import sqlite3
import random
from datetime import datetime, timedelta
from database import DB_PATH, init_db

def generate_mock_data():
    init_db()
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Clear existing data
    cursor.execute("DELETE FROM ticket_prices")
    cursor.execute("DELETE FROM matches")
    
    # 2026 World Cup starts June 11, 2026, ends July 19, 2026.
    # Let's generate a few upcoming matches.
    matches = [
        (1, '2026-06-11 12:00:00', 'Mexico', 'TBD', 'Estadio Azteca', 'Mexico City', 'Group Stage'),
        (2, '2026-06-12 12:00:00', 'USA', 'TBD', 'SoFi Stadium', 'Los Angeles', 'Group Stage'),
        (3, '2026-06-12 15:00:00', 'Canada', 'TBD', 'BMO Field', 'Toronto', 'Group Stage'),
        (50, '2026-06-28 15:00:00', 'TBD', 'TBD', 'MetLife Stadium', 'New York', 'Round of 32'),
        (104, '2026-07-19 12:00:00', 'TBD', 'TBD', 'MetLife Stadium', 'New York', 'Final')
    ]
    
    cursor.executemany("""
        INSERT INTO matches (match_number, date, team_a, team_b, stadium, city, stage)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    """, matches)
    
    # Generate mock price trends for the past 90 days.
    # Today is roughly May 2026, let's simulate from Feb 2026 to May 2026.
    # We will use today's date minus 90 days.
    platforms = ['FIFA', 'StubHub', 'SeatGeek']
    today = datetime.now()
    
    price_data = []
    
    # Base prices depending on stage
    base_prices = {
        'Group Stage': 150,
        'Round of 32': 250,
        'Final': 800
    }
    
    cursor.execute("SELECT id, stage FROM matches")
    inserted_matches = cursor.fetchall()
    
    for match_id, stage in inserted_matches:
        base = base_prices.get(stage, 200)
        
        for i in range(90, -1, -1):
            date_scraped = (today - timedelta(days=i)).strftime('%Y-%m-%d')
            
            for platform in platforms:
                # FIFA price is usually static, others fluctuate.
                if platform == 'FIFA':
                    if i < 30 and random.random() < 0.2:
                        price = base # available occasionally
                    else:
                        continue # sold out mostly
                else:
                    # Fluctuate based on days closer to match.
                    # It goes up as we get closer.
                    trend_multiplier = 1 + (90 - i) * 0.01 
                    noise = random.uniform(0.9, 1.2)
                    platform_premium = 1.5 if platform == 'StubHub' else 1.4
                    
                    price = round(base * trend_multiplier * noise * platform_premium, 2)
                
                url = f"https://www.{platform.lower()}.com/tickets/world-cup-2026"
                price_data.append((match_id, date_scraped, platform, price, 'USD', url))
    
    cursor.executemany("""
        INSERT INTO ticket_prices (match_id, date_scraped, platform, lowest_price, currency, url)
        VALUES (?, ?, ?, ?, ?, ?)
    """, price_data)
    
    conn.commit()
    conn.close()
    print(f"Generated mock data for {len(matches)} matches and {len(price_data)} price records.")

if __name__ == "__main__":
    generate_mock_data()
