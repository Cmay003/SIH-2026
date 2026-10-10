"""
SANJEEVNI - long-term analytics and the public CAP Atom feed.

Backs three endpoints in backend_server.py:
  GET /api/analytics/trends?node_id=&range=24h|7d|30d   per-node time series
  GET /api/analytics/summary?range=7d|30d               hazards, hotspots,
                                                        exceedance hours, uptime
  GET /api/cap/feed.atom                                 active confirmed alerts

Everything is read from the backend's `readings` table (one row per
classified reading; an alert is a row whose status is 'alert_dispatched'
(confirmed) or 'pending_confirmation'). Functions take an open sqlite3
connection, the node registry and "now", so the tests can pin all three.

HONESTY NOTE: SANJEEVNI has not been field-deployed. Every row comes from
the demo simulator, bench rigs, or rows stored before the `simulated` flag
existed. Every analytics response therefore carries a `data_note` saying so;
the UI must show it next to any chart or number built from these endpoints.
"""

import math
import os
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional
from xml.etree import ElementTree as ET

from cap_alert import (
    CAP_VALIDITY_HOURS,
    HAZARD_TO_CAP,
    SEVERITY_TO_CAP,
    cap_identifier,
)
from hazard_classification import (
    PM10_BAND_TOPS,
    PM25_BAND_TOPS,
    classify_extreme_heat,
)

# range key -> (span seconds, bucket seconds). Fixed by the API contract:
# 24 h in 15-min buckets (96), 7 d in 2-h buckets (84), 30 d in 6-h (120).
TREND_RANGES = {
    "24h": (24 * 3600, 15 * 60),
    "7d": (7 * 24 * 3600, 2 * 3600),
    "30d": (30 * 24 * 3600, 6 * 3600),
}
SUMMARY_RANGES = ("7d", "30d")

# Sensor columns charted by /trends (min / max / mean per bucket).
TREND_FIELDS = (
    "river_level_m", "temp_c", "humidity_pct", "gas_ppm", "pm25_ugm3",
    "pm10_ugm3", "soil_moisture_pct", "tilt_angle_deg",
)

SEVERITY_ORDER = ("LOW", "MEDIUM", "HIGH", "CRITICAL")
_SEVERITY_RANK_SQL = (
    "CASE severity WHEN 'LOW' THEN 1 WHEN 'MEDIUM' THEN 2 "
    "WHEN 'HIGH' THEN 3 WHEN 'CRITICAL' THEN 4 END"
)

# Rows whose sensor values must not be charted or counted:
#  - 'suppressed': a reading rejected as a sensor fault keeps its RAW
#    (impossible) values in the table, see _process_raw_reading;
#  - 'untimed': a backlog reading with no known time - its timestamp is
#    when it was RECEIVED and river_level_m is the raw, uninverted distance.
# Both still prove the node was heard, so uptime counts them.
EXCLUDED_STATUSES = ("suppressed", "untimed")
_MEASURED_ROWS_SQL = "COALESCE(status, '') NOT IN ('suppressed', 'untimed')"
ALERT_STATUSES = ("alert_dispatched", "pending_confirmation")

# FORECAST-ONLY alerts (heavy_rain / high_wind whose severity comes from the
# weather forecast: severity_source "weather_forecast", confirmation basis
# "forecast" - hazard_classification / hazard_confirmation) are raised at
# EVERY quiet node in the forecast area on every reading. They say nothing
# about what a node measured, so hotspot scores, the per-node / per-hazard
# alert counts and the trend's risk_score_max / severity_max leave them
# out; they are reported separately (summary "forecast_alerts", trend
# "forecast_severity_max"). Review 2026-10-09: before, every node online
# during a regional forecast earned HIGH hotspot weight each hour.
_FORECAST_ROW_SQL = (
    "(COALESCE(severity_source, '') = 'weather_forecast' OR COALESCE(confirmation, '') = 'forecast')"
)
_MEASURED_ALERT_SQL = f"NOT {_FORECAST_ROW_SQL}"
TREND_SEVERITY_BASIS = (
    "risk_score_max / severity_max: rows assessed from this node's own sensors; forecast-only alerts "
    "(severity from the weather forecast) are in forecast_severity_max instead"
)
ALERTS_COUNT_BASIS = (
    "count = alert readings (confirmed + pending) assessed from the node's own sensors; confirmed = status "
    "alert_dispatched. Forecast-only alerts (severity from the weather forecast, raised at every node in the "
    "forecast area) are not counted here - see forecast_alerts"
)
FORECAST_ALERTS_BASIS = (
    "alert readings whose severity came from the weather forecast alone (severity_source weather_forecast); "
    "an area-wide forecast, not a node measurement - excluded from hotspots and the per-node counts"
)

