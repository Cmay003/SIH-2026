"""
SANJEEVNI - Backend Server (FastAPI, AI layer)
Run: uvicorn backend_server:app --host 127.0.0.1 --port 8000
(127.0.0.1: only server.js on the same machine should reach this service.)
"""

import json
import sqlite3
import os
# Windows 11 Smart App Control blocks wrapt's unsigned compiled helper
# (_wrappers.*.pyd, pulled in by TensorFlow / ChromaDB) with "Part of this
# app has been blocked". wrapt's pure-Python fallback behaves the same.
# Must run before those imports. To keep the compiled helper, set
# WRAPT_DISABLE_EXTENSIONS to an EMPTY value (wrapt treats "0" as set).
os.environ.setdefault("WRAPT_DISABLE_EXTENSIONS", "1")
import secrets
import joblib
import requests
import statistics
import threading
from contextlib import asynccontextmanager, contextmanager
import math
import re
import tempfile
from collections import deque
from pathlib import Path
from datetime import datetime, timezone, timedelta
from typing import Literal, Optional
from dotenv import load_dotenv

# Before the project imports below: integration_pipeline reads
# SANJEEVNI_BENCH_MODE / _BENCH_MOUNT_M / _MAX_RIVER_LEVEL_M (and paths.py
# reads SANJEEVNI_VAR_DIR) when imported, so loading .env later silently
# ignored those settings. .env sits in the project root, one level up.
load_dotenv(os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"))

import paths  # noqa: E402 - every file location (backend/paths.py)
from predictive_maintenance import check_all_sensors_for_drift

from fastapi import FastAPI, HTTPException, Response, Header, Depends
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from starlette.background import BackgroundTask
from pydantic import BaseModel, Field, ValidationError, field_validator, model_validator

from integration_pipeline import (
    train_flood_model,
    train_anomaly_detector,
    process_reading,
    compute_flood_risk,
    explain_flood_risk,
    implausible_fields,
    fault_fields,
    rain_reading_plausible,
    anomaly_baseline,
    bench_mount_for,
    river_spike,
    ANOMALY_BASELINE_MAX_AGE_MIN,
    ANOMALY_BASELINE_MIN_SAMPLES,
    ANOMALY_BASELINE_WINDOW,
    ANOMALY_FEATURES,
    DERIVED_FROM,
)
import fast_inference
from rag_alert_pipeline import build_knowledge_base, severity_band
from hazard_classification import (
    LANDSLIDE_RAIN_WINDOWS_HOURS,
    PROXY_SATURATION_PER_MM,
    SHORT_TREND_FIELDS,
    SHORT_TREND_WINDOW_MINUTES,
    CM_PER_MIN_TO_M_PER_HR,
    FLOOD_SIGNATURE_RAIN_MM_HR,
    FLOOD_SIGNATURE_RATE_M_PER_HR,
    short_window_trend,
)
from cap_alert import generate_cap_alert
from hazard_confirmation import HazardConfirmer
from alert_confidence import (
    add_confidence_to_message,
    compute_confidence,
    load_flood_calibration,
    stuck_hazard_fields,
)
import river_forecast
from satellite_check import satellite_flood_check
from situation_report import generate_situation_report_pdf
import analytics

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

DB_PATH = paths.DB_PATH  # var/sanjeevni.db, shared with server/server.js
MODEL_CARD_PATH = paths.MODEL_CARD_PATH  # var/models/model_card.json (ml/evaluate_models.py)

# Admin node-registry endpoints use the same OFFICER_API_KEY as server.js.
# There is NO fallback key: the old demo default was published in the repo,
# so anyone reaching this port could have edited or deleted nodes. Unset =
# admin endpoints disabled. Also run uvicorn with --host 127.0.0.1 so only
# server.js (same machine) can reach this service at all.
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
    # Per-node landslide rainfall threshold I = alpha * D^-beta (NULL = the
    # global Caine 1980 default - see hazard_classification.py). Setting
    # either one also marks a node WITHOUT a tilt sensor as a slope node, so
    # its rain gauge can raise a landslide WATCH.
    for col in ("landslide_rain_alpha", "landslide_rain_beta"):
        if col not in node_cols:
            conn.execute(f"ALTER TABLE nodes ADD COLUMN {col} REAL")
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

    new_registry = {
        row["node_id"]: {
            "location": row["location"],
            "land_use": row["land_use"],
            "curve_number": row["curve_number"],
            "latitude": row["latitude"],
            "longitude": row["longitude"],
            "upstream_node": row["upstream_node"],
            "report_interval_seconds": row["report_interval_seconds"],
            "landslide_rain_alpha": row["landslide_rain_alpha"],
            "landslide_rain_beta": row["landslide_rain_beta"],
        }
        for row in rows
    }
    # Built first, swapped in under the ingest lock. Admin edits run on the
    # same thread pool as ingest: clearing and refilling the dict in place
    # let a concurrent reading see a half-built registry and be rejected as
    # an "unknown node" - and the node then dropped it for good, because
    # the batch itself answered 200. Same dict object, so every existing
    # reference to NODE_REGISTRY stays valid. Readers outside the lock
    # iterate over a snapshot (list(NODE_REGISTRY.items())).
    with _ingest_lock:
        # Tracking entries are created BEFORE the node is published in the
        # registry: get_nodes() reads outside this lock and looks up
        # node_history for every node in its registry snapshot, so a node
        # must never be visible in NODE_REGISTRY without a history entry
        # (that was a KeyError -> 500 for a node just added by an admin).
        for node_id in new_registry:
            # Lazily create history/health tracking for any node not seen
            # before (e.g. just added via the admin API) - never overwrites
            # existing history for a node that already had readings.
            if node_id not in node_history:
                node_history[node_id] = deque(maxlen=HISTORY_WINDOW)
            if node_id not in node_health:
                node_health[node_id] = {}
        NODE_REGISTRY.clear()
        NODE_REGISTRY.update(new_registry)


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
# Uses Open-Meteo's Elevation API - the same provider as the weather
# forecast below, so weather and terrain come from one provider instead
# of two (the Sentinel-1 radar cross-check is separate, see satellite_check.py).
# Docs: https://open-meteo.com/en/docs/elevation-api (checked 2026-10-08):
#   GET /v1/elevation?latitude=a,b,...&longitude=x,y,...  (comma-separated,
#   up to 100 coordinates per request), no API key for non-commercial use;
#   returns {"elevation": [m, ...]} - always a list, in request order.
#   Errors are HTTP 400 + {"error": true, "reason": ...}.
#   Data: Copernicus DEM 2021 GLO-90 (90 m grid). The ~100 m sample
#   offset below is only about one grid cell, so the slope is a coarse
#   local estimate - fine for a capped CN nudge, not for engineering use.
#   Attribution required: Copernicus programme + Open-Meteo.
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
OPEN_METEO_ELEVATION_URL = "https://api.open-meteo.com/v1/elevation"
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
        # One request for all 5 points: parallel comma-separated lists.
        response = requests.get(
            OPEN_METEO_ELEVATION_URL,
            params={
                "latitude": ",".join(str(lat) for lat, _ in points),
                "longitude": ",".join(str(lon) for _, lon in points),
            },
            timeout=ELEVATION_FETCH_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        elevations = [float(e) for e in response.json()["elevation"]]
        # A short list would otherwise compute a slope from fewer
        # neighbours (or crash on [0]) - treat it like any bad response.
        if len(elevations) != len(points):
            raise ValueError(
                f"expected {len(points)} elevations, got {len(elevations)}"
            )

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
# Hourly variables asked for (names and units from
# https://open-meteo.com/en/docs, read 2026-10-09): precipitation is the
# preceding hour's sum in mm; wind_speed_10m is km/h; wind_gusts_10m is the
# preceding hour's maximum gust in km/h. The wind feeds the high_wind
# hazard, the 24 h rain sum the heavy_rain hazard
# (hazard_classification.classify_heavy_rain / classify_high_wind).
WEATHER_HOURLY_VARIABLES = "precipitation,wind_speed_10m,wind_gusts_10m"
FLOOD_FORECAST_WINDOW_HOURS = 6     # flood model feature (forecast_rainfall_6h_mm)
EXTREME_WEATHER_WINDOW_HOURS = 24   # IMD rainfall categories are 24 h totals
# SANJEEVNI_WEATHER_MOCK=<path to a JSON file shaped like Open-Meteo's
# response> makes the backend read that file instead of the internet, for
# tests and the offline demo (example files: data/weather_mock/). Read on
# every call (no cache), so the demo can swap the file while running.
# Mock results carry forecast_source "mock" and every alert text built on
# them says it is a test file. The mock is applied to SIMULATED readings
# only: a REAL (non-simulated) reading gets no forecast at all while the
# variable is set (no heavy_rain / high_wind input AND no 6 h rain for the
# flood model), so a test file left configured can never change a real
# node's risk, alert or siren. (Before 2026-10-09 the mock's 6 h rain went
# into the flood model for real nodes too - a synthetic storm could push a
# real river reading to CRITICAL.) hazard_confirmation additionally refuses
# to confirm a mock-forecast alert on a real reading (defence in depth).
# For SIMULATED nodes the mock's 6 h rain still feeds the flood model on
# purpose: the judge demo's storm cue (tools/demo/run_demo.js cue 11) is
# meant to raise simulated flood risk along with the forecast alerts.
WEATHER_MOCK_ENV = "SANJEEVNI_WEATHER_MOCK"
# Unit conversions for a payload that declares non-default units in
# "hourly_units" (a mock file may); anything unknown is rejected.
_WIND_TO_KMH = {"km/h": 1.0, "kmh": 1.0, "m/s": 3.6, "ms": 3.6, "kn": 1.852, "mp/h": 1.609344, "mph": 1.609344}
_RAIN_TO_MM = {"mm": 1.0, "inch": 25.4}

_weather_cache: dict[str, dict] = (
    {}
)  # node_id -> {"value": 6 h rain mm, "weather": fetch_weather_forecast() dict, "fetched_at": datetime}
_weather_mock_rebase_logged: set = set()
_weather_mock_missing_logged: set = set()
_weather_mock_real_logged: set = set()


def _hourly_factor(payload: dict, variable: str, table: dict, default_unit: str) -> float:
    unit = str((payload.get("hourly_units") or {}).get(variable) or default_unit).strip()
    if unit not in table:
        raise ValueError(f"unsupported unit {unit!r} for {variable}")
    return table[unit]


def _complete_window(values, start: int, hours: int):
    """values[start:start+hours] when every hour is there and not null,
    else None - a gappy window is an unknown, never "less rain / wind"."""
    if not isinstance(values, list):
        return None
    window = values[start:start + hours]
    if len(window) < hours or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) for v in window
    ):
        return None
    return window


