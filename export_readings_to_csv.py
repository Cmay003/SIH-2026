"""
SANJEEVNI - Export accumulated readings from sanjeevni.db into training CSVs.

Run this after you've collected real sensor history, then hand-label
flood_event / is_anomaly for the exported rows before running train_models.py.

Run: python export_readings_to_csv.py
"""

import sqlite3
import pandas as pd
import os

DB_PATH = "sanjeevni.db"
OUT_DIR = "data"
os.makedirs(OUT_DIR, exist_ok=True)

conn = sqlite3.connect(DB_PATH)
df = pd.read_sql_query("SELECT * FROM readings", conn)
conn.close()

if df.empty:
    print("No readings found in sanjeevni.db yet - run the system for a while first.")
else:
    flood_cols = [
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
    anomaly_cols = [
        "river_level_m",
        "temp_c",
        "humidity_pct",
        "gas_ppm",
        "flame_reading",
    ]

    flood_df = df[[c for c in flood_cols if c in df.columns]].copy()
    flood_df["flood_event"] = ""  # fill in 0/1 by hand before training
    flood_df.to_csv(os.path.join(OUT_DIR, "flood_history_export.csv"), index=False)

    anomaly_df = df[[c for c in anomaly_cols if c in df.columns]].copy()
    anomaly_df["is_anomaly"] = (
        ""  # fill in 0/1 by hand, or leave blank column and delete it
    )
    anomaly_df.to_csv(os.path.join(OUT_DIR, "anomaly_history_export.csv"), index=False)

    print(f"Exported {len(flood_df)} rows to data/flood_history_export.csv")
    print(f"Exported {len(anomaly_df)} rows to data/anomaly_history_export.csv")
    print("Label the flood_event / is_anomaly columns, then rename to")
    print("flood_history.csv / anomaly_history.csv and run train_models.py")