# --- Exceedance hours ---------------------------------------------------
# CPCB National Air Quality Index breakpoints (24-hour average, ug/m3):
#   PM2.5 Poor 91-120, Very Poor 121-250, Severe 250+
#   PM10  Poor 251-350, Very Poor 351-430, Severe 430+
# Source: the CPCB NAQI table already cited in hazard_classification.py
# (cpcb.gov.in > National Air Quality Index > About NAQI, checked
# 2026-10-08); re-checked 2026-10-09 against the Government of India IES
# Arthapedia NAQI page (https://ies.gov.in/arthapedia/concept/national-air-quality-index),
# which lists the same Poor row (PM10 251-350, PM2.5 91-120).
# CPCB writes the ranges as integers, so "Poor or worse" is ABOVE the
# Moderately-polluted top (90 / 250), the same convention _pm_band uses.
PM25_POOR_ABOVE_UGM3 = 90.0
PM10_POOR_ABOVE_UGM3 = 250.0
PM25_SEVERE_ABOVE_UGM3 = float(PM25_BAND_TOPS[2])   # 250, Severe = 250+
PM10_SEVERE_ABOVE_UGM3 = float(PM10_BAND_TOPS[2])   # 430, Severe = 430+

EXCEEDANCE_BASIS = {
    "pm25_poor_or_worse": "node-hours whose 1-h mean PM2.5 was above 90 ug/m3 (CPCB NAQI Poor or worse)",
    "pm10_poor_or_worse": "node-hours whose 1-h mean PM10 was above 250 ug/m3 (CPCB NAQI Poor or worse)",
    "pm25_severe": "node-hours whose 1-h mean PM2.5 was above 250 ug/m3 (CPCB NAQI Severe)",
    "pm10_severe": "node-hours whose 1-h mean PM10 was above 430 ug/m3 (CPCB NAQI Severe)",
    "heat_wave": "node-hours whose 1-h maximum temperature met IMD's heat-wave or severe-heat-wave "
                 "criteria for the node's region (hazard_classification.classify_extreme_heat)",
    "severe_heat_wave": "node-hours whose 1-h maximum temperature met IMD's severe-heat-wave criteria",
}
EXCEEDANCE_NOTE = (
    "Indicative screen, not a compliance figure: CPCB defines its AQI bands on 24-hour averages "
    "and IMD defines heat waves on daily maximum temperatures declared over a region; these counts "
    "apply the same thresholds to one node's hourly values."
)

# --- Hotspots -----------------------------------------------------------
# ONE definition for the officer map and this summary (step B2,
# 2026-10-09). The map's heat layer is computed in server/server.js
# (aggregateHotspots / hotspotDayRows, "THE HOTSPOT DEFINITION"); before
# this step the summary ranked nodes by a different score (worst confirmed
# severity per clock-hour, weighted 1/2/4), so the map and the summary
# could name different hotspots. This is a copy of the server's rule:
#   per node over the last `days` UTC calendar days (7d -> 7, 30d -> 30;
#   the window starts at 00:00 UTC of the first day, like the map)
#   readings  = every stored reading except suppressed / untimed /
#               rejected / duplicate / error rows (simulated ones included
#               unless exclude_simulated)
#   elevated  = status 'alert_dispatched' (confirmed), severity HIGH or
#               CRITICAL, and NOT forecast-only (_FORECAST_ROW_SQL)
#   medium    = the same, at severity MEDIUM
#   intensity = min(1, (elevated + 0.5 * medium) / readings), shown
#               rounded to 3 decimals (half up, as JS Math.round)
#   level     = high >= 0.3, moderate >= 0.1, else low (on the unrounded
#               intensity, as the server)
#   order     = intensity, then elevated count, then node id
# The 0.1 / 0.3 edges are the project's demo choice (no official standard
# exists for this) - change them in server.js, here and in the frontend
# text (components/RiskLayers.tsx) together.
# The summary lists the top HOTSPOT_LIMIT nodes with intensity > 0 (a node
# with no confirmed MEDIUM+ alert is on the map as "low" but is not a
# hotspot to list). `score` = intensity, kept for the existing UI / CSV.
HOTSPOT_LEVEL_EDGES = {"moderate": 0.1, "high": 0.3}
HOTSPOT_LIMIT = 5
_NOT_A_READING_SQL = "COALESCE(status, '') IN ('suppressed', 'untimed', 'rejected', 'duplicate', 'error')"
# Word for word server.js HOTSPOT_DEFINITION + HOTSPOT_BASIS.
HOTSPOT_DEFINITION = (
    "A hotspot is a node where hazards keep coming back. Intensity = (confirmed HIGH or CRITICAL alert readings "
    "+ half the confirmed MEDIUM ones) / all readings the node sent in the window; High from 30 %, Moderate from 10 % "
    "(project thresholds, not an official standard)."
)
HOTSPOT_ELEVATED_BASIS = (
    "Elevated = a confirmed HIGH or CRITICAL alert from the node's own sensors; MEDIUM counts half. "
    "Area-wide weather-forecast alerts (heavy rain, high wind) and unconfirmed alerts are not counted."
)
HOTSPOT_BASIS = HOTSPOT_DEFINITION + " " + HOTSPOT_ELEVATED_BASIS
HOTSPOT_DATA_NOTE = (
    "Counts every stored reading in the window, simulated (demo) readings included. Nodes report more often "
    "while a hazard is elevated, so the share of elevated readings overstates the share of time spent "
    "elevated. Use it to compare places, not as a probability."
)
HOTSPOT_DAYS = {"7d": 7, "30d": 30}