def summarise_forecast(payload: dict, now: datetime, allow_rebase: bool = False) -> dict:
    """Open-Meteo hourly payload -> the numbers the pipeline uses:
      rain_6h_mm          next 6 h (flood model) - REQUIRED: an incomplete
                          6 h window raises, as before
      rain_24h_mm         next 24 h (heavy_rain) - None when incomplete
      wind_speed_max_kmh  max hourly 10 m wind, next 24 h (high_wind)
      wind_gust_max_kmh   max hourly 10 m gust, next 24 h (high_wind)
      rebased             True when allow_rebase was used (below)
    The window starts at the current UTC hour, which must be in the
    payload. allow_rebase (mock files only): a fixed test file has no entry
    for "now", so its FIRST hour is taken as the current hour."""
    hourly = payload["hourly"]
    times = hourly["time"]
    current_hour_key = now.strftime("%Y-%m-%dT%H:00")
    # The current hour must be in the response. Falling back to index 0
    # (as before 2026-10-08) summed whatever hours the payload started
    # with - an old or wrongly-zoned forecast - and cached it as "the next
    # 6 h". Only a mock file may do that, on purpose.
    rebased = False
    if current_hour_key in times:
        start_idx = times.index(current_hour_key)
    elif allow_rebase and times:
        start_idx, rebased = 0, True
    else:
        raise ValueError(f"forecast has no entry for {current_hour_key}")

    rain_factor = _hourly_factor(payload, "precipitation", _RAIN_TO_MM, "mm")
    precip = hourly["precipitation"]
    window = _complete_window(precip, start_idx, FLOOD_FORECAST_WINDOW_HOURS)
    # A short or gappy window is an incomplete forecast, not "less rain":
    # caching a 3-hour sum as the 6-hour value would quietly lower flood
    # risk for the next 30 min. Raising takes the failure path
    # (last good cached value, else None = "forecast unavailable").
    # Open-Meteo sends null for hours it has no value for.
    if window is None:
        raw = precip[start_idx:start_idx + FLOOD_FORECAST_WINDOW_HOURS]
        raise ValueError(
            f"incomplete 6 h forecast window ({len(raw)} hours, "
            f"{sum(v is None for v in raw)} null)"
        )
    rain_24h = _complete_window(precip, start_idx, EXTREME_WEATHER_WINDOW_HOURS)

    def wind_max(variable):
        values = _complete_window(hourly.get(variable), start_idx, EXTREME_WEATHER_WINDOW_HOURS)
        if values is None:
            return None
        return round(max(values) * _hourly_factor(payload, variable, _WIND_TO_KMH, "km/h"), 1)

    return {
        "rain_6h_mm": float(sum(window)) * rain_factor,
        "rain_24h_mm": round(float(sum(rain_24h)) * rain_factor, 1) if rain_24h is not None else None,
        "wind_speed_max_kmh": wind_max("wind_speed_10m"),
        "wind_gust_max_kmh": wind_max("wind_gusts_10m"),
        "rebased": rebased,
    }


def _mock_weather_forecast(mock_path: str, now: datetime) -> Optional[dict]:
    """The mock file's forecast, or None. A MISSING file is a normal state
    (the demo creates / deletes it to switch the storm on and off), logged
    once instead of on every reading; it never falls back to the internet."""
    if not os.path.exists(mock_path):
        if mock_path not in _weather_mock_missing_logged:
            _weather_mock_missing_logged.add(mock_path)
            print(f"[weather] {WEATHER_MOCK_ENV} file {mock_path!r} not found - no forecast "
                  "(the mock never falls back to the internet)")
        return None
    _weather_mock_missing_logged.discard(mock_path)
    try:
        with open(mock_path, encoding="utf-8") as f:
            payload = json.load(f)
        summary = summarise_forecast(payload, now, allow_rebase=True)
    except Exception as e:
        print(f"[weather] {WEATHER_MOCK_ENV} file {mock_path!r} unusable: {e}")
        return None
    if summary.pop("rebased") and mock_path not in _weather_mock_rebase_logged:
        _weather_mock_rebase_logged.add(mock_path)
        print(f"[weather] {WEATHER_MOCK_ENV}: no entry for the current hour - "
              "the file's first hour is used as 'now'")
    return {**summary, "source": "mock"}


def fetch_weather_forecast(latitude: float, longitude: float, node_id: str,
                           simulated: bool = False) -> Optional[dict]:
    """
    The next hours' weather at this node's location from Open-Meteo's free
    hourly forecast (or, for a SIMULATED reading only, the
    SANJEEVNI_WEATHER_MOCK file - a real reading gets None while the mock
    is configured; see WEATHER_MOCK_ENV):
    {"rain_6h_mm", "rain_24h_mm", "wind_speed_max_kmh",
     "wind_gust_max_kmh", "source": "open-meteo"|"mock"}; the last three
    numbers may be None when that part of the forecast is incomplete.

    Cached per node for WEATHER_CACHE_TTL_MINUTES so we don't hit the API
    on every single sensor reading - readings can arrive every few
    seconds, but a forecast is meaningless to re-fetch that often.

    Returns None if the fetch fails and there's no usable cached value
    (e.g. no internet, API down, bad response). Callers should treat None
    as "forecast unavailable" and fall back gracefully - a weather API
    outage should never crash the ingest pipeline or block a real hazard
    reading from being processed.
    """
    now = datetime.now(timezone.utc)
    mock_path = os.environ.get(WEATHER_MOCK_ENV)
    if mock_path:
        if not simulated:
            # A test file must never reach a real node's risk (flood model
            # input included), and the mock never falls back to the
            # internet either: no forecast for this reading.
            if node_id not in _weather_mock_real_logged:
                _weather_mock_real_logged.add(node_id)
                print(f"[weather] {WEATHER_MOCK_ENV} is set: ignored for REAL readings "
                      f"from {node_id} (no forecast used)")
            return None
        return _mock_weather_forecast(mock_path, now)

    cached = _weather_cache.get(node_id)

    def cached_value():
        if not cached:
            return None
        # An entry holding only the 6 h value (older code, tests) still
        # serves the flood model; the extreme-weather parts are unknown.
        return cached.get("weather") or {
            "rain_6h_mm": cached["value"], "rain_24h_mm": None,
            "wind_speed_max_kmh": None, "wind_gust_max_kmh": None, "source": "open-meteo",
        }

    if cached and (now - cached["fetched_at"]) < timedelta(
        minutes=WEATHER_CACHE_TTL_MINUTES
    ):
        return cached_value()
    if _api_in_backoff("weather"):
        # Same fallback as a failed fetch, without waiting on another timeout
        return cached_value()

    try:
        response = requests.get(
            OPEN_METEO_URL,
            params={
                "latitude": latitude,
                "longitude": longitude,
                "hourly": WEATHER_HOURLY_VARIABLES,
                # 2 days, not 1: with forecast_days=1 the response stops at
                # 23:00 UTC today, so from 18:00 UTC (23:30 IST - monsoon
                # night rain) the "next 6 hours" window ran off the end and
                # summed only 5..1 hours, under-reporting the flood input.
                # 2 days also always holds the next 24 h.
                "forecast_days": 2,
                "timezone": "UTC",
            },
            timeout=WEATHER_FETCH_TIMEOUT_SECONDS,
        )
        response.raise_for_status()
        weather = summarise_forecast(response.json(), now)
        weather.pop("rebased")
        weather["source"] = "open-meteo"

        _weather_cache[node_id] = {"value": weather["rain_6h_mm"], "weather": weather, "fetched_at": now}
        _api_failed_at.pop("weather", None)
        return weather

    except Exception as e:
        _api_failed_at["weather"] = datetime.now(timezone.utc)
        print(
            f"[weather] forecast fetch failed for {node_id}; not retrying for "
            f"{EXTERNAL_API_RETRY_AFTER_MINUTES} min: {e}"
        )
        # Fall back to the last good cached value rather than nothing, if we have one
        return cached_value()


def fetch_forecast_rainfall_mm(
    latitude: float, longitude: float, node_id: str, simulated: bool = False
) -> Optional[float]:
    """Forecast rainfall (mm) for the next 6 hours at this node - the flood
    model's forecast feature. None = forecast unavailable (see
    fetch_weather_forecast)."""
    weather = fetch_weather_forecast(latitude, longitude, node_id, simulated=simulated)
    return weather["rain_6h_mm"] if weather else None


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
# The model card's reliability table for the loaded flood model, used by
# the confidence score; None when the card is missing or describes a
# different model file (alert_confidence.load_flood_calibration).
_flood_calibration = None


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
    # Comma-separated fields dropped as physically impossible (their value
    # columns are then NULL). Kept even when the reading still alerted on
    # another sensor, so maintainers can see a channel has failed.
    "sensor_faults": "TEXT",
    # The node's position WHEN the reading was taken. The CAP export used
    # the live registry, so a node moved later relocated its old alerts and
    # a deleted node's alerts were placed at 0,0. Filled by save_reading
    # from result["latitude"/"longitude"]; NULL on rows from before this.
    "latitude": "REAL",
    "longitude": "REAL",
    # The node's own fast-rise check and anomaly flags (2026-10-09), kept
    # so an officer can audit why a flash flood fired or a channel was
    # distrusted. edge_anomaly is comma-separated like sensor_faults.
    "fast_rise": "INTEGER",
    "rise_rate_cm_per_min": "REAL",
    "edge_anomaly": "TEXT",
    # Confidence score of an alert (alert_confidence.py); NULL for logged /
    # suppressed readings and rows from before 2026-10-09. The CAP export
    # maps it to <certainty>. confidence_reasons is a JSON array of text.
    "confidence": "REAL",
    "confidence_label": "TEXT",
    "confidence_reasons": "TEXT",
    # Next-24 h weather forecast behind the heavy_rain / high_wind hazards
    # (2026-10-09); forecast_source is "open-meteo" or "mock" (a test file,
    # SANJEEVNI_WEATHER_MOCK), NULL when no forecast was available.
    "forecast_rainfall_24h_mm": "REAL",
    "forecast_wind_speed_max_kmh": "REAL",
    "forecast_wind_gust_max_kmh": "REAL",
    "forecast_source": "TEXT",
    # The node said it has a siren output (2026-10-09). Restores the
    # node's expected report interval after a restart (decision (1):
    # siren nodes summarise every 60 s, the others every 300 s).
    "siren_fitted": "INTEGER",
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
    # Time-range scans for /api/analytics/* and the CAP feed (analytics.py):
    # without these every trends/summary request read the whole table.
    conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_timestamp ON readings(timestamp)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_readings_node_timestamp ON readings(node_id, timestamp)")
    conn.commit()

    init_node_registry_table(conn)
    conn.close()


@contextmanager
def _ingest_db(conn: Optional[sqlite3.Connection]):
    """The connection an ingest step writes through: the caller's (the
    kept-open ingest connection, see ingest_connection), else a
    short-lived one of its own, as before (direct callers, tests)."""
    if conn is not None:
        yield conn
        return
    own = sqlite3.connect(DB_PATH)
    try:
        yield own
    finally:
        own.close()


# Step B2: ONE kept-open SQLite connection for the ingest path. Opening a
# connection per step (duplicate check, then insert) cost ~14 ms of every
# reading on Windows with the WAL database (open + -wal/-shm mapping +
# schema parse on the first statement) - about half of a reading's time
# once the models were fast (tests/ingest_bench.py: 26 ms per single
# reading vs 12 ms in a batch sharing one connection). Only used while
# _ingest_lock is held (one thread at a time; check_same_thread off for
# that reason). Every reading is still committed on its own, and a failed
# INSERT is rolled back at once (_insert_reading), so the write lock on the
# file server.js also writes to is never kept between readings. Re-opened
# when DB_PATH changes (tests) or after any SQLite error.
_ingest_conn = {"path": None, "conn": None}


