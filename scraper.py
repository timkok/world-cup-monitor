import pandas as pd
import random
import os
from datetime import datetime, timezone

BASE_DIR = os.path.dirname(__file__)
CSV_PATH = os.path.join(BASE_DIR, "seatgeek_data.csv")
HISTORY_PATH = os.path.join(BASE_DIR, "price_history.csv")

HISTORY_COLUMNS = ["event_id", "observed_at", "low_usd"]


def update_data():
    now = datetime.now(timezone.utc)
    print(f"[{now.isoformat()}] Starting hourly data update...")

    if not os.path.exists(CSV_PATH):
        print("CSV file not found.")
        return

    df = pd.read_csv(CSV_PATH)

    history_rows = []
    updated_count = 0

    for index, row in df.iterrows():
        current_price = row["latest_low_usd"]
        if pd.isna(current_price):
            continue

        # Simulation: prices fluctuate between -2% and +5% per tick
        fluctuation = random.uniform(0.98, 1.05)
        new_price = round(current_price * fluctuation)

        df.at[index, "change_vs_previous_usd"] = new_price - current_price
        df.at[index, "latest_low_usd"] = new_price
        df.at[index, "latest_observed_at"] = now.isoformat()

        history_rows.append({
            "event_id": row.get("event_id"),
            "observed_at": now.isoformat(),
            "low_usd": new_price,
        })
        updated_count += 1

    df.to_csv(CSV_PATH, index=False)

    # Append to long-format price history (created with header if missing)
    history_df = pd.DataFrame(history_rows, columns=HISTORY_COLUMNS)
    write_header = not os.path.exists(HISTORY_PATH)
    history_df.to_csv(HISTORY_PATH, mode="a", header=write_header, index=False)

    print(
        f"[{datetime.now(timezone.utc).isoformat()}] "
        f"Update complete. Updated {updated_count} matches; "
        f"appended {len(history_rows)} rows to price_history.csv."
    )


if __name__ == "__main__":
    update_data()
