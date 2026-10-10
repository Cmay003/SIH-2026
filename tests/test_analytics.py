"""
Analytics + CAP Atom feed (backend lane step B2):

  - analytics.compute_trends: bucket grid per range (24h/15 min, 7d/2 h,
    30d/6 h), min/max/mean per field, worst risk/severity, rows that must
    not be charted (suppressed, untimed, other nodes, out of range,
    simulated when excluded), a legacy non-UTC timestamp
  - analytics.compute_summary: alert counts, CPCB / IMD exceedance hours on
    their band edges, hotspot scoring per clock-hour, uptime, empty DB
  - analytics.active_confirmed_alerts / build_atom_feed: only the latest
    confirmed MEDIUM+ alert per registered node, not expired; RFC 4287
    required elements
  - the three FastAPI endpoints: shapes, range limits (400), unknown node
    (404), content type

Uses a throwaway SQLite file (backend_server.DB_PATH is pointed at it); the
app's startup (models, knowledge base) never runs.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from xml.etree import ElementTree as ET

from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import analytics  # noqa: E402
import backend_server as bs  # noqa: E402

NOW = datetime(2026, 10, 9, 12, 7, 30, tzinfo=timezone.utc)
ATOM = "{http://www.w3.org/2005/Atom}"
REGISTRY = {
    "N1": {"location": "Riverside", "latitude": 29.1, "longitude": 79.2},
    "N2": {"location": "Hillside", "latitude": 29.2, "longitude": 79.3, "heat_region": "hilly"},
    "N3": {"location": "Never seen", "latitude": 29.3, "longitude": 79.4},
}
TREND_KEYS = {"node_id", "range", "bucket_s", "generated_at", "data_note", "series"}
SUMMARY_KEYS = {"range", "generated_at", "data_note", "alerts_by_hazard", "alerts_by_node",
                "exceedance_hours", "top_hotspots", "node_uptime_pct"}


def ts(dt):
    return dt.astimezone(timezone.utc).isoformat()


class _DbCase(unittest.TestCase):
    """A fresh database per test, created by the real init_db()."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sj_analytics_")
        self._real_db = bs.DB_PATH
        bs.DB_PATH = os.path.join(self.tmp, "test.db")
        bs.init_db()
        self.conn = sqlite3.connect(bs.DB_PATH)

    def tearDown(self):
        self.conn.close()
        bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
        bs.DB_PATH = self._real_db
        shutil.rmtree(self.tmp, ignore_errors=True)

    def add(self, when, node_id="N1", **cols):
        row = dict(node_id=node_id, location=REGISTRY.get(node_id, {}).get("location", node_id),
                   status="logged", severity="LOW", risk_score=0.1, simulated=1,
                   timestamp=when if isinstance(when, str) else ts(when))
        row.update(cols)
        cur = self.conn.execute(
            f"INSERT INTO readings ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
            tuple(row.values()),
        )
        self.conn.commit()
        return cur.lastrowid


# --- trends -----------------------------------------------------------------

