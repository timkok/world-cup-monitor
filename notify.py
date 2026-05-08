import os
import pandas as pd
import requests

DISCORD_WEBHOOK_URL = os.environ.get('DISCORD_WEBHOOK_URL')

def notify():
    if not DISCORD_WEBHOOK_URL:
        print("No Discord Webhook URL provided. Skipping notifications.")
        return

    try:
        sg_df = pd.read_csv('seatgeek_data.csv')
        tp_df = pd.read_csv('tickpick_data.csv')
    except Exception as e:
        print(f"Error reading CSVs: {e}")
        return

    # Keep track of alerts to send
    alerts = []

    # Process local priority deals (NJ, PA, MA)
    local_cities = ['New York / New Jersey', 'Philadelphia, PA', 'Boston, MA']
    
    for _, sg_row in sg_df.iterrows():
        # Check if local
        if not any(c in str(sg_row.get('host_city', '')) for c in local_cities):
            continue
            
        # Find match in TickPick
        tp_price = None
        tp_url = None
        for _, tp_row in tp_df.iterrows():
            # Loose matching based on venue name snippet
            if str(tp_row.get('venue')) in str(sg_row.get('venue', '')):
                # In real production, date match should be exact. Assuming venue match is close enough for alerts.
                tp_price = tp_row.get('low_price_usd')
                tp_url = tp_row.get('url')
                break
        
        sg_price = sg_row.get('latest_low_usd')
        
        lowest_price = sg_price
        best_url = sg_row.get('url')
        source = "SeatGeek"
        
        if pd.notna(tp_price) and (pd.isna(lowest_price) or tp_price < lowest_price):
            lowest_price = tp_price
            best_url = tp_url
            source = "TickPick"
            
        if pd.isna(lowest_price):
            continue

        # Face Value Rule
        stage = str(sg_row.get('stage', '')).lower()
        fv = 70
        if 'final' in stage and 'semi' not in stage and 'quarter' not in stage: fv = 600
        elif 'semi' in stage: fv = 400
        elif 'quarter' in stage: fv = 250
        elif '16' in stage or '32' in stage: fv = 150
        
        multiplier = lowest_price / fv
        
        # Determine if it's an alert condition: < 3x Face Value
        if multiplier < 3.0:
            alerts.append({
                "title": f"🚨 PRICE DROP: {sg_row.get('match')}",
                "description": f"**Venue:** {sg_row.get('venue')}\n**Price:** ${lowest_price} ({multiplier:.1f}x Face Value)\n**Source:** {source}",
                "url": best_url,
                "color": 3066993 # Green
            })
            
    if alerts:
        # We limit to top 5 alerts to avoid spam
        for alert in alerts[:5]:
            payload = {
                "embeds": [alert]
            }
            requests.post(DISCORD_WEBHOOK_URL, json=payload)
            print(f"Sent alert for {alert['title']}")
    else:
        print("No alerts triggered this hour.")

if __name__ == "__main__":
    notify()
