"""History append helpers for high-frequency scrape workflows."""

from __future__ import annotations

from pathlib import Path

import pandas as pd


def _isoformat_utc(series: pd.Series) -> pd.Series:
    return series.map(lambda value: value.isoformat() if pd.notna(value) else "")


def append_incremental_history(
    *,
    snapshot_df: pd.DataFrame,
    history_path: str | Path,
    id_col: str,
    observed_col: str,
    price_col: str,
    min_minutes_between_same_price: int = 30,
) -> int:
    """Append only meaningful history points.

    GitHub Actions may run every few minutes. Appending every unchanged price for
    every event creates huge CSVs without adding trend signal. This keeps a new
    point when the price changed, or when the same price has not been recorded
    for that event for at least ``min_minutes_between_same_price``.
    """

    history_path = Path(history_path)
    required = [id_col, observed_col, price_col]
    new_rows = snapshot_df[required].dropna(subset=[id_col, observed_col, price_col]).copy()
    if new_rows.empty:
        return 0

    new_rows[id_col] = new_rows[id_col].astype(str)
    new_rows[price_col] = pd.to_numeric(new_rows[price_col], errors="coerce")
    new_rows[observed_col] = pd.to_datetime(new_rows[observed_col], utc=True, errors="coerce")
    new_rows = new_rows.dropna(subset=[price_col, observed_col])
    if new_rows.empty:
        return 0

    if not history_path.exists() or history_path.stat().st_size == 0:
        write_df = new_rows.copy()
        write_df[observed_col] = _isoformat_utc(write_df[observed_col])
        write_df.to_csv(history_path, index=False)
        return len(write_df)

    try:
        hist = pd.read_csv(history_path, dtype={id_col: str})
    except Exception:
        hist = pd.DataFrame(columns=required)

    if hist.empty or not set(required).issubset(hist.columns):
        write_df = new_rows.copy()
        write_df[observed_col] = _isoformat_utc(write_df[observed_col])
        write_df.to_csv(history_path, mode="a", header=not history_path.exists(), index=False)
        return len(write_df)

    hist[id_col] = hist[id_col].astype(str)
    hist[price_col] = pd.to_numeric(hist[price_col], errors="coerce")
    hist[observed_col] = pd.to_datetime(hist[observed_col], utc=True, errors="coerce")
    hist = hist.dropna(subset=[id_col, observed_col, price_col])

    latest_by_id = hist.sort_values(observed_col).groupby(id_col).tail(1).set_index(id_col)
    keep_rows = []
    min_delta = pd.Timedelta(minutes=min_minutes_between_same_price)

    for _, row in new_rows.iterrows():
        event_id = row[id_col]
        if event_id not in latest_by_id.index:
            keep_rows.append(row)
            continue
        previous = latest_by_id.loc[event_id]
        price_changed = float(previous[price_col]) != float(row[price_col])
        old_enough = row[observed_col] - previous[observed_col] >= min_delta
        if price_changed or old_enough:
            keep_rows.append(row)

    if not keep_rows:
        return 0

    write_df = pd.DataFrame(keep_rows, columns=required)
    write_df[observed_col] = _isoformat_utc(write_df[observed_col])
    write_df.to_csv(history_path, mode="a", header=False, index=False)
    return len(write_df)
