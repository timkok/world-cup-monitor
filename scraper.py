import pandas as pd
import os
import json
import re
from datetime import datetime
from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync

CSV_PATH = os.path.join(os.path.dirname(__file__), "seatgeek_data.csv")

def extract_price_from_jsonld(page):
    """Attempt to extract price from schema.org JSON-LD data which SeatGeek usually embeds."""
    try:
        script_tags = page.locator('script[type="application/ld+json"]').all_inner_texts()
        for script_content in script_tags:
            try:
                data = json.loads(script_content)
                # Handle both array of objects and single object
                if isinstance(data, list):
                    for item in data:
                        if 'offers' in item and 'lowPrice' in item['offers']:
                            return float(item['offers']['lowPrice'])
                elif isinstance(data, dict):
                    if 'offers' in data and 'lowPrice' in data['offers']:
                        return float(data['offers']['lowPrice'])
            except json.JSONDecodeError:
                continue
    except Exception as e:
        print(f"JSON-LD extraction error: {e}")
    return None

def extract_price_from_dom(page):
    """Attempt to extract price from visible DOM elements as a fallback."""
    try:
        # Wait a bit for JS to render prices
        page.wait_for_timeout(3000)
        
        # We look for common price patterns on the page
        text_content = page.content()
        # Very crude regex to find $ followed by numbers, just as an absolute last resort fallback
        # Realistically, SeatGeek prices are in specific classes, but this is a broad catch.
        prices = re.findall(r'\$(\d{2,5})', text_content)
        if prices:
            # We assume the lowest realistic ticket price isn't $1 or $10. Let's filter > $50
            valid_prices = [float(p) for p in prices if float(p) > 50]
            if valid_prices:
                return min(valid_prices)
    except Exception as e:
        print(f"DOM extraction error: {e}")
    return None

def update_data():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting real Playwright data scrape...")
    
    if not os.path.exists(CSV_PATH):
        print("CSV file not found.")
        return
        
    df = pd.read_csv(CSV_PATH)
    today = datetime.now()
    col_name = today.strftime('%b_%d_%Y').lower() + '_low_usd'
    
    updated_count = 0
    errors_count = 0

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        # Using a realistic user agent
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            viewport={'width': 1280, 'height': 800}
        )
        page = context.new_page()
        stealth_sync(page)

        for index, row in df.iterrows():
            url = row['url']
            if pd.isna(url) or not isinstance(url, str) or not url.startswith('http'):
                continue

            print(f"Scraping: {row['match']}...")
            real_price = None

            try:
                # Go to the SeatGeek page
                response = page.goto(url, wait_until="domcontentloaded", timeout=20000)
                
                # Check for Datadome block
                content = page.content()
                if "geo.captcha-delivery.com" in content or response.status == 403:
                    print(f"  -> Blocked by Datadome CAPTCHA.")
                else:
                    # Try JSON-LD first
                    real_price = extract_price_from_jsonld(page)
                    if not real_price:
                        # Fallback to DOM parsing
                        real_price = extract_price_from_dom(page)

            except Exception as e:
                print(f"  -> Error fetching URL: {e}")

            # Determine new price
            if real_price:
                new_price = real_price
                print(f"  -> Success! Found price: ${new_price}")
                df.at[index, 'trend_note'] = 'Live Scraped'
                updated_count += 1
            else:
                # Fallback to the previous price if blocked/failed
                new_price = row['latest_low_usd']
                print(f"  -> Failed. Falling back to previous price: ${new_price}")
                df.at[index, 'trend_note'] = 'Fallback (Blocked)'
                errors_count += 1
            
            # Record Data
            if pd.notna(new_price):
                old_price = row['latest_low_usd']
                if pd.notna(old_price):
                    df.at[index, 'change_vs_previous_usd'] = new_price - old_price
                    # avoid division by zero
                    if old_price > 0:
                        df.at[index, 'change_vs_previous_pct'] = round(((new_price - old_price) / old_price) * 100, 2)
                
                df.at[index, col_name] = new_price
                df.at[index, 'latest_low_usd'] = new_price
                df.at[index, 'latest_observed_at'] = today.isoformat()
            
            # Sleep to avoid getting rate-limited too fast
            page.wait_for_timeout(3000)

        browser.close()
        
    df.to_csv(CSV_PATH, index=False)
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Scrape complete. Updated {updated_count} records. Failed/Fallback {errors_count} records.")

if __name__ == "__main__":
    update_data()