def ingest_connection() -> sqlite3.Connection:
    """The kept-open ingest connection (caller holds _ingest_lock)."""
    if _ingest_conn["conn"] is None or _ingest_conn["path"] != DB_PATH:
        close_ingest_connection()
        _ingest_conn["conn"] = sqlite3.connect(DB_PATH, check_same_thread=False)
        _ingest_conn["path"] = DB_PATH
    return _ingest_conn["conn"]


def close_ingest_connection():
    """Close the kept-open ingest connection (re-opened on next use)."""
    conn, _ingest_conn["conn"], _ingest_conn["path"] = _ingest_conn["conn"], None, None
    if conn is not None:
        try:
            conn.close()
        except sqlite3.Error:
            pass


def _insert_reading(conn: sqlite3.Connection, sql: str, values: tuple):
    """INSERT + COMMIT; on a failed INSERT the implicit transaction is
    rolled back, so a shared connection never keeps the database's write
    lock (server.js writes to the same file) after a duplicate."""
    try:
        conn.execute(sql, values)
    except sqlite3.Error:
        conn.rollback()
        raise
    conn.commit()


def save_reading(enriched: dict, result: dict, timestamp: str, conn: Optional[sqlite3.Connection] = None):
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
    row["sensor_faults"] = ",".join(result.get("sensor_faults") or ()) or None
    row["fast_rise"] = 1 if enriched.get("fast_rise") else 0
    row["siren_fitted"] = 1 if enriched.get("siren_fitted") else 0
    row["edge_anomaly"] = ",".join(enriched.get("edge_anomaly") or ()) or None
    reasons = result.get("confidence_reasons")
    row["confidence_reasons"] = json.dumps(reasons) if reasons else None

    columns = ", ".join(row)
    placeholders = ", ".join("?" for _ in row)
    with _ingest_db(conn) as db:
        _insert_reading(db, f"INSERT INTO readings ({columns}) VALUES ({placeholders})", tuple(row.values()))


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
# Shortest gap a reading's own rain rate is worked out over (derive_features,
# reading_rain_mm_hr). DEMO DEFAULT: rain reported over a shorter gap is
# spread over this long, so a few seconds' rain cannot claim a huge rate.
RAIN_RATE_MIN_GAP_SECONDS = 60
# Upstream data older than RATE_WINDOW_MINUTES (or this many of the
# upstream node's configured report intervals, if longer) is no evidence
# about the river NOW - see upstream_history_for().
UPSTREAM_MAX_MISSED_REPORTS = 3
# Clamp on the reported river rise/fall rate. Steeper slopes come from a
# sudden step (sensor knocked, glitch, re-mount) still inside the 15-minute
# window, and were reaching +400 m/hr on a river that was actually FALLING,
# which broke the ETA projection and the dashboard (B33 follow-up).
# DEMO DEFAULT - VERIFY PER SITE: 5 m/hr is not taken from a hydrological
# source; set it from the site's own records (e.g. CWC gauge data). It only
# clamps the rate (5 m/hr is already far above the flash-flood CRITICAL
# rate), it never throws a level away.
MAX_RIVER_RATE_M_PER_HR = float(os.environ.get("SANJEEVNI_MAX_RIVER_RATE_M_PER_HR", "5"))
# How fast the level may move between two readings before the jump is held
# as a sensor spike (integration_pipeline.river_spike) - its own setting,
# because unlike the clamp above it decides whether a level is used at all.
# DEMO DEFAULT - VERIFY PER SITE (no hydrological source; review 2026-10-09).
# A real rise faster than this is still accepted within
# RIVER_SPIKE_ACCEPT_AFTER readings (a step that stays, or a steady ramp),
# or at once with rain / upstream / fast-rise corroboration.
RIVER_SPIKE_MAX_RATE_M_PER_HR = float(os.environ.get("SANJEEVNI_RIVER_SPIKE_MAX_RATE_M_PER_HR", "5"))


def clamp_river_rate(rate: float) -> float:
    return max(-MAX_RIVER_RATE_M_PER_HR, min(MAX_RIVER_RATE_M_PER_HR, rate))
SOIL_DRYING_TIME_CONSTANT_HOURS = 48.0  # saturation proxy decays to ~37% after this long without rain
# One constant for both sides: assess_landslide_rain() takes a storm's own
# rain back out of this proxy before the antecedent-wetness test.
SOIL_SATURATION_PER_MM = PROXY_SATURATION_PER_MM

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
    fit = rate_fit(history, key, current_value, now)
    return fit["slope"] if fit else 0.0


def rate_window_points(history, key: str, current_value: float, now: datetime) -> list:
    """(hours relative to now, value) for the readings in the last
    RATE_WINDOW_MINUTES plus the current one (at 0.0), in history order."""
    window_start = now - timedelta(minutes=RATE_WINDOW_MINUTES)
    points = [((r["timestamp"] - now).total_seconds() / 3600, r[key])
              for r in history if window_start <= r["timestamp"] <= now and r.get(key) is not None]
    points.append((0.0, current_value))
    return points


def rate_fit(history: deque, key: str, current_value: float, now: datetime):
    """The least-squares line through the readings in the last
    RATE_WINDOW_MINUTES plus the current one, as {"slope": per hour,
    "sigma": residual standard deviation (None with only 2 points - no
    degree of freedom left), "time_ss": sum of squared time offsets (h^2),
    "n": points}; None when there is less than MIN_RATE_SPAN_SECONDS of
    history. The slope's standard error is sigma / sqrt(time_ss).
    history is in ARRIVAL order (a backlog can arrive after newer
    readings), so the span is measured from the OLDEST point, not the
    first one in the list."""
    points = rate_window_points(history, key, current_value, now)
    span_seconds = -min(t for t, _ in points) * 3600
    if span_seconds < MIN_RATE_SPAN_SECONDS:
        return None
    return line_fit(points)


def line_fit(points):
    """rate_fit's numbers for a list of (hours, value) points; None when
    the times are all equal."""
    n = len(points)
    mean_t = sum(t for t, _ in points) / n
    mean_v = sum(v for _, v in points) / n
    time_ss = sum((t - mean_t) ** 2 for t, _ in points)
    if time_ss == 0:
        return None
    slope = sum((t - mean_t) * (v - mean_v) for t, v in points) / time_ss
    sigma = None
    if n > 2:
        residual_ss = sum((v - (mean_v + slope * (t - mean_t))) ** 2 for t, v in points)
        sigma = math.sqrt(residual_ss / (n - 2))
    return {"slope": slope, "sigma": sigma, "time_ss": time_ss, "n": n}


# --- River rate: a rise must stand out from the sensor's noise (step B1) --
#
# With few points in the window the least-squares slope IS the noise: two
# readings 60 s apart that differ by 1.5 cm of jitter "rise" at 0.9 m/h,
# above the flash-flood MEDIUM rate (0.6 m/h). Measured 2026-10-09 on the
# load-test stream with +-1 cm river noise (tests/false_alarm_streams.py):
# MEDIUM flash floods on a calm river, all on a node's 2nd reading.
# A river rate now counts only when
#   - the window holds at least MIN_RIVER_RATE_POINTS readings, and
#   - the slope is at least RIVER_RATE_SIGNIFICANCE_Z standard errors from
#     0, with the noise taken as the larger of the fit's own residual
#     spread and RIVER_NOISE_FLOOR_M (a 3-point fit's residual can be ~0
#     by chance).
# Otherwise the rate is 0.0, "no evidence of change" - the same answer as
# too little history. It feeds the flash-flood check, the flood model,
# the upstream corroboration and the ETA alike.
# The noise is measured on the CALM part of the window when there is one:
# with at least NOISE_FIT_MIN_POINTS points, the residual of a line through
# all but the newest NOISE_EXCLUDE_NEWEST points. The residual of the whole
# fit also contains the BEND between a calm stretch and a sudden rise, and
# gated real rises to 0 for 2 readings mid-stream (review 2026-10-09:
# 15 calm minutes then 50 cm/min read 0.0 at minute 2 where the plain slope
# read 1.90 m/h, above flash-flood HIGH).
# Cost, measured 2026-10-09 (river_rate_per_hour vs the plain slope,
# 60 s cadence, noise-free): with 3 or 4 points in the window (start-up)
# the whole-fit residual still gates, so a rise right then is seen one
# reading later (3 calm min + 10 cm/min: 0.0 vs 1.8 m/h at minute 1).
# After 15 calm minutes, rises of 10/20/30/50 cm/min now read the plain
# slope from the first rising reading on (before this change: 0.0 for
# minutes 1 and 2). Calm river, +-1 cm noise, 20 000 windows each:
# P(rate >= 0.2 m/h) at 5 / 6 points 0.31 % / 0.43 % before, 0.26 % /
# 0.37 % after; P(rate >= 0.6 m/h) 0 before and after; 3, 4, 8, 16 points
# unchanged. At 5 s (elevated mode) the window holds many points. The
# node's own fast-rise check (taken from every raw sample) is unaffected.
# RIVER_NOISE_FLOOR_M IS A DEMO DEFAULT (river-surface ripple plus
# ultrasonic jitter; not from a datasheet) - set it per site from a calm
# day's readings. In bench mode it scales with the rig (a few cm tall).
MIN_RIVER_RATE_POINTS = 3
RIVER_RATE_SIGNIFICANCE_Z = 3.0
NOISE_EXCLUDE_NEWEST = 2
NOISE_FIT_MIN_POINTS = MIN_RIVER_RATE_POINTS + NOISE_EXCLUDE_NEWEST  # leaves >= 3 calm points (1 dof)
RIVER_NOISE_FLOOR_M = float(os.environ.get("SANJEEVNI_RIVER_NOISE_FLOOR_M", "0.005"))
BENCH_NOISE_FLOOR_FRACTION = 0.05  # of the bench rig's mount height
# A level change far beyond any sensor noise is evidence by itself
# (integration 2026-10-10): when the newest RIVER_RATE_CLEAR_READINGS
# levels ALL lie at least RIVER_RATE_CLEAR_CHANGE_M on the same side of the
# median of the older points in the window, the plain slope is used
# without the significance gate. The "calm" fit above assumes the rise is
# in the newest NOISE_EXCLUDE_NEWEST points only; after a step (wave front)
# followed by a plateau, with dense readings right before the step and
# only one or two sparse older points in the window (a node back from a
# link outage, a 5-min node going to 5-s samples, the judge demo's 2-s
# rounds after its 150-s history), the step itself landed in the "noise"
# and the rate read 0.0 for the whole plateau: the judge demo's 3.8-4.1 m
# river read 0.0 m/h for 17 readings and its flood stayed MEDIUM/HIGH.
# 0.3 m is 60x the noise floor and 30x the +-1 cm jitter of the false-alarm
# streams; a one-reading spike is held out of history by river_spike, so it
# cannot make 3 newest points. Bench rigs (a few cm) never reach it.
# DEMO DEFAULT - VERIFY PER SITE.
RIVER_RATE_CLEAR_CHANGE_M = float(os.environ.get("SANJEEVNI_RIVER_RATE_CLEAR_CHANGE_M", "0.3"))
RIVER_RATE_CLEAR_READINGS = 3


def river_noise_floor_m(bench_mount_m=None) -> float:
    return BENCH_NOISE_FLOOR_FRACTION * bench_mount_m if bench_mount_m else RIVER_NOISE_FLOOR_M


