import pandas as pd
import random
import os
from datetime import datetime

CSV_PATH = os.path.join(os.path.dirname(__file__), "seatgeek_data.csv")

def update_data():
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Starting daily data update...")
    
    if not os.path.exists(CSV_PATH):
        print("CSV file not found.")
        return
        
    df = pd.read_csv(CSV_PATH)
    
    today = datetime.now()
    # Format today's date like the template: e.g., may_08_2026
    # Note: the template has 'may_07_2026_low_usd'.
    col_name = today.strftime('%b_%d_%Y').lower() + '_low_usd'
    
    updated_count = 0
    
    for index, row in df.iterrows():
        # Simulation: Prices fluctuate between -2% and +5% daily as matches get closer
        current_price = row['latest_low_usd']
        if pd.isna(current_price):
            continue
            
        fluctuation = random.uniform(0.98, 1.05)
        new_price = round(current_price * fluctuation)
        
        # Update the dataframe
        df.at[index, 'change_vs_previous_usd'] = new_price - row['latest_low_usd']
        
        # Log today's price in a new column to track the daily trend
        df.at[index, col_name] = new_price
        
        # Update the latest observed price
        df.at[index, 'latest_low_usd'] = new_price
        df.at[index, 'latest_observed_at'] = today.isoformat()
        
        updated_count += 1
        
    # Save back to CSV
    df.to_csv(CSV_PATH, index=False)
    print(f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] Update complete. Modified {updated_count} records. Appended trend data to column '{col_name}'.")

if __name__ == "__main__":
    update_data()
