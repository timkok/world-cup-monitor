from playwright.sync_api import sync_playwright
from playwright_stealth import stealth_sync
import time

def test_scrape():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(
            user_agent="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36"
        )
        stealth_sync(page)
        
        url = "https://seatgeek.com/fifa-world-cup-tickets/international-soccer/2026-06-11-2-pm/17650338"
        print(f"Navigating to {url}")
        
        response = page.goto(url, wait_until="domcontentloaded", timeout=30000)
        
        print("Response status:", response.status)
        
        # Wait a bit
        page.wait_for_timeout(5000)
        
        content = page.content()
        if "geo.captcha-delivery.com" in content or "Please enable JS and disable any ad blocker" in content:
            print("Blocked by Datadome/Captcha.")
        else:
            print("Success! Page loaded.")
            # Let's try to find price.
            # Usually SeatGeek has a script tag with JSON or some specific elements.
            print(page.title())
            
        browser.close()

if __name__ == "__main__":
    test_scrape()
