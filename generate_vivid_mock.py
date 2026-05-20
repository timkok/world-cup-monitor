import pandas as pd
import numpy as np
import os
import random
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
SG_DATA_PATH = os.path.join(BASE_DIR, "seatgeek_data.csv")
SG_HIST_PATH = os.path.join(BASE_DIR, "price_history.csv")

VIVID_DATA_PATH = os.path.join(BASE_DIR, "vivid_data.csv")
VIVID_HIST_PATH = os.path.join(BASE_DIR, "vivid_history.csv")

def main():
    if not os.path.exists(SG_DATA_PATH):
        print("SeatGeek data not found. Cannot mock Vivid Seats.")
        return 1

    sg_df = pd.read_csv(SG_DATA_PATH)
    sg_hist = pd.read_csv(SG_HIST_PATH)

    vivid_rows = []
    vivid_hist_rows = []

    now_iso = datetime.now(timezone.utc).isoformat()

    for idx, row in sg_df.iterrows():
        # Match name and venue details
        match_name = row["match"]
        venue = row["venue"]
        
        # Parse teams
        teams = match_name.split(" vs ")
        # Map some venue/city attributes
        city = row.get("host_city", "Unknown City").split(",")[0]
        region = "US" if "Canada" not in city and "Mexico" not in city else "NA"
        
        # Calculate random vivid price (around seatgeek price)
        sg_price = row["latest_low_usd"]
        if pd.isna(sg_price):
            sg_price = 250
        vivid_price = round(sg_price * random.uniform(0.92, 1.08))

        event_id = int(row["event_id"])
        vivid_event_id = 8000000 + event_id

        # Format matches similar to vivid scrapings
        vivid_rows.append({
            "vivid_event_id": vivid_event_id,
            "name": f"FIFA World Cup 2026 - {match_name}",
            "start_date": "2026-06-11T12:00:00", # placeholder date matching format
            "venue": venue,
            "city": city,
            "region": region,
            "low_price_usd": vivid_price,
            "currency": "USD",
            "url": f"https://www.vividseats.com/fifa-world-cup-tickets-event-{vivid_event_id}",
            "observed_at": now_iso
        })

        # Add corresponding history
        match_hist = sg_hist[sg_hist["event_id"] == event_id]
        if match_hist.empty:
            # Generate a simple mock history
            for day in range(5, -1, -1):
                hist_time = (datetime.now(timezone.utc) - pd.Timedelta(days=day)).isoformat()
                vivid_hist_rows.append({
                    "vivid_event_id": vivid_event_id,
                    "observed_at": hist_time,
                    "low_price_usd": round(vivid_price * (1 + day * 0.015 * random.choice([-1, 1])))
                })
        else:
            for _, h_row in match_hist.iterrows():
                vivid_hist_rows.append({
                    "vivid_event_id": vivid_event_id,
                    "observed_at": h_row["observed_at"],
                    "low_price_usd": round(h_row["low_usd"] * random.uniform(0.95, 1.05))
                })

    vivid_df = pd.DataFrame(vivid_rows)
    vivid_df.to_csv(VIVID_DATA_PATH, index=False)

    vivid_hist_df = pd.DataFrame(vivid_hist_rows)
    vivid_hist_df.to_csv(VIVID_HIST_PATH, index=False)

    print(f"Generated {len(vivid_df)} Vivid Seats mock snapshot rows and {len(vivid_hist_df)} history rows.")
    return 0

if __name__ == "__main__":
    main()