def hotspot_window_start(days: int, now: datetime) -> str:
    """server.js hotspotWindowStart: the UTC calendar day `days - 1` days
    before today, as 'YYYY-MM-DD'."""
    return (_utc(now).date() - timedelta(days=days - 1)).isoformat()


def _js_round3(x: float) -> float:
    """Math.round(x * 1000) / 1000 (JS rounds halves up, Python's round()
    to even)."""
    return math.floor(x * 1000 + 0.5) / 1000


def _node_id_order(node_id: str):
    """Tie-break like JS String.localeCompare for this id alphabet
    (A-Z a-z 0-9 _ -; ICU root collation: '_' < '-' < digits < letters,
    letters case-insensitive first, lower case before upper on a tie)."""
    primary = tuple((0, "") if c == "_" else (1, "") if c == "-" else (2, c) if c.isdigit()
                    else (3, c.lower()) if c.isalpha() else (4, c) for c in node_id)
    return primary, tuple(not c.islower() for c in node_id), node_id


def compute_hotspots(conn, range_key: str, registry: dict, now: datetime,
                     exclude_simulated: bool = False, limit: Optional[int] = HOTSPOT_LIMIT) -> dict:
    """Per-node hotspot intensity, the officer map's definition (above).
    Returns {"from_day", "hotspots": [...ranked...]} - every node with a
    counted reading when limit is None, else the top `limit` with
    intensity > 0."""
    days = HOTSPOT_DAYS[range_key]
    from_day = hotspot_window_start(days, now)
    sim = _sim_filter(exclude_simulated)
    nodes = {}
    for node_id, day, readings, high, medium, max_risk in conn.execute(
        f"""SELECT node_id, substr(timestamp, 1, 10) AS day, COUNT(*),
              SUM(CASE WHEN status = 'alert_dispatched' AND NOT {_FORECAST_ROW_SQL}
                       AND severity IN ('HIGH', 'CRITICAL') THEN 1 ELSE 0 END),
              SUM(CASE WHEN status = 'alert_dispatched' AND NOT {_FORECAST_ROW_SQL}
                       AND severity = 'MEDIUM' THEN 1 ELSE 0 END),
              MAX(CASE WHEN NOT {_FORECAST_ROW_SQL} THEN risk_score END)
            FROM readings
            WHERE timestamp >= ? AND NOT {_NOT_A_READING_SQL}{sim}
            GROUP BY node_id, day""",
        (from_day,),
    ):
        if not isinstance(day, str) or day < from_day or not isinstance(node_id, str):
            continue
        h = nodes.setdefault(node_id, {"reading_count": 0, "high_count": 0, "medium_count": 0,
                                       "max_risk_score": None, "days_reported": 0, "days_with_high": 0})
        h["reading_count"] += int(readings or 0)
        h["high_count"] += int(high or 0)
        h["medium_count"] += int(medium or 0)
        h["days_reported"] += 1
        h["days_with_high"] += 1 if high else 0
        if max_risk is not None:
            h["max_risk_score"] = max_risk if h["max_risk_score"] is None else max(h["max_risk_score"], max_risk)

    # The hazard behind the elevated readings - a label only, not part of
    # the map's rule: most elevated readings, MEDIUM counting half.
    dominant = {}
    for node_id, hazard, high, medium in conn.execute(
        f"""SELECT node_id, COALESCE(hazard_type, 'unknown'),
              SUM(CASE WHEN severity IN ('HIGH', 'CRITICAL') THEN 1 ELSE 0 END),
              SUM(CASE WHEN severity = 'MEDIUM' THEN 1 ELSE 0 END)
            FROM readings
            WHERE timestamp >= ? AND substr(timestamp, 1, 10) >= ? AND status = 'alert_dispatched'
              AND NOT {_FORECAST_ROW_SQL} AND severity IN ('MEDIUM', 'HIGH', 'CRITICAL'){sim}
            GROUP BY 1, 2""",
        (from_day, from_day),
    ):
        weight = int(high or 0) + 0.5 * int(medium or 0)
        best = dominant.get(node_id)
        if best is None or (-weight, hazard) < (-best[1], best[0]):
            dominant[node_id] = (hazard, weight)

    out = []
    for node_id, h in nodes.items():
        raw = (min(1.0, (h["high_count"] + 0.5 * h["medium_count"]) / h["reading_count"])
               if h["reading_count"] else 0.0)
        level = ("high" if raw >= HOTSPOT_LEVEL_EDGES["high"]
                 else "moderate" if raw >= HOTSPOT_LEVEL_EDGES["moderate"] else "low")
        cfg = registry.get(node_id) or {}
        intensity = _js_round3(raw)
        out.append({
            "node_id": node_id,
            "location": cfg.get("location") or node_id,
            "latitude": cfg.get("latitude"),
            "longitude": cfg.get("longitude"),
            "score": intensity,
            "intensity": intensity,
            "level": level,
            "dominant_hazard": dominant[node_id][0] if node_id in dominant else None,
            **h,
        })
    out.sort(key=lambda x: (-x["intensity"], -x["high_count"], _node_id_order(x["node_id"])))
    if limit is not None:
        out = [x for x in out if x["intensity"] > 0][:limit]
    return {"from_day": from_day, "hotspots": out}


