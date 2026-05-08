import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), "tickets.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    # Create matches table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS matches (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_number INTEGER,
            date TEXT,
            team_a TEXT,
            team_b TEXT,
            stadium TEXT,
            city TEXT,
            stage TEXT
        )
    """)
    
    # Create ticket_prices table
    cursor.execute("""
        CREATE TABLE IF NOT EXISTS ticket_prices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            match_id INTEGER,
            date_scraped TEXT,
            platform TEXT,
            lowest_price REAL,
            currency TEXT DEFAULT 'USD',
            url TEXT,
            FOREIGN KEY(match_id) REFERENCES matches(id)
        )
    """)
    
    conn.commit()
    conn.close()

if __name__ == "__main__":
    init_db()
    print("Database initialized successfully.")