def river_rate_per_hour(history, current_value: float, now: datetime, bench_mount_m=None) -> float:
    """The river's rate of rise in m/h (clamped), or 0.0 when it does not
    stand out from the sensor's noise - see the block above."""
    points = rate_window_points(history, "river_level_m", current_value, now)
    if -min(t for t, _ in points) * 3600 < MIN_RATE_SPAN_SECONDS:
        return 0.0
    fit = line_fit(points)
    if not fit or fit["n"] < MIN_RIVER_RATE_POINTS or fit["sigma"] is None:
        return 0.0
    change = clear_level_change(points)
    if change and (change > 0) == (fit["slope"] > 0):
        return clamp_river_rate(fit["slope"])
    noise = fit["sigma"]
    if fit["n"] >= NOISE_FIT_MIN_POINTS:
        calm = line_fit(sorted(points)[:-NOISE_EXCLUDE_NEWEST])
        if calm and calm["sigma"] is not None:
            noise = calm["sigma"]
    sigma = max(noise, river_noise_floor_m(bench_mount_m))
    stderr = sigma / math.sqrt(fit["time_ss"])
    if abs(fit["slope"]) < RIVER_RATE_SIGNIFICANCE_Z * stderr:
        return 0.0
    return clamp_river_rate(fit["slope"])


def clear_level_change(points) -> float:
    """+1 / -1 when the newest RIVER_RATE_CLEAR_READINGS levels all lie at
    least RIVER_RATE_CLEAR_CHANGE_M above / below the median of the older
    points in the window (needs >= 2 older points), else 0."""
    ordered = sorted(points)  # by time (history can arrive out of order)
    if len(ordered) < RIVER_RATE_CLEAR_READINGS + 2:
        return 0
    base = statistics.median(v for _, v in ordered[:-RIVER_RATE_CLEAR_READINGS])
    newest = [v for _, v in ordered[-RIVER_RATE_CLEAR_READINGS:]]
    if all(v - base >= RIVER_RATE_CLEAR_CHANGE_M for v in newest):
        return 1
    if all(base - v >= RIVER_RATE_CLEAR_CHANGE_M for v in newest):
        return -1
    return 0


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
    # Readings taken while the water sensor was missing/failed hold None.
    recent = [v for v in recent if v is not None]
    recent.append(current_value)
    return statistics.median(recent)


def last_entry_with(history, key: str):
    """Most recent history entry that actually has `key` (modular nodes and
    failed sensors leave gaps), or None."""
    for entry in reversed(history):
        if entry.get(key) is not None:
            return entry
    return None


def last_value(history, key: str):
    entry = last_entry_with(history, key)
    return entry[key] if entry else None


# --- Optional reading fields added 2026-10-09 (siren, fast rise, edge
# anomaly checks, NORMAL-mode summaries) ----------------------------------
# A malformed value in one of these fields is DROPPED (the field falls back
# to its default) instead of rejecting the reading: pydantic rejects a
# whole /api/ingest/batch when one item fails, and the gateway would then
# retry that batch forever (review R7). A field the backend cannot read is
# simply not used.
EDGE_RISK_LEVELS = ("NORMAL", "WATCH", "URGENT")
SIREN_REASONS = ("auto_offline", "command")
# "<check>:<field>", e.g. "spike:gas_ppm". The check names are open-ended
# (stuck / spike / rate / dropout today) so newer firmware is not rejected.
EDGE_ANOMALY_PATTERN = re.compile(r"^[a-z_]{1,16}:[a-z0-9_]{1,32}$")
MAX_EDGE_ANOMALY_ITEMS = 16


def _drop_if_invalid(cls, value, handler, info):
    """Wrap-validator body: validate normally; on failure use the field's
    default (see the comment above)."""
    try:
        return handler(value)
    except ValidationError:
        return cls.model_fields[info.field_name].get_default(call_default_factory=True)


class SummaryStats(BaseModel):
    """min / max / mean of one sensor over a summary window."""
    min: float
    max: float
    mean: float

    @model_validator(mode="after")
    def _consistent(self):
        values = (self.min, self.max, self.mean)
        if not all(math.isfinite(v) for v in values):
            raise ValueError("summary statistics must be finite")
        # Small tolerance: the firmware rounds each number separately.
        if self.min > self.max or not self.min - 1e-6 <= self.mean <= self.max + 1e-6:
            raise ValueError("summary statistics must satisfy min <= mean <= max")
        return self


class ReadingSummary(BaseModel):
    """What a node in NORMAL mode sends instead of every raw sample: the
    reading's top-level sensor values are the LATEST sample (so the
    pipeline needs no change), and this block describes the samples since
    the previous report. Only the smoke check uses it so far (the min and
    mean let it see a rise that happened between two reports)."""
    samples: Optional[int] = Field(default=None, ge=1, le=100_000)
    window_s: Optional[int] = Field(default=None, ge=0, le=30 * 24 * 3600)
    max_edge_risk_level: Optional[str] = None
    river_level_m: Optional[SummaryStats] = None
    temp_c: Optional[SummaryStats] = None
    humidity_pct: Optional[SummaryStats] = None
    gas_ppm: Optional[SummaryStats] = None
    pm25_ugm3: Optional[SummaryStats] = None
    tilt_angle_deg: Optional[SummaryStats] = None

    @field_validator("*", mode="wrap")
    @classmethod
    def _drop_bad_fields(cls, value, handler, info):
        return _drop_if_invalid(cls, value, handler, info)

    @field_validator("max_edge_risk_level")
    @classmethod
    def _known_level(cls, value):
        return value if value in EDGE_RISK_LEVELS else None

    def stats(self, field: str) -> Optional[dict]:
        """{"min", "max", "mean"} for one sensor, or None."""
        s = getattr(self, field, None)
        return s.model_dump() if isinstance(s, SummaryStats) else None


class RawReading(BaseModel):
    node_id: str
    # Modular nodes (P2.7): every sensor is optional. A node without a
    # water sensor / DHT22 / MQ135 / flame module (or whose sensor failed
    # this time) leaves the field out, and the pipeline skips whatever
    # needs it - see integration_pipeline.process_reading().
    river_level_m: Optional[float] = None
    temp_c: Optional[float] = None
    humidity_pct: Optional[float] = None
    gas_ppm: Optional[float] = None
    flame_reading: Optional[float] = None
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
    # Someone held the SOS button on a LoRa node (firmware SJ_SOS_PRESSED;
    # omitted when not pressed). The web server raises the SOS from it
    # before forwarding the reading here; the AI pipeline ignores it - the
    # reading's sensor values are processed like any other.
    sos_button: bool = False
    # --- 2026-10-09 contract (see SummaryStats above). Omitted when false
    # or absent; a malformed value is dropped, never a rejected reading.
    # Siren state: the web server reconciles it against the officer's /
    # auto siren decision; the AI pipeline does not use it.
    siren_fitted: bool = False
    siren_on: bool = False
    siren_reason: Optional[str] = None  # "auto_offline" | "command", only with siren_on
    # The node's own river rate-of-rise check (positive = rising). A fast
    # rise is sent at once instead of waiting for the next report; the
    # flash-flood classifier uses the rate as a second measurement next to
    # the backend's own (hazard_classification.classify_flash_flood).
    fast_rise: bool = False
    rise_rate_cm_per_min: Optional[float] = None
    # On-device anomaly checks, "<check>:<field>" (EDGE_ANOMALY_PATTERN).
    edge_anomaly: Optional[list] = None  # items checked in _clean_anomaly_list
    summary: Optional[ReadingSummary] = None

    @field_validator(
        "siren_fitted", "siren_on", "siren_reason", "fast_rise", "rise_rate_cm_per_min",
        "edge_anomaly", "summary", mode="wrap",
    )
    @classmethod
    def _drop_bad_contract_fields(cls, value, handler, info):
        return _drop_if_invalid(cls, value, handler, info)

    @field_validator("rise_rate_cm_per_min")
    @classmethod
    def _finite_rate(cls, value):
        return value if value is None or math.isfinite(value) else None

    @field_validator("edge_anomaly")
    @classmethod
    def _clean_anomaly_list(cls, value):
        # Unknown-format entries are dropped one by one; duplicates and an
        # oversized list are trimmed, so a corrupted packet cannot flood
        # the stored column.
        if value is None:
            return None
        kept = []
        for item in value:
            if isinstance(item, str) and EDGE_ANOMALY_PATTERN.match(item) and item not in kept:
                kept.append(item)
        return kept[:MAX_EDGE_ANOMALY_ITEMS] or None

    @model_validator(mode="after")
    def _siren_reason_only_while_sounding(self):
        if self.siren_reason not in SIREN_REASONS or not self.siren_on:
            self.siren_reason = None
        return self

    @model_validator(mode="after")
    def _has_a_measurement(self):
        # rainfall_mm_since_last is left out: it defaults to 0.0, so it
        # can't tell "no rain" from "no gauge".
        if all(getattr(self, f) is None for f in SENSOR_FIELDS):
            raise ValueError("reading has no sensor values - at least one of " + ", ".join(SENSOR_FIELDS) + " is required")
        return self


SENSOR_FIELDS = (
    "river_level_m", "temp_c", "humidity_pct", "gas_ppm", "flame_reading", "soil_moisture_pct",
    "tilt_angle_deg", "vibration_magnitude", "pm25_ugm3", "pm10_ugm3", "water_ph", "turbidity_ntu",
)