class TrendsTests(_DbCase):
    def test_bucket_grid_per_range(self):
        for key, (bucket_s, n) in {"24h": (900, 96), "7d": (7200, 84), "30d": (21600, 120)}.items():
            out = analytics.compute_trends(self.conn, "N1", key, NOW)
            self.assertEqual(out["bucket_s"], bucket_s)
            self.assertEqual(len(out["series"]), n, key)
            times = [datetime.fromisoformat(p["t"].replace("Z", "+00:00")) for p in out["series"]]
            self.assertTrue(all(b - a == timedelta(seconds=bucket_s) for a, b in zip(times, times[1:])))
            self.assertTrue(all(int(t.timestamp()) % bucket_s == 0 for t in times))  # epoch-aligned
            self.assertLessEqual(times[-1], NOW)
            self.assertGreater(times[-1] + timedelta(seconds=bucket_s), NOW)  # last bucket holds now

    def test_no_data_gives_nulls_and_an_honest_note(self):
        out = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        self.assertTrue(TREND_KEYS <= set(out))
        self.assertEqual(out["readings_total"], 0)
        self.assertIn("No readings", out["data_note"])
        self.assertIn("simulated", out["data_note"].lower())
        for p in out["series"]:
            self.assertEqual(p["readings"], 0)
            self.assertIsNone(p["risk_score_max"])
            self.assertIsNone(p["severity_max"])
            for f in analytics.TREND_FIELDS:
                self.assertIsNone(p[f])

    def test_aggregates_one_bucket(self):
        base = datetime(2026, 10, 9, 11, 30, tzinfo=timezone.utc)
        self.add(base + timedelta(minutes=1), temp_c=30.0, river_level_m=1.0, risk_score=0.2)
        self.add(base + timedelta(minutes=5), temp_c=33.0, river_level_m=2.0, risk_score=0.75,
                 severity="HIGH", status="alert_dispatched", hazard_type="flood")
        self.add(base + timedelta(minutes=14, seconds=59), temp_c=36.0, river_level_m=None, risk_score=0.5,
                 severity="MEDIUM", status="pending_confirmation")
        out = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        point = next(p for p in out["series"] if p["t"] == "2026-10-09T11:30:00Z")
        self.assertEqual(point["readings"], 3)
        self.assertEqual(point["risk_score_max"], 0.75)
        self.assertEqual(point["severity_max"], "HIGH")
        self.assertEqual(point["temp_c"], {"min": 30.0, "max": 36.0, "mean": 33.0})
        self.assertEqual(point["river_level_m"], {"min": 1.0, "max": 2.0, "mean": 1.5})  # NULL ignored
        self.assertIsNone(point["pm25_ugm3"])  # no sensor at all -> null, not zeros
        self.assertEqual(sum(p["readings"] for p in out["series"]), 3)
        self.assertIsNone(point["forecast_severity_max"])

    def test_forecast_only_severity_is_kept_out_of_severity_max(self):
        base = datetime(2026, 10, 9, 11, 30, tzinfo=timezone.utc)
        self.add(base + timedelta(minutes=1), temp_c=30.0, risk_score=0.85, severity="HIGH",
                 status="alert_dispatched", hazard_type="heavy_rain",
                 severity_source="weather_forecast", confirmation="forecast")
        self.add(base + timedelta(minutes=2), temp_c=31.0, risk_score=0.2)
        out = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        point = next(p for p in out["series"] if p["t"] == "2026-10-09T11:30:00Z")
        self.assertEqual((point["severity_max"], point["risk_score_max"]), ("LOW", 0.2))
        self.assertEqual(point["forecast_severity_max"], "HIGH")
        self.assertEqual(point["temp_c"], {"min": 30.0, "max": 31.0, "mean": 30.5})  # sensor values kept
        self.assertIn("forecast", out["severity_basis"])

    def test_rows_that_must_not_be_charted(self):
        t = datetime(2026, 10, 9, 10, 0, tzinfo=timezone.utc)
        self.add(t, temp_c=25.0)
        self.add(t, temp_c=99.0, status="suppressed")      # sensor fault, raw value kept
        self.add(t, temp_c=98.0, status="untimed")         # timestamp is arrival time
        self.add(t, node_id="N2", temp_c=97.0)             # other node
        self.add(NOW - timedelta(hours=25), temp_c=96.0)   # before the range
        self.add(NOW + timedelta(hours=1), temp_c=95.0)    # after "now"
        out = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        filled = [p for p in out["series"] if p["readings"]]
        self.assertEqual(len(filled), 1)
        self.assertEqual(filled[0]["temp_c"]["max"], 25.0)

    def test_exclude_simulated(self):
        t = datetime(2026, 10, 9, 9, 0, tzinfo=timezone.utc)
        self.add(t, temp_c=20.0, simulated=1)
        self.add(t, temp_c=40.0, simulated=0)
        self.add(t, temp_c=30.0, simulated=None)  # row from before the flag existed
        both = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        real = analytics.compute_trends(self.conn, "N1", "24h", NOW, exclude_simulated=True)
        pick = lambda out: next(p for p in out["series"] if p["readings"])  # noqa: E731
        self.assertEqual(pick(both)["temp_c"]["mean"], 30.0)
        self.assertEqual(pick(real)["temp_c"], {"min": 30.0, "max": 40.0, "mean": 35.0})
        self.assertEqual((both["readings_total"], both["readings_flagged_simulated"]), (3, 1))
        self.assertIn("1 of 3 readings", both["data_note"])
        self.assertIn("excluded", real["data_note"])

    def test_legacy_offset_timestamp_lands_in_its_utc_bucket(self):
        self.add("2026-10-09T17:05:00+05:30", temp_c=31.0)  # = 11:35 UTC
        out = analytics.compute_trends(self.conn, "N1", "24h", NOW)
        point = next(p for p in out["series"] if p["readings"])
        self.assertEqual(point["t"], "2026-10-09T11:30:00Z")

    def test_30d_range_reaches_back_30_days(self):
        self.add(NOW - timedelta(days=29, hours=12), temp_c=22.0)
        self.add(NOW - timedelta(days=31), temp_c=23.0)
        out = analytics.compute_trends(self.conn, "N1", "30d", NOW)
        self.assertEqual(sum(p["readings"] for p in out["series"]), 1)
        self.assertEqual(sum(p["readings"] for p in analytics.compute_trends(self.conn, "N1", "7d", NOW)["series"]), 0)


