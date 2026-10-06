"""
SANJEEVNI - Backend Server (FastAPI, AI layer)
Run: uvicorn backend_server:app --host 127.0.0.1 --port 8000
(127.0.0.1: only server.js on the same machine should reach this service.)
"""

import sqlite3
import os
import secrets
import joblib
import requests
import statistics
import threading
from contextlib import asynccontextmanager
import math
import tempfile
from collections import deque
from datetime import datetime, timezone, timedelta
from typing import Optional
from dotenv import load_dotenv

from predictive_maintenance import check_all_sensors_for_drift

from fastapi import FastAPI, HTTPException, Response, Header, Depends
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field

from integration_pipeline import (
    train_flood_model,
    train_anomaly_detector,
    process_reading,
    compute_flood_risk,
    explain_flood_risk,
)
from rag_alert_pipeline import build_knowledge_base, severity_band
from cap_alert import generate_cap_alert
from hazard_confirmation import HazardConfirmer
import river_forecast
from satellite_check import satellite_flood_check
from situation_report import generate_situation_report_pdf

@asynccontextmanager
async def lifespan(_app):
    # FastAPI's replacement for the deprecated @app.on_event("startup") (B30).
    # startup() is defined further down; it runs once the module is loaded.
    startup()
    yield


app = FastAPI(title="SANJEEVNI Backend", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "sanjeevni.db"

# Admin node-registry endpoints use the same OFFICER_API_KEY as server.js.
# There is NO fallback key: the old demo default was published in the repo,
# so anyone reaching this port could have edited or deleted nodes. Unset =
# admin endpoints disabled. Also run uvicorn with --host 127.0.0.1 so only
# server.js (same machine) can reach this service at all.
load_dotenv()
ADMIN_API_KEY = os.environ.get("OFFICER_API_KEY") or None
if not ADMIN_API_KEY:
    print("[auth] OFFICER_API_KEY not set - admin node-registry endpoints are disabled.")


def require_admin_auth(x_api_key: Optional[str] = Header(None)):
    if not ADMIN_API_KEY:
        raise HTTPException(status_code=503, detail="Admin API disabled - set OFFICER_API_KEY in .env")
    if not x_api_key or not secrets.compare_digest(x_api_key, ADMIN_API_KEY):
        raise HTTPException(
            status_code=401, detail="Unauthorized - valid X-API-Key header required"
        )


# Seed values for a first-run/empty database - these were the original
# hardcoded values. After the first startup, the DATABASE is the source
# of truth; this dict is only ever read once, to populate an empty table.
_SEED_NODES = {
    "NODE-04": {
        "location": "Sector 4, Riverside",
        "land_use": "urban_low",
        "curve_number": 78,
        "latitude": 29.3919,
        "longitude": 79.4542,
        # Hillside node drains toward the riverside node - lets the
        # spatial-correlation boost actually run (it never did while every
        # node had upstream_node = None). Demo topology: confirm against
        # the real terrain/drainage before field deployment.
        "upstream_node": "NODE-07",
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

# The live, in-memory node registry - kept as a plain dict so every
# EXISTING piece of code that does NODE_REGISTRY[node_id], .get(), .items(),
# or `in NODE_REGISTRY` keeps working completely unchanged. reload_node_registry()
# is the only thing that's new: it rebuilds this dict FROM THE DATABASE,
# called once at startup and again after every admin create/update/delete.
NODE_REGISTRY: dict = {}


def init_node_registry_table(conn):
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nodes (
            node_id TEXT PRIMARY KEY,
            location TEXT,
            land_use TEXT,
            curve_number REAL,
            latitude REAL,
            longitude REAL,
            upstream_node TEXT
        )
    """)
    # How often the node is expected to report (NULL = DEFAULT_REPORT_INTERVAL_SECONDS).
    # Deep-sleep / LoRa nodes report every few minutes, so "missing" must be
    # judged per node - see compute_node_health().
    node_cols = {row[1] for row in conn.execute("PRAGMA table_info(nodes)")}
    if "report_interval_seconds" not in node_cols:
        conn.execute("ALTER TABLE nodes ADD COLUMN report_interval_seconds REAL")
    row_count = conn.execute("SELECT COUNT(*) FROM nodes").fetchone()[0]
    if row_count == 0:
        for node_id, cfg in _SEED_NODES.items():
            conn.execute(
                "INSERT INTO nodes (node_id, location, land_use, curve_number, latitude, longitude, upstream_node) VALUES (?,?,?,?,?,?,?)",
                (
                    node_id,
                    cfg["location"],
                    cfg["land_use"],
                    cfg["curve_number"],
                    cfg["latitude"],
                    cfg["longitude"],
                    cfg["upstream_node"],
                ),
            )
        conn.commit()
        print(
            f"[nodes] Seeded {len(_SEED_NODES)} initial nodes into the database (first run)."
        )
    apply_seed_upstream_links_once(conn)


def apply_seed_upstream_links_once(conn):
    """Databases seeded before _SEED_NODES had upstream links keep
    upstream_node = NULL forever, since seeding only runs on an empty
    table. This copies the seed links over ONCE (recorded in schema_meta),
    and only where the field is still NULL - so a link an admin later
    removes or changes via the API is never overwritten again."""
    conn.execute(
        "CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT)"
    )
    marker = "seed_upstream_links_v1"
    if conn.execute("SELECT 1 FROM schema_meta WHERE key=?", (marker,)).fetchone():
        return
    for node_id, cfg in _SEED_NODES.items():
        if cfg["upstream_node"]:
            conn.execute(
                "UPDATE nodes SET upstream_node=? WHERE node_id=? AND upstream_node IS NULL "
                "AND EXISTS (SELECT 1 FROM nodes WHERE node_id=?)",
                (cfg["upstream_node"], node_id, cfg["upstream_node"]),
            )
    conn.execute(
        "INSERT INTO schema_meta (key, value) VALUES (?, ?)",
        (marker, datetime.now(timezone.utc).isoformat()),
    )
    conn.commit()


def reload_node_registry():
    """Rebuilds the in-memory NODE_REGISTRY dict from the database, and
    ensures node_history/node_health have an entry for every node -
    including ones added AFTER startup, which the old hardcoded-dict
    design could never do (a dict comprehension over NODE_REGISTRY only
    ran once, at import time)."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM nodes").fetchall()
    conn.close()

    NODE_REGISTRY.clear()
    for row in rows:
        NODE_REGISTRY[row["node_id"]] = {
            "location": row["location"],
            "land_use": row["land_use"],
            "curve_number": row["curve_number"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "upstream_node": row["upstream_node"],
            "report_interval_seconds": row["report_interval_seconds"],
        }
        # Lazily create history/health tracking for any node not seen
        # before (e.g. just added via the admin API) - never overwrites
        # existing history for a node that already had readings.
        if row["node_id"] not in node_history:
            node_history[row["node_id"]] = deque(maxlen=HISTORY_WINDOW)
        if row["node_id"] not in node_health:
            node_health[row["node_id"]] = {}


HISTORY_WINDOW = 50
# UPGRADE: previously a dict comprehension over the hardcoded
# NODE_REGISTRY, which only ever ran once at import time - a node added
# later via the admin API would have crashed with a KeyError the first
# time a reading came in. Now starts empty and gets populated (for both
# startup-time and later-added nodes) by reload_node_registry().
node_history: dict[str, deque] = {}

# UPGRADE: node health telemetry - last-seen timestamp, battery %, signal
# strength per node. Simple in-memory dict (like node_history) - resets
# on server restart, which is fine since it's live status, not history.
node_health: dict[str, dict] = {}

# --- UPGRADE: terrain elevation -> auto-derived curve number ------------
# Uses Open-Elevation (https://open-elevation.com) - free, no API key,
# open-source (self-hostable if the public instance is rate-limited).
# Replaces a HAND-TYPED curve_number guess in NODE_REGISTRY with one
# derived from real terrain slope around the node. Cached indefinitely
# per node (elevation doesn't change), computed once and reused.
#
# Curve Number theory note: CN is primarily driven by land cover + soil
# type (which is why land_use still anchors the BASE value below) - slope
# is a secondary, real modifier used in several SCS-CN extensions
# (steeper terrain sheds water faster, raising effective runoff response
# even for the same land cover). This applies a modest, capped adjustment
# on top of the land-use base, not a replacement for it.
OPEN_ELEVATION_URL = "https://api.open-elevation.com/api/v1/lookup"
ELEVATION_FETCH_TIMEOUT_SECONDS = 8
ELEVATION_SAMPLE_OFFSET_DEG = 0.001  # ~100m at these latitudes

_elevation_cache: dict[str, dict] = (
    {}
)  # node_id -> {"curve_number": float, "slope_pct": float}

# Land-use base CN (matches the ranges already used in flood_risk_model.py's
# synthetic generator, so a node's auto-derived value stays consistent
# with how the model was trained).
LAND_USE_BASE_CN = {
    "forest": 45,
    "agricultural": 65,
    "urban_low": 80,
    "urban_high": 90,
}
SLOPE_CN_ADJUSTMENT_MAX = 6  # cap - slope alone can't swing CN wildly

# Back-off for external APIs. Without it, a failed lookup was retried on
# EVERY reading, so with no internet each ingest blocked for up to 8s
# (elevation) + 5s (weather) - longer than the nodes' 5s send interval.
# After one failure, an API is skipped for this long (globally, not per
# node - "no internet" affects every node at once).
EXTERNAL_API_RETRY_AFTER_MINUTES = 10
_api_failed_at: dict[str, datetime] = {}  # "elevation"/"weather" -> last failure


def _api_in_backoff(api_name: str) -> bool:
    failed_at = _api_failed_at.get(api_name)
    return failed_at is not None and datetime.now(timezone.utc) - failed_at < timedelta(
        minutes=EXTERNAL_API_RETRY_AFTER_MINUTES
    )


def fetch_terrain_derived_curve_number(
    latitude: float, longitude: float, land_use: str, node_id: str
) -> Optional[dict]:
    """Returns {"curve_number": float, "slope_pct": float, "source": str}
    or None if the API is unreachable - callers should fall back to the
    NODE_REGISTRY's hand-typed curve_number in that case, exactly like
    the weather API's fallback pattern.

    Fetches elevation at the node plus 4 points offset ~100m in each
    cardinal direction, computes the steepest gradient among them as the
    local slope, and applies a small, capped adjustment on top of the
    land-use base CN - steeper terrain nudges CN up (faster runoff),
    flatter terrain nudges it down slightly.
    """
    if node_id in _elevation_cache:
        return _elevation_cache[node_id]
    if _api_in_backoff("elevation"):
        return None

    try:
        points = [
            (latitude, longitude),
            (latitude + ELEVATION_SAMPLE_OFFSET_DEG, longitude),
            (latitude - ELEVATION_SAMPLE_OFFSET_DEG, longitude),
            (latitude, longitude + ELEVATION_SAMPLE_OFFSET_DEG),
            (latitude, longitude - ELEVATION_SAMPLE_OFFSET_DEG),
        ]
        locations_param = "|".join(f"{lat},{lon}" for lat, lon in points)
        response = requests.get(
            OPEN_ELEVATION_URL,
            params={"locations": locations_param},
            timeout=ELEVATION_FETCH_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        results = response.json()["results"]
        elevations = [r["elevation"] for r in results]

        center_elev = elevations[0]
        # ~111,320m per degree of latitude/longitude (approximation valid
        # at the scale of this offset)
        distance_m = ELEVATION_SAMPLE_OFFSET_DEG * 111_320
        max_gradient_pct = max(
            abs(center_elev - e) / distance_m * 100 for e in elevations[1:]
        )

        base_cn = LAND_USE_BASE_CN.get(land_use, 70)
        # Normalize slope against 15% as "steep" for this adjustment's
        # scale - beyond that, the adjustment is already at its cap.
        slope_adjustment = min(
            SLOPE_CN_ADJUSTMENT_MAX, (max_gradient_pct / 15.0) * SLOPE_CN_ADJUSTMENT_MAX
        )
        derived_cn = min(98, base_cn + slope_adjustment)

        result = {
            "curve_number": round(derived_cn, 1),
            "slope_pct": round(max_gradient_pct, 2),
            "source": "terrain_derived",
        }
        _elevation_cache[node_id] = result
        _api_failed_at.pop("elevation", None)
        return result

    except Exception as e:
        _api_failed_at["elevation"] = datetime.now(timezone.utc)
        print(
            f"[elevation] terrain lookup failed for {node_id}, falling back to hand-typed "
            f"curve_number; not retrying for {EXTERNAL_API_RETRY_AFTER_MINUTES} min: {e}"
        )
        return None


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
    if _api_in_backoff("weather"):
        # Same fallback as a failed fetch, without waiting on another timeout
        return cached["value"] if cached else None

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
        _api_failed_at.pop("weather", None)
        return forecast_6h_mm

    except Exception as e:
        _api_failed_at["weather"] = datetime.now(timezone.utc)
        print(
            f"[weather] forecast fetch failed for {node_id}; not retrying for "
            f"{EXTERNAL_API_RETRY_AFTER_MINUTES} min: {e}"
        )
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


# Columns added after the original readings schema, migrated onto existing
# databases by init_db(). Includes every flood-model input (so real
# readings can be exported and retrained on), the optional multi-hazard
# sensor fields, and `simulated` so simulator traffic can be kept out of
# training data.
ADDED_READING_COLUMNS = {
    "forecast_rainfall_6h_mm": "REAL",
    "severity_source": "TEXT",
    "land_use": "TEXT",
    "curve_number": "REAL",
    "curve_number_source": "TEXT",
    "rainfall_intensity_mm_hr": "REAL",
    "river_level_rate_m_per_hr": "REAL",
    "upstream_level_m": "REAL",
    "upstream_rate_m_per_hr": "REAL",
    "soil_saturation": "REAL",
    "gas_ppm_rate_per_hr": "REAL",
    "tilt_angle_deg": "REAL",
    "vibration_magnitude": "REAL",
    "pm25_ugm3": "REAL",
    "pm10_ugm3": "REAL",
    "water_ph": "REAL",
    "turbidity_ntu": "REAL",
    "simulated": "INTEGER",
    "battery_pct": "REAL",
    "signal_strength_dbm": "REAL",
    "reading_uid": "TEXT",
    "delay_seconds": "REAL",  # received_at - reading time (store-and-forward backlog)
    "edge_risk_level": "TEXT",
    "confirmation": "TEXT",  # "persistent" / "neighbour:<id>" / "unconfirmed"
    "soil_moisture_pct": "REAL",
    "soil_saturation_source": "TEXT",  # "sensor" or "rainfall_proxy"
    "link": "TEXT",
    "rainfall_mm_since_last": "REAL",  # per-reading rain - input for the river forecast
}


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
    for column, sql_type in ADDED_READING_COLUMNS.items():
        if column not in existing_cols:
            conn.execute(f"ALTER TABLE readings ADD COLUMN {column} {sql_type}")
    # Duplicate guard for store-and-forward retries (see RawReading.reading_uid)
    conn.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_readings_node_uid "
        "ON readings(node_id, reading_uid) WHERE reading_uid IS NOT NULL"
    )
    conn.commit()

    init_node_registry_table(conn)
    conn.close()


def save_reading(enriched: dict, result: dict, timestamp: str):
    # Every model input is stored, not just the raw sensor values - without
    # them export_readings_to_csv.py could only export 3 flood columns and
    # retraining on real data failed with KeyError: 'curve_number'.
    row = {
        "node_id": enriched["node_id"],
        "location": enriched["location"],
        "river_level_m": enriched["river_level_m"],
        "temp_c": enriched["temp_c"],
        "humidity_pct": enriched["humidity_pct"],
        "gas_ppm": enriched["gas_ppm"],
        "flame_reading": enriched["flame_reading"],
        "rainfall_24h_mm": enriched["rainfall_24h_mm"],
        "forecast_rainfall_6h_mm": enriched.get("forecast_rainfall_6h_mm"),
        "status": result["status"],
        "hazard_type": result.get("hazard_type"),
        "risk_score": result.get("risk_score"),
        "severity": result.get("severity"),
        "severity_source": result.get("severity_source"),
        "message": result.get("message"),
        "eta_minutes": result.get("eta_minutes"),
        "predicted_time": result.get("predicted_time"),
        "timestamp": timestamp,
    }
    for column in ADDED_READING_COLUMNS:
        if column not in row:
            row[column] = enriched[column] if column in enriched else result.get(column)
    row["simulated"] = 1 if enriched.get("simulated") else 0

    columns = ", ".join(row)
    placeholders = ", ".join("?" for _ in row)
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        f"INSERT INTO readings ({columns}) VALUES ({placeholders})",
        tuple(row.values()),
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
#
# True: every firmware in Arduino/ (node, edge_ai, deep_sleep) already
# sends the inverted water level via distanceToWaterLevelMeters(). With
# False, the backend inverted it a second time and a real flood read 0 m.
# In this mode the mount height lives ONLY in the firmware
# (ULTRASONIC_MOUNT_HEIGHT_CM); ULTRASONIC_MOUNT_HEIGHT_M above is used
# only for old firmware that still sends raw distance.
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
        # Firmware already inverted distance -> water level itself and
        # clamped it to its own mount height - no second inversion here,
        # and no upper clamp to the backend's (legacy) mount height, which
        # would silently cap a differently-mounted sensor.
        return max(0.0, raw_value_m)

    water_level_m = ULTRASONIC_MOUNT_HEIGHT_M - raw_value_m
    return max(0.0, min(ULTRASONIC_MOUNT_HEIGHT_M, water_level_m))


WATER_LEVEL_SMOOTHING_WINDOW = (
    5  # readings; at a 5s send interval, ~20-25s of smoothing
)


RATE_WINDOW_MINUTES = 15  # rate of rise is measured against the oldest reading this recent
MIN_RATE_SPAN_SECONDS = 30  # shorter spans turn mm of sensor jitter into huge m/hr values
SOIL_DRYING_TIME_CONSTANT_HOURS = 48.0  # saturation proxy decays to ~37% after this long without rain
SOIL_SATURATION_PER_MM = 0.01

# node_id -> deque of (datetime, rainfall_mm), only the last 24 hours.
# In-memory like node_history, so rainfall totals restart from 0 when the
# backend restarts.
node_rainfall: dict[str, deque] = {}


def parse_timestamp(timestamp: str) -> datetime:
    """ISO-8601 string -> timezone-aware datetime. Falls back to "now" for
    an unparseable client-supplied timestamp rather than rejecting the
    reading - a bad clock must never drop a hazard reading."""
    try:
        parsed = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return datetime.now(timezone.utc)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def rate_per_hour(history: deque, key: str, current_value: float, now: datetime) -> float:
    """Change in `key` per HOUR over the last RATE_WINDOW_MINUTES: the
    least-squares slope through ALL readings in the window plus the
    current one. Using only the oldest and newest point let ordinary
    sensor jitter look like a fast rise - the cause of false MEDIUM flood
    alerts on calm rivers (B33). Returns 0.0 (no evidence of change) when
    there isn't at least MIN_RATE_SPAN_SECONDS of history."""
    window_start = now - timedelta(minutes=RATE_WINDOW_MINUTES)
    points = [((r["timestamp"] - now).total_seconds() / 3600, r[key])
              for r in history if window_start <= r["timestamp"] <= now and r.get(key) is not None]
    points.append((0.0, current_value))
    span_seconds = -points[0][0] * 3600 if len(points) > 1 else 0.0
    if span_seconds < MIN_RATE_SPAN_SECONDS:
        return 0.0
    n = len(points)
    mean_t = sum(t for t, _ in points) / n
    mean_v = sum(v for _, v in points) / n
    var_t = sum((t - mean_t) ** 2 for t, _ in points)
    if var_t == 0:
        return 0.0
    return sum((t - mean_t) * (v - mean_v) for t, v in points) / var_t


def smooth_water_level(history: deque, current_value: float) -> float:
    """Median-smooths the water level over the last few readings, so a
    single noisy/spiked HC-SR04 reading can't alone trigger a false
    MEDIUM/HIGH. A sustained real change still comes through within a
    few readings - only an isolated one-off spike gets outvoted by the
    surrounding normal readings around it.

    Medians the RAW (unsmoothed) values. It used to median its own past
    OUTPUTS (river_level_m), which latches: for a steadily rising level
    the old outputs outvote every new reading, and in testing a level
    rising 0.004 -> 0.020 m stayed frozen at 0.0042 m."""
    recent = [
        r.get("raw_water_level_m", r["river_level_m"])
        for r in list(history)[-(WATER_LEVEL_SMOOTHING_WINDOW - 1) :]
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
    # UPGRADE: node health telemetry - optional so older firmware
    # without these fields doesn't break ingestion.
    signal_strength_dbm: Optional[float] = None
    battery_pct: Optional[float] = None
    # Set true by simulation.js (and any other pure-software test
    # client). Real ESP32 hardware never sends this, so it defaults to
    # False - meaning real hardware always goes through the HC-SR04
    # distance->water-level conversion, while simulated traffic sends an
    # already-realistic water level directly and skips that conversion.
    # Without this flag, a simulator sending realistic river-scale values
    # (1.5-4m) would get wrongly inverted as if they were raw ultrasonic
    # distances and clamped to 0 - confirmed and demonstrated before this
    # fix was added.
    simulated: bool = False
    # UPGRADE: multi-hazard classification sensors - all optional, since
    # most nodes won't have all of these physically installed. A node
    # without a given sensor simply omits that field, and
    # hazard_classification.py skips classifying that hazard type
    # entirely rather than reporting a false LOW.
    tilt_angle_deg: Optional[float] = None  # MPU6050 - landslide detection
    vibration_magnitude: Optional[float] = None  # MPU6050 - landslide detection
    pm25_ugm3: Optional[float] = None  # PMS5003 - air pollution
    pm10_ugm3: Optional[float] = None  # PMS5003 - air pollution
    water_ph: Optional[float] = None  # water quality sensor
    turbidity_ntu: Optional[float] = None  # water quality sensor
    # Store-and-forward: a node that queued readings while offline uploads
    # them later. LoRa-only nodes have no clock (no NTP), so they send how
    # long ago the reading was taken instead of a timestamp; the backend
    # turns that into a timestamp. reading_uid (unique per node, e.g.
    # "<boot>-<seq>") makes a re-sent reading a no-op, so a node can safely
    # retry an upload whose response it never received.
    # 0 .. 30 days. A value like 1e20 used to raise OverflowError while
    # sorting and fail the whole batch with 500 forever (review R7).
    age_seconds: Optional[float] = Field(default=None, ge=0, le=30 * 24 * 3600)
    reading_uid: Optional[str] = None
    # The node's own on-device edge-AI verdict (NORMAL/WATCH/URGENT), stored
    # so edge and cloud classifications can be compared over time.
    edge_risk_level: Optional[str] = None
    # Capacitive soil-moisture sensor (0-100 %). When present it REPLACES
    # the rainfall-decay soil_saturation proxy with a real measurement.
    soil_moisture_pct: Optional[float] = None
    # How the reading reached us: "wifi" (node direct), "lora" (via the
    # gateway - signal_strength_dbm is then the LoRa RSSI) or "nbiot".
    # Decides what counts as a weak signal in node health.
    link: Optional[str] = None


def startup():
    global _flood_model, _flood_feature_cols, _anomaly_model, _anomaly_scaler
    global _rag_collection, _rag_embedder
    init_db()
    reload_node_registry()
    seed_node_health_from_db()
    print(
        f"[nodes] Loaded {len(NODE_REGISTRY)} nodes from the database: {list(NODE_REGISTRY.keys())}"
    )

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
    try:
        _rag_collection, _rag_embedder = build_knowledge_base()
    except Exception as e:
        # Never let alert-text enrichment stop hazard detection from
        # starting - alerts fall back to a template without SOP text.
        _rag_collection, _rag_embedder = None, None
        print(f"[RAG] knowledge base unavailable, alerts will omit SOP text: {e}")
    print("Backend ready.")


def derive_features(raw: RawReading, timestamp: str) -> dict:
    if raw.node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown node_id '{raw.node_id}'")
    now = parse_timestamp(timestamp)

    config = NODE_REGISTRY[raw.node_id]
    history = node_history[raw.node_id]

    # Convert raw HC-SR04 distance (mislabeled "river_level_m" by the
    # current firmware) into an actual water-level value. See
    # convert_ultrasonic_distance_to_water_level_m() above for the full
    # explanation - this MUST run before the raw value is used anywhere.
    # SKIPPED for simulated traffic (see RawReading.simulated) - a
    # simulator sends an already-realistic water level directly, not a
    # raw sensor distance that needs inverting.
    if raw.simulated:
        converted_value = raw.river_level_m
    else:
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
    # Smoothing exists to filter REAL sensor jitter (see the docstring
    # above) - a simulator's values are deliberately controlled test
    # data, not noisy hardware, so simulated readings skip smoothing too
    # and use their value directly (confirmed via testing: without this,
    # a simulated jump from a calm to a flood scenario got averaged with
    # prior readings instead of reflecting the new scenario immediately).
    water_level_m = (
        converted_value
        if raw.simulated
        else smooth_water_level(history, converted_value)
    )

    # Rates are real per-HOUR values from timestamps. They used to be the
    # plain difference from the previous reading (3-5s earlier), which
    # made ETA projections ~700x too slow and fed the flood model a
    # feature on a different scale than it was trained on.
    river_level_rate_m_per_hr = rate_per_hour(
        history, "river_level_m", water_level_m, now
    )
    gas_ppm_rate_per_hr = rate_per_hour(history, "gas_ppm", raw.gas_ppm, now)

    # Rainfall totals come from a time-pruned log, not "the last 50
    # readings" (~4 min at a 5s interval) as before.
    rain_log = node_rainfall.setdefault(raw.node_id, deque())
    if raw.rainfall_mm_since_last > 0:
        rain_log.append((now, raw.rainfall_mm_since_last))
    while rain_log and rain_log[0][0] < now - timedelta(hours=24):
        rain_log.popleft()
    rainfall_24h_mm = sum(mm for _, mm in rain_log)
    # mm that fell in the last hour IS the intensity in mm/hr - previously
    # the per-reading amount was passed off as mm/hr.
    rainfall_intensity_mm_hr = sum(
        mm for t, mm in rain_log if t >= now - timedelta(hours=1)
    )

    # Soil saturation: the real capacitive sensor when the node has one;
    # otherwise a proxy that rises with rain and dries out exponentially
    # with real elapsed time (it used to lose 2% per reading, which emptied
    # it in minutes at a 5s interval).
    if raw.soil_moisture_pct is not None:
        prev_saturation = None
    elif history:
        hours_since_prev = max(
            0.0, (now - history[-1]["timestamp"]).total_seconds() / 3600
        )
        prev_saturation = history[-1]["soil_saturation"] * math.exp(
            -hours_since_prev / SOIL_DRYING_TIME_CONSTANT_HOURS
        )
    else:
        prev_saturation = 0.3
    if prev_saturation is None:
        soil_saturation = min(1.0, max(0.0, raw.soil_moisture_pct / 100))
        soil_saturation_source = "sensor"
    else:
        soil_saturation = min(
            1.0,
            max(0.0, prev_saturation + raw.rainfall_mm_since_last * SOIL_SATURATION_PER_MM),
        )
        soil_saturation_source = "rainfall_proxy"

    upstream_node = config.get("upstream_node")
    if upstream_node and node_history.get(upstream_node):
        upstream_hist = node_history[upstream_node]
        upstream_level_m = upstream_hist[-1]["river_level_m"]
        # UPGRADE: cross-node spatial correlation needs the upstream
        # node's OWN rate of rise, not just its current level - see
        # integration_pipeline.py's apply_spatial_correlation_boost().
        upstream_rate_m_per_hr = rate_per_hour(
            upstream_hist,
            "river_level_m",
            upstream_level_m,
            upstream_hist[-1]["timestamp"],
        )
    else:
        upstream_level_m = water_level_m
        upstream_rate_m_per_hr = 0.0

    # Cloud-side weather enrichment - forecasted rain not yet reflected in
    # any sensor reading. None if the weather API is unreachable; the
    # pipeline must not depend on this to function.
    forecast_rainfall_6h_mm = fetch_forecast_rainfall_mm(
        config["latitude"], config["longitude"], raw.node_id
    )

    # UPGRADE: auto-derived curve_number from real terrain slope, falling
    # back to the hand-typed NODE_REGISTRY value if the terrain API is
    # unreachable - never let an external dependency block ingestion.
    terrain_result = fetch_terrain_derived_curve_number(
        config["latitude"], config["longitude"], config["land_use"], raw.node_id
    )
    curve_number = (
        terrain_result["curve_number"] if terrain_result else config["curve_number"]
    )
    curve_number_source = (
        terrain_result["source"] if terrain_result else "hand_typed_config"
    )

    enriched = {
        "node_id": raw.node_id,
        "location": config["location"],
        "land_use": config["land_use"],
        "curve_number": curve_number,
        "curve_number_source": curve_number_source,
        "rainfall_24h_mm": rainfall_24h_mm,
        "rainfall_intensity_mm_hr": rainfall_intensity_mm_hr,
        "forecast_rainfall_6h_mm": forecast_rainfall_6h_mm,
        "river_level_m": water_level_m,
        "simulated": raw.simulated,
        "river_level_rate_m_per_hr": river_level_rate_m_per_hr,
        "upstream_level_m": upstream_level_m,
        "upstream_rate_m_per_hr": upstream_rate_m_per_hr,
        "soil_saturation": soil_saturation,
        "temp_c": raw.temp_c,
        "humidity_pct": raw.humidity_pct,
        "gas_ppm": raw.gas_ppm,
        "gas_ppm_rate_per_hr": gas_ppm_rate_per_hr,
        "flame_reading": raw.flame_reading,
        # UPGRADE: multi-hazard classification sensors, passed through
        # unchanged (None if the node doesn't have that sensor).
        "tilt_angle_deg": raw.tilt_angle_deg,
        "vibration_magnitude": raw.vibration_magnitude,
        "pm25_ugm3": raw.pm25_ugm3,
        "pm10_ugm3": raw.pm10_ugm3,
        "water_ph": raw.water_ph,
        "turbidity_ntu": raw.turbidity_ntu,
        # Node telemetry / provenance, stored with the reading
        "battery_pct": raw.battery_pct,
        "signal_strength_dbm": raw.signal_strength_dbm,
        "reading_uid": raw.reading_uid,
        "edge_risk_level": raw.edge_risk_level,
        "soil_moisture_pct": raw.soil_moisture_pct,
        "rainfall_mm_since_last": raw.rainfall_mm_since_last,
        "soil_saturation_source": soil_saturation_source,
        "link": raw.link,
    }

    history.append(
        {
            "timestamp": now,
            "river_level_m": water_level_m,
            "raw_water_level_m": converted_value,  # unsmoothed - see smooth_water_level()
            "rainfall_mm_since_last": raw.rainfall_mm_since_last,
            "soil_saturation": soil_saturation,
            "gas_ppm": raw.gas_ppm,
            "temp_c": raw.temp_c,
            "humidity_pct": raw.humidity_pct,
        }
    )

    return enriched


MAX_CLOCK_SKEW_MINUTES = 5  # node timestamps further in the future are treated as clock garbage
MAX_BATCH_SIZE = 200

_confirmer = HazardConfirmer()


def resolve_reading_time(raw: RawReading, received_at: datetime) -> datetime:
    """When the reading was TAKEN: explicit timestamp, else received_at
    minus age_seconds (clockless LoRa nodes), else received_at. A future
    timestamp (node clock not set) falls back to received_at."""
    if raw.timestamp:
        taken_at = parse_timestamp(raw.timestamp)
    elif raw.age_seconds is not None:
        taken_at = received_at - timedelta(seconds=max(0.0, raw.age_seconds))
    else:
        taken_at = received_at
    if taken_at > received_at + timedelta(minutes=MAX_CLOCK_SKEW_MINUTES):
        taken_at = received_at
    # Always UTC, so stored timestamps sort and compare correctly as text
    return taken_at.astimezone(timezone.utc)


def is_duplicate_reading(node_id: str, reading_uid: Optional[str]) -> bool:
    if not reading_uid:
        return False
    conn = sqlite3.connect(DB_PATH)
    row = conn.execute(
        "SELECT 1 FROM readings WHERE node_id=? AND reading_uid=?", (node_id, reading_uid)
    ).fetchone()
    conn.close()
    return row is not None


def update_node_health(raw: RawReading, received_at: datetime, taken_at: datetime, drift: list):
    """last_seen = when we last HEARD from the node (received_at), not when
    a backlogged reading was taken. Battery/signal only move forward in
    time, so an old queued reading can't overwrite newer telemetry."""
    health = node_health.setdefault(raw.node_id, {})
    health["last_seen"] = received_at.isoformat()
    previous_taken = health.get("last_reading_at")
    if previous_taken is None or taken_at >= parse_timestamp(previous_taken):
        health["last_reading_at"] = taken_at.isoformat()
        health["battery_pct"] = raw.battery_pct
        health["signal_strength_dbm"] = raw.signal_strength_dbm
        health["link"] = raw.link
        health["sensor_drift"] = drift


# Readings are processed one at a time. FastAPI runs these sync endpoints
# on a thread pool, so two requests (e.g. a node retry and the gateway's
# copy of the same reading) could both pass the duplicate check and both
# update the in-memory rain log / history / confirmation state before one
# of them failed on the unique index - double-counting it (review R22).
# At ~1 reading/s per backend this costs nothing.
_ingest_lock = threading.Lock()


def process_raw_reading(raw: RawReading, received_at: datetime, time_known: bool = True) -> dict:
    with _ingest_lock:
        if not time_known:
            return store_untimed_reading(raw, received_at)
        return _process_raw_reading(raw, received_at)


def store_untimed_reading(raw: RawReading, received_at: datetime) -> dict:
    """A queued reading whose age is unknown (its node or gateway rebooted
    while it waited). Stamping it "now" would pile hours of backlog rain
    into the same instant - inflating rainfall intensity and possibly
    producing a false flood alert (review R6). So it is STORED for the
    record but kept out of rates, rainfall totals, alerts and confirmation."""
    if raw.node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown node_id '{raw.node_id}'")
    if is_duplicate_reading(raw.node_id, raw.reading_uid):
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}
    node_health.setdefault(raw.node_id, {})["last_seen"] = received_at.isoformat()  # we did hear from it
    conn = sqlite3.connect(DB_PATH)
    try:
        conn.execute(
            """INSERT INTO readings (node_id, location, river_level_m, temp_c, humidity_pct, gas_ppm,
                   flame_reading, status, timestamp, reading_uid, simulated, link, battery_pct, signal_strength_dbm)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (raw.node_id, NODE_REGISTRY[raw.node_id]["location"], raw.river_level_m, raw.temp_c,
             raw.humidity_pct, raw.gas_ppm, raw.flame_reading, "untimed", received_at.isoformat(),
             raw.reading_uid, 1 if raw.simulated else 0, raw.link, raw.battery_pct, raw.signal_strength_dbm),
        )
        conn.commit()
    except sqlite3.IntegrityError:
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}
    finally:
        conn.close()
    return {"status": "untimed", "node_id": raw.node_id, "reading_uid": raw.reading_uid}


def _process_raw_reading(raw: RawReading, received_at: datetime) -> dict:
    """Shared by /api/ingest and /api/ingest/batch."""
    if is_duplicate_reading(raw.node_id, raw.reading_uid):
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}

    taken_at = resolve_reading_time(raw, received_at)
    timestamp = taken_at.isoformat()
    # derive_features validates node_id, so health is only updated for
    # registered nodes (unknown IDs used to pollute node_health).
    enriched = derive_features(raw, timestamp)
    enriched["delay_seconds"] = round((received_at - taken_at).total_seconds(), 1)

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

    # UPGRADE: predictive maintenance - checked on every reading, but
    # this is a NODE HEALTH signal (for officers/maintainers), separate
    # from the hazard severity a citizen sees. Never affects risk_score
    # or severity - a drifting temp sensor doesn't mean there's a flood.
    result["predictive_maintenance"] = check_all_sensors_for_drift(
        node_history[raw.node_id]
    )
    update_node_health(raw, received_at, taken_at, result["predictive_maintenance"])

    # Multi-node cross-check (hazard_confirmation.py): an alert only goes
    # public once corroborated; until then officers see it as pending.
    if result["status"] == "alert_dispatched":
        confirmed, basis = _confirmer.assess(
            raw.node_id, result["hazard_type"], result["severity"], taken_at, NODE_REGISTRY
        )
        result["confirmation"] = basis or "unconfirmed"
        if not confirmed:
            result["status"] = "pending_confirmation"
    result["delay_seconds"] = enriched["delay_seconds"]
    result["reading_uid"] = raw.reading_uid

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
    # Relative to when the reading was TAKEN - for a backlogged reading,
    # "now + eta" would push the predicted time into the future.
    result["predicted_time"] = (
        (taken_at + timedelta(minutes=eta_minutes)).isoformat()
        if eta_minutes is not None and eta_minutes > 0
        else None
    )

    try:
        save_reading(enriched, result, timestamp)
    except sqlite3.IntegrityError:
        # Same reading_uid saved by a concurrent request between the
        # duplicate check and here - the other request already handled it.
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}

    return result


@app.post("/api/ingest")
def ingest_reading(raw: RawReading):
    return process_raw_reading(raw, datetime.now(timezone.utc))


class ReadingBatch(BaseModel):
    readings: list[RawReading]


@app.post("/api/ingest/batch")
def ingest_batch(batch: ReadingBatch):
    """Store-and-forward upload: a node (or LoRa gateway) that was offline
    sends its queued readings in one request. Readings are processed
    oldest-first per node so rates, rainfall totals and smoothing see them
    in the order they happened. Each reading gets its own result; one bad
    reading (e.g. unknown node) doesn't reject the rest of the batch."""
    if len(batch.readings) > MAX_BATCH_SIZE:
        raise HTTPException(
            status_code=413, detail=f"At most {MAX_BATCH_SIZE} readings per batch"
        )
    received_at = datetime.now(timezone.utc)
    order = sorted(
        range(len(batch.readings)),
        key=lambda i: resolve_reading_time(batch.readings[i], received_at),
    )
    results: list = [None] * len(batch.readings)
    for i in order:
        r = batch.readings[i]
        # In a store-and-forward batch, no timestamp AND no age means the
        # sender lost track of when it was taken (rebooted) - see R6.
        time_known = r.timestamp is not None or r.age_seconds is not None
        try:
            results[i] = process_raw_reading(r, received_at, time_known)
        except HTTPException as e:
            results[i] = {"status": "rejected", "node_id": r.node_id, "reading_uid": r.reading_uid, "detail": e.detail}
        except Exception as e:  # noqa: BLE001 - one bad reading must not fail (and jam) the whole batch (R7)
            print(f"[ingest] error processing {r.node_id} {r.reading_uid}: {e!r}")
            results[i] = {"status": "error", "node_id": r.node_id, "reading_uid": r.reading_uid, "detail": str(e)}
    return {"count": len(results), "results": results}


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


@app.get("/api/alerts/{alert_id}/cap")
def get_alert_as_cap(alert_id: int):
    """UPGRADE: CAP-compliant alert format. Returns this alert as a
    Common Alerting Protocol v1.2 XML document - the format NDMA's
    SACHET platform (and most national alert systems) consume. See
    cap_alert.py's module docstring for what this does and doesn't cover -
    this generates spec-compliant CAP XML; it does not submit to SACHET
    itself, which requires government authorization this project doesn't have."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM readings WHERE id=?", (alert_id,)).fetchone()
    conn.close()
    if row is None:
        raise HTTPException(status_code=404, detail=f"No reading with id {alert_id}")
    row = dict(row)
    # Only real alerts become CAP messages. Logged/suppressed readings
    # (severity LOW or "N/A") previously reached generate_cap_alert and
    # crashed with a 500 on the unmappable "N/A" severity.
    if row.get("status") != "alert_dispatched":
        raise HTTPException(
            status_code=404,
            detail=f"Reading {alert_id} is not an alert (status '{row.get('status')}')",
        )

    config = NODE_REGISTRY.get(row["node_id"], {})
    cap_xml = generate_cap_alert(
        hazard_type=row.get("hazard_type") or "flood",
        severity=row.get("severity") or "LOW",
        location=row.get("location") or row["node_id"],
        latitude=config.get("latitude", 0.0),
        longitude=config.get("longitude", 0.0),
        message=row.get("message") or "No alert message recorded for this reading.",
        node_id=row["node_id"],
        risk_score=row.get("risk_score") or 0.0,
        severity_source=row.get("severity_source") or "ml_model",
    )
    return Response(content=cap_xml, media_type="application/xml")


@app.get("/api/reports/{alert_id}/pdf")
def get_situation_report_pdf(alert_id: int):
    """UPGRADE: auto-generated PDF situation reports. Pulls the alert
    plus the preceding readings for the same node (the "lead-up") into a
    printable document - for an audit trail, or to hand an official
    something they can read offline."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    event_row = conn.execute(
        "SELECT * FROM readings WHERE id=?", (alert_id,)
    ).fetchone()
    if event_row is None:
        conn.close()
        raise HTTPException(status_code=404, detail=f"No reading with id {alert_id}")
    event = dict(event_row)

    timeline_rows = conn.execute(
        "SELECT * FROM readings WHERE node_id=? AND id<=? ORDER BY id DESC LIMIT 20",
        (event["node_id"], alert_id),
    ).fetchall()
    conn.close()
    timeline = [dict(r) for r in reversed(timeline_rows)]

    # Was a hard-coded "/tmp/..." path, which doesn't exist on Windows.
    # A unique temp file per request (deleted once sent) also avoids two
    # simultaneous requests for the same alert overwriting each other.
    fd, output_path = tempfile.mkstemp(
        prefix=f"situation_report_{alert_id}_", suffix=".pdf"
    )
    os.close(fd)
    try:
        generate_situation_report_pdf(event, timeline, output_path)
    except Exception:
        os.remove(output_path)
        raise
    return FileResponse(
        output_path,
        media_type="application/pdf",
        filename=f"sanjeevni_situation_report_{alert_id}.pdf",
        background=BackgroundTask(os.remove, output_path),
    )


@app.get("/api/events/{node_id}/timeline")
def get_event_timeline(node_id: str, around_id: Optional[int] = None, window: int = 20):
    """UPGRADE: event replay / timeline view. Returns readings around a
    specific point in time for one node - minute-by-minute playback of
    what led up to (and followed) a hazard, for the officer dashboard's
    audit/storytelling view. If around_id is omitted, returns the most
    recent `window` readings instead."""
    if node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown node_id '{node_id}'")

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    if around_id is not None:
        before = conn.execute(
            "SELECT * FROM readings WHERE node_id=? AND id<=? ORDER BY id DESC LIMIT ?",
            (node_id, around_id, window // 2 + 1),
        ).fetchall()
        after = conn.execute(
            "SELECT * FROM readings WHERE node_id=? AND id>? ORDER BY id ASC LIMIT ?",
            (node_id, around_id, window // 2),
        ).fetchall()
        rows = list(reversed(before)) + list(after)
    else:
        rows = conn.execute(
            "SELECT * FROM readings WHERE node_id=? ORDER BY id DESC LIMIT ?",
            (node_id, window),
        ).fetchall()
        rows = list(reversed(rows))
    conn.close()
    return {"node_id": node_id, "count": len(rows), "timeline": [dict(r) for r in rows]}


@app.get("/api/analytics/heatmap")
def get_flood_frequency_heatmap():
    """UPGRADE: historical analytics dashboard - flood-frequency data per
    node over time, for infrastructure planning ("which locations flood
    most often"). Aggregates by node and by day."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""SELECT node_id, substr(timestamp, 1, 10) AS day,
                  COUNT(*) AS reading_count,
                  SUM(CASE WHEN severity IN ('HIGH','CRITICAL') THEN 1 ELSE 0 END) AS high_count,
                  SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_count,
                  AVG(risk_score) AS avg_risk_score,
                  MAX(risk_score) AS max_risk_score
           FROM readings
           WHERE timestamp IS NOT NULL
           GROUP BY node_id, day
           ORDER BY day ASC""").fetchall()
    conn.close()

    result = [dict(r) for r in rows]
    for r in result:
        config = NODE_REGISTRY.get(r["node_id"], {})
        r["location"] = config.get("location", r["node_id"])
        r["latitude"] = config.get("latitude")
        r["longitude"] = config.get("longitude")
    return {"count": len(result), "heatmap_data": result}


@app.get("/api/nodes")
def get_nodes():
    out = []
    for node_id, config in NODE_REGISTRY.items():
        last = node_history[node_id][-1] if node_history[node_id] else None
        health = node_health.get(node_id, {})
        out.append(
            {
                "node_id": node_id,
                "location": config["location"],
                "land_use": config["land_use"],
                "latitude": config["latitude"],
                "longitude": config["longitude"],
                "last_river_level_m": last["river_level_m"] if last else None,
                "reading_count": len(node_history[node_id]),
                "last_seen": health.get("last_seen"),
                "battery_pct": health.get("battery_pct"),
                "signal_strength_dbm": health.get("signal_strength_dbm"),
            }
        )
    return out


# --- Node health / missing-node alerts ----------------------------------
DEFAULT_REPORT_INTERVAL_SECONDS = 5  # always-on firmware sends every 5s
MISSED_REPORTS_BEFORE_OFFLINE = 6
MIN_OFFLINE_AFTER_SECONDS = 60  # never flag faster than this (network hiccups)
LOW_BATTERY_PCT = 20
CRITICAL_BATTERY_PCT = 10
# Weak-signal threshold per link type: WiFi gets unreliable below about
# -85 dBm, while LoRa (SF7-SF9) still decodes down to roughly -120 dBm.
WEAK_SIGNAL_DBM_BY_LINK = {"wifi": -85, "lora": -115, "nbiot": -110}
WEAK_SIGNAL_DBM_DEFAULT = -85  # readings that don't say (old firmware = WiFi)
_HEALTH_LEVEL_RANK = {"critical": 0, "warning": 1, "ok": 2}


def _format_duration(seconds: float) -> str:
    if seconds < 120:
        return f"{seconds:.0f}s"
    if seconds < 7200:
        return f"{seconds / 60:.0f} min"
    return f"{seconds / 3600:.1f} h"


def median_gap_seconds(timestamps: list) -> Optional[float]:
    """Typical seconds between reports, from at least 3 gaps."""
    gaps = [(b - a).total_seconds() for a, b in zip(timestamps, timestamps[1:])]
    gaps = [g for g in gaps if g > 0]
    return statistics.median(gaps) if len(gaps) >= 3 else None


def observed_interval_from_db(conn, node_id: str) -> Optional[float]:
    rows = conn.execute(
        "SELECT timestamp FROM readings WHERE node_id=? AND timestamp IS NOT NULL ORDER BY id DESC LIMIT 11",
        (node_id,),
    ).fetchall()
    return median_gap_seconds(sorted(parse_timestamp(r[0]) for r in rows))


def seed_node_health_from_db():
    """node_health is in-memory, so after a restart every node looked like
    it had never reported. Restore last-seen + telemetry from each node's
    most recent stored reading."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT r.node_id, r.timestamp, r.battery_pct, r.signal_strength_dbm, r.link
        FROM readings r
        JOIN (SELECT node_id, MAX(id) AS max_id FROM readings GROUP BY node_id) latest
          ON r.id = latest.max_id
    """).fetchall()
    for row in rows:
        if row["node_id"] in NODE_REGISTRY and row["timestamp"]:
            node_health.setdefault(row["node_id"], {}).update(
                {
                    "last_seen": row["timestamp"],
                    "last_reading_at": row["timestamp"],
                    "battery_pct": row["battery_pct"],
                    "signal_strength_dbm": row["signal_strength_dbm"],
                    # restored too, so LoRa nodes aren't judged by the WiFi
                    # signal threshold after a restart (review R20)
                    "link": row["link"],
                    "observed_interval_seconds": observed_interval_from_db(conn, row["node_id"]),
                }
            )
    conn.close()


def compute_node_health(now: Optional[datetime] = None) -> list[dict]:
    """Per-node status (online / offline / never_seen) plus maintenance
    issues, worst first. A node is offline after missing
    MISSED_REPORTS_BEFORE_OFFLINE of its expected reports - a dead node
    otherwise looks exactly like a calm one on the hazard map."""
    now = now or datetime.now(timezone.utc)
    out = []
    for node_id, cfg in NODE_REGISTRY.items():
        health = node_health.get(node_id, {})
        # Expected cadence: the configured value, else what the node has
        # actually been doing. A LoRa node that heartbeats every 60 s used to
        # be judged against the 5 s default and flagged "missing" all the
        # time unless someone configured it by hand (review R19).
        recent = [r["timestamp"] for r in list(node_history.get(node_id, ()))[-11:]]
        observed = median_gap_seconds(recent) or health.get("observed_interval_seconds")
        interval = cfg.get("report_interval_seconds") or max(DEFAULT_REPORT_INTERVAL_SECONDS, observed or 0)
        offline_after = max(MIN_OFFLINE_AFTER_SECONDS, interval * MISSED_REPORTS_BEFORE_OFFLINE)
        issues = []

        seconds_since_seen = None
        if health.get("last_seen") is None:
            status = "never_seen"
            issues.append({"level": "warning", "type": "never_seen",
                           "message": "No reading received yet from this node"})
        else:
            seconds_since_seen = max(0.0, (now - parse_timestamp(health["last_seen"])).total_seconds())
            if seconds_since_seen > offline_after:
                status = "offline"
                issues.append({
                    "level": "critical", "type": "missing",
                    "message": f"No report for {_format_duration(seconds_since_seen)} "
                               f"(expected every {_format_duration(interval)}) - check power/link or theft",
                })
            else:
                status = "online"

        battery = health.get("battery_pct")
        if battery is not None and battery < LOW_BATTERY_PCT:
            issues.append({
                "level": "critical" if battery < CRITICAL_BATTERY_PCT else "warning",
                "type": "low_battery", "message": f"Battery at {battery:.0f}%",
            })
        signal = health.get("signal_strength_dbm")
        link = health.get("link")
        weak_below = WEAK_SIGNAL_DBM_BY_LINK.get(link, WEAK_SIGNAL_DBM_DEFAULT)
        if signal is not None and signal < weak_below:
            issues.append({"level": "warning", "type": "weak_signal",
                           "message": f"Weak {link or 'wifi'} signal ({signal:.0f} dBm)"})
        for drift in health.get("sensor_drift") or []:
            issues.append({
                "level": "warning", "type": "sensor_drift",
                "message": f"{drift['sensor']} drifting {drift['slope_per_reading']:+} per reading "
                           f"over {drift['window_size']} readings - inspect / recalibrate",
            })

        level = "critical" if any(i["level"] == "critical" for i in issues) else (
            "warning" if issues else "ok")
        out.append({
            "node_id": node_id,
            "location": cfg["location"],
            "latitude": cfg["latitude"],
            "longitude": cfg["longitude"],
            "status": status,
            "level": level,
            "last_seen": health.get("last_seen"),
            "seconds_since_seen": round(seconds_since_seen) if seconds_since_seen is not None else None,
            "expected_interval_seconds": interval,
            "battery_pct": battery,
            "signal_strength_dbm": signal,
            "link": link,
            "issues": issues,
        })
    out.sort(key=lambda n: (_HEALTH_LEVEL_RANK[n["level"]], n["node_id"]))
    return out


@app.get("/api/forecast/{node_id}")
def get_river_forecast(node_id: str):
    """LSTM river-level forecast (+30 / +60 min) for one node, from its
    last ~2 hours of stored readings, next to the linear extrapolation the
    ETA uses. Trained on SYNTHETIC hydrology - shown as indicative only and
    never used to raise or lower an alert."""
    if node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Unknown node_id '{node_id}'")
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """SELECT timestamp, river_level_m, rainfall_mm_since_last FROM readings
           WHERE node_id=? AND status != 'suppressed' AND river_level_m IS NOT NULL
           ORDER BY id DESC LIMIT 3000""",  # sensor faults excluded
        (node_id,),
    ).fetchall()
    conn.close()
    if not rows:
        return {"node_id": node_id, "available": False, "reason": "no readings yet"}
    # key=time only: comparing whole tuples hit None-vs-float rain on ties
    # and raised TypeError (review R23)
    parsed = sorted(((parse_timestamp(ts), level, rain) for ts, level, rain in rows if ts), key=lambda r: r[0])
    result = river_forecast.forecast_from_readings(parsed, end=parsed[-1][0])
    return {"node_id": node_id, "as_of": parsed[-1][0].isoformat(), **result}


@app.get("/api/satellite-check/{node_id}")
def get_satellite_check(node_id: str):
    """Sentinel-1 radar cross-check of a node's flood readings (see
    satellite_check.py). On demand only - slow, external, and a pass is
    usually days old - so it informs officers and never changes alerts."""
    cfg = NODE_REGISTRY.get(node_id)
    if cfg is None:
        raise HTTPException(status_code=404, detail=f"Unknown node_id '{node_id}'")
    # Copy: the module caches this dict for 6 h - writing the per-request
    # agreement text into it kept stale "corroborates" text (review R8).
    result = dict(satellite_flood_check(node_id, cfg["latitude"], cfg["longitude"]))

    conn = sqlite3.connect(DB_PATH)
    last = conn.execute(
        """SELECT severity, timestamp FROM readings
           WHERE node_id=? AND hazard_type='flood' AND status IN ('alert_dispatched','pending_confirmation')
           ORDER BY id DESC LIMIT 1""",
        (node_id,),
    ).fetchone()
    conn.close()
    if last and result["status"] in ("flood_signal", "no_flood_signal"):
        result["node_last_flood_alert"] = {"severity": last[0], "timestamp": last[1]}
        result["agreement"] = (
            "satellite corroborates the node's flood alert" if result["status"] == "flood_signal"
            else "satellite does not show it - the pass may predate the event, or the alert may be local"
        )
    return {"node_id": node_id, **result}


@app.get("/api/node-health")
def get_node_health():
    nodes = compute_node_health()
    return {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            status: sum(1 for n in nodes if n["status"] == status)
            for status in ("online", "offline", "never_seen")
        },
        "nodes_with_issues": sum(1 for n in nodes if n["issues"]),
        "nodes": nodes,
    }


class NodeConfig(BaseModel):
    """UPGRADE: admin-editable node registry. Adding a node used to mean
    editing Python source code and restarting the server - this is what
    actually lets you credibly claim 'scale from a village to a
    state-wide deployment' per the problem statement, since a real
    rollout can't require a code change for every new sensor node."""

    location: str
    land_use: str
    curve_number: float
    latitude: float
    longitude: float
    upstream_node: Optional[str] = None
    # Expected seconds between reports; None = DEFAULT_REPORT_INTERVAL_SECONDS.
    # Set e.g. 300 for a deep-sleep node so it isn't flagged missing.
    report_interval_seconds: Optional[float] = None


@app.get("/api/admin/nodes")
def admin_list_nodes(auth=Depends(require_admin_auth)):
    return NODE_REGISTRY


@app.post("/api/admin/nodes/{node_id}")
def admin_create_node(node_id: str, cfg: NodeConfig, auth=Depends(require_admin_auth)):
    if node_id in NODE_REGISTRY:
        raise HTTPException(
            status_code=409,
            detail=f"Node '{node_id}' already exists - use PUT to update it",
        )
    if cfg.upstream_node and cfg.upstream_node not in NODE_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"upstream_node '{cfg.upstream_node}' does not exist",
        )

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO nodes (node_id, location, land_use, curve_number, latitude, longitude, upstream_node, report_interval_seconds) VALUES (?,?,?,?,?,?,?,?)",
        (
            node_id,
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
            cfg.report_interval_seconds,
        ),
    )
    conn.commit()
    conn.close()
    reload_node_registry()
    return {"status": "created", "node_id": node_id}