def startup():
    global _flood_model, _flood_feature_cols, _anomaly_model, _anomaly_scaler
    global _rag_collection, _rag_embedder, _flood_calibration
    init_db()
    reload_node_registry()
    seed_node_health_from_db()
    seed_node_history_from_db()
    print(
        f"[nodes] Loaded {len(NODE_REGISTRY)} nodes from the database: {list(NODE_REGISTRY.keys())}"
    )

    models_dir = paths.MODELS_DIR
    flood_path = os.path.join(models_dir, "flood_model.joblib")
    flood_cols_path = os.path.join(models_dir, "flood_feature_cols.joblib")
    anomaly_path = os.path.join(models_dir, "anomaly_model.joblib")
    scaler_path = os.path.join(models_dir, "anomaly_scaler.joblib")

    if os.path.exists(flood_path) and os.path.exists(flood_cols_path):
        print(f"Loading trained flood model from {models_dir} ...")
        _flood_model = joblib.load(flood_path)
        _flood_feature_cols = joblib.load(flood_cols_path)
        # Only for a model loaded from disk: the card names that file's
        # sha256. A freshly trained fallback model was never evaluated.
        _flood_calibration = load_flood_calibration(MODEL_CARD_PATH, flood_path)
    else:
        print(
            "No saved flood model found - training on synthetic data (run train_models.py to use real data)..."
        )
        _flood_model, _flood_feature_cols = train_flood_model()

    if os.path.exists(anomaly_path) and os.path.exists(scaler_path):
        print(f"Loading trained anomaly model from {models_dir} ...")
        _anomaly_model = joblib.load(anomaly_path)
        _anomaly_scaler = joblib.load(scaler_path)
    else:
        print(
            "No saved anomaly model found - training on synthetic data (run train_models.py to use real data)..."
        )
        _anomaly_model, _anomaly_scaler = train_anomaly_detector()

    # Step B2: build the fast evaluators of both models now (each is checked
    # against scikit-learn on probe rows - fast_inference.py), not on the
    # first reading. None = scikit-learn is used, with the same results.
    fast = (
        fast_inference.fast_isolation_forest(_anomaly_model, _anomaly_scaler, ANOMALY_FEATURES),
        fast_inference.fast_flood_model(_flood_model, _flood_feature_cols),
    )
    print(f"[fast-inference] anomaly model: {'fast' if fast[0] else 'scikit-learn'}, "
          f"flood model: {'fast' if fast[1] else 'scikit-learn'}")

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
    # No water sensor on this node (or it failed this time): every water
    # value stays None and the flood model is skipped for this reading.
    has_water = raw.river_level_m is not None
    if raw.simulated or not has_water:
        converted_value = raw.river_level_m
    else:
        converted_value = convert_ultrasonic_distance_to_water_level_m(
            raw.river_level_m, last_value(history, "river_level_m")
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
        if raw.simulated or not has_water
        else smooth_water_level(history, converted_value)
    )

    # Rates are real per-HOUR values from timestamps. They used to be the
    # plain difference from the previous reading (3-5s earlier), which
    # made ETA projections ~700x too slow and fed the flood model a
    # feature on a different scale than it was trained on.
    # Only a rise that stands out from the sensor's noise counts - see
    # river_rate_per_hour (step B1).
    bench_mount_m = bench_mount_for({"simulated": raw.simulated})
    river_level_rate_m_per_hr = (
        river_rate_per_hour(history, water_level_m, now, bench_mount_m)
        if has_water else None
    )
    gas_ppm_rate_per_hr = (
        rate_per_hour(history, "gas_ppm", raw.gas_ppm, now) if raw.gas_ppm is not None else None
    )

    # Rain gauge range check (integration_pipeline.rain_reading_plausible):
    # the cap scales with the time since this node's previous reading. An
    # impossible value is counted as NO rain - kept out of the rain log and
    # the soil proxy - and reported as a sensor fault below, so it can't
    # raise a landslide WATCH that keeps re-scoring itself for 24 h.
    rain_hours_since_prev = (
        (now - history[-1]["timestamp"]).total_seconds() / 3600 if history else None
    )
    rain_fault = not rain_reading_plausible(raw.rainfall_mm_since_last, rain_hours_since_prev)
    rain_mm = 0.0 if rain_fault else raw.rainfall_mm_since_last

    # Rainfall totals come from a time-pruned log, not "the last 50
    # readings" (~4 min at a 5s interval) as before.
    rain_log = node_rainfall.setdefault(raw.node_id, deque())
    if rain_mm > 0:
        rain_log.append((now, rain_mm))
    while rain_log and rain_log[0][0] < now - timedelta(hours=24):
        rain_log.popleft()
    rainfall_24h_mm = sum(mm for _, mm in rain_log)
    # mm that fell in the last hour IS the intensity in mm/hr - previously
    # the per-reading amount was passed off as mm/hr.
    rainfall_intensity_mm_hr = sum(
        mm for t, mm in rain_log if t >= now - timedelta(hours=1)
    )
    # THIS reading's own rain rate. The hourly total above lags at the
    # start of a storm (60 mm/h that began 2 min ago has put ~2 mm in the
    # hour), so on its own it cannot tell the river-spike check that heavy
    # rain is falling NOW (review 2026-10-09). The gap is floored at
    # RAIN_RATE_MIN_GAP_SECONDS so one rain report over a few seconds (an
    # elevated burst, a backlog) cannot claim a huge rate. Used only as
    # corroboration for river_spike below. Trade-off: one tipping-bucket
    # tip can count as "heavy rain" for that one reading (the node
    # firmware's default 0.2794 mm bucket, RAIN_MM_PER_TIP in config.h, in
    # a gap of 60 s or less reads 16.8 mm/h; over a 5-min summary 3.4 mm/h,
    # under FLOOD_SIGNATURE_RAIN_MM_HR) - a spike in that same reading is
    # then classified, and HazardConfirmer still needs a repeat.
    reading_rain_mm_hr = (
        rain_mm / (max(rain_hours_since_prev * 3600, RAIN_RATE_MIN_GAP_SECONDS) / 3600)
        if rain_hours_since_prev is not None and rain_mm > 0 else 0.0
    )
    # mm per trailing window, for the landslide rainfall threshold, which
    # needs more durations than 1 h and 24 h (see
    # LANDSLIDE_RAIN_WINDOWS_HOURS). Same ">=" edge as the intensity above.
    rainfall_windows_mm = {
        hours: sum(mm for t, mm in rain_log if t >= now - timedelta(hours=hours))
        for hours in LANDSLIDE_RAIN_WINDOWS_HOURS
    }
    # How many separate rain reports make up each window: a window built
    # from ONE report may not trigger the landslide WATCH on its own (see
    # hazard_classification.assess_landslide_rain).
    rainfall_windows_count = {
        hours: sum(1 for t, _ in rain_log if t >= now - timedelta(hours=hours))
        for hours in LANDSLIDE_RAIN_WINDOWS_HOURS
    }

    # Soil saturation: the real capacitive sensor when the node has one;
    # otherwise a proxy that rises with rain and dries out exponentially
    # with real elapsed time (it used to lose 2% per reading, which emptied
    # it in minutes at a 5s interval).
    if raw.soil_moisture_pct is not None:
        prev_saturation = None
    elif history and history[-1].get("soil_saturation") is not None:
        # (an entry restored from an old database row may have no proxy)
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
            max(0.0, prev_saturation + rain_mm * SOIL_SATURATION_PER_MM),
        )
        soil_saturation_source = "rainfall_proxy"

    upstream_node = config.get("upstream_node")
    upstream_hist = upstream_history_for(upstream_node, raw.simulated, now)
    upstream_last = last_entry_with(upstream_hist, "river_level_m")
    if upstream_last:
        upstream_level_m = upstream_last["river_level_m"]
        # UPGRADE: cross-node spatial correlation needs the upstream
        # node's OWN rate of rise, not just its current level - see
        # integration_pipeline.py's apply_spatial_correlation_boost().
        # Noise-gated like this node's own rate: a jittery upstream sensor
        # must not count as "rising upstream" corroboration.
        # (upstream_last is the current point - not counted twice.)
        upstream_rate_m_per_hr = river_rate_per_hour(
            [e for e in upstream_hist if e is not upstream_last],
            upstream_level_m,
            upstream_last["timestamp"],
            bench_mount_for({"simulated": raw.simulated}),
        )
    else:
        upstream_level_m = water_level_m
        upstream_rate_m_per_hr = 0.0

    # The node's own recent values (step B1): an Isolation Forest flag only
    # suppresses a reading that is ALSO out of line with them
    # (integration_pipeline.anomaly_flag_stands), and a river level further
    # from the last good one than the river could have moved is a spike
    # (integration_pipeline.river_spike). From history BEFORE this entry;
    # faulty fields are None there and skipped.
    # The window is at least ANOMALY_BASELINE_MAX_AGE_MIN, longer for a
    # node that reports less often (baseline_max_age), so a slow node still
    # collects ANOMALY_BASELINE_MIN_SAMPLES readings in it.
    baseline_start = now - baseline_max_age(raw.node_id)
    baseline_entries = [e for e in history if baseline_start <= e["timestamp"] < now][-ANOMALY_BASELINE_WINDOW:]
    anomaly_ref = anomaly_baseline(baseline_entries)
    good_levels = sorted((e for e in baseline_entries if e.get("raw_water_level_m") is not None),
                         key=lambda e: e["timestamp"])
    last_good = good_levels[-1] if good_levels else None

    def hours_before_now(e):
        return (now - e["timestamp"]).total_seconds() / 3600

    held_before = []
    for e in reversed(history):  # the run of held spikes just before this reading
        if e.get("river_spike_m") is None:
            break
        held_before.insert(0, (hours_before_now(e), e["river_spike_m"]))
    is_river_spike = has_water and converted_value is not None and river_spike(
        converted_value,
        last_good["raw_water_level_m"] if last_good else None,
        hours_before_now(last_good) if last_good else 0.0,
        len(good_levels) >= ANOMALY_BASELINE_MIN_SAMPLES,
        RIVER_SPIKE_MAX_RATE_M_PER_HR,
        corroborated=(
            max(rainfall_intensity_mm_hr, reading_rain_mm_hr) >= FLOOD_SIGNATURE_RAIN_MM_HR
            or upstream_rate_m_per_hr >= FLOOD_SIGNATURE_RATE_M_PER_HR
            or bool(raw.fast_rise)
        ),
        held_before=held_before,
        prev_good=(
            (hours_before_now(good_levels[-2]), good_levels[-2]["raw_water_level_m"])
            if len(good_levels) >= 2 else None
        ),
    )

    # Cloud-side weather enrichment - forecasted rain not yet reflected in
    # any sensor reading. None if the weather API is unreachable; the
    # pipeline must not depend on this to function.
    # The same fetch gives the next 24 h of rain and wind for the
    # extreme-weather hazards (heavy_rain / high_wind).
    # simulated: the SANJEEVNI_WEATHER_MOCK test file applies to simulated
    # readings only - a real reading never sees it (WEATHER_MOCK_ENV).
    weather = fetch_weather_forecast(
        config["latitude"], config["longitude"], raw.node_id,
        simulated=bool(raw.simulated),
    ) or {}
    forecast_rainfall_6h_mm = weather.get("rain_6h_mm")

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
        "rainfall_windows_mm": rainfall_windows_mm,
        "rainfall_windows_count": rainfall_windows_count,
        "forecast_rainfall_6h_mm": forecast_rainfall_6h_mm,
        "forecast_rainfall_24h_mm": weather.get("rain_24h_mm"),
        "forecast_wind_speed_max_kmh": weather.get("wind_speed_max_kmh"),
        "forecast_wind_gust_max_kmh": weather.get("wind_gust_max_kmh"),
        "forecast_source": weather.get("source"),
        # IMD heat-wave criteria per region (hazard_classification.
        # classify_extreme_heat). Not registry columns yet: None = the
        # SANJEEVNI_HEAT_REGION default ("plains") and no departure check.
        "heat_region": config.get("heat_region"),
        "normal_max_temp_c": config.get("normal_max_temp_c"),
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
        # Per-node landslide rain threshold override (None = Caine 1980).
        "landslide_rain_alpha": config.get("landslide_rain_alpha"),
        "landslide_rain_beta": config.get("landslide_rain_beta"),
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
        # The node's own fast-rise check (flash flood). Its rate is clamped
        # like the backend's, so one corrupted number cannot claim a rise
        # faster than any river (see MAX_RIVER_RATE_M_PER_HR).
        "fast_rise": raw.fast_rise if has_water else False,
        "rise_rate_cm_per_min": raw.rise_rate_cm_per_min,
        "node_rise_rate_m_per_hr": (
            clamp_river_rate(raw.rise_rate_cm_per_min * CM_PER_MIN_TO_M_PER_HR)
            if has_water and raw.rise_rate_cm_per_min is not None else None
        ),
        "edge_anomaly": raw.edge_anomaly,
        # Sets the node's expected report interval (node health).
        "siren_fitted": raw.siren_fitted,
    }

    # A value no working sensor can produce (see PHYSICAL_LIMITS) is kept
    # out of history as None - the same gap a missing sensor leaves - so
    # one 14 m spike can't skew the next 15 minutes of rise rates, the
    # median smoothing, an upstream neighbour's features or drift checks.
    # fault_fields = out of range, or part of a dropout frame (step B1).
    faulty = set(fault_fields(enriched))
    if converted_value is not None and implausible_fields({"river_level_m": converted_value}):
        faulty.add("raw_water_level_m")
    if rain_fault:
        # Like a PHYSICAL_LIMITS fault: None in history (so the river
        # forecast does not train on it) and listed for process_reading,
        # which puts it in result["sensor_faults"] and drops the raw value
        # from a live row. A wholly suppressed row keeps the raw value, as
        # other faulty fields do, to help label anomalies.
        faulty.add("rainfall_mm_since_last")
        enriched["sensor_faults"] = ["rainfall_mm_since_last"]
    if is_river_spike:
        # Same treatment: None in history (so it skews no rate, median or
        # neighbour), listed for process_reading (which drops the level and
        # everything derived from it). river_spike_m keeps the value, so a
        # level that STAYS there is accepted (RIVER_SPIKE_ACCEPT_AFTER).
        faulty.update(("river_level_m", "raw_water_level_m"))
        enriched["sensor_faults"] = [*(enriched.get("sensor_faults") or ()), "river_level_m"]
        enriched["river_spike"] = True
    entry = {
        "timestamp": now,
        "river_level_m": water_level_m,
        "raw_water_level_m": converted_value,  # unsmoothed - see smooth_water_level()
        "rainfall_mm_since_last": raw.rainfall_mm_since_last,
        "soil_saturation": soil_saturation,
        "gas_ppm": raw.gas_ppm,
        "temp_c": raw.temp_c,
        "humidity_pct": raw.humidity_pct,
        "pm25_ugm3": raw.pm25_ugm3,  # for the smoke trend
        # Lets a neighbour tell simulator data from real data - see
        # upstream_history_for().
        "simulated": raw.simulated,
    }
    for field in faulty:
        if field in entry:
            entry[field] = None
    if is_river_spike:
        entry["river_spike_m"] = converted_value

    # Short-window trends for the smoke check (hazard_classification.
    # short_window_trend), from history BEFORE this entry is added. A
    # field that is faulty now has no trend; its past None gaps are skipped.
    # history is in ARRIVAL order, and a node sends elevated / fast-rise
    # readings before its older backlog (round item E), so it is sorted by
    # time here: short_window_trend takes the last values as "recent" and
    # the rest as the baseline.
    trend_start = now - timedelta(minutes=SHORT_TREND_WINDOW_MINUTES)
    in_window = sorted(
        (e for e in history if trend_start <= e["timestamp"] <= now), key=lambda e: e["timestamp"]
    )
    # The summary's min / mean describe the node's report window. Only one
    # that fits inside the short window is evidence of a FAST rise: a
    # summary over an hour (a long report interval, or the first report
    # after an outage) would turn a slow build-up into "smoke".
    window_s = raw.summary.window_s if raw.summary else None
    use_summary = window_s is not None and 0 < window_s <= SHORT_TREND_WINDOW_MINUTES * 60
    short_trends = {}
    for field in SHORT_TREND_FIELDS:
        if field in faulty:
            continue
        trend = short_window_trend(
            [e.get(field) for e in in_window],
            getattr(raw, field),
            raw.summary.stats(field) if use_summary else None,
        )
        if trend is not None:
            short_trends[field] = trend
    enriched["short_trends"] = short_trends

    enriched["anomaly_baseline"] = anomaly_ref  # see river_spike above

    history.append(entry)

    return enriched