# --- summary ----------------------------------------------------------------

class SummaryTests(_DbCase):
    def test_empty_database(self):
        out = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)
        self.assertTrue(SUMMARY_KEYS <= set(out))
        self.assertEqual(out["alerts_by_hazard"], {})
        self.assertEqual(out["alerts_by_node"], {})
        self.assertEqual(out["top_hotspots"], [])
        self.assertTrue(all(v == 0 for v in out["exceedance_hours"].values()))
        for key in ("pm25_poor_or_worse", "pm10_poor_or_worse", "heat_wave"):
            self.assertIn(key, out["exceedance_hours"])
        self.assertEqual(set(out["exceedance_hours"]), set(out["exceedance_basis"]))  # every key documented
        self.assertEqual(out["node_uptime_pct"], {"N1": 0.0, "N2": 0.0, "N3": 0.0})
        self.assertIn("No readings", out["data_note"])

    def test_alert_counts(self):
        t = NOW - timedelta(hours=3)
        self.add(t, status="alert_dispatched", hazard_type="flood", severity="HIGH")
        self.add(t, status="pending_confirmation", hazard_type="flood", severity="CRITICAL")
        self.add(t, node_id="N2", status="alert_dispatched", hazard_type="heavy_rain", severity="MEDIUM")
        self.add(t, status="logged", hazard_type="flood", severity="LOW")             # not an alert
        self.add(NOW - timedelta(days=8), status="alert_dispatched", hazard_type="fire", severity="HIGH")
        out = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)
        self.assertEqual(out["alerts_by_hazard"], {
            "flood": {"count": 2, "confirmed": 1, "max_severity": "CRITICAL"},
            "heavy_rain": {"count": 1, "confirmed": 1, "max_severity": "MEDIUM"},
        })
        self.assertEqual(out["alerts_by_node"], {"N1": {"count": 2, "max_severity": "CRITICAL"},
                                                 "N2": {"count": 1, "max_severity": "MEDIUM"}})
        self.assertIn("fire", analytics.compute_summary(self.conn, "30d", REGISTRY, NOW)["alerts_by_hazard"])

    # --- hotspots: the officer map's definition (server.js aggregateHotspots), step B2

    def _hot(self, out):
        return [(x["node_id"], x["intensity"], x["level"], x["high_count"], x["medium_count"],
                 x["reading_count"]) for x in out["top_hotspots"]]

    def test_hotspots_use_the_map_definition(self):
        day = datetime(2026, 10, 8, 9, 0, tzinfo=timezone.utc)
        m = lambda k: day + timedelta(minutes=k)  # noqa: E731
        # N1: 3 confirmed HIGH + 1 confirmed MEDIUM flood, a PENDING CRITICAL
        # (a reading, not elevated), 4 calm; suppressed / untimed rows are not
        # readings -> (3 + 0.5) / 9 = 0.3889 -> high
        for k in range(3):
            self.add(m(k), status="alert_dispatched", hazard_type="flood", severity="HIGH")
        self.add(m(3), status="alert_dispatched", hazard_type="flood", severity="MEDIUM")
        self.add(m(4), status="pending_confirmation", hazard_type="fire", severity="CRITICAL")
        for k in range(4):
            self.add(m(5 + k))
        self.add(m(10), status="suppressed", hazard_type="sensor_fault", severity="N/A")
        self.add(m(11), status="untimed", severity=None)
        # N2: 4 confirmed FORECAST-only HIGH (never elevated, still readings)
        # + 1 confirmed MEDIUM landslide + 5 calm -> 0.5 / 10 = 0.05 -> low
        for k in range(4):
            self.add(m(k), node_id="N2", status="alert_dispatched", hazard_type="heavy_rain",
                     severity="HIGH", severity_source="weather_forecast", confirmation="forecast")
        self.add(m(4), node_id="N2", status="alert_dispatched", hazard_type="landslide", severity="MEDIUM")
        for k in range(5):
            self.add(m(5 + k), node_id="N2")
        # GONE (deleted from the registry): 1 of 2 readings CRITICAL -> 0.5
        self.add(m(0), node_id="GONE", status="alert_dispatched", hazard_type="fire", severity="CRITICAL")
        self.add(m(1), node_id="GONE")
        out = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)
        self.assertEqual(self._hot(out), [
            ("GONE", 0.5, "high", 1, 0, 2),
            ("N1", 0.389, "high", 3, 1, 9),
            ("N2", 0.05, "low", 0, 1, 10),
        ])
        n1 = out["top_hotspots"][1]
        self.assertEqual((n1["score"], n1["dominant_hazard"], n1["location"], n1["latitude"]),
                         (0.389, "flood", "Riverside", 29.1))
        self.assertEqual(out["top_hotspots"][2]["dominant_hazard"], "landslide")  # not the forecast rain
        self.assertEqual(out["top_hotspots"][0]["location"], "GONE")
        self.assertEqual((n1["days_reported"], n1["days_with_high"]), (1, 1))
        self.assertEqual(out["hotspot_from_day"], "2026-10-03")
        self.assertEqual(out["hotspot_level_edges"], {"moderate": 0.1, "high": 0.3})

    def test_hotspot_window_is_utc_calendar_days_like_the_map(self):
        # 7d = today + the 6 UTC days before (from 2026-10-03 00:00) - a
        # reading 6.9 days ago on 10-02 is out, as on the map, though it is
        # inside a rolling 7 x 24 h window
        old = datetime(2026, 10, 2, 13, 0, tzinfo=timezone.utc)
        self.assertLess(NOW - old, timedelta(days=7))
        self.add(old, node_id="N3", status="alert_dispatched", hazard_type="fire", severity="CRITICAL")
        self.add(datetime(2026, 10, 3, 0, 0, tzinfo=timezone.utc), status="alert_dispatched",
                 hazard_type="flood", severity="HIGH")
        self.assertEqual([x["node_id"] for x in analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)
                          ["top_hotspots"]], ["N1"])
        out30 = analytics.compute_summary(self.conn, "30d", REGISTRY, NOW)
        self.assertEqual(out30["hotspot_from_day"], "2026-09-10")
        self.assertEqual([x["node_id"] for x in out30["top_hotspots"]], ["N1", "N3"])  # tie 1.0: N1 < N3

    def test_hotspot_ties_rounding_limit_and_simulated(self):
        t = NOW - timedelta(hours=2)
        # equal intensity 0.1: more HIGH readings first; moderate from 0.1
        self.add(t, node_id="B", status="alert_dispatched", hazard_type="fire", severity="HIGH")
        for k in range(9):
            self.add(t + timedelta(minutes=k + 1), node_id="B")
        for k in range(2):
            self.add(t, node_id="A", status="alert_dispatched", hazard_type="fire", severity="MEDIUM")
        for k in range(8):
            self.add(t + timedelta(minutes=k + 1), node_id="A")
        # 0.5 / 8 = 0.0625: shown 0.063 (JS Math.round half up; Python's round gives 0.062)
        self.add(t, node_id="C", status="alert_dispatched", hazard_type="flood", severity="MEDIUM")
        for k in range(7):
            self.add(t + timedelta(minutes=k + 1), node_id="C")
        for k in range(5):  # four more nodes at 1.0 -> only 5 listed, calm nodes never
            self.add(t, node_id=f"Z{k}", status="alert_dispatched", hazard_type="fire", severity="HIGH")
        self.add(t, node_id="CALM")
        out = analytics.compute_summary(self.conn, "7d", {}, NOW)
        self.assertEqual([x["node_id"] for x in out["top_hotspots"]], ["Z0", "Z1", "Z2", "Z3", "Z4"])
        hot = analytics.compute_hotspots(self.conn, "7d", {}, NOW, limit=None)["hotspots"]
        self.assertEqual([(x["node_id"], x["intensity"], x["level"]) for x in hot[5:]],
                         [("B", 0.1, "moderate"), ("A", 0.1, "moderate"), ("C", 0.063, "low"),
                          ("CALM", 0.0, "low")])
        self.assertEqual(round(0.0625, 3), 0.062)  # why _js_round3 exists
        # exclude_simulated: every row here is simulated
        self.assertEqual(analytics.compute_summary(self.conn, "7d", {}, NOW, exclude_simulated=True)
                         ["top_hotspots"], [])

    def test_hotspot_basis_is_the_maps_text(self):
        """server.js HOTSPOT_DEFINITION + HOTSPOT_BASIS, word for word, and
        the same level edges / not-a-reading statuses (drift guard)."""
        import re

        with open(os.path.join(ROOT, "server", "server.js"), encoding="utf-8") as f:
            js = f.read()

        def js_string(name):
            m = re.search(r"const %s =\s*((?:\"(?:[^\"\\]|\\.)*\"\s*\+?\s*)+);" % name, js)
            self.assertIsNotNone(m, name)
            return "".join(re.findall(r"\"((?:[^\"\\]|\\.)*)\"", m.group(1)))

        self.assertEqual(analytics.HOTSPOT_DEFINITION, js_string("HOTSPOT_DEFINITION"))
        self.assertEqual(analytics.HOTSPOT_ELEVATED_BASIS, js_string("HOTSPOT_BASIS"))
        self.assertEqual(analytics.HOTSPOT_DATA_NOTE, js_string("HOTSPOT_DATA_NOTE"))
        self.assertEqual(analytics.HOTSPOT_BASIS,
                         js_string("HOTSPOT_DEFINITION") + " " + js_string("HOTSPOT_BASIS"))
        self.assertIn("const HOTSPOT_LEVEL_EDGES = { moderate: 0.1, high: 0.3 };", js)
        self.assertIn(f'const NOT_A_READING_SQL = "{analytics._NOT_A_READING_SQL}";', js)
        self.assertIn(f'"{analytics._FORECAST_ROW_SQL}";', js)

    def test_forecast_only_alerts_are_not_node_evidence(self):
        # Review 2026-10-09: a confirmed forecast-only alert (area-wide
        # weather forecast) is raised at every quiet node; it must not make
        # hotspots or per-node counts, only the separate forecast_alerts.
        h = datetime(2026, 10, 9, 8, 0, tzinfo=timezone.utc)
        for k in range(4):
            for node in ("N1", "N2"):
                self.add(h + timedelta(hours=k), node_id=node, status="alert_dispatched",
                         hazard_type="heavy_rain", severity="HIGH",
                         severity_source="weather_forecast", confirmation="forecast")
        self.add(h, node_id="N2", status="alert_dispatched", hazard_type="flood", severity="MEDIUM",
                 severity_source="ml_model", confirmation="persistent")
        # measured heavy rain (gauge) still counts
        self.add(h, node_id="N1", status="alert_dispatched", hazard_type="heavy_rain", severity="MEDIUM",
                 severity_source="threshold_classifier", confirmation="persistent")
        out = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)
        # map definition: N1 1 MEDIUM of 5 readings, N2 1 MEDIUM of 5 (the
        # forecast rows are readings, never elevated) -> 0.1 each, N1 first
        self.assertEqual([(x["node_id"], x["score"], x["dominant_hazard"]) for x in out["top_hotspots"]],
                         [("N1", 0.1, "heavy_rain"), ("N2", 0.1, "flood")])
        self.assertEqual(out["alerts_by_hazard"], {
            "flood": {"count": 1, "confirmed": 1, "max_severity": "MEDIUM"},
            "heavy_rain": {"count": 1, "confirmed": 1, "max_severity": "MEDIUM"},
        })
        self.assertEqual(out["alerts_by_node"], {"N1": {"count": 1, "max_severity": "MEDIUM"},
                                                 "N2": {"count": 1, "max_severity": "MEDIUM"}})
        fa = out["forecast_alerts"]
        self.assertEqual((fa["count"], fa["confirmed"], fa["nodes"]), (8, 8, 2))
        self.assertEqual(fa["by_hazard"], {"heavy_rain": {"count": 8, "confirmed": 8, "max_severity": "HIGH"}})
        self.assertIn("forecast", out["hotspot_basis"])
        self.assertIn("forecast_alerts", out["alerts_count_basis"])

    def test_pm_exceedance_on_cpcb_band_edges(self):
        hours = [NOW - timedelta(hours=k, minutes=30) for k in range(1, 7)]
        self.add(hours[0], pm25_ugm3=90.0, pm10_ugm3=250.0)    # Moderately polluted top: no
        self.add(hours[1], pm25_ugm3=91.0, pm10_ugm3=251.0)    # Poor: yes
        self.add(hours[2], pm25_ugm3=80.0)                      # 1-h MEAN 100 -> yes
        self.add(hours[2] + timedelta(minutes=5), pm25_ugm3=120.0)
        self.add(hours[3], pm25_ugm3=251.0, pm10_ugm3=431.0)   # Severe: both
        self.add(hours[4], pm25_ugm3=250.0, pm10_ugm3=430.0)   # Very Poor tops: poor, not severe
        self.add(hours[5], pm25_ugm3=500.0, status="suppressed")  # fault: ignored
        ex = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)["exceedance_hours"]
        self.assertEqual(ex["pm25_poor_or_worse"], 4)
        self.assertEqual(ex["pm25_severe"], 1)
        self.assertEqual(ex["pm10_poor_or_worse"], 3)
        self.assertEqual(ex["pm10_severe"], 1)

    def test_heat_exceedance_uses_imd_criteria_and_region(self):
        t = NOW - timedelta(hours=5)
        self.add(t, temp_c=44.9)                              # plains, below 45: no
        self.add(t + timedelta(hours=1), temp_c=45.0)         # plains heat wave
        self.add(t + timedelta(hours=2), temp_c=47.0)         # plains severe heat wave
        self.add(t + timedelta(hours=2, minutes=10), temp_c=30.0)  # same hour: the MAX counts
        self.add(t, node_id="N2", temp_c=48.0)                # hilly, no normal: IMD gives no category
        ex = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)["exceedance_hours"]
        self.assertEqual(ex["heat_wave"], 2)
        self.assertEqual(ex["severe_heat_wave"], 1)

    def test_uptime(self):
        start = NOW - timedelta(days=7)
        # N1 heard in every 15-min slot of the 7 days (status does not matter)
        t = datetime.fromtimestamp((int(start.timestamp()) // 900) * 900 + 900, tz=timezone.utc)
        while t <= NOW:
            self.add(t, status="suppressed" if t.minute == 0 else "logged")
            t += timedelta(minutes=15)
        # N2 first ever heard 2 h ago, then every 15 min for the first hour only
        for k in range(4):
            self.add(NOW - timedelta(hours=2) + timedelta(minutes=15 * k), node_id="N2")
        up = analytics.compute_summary(self.conn, "7d", REGISTRY, NOW)["node_uptime_pct"]
        self.assertGreaterEqual(up["N1"], 99.0)
        self.assertTrue(40.0 <= up["N2"] <= 60.0, up["N2"])  # window starts at first reading
        self.assertEqual(up["N3"], 0.0)                      # registered, never seen

    def test_uptime_slot_follows_a_slow_report_interval(self):
        registry = {"N1": {**REGISTRY["N1"], "report_interval_seconds": 1800}}  # 60-min slots
        for k in range(1, 25):
            self.add(NOW - timedelta(hours=k), node_id="N1")
        self.add(NOW - timedelta(days=6), node_id="N1")  # first reading -> window start
        up = analytics.compute_summary(self.conn, "7d", registry, NOW)["node_uptime_pct"]["N1"]
        self.assertAlmostEqual(up, 100.0 * 25 / ((6 * 24) + 1), delta=1.0)

    def test_single_node_and_unregistered_node(self):
        self.add(NOW - timedelta(hours=1), node_id="GONE", status="alert_dispatched",
                 hazard_type="fire", severity="CRITICAL")
        out = analytics.compute_summary(self.conn, "7d", {}, NOW)
        self.assertEqual(list(out["alerts_by_node"]), ["GONE"])  # history kept after deletion
        self.assertEqual(out["top_hotspots"][0]["location"], "GONE")
        self.assertIn("GONE", out["node_uptime_pct"])


# --- CAP Atom feed -----------------------------------------------------------

class FeedTests(_DbCase):
    def alerts(self, registry=REGISTRY):
        return analytics.active_confirmed_alerts(self.conn, registry, NOW)

    def test_latest_confirmed_alert_per_node_only(self):
        t = NOW - timedelta(minutes=10)
        self.add(t, status="alert_dispatched", hazard_type="flood", severity="HIGH")
        latest = self.add(t + timedelta(minutes=1), status="alert_dispatched", hazard_type="flood",
                          severity="CRITICAL", message="Evacuate.\n\n[Source: flood.txt] SOP text")
        self.add(t + timedelta(minutes=2), status="suppressed")      # fault: does not hide it
        self.add(t, node_id="N2", status="alert_dispatched", hazard_type="fire", severity="HIGH")
        self.add(t + timedelta(minutes=1), node_id="N2", status="logged")  # N2 cleared
        self.add(t, node_id="N3", status="pending_confirmation", hazard_type="fire", severity="HIGH")
        self.add(t, node_id="GONE", status="alert_dispatched", hazard_type="fire", severity="HIGH",
                 latitude=1.0, longitude=2.0)                          # deleted node
        rows = self.alerts()
        self.assertEqual([r["id"] for r in rows], [latest])

    def test_expired_and_low_alerts_are_not_active(self):
        self.add(NOW - timedelta(hours=analytics.CAP_VALIDITY_HOURS, minutes=1),
                 status="alert_dispatched", hazard_type="flood", severity="HIGH")
        self.add(NOW - timedelta(minutes=1), node_id="N2", status="alert_dispatched",
                 hazard_type="flood", severity="LOW")
        self.assertEqual(self.alerts(), [])

    def test_alert_without_any_position_is_skipped(self):
        self.add(NOW - timedelta(minutes=1), status="alert_dispatched", hazard_type="flood", severity="HIGH")
        self.assertEqual(self.alerts({"N1": {"location": "x"}}), [])
        self.assertEqual(len(self.alerts()), 1)  # registry position used as fallback

    def test_feed_has_rfc4287_required_elements(self):
        rid = self.add(NOW - timedelta(minutes=3), status="alert_dispatched", hazard_type="heavy_rain",
                       severity="HIGH", message="Heavy rain forecast.\n\nSOP...", simulated=1)
        rid2 = self.add(NOW - timedelta(minutes=2), node_id="N2", status="alert_dispatched",
                        hazard_type="smoke", severity="MEDIUM", message="Smoke", simulated=0)
        xml = analytics.build_atom_feed(self.alerts(), NOW, base_url="https://example.org/")
        feed = ET.fromstring(xml.encode("utf-8"))
        self.assertEqual(feed.tag, ATOM + "feed")
        for tag in ("id", "title", "updated", "author"):
            self.assertEqual(len(feed.findall(ATOM + tag)), 1, tag)
        self.assertEqual(feed.find(ATOM + "updated").text, "2026-10-09T12:05:30Z")  # newest entry
        self.assertEqual(feed.find(ATOM + "link").get("href"), "https://example.org/cap/feed.atom")
        entries = feed.findall(ATOM + "entry")
        self.assertEqual(len(entries), 2)
        by_href = {e.find(ATOM + "link").get("href"): e for e in entries}
        rain = by_href[f"https://example.org/cap/alerts/{rid}.xml"]
        self.assertIn(f"https://example.org/cap/alerts/{rid2}.xml", by_href)
        for e in entries:
            for tag in ("id", "title", "updated"):
                self.assertEqual(len(e.findall(ATOM + tag)), 1)
            self.assertTrue(e.find(ATOM + "id").text.startswith("urn:uuid:"))
            self.assertEqual(e.find(ATOM + "link").get("rel"), "alternate")
            self.assertRegex(e.find(ATOM + "updated").text, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")
        self.assertEqual(rain.find(ATOM + "title").text, "[EXERCISE] Heavy Rain Warning (Severe): Riverside")
        self.assertEqual(rain.find(ATOM + "summary").text, "Heavy rain forecast.")
        self.assertEqual(rain.find(ATOM + "category").get("term"), "Met")
        smoke = by_href[f"https://example.org/cap/alerts/{rid2}.xml"]
        self.assertFalse(smoke.find(ATOM + "title").text.startswith("[EXERCISE]"))
        # same alert -> same entry id on every poll
        again = ET.fromstring(analytics.build_atom_feed(self.alerts(), NOW + timedelta(minutes=1)).encode())
        self.assertEqual(sorted(e.find(ATOM + "id").text for e in again.findall(ATOM + "entry")),
                         sorted(e.find(ATOM + "id").text for e in entries))

    def test_empty_feed_is_still_valid_and_links_are_relative_by_default(self):
        with mock.patch.dict(os.environ, {analytics.PUBLIC_BASE_URL_ENV: ""}):
            feed = ET.fromstring(analytics.build_atom_feed([], NOW).encode())
        self.assertEqual(feed.findall(ATOM + "entry"), [])
        self.assertEqual(feed.find(ATOM + "updated").text, "2026-10-09T12:07:30Z")
        self.assertEqual(feed.find(ATOM + "link").get("href"), "/cap/feed.atom")


# --- endpoints ----------------------------------------------------------------

class EndpointTests(_DbCase):
    def setUp(self):
        super().setUp()
        self._real_registry = dict(bs.NODE_REGISTRY)
        bs.NODE_REGISTRY.clear()
        bs.NODE_REGISTRY.update(REGISTRY)
        self.client = TestClient(bs.app)  # no `with`: startup must not run

    def tearDown(self):
        bs.NODE_REGISTRY.clear()
        bs.NODE_REGISTRY.update(self._real_registry)
        super().tearDown()

    def test_trends_endpoint(self):
        now = datetime.now(timezone.utc)
        self.add(now - timedelta(minutes=20), temp_c=31.5)
        r = self.client.get("/api/analytics/trends", params={"node_id": "N1", "range": "24h"})
        self.assertEqual(r.status_code, 200)
        body = r.json()
        self.assertTrue(TREND_KEYS <= set(body))
        self.assertEqual((body["node_id"], body["range"], body["bucket_s"], len(body["series"])), ("N1", "24h", 900, 96))
        self.assertEqual(sum(p["readings"] for p in body["series"]), 1)
        self.assertIn("SIMULATED", body["data_note"])
        self.assertEqual(self.client.get("/api/analytics/trends", params={"node_id": "N1"}).json()["range"], "24h")

    def test_trends_limits(self):
        get = lambda **p: self.client.get("/api/analytics/trends", params=p)  # noqa: E731
        self.assertEqual(get(node_id="N1", range="1y").status_code, 400)
        self.assertEqual(get(node_id="N1", range="24H").status_code, 400)
        self.assertEqual(get(range="24h").status_code, 422)            # node_id required
        self.assertEqual(get(node_id="NOPE", range="24h").status_code, 404)
        self.add(NOW, node_id="DELETED")                                # history only
        self.assertEqual(get(node_id="DELETED", range="7d").status_code, 200)
        self.assertEqual(get(node_id="N3", range="30d").status_code, 200)  # registered, no data

    def test_summary_endpoint_and_limits(self):
        for key in ("7d", "30d"):
            r = self.client.get("/api/analytics/summary", params={"range": key})
            self.assertEqual(r.status_code, 200)
            self.assertTrue(SUMMARY_KEYS <= set(r.json()))
        self.assertEqual(self.client.get("/api/analytics/summary").json()["range"], "7d")
        for bad in ("24h", "90d", ""):
            self.assertEqual(self.client.get("/api/analytics/summary", params={"range": bad}).status_code, 400)

    def test_feed_endpoint(self):
        rid = self.add(datetime.now(timezone.utc) - timedelta(minutes=1), status="alert_dispatched",
                       hazard_type="flash_flood", severity="CRITICAL", message="Move to high ground")
        r = self.client.get("/api/cap/feed.atom")
        self.assertEqual(r.status_code, 200)
        self.assertTrue(r.headers["content-type"].startswith("application/atom+xml"))
        feed = ET.fromstring(r.content)
        hrefs = [e.find(ATOM + "link").get("href") for e in feed.findall(ATOM + "entry")]
        self.assertEqual(len(hrefs), 1)
        self.assertTrue(hrefs[0].endswith(f"/cap/alerts/{rid}.xml"))

    def test_indexes_created(self):
        names = {r[0] for r in self.conn.execute("SELECT name FROM sqlite_master WHERE type='index'")}
        self.assertTrue({"idx_readings_timestamp", "idx_readings_node_timestamp"} <= names)
        plan = " ".join(str(r) for r in self.conn.execute(
            "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM readings WHERE node_id = 'N1' AND timestamp >= '2026'"))
        self.assertIn("idx_readings_node_timestamp", plan)


if __name__ == "__main__":
    unittest.main()
