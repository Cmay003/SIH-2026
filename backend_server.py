"""
SANJEEVNI - Backend Server (FastAPI, AI layer)
Run: uvicorn backend_server:app --host 0.0.0.0 --port 8000 --reload
"""

import sqlite3
import os
import joblib
import requests
import statistics
from collections import deque
from datetime import datetime, timezone, timedelta
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from integration_pipeline import (
    train_flood_model,
    train_anomaly_detector,
    process_reading,
)
from rag_alert_pipeline import build_knowledge_base

app = FastAPI(title="SANJEEVNI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "sanjeevni.db"

NODE_REGISTRY = {
    "NODE-04": {
        "location": "Sector 4, Riverside",
        "land_use": "urban_low",
        "curve_number": 78,
        "latitude": 29.374496,
        "longitude": 79.530083,
        "upstream_node": None,
    },
    "NODE-07": {
        "location": "Sector 7, Hillside",
        "land_use": "forest",
        "curve_number": 45,
        "latitude": 29.4002,
        "longitude": 79.4610,
        "upstream_node": None,
    },
    "NODE-INDB": {
        "location": "Industrial Zone B",
        "land_use": "urban_high",
        "curve_number": 90,
        "latitude": 29.3850,
        "longitude": 79.4480,
        "upstream_node": None,
    },
}

HISTORY_WINDOW = 50
node_history: dict[str, deque] = {
    n: deque(maxlen=HISTORY_WINDOW) for n in NODE_REGISTRY
}

# --- Weather forecast enrichment (cloud-side only) ---------------------
# Uses Open-Meteo (https://open-meteo.com) - free, no API key required.
# This is a forecast SIGNAL fed into the flood model as an extra feature
# (rain that hasn't fallen yet), not a replacement for the node's own rain
# gauge. It only runs on the backend, where internet is assumed available -
# the ESP32 edge nodes themselves stay fully offline-capable as designed.
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"
WEATHER_CACHE_TTL_MINUTES = 30  # forecasts don't change meaningfully faster than this
WEATHER_FETCH_TIMEOUT_SECONDS = 5

_weather_cache: dict[str, dict] = (
    {}
)  # node_id -> {"value": float, "fetched_at": datetime}


def fetch_forecast_rainfall_mm(
    latitude: float, longitude: float, node_id: str
) -> Optional[float]:
    """
    Returns forecasted rainfall (mm) for the next 6 hours at this node's
    location, from Open-Meteo's free hourly precipitation forecast.

    Cached per node for WEATHER_CACHE_TTL_MINUTES so we don't hit the API
    on every single sensor reading - readings can arrive every few
    seconds, but a rain forecast is meaningless to re-fetch that often.

    Returns None if the fetch fails and there's no usable cached value
    (e.g. no internet, API down, bad response). Callers should treat None
    as "forecast unavailable" and fall back gracefully - a weather API
    outage should never crash the ingest pipeline or block a real hazard
    reading from being processed.
    """
    now = datetime.now(timezone.utc)
    cached = _weather_cache.get(node_id)
    if cached and (now - cached["fetched_at"]) < timedelta(
        minutes=WEATHER_CACHE_TTL_MINUTES
    ):
        return cached["value"]

    try:
        response = requests.get(
            OPEN_METEO_URL,
            params={
                "latitude": latitude,
                "longitude": longitude,
                "hourly": "precipitation",
                "forecast_days": 1,
                "timezone": "UTC",
            },
            timeout=WEATHER_FETCH_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        payload = response.json()

        hourly_times = payload["hourly"]["time"]
        hourly_precip = payload["hourly"]["precipitation"]

        current_hour_key = now.strftime("%Y-%m-%dT%H:00")
        start_idx = (
            hourly_times.index(current_hour_key)
            if current_hour_key in hourly_times
            else 0
        )

        forecast_6h_mm = float(sum(hourly_precip[start_idx : start_idx + 6]))

        _weather_cache[node_id] = {"value": forecast_6h_mm, "fetched_at": now}
        return forecast_6h_mm

    except Exception as e:
        print(f"[weather] forecast fetch failed for {node_id}: {e}")
        # Fall back to the last good cached value rather than nothing, if we have one
        return cached["value"] if cached else None


# Thresholds used to project "when will this become critical" from the
# current rate of change. Simple linear extrapolation, not a separate model.
FLOOD_CRITICAL_LEVEL_M = 3.5
GAS_CRITICAL_PPM = 800
MAX_ETA_HOURS = 48  # ignore projections further out than this - too unreliable


def estimate_eta_minutes(current: float, rate_per_hr: float, threshold: float):
    """Minutes until `current` reaches `threshold` at the current rate.
    Returns None if not rising toward the threshold, or if already past it,
    or if the projection is too far out to be meaningful."""
    if current >= threshold:
        return 0
    if rate_per_hr is None or rate_per_hr <= 0:
        return None
    hours = (threshold - current) / rate_per_hr
    if hours > MAX_ETA_HOURS:
        return None
    return round(hours * 60)


_flood_model = None
_flood_feature_cols = None
_anomaly_model = None
_anomaly_scaler = None
_rag_collection = None
_rag_embedder = None


def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS readings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            node_id TEXT,
            location TEXT,
            river_level_m REAL,
            temp_c REAL,
            humidity_pct REAL,
            gas_ppm REAL,
            flame_reading REAL,
            rainfall_24h_mm REAL,
            forecast_rainfall_6h_mm REAL,
            status TEXT,
            hazard_type TEXT,
            risk_score REAL,
            severity TEXT,
            message TEXT,
            eta_minutes REAL,
            predicted_time TEXT,
            timestamp TEXT
        )
    """)
    # NOTE: "CREATE TABLE IF NOT EXISTS" does NOT alter a table that
    # already exists. If you already have a sanjeevni.db from before this
    # change, the new column won't just appear - add it explicitly so old
    # databases pick it up without deleting existing history.
    existing_cols = {row[1] for row in conn.execute("PRAGMA table_info(readings)")}
    if "forecast_rainfall_6h_mm" not in existing_cols:
        conn.execute("ALTER TABLE readings ADD COLUMN forecast_rainfall_6h_mm REAL")
    conn.commit()
    conn.close()


def save_reading(enriched: dict, result: dict, timestamp: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """INSERT INTO readings
           (node_id, location, river_level_m, temp_c, humidity_pct, gas_ppm,
            flame_reading, rainfall_24h_mm, forecast_rainfall_6h_mm, status,
            hazard_type, risk_score, severity, message, eta_minutes,
            predicted_time, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        (
            enriched["node_id"],
            enriched["location"],
            enriched["river_level_m"],
            enriched["temp_c"],
            enriched["humidity_pct"],
            enriched["gas_ppm"],
            enriched["flame_reading"],
            enriched["rainfall_24h_mm"],
            enriched.get("forecast_rainfall_6h_mm"),
            result["status"],
            result.get("hazard_type"),
            result.get("risk_score"),
            result.get("severity"),
            result.get("message"),
            result.get("eta_minutes"),
            result.get("predicted_time"),
            timestamp,
        ),
    )
    conn.commit()
    conn.close()


# --- HC-SR04 ultrasonic distance -> actual water-level conversion -------
# CONFIRMED from the actual firmware: the ESP32 sends raw distance
# (sensor-to-surface, cm -> m) directly as "river_level_m", with NO
# inversion. That means the relationship arriving here is BACKWARDS -
# empty container = large distance = large raw value; water rising
# TOWARD the sensor = SMALL distance = SMALL raw value. Every feature
# and model downstream assumes the opposite (bigger river_level_m = more
# water = more danger), so this MUST be inverted before use anywhere.
#
# ULTRASONIC_MOUNT_HEIGHT_M is the distance from the sensor to the
# container's empty floor - i.e. what the sensor reads when there's no
# water at all. Defaulted to 0.40m because that's literally the
# firmware's own DISTANCE_LIMIT (40.0 cm) - the distance the firmware
# itself already treats as "alert-worthy close." If your sensor is
# physically mounted at a different height, change this one number.
#
# >>> If you can measure your actual mounting height, update this. <<<
ULTRASONIC_MOUNT_HEIGHT_M = (
    0.0234  # measured: sensor sits only 2.34cm above empty baseline
)

# Set this to True ONLY after you've flashed updated firmware that does
# the distance -> water-level inversion itself (see the .ino code you
# were given alongside this). Leave it False while running the CURRENT
# firmware (which sends raw, uninverted distance) - the backend does the
# inversion in that case. Flipping this incorrectly would either leave
# the value uninverted (False when firmware already inverted it) or
# double-invert it back to nonsense (True when firmware still sends raw
# distance) - only ONE side should ever do this conversion.
FIRMWARE_SENDS_CORRECTED_WATER_LEVEL = True


def convert_ultrasonic_distance_to_water_level_m(
    raw_value_m: float, previous_water_level_m: float | None
) -> float:
    """Converts the firmware's raw (uninverted) distance reading into an
    actual water-level value: 0 = empty, ULTRASONIC_MOUNT_HEIGHT_M = full
    (water touching the sensor).

    Handles the firmware's "-1" sentinel (no echo received - the
    HC-SR04 got no valid reading at all) by falling back to the previous
    known-good water level rather than treating -1 meters as a real,
    valid, extremely-negative reading."""
    if raw_value_m is None or raw_value_m < 0:
        # "-1" sentinel (or any other invalid negative) - no valid echo.
        # Don't invent a reading; hold the last known value if we have
        # one, else assume empty (0.0) as the safest default.
        return previous_water_level_m if previous_water_level_m is not None else 0.0

    if FIRMWARE_SENDS_CORRECTED_WATER_LEVEL:
        # Firmware already inverted distance -> water level itself.
        # Just clamp to the valid range - no second inversion here.
        return max(0.0, min(ULTRASONIC_MOUNT_HEIGHT_M, raw_value_m))

    water_level_m = ULTRASONIC_MOUNT_HEIGHT_M - raw_value_m
    return max(0.0, min(ULTRASONIC_MOUNT_HEIGHT_M, water_level_m))


WATER_LEVEL_SMOOTHING_WINDOW = (
    5  # readings; at a 5s send interval, ~20-25s of smoothing
)


def smooth_water_level(history: deque, current_value: float) -> float:
    """Median-smooths the water level over the last few readings, so a
    single noisy/spiked HC-SR04 reading can't alone trigger a false
    MEDIUM/HIGH. A sustained real change still comes through within a
    few readings - only an isolated one-off spike gets outvoted by the
    surrounding normal readings around it."""
    recent = [
        r["river_level_m"] for r in list(history)[-(WATER_LEVEL_SMOOTHING_WINDOW - 1) :]
    ]
    recent.append(current_value)
    return statistics.median(recent)


class RawReading(BaseModel):
    node_id: str
    river_level_m: float
    temp_c: float
    humidity_pct: float
    gas_ppm: float
    flame_reading: float
    rainfall_mm_since_last: float = 0.0
    timestamp: Optional[str] = None


@app.on_event("startup")
def startup():
    global _flood_model, _flood_feature_cols, _anomaly_model, _anomaly_scaler
    global _rag_collection, _rag_embedder
    init_db()

    models_dir = "models"
    flood_path = os.path.join(models_dir, "flood_model.joblib")
    flood_cols_path = os.path.join(models_dir, "flood_feature_cols.joblib")
    anomaly_path = os.path.join(models_dir, "anomaly_model.joblib")
    scaler_path = os.path.join(models_dir, "anomaly_scaler.joblib")

    if os.path.exists(flood_path) and os.path.exists(flood_cols_path):
        print("Loading trained flood model from models/ ...")
        _flood_model = joblib.load(flood_path)
        _flood_feature_cols = joblib.load(flood_cols_path)
    else:
        print(
            "No saved flood model found - training on synthetic data (run train_models.py to use real data)..."
        )
        _flood_model, _flood_feature_cols = train_flood_model()

    if os.path.exists(anomaly_path) and os.path.exists(scaler_path):
        print("Loading trained anomaly model from models/ ...")
        _anomaly_model = joblib.load(anomaly_path)
        _anomaly_scaler = joblib.load(scaler_path)
    else:
        print(
            "No saved anomaly model found - training on synthetic data (run train_models.py to use real data)..."
        )
        _anomaly_model, _anomaly_scaler = train_anomaly_detector()

    print("Building RAG knowledge base...")
    _rag_collection, _rag_embedder = build_knowledge_base()
    print("Backend ready.")


def derive_features(raw: RawReading) -> dict:
    if raw.node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown node_id '{raw.node_id}'")

    config = NODE_REGISTRY[raw.node_id]
    history = node_history[raw.node_id]

    # Convert raw HC-SR04 distance (mislabeled "river_level_m" by the
    # current firmware) into an actual water-level value. See
    # convert_ultrasonic_distance_to_water_level_m() above for the full
    # explanation - this MUST run before the raw value is used anywhere.
    converted_value = convert_ultrasonic_distance_to_water_level_m(
        raw.river_level_m, history[-1]["river_level_m"] if history else None
    )

    # Median-smooth over the last few readings. A single noisy HC-SR04
    # reading (e.g. a momentary multipath reflection reading ~0cm when
    # nothing is actually there) would otherwise be enough, on its own,
    # to trigger a false MEDIUM/HIGH under the sensitive test thresholds -
    # confirmed from a real reading that briefly implied 0cm before
    # returning to its normal ~10cm baseline a few seconds later. The
    # median outvotes a one-off spike while still responding to a real,
    # SUSTAINED change within a few readings.
    water_level_m = smooth_water_level(history, converted_value)

    if history:
        prev = history[-1]
        river_level_rate_m_per_hr = water_level_m - prev["river_level_m"]
        gas_ppm_rate_per_hr = raw.gas_ppm - prev["gas_ppm"]
    else:
        river_level_rate_m_per_hr = 0.0
        gas_ppm_rate_per_hr = 0.0

    rainfall_24h_mm = raw.rainfall_mm_since_last + sum(
        r["rainfall_mm_since_last"] for r in history
    )

    prev_saturation = history[-1]["soil_saturation"] if history else 0.3
    soil_saturation = min(
        1.0, max(0.0, prev_saturation * 0.98 + raw.rainfall_mm_since_last * 0.01)
    )

    upstream_node = config.get("upstream_node")
    if upstream_node and node_history.get(upstream_node):
        upstream_level_m = node_history[upstream_node][-1]["river_level_m"]
    else:
        upstream_level_m = water_level_m

    # Cloud-side weather enrichment - forecasted rain not yet reflected in
    # any sensor reading. None if the weather API is unreachable; the
    # pipeline must not depend on this to function.
    forecast_rainfall_6h_mm = fetch_forecast_rainfall_mm(
        config["latitude"], config["longitude"], raw.node_id
    )

    enriched = {
        "node_id": raw.node_id,
        "location": config["location"],
        "land_use": config["land_use"],
        "curve_number": config["curve_number"],
        "rainfall_24h_mm": rainfall_24h_mm,
        "rainfall_intensity_mm_hr": raw.rainfall_mm_since_last,
        "forecast_rainfall_6h_mm": forecast_rainfall_6h_mm,
        "river_level_m": water_level_m,
        "river_level_rate_m_per_hr": river_level_rate_m_per_hr,
        "upstream_level_m": upstream_level_m,
        "soil_saturation": soil_saturation,
        "temp_c": raw.temp_c,
        "humidity_pct": raw.humidity_pct,
        "gas_ppm": raw.gas_ppm,
        "gas_ppm_rate_per_hr": gas_ppm_rate_per_hr,
        "flame_reading": raw.flame_reading,
    }

    history.append(
        {
            "river_level_m": water_level_m,
            "rainfall_mm_since_last": raw.rainfall_mm_since_last,
            "soil_saturation": soil_saturation,
            "gas_ppm": raw.gas_ppm,
        }
    )

    return enriched


@app.post("/api/ingest")
def ingest_reading(raw: RawReading):
    timestamp = raw.timestamp or datetime.now(timezone.utc).isoformat()
    enriched = derive_features(raw)

    result = process_reading(
        enriched,
        _anomaly_model,
        _anomaly_scaler,
        _flood_model,
        _flood_feature_cols,
        _rag_collection,
        _rag_embedder,
    )
    result["timestamp"] = timestamp
    result["node_id"] = raw.node_id
    result["location"] = enriched["location"]
    result["latitude"] = NODE_REGISTRY[raw.node_id]["latitude"]
    result["longitude"] = NODE_REGISTRY[raw.node_id]["longitude"]
    result["river_level_m"] = enriched[
        "river_level_m"
    ]  # corrected water level, not the raw uninverted distance
    result["temp_c"] = raw.temp_c
    result["humidity_pct"] = raw.humidity_pct
    result["forecast_rainfall_6h_mm"] = enriched["forecast_rainfall_6h_mm"]

    eta_minutes = None
    if result.get("hazard_type") == "flood":
        eta_minutes = estimate_eta_minutes(
            enriched["river_level_m"],
            enriched["river_level_rate_m_per_hr"],
            FLOOD_CRITICAL_LEVEL_M,
        )
    elif result.get("hazard_type") == "gas leak":
        eta_minutes = estimate_eta_minutes(
            raw.gas_ppm, enriched["gas_ppm_rate_per_hr"], GAS_CRITICAL_PPM
        )

    result["eta_minutes"] = eta_minutes
    result["predicted_time"] = (
        (datetime.now(timezone.utc) + timedelta(minutes=eta_minutes)).isoformat()
        if eta_minutes is not None and eta_minutes > 0
        else None
    )

    save_reading(enriched, result, timestamp)

    return result


@app.get("/api/readings")
def get_readings(node_id: Optional[str] = None, limit: int = 50):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if node_id:
        rows = conn.execute(
            "SELECT * FROM readings WHERE node_id=? ORDER BY id DESC LIMIT ?",
            (node_id, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            "SELECT * FROM readings ORDER BY id DESC LIMIT ?", (limit,)
        ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/alerts")
def get_alerts(limit: int = 20):
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT * FROM readings WHERE status='alert_dispatched' ORDER BY id DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    return [dict(r) for r in rows]


@app.get("/api/nodes")
def get_nodes():
    out = []
    for node_id, config in NODE_REGISTRY.items():
        last = node_history[node_id][-1] if node_history[node_id] else None
        out.append(
            {
                "node_id": node_id,
                "location": config["location"],
                "land_use": config["land_use"],
                "latitude": config["latitude"],
                "longitude": config["longitude"],
                "last_river_level_m": last["river_level_m"] if last else None,
                "reading_count": len(node_history[node_id]),
            }
        )
    return out


@app.get("/api/health")
def health():
    return {"status": "ok", "models_loaded": _flood_model is not None}
