import streamlit as st
import pandas as pd
import plotly.express as px
import os

CSV_PATH = os.path.join(os.path.dirname(__file__), "seatgeek_data.csv")

st.set_page_config(page_title="2026 World Cup Ticket Monitor", page_icon="⚽", layout="wide")

@st.cache_data(ttl=60)
def load_data():
    df = pd.read_csv(CSV_PATH)
    
    def parse_date(date_str):
        try:
            parts = date_str.split('·')
            date_part = parts[0].split(',')[1].strip() + " 2026"
            time_part = parts[1].strip()
            full_str = f"{date_part} {time_part}"
            return pd.to_datetime(full_str, format="%b %d %Y %I:%M%p")
        except:
            return pd.NaT

    df['parsed_date'] = df['date_time'].apply(parse_date)
    
    # Identify NJ/Nearby Matches
    nearby_cities = ['New York / New Jersey', 'Philadelphia, PA', 'Boston, MA']
    df['is_nearby'] = df['host_city'].apply(lambda x: any(city in x for city in nearby_cities))
    
    return df

def main():
    st.title("⚽ 2026 World Cup Ticket Monitoring Dashboard")
    st.markdown("Track daily ticket prices. **Focus: NJ / Philadelphia / Boston Matches.**")
    
    try:
        df = load_data()
    except FileNotFoundError:
        st.warning("No data found. Please ensure `seatgeek_data.csv` is present.")
        return

    st.markdown("---")
    
    # --- UPCOMING MATCHES FOCUS ---
    st.header("🔥 Best Deals for NJ / Local Matches")
    st.markdown("Cheapest available tickets across **New York / New Jersey**, **Philadelphia**, and **Boston** matches.")
    
    nearby_df = df[df['is_nearby'] == True]
    cheapest = nearby_df.nsmallest(5, 'latest_low_usd')
    
    cols = st.columns(len(cheapest))
    for i, row in enumerate(cheapest.itertuples()):
        with cols[i % len(cols)]:
            st.metric(label=f"{row.match} ({row.stage})", 
                      value=f"${row.latest_low_usd:,.0f}", 
                      delta=f"Via {row.source}", delta_color="off")
            st.caption(f"{row.date_time} | {row.host_city}")
            st.markdown(f"[Buy Tickets]({row.url})")

    st.markdown("---")
    
    # --- TRENDS ---
    st.header("📈 Ticket Price Trends")
    st.markdown("Select a match to view its historical price trends (Jan - Latest).")
    
    match_list = df.apply(lambda x: f"{x['match']} - {x['stage']} ({x['host_city']})", axis=1).unique()
    selected_match = st.selectbox("Select Match", match_list)
    
    if selected_match:
        match_name = selected_match.split(" - ")[0]
        match_data = df[df['match'] == match_name].iloc[0]
        
        # Dynamically find all columns ending in '_low_usd' that are part of the trend
        trend_cols = [c for c in df.columns if c.endswith('_low_usd') and c != 'latest_low_usd']
        
        # Create user-friendly labels from column names (e.g. 'jan_2026_low_usd' -> 'Jan 2026')
        def format_month_label(col_name):
            parts = col_name.replace('_low_usd', '').split('_')
            return " ".join([p.capitalize() for p in parts])
            
        months = [format_month_label(c) for c in trend_cols]
        prices = [match_data[c] for c in trend_cols]
        
        trend_df = pd.DataFrame({
            'Time': months,
            'Price (USD)': prices
        })
        
        trend_df = trend_df.dropna()
        
        if len(trend_df) > 1:
            fig = px.line(trend_df, x="Time", y="Price (USD)", 
                          title=f"Price Trend per Ticket: {match_name}",
                          markers=True)
            st.plotly_chart(fig, use_container_width=True)
        else:
            st.info("Not enough historical data to show a trend for this match (Baseline).")

    st.markdown("---")
    
    # --- COMPREHENSIVE TABLE ---
    st.header("📊 All Matches")
    
    filter_nearby = st.checkbox("Show ONLY NJ / Philadelphia / Boston Matches", value=True)
    
    display_df = nearby_df if filter_nearby else df
    
    display_cols = ['stage', 'match', 'date_time', 'host_city', 'latest_low_usd', 'change_vs_previous_usd', 'url']
    final_df = display_df[display_cols].copy()
    
    final_df.rename(columns={
        'stage': 'Stage',
        'match': 'Match',
        'date_time': 'Date',
        'host_city': 'City',
        'latest_low_usd': 'Price per Ticket ($)',
        'change_vs_previous_usd': 'Price Change ($)',
        'url': 'Link'
    }, inplace=True)
    
    # Format Price
    final_df['Price per Ticket ($)'] = final_df['Price per Ticket ($)'].apply(lambda x: f"${x:,.0f}" if pd.notnull(x) else "N/A")
    final_df['Price Change ($)'] = final_df['Price Change ($)'].apply(lambda x: f"${x:,.0f}" if pd.notnull(x) else "-")
    
    st.dataframe(
        final_df, 
        use_container_width=True, 
        hide_index=True,
        column_config={
            "Link": st.column_config.LinkColumn("Ticket Link")
        }
    )

if __name__ == "__main__":
    main()