@app.put("/api/admin/nodes/{node_id}")
def admin_update_node(node_id: str, cfg: NodeConfig, auth=Depends(require_admin_auth)):
    if node_id not in NODE_REGISTRY:
        raise HTTPException(
            status_code=404,
            detail=f"Node '{node_id}' does not exist - use POST to create it",
        )
    if cfg.upstream_node and cfg.upstream_node not in NODE_REGISTRY:
        raise HTTPException(
            status_code=400,
            detail=f"upstream_node '{cfg.upstream_node}' does not exist",
        )
    if cfg.upstream_node == node_id:
        raise HTTPException(
            status_code=400, detail="A node cannot be its own upstream_node"
        )

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE nodes SET location=?, land_use=?, curve_number=?, latitude=?, longitude=?, upstream_node=?, report_interval_seconds=? WHERE node_id=?",
        (
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
            cfg.report_interval_seconds,
            node_id,
        ),
    )
    conn.commit()
    conn.close()
    reload_node_registry()
    return {"status": "updated", "node_id": node_id}


@app.delete("/api/admin/nodes/{node_id}")
def admin_delete_node(node_id: str, auth=Depends(require_admin_auth)):
    if node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=404, detail=f"Node '{node_id}' does not exist")

    dependents = [
        n for n, cfg in NODE_REGISTRY.items() if cfg.get("upstream_node") == node_id
    ]
    if dependents:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete '{node_id}' - it's set as upstream_node for: {dependents}. Update those nodes first.",
        )

    conn = sqlite3.connect(DB_PATH)
    conn.execute("DELETE FROM nodes WHERE node_id=?", (node_id,))
    conn.commit()
    conn.close()
    reload_node_registry()
    # Deliberately does NOT delete node_history/node_health/readings -
    # historical data outlives the node's registry entry, same as
    # deleting a citizen report never deletes the SOS history tied to it.
    return {"status": "deleted", "node_id": node_id}


