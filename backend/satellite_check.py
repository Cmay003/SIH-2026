"""
SANJEEVNI - Sentinel-1 radar flood cross-check (PPT slide 3).

Asks the Copernicus Data Space Ecosystem (CDSE) Statistical API what share
of a ~2 km box around a node looks like open water in Sentinel-1 radar,
for the most recent satellite pass vs a reference period 30-120 days
earlier. A clear increase is independent evidence of flooding at the node.

What it is and isn't:
  - Sentinel-1 revisits a location only every ~6-12 days, so this is an
    after-the-fact CORROBORATION layer for officers, not a real-time
    trigger. It never raises or lowers alerts by itself.
  - Water detection uses a fixed VV backscatter threshold (WATER_DB_
    THRESHOLD, a common rule of thumb). Wet soil, radar shadow in hilly
    terrain, and dense urban areas can fool it; compare with the optical
    view / GFM product before acting.
  - Monsoon reference periods may already be wet, which hides change.

Setup: create a free account at dataspace.copernicus.eu, then in the
Sentinel Hub dashboard create an OAuth client and put its id/secret in
.env as CDSE_CLIENT_ID / CDSE_CLIENT_SECRET.
"""

import math
import os
import statistics
import time
from datetime import datetime, timedelta, timezone

import requests

TOKEN_URL = "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token"
STATISTICS_URL = "https://sh.dataspace.copernicus.eu/api/v1/statistics"

BOX_HALF_SIZE_KM = 1.0
RECENT_DAYS = 12  # look for a pass this recent
REFERENCE_FROM_DAYS, REFERENCE_TO_DAYS = 120, 30  # reference period: 120..30 days ago
WATER_DB_THRESHOLD = -18.0  # VV sigma0 below this (dB) counts as open water
FLOOD_SIGNAL_INCREASE = 0.10  # +10 percentage points of the box newly water
RESOLUTION_DEG = 0.0001  # ~11 m pixels
CACHE_SECONDS = 6 * 3600
REQUEST_TIMEOUT_SECONDS = 30

EVALSCRIPT = f"""//VERSION=3
function setup() {{
  return {{
    input: [{{ bands: ["VV", "dataMask"] }}],
    output: [
      {{ id: "water", bands: 1, sampleType: "FLOAT32" }},
      {{ id: "dataMask", bands: 1 }}
    ]
  }};
}}
function evaluatePixel(s) {{
  var db = 10 * Math.log(s.VV) / Math.LN10;
  return {{ water: [db < {WATER_DB_THRESHOLD} ? 1 : 0], dataMask: [s.dataMask] }};
}}
"""

_token = {"value": None, "expires_at": 0.0}
_cache: dict[str, tuple[float, dict]] = {}


def is_configured() -> bool:
    return bool(os.environ.get("CDSE_CLIENT_ID") and os.environ.get("CDSE_CLIENT_SECRET"))


