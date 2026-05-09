"""Vivid Seats scraper for FIFA World Cup 2026 ticket prices.

Strategy mirrors tickpick_scraper.py:
  1. Walk one (or more) Vivid Seats "FIFA World Cup 2026" category pages
     to discover individual event URLs.
  2. For each unique event, fetch the page and pull `lowPrice` from the
     embedded schema.org JSON-LD block (with a couple of fallbacks).
  3. Write a current-snapshot CSV (vivid_data.csv) and append a
     long-format history row to vivid_history.csv.

Vivid Seats does not require auth and JSON-LD is consistently present;
their bot protection is much lighter than SeatGeek's.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urljoin

import pandas as pd
import requests


BASE_DIR = os.path.dirname(__file__)
SNAPSHOT_PATH = os.path.join(BASE_DIR, "vivid_data.csv")
HISTORY_PATH = os.path.join(BASE_DIR, "vivid_history.csv")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Performer / category landing pages to crawl for event links.
# Multiple in case Vivid changes URLs or splits by stage.
SEED_URLS = [
    "https://www.vividseats.com/world-cup-soccer-tickets--sports-soccer/performer/944",
]

# Vivid event URLs look like /<slug>-tickets-<MM>-<DD>-<YYYY>-<venue>/production/<eventId>
EVENT_HREF_RE = re.compile(
    r'href="(/[^"#?]*?-tickets[^"#?]*?/production/(\d{6,10}))"'
)
LD_JSON_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.S,
)
NEXT_DATA_RE = re.compile(
    r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>',
    re.S,
)
LOWEST_PRICE_KEY_RE = re.compile(
    r'"(?:lowPrice|minTicketPrice|minPrice|lowest_price)"\s*:\s*"?([0-9]+(?:\.[0-9]+)?)"?'
)

REQUEST_TIMEOUT = 30
INTER_REQUEST_DELAY = 0.5


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


def discover_events(session: requests.Session) -> dict[str, str]:
    """Return {vivid_event_id: full_url} from any seed page that responds."""
    found: dict[str, str] = {}
    for seed in SEED_URLS:
        try:
            resp = session.get(seed, timeout=REQUEST_TIMEOUT)
            if resp.status_code == 404:
                print(f"  [{seed}] 404 — skipping")
                continue
            resp.raise_for_status()
        except Exception as e:
            print(f"  [{seed}] fetch failed: {e}")
            continue

        added = 0
        for href, event_id in EVENT_HREF_RE.findall(resp.text):
            full = urljoin("https://www.vividseats.com", href)
            if event_id not in found:
                found[event_id] = full
                added += 1
        print(f"  [{seed}] +{added} events (total {len(found)})")
        time.sleep(INTER_REQUEST_DELAY)

    return found


def parse_event_page(html: str) -> Optional[dict]:
    """Extract pricing + metadata from a Vivid event page."""
    # 1) JSON-LD
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
            if not isinstance(offers, dict):
                continue
            low = offers.get("lowPrice") or offers.get("price") or offers.get("minPrice")
            if low is None:
                continue
            try:
                low = float(low)
            except (TypeError, ValueError):
                continue
            location = entry.get("location") or {}
            if isinstance(location, list):
                location = location[0] if location else {}
            address = location.get("address") if isinstance(location, dict) else None
            if isinstance(address, dict):
                city = address.get("addressLocality") or ""
                region = address.get("addressRegion") or ""
            elif isinstance(address, str):
                city, region = address, ""
            else:
                city, region = "", ""
            return {
                "name": entry.get("name") or "",
                "start_date": entry.get("startDate") or "",
                "venue": (location.get("name") if isinstance(location, dict) else "") or "",
                "city": city,
                "region": region,
                "low_price": low,
                "currency": offers.get("priceCurrency") or "USD",
                "url": entry.get("url") or "",
            }

    # 2) __NEXT_DATA__ — look for any minTicketPrice/lowest_price field
    nd = NEXT_DATA_RE.search(html)
    target_blob = nd.group(1) if nd else html
    m = LOWEST_PRICE_KEY_RE.search(target_blob)
    if m:
        try:
            return {"name": "", "start_date": "", "venue": "", "city": "",
                    "region": "", "low_price": float(m.group(1)),
                    "currency": "USD", "url": ""}
        except ValueError:
            pass
    return None


def scrape() -> pd.DataFrame:
    session = make_session()
    print(f"[{datetime.now(timezone.utc).isoformat()}] Discovering Vivid events...")
    events = discover_events(session)
    print(f"Discovered {len(events)} unique events.")
    if not events:
        return pd.DataFrame()

    rows = []
    for i, (event_id, url) in enumerate(sorted(events.items()), 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            print(f"  [{i}/{len(events)}] {event_id}: fetch failed: {e}")
            continue

        parsed = parse_event_page(resp.text)
        if parsed is None or parsed.get("low_price") is None:
            print(f"  [{i}/{len(events)}] {event_id}: no JSON-LD price found")
            continue

        rows.append({
            "vivid_event_id": event_id,
            "name": parsed["name"],
            "start_date": parsed["start_date"],
            "venue": parsed["venue"],
            "city": parsed["city"],
            "region": parsed["region"],
            "low_price_usd": parsed["low_price"],
            "currency": parsed["currency"],
            "url": parsed["url"] or url,
        })
        if i % 10 == 0:
            print(f"  ...{i}/{len(events)} done")
        time.sleep(INTER_REQUEST_DELAY)

    return pd.DataFrame(rows)


def main() -> int:
    df = scrape()
    if df.empty:
        print("No data scraped; aborting write.")
        return 1

    now_iso = datetime.now(timezone.utc).isoformat()
    df["observed_at"] = now_iso
    df.to_csv(SNAPSHOT_PATH, index=False)

    history_df = df[["vivid_event_id", "observed_at", "low_price_usd"]].copy()
    write_header = not os.path.exists(HISTORY_PATH)
    history_df.to_csv(HISTORY_PATH, mode="a", header=write_header, index=False)

    print(
        f"Wrote {len(df)} rows to vivid_data.csv; "
        f"appended {len(history_df)} rows to vivid_history.csv."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
