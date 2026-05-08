"""Local preview server.

The real data updates run in GitHub Actions (see .github/workflows/update.yml).
This script only serves the static files locally for development; it does NOT
mutate seatgeek_data.csv or price_history.csv.
"""
import http.server
import socketserver

PORT = 8080

Handler = http.server.SimpleHTTPRequestHandler

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    print(f"Serving UI at http://localhost:{PORT}")
    httpd.serve_forever()