# --- Uptime -------------------------------------------------------------
# A node is "up" in a slot if at least one reading (any status) arrived in
# it. The slot is 15 min, or twice the node's configured report interval
# when that is longer (a deep-sleep node reporting every 20 min must not
# score 75 %). The window starts at the later of the range start and the
# node's first-ever reading, so a node installed yesterday is not charged
# for the days before it existed.
UPTIME_BASE_SLOT_S = 15 * 60
UPTIME_BASIS = (
    "percent of 15-min slots (or 2x the node's configured report interval if longer) with at least "
    "one reading received, from the later of the range start and the node's first reading"
)

FEED_PATH = "/cap/feed.atom"
FEED_ALERT_PATH = "/cap/alerts/{id}.xml"
# Public base URL the feed's links are built on (e.g. https://sanjeevni.example.in).
# Unset: links are relative ("/cap/alerts/12.xml"), which RFC 4287 allows -
# a reader resolves them against the feed's own URL.
PUBLIC_BASE_URL_ENV = "SANJEEVNI_PUBLIC_BASE_URL"
ATOM_NS = "http://www.w3.org/2005/Atom"
ATOM_MEDIA_TYPE = "application/atom+xml"  # RFC 4287 section 7


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _iso(epoch: float) -> str:
    """RFC 3339 / ISO-8601 UTC with an uppercase Z (RFC 4287 section 3.3)."""
    return datetime.fromtimestamp(epoch, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _text_lower_bound(epoch: float) -> str:
    """A text bound for `timestamp >= ?` that lets SQLite use the timestamp
    index. Stored times are UTC isoformat, which sorts as text; a day of
    margin keeps any legacy row stored with another offset, and the exact
    unixepoch() test in the same WHERE does the real filtering."""
    return datetime.fromtimestamp(epoch - 86400, tz=timezone.utc).isoformat()


def _sim_filter(exclude_simulated: bool) -> str:
    return " AND COALESCE(simulated, 0) = 0" if exclude_simulated else ""


def _severity_name(rank) -> Optional[str]:
    return SEVERITY_ORDER[int(rank) - 1] if rank else None


def _r(value, digits=3):
    return None if value is None else round(float(value), digits)


def range_window(range_key: str, now: datetime, ranges=TREND_RANGES):
    """(start_epoch, end_epoch, bucket_s, n_buckets). Buckets are aligned
    to the epoch (so 15-min buckets start on :00/:15/:30/:45 UTC) and the
    last one is the bucket containing `now` (still filling)."""
    span_s, bucket_s = ranges[range_key]
    end = _utc(now).timestamp()
    n_buckets = span_s // bucket_s
    first = (int(end) // bucket_s) * bucket_s - (n_buckets - 1) * bucket_s
    return first, end, bucket_s, n_buckets


def build_data_note(total: int, simulated: int, exclude_simulated: bool = False) -> str:
    if total == 0:
        return (
            "No readings in this range. SANJEEVNI is a prototype that has not been field-deployed; "
            "any data it shows is simulated/synthetic (demo simulator or bench rigs), not field measurements."
        )
    other = total - simulated
    parts = [
        "PROTOTYPE DATA - SIMULATED/SYNTHETIC, NOT FIELD MEASUREMENTS. SANJEEVNI has not been field-deployed.",
        f"{simulated} of {total} readings in this range are flagged simulated (demo simulator);",
        f"the other {other} come from bench/test rigs or were stored before the simulated flag existed."
        if other else "none come from any other source.",
    ]
    if exclude_simulated:
        parts.append("Rows flagged simulated were excluded on request.")
    parts.append("Use these figures to demonstrate the analytics, not to judge these locations.")
    return " ".join(parts)


def _count_rows(conn, start, end, node_id=None, exclude_simulated=False):
    sql = (
        "SELECT COUNT(*), COALESCE(SUM(CASE WHEN simulated = 1 THEN 1 ELSE 0 END), 0) FROM readings "
        "WHERE timestamp >= ? AND unixepoch(timestamp) >= ? AND unixepoch(timestamp) <= ?"
    )
    params = [_text_lower_bound(start), int(start), int(end)]
    if node_id is not None:
        sql += " AND node_id = ?"
        params.append(node_id)
    sql += _sim_filter(exclude_simulated)
    total, simulated = conn.execute(sql, params).fetchone()
    return int(total or 0), int(simulated or 0)


def node_known(conn, node_id: str, registry: dict) -> bool:
    if node_id in registry:
        return True
    return conn.execute("SELECT 1 FROM readings WHERE node_id = ? LIMIT 1", (node_id,)).fetchone() is not None


# ---------------------------------------------------------------- trends --

def compute_trends(conn, node_id: str, range_key: str, now: datetime, exclude_simulated: bool = False) -> dict:
    """Per-bucket series for one node. Every bucket in the range is listed;
    a bucket with no usable reading has nulls (and readings 0), so a chart
    shows a gap instead of joining across an outage."""
    start, end, bucket_s, n_buckets = range_window(range_key, now)
    field_sql = ", ".join(f"MIN({f}), MAX({f}), AVG({f})" for f in TREND_FIELDS)
    rows = conn.execute(
        f"""SELECT (unixepoch(timestamp) / ?) * ? AS bucket, COUNT(*),
                   MAX(CASE WHEN {_MEASURED_ALERT_SQL} THEN risk_score END),
                   MAX(CASE WHEN {_MEASURED_ALERT_SQL} THEN {_SEVERITY_RANK_SQL} END),
                   MAX(CASE WHEN {_FORECAST_ROW_SQL} THEN {_SEVERITY_RANK_SQL} END), {field_sql}
            FROM readings
            WHERE node_id = ? AND timestamp >= ? AND unixepoch(timestamp) >= ?
              AND unixepoch(timestamp) <= ? AND {_MEASURED_ROWS_SQL}{_sim_filter(exclude_simulated)}
            GROUP BY bucket""",
        (bucket_s, bucket_s, node_id, _text_lower_bound(start), int(start), int(end)),
    ).fetchall()
    by_bucket = {int(r[0]): r for r in rows if r[0] is not None}

    series = []
    for i in range(n_buckets):
        t = int(start) + i * bucket_s
        row = by_bucket.get(t)
        point = {
            "t": _iso(t),
            "readings": int(row[1]) if row else 0,
            "risk_score_max": _r(row[2], 4) if row else None,
            "severity_max": _severity_name(row[3]) if row else None,
            # worst forecast-only alert severity in the bucket (area-wide
            # weather forecast, not this node's measurement)
            "forecast_severity_max": _severity_name(row[4]) if row else None,
        }
        for j, field in enumerate(TREND_FIELDS):
            lo, hi, mean = row[5 + 3 * j: 8 + 3 * j] if row else (None, None, None)
            point[field] = None if mean is None else {"min": _r(lo), "max": _r(hi), "mean": _r(mean)}
        series.append(point)

    total, simulated = _count_rows(conn, start, end, node_id, exclude_simulated)
    return {
        "node_id": node_id,
        "range": range_key,
        "bucket_s": bucket_s,
        "generated_at": _utc(now).isoformat(),
        "start": _iso(start),
        "data_note": build_data_note(total, simulated, exclude_simulated),
        "readings_total": total,
        "readings_flagged_simulated": simulated,
        "severity_basis": TREND_SEVERITY_BASIS,
        "series": series,
    }


# --------------------------------------------------------------- summary --

def _uptime(conn, start, end, registry, exclude_simulated):
    slots = {}
    for node_id, slot in conn.execute(
        f"""SELECT node_id, unixepoch(timestamp) / {UPTIME_BASE_SLOT_S} AS s FROM readings
            WHERE timestamp >= ? AND unixepoch(timestamp) >= ? AND unixepoch(timestamp) <= ?
              {_sim_filter(exclude_simulated)}
            GROUP BY node_id, s""",
        (_text_lower_bound(start), int(start), int(end)),
    ):
        if slot is not None:
            slots.setdefault(node_id, set()).add(int(slot) * UPTIME_BASE_SLOT_S)
    first_seen = {
        node_id: first for node_id, first in conn.execute(
            f"SELECT node_id, MIN(unixepoch(timestamp)) FROM readings WHERE timestamp IS NOT NULL"
            f"{_sim_filter(exclude_simulated)} GROUP BY node_id"
        ) if first is not None
    }
    out = {}
    for node_id in sorted(set(registry) | set(slots)):
        interval = (registry.get(node_id) or {}).get("report_interval_seconds") or 0
        slot_s = max(UPTIME_BASE_SLOT_S, int(2 * interval))
        begin = max(start, first_seen.get(node_id, end))
        if node_id not in first_seen or begin > end:
            out[node_id] = 0.0
            continue
        first_slot, last_slot = int(begin) // slot_s, int(end) // slot_s
        total = last_slot - first_slot + 1
        covered = {t // slot_s for t in slots.get(node_id, ()) if first_slot <= t // slot_s <= last_slot}
        out[node_id] = round(min(100.0, 100.0 * len(covered) / total), 1)
    return out


def _exceedance(conn, start, end, registry, exclude_simulated):
    counts = {key: 0 for key in EXCEEDANCE_BASIS}
    for node_id, _hour, pm25, pm10, tmax in conn.execute(
        f"""SELECT node_id, unixepoch(timestamp) / 3600 AS h, AVG(pm25_ugm3), AVG(pm10_ugm3), MAX(temp_c)
            FROM readings
            WHERE timestamp >= ? AND unixepoch(timestamp) >= ? AND unixepoch(timestamp) <= ?
              AND {_MEASURED_ROWS_SQL}{_sim_filter(exclude_simulated)}
            GROUP BY node_id, h""",
        (_text_lower_bound(start), int(start), int(end)),
    ):
        if pm25 is not None:
            counts["pm25_poor_or_worse"] += pm25 > PM25_POOR_ABOVE_UGM3
            counts["pm25_severe"] += pm25 > PM25_SEVERE_ABOVE_UGM3
        if pm10 is not None:
            counts["pm10_poor_or_worse"] += pm10 > PM10_POOR_ABOVE_UGM3
            counts["pm10_severe"] += pm10 > PM10_SEVERE_ABOVE_UGM3
        if tmax is not None:
            cfg = registry.get(node_id) or {}
            heat = classify_extreme_heat({
                "temp_c": tmax,
                "heat_region": cfg.get("heat_region"),
                "normal_max_temp_c": cfg.get("normal_max_temp_c"),
            })
            category = heat and heat.get("imd_category")
            counts["heat_wave"] += category in ("heat_wave", "severe_heat_wave")
            counts["severe_heat_wave"] += category == "severe_heat_wave"
    return {k: int(v) for k, v in counts.items()}


def compute_summary(conn, range_key: str, registry: dict, now: datetime, exclude_simulated: bool = False) -> dict:
    span_s, _ = TREND_RANGES[range_key]
    end = _utc(now).timestamp()
    start = end - span_s
    window = (_text_lower_bound(start), int(start), int(end))
    window_sql = "timestamp >= ? AND unixepoch(timestamp) >= ? AND unixepoch(timestamp) <= ?"
    sim = _sim_filter(exclude_simulated)

    alerts_by_hazard = {}
    for hazard, count, confirmed, rank in conn.execute(
        f"""SELECT COALESCE(hazard_type, 'unknown'), COUNT(*),
                   SUM(CASE WHEN status = 'alert_dispatched' THEN 1 ELSE 0 END), MAX({_SEVERITY_RANK_SQL})
            FROM readings WHERE status IN ('alert_dispatched', 'pending_confirmation')
              AND {_MEASURED_ALERT_SQL} AND {window_sql}{sim}
            GROUP BY 1 ORDER BY 2 DESC""",
        window,
    ):
        alerts_by_hazard[hazard] = {"count": int(count), "confirmed": int(confirmed or 0),
                                    "max_severity": _severity_name(rank)}

    forecast_alerts = {"count": 0, "confirmed": 0, "nodes": 0, "by_hazard": {}, "basis": FORECAST_ALERTS_BASIS}
    forecast_nodes = set()
    for hazard, node_id, count, confirmed, rank in conn.execute(
        f"""SELECT COALESCE(hazard_type, 'unknown'), node_id, COUNT(*),
                   SUM(CASE WHEN status = 'alert_dispatched' THEN 1 ELSE 0 END), MAX({_SEVERITY_RANK_SQL})
            FROM readings WHERE status IN ('alert_dispatched', 'pending_confirmation')
              AND {_FORECAST_ROW_SQL} AND {window_sql}{sim}
            GROUP BY 1, 2""",
        window,
    ):
        forecast_nodes.add(node_id)
        forecast_alerts["count"] += int(count)
        forecast_alerts["confirmed"] += int(confirmed or 0)
        per = forecast_alerts["by_hazard"].setdefault(hazard, {"count": 0, "confirmed": 0, "max_severity": None})
        per["count"] += int(count)
        per["confirmed"] += int(confirmed or 0)
        sev = _severity_name(rank)
        if sev and (per["max_severity"] is None
                    or SEVERITY_ORDER.index(sev) > SEVERITY_ORDER.index(per["max_severity"])):
            per["max_severity"] = sev
    forecast_alerts["nodes"] = len(forecast_nodes)

    alerts_by_node = {}
    for node_id, count, rank in conn.execute(
        f"""SELECT node_id, COUNT(*), MAX({_SEVERITY_RANK_SQL})
            FROM readings WHERE status IN ('alert_dispatched', 'pending_confirmation')
              AND {_MEASURED_ALERT_SQL} AND {window_sql}{sim}
            GROUP BY node_id ORDER BY 2 DESC""",
        window,
    ):
        alerts_by_node[node_id] = {"count": int(count), "max_severity": _severity_name(rank)}

    # Hotspots: the officer map's definition (compute_hotspots).
    hotspots = compute_hotspots(conn, range_key, registry, now, exclude_simulated)

    total, simulated = _count_rows(conn, start, end, None, exclude_simulated)
    return {
        "range": range_key,
        "generated_at": _utc(now).isoformat(),
        "start": _iso(start),
        "data_note": build_data_note(total, simulated, exclude_simulated),
        "readings_total": total,
        "readings_flagged_simulated": simulated,
        "alerts_by_hazard": alerts_by_hazard,
        "alerts_by_node": alerts_by_node,
        "alerts_count_basis": ALERTS_COUNT_BASIS,
        "forecast_alerts": forecast_alerts,
        "exceedance_hours": _exceedance(conn, start, end, registry, exclude_simulated),
        "exceedance_basis": EXCEEDANCE_BASIS,
        "exceedance_note": EXCEEDANCE_NOTE,
        "top_hotspots": hotspots["hotspots"],
        "hotspot_basis": HOTSPOT_BASIS,
        "hotspot_level_edges": HOTSPOT_LEVEL_EDGES,
        "hotspot_from_day": hotspots["from_day"],
        "hotspot_data_note": HOTSPOT_DATA_NOTE,
        "node_uptime_pct": _uptime(conn, start, end, registry, exclude_simulated),
        "uptime_basis": UPTIME_BASIS,
    }


# -------------------------------------------------------------- CAP feed --

def active_confirmed_alerts(conn, registry: dict, now: datetime) -> list:
    """The alerts the public map shows, as stored readings: each registered
    node's latest measured reading, if it is a CONFIRMED (alert_dispatched)
    MEDIUM+ alert - the same rule as server.js ACTIVE_HAZARD_SQL - and its
    CAP message has not expired (sent + CAP_VALIDITY_HOURS). A node whose
    newest reading is calm, pending or older than the CAP validity has no
    entry. Suppressed / untimed rows never decide what is "latest": one
    faulty reading must not hide an ongoing hazard."""
    now_ts = _utc(now).timestamp()
    oldest = now_ts - CAP_VALIDITY_HOURS * 3600
    cols = [d[1] for d in conn.execute("PRAGMA table_info(readings)")] + ["_sent_epoch"]
    rows = conn.execute(
        f"""SELECT r.*, unixepoch(r.timestamp) FROM readings r
            JOIN (SELECT node_id, MAX(id) AS max_id FROM readings
                  WHERE timestamp >= ? AND {_MEASURED_ROWS_SQL} GROUP BY node_id) latest
              ON r.id = latest.max_id
            WHERE r.status = 'alert_dispatched' AND r.severity IN ('MEDIUM', 'HIGH', 'CRITICAL')
            ORDER BY r.risk_score DESC, r.id DESC""",
        (_text_lower_bound(oldest),),
    ).fetchall()
    out = []
    for values in rows:
        row = dict(zip(cols, values))
        if row["node_id"] not in registry:
            continue
        sent = row["_sent_epoch"]
        if sent is None or sent + CAP_VALIDITY_HOURS * 3600 <= now_ts:
            continue
        cfg = registry[row["node_id"]]
        if row.get("latitude") is None or row.get("longitude") is None:
            row["latitude"], row["longitude"] = cfg.get("latitude"), cfg.get("longitude")
        if row["latitude"] is None or row["longitude"] is None:
            continue  # the CAP export refuses it (409) - do not link to it
        out.append(row)
    return out


def build_atom_feed(alerts: list, now: datetime, base_url: Optional[str] = None) -> str:
    """Atom 1.0 (RFC 4287) feed, one entry per active confirmed alert,
    each linking to that alert's CAP 1.2 XML (the pattern CAP aggregators
    poll). Entry id and <updated> are derived from the stored reading, so a
    poller sees the same entry until a newer alert replaces it."""
    base = (base_url if base_url is not None else os.environ.get(PUBLIC_BASE_URL_ENV, "")).rstrip("/")
    ET.register_namespace("", ATOM_NS)

    def el(parent, tag, text=None, **attrs):
        node = ET.SubElement(parent, f"{{{ATOM_NS}}}{tag}", attrs)
        if text is not None:
            node.text = text
        return node

    feed = ET.Element(f"{{{ATOM_NS}}}feed")
    el(feed, "id", "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, "sanjeevni:cap-feed")))
    el(feed, "title", "SANJEEVNI active alerts (CAP 1.2)")
    # HUMAN REVIEW: public-facing wording.
    el(feed, "subtitle", "Prototype feed: confirmed SANJEEVNI alerts that are currently active. "
                         "Not connected to NDMA SACHET. Alerts from simulated data carry CAP status "
                         "'Exercise' and are marked [EXERCISE].")
    updated = max((a["_sent_epoch"] for a in alerts), default=_utc(now).timestamp())
    el(feed, "updated", _iso(updated))
    author = el(feed, "author")
    el(author, "name", "SANJEEVNI Disaster Rescue System")
    el(feed, "link", rel="self", type=ATOM_MEDIA_TYPE, href=f"{base}{FEED_PATH}")
    el(feed, "generator", "SANJEEVNI backend")

    for a in alerts:
        identifier = cap_identifier(a["node_id"], a["id"])
        event, category = HAZARD_TO_CAP.get(a.get("hazard_type"), ("Other Hazard Warning", "Other"))
        severity = SEVERITY_TO_CAP.get(a.get("severity"), a.get("severity"))
        location = a.get("location") or a["node_id"]
        prefix = "[EXERCISE] " if a.get("simulated") else ""
        entry = el(feed, "entry")
        el(entry, "id", "urn:uuid:" + str(uuid.uuid5(uuid.NAMESPACE_URL, f"sanjeevni:cap:{identifier}")))
        el(entry, "title", f"{prefix}{event} ({severity}): {location}")
        el(entry, "updated", _iso(a["_sent_epoch"]))
        el(entry, "published", _iso(a["_sent_epoch"]))
        el(entry, "link", rel="alternate", type="application/xml",
           href=f"{base}{FEED_ALERT_PATH.format(id=int(a['id']))}")
        el(entry, "category", term=category, label=event)
        # The headline paragraph only: the stored message goes on with SOP
        # excerpts, which belong in the CAP <description>, not a feed list.
        summary = (a.get("message") or "").strip().split("\n\n", 1)[0]
        summary = summary.split(" Relevant guidance:", 1)[0].strip()
        if len(summary) > 300:
            summary = summary[:297].rstrip() + "..."
        el(entry, "summary", summary or f"{event} at {location}")
    return '<?xml version="1.0" encoding="utf-8"?>\n' + ET.tostring(feed, encoding="unicode")

