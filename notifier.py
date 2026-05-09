import os
import json
import pandas as pd
import requests

def send_telegram_message(token, chat_id, text):
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    payload = {
        "chat_id": chat_id,
        "text": text,
        "parse_mode": "Markdown"
    }
    try:
        response = requests.post(url, json=payload)
        response.raise_for_status()
        print("Telegram message sent successfully.")
    except Exception as e:
        print(f"Error sending Telegram message: {e}")

def main():
    # Load environment variables
    targets_json = os.environ.get("USER_TARGETS")
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")

    if not bot_token or not chat_id:
        print("Telegram credentials missing. Skipping notification.")
        return

    if not targets_json:
        print("No user targets defined. Skipping notification.")
        return

    try:
        targets = json.loads(targets_json)
    except Exception as e:
        print(f"Error parsing USER_TARGETS JSON: {e}")
        return

    # Load data
    try:
        sg_df = pd.read_csv("seatgeek_data.csv")
    except Exception as e:
        print(f"Error reading seatgeek_data.csv: {e}")
        return

    tp_df = pd.DataFrame()
    if os.path.exists("tickpick_data.csv"):
        try:
            tp_df = pd.read_csv("tickpick_data.csv")
        except:
            pass

    vs_df = pd.DataFrame()
    if os.path.exists("vivid_data.csv"):
        try:
            vs_df = pd.read_csv("vivid_data.csv")
        except:
            pass

    alerts = []

    for index, row in sg_df.iterrows():
        event_id = str(row.get("event_id"))
        match_name = row.get("match")
        sg_price = row.get("latest_low_usd")

        if event_id not in targets:
            continue

        target_price = float(targets[event_id])

        # Find prices from other sources
        prices = []
        if sg_price is not None and not pd.isna(sg_price):
            prices.append(float(sg_price))

        if not tp_df.empty:
            tp_match = tp_df[tp_df['name'].str.contains(match_name, na=False)]
            if not tp_match.empty:
                tp_price = tp_match['low_price_usd'].iloc[0]
                if not pd.isna(tp_price):
                    prices.append(float(tp_price))

        if not vs_df.empty:
            vs_match = vs_df[vs_df['name'].str.contains(match_name, na=False)]
            if not vs_match.empty:
                vs_price = vs_match['low_price_usd'].iloc[0]
                if not pd.isna(vs_price):
                    prices.append(float(vs_price))

        if not prices:
            continue

        min_price = min(prices)

        if min_price <= target_price:
            alerts.append(f"🎯 *{match_name}* hit target!\n💰 Price: ${min_price:.0f} (Target: ${target_price:.0f})")

    if alerts:
        message = "🔔 *World Cup Ticket Alerts*\n\n" + "\n\n".join(alerts)
        send_telegram_message(bot_token, chat_id, message)
    else:
        print("No targets hit.")

if __name__ == "__main__":
    main()