def upstream_history_for(upstream_node: Optional[str], simulated: bool, now: datetime) -> list:
    """The upstream node's history entries that may feed THIS reading:
    same simulated flag, taken in the last UPSTREAM_MAX_AGE window, not
    after `now`. Empty means "no upstream evidence", and derive_features
    then falls back to the node's own level and a 0.0 upstream rate.

    - Simulated history never feeds a real node: in the mixed demo
      (`simulation.js --skip NODE-04`) a scripted upstream flood used to
      boost the REAL node's flood risk and count as flood-signature
      corroboration.
    - Stale history is no evidence: a washed-away or flat-battery upstream
      node used to keep its last rise rate (e.g. 0.6 m/hr) for days,
      boosting every downstream reading."""
    if not upstream_node or not node_history.get(upstream_node):
        return []
    cfg = NODE_REGISTRY.get(upstream_node) or {}
    # A slow (deep-sleep) upstream node reports every few minutes; allow a
    # few of its intervals, but never less than the rate window itself.
    max_age = timedelta(seconds=max(
        RATE_WINDOW_MINUTES * 60,
        UPSTREAM_MAX_MISSED_REPORTS * (cfg.get("report_interval_seconds") or 0),
    ))
    return [
        e for e in node_history[upstream_node]
        if bool(e.get("simulated")) == bool(simulated) and now - max_age <= e["timestamp"] <= now
    ]


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


def is_duplicate_reading(node_id: str, reading_uid: Optional[str],
                         conn: Optional[sqlite3.Connection] = None) -> bool:
    if not reading_uid:
        return False
    with _ingest_db(conn) as db:
        row = db.execute(
            "SELECT 1 FROM readings WHERE node_id=? AND reading_uid=?", (node_id, reading_uid)
        ).fetchone()
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
        health["siren_fitted"] = raw.siren_fitted
    remember_report_interval(health, node_history.get(raw.node_id, ()), received_at)


# How long the node's normal (slow) reporting interval is remembered while
# it reports faster. Longer than any single hazard episode is likely to
# last; an admin can always pin report_interval_seconds instead.
REPORT_INTERVAL_MEMORY_HOURS = 24
# A new estimate this close to the remembered one replaces it (ordinary
# jitter, or a genuinely re-tuned node); a much faster one is an elevated
# burst and does not.
REPORT_INTERVAL_SHRINK_TOLERANCE = 0.75


def remember_report_interval(health: dict, history, now: datetime):
    """Keeps node_health["observed_interval_seconds"] at the node's NORMAL
    reporting interval. A percentile of recent gaps alone is not enough:
    after a hazard the last 11 readings can all be 5 s apart, and the
    node that had just reported the hazard was then flagged "offline"
    60 s later, when its normal 60 s report was simply on its way. So a
    much faster estimate does not overwrite the remembered interval until
    REPORT_INTERVAL_MEMORY_HOURS have passed without confirming it."""
    estimate = expected_gap_seconds([r["timestamp"] for r in list(history)[-REPORT_GAP_SAMPLE:]])
    if estimate is None:
        return
    previous = health.get("observed_interval_seconds")
    previous_at = health.get("observed_interval_at")
    expired = previous_at is None or now - parse_timestamp(previous_at) > timedelta(
        hours=REPORT_INTERVAL_MEMORY_HOURS
    )
    if previous is None or expired or estimate >= REPORT_INTERVAL_SHRINK_TOLERANCE * previous:
        health["observed_interval_seconds"] = estimate
        health["observed_interval_at"] = now.isoformat()


# Readings are processed one at a time. FastAPI runs these sync endpoints
# on a thread pool, so two requests (e.g. a node retry and the gateway's
# copy of the same reading) could both pass the duplicate check and both
# update the in-memory rain log / history / confirmation state before one
# of them failed on the unique index - double-counting it (review R22).
# At ~1 reading/s per backend this costs nothing.
_ingest_lock = threading.Lock()


def process_raw_reading(raw: RawReading, received_at: datetime, time_known: bool = True) -> dict:
    with _ingest_lock:
        try:
            db = ingest_connection()
            if not time_known:
                return store_untimed_reading(raw, received_at, db)
            return _process_raw_reading(raw, received_at, db)
        except sqlite3.Error:
            # (a duplicate's IntegrityError never gets here) - a fresh
            # connection for the next reading, whatever state this one is in
            close_ingest_connection()
            raise


