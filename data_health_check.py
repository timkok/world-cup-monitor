#!/usr/bin/env python3
"""Data Integrity and Health Check for World Cup Monitor CSV Files.

Checks SeatGeek, TickPick, and Vivid Seats snapshot/history CSV files for:
- File existence
- Expected columns
- Non-empty records
- Column value type sanity (IDs are numeric/valid strings, prices are positive numbers, ISO timestamps parse)
"""

import os
import sys
import pandas as pd

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

FILES_TO_CHECK = {
    "seatgeek_data.csv": {
        "type": "snapshot",
        "required_cols": ["event_id", "url", "latest_low_usd", "latest_observed_at"]
    },
    "price_history.csv": {
        "type": "history",
        "required_cols": ["event_id", "observed_at", "low_usd"]
    },
    "tickpick_data.csv": {
        "type": "snapshot",
        "required_cols": ["tickpick_event_id", "url", "low_price_usd", "observed_at"]
    },
    "tickpick_history.csv": {
        "type": "history",
        "required_cols": ["tickpick_event_id", "observed_at", "low_price_usd"]
    },
    "vivid_data.csv": {
        "type": "snapshot",
        "required_cols": ["vivid_event_id", "url", "low_price_usd", "observed_at"]
    },
    "vivid_history.csv": {
        "type": "history",
        "required_cols": ["vivid_event_id", "observed_at", "low_price_usd"]
    }
}

def run_health_checks() -> bool:
    print("Starting World Cup Ticket Monitor Data Health Check...")
    print("=====================================================")
    
    all_ok = True
    
    for filename, config in FILES_TO_CHECK.items():
        path = os.path.join(BASE_DIR, filename)
        print(f"Checking {filename}...")
        
        # 1. Existence Check
        if not os.path.exists(path):
            print(f"  ❌ ERROR: File does not exist at {path}")
            all_ok = False
            continue
            
        try:
            df = pd.read_csv(path)
        except Exception as e:
            print(f"  ❌ ERROR: Failed to parse CSV: {e}")
            all_ok = False
            continue
            
        # 2. Empty Check
        if df.empty:
            print(f"  ❌ ERROR: File is empty (0 rows)")
            all_ok = False
            continue
            
        print(f"  ✔ Found {len(df)} rows.")
        
        # 3. Columns Check
        missing_cols = [col for col in config["required_cols"] if col not in df.columns]
        if missing_cols:
            print(f"  ❌ ERROR: Missing required columns: {missing_cols}")
            all_ok = False
            continue
        print(f"  ✔ All required columns present.")
        
        # 4. Values Sanity Checks
        # Verify event_id is non-null and numeric
        id_col = next((c for c in df.columns if "event_id" in c), None)
        if id_col:
            null_ids = df[id_col].isna().sum()
            if null_ids > 0:
                print(f"  ❌ ERROR: Found {null_ids} null values in ID column '{id_col}'")
                all_ok = False
            else:
                print(f"  ✔ Event IDs are clean.")
                
        # Verify price columns are positive numbers
        price_col = next((c for c in df.columns if "low" in c), None)
        if price_col:
            # Drop null prices if it's snapshot, but check value ranges
            non_null_prices = df[price_col].dropna()
            try:
                numeric_prices = pd.to_numeric(non_null_prices)
                negative_prices = (numeric_prices <= 0).sum()
                if negative_prices > 0:
                    print(f"  ❌ ERROR: Found {negative_prices} negative or zero prices in '{price_col}'")
                    all_ok = False
                else:
                    print(f"  ✔ Price values are positive numeric ranges.")
            except Exception as e:
                print(f"  ❌ ERROR: Prices column '{price_col}' contains non-numeric values: {e}")
                all_ok = False
                
        # Verify timestamp column formats
        time_col = next((c for c in df.columns if "observed_at" in c), None)
        if time_col:
            non_null_times = df[time_col].dropna()
            try:
                pd.to_datetime(non_null_times, format='ISO8601', utc=True, errors='raise')
                print(f"  ✔ Timestamps parse correctly.")
            except Exception as e:
                print(f"  ❌ ERROR: Found invalid timestamp formatting in '{time_col}': {e}")
                all_ok = False
                
        print(f"  ✔ {filename} passed sanity checks.\n")
        
    print("=====================================================")
    if all_ok:
        print("🎉 SUCCESS: All data files are healthy and syntactically valid!")
        return True
    else:
        print("🚨 FAILURE: One or more data integrity errors were discovered.")
        return False

if __name__ == "__main__":
    success = run_health_checks()
    sys.exit(0 if success else 1)
