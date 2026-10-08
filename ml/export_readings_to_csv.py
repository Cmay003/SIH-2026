"""
SANJEEVNI - Export accumulated readings from sanjeevni.db into training CSVs.

Run this after you've collected real sensor history, then hand-label
flood_event / is_anomaly for the exported rows before running train_models.py.

Only REAL hardware readings are exported by default. Simulator rows
(simulation.js) and rows whose origin is unknown (saved before the
`simulated` column existed) are skipped - training on simulator output
would just teach the model the simulator's own random-number rules.
Pass --include-simulated to export them anyway (e.g. to test the pipeline).

Run: python export_readings_to_csv.py [--include-simulated]
"""

import argparse
import os
import sqlite3

import pandas as pd
import os as _os
import sys as _sys

# backend/ holds the shared modules + paths.py (file locations)
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "backend"))
import paths  # noqa: E402

DB_PATH = paths.DB_PATH
OUT_DIR = paths.DATA_DIR

# Must match train_models.py's FLOOD_INPUT_COLS / ANOMALY_FEATURES.
FLOOD_COLS = [
    "land_use",
    "curve_number",
    "rainfall_24h_mm",
    "rainfall_intensity_mm_hr",
    "forecast_rainfall_6h_mm",
    "river_level_m",
    "river_level_rate_m_per_hr",
    "upstream_level_m",
    "soil_saturation",
]
ANOMALY_COLS = [
    "river_level_m",
    "temp_c",
    "humidity_pct",
    "gas_ppm",
    "flame_reading",
]
# Not used for training - exported only to help whoever hand-labels the
# rows see when/where a reading happened and what the system decided.
CONTEXT_COLS = ["id", "node_id", "timestamp", "status", "hazard_type", "severity", "risk_score"]


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "--include-simulated",
        action="store_true",
        help="also export simulator rows and rows saved before the 'simulated' column existed",
    )
    args = parser.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    df = pd.read_sql_query("SELECT * FROM readings", conn)
    conn.close()

    if df.empty:
        print("No readings found in sanjeevni.db yet - run the system for a while first.")
        return

    total = len(df)
    if not args.include_simulated:
        if "simulated" not in df.columns:
            df = df.iloc[0:0]
        else:
            df = df[df["simulated"] == 0]
        print(
            f"Using {len(df)} of {total} readings (skipped simulator rows and rows of "
            "unknown origin; pass --include-simulated to keep them)."
        )
    if df.empty:
        print("Nothing to export - collect readings from real hardware first.")
        return

    missing_cols = [c for c in FLOOD_COLS if c not in df.columns]
    if missing_cols:
        print(
            f"readings table has no {missing_cols} columns - start backend_server.py once "
            "so it migrates the database, then collect new readings."
        )
        return

    # Rows saved before every model input was stored have NULLs in those
    # columns; they can't be used for flood training.
    flood_df = df.dropna(subset=[c for c in FLOOD_COLS if c != "forecast_rainfall_6h_mm"])
    flood_df = flood_df[CONTEXT_COLS + FLOOD_COLS].copy()
    flood_df["flood_event"] = ""  # fill in 0/1 by hand before training
    flood_path = os.path.join(OUT_DIR, "flood_history_export.csv")
    flood_df.to_csv(flood_path, index=False)

    anomaly_df = df.dropna(subset=ANOMALY_COLS)[CONTEXT_COLS + ANOMALY_COLS].copy()
    anomaly_df["is_anomaly"] = ""  # fill in 0/1 by hand, or leave blank
    anomaly_path = os.path.join(OUT_DIR, "anomaly_history_export.csv")
    anomaly_df.to_csv(anomaly_path, index=False)

    skipped = len(df) - len(flood_df)
    print(f"Exported {len(flood_df)} rows to {flood_path}" + (
        f" ({skipped} older rows skipped - saved before all model inputs were stored)" if skipped else ""
    ))
    print(f"Exported {len(anomaly_df)} rows to {anomaly_path}")
    print("Label the flood_event / is_anomaly columns, then rename to")
    print("flood_history.csv / anomaly_history.csv and run train_models.py")


if __name__ == "__main__":
    main()
