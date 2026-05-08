import http.server
import socketserver
import threading
import time
import traceback

import scraper

PORT = 8080
UPDATE_INTERVAL_SECONDS = 24 * 60 * 60  # daily

Handler = http.server.SimpleHTTPRequestHandler


def run_scraper_loop():
    while True:
        try:
            scraper.update_data()
        except Exception:
            traceback.print_exc()
        time.sleep(UPDATE_INTERVAL_SECONDS)


threading.Thread(target=run_scraper_loop, daemon=True).start()

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Serving UI at http://localhost:{PORT}")
    httpd.serve_forever()