@app.get("/api/health")
def health():
    return {"status": "ok", "models_loaded": _flood_model is not None}


class WhatIfRequest(BaseModel):
    """UPGRADE: what-if simulation mode. An officer enters a hypothetical
    scenario and sees the model's predicted risk immediately - useful for
    training, understanding model behavior, and pre-planning ("if we get
    the forecasted 80mm tonight, does Sector 4 go HIGH?") without waiting
    for a real reading."""

    land_use: str = "urban_low"
    curve_number: Optional[float] = None  # auto-filled from land_use if not given
    rainfall_24h_mm: float = 0.0
    rainfall_intensity_mm_hr: float = 0.0
    forecast_rainfall_6h_mm: float = 0.0
    river_level_m: float = 1.5
    river_level_rate_m_per_hr: float = 0.0
    upstream_level_m: float = 1.5
    upstream_rate_m_per_hr: float = 0.0
    soil_saturation: float = 0.3


@app.post("/api/simulate")
def simulate_scenario(scenario: WhatIfRequest):
    """Runs a HYPOTHETICAL reading through the real trained flood model -
    does NOT touch node_history, does NOT save to the database, does NOT
    affect any real node's state. Pure what-if."""
    if _flood_model is None or _flood_feature_cols is None:
        raise HTTPException(status_code=503, detail="Flood model not loaded yet")

    curve_number = scenario.curve_number
    if curve_number is None:
        curve_number = LAND_USE_BASE_CN.get(scenario.land_use, 70)

    reading = {
        "land_use": scenario.land_use,
        "curve_number": curve_number,
        "rainfall_24h_mm": scenario.rainfall_24h_mm,
        "rainfall_intensity_mm_hr": scenario.rainfall_intensity_mm_hr,
        "forecast_rainfall_6h_mm": scenario.forecast_rainfall_6h_mm,
        "river_level_m": scenario.river_level_m,
        "river_level_rate_m_per_hr": scenario.river_level_rate_m_per_hr,
        "upstream_level_m": scenario.upstream_level_m,
        "upstream_rate_m_per_hr": scenario.upstream_rate_m_per_hr,
        "soil_saturation": scenario.soil_saturation,
    }

    risk_score = compute_flood_risk(reading, _flood_model, _flood_feature_cols)
    explanation = explain_flood_risk(reading, _flood_model, _flood_feature_cols)

    return {
        "simulated": True,
        "input": reading,
        "predicted_risk_score": float(risk_score),
        "predicted_severity": severity_band(risk_score),
        "explanation": explanation,
    }