def store_untimed_reading(raw: RawReading, received_at: datetime,
                          conn: Optional[sqlite3.Connection] = None) -> dict:
    """A queued reading whose age is unknown (its node or gateway rebooted
    while it waited). Stamping it "now" would pile hours of backlog rain
    into the same instant - inflating rainfall intensity and possibly
    producing a false flood alert (review R6). So it is STORED for the
    record but kept out of rates, rainfall totals, alerts and confirmation."""
    if raw.node_id not in NODE_REGISTRY:
        raise HTTPException(status_code=400, detail=f"Unknown node_id '{raw.node_id}'")
    if is_duplicate_reading(raw.node_id, raw.reading_uid, conn):
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}
    node_health.setdefault(raw.node_id, {})["last_seen"] = received_at.isoformat()  # we did hear from it
    try:
        with _ingest_db(conn) as db:
            _insert_reading(
                db,
                """INSERT INTO readings (node_id, location, river_level_m, temp_c, humidity_pct, gas_ppm,
                       flame_reading, status, timestamp, reading_uid, simulated, link, battery_pct,
                       signal_strength_dbm)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (raw.node_id, NODE_REGISTRY[raw.node_id]["location"], raw.river_level_m, raw.temp_c,
                 raw.humidity_pct, raw.gas_ppm, raw.flame_reading, "untimed", received_at.isoformat(),
                 raw.reading_uid, 1 if raw.simulated else 0, raw.link, raw.battery_pct, raw.signal_strength_dbm),
            )
    except sqlite3.IntegrityError:
        return {"status": "duplicate", "node_id": raw.node_id, "reading_uid": raw.reading_uid}
    return {"status": "untimed", "node_id": raw.node_id, "reading_uid": raw.reading_uid}


def _process_raw_reading(raw: RawReading, received_at: datetime,
                         conn: Optional[sqlite3.Connection] = None) -> dict:
    """Shared by /api/ingest and /api/ingest/batch."""
    if is_duplicate_reading(raw.node_id, raw.reading_uid, conn):
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
    # A reading that still alerted on another sensor was classified
    # WITHOUT its faulty fields; store and report it the same way, so a
    # 14 m spike never lands in the readings table as a measurement on a
    # live row (charts, forecast and the CSV export read those columns).
    # The fault is kept in the sensor_faults column. A wholly suppressed
    # reading keeps its raw values as before - status 'suppressed' already
    # keeps it out of everything, and the raw value helps label anomalies.
    if result["status"] != "suppressed":
        for field in result.get("sensor_faults", ()):
            enriched[field] = None
            for derived in DERIVED_FROM.get(field, ()):
                enriched[derived] = None
    result["timestamp"] = timestamp
    result["node_id"] = raw.node_id
    result["location"] = enriched["location"]
    result["latitude"] = NODE_REGISTRY[raw.node_id]["latitude"]
    result["longitude"] = NODE_REGISTRY[raw.node_id]["longitude"]
    result["river_level_m"] = enriched[
        "river_level_m"
    ]  # corrected water level, not the raw uninverted distance
    result["temp_c"] = enriched["temp_c"]
    result["humidity_pct"] = enriched["humidity_pct"]
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
        # simulated: simulator traffic must never corroborate a real alert
        # (it would go public and reach real WhatsApp subscribers).
        # sensor_stuck: a sensor this hazard reads that the node calls
        # frozen repeats by definition, so only a neighbour may confirm it
        # (a stuck gas sensor would otherwise "confirm" its own CRITICAL
        # and auto-sound the siren).
        confirmed, basis = _confirmer.assess(
            raw.node_id, result["hazard_type"], result["severity"], taken_at, NODE_REGISTRY,
            simulated=raw.simulated,
            sensor_stuck=bool(stuck_hazard_fields(result["hazard_type"], raw.edge_anomaly)),
            # Forecast-only heavy rain / high wind: confirmed by its
            # external source, never by node repeats (hazard_confirmation).
            forecast_only=bool(result.get("forecast_based")),
            forecast_source=result.get("forecast_source"),
        )
        result["confirmation"] = basis or "unconfirmed"
        if not confirmed:
            result["status"] = "pending_confirmation"

    # Confidence score (alert_confidence.py) - after the cross-check, since
    # confirmation is its biggest part. The three keys are always present
    # (None for a non-alert), so every result has the same shape.
    # A NORMAL-mode summary report's latest-sample verdict is
    # edge_risk_level; the window's worst is only weaker support for
    # firmware that sends just the summary block (alert_confidence.
    # EDGE_WINDOW_SUPPORT_SCORE) - never full agreement.
    confidence = compute_confidence(
        result,
        {"edge_risk_level": raw.edge_risk_level,
         "edge_risk_level_window_max": raw.summary.max_edge_risk_level if raw.summary else None,
         "edge_anomaly": raw.edge_anomaly,
         "delay_seconds": enriched["delay_seconds"]},
        _flood_calibration,
    )
    result.update(confidence)
    if result.get("message"):
        result["message"] = add_confidence_to_message(result["message"], confidence)
    result["delay_seconds"] = enriched["delay_seconds"]
    result["reading_uid"] = raw.reading_uid

    eta_minutes = None
    if result.get("hazard_type") == "flood":
        eta_minutes = estimate_eta_minutes(
            enriched["river_level_m"],
            enriched["river_level_rate_m_per_hr"],
            FLOOD_CRITICAL_LEVEL_M,
        )
    elif result.get("hazard_type") == "flash_flood":
        # The flash-flood rate is the faster of the backend's and the
        # node's own measurement (classify_flash_flood).
        eta_minutes = estimate_eta_minutes(
            enriched["river_level_m"],
            result["hazard_scores"]["flash_flood"]["rise_rate_m_per_hr"],
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
        save_reading(enriched, result, timestamp, conn)
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

    # Position stored with the reading first (where the node WAS); the
    # live registry only for rows saved before those columns existed. No
    # position at all (old row, node since deleted) is refused: a CAP area
    # at 0,0 - the old default - is a wrong public warning area, not a
    # harmless placeholder.
    latitude, longitude = row.get("latitude"), row.get("longitude")
    if latitude is None or longitude is None:
        config = NODE_REGISTRY.get(row["node_id"], {})
        latitude, longitude = config.get("latitude"), config.get("longitude")
    if latitude is None or longitude is None:
        raise HTTPException(
            status_code=409,
            detail=f"Alert {alert_id} has no known location (node '{row['node_id']}' is not registered)",
        )

    cap_xml = generate_cap_alert(
        hazard_type=row.get("hazard_type") or "flood",
        severity=row.get("severity") or "LOW",
        location=row.get("location") or row["node_id"],
        latitude=latitude,
        longitude=longitude,
        message=row.get("message") or "No alert message recorded for this reading.",
        node_id=row["node_id"],
        risk_score=row.get("risk_score") or 0.0,
        severity_source=row.get("severity_source") or "ml_model",
        # <certainty> from the stored confidence score; rows from before
        # it existed (NULL) keep the old per-source mapping.
        confidence=row.get("confidence"),
        confirmation=row.get("confirmation"),
        # Same reading -> same identifier and <sent> on every download, so
        # a polling CAP consumer does not re-publish it as a new alert.
        reading_id=row["id"],
        sent_at=parse_timestamp(row["timestamp"]) if row.get("timestamp") else None,
        # Simulator traffic must never reach a consumer as a real warning.
        status="Exercise" if row.get("simulated") else "Actual",
        # radius_m omitted: cap_alert picks the severity's zone, matching
        # server.js HAZARD_RADIUS_M (the map and WhatsApp reach).
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


def _analytics_conn():
    """Read-only connection for the analytics endpoints, so a slow 30-day
    query can never hold a write lock against /api/ingest."""
    # as_uri(): a Windows path ("D:\...") is not a valid SQLite URI as-is.
    return sqlite3.connect(Path(os.path.abspath(DB_PATH)).as_uri() + "?mode=ro", uri=True)


@app.get("/api/analytics/trends")
def get_analytics_trends(node_id: str, range: str = "24h", exclude_simulated: bool = False):
    """Long-term trend series for one node (analytics.compute_trends):
    24h in 15-min buckets, 7d in 2-h, 30d in 6-h; min/max/mean per sensor
    field plus the worst risk score and severity per bucket. Every response
    carries data_note - the data is simulated/synthetic in this prototype."""
    if range not in analytics.TREND_RANGES:
        raise HTTPException(status_code=400, detail=f"range must be one of {', '.join(analytics.TREND_RANGES)}")
    conn = _analytics_conn()
    try:
        if not analytics.node_known(conn, node_id, NODE_REGISTRY):
            raise HTTPException(status_code=404, detail=f"Unknown node_id '{node_id}'")
        return analytics.compute_trends(conn, node_id, range, datetime.now(timezone.utc), exclude_simulated)
    finally:
        conn.close()


@app.get("/api/analytics/summary")
def get_analytics_summary(range: str = "7d", exclude_simulated: bool = False):
    """Network summary (analytics.compute_summary): alerts per hazard and
    node, CPCB / IMD exceedance hours, top hotspots and per-node uptime."""
    if range not in analytics.SUMMARY_RANGES:
        raise HTTPException(status_code=400, detail=f"range must be one of {', '.join(analytics.SUMMARY_RANGES)}")
    conn = _analytics_conn()
    try:
        return analytics.compute_summary(conn, range, dict(NODE_REGISTRY), datetime.now(timezone.utc), exclude_simulated)
    finally:
        conn.close()


@app.get("/api/cap/feed.atom")
def get_cap_atom_feed():
    """Atom 1.0 feed of the currently active CONFIRMED alerts, one entry
    per alert linking to its CAP 1.2 XML at /cap/alerts/{id}.xml (the
    public path server.js serves). Links are relative unless
    SANJEEVNI_PUBLIC_BASE_URL is set."""
    now = datetime.now(timezone.utc)
    conn = _analytics_conn()
    try:
        alerts = analytics.active_confirmed_alerts(conn, dict(NODE_REGISTRY), now)
    finally:
        conn.close()
    return Response(content=analytics.build_atom_feed(alerts, now), media_type=analytics.ATOM_MEDIA_TYPE)


@app.get("/api/nodes")
def get_nodes():
    out = []
    # Snapshot: an admin edit can reload the registry during this loop.
    for node_id, config in list(NODE_REGISTRY.items()):
        # .get: second guard against a node visible before its history
        # entry exists (reload_node_registry creates history first).
        history = node_history.get(node_id, ())
        last = history[-1] if history else None
        health = node_health.get(node_id, {})
        out.append(
            {
                "node_id": node_id,
                "location": config["location"],
                "land_use": config["land_use"],
                "latitude": config["latitude"],
                "longitude": config["longitude"],
                "last_river_level_m": last["river_level_m"] if last else None,
                "reading_count": len(history),
                "last_seen": health.get("last_seen"),
                "battery_pct": health.get("battery_pct"),
                "signal_strength_dbm": health.get("signal_strength_dbm"),
            }
        )
    return out


# --- Node health / missing-node alerts ----------------------------------
# The node's NORMAL-time report interval, before anything has been learned
# from its own readings. User decision (1), 2026-10-09: a node WITHOUT a
# siren sends its normal-time summary every 5 min, a node with a siren
# (it says siren_fitted: true in every reading) every 1 min; WATCH /
# URGENT, a fast rise, a new anomaly and SOS are sent at once on top.
# It used to be 5 s for every node, so a new 5-min node was shown
# "offline" 60 s after its first report until 3 report gaps had been seen.
SIREN_NODE_REPORT_INTERVAL_SECONDS = 60
NODE_REPORT_INTERVAL_SECONDS = 300
DEFAULT_REPORT_INTERVAL_SECONDS = NODE_REPORT_INTERVAL_SECONDS  # a node not heard from yet


def nominal_report_interval(health: dict) -> int:
    """Decision (1): 60 s for a node that reports siren_fitted, else 300 s."""
    if health.get("siren_fitted"):
        return SIREN_NODE_REPORT_INTERVAL_SECONDS
    return NODE_REPORT_INTERVAL_SECONDS

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


REPORT_GAP_PERCENTILE = 0.9
REPORT_GAP_SAMPLE = 11  # most recent readings (10 gaps) used for a live estimate


def expected_gap_seconds(timestamps: list) -> Optional[float]:
    """The node's NORMAL reporting interval, from at least 3 gaps: a high
    percentile (the slow end), not the median. Nodes report every 5 s (30 s
    on deep sleep) while a hazard is elevated and every 60 s (300 s)
    otherwise; after an elevated burst the median was the burst cadence,
    so the node that had just reported the hazard was flagged "offline -
    check power/link or theft" for minutes. With 10 gaps the 90th
    percentile is the second-largest, so one long outage gap is ignored
    but the normal heartbeat is kept."""
    gaps = sorted(g for g in ((b - a).total_seconds() for a, b in zip(timestamps, timestamps[1:])) if g > 0)
    if len(gaps) < 3:
        return None
    return gaps[int(REPORT_GAP_PERCENTILE * (len(gaps) - 1))]


def expected_report_interval_seconds(node_id: str, cfg: Optional[dict] = None,
                                     health: Optional[dict] = None) -> float:
    """How often the node is expected to report: the configured value, else
    the slower of what it has actually been doing and its nominal interval.
    Shared by node health (offline detection) and the anomaly baseline
    window (baseline_max_age)."""
    cfg = NODE_REGISTRY.get(node_id, {}) if cfg is None else cfg
    health = node_health.get(node_id, {}) if health is None else health
    # Expected cadence: the configured value, else what the node has
    # actually been doing. A LoRa node that heartbeats every 60 s used to
    # be judged against the 5 s default and flagged "missing" all the
    # time unless someone configured it by hand (review R19).
    # The slower of the live estimate and the remembered normal interval
    # (remember_report_interval), so an elevated burst can't shrink it.
    recent = [r["timestamp"] for r in list(node_history.get(node_id, ()))[-REPORT_GAP_SAMPLE:]]
    estimates = [v for v in (expected_gap_seconds(recent), health.get("observed_interval_seconds")) if v]
    observed = max(estimates) if estimates else None
    # Never shorter than the node's nominal interval (decision (1)): a
    # node that sent a burst of urgent readings, or old always-on
    # firmware, must not make a 5-min node look "offline" between its
    # summaries. A slower observed cadence (deep sleep) still wins.
    return cfg.get("report_interval_seconds") or max(nominal_report_interval(health), observed or 0)


def baseline_max_age(node_id: str) -> timedelta:
    """How far back the anomaly baseline / river-spike window reaches for
    this node: ANOMALY_BASELINE_MAX_AGE_MIN, or long enough for
    ANOMALY_BASELINE_MIN_SAMPLES + 1 of the node's expected reports if that
    is longer. A node reporting every 20 min or more never had 3 readings in
    60 min, so its anomaly flags were never checked against its own
    readings (review 2026-10-09)."""
    interval = expected_report_interval_seconds(node_id)
    return max(timedelta(minutes=ANOMALY_BASELINE_MAX_AGE_MIN),
               timedelta(seconds=(ANOMALY_BASELINE_MIN_SAMPLES + 1) * interval))


def observed_interval_from_db(conn, node_id: str) -> Optional[float]:
    # 'untimed' backlog rows carry their ARRIVAL time, not when they were
    # taken, so they say nothing about the node's reporting cadence. A
    # longer sample than the live estimate (HISTORY_WINDOW + 1), so a
    # restart right after a hazard burst still sees the normal interval.
    rows = conn.execute(
        "SELECT timestamp FROM readings WHERE node_id=? AND timestamp IS NOT NULL "
        "AND status IS NOT 'untimed' ORDER BY id DESC LIMIT ?",
        (node_id, HISTORY_WINDOW + 1),
    ).fetchall()
    return expected_gap_seconds(sorted(parse_timestamp(r[0]) for r in rows))


def seed_node_health_from_db():
    """node_health is in-memory, so after a restart every node looked like
    it had never reported. Restore last-seen + telemetry from each node's
    most recent stored reading."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("""
        SELECT r.node_id, r.timestamp, r.battery_pct, r.signal_strength_dbm, r.link, r.siren_fitted
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
                    "siren_fitted": bool(row["siren_fitted"]),
                    "observed_interval_seconds": observed_interval_from_db(conn, row["node_id"]),
                    "observed_interval_at": datetime.now(timezone.utc).isoformat(),
                }
            )
    conn.close()


