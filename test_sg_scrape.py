import requests
import re
import json

url = "https://seatgeek.com/fifa-world-cup-tickets/international-soccer/2026-06-11-2-pm/17650338"
headers = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

resp = requests.get(url, headers=headers)
print("Status:", resp.status_code)

if resp.status_code == 200:
    # Look for __NEXT_DATA__ or JSON-LD
    m = re.search(r'<script id="__NEXT_DATA__" type="application/json">(.*?)</script>', resp.text)
    if m:
        print("__NEXT_DATA__ found. Length:", len(m.group(1)))
        try:
            data = json.loads(m.group(1))
            event = data.get('props', {}).get('pageProps', {}).get('event', {})
            stats = event.get('stats', {})
            print("Lowest price:", stats.get('lowest_price'))
        except Exception as e:
            print("Error parsing __NEXT_DATA__", e)
    else:
        print("__NEXT_DATA__ not found.")
        
    m2 = re.search(r'<script type="application/ld\+json">(.*?)</script>', resp.text, re.S)
    if m2:
        print("JSON-LD found. Length:", len(m2.group(1)))
        try:
            data = json.loads(m2.group(1))
            print("JSON-LD offers:", data.get('offers'))
        except Exception as e:
            pass
