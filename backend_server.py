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
from dotenv import load_dotenv

from predictive_maintenance import check_all_sensors_for_drift

from fastapi import FastAPI, HTTPException, Response, Header, Depends
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from integration_pipeline import (
    train_flood_model,
    train_anomaly_detector,
    process_reading,
    compute_flood_risk,
    explain_flood_risk,
)
from rag_alert_pipeline import build_knowledge_base, severity_band
from cap_alert import generate_cap_alert
from situation_report import generate_situation_report_pdf

app = FastAPI(title="SANJEEVNI Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

DB_PATH = "sanjeevni.db"

# UPGRADE: admin-editable node registry. Loads the same .env file
# server.js uses (one shared secret across both services, not two
# separate keys to manage) - falls back to the same insecure demo key
# with the same warning if unset, for consistency with server.js.
load_dotenv()
ADMIN_API_KEY = os.environ.get("OFFICER_API_KEY", "sanjeevni-demo-key-CHANGE-ME")
if "OFFICER_API_KEY" not in os.environ:
    print(
        "\n[SECURITY WARNING] OFFICER_API_KEY is not set - using an insecure "
        "default demo key for the admin node-registry endpoints. Set a real "
        "one in your .env file before any real deployment.\n"
    )


def require_admin_auth(x_api_key: Optional[str] = Header(None)):
    if x_api_key != ADMIN_API_KEY:
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
        return result

    except Exception as e:
        print(
            f"[elevation] terrain lookup failed for {node_id}, falling back to hand-typed curve_number: {e}"
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
    if "severity_source" not in existing_cols:
        conn.execute("ALTER TABLE readings ADD COLUMN severity_source TEXT")
    conn.commit()

    init_node_registry_table(conn)
    conn.close()


def save_reading(enriched: dict, result: dict, timestamp: str):
    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        """INSERT INTO readings
           (node_id, location, river_level_m, temp_c, humidity_pct, gas_ppm,
            flame_reading, rainfall_24h_mm, forecast_rainfall_6h_mm, status,
            hazard_type, risk_score, severity, severity_source, message, eta_minutes,
            predicted_time, timestamp)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
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
            result.get("severity_source"),
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
FIRMWARE_SENDS_CORRECTED_WATER_LEVEL = False


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


@app.on_event("startup")
def startup():
    global _flood_model, _flood_feature_cols, _anomaly_model, _anomaly_scaler
    global _rag_collection, _rag_embedder
    init_db()
    reload_node_registry()
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
        upstream_hist = node_history[upstream_node]
        upstream_level_m = upstream_hist[-1]["river_level_m"]
        # UPGRADE: cross-node spatial correlation needs the upstream
        # node's OWN rate of rise, not just its current level - see
        # integration_pipeline.py's apply_spatial_correlation_boost().
        upstream_rate_m_per_hr = (
            upstream_hist[-1]["river_level_m"] - upstream_hist[-2]["river_level_m"]
            if len(upstream_hist) >= 2
            else 0.0
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
        "rainfall_intensity_mm_hr": raw.rainfall_mm_since_last,
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
    }

    history.append(
        {
            "river_level_m": water_level_m,
            "rainfall_mm_since_last": raw.rainfall_mm_since_last,
            "soil_saturation": soil_saturation,
            "gas_ppm": raw.gas_ppm,
            "temp_c": raw.temp_c,
            "humidity_pct": raw.humidity_pct,
        }
    )

    return enriched


@app.post("/api/ingest")
def ingest_reading(raw: RawReading):
    timestamp = raw.timestamp or datetime.now(timezone.utc).isoformat()
    node_health[raw.node_id] = {
        "last_seen": timestamp,
        "battery_pct": raw.battery_pct,
        "signal_strength_dbm": raw.signal_strength_dbm,
    }
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

    # UPGRADE: predictive maintenance - checked on every reading, but
    # this is a NODE HEALTH signal (for officers/maintainers), separate
    # from the hazard severity a citizen sees. Never affects risk_score
    # or severity - a drifting temp sensor doesn't mean there's a flood.
    result["predictive_maintenance"] = check_all_sensors_for_drift(
        node_history[raw.node_id]
    )

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

    output_path = f"/tmp/situation_report_{alert_id}.pdf"
    generate_situation_report_pdf(event, timeline, output_path)
    return FileResponse(
        output_path,
        media_type="application/pdf",
        filename=f"sanjeevni_situation_report_{alert_id}.pdf",
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
        "INSERT INTO nodes (node_id, location, land_use, curve_number, latitude, longitude, upstream_node) VALUES (?,?,?,?,?,?,?)",
        (
            node_id,
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
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
        "UPDATE nodes SET location=?, land_use=?, curve_number=?, latitude=?, longitude=?, upstream_node=? WHERE node_id=?",
        (
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
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
