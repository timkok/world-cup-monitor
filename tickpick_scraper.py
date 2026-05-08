"""TickPick scraper for FIFA World Cup 2026 ticket prices.

Strategy:
  1. Walk a fixed list of TickPick "explore" city pages (one per host city).
  2. From each page, collect distinct /buy-fifa-world-cup-26-... event URLs.
  3. For each unique event, fetch the page and extract lowPrice + metadata
     from the embedded schema.org JSON-LD block.
  4. Write a current-snapshot CSV (tickpick_data.csv) plus append to a
     long-format history (tickpick_history.csv).
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from urllib.parse import urljoin

import pandas as pd
import requests


BASE_DIR = os.path.dirname(__file__)
SNAPSHOT_PATH = os.path.join(BASE_DIR, "tickpick_data.csv")
HISTORY_PATH = os.path.join(BASE_DIR, "tickpick_history.csv")

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# 16 host cities of the 2026 World Cup, with their TickPick "explore" page IDs
CITY_PAGES = [
    ("Arlington",       "https://www.tickpick.com/explore/soccer/world-cup-soccer-arlington-tickets/7249/"),
    ("Atlanta",         "https://www.tickpick.com/explore/soccer/world-cup-soccer-atlanta-tickets/7255/"),
    ("Foxborough",      "https://www.tickpick.com/explore/soccer/world-cup-soccer-foxborough-tickets/7250/"),
    ("Ft Lauderdale",   "https://www.tickpick.com/explore/soccer/world-cup-soccer-ft-lauderdale-tickets/7251/"),
    ("Houston",         "https://www.tickpick.com/explore/soccer/world-cup-soccer-houston-tickets/7256/"),
    ("Kansas City",     "https://www.tickpick.com/explore/soccer/world-cup-soccer-kansas-city-tickets/7248/"),
    ("Los Angeles",     "https://www.tickpick.com/explore/soccer/world-cup-soccer-los-angeles-tickets/7257/"),
    ("Mexico City",     "https://www.tickpick.com/explore/soccer/world-cup-soccer-mexico-city-tickets/7261/"),
    ("Monterrey",       "https://www.tickpick.com/explore/soccer/world-cup-soccer-monterrey-tickets/7262/"),
    ("New York",        "https://www.tickpick.com/explore/soccer/world-cup-soccer-new-york-tickets/7247/"),
    ("Philadelphia",    "https://www.tickpick.com/explore/soccer/world-cup-soccer-philadelphia-tickets/7253/"),
    ("Santa Clara",     "https://www.tickpick.com/explore/soccer/world-cup-soccer-santa-clara-tickets/7252/"),
    ("Seattle",         "https://www.tickpick.com/explore/soccer/world-cup-soccer-seattle-tickets/7254/"),
    ("Toronto",         "https://www.tickpick.com/explore/soccer/world-cup-soccer-toronto-tickets/7258/"),
    ("Vancouver",       "https://www.tickpick.com/explore/soccer/world-cup-soccer-vancouver-tickets/7259/"),
    ("Zapopan",         "https://www.tickpick.com/explore/soccer/world-cup-soccer-zapopan-tickets/7260/"),
]

# Some explore pages are empty; back-fill via TickPick's keyword search.
# Each query returns event links matching the venue/team name.
SEARCH_FALLBACK_QUERIES = [
    "gillette+world+cup",  # Foxborough / Boston — empty explore page
]

EVENT_HREF_RE = re.compile(r'href="(/buy-fifa-world-cup-26[^"#?]+)"')
TICKPICK_ID_RE = re.compile(r"/(\d{6,9})/?$")
LD_JSON_RE = re.compile(
    r'<script[^>]*type="application/ld\+json"[^>]*>(.*?)</script>',
    re.S,
)

REQUEST_TIMEOUT = 30
INTER_REQUEST_DELAY = 0.5  # seconds, be polite


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    })
    return s


def collect_event_urls(session: requests.Session) -> dict[str, str]:
    """Return {tickpick_event_id: full_url} across all city pages."""
    found: dict[str, str] = {}
    for city, page_url in CITY_PAGES:
        try:
            resp = session.get(page_url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            print(f"  [{city}] page fetch failed: {e}")
            continue

        hrefs = set(EVENT_HREF_RE.findall(resp.text))
        added = 0
        for href in hrefs:
            full = urljoin("https://www.tickpick.com", href)
            m = TICKPICK_ID_RE.search(href)
            if not m:
                continue
            event_id = m.group(1)
            if event_id not in found:
                found[event_id] = full
                added += 1
        print(f"  [{city}] {len(hrefs)} links → +{added} new events (total {len(found)})")
        time.sleep(INTER_REQUEST_DELAY)

    # Back-fill via search for venues whose city pages are empty
    for query in SEARCH_FALLBACK_QUERIES:
        url = f"https://www.tickpick.com/search/?q={query}"
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            print(f"  [search:{query}] fetch failed: {e}")
            continue
        hrefs = set(EVENT_HREF_RE.findall(resp.text))
        added = 0
        for href in hrefs:
            full = urljoin("https://www.tickpick.com", href)
            m = TICKPICK_ID_RE.search(href)
            if not m:
                continue
            event_id = m.group(1)
            if event_id not in found:
                found[event_id] = full
                added += 1
        print(f"  [search:{query}] {len(hrefs)} links → +{added} new events (total {len(found)})")
        time.sleep(INTER_REQUEST_DELAY)

    return found


def parse_event_page(html: str) -> dict | None:
    """Extract pricing + metadata from a TickPick event page's JSON-LD."""
    for block in LD_JSON_RE.findall(html):
        try:
            data = json.loads(block.strip())
        except json.JSONDecodeError:
            continue
        candidates = data if isinstance(data, list) else [data]
        for entry in candidates:
            if not isinstance(entry, dict):
                continue
            if entry.get("@type") not in ("Event", "SportsEvent"):
                continue
            offers = entry.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            low_price = offers.get("lowPrice")
            if low_price is None:
                continue
            location = entry.get("location") or {}
            if isinstance(location, list):
                location = location[0] if location else {}
            address = location.get("address") or {}
            if isinstance(address, dict):
                city = address.get("addressLocality") or ""
                region = address.get("addressRegion") or ""
            else:
                city, region = "", ""
            return {
                "name": entry.get("name") or "",
                "start_date": entry.get("startDate") or "",
                "venue": location.get("name") or "",
                "city": city,
                "region": region,
                "low_price": float(low_price),
                "currency": offers.get("priceCurrency") or "USD",
                "url": entry.get("url") or "",
            }
    return None


def scrape() -> pd.DataFrame:
    session = make_session()
    print(f"[{datetime.now(timezone.utc).isoformat()}] Discovering events...")
    events = collect_event_urls(session)
    print(f"Discovered {len(events)} unique events.")

    rows = []
    for i, (event_id, url) in enumerate(sorted(events.items()), 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT)
            resp.raise_for_status()
        except Exception as e:
            print(f"  [{i}/{len(events)}] {event_id}: fetch failed: {e}")
            continue

        parsed = parse_event_page(resp.text)
        if parsed is None:
            print(f"  [{i}/{len(events)}] {event_id}: no JSON-LD price found")
            continue

        rows.append({
            "tickpick_event_id": event_id,
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

    history_df = df[["tickpick_event_id", "observed_at", "low_price_usd"]].copy()
    write_header = not os.path.exists(HISTORY_PATH)
    history_df.to_csv(HISTORY_PATH, mode="a", header=write_header, index=False)

    print(
        f"Wrote {len(df)} rows to tickpick_data.csv; "
        f"appended {len(history_df)} rows to tickpick_history.csv."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