def _get_token() -> str:
    if _token["value"] and time.time() < _token["expires_at"] - 60:
        return _token["value"]
    response = requests.post(
        TOKEN_URL,
        data={
            "grant_type": "client_credentials",
            "client_id": os.environ["CDSE_CLIENT_ID"],
            "client_secret": os.environ["CDSE_CLIENT_SECRET"],
        },
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    payload = response.json()
    _token["value"] = payload["access_token"]
    _token["expires_at"] = time.time() + payload.get("expires_in", 600)
    return _token["value"]


def bbox_around(lat: float, lon: float, half_size_km: float = BOX_HALF_SIZE_KM) -> list[float]:
    d_lat = half_size_km / 111.32
    d_lon = half_size_km / (111.32 * math.cos(math.radians(lat)))
    return [lon - d_lon, lat - d_lat, lon + d_lon, lat + d_lat]


def build_statistics_request(bbox: list[float], start: datetime, end: datetime) -> dict:
    return {
        "input": {
            "bounds": {"bbox": bbox, "properties": {"crs": "http://www.opengis.net/def/crs/OGC/1.3/CRS84"}},
            "data": [{
                "type": "sentinel-1-grd",
                "dataFilter": {"acquisitionMode": "IW", "polarization": "DV", "resolution": "HIGH"},
                "processing": {"backCoeff": "SIGMA0_ELLIPSOID", "orthorectify": True},
            }],
        },
        "aggregation": {
            "timeRange": {"from": start.strftime("%Y-%m-%dT%H:%M:%SZ"), "to": end.strftime("%Y-%m-%dT%H:%M:%SZ")},
            "aggregationInterval": {"of": "P1D"},
            "evalscript": EVALSCRIPT,
            "resx": RESOLUTION_DEG,
            "resy": RESOLUTION_DEG,
        },
        "calculations": {"default": {}},
    }


def parse_water_fractions(response_json: dict) -> list[tuple[str, float]]:
    """[(date 'YYYY-MM-DD', water fraction 0-1), ...] for days that had a
    satellite pass with valid pixels; days without data are skipped."""
    out = []
    for item in response_json.get("data", []):
        stats = (item.get("outputs", {}).get("water", {}).get("bands", {}).get("B0", {}).get("stats", {}))
        if not stats or stats.get("mean") is None:
            continue
        if stats.get("sampleCount", 0) <= stats.get("noDataCount", 0):
            continue
        if isinstance(stats["mean"], str):  # "NaN" for all-masked days
            continue
        out.append((item["interval"]["from"][:10], float(stats["mean"])))
    return sorted(out)


def _water_series(bbox, start, end) -> list[tuple[str, float]]:
    response = requests.post(
        STATISTICS_URL,
        json=build_statistics_request(bbox, start, end),
        headers={"Authorization": f"Bearer {_get_token()}"},
        timeout=REQUEST_TIMEOUT_SECONDS,
    )
    response.raise_for_status()
    return parse_water_fractions(response.json())


def interpret(recent: list[tuple[str, float]], reference: list[tuple[str, float]]) -> dict:
    """Pure decision logic (unit-tested separately from the API)."""
    if not recent:
        return {"status": "no_recent_pass",
                "message": f"No Sentinel-1 pass in the last {RECENT_DAYS} days - cannot check yet."}
    if not reference:
        return {"status": "no_reference",
                "message": "No reference passes 30-120 days ago to compare against."}
    latest_date, latest = recent[-1]
    baseline = statistics.median(v for _, v in reference)
    increase = latest - baseline
    flooded = increase >= FLOOD_SIGNAL_INCREASE
    return {
        "status": "flood_signal" if flooded else "no_flood_signal",
        "latest_pass_date": latest_date,
        "latest_water_fraction": round(latest, 3),
        "reference_water_fraction": round(baseline, 3),
        "reference_passes": len(reference),
        "increase": round(increase, 3),
        "message": (
            f"Radar on {latest_date} shows {increase * 100:+.0f} percentage points more open water than "
            f"the reference period - {'consistent with flooding' if flooded else 'no clear flood signal'}."
        ),
    }


def satellite_flood_check(node_id: str, lat: float, lon: float, now: datetime | None = None) -> dict:
    """Never raises - returns {"status": "unavailable", ...} on any problem."""
    if not is_configured():
        return {"status": "unavailable", "message": "CDSE_CLIENT_ID / CDSE_CLIENT_SECRET not set in .env"}
    cached = _cache.get(node_id)
    if cached and time.time() - cached[0] < CACHE_SECONDS:
        return cached[1]
    now = now or datetime.now(timezone.utc)
    bbox = bbox_around(lat, lon)
    try:
        recent = _water_series(bbox, now - timedelta(days=RECENT_DAYS), now)
        reference = _water_series(bbox, now - timedelta(days=REFERENCE_FROM_DAYS), now - timedelta(days=REFERENCE_TO_DAYS))
    except Exception as e:  # network down, bad credentials, API change...
        return {"status": "unavailable", "message": f"Copernicus request failed: {e}"}
    result = {**interpret(recent, reference), "bbox": [round(v, 5) for v in bbox],
              "water_threshold_db": WATER_DB_THRESHOLD}
    _cache[node_id] = (time.time(), result)
    return result