def seed_node_history_from_db(now: Optional[datetime] = None):
    """node_history is in-memory, so after a restart every node's first
    ANOMALY_BASELINE_MIN_SAMPLES readings had no baseline: at a site the
    Isolation Forest does not know (a hot dry summer) they were suppressed
    as sensor faults, and the river-spike guard was off (review 2026-10-09).
    Restores each node's stored readings from its baseline window
    (baseline_max_age, before `now`), at most HISTORY_WINDOW, in arrival
    order, the way derive_features would have kept them: every field the
    row lists in sensor_faults is None (a suppressed row keeps its raw
    values in the table), and a reading suppressed only by the forest's
    flag keeps its values, as it does in live history. Skipped: untimed
    rows (their time is the arrival time) and a node that already has live
    history.
    Approximations: the database keeps the corrected, SMOOTHED level, not
    the raw one, so it stands in for raw_water_level_m (a simulated
    reading is never smoothed, so there they are equal); a river level
    held as a spike is restored as a gap, not as part of a held run. The
    24 h rain log is not restored (rain totals still restart from 0)."""
    now = now or datetime.now(timezone.utc)
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        for node_id in list(NODE_REGISTRY):
            if node_history.get(node_id):
                continue
            since = now - baseline_max_age(node_id)
            rows = conn.execute(
                "SELECT timestamp, river_level_m, rainfall_mm_since_last, soil_saturation, gas_ppm, "
                "temp_c, humidity_pct, pm25_ugm3, simulated, sensor_faults FROM readings "
                "WHERE node_id=? AND timestamp IS NOT NULL AND status IS NOT 'untimed' "
                "ORDER BY id DESC LIMIT ?",
                (node_id, HISTORY_WINDOW),
            ).fetchall()
            entries = []
            for row in reversed(rows):
                at = parse_timestamp(row["timestamp"])
                if not since <= at <= now:
                    continue
                faults = set(filter(None, (row["sensor_faults"] or "").split(",")))
                entry = {
                    "timestamp": at,
                    "river_level_m": row["river_level_m"],
                    "raw_water_level_m": row["river_level_m"],
                    "rainfall_mm_since_last": row["rainfall_mm_since_last"],
                    "soil_saturation": row["soil_saturation"],
                    "gas_ppm": row["gas_ppm"],
                    "temp_c": row["temp_c"],
                    "humidity_pct": row["humidity_pct"],
                    "pm25_ugm3": row["pm25_ugm3"],
                    "simulated": bool(row["simulated"]),
                }
                if "river_level_m" in faults:
                    faults.add("raw_water_level_m")
                for field in faults:
                    if field in entry:
                        entry[field] = None
                entries.append(entry)
            history = node_history.setdefault(node_id, deque(maxlen=HISTORY_WINDOW))
            history.extend(entries)
    finally:
        conn.close()


def compute_node_health(now: Optional[datetime] = None) -> list[dict]:
    """Per-node status (online / offline / never_seen) plus maintenance
    issues, worst first. A node is offline after missing
    MISSED_REPORTS_BEFORE_OFFLINE of its expected reports - a dead node
    otherwise looks exactly like a calm one on the hazard map."""
    now = now or datetime.now(timezone.utc)
    out = []
    for node_id, cfg in list(NODE_REGISTRY.items()):  # snapshot - see reload_node_registry()
        health = node_health.get(node_id, {})
        interval = expected_report_interval_seconds(node_id, cfg, health)  # (decision (1))
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
           WHERE node_id=? AND status NOT IN ('suppressed', 'untimed') AND river_level_m IS NOT NULL
           ORDER BY id DESC LIMIT 3000""",
        # Sensor faults are excluded, and so are 'untimed' backlog rows:
        # they are stamped with their ARRIVAL time (R6), so an hours-old
        # level would land in the newest step and become the "Now" level
        # the forecast starts from.
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
           WHERE node_id=? AND hazard_type IN ('flood','flash_flood')
             AND status IN ('alert_dispatched','pending_confirmation')
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

    location: str = Field(min_length=1, max_length=100)
    # The flood model only knows these four (train_models.LAND_USE_CATEGORIES);
    # any other value silently fell out of its one-hot features.
    land_use: Literal["agricultural", "forest", "urban_low", "urban_high"]
    # SCS-CN curve numbers lie between ~30 (dense forest) and 100 (water/paved)
    curve_number: float = Field(ge=30, le=100)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    upstream_node: Optional[str] = None
    # Expected seconds between reports; None = 60 s for a node that reports
    # siren_fitted, 300 s otherwise, or the slower cadence the node is
    # observed to keep (nominal_report_interval). Set it for a deep-sleep
    # node with a longer wake interval so it isn't flagged missing.
    report_interval_seconds: Optional[float] = Field(default=None, gt=0, le=24 * 3600)
    # Landslide rainfall threshold I = alpha * D^-beta (mm/h, hours) from a
    # regional study, in place of the global Caine (1980) 14.82 / 0.39.
    # None = the global default. The bounds only reject typos: published
    # I-D thresholds have alpha of a few to a few tens of mm/h and beta
    # between 0 and 1.
    landslide_rain_alpha: Optional[float] = Field(default=None, gt=0, le=200)
    landslide_rain_beta: Optional[float] = Field(default=None, ge=0, le=2)


LANDSLIDE_OVERRIDE_FIELDS = ("landslide_rain_alpha", "landslide_rain_beta")


def landslide_override_values(cfg: NodeConfig, existing: Optional[dict]) -> tuple:
    """(alpha, beta) to store. A field left OUT of the request keeps the
    node's current value: the admin page predates these fields, and a
    plain location edit from it must not silently wipe a calibrated
    threshold. Sending null explicitly clears it."""
    return tuple(
        getattr(cfg, field) if field in cfg.model_fields_set or existing is None
        else existing.get(field)
        for field in LANDSLIDE_OVERRIDE_FIELDS
    )


# LoRa packets carry the node id in 12 bytes (SJ_NODE_ID_LEN in sj_packet.h):
# a longer id would arrive cut short and be rejected as an unknown node.
NODE_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$")


def check_node_id(node_id: str):
    if not NODE_ID_PATTERN.match(node_id):
        raise HTTPException(
            status_code=400,
            detail="Node ID must be 1-12 characters: letters, digits, - or _ (LoRa packets hold 12)",
        )


def upstream_problem(node_id: str, upstream: Optional[str]) -> Optional[str]:
    """Why `upstream` can't be node_id's upstream node, or None if it can."""
    if not upstream:
        return None
    if upstream == node_id:
        return "A node cannot be its own upstream node"
    if upstream not in NODE_REGISTRY:
        return f"Upstream node '{upstream}' does not exist"
    seen = {node_id}
    current = upstream
    while current:  # walk up the chain: a loop would never end in the river
        if current in seen:
            return f"Upstream node '{upstream}' would create a loop back to '{node_id}'"
        seen.add(current)
        current = (NODE_REGISTRY.get(current) or {}).get("upstream_node")
    return None


@app.get("/api/admin/nodes")
def admin_list_nodes(auth=Depends(require_admin_auth)):
    return dict(NODE_REGISTRY)  # snapshot - serialised after we return, while a reload may run


@app.post("/api/admin/nodes/{node_id}")
def admin_create_node(node_id: str, cfg: NodeConfig, auth=Depends(require_admin_auth)):
    check_node_id(node_id)
    if node_id in NODE_REGISTRY:
        raise HTTPException(
            status_code=409,
            detail=f"Node '{node_id}' already exists - use PUT to update it",
        )
    problem = upstream_problem(node_id, cfg.upstream_node)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "INSERT INTO nodes (node_id, location, land_use, curve_number, latitude, longitude, upstream_node, "
        "report_interval_seconds, landslide_rain_alpha, landslide_rain_beta) VALUES (?,?,?,?,?,?,?,?,?,?)",
        (
            node_id,
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
            cfg.report_interval_seconds,
            *landslide_override_values(cfg, None),
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
    problem = upstream_problem(node_id, cfg.upstream_node)
    if problem:
        raise HTTPException(status_code=400, detail=problem)

    conn = sqlite3.connect(DB_PATH)
    conn.execute(
        "UPDATE nodes SET location=?, land_use=?, curve_number=?, latitude=?, longitude=?, upstream_node=?, "
        "report_interval_seconds=?, landslide_rain_alpha=?, landslide_rain_beta=? WHERE node_id=?",
        (
            cfg.location,
            cfg.land_use,
            cfg.curve_number,
            cfg.latitude,
            cfg.longitude,
            cfg.upstream_node,
            cfg.report_interval_seconds,
            *landslide_override_values(cfg, NODE_REGISTRY.get(node_id)),
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
        n for n, cfg in list(NODE_REGISTRY.items()) if cfg.get("upstream_node") == node_id
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


@app.get("/api/model-card")
def get_model_card(auth=Depends(require_admin_auth)):
    """Honest evaluation report for the four models (flood, anomaly
    filter, edge network, LSTM), written offline by ml/evaluate_models.py.
    Served as-is; the contract is validate_card() in that script.

    Admin-only like the node registry: it is an engineering report, and
    its numbers come from SYNTHETIC data - the page must show the card's
    own banner/provenance next to every figure, never the numbers alone.
    Read on every request (a few KB), so re-running the script needs no
    backend restart."""
    try:
        with open(MODEL_CARD_PATH, encoding="utf-8") as f:
            card = json.load(f)
    except FileNotFoundError:
        raise HTTPException(
            status_code=404,
            detail=r"No model card yet - run: venv\Scripts\python.exe ml\evaluate_models.py",
        )
    except (OSError, ValueError):
        # ValueError covers JSONDecodeError and bad UTF-8: a hand-edited or
        # truncated file is a server problem, not "not generated yet".
        raise HTTPException(
            status_code=500,
            detail=r"model_card.json is unreadable - re-run ml\evaluate_models.py",
        )
    if not isinstance(card, dict) or "models" not in card:
        raise HTTPException(
            status_code=500,
            detail=r"model_card.json is not a model card - re-run ml\evaluate_models.py",
        )
    return card


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
