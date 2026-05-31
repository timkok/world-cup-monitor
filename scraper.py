"""SeatGeek scraper for FIFA World Cup 2026 ticket prices.

For each event URL already tracked in seatgeek_data.csv, fetch the public
event page and extract the lowest available list price ("get-in") from the
embedded schema.org JSON-LD block. Updates the snapshot CSV in place and
appends the observation to price_history.csv.

Notes:
  - This is a *real* scraper (replacing an earlier random-jitter mock).
  - If extraction fails for a given event we keep the previous price and
    do NOT append to history, so we never pollute the trend with noise.
  - Be polite: we sleep between requests and we keep one Session.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Optional

import pandas as pd
import requests

from history_utils import append_incremental_history


BASE_DIR = os.path.dirname(__file__)
CSV_PATH = os.path.join(BASE_DIR, "seatgeek_data.csv")
HISTORY_PATH = os.path.join(BASE_DIR, "price_history.csv")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

LD_JSON_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.S,
)
# Fallback: SeatGeek ships a JSON blob in __NEXT_DATA__ with a "lowest_price" key.
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.S,
)
LOWEST_PRICE_KEY_RE = re.compile(r'"lowest_price"\s*:\s*([0-9]+(?:\.[0-9]+)?)')

REQUEST_TIMEOUT = 30
INTER_REQUEST_DELAY = 0.6  # seconds between fetches
MAX_RETRIES = 2
HISTORY_COLUMNS = ["event_id", "observed_at", "low_usd"]


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
    })
    return s


def extract_low_price(html: str) -> Optional[float]:
    """Return the lowest list price from a SeatGeek event page, or None."""
    # 1) JSON-LD (most stable)
    for block in LD_JSON_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            if entry.get("@type") not in ("Event", "SportsEvent", "MusicEvent"):
                continue
            offers = entry.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            low = offers.get("lowPrice") if isinstance(offers, dict) else None
            if low is not None:
                try:
                    return float(low)
                except (TypeError, ValueError):
                    pass

    # 2) __NEXT_DATA__ blob — look for a numeric "lowest_price" field
    next_match = NEXT_DATA_RE.search(html)
    if next_match:
        m = LOWEST_PRICE_KEY_RE.search(next_match.group(1))
        if m:
            try:
                return float(m.group(1))
            except ValueError:
                pass

    # 3) Bare regex fallback (last resort)
    m = LOWEST_PRICE_KEY_RE.search(html)
    if m:
        try:
            return float(m.group(1))
        except ValueError:
            pass

    return None


def fetch_event_price(session: requests.Session, url: str) -> Optional[float]:
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
        except requests.RequestException as e:
            print(f"    fetch error (attempt {attempt}): {e}")
            time.sleep(1.5 * attempt)
            continue
        if resp.status_code in (429, 503):
            print(f"    throttled ({resp.status_code}); backing off")
            time.sleep(3 * attempt)
            continue
        if not resp.ok:
            print(f"    HTTP {resp.status_code}")
            return None
        price = extract_low_price(resp.text)
        if price is not None:
            return price
        # No price visible — could be sold out or page format changed
        return None
    return None


def update_data() -> int:
    now_iso = datetime.now(timezone.utc).isoformat()
    print(f"[{now_iso}] Starting SeatGeek price update...")

    if not os.path.exists(CSV_PATH):
        print(f"Snapshot CSV not found at {CSV_PATH}; nothing to update.")
        return 1

    df = pd.read_csv(CSV_PATH)
    if "url" not in df.columns or "event_id" not in df.columns:
        print("CSV missing required columns 'url' / 'event_id'.")
        return 1

    session = make_session()
    history_rows = []
    updated = 0
    failed = 0

    for idx, row in df.iterrows():
        url = row.get("url")
        event_id = row.get("event_id")
        if not isinstance(url, str) or not url.startswith("http"):
            continue

        prev = row.get("latest_low_usd")
        try:
            prev_val = float(prev) if pd.notna(prev) else None
        except (TypeError, ValueError):
            prev_val = None

        price = fetch_event_price(session, url)
        if price is None:
            failed += 1
            print(f"  [{idx+1}/{len(df)}] {event_id}: no price (kept ${prev_val})")
            time.sleep(INTER_REQUEST_DELAY)
            continue

        new_price = round(price)
        change = new_price - prev_val if prev_val is not None else 0
        df.at[idx, "latest_low_usd"] = new_price
        df.at[idx, "latest_observed_at"] = now_iso
        df.at[idx, "change_vs_previous_usd"] = change
        if prev_val:
            df.at[idx, "change_vs_previous_pct"] = round(change / prev_val * 100, 2)

        history_rows.append({
            "event_id": event_id,
            "observed_at": now_iso,
            "low_usd": new_price,
        })
        updated += 1
        if (idx + 1) % 10 == 0:
            print(f"  ...{idx+1}/{len(df)} done (ok={updated}, fail={failed})")
        time.sleep(INTER_REQUEST_DELAY)

    df.to_csv(CSV_PATH, index=False)

    appended_history = 0
    if history_rows:
        history_df = pd.DataFrame(history_rows, columns=HISTORY_COLUMNS)
        appended_history = append_incremental_history(
            snapshot_df=history_df,
            history_path=HISTORY_PATH,
            id_col="event_id",
            observed_col="observed_at",
            price_col="low_usd",
        )

    print(
        f"[{datetime.now(timezone.utc).isoformat()}] "
        f"Done. Updated {updated}/{len(df)} matches, {failed} failures; "
        f"appended {appended_history} meaningful history rows."
    )
    return 0


if __name__ == "__main__":
    sys.exit(update_data())
