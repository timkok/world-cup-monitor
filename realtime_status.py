#!/usr/bin/env python3
"""Generate a compact realtime status file for the static dashboard.

The dashboard is served from GitHub Pages, so it cannot ask GitHub Actions for
run metadata directly. This script inspects the committed CSV snapshots and
writes realtime_status.json with per-source freshness, row counts, and the
freshest observed timestamp across all public sources.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import pandas as pd


BASE_DIR = Path(__file__).resolve().parent
OUTPUT_PATH = BASE_DIR / "realtime_status.json"

SOURCE_FILES = {
    "SeatGeek": {
        "path": BASE_DIR / "seatgeek_data.csv",
        "time_col": "latest_observed_at",
        "price_col": "latest_low_usd",
    },
    "TickPick": {
        "path": BASE_DIR / "tickpick_data.csv",
        "time_col": "observed_at",
        "price_col": "low_price_usd",
    },
    "Vivid": {
        "path": BASE_DIR / "vivid_data.csv",
        "time_col": "observed_at",
        "price_col": "low_price_usd",
    },
    "FIFA": {
        "path": BASE_DIR / "fifa_marketplace_data.csv",
        "time_col": "observed_at",
        "price_col": "low_price_usd",
    },
}


def parse_times(series: pd.Series) -> pd.Series:
    return pd.to_datetime(series.dropna(), utc=True, errors="coerce").dropna()


def freshness_status(age_minutes: float | None) -> str:
    if age_minutes is None:
        return "Missing"
    if age_minutes < 90:
        return "Fresh"
    if age_minutes < 360:
        return "Stale"
    return "Very stale"


def source_status(name: str, config: dict[str, Any], now: datetime) -> dict[str, Any]:
    path = config["path"]
    if not path.exists():
        return {
            "source": name,
            "status": "Missing",
            "rows": 0,
            "priced_rows": 0,
            "latest_observed_at": None,
            "age_minutes": None,
            "note": "CSV file missing",
        }

    try:
        df = pd.read_csv(path)
    except Exception as exc:  # noqa: BLE001 - status file should capture parse failures
        return {
            "source": name,
            "status": "Missing",
            "rows": 0,
            "priced_rows": 0,
            "latest_observed_at": None,
            "age_minutes": None,
            "note": f"CSV parse failed: {exc}",
        }

    rows = len(df)
    price_col = config["price_col"]
    priced_rows = int(pd.to_numeric(df.get(price_col, pd.Series(dtype=float)), errors="coerce").notna().sum())

    time_col = config["time_col"]
    if time_col not in df.columns or df.empty:
        latest = None
    else:
        times = parse_times(df[time_col])
        latest = times.max().to_pydatetime() if not times.empty else None

    age_minutes = (now - latest).total_seconds() / 60 if latest else None
    return {
        "source": name,
        "status": freshness_status(age_minutes),
        "rows": rows,
        "priced_rows": priced_rows,
        "latest_observed_at": latest.isoformat() if latest else None,
        "age_minutes": round(age_minutes, 1) if age_minutes is not None else None,
        "note": "",
    }


def build_status() -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    sources = {name: source_status(name, config, now) for name, config in SOURCE_FILES.items()}

    latest_values = [
        datetime.fromisoformat(item["latest_observed_at"])
        for item in sources.values()
        if item.get("latest_observed_at")
    ]
    latest_any = max(latest_values) if latest_values else None
    aggregate_age = (now - latest_any).total_seconds() / 60 if latest_any else None

    return {
        "generated_at": now.isoformat(),
        "aggregate": {
            "status": freshness_status(aggregate_age),
            "latest_observed_at": latest_any.isoformat() if latest_any else None,
            "age_minutes": round(aggregate_age, 1) if aggregate_age is not None else None,
        },
        "sources": sources,
    }


def main() -> int:
    status = build_status()
    OUTPUT_PATH.write_text(json.dumps(status, indent=2, sort_keys=True) + "\n")
    print(f"Wrote {OUTPUT_PATH}")
    print(json.dumps(status["aggregate"], indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
