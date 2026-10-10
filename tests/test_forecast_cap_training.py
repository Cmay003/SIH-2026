"""
Forecast window, CAP export and grouped flood-model evaluation
(progress.txt section 4, backend lane step 2):

  - the "next 6 h" rain forecast is no longer cut short late in the UTC
    day (forecast_days=2), and a short / gappy window is treated as a
    failed fetch instead of being cached as less rain
  - CAP export: one stable identifier and <sent> per stored alert, UTC
    written as -00:00, an <expires>, status Exercise for simulated alerts,
    the severity's zone radius (matching server.js) and the position the
    node had when the reading was taken
  - train_models.py splits and calibrates on whole groups (node + day or
    event_id), never on near-duplicate rows seconds apart

Uses a throwaway SQLite file and temp model dir - var/ is never touched.
Network calls are stubbed out.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from unittest import mock

import numpy as np
import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "ml"))

import backend_server as bs  # noqa: E402
import cap_alert  # noqa: E402
import train_models as tm  # noqa: E402
from fastapi import HTTPException  # noqa: E402

NS = {"cap": cap_alert.CAP_NAMESPACE}


def _offline(*_a, **_k):
    raise requests.ConnectionError("offline (test)")


def _fixed_datetime(at: datetime):
    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            return at if tz is None else at.astimezone(tz)

    return Fixed


def _open_meteo_payload(start: datetime, hours: int, mm_per_hour=10.0):
    times = [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:00") for h in range(hours)]
    precip = mm_per_hour if isinstance(mm_per_hour, list) else [mm_per_hour] * hours
    return {"hourly": {"time": times, "precipitation": precip}}


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


# --- 6-hour rain forecast window ------------------------------------------

class ForecastWindowTests(unittest.TestCase):
    NODE = "TEST-FORECAST"
    LATE = datetime(2026, 10, 8, 21, 30, tzinfo=timezone.utc)  # 03:00 IST
    DAY = datetime(2026, 10, 8, 0, 0, tzinfo=timezone.utc)

    def setUp(self):
        bs._weather_cache.pop(self.NODE, None)
        self._saved_backoff = bs._api_failed_at.pop("weather", None)

    def tearDown(self):
        bs._weather_cache.pop(self.NODE, None)
        bs._api_failed_at.pop("weather", None)
        if self._saved_backoff is not None:
            bs._api_failed_at["weather"] = self._saved_backoff

    def _fetch(self, payload, at=LATE):
        calls = []

        def fake_get(url, params=None, timeout=None):
            calls.append(params)
            return _FakeResponse(payload)

        with mock.patch.object(bs, "datetime", _fixed_datetime(at)), \
                mock.patch.object(bs.requests, "get", fake_get):
            value = bs.fetch_forecast_rainfall_mm(29.39, 79.45, self.NODE)
        return value, calls

    def test_requests_two_days_so_the_window_runs_past_midnight(self):
        value, calls = self._fetch(_open_meteo_payload(self.DAY, 48))
        self.assertEqual(calls[0]["forecast_days"], 2)
        # 21:00..02:00 UTC - six full hours, not the three left in "today"
        self.assertEqual(value, 60.0)

    def test_window_starts_at_the_current_hour(self):
        rain = [0.0] * 48
        rain[21] = 7.0  # 21:00 UTC - inside the window
        rain[20] = 100.0  # 20:00 UTC - already past, must not count
        rain[27] = 100.0  # 03:00 next day - 7th hour, outside
        value, _ = self._fetch(_open_meteo_payload(self.DAY, 48, rain))
        self.assertEqual(value, 7.0)

    def test_truncated_window_is_not_cached_as_less_rain(self):
        # A one-day response (what forecast_days=1 returned): at 21:30 only
        # 3 hours remain. Old code returned 30.0 and cached it.
        value, _ = self._fetch(_open_meteo_payload(self.DAY, 24))
        self.assertIsNone(value)
        self.assertNotIn(self.NODE, bs._weather_cache)

    def test_truncated_window_falls_back_to_last_good_value(self):
        bs._weather_cache[self.NODE] = {
            "value": 42.0,
            "fetched_at": self.LATE - timedelta(hours=1),  # past the TTL
        }
        value, _ = self._fetch(_open_meteo_payload(self.DAY, 24))
        self.assertEqual(value, 42.0)

    def test_null_hour_in_window_is_incomplete(self):
        rain = [1.0] * 48
        rain[23] = None
        value, _ = self._fetch(_open_meteo_payload(self.DAY, 48, rain))
        self.assertIsNone(value)

    def test_missing_current_hour_is_not_summed_from_index_zero(self):
        # A stale payload for yesterday: the old code fell back to index 0
        # and reported yesterday's rain as the next 6 hours.
        value, _ = self._fetch(_open_meteo_payload(self.DAY - timedelta(days=2), 48))
        self.assertIsNone(value)


# --- CAP message ------------------------------------------------------------

def _cap(**overrides):
    kwargs = dict(
        hazard_type="flood",
        severity="HIGH",
        location="Sector 4",
        latitude=29.3919,
        longitude=79.4542,
        message="River rising",
        node_id="NODE-04",
        risk_score=0.81,
        reading_id=17,
        sent_at=datetime(2026, 10, 5, 22, 15, 3, 123456, tzinfo=timezone.utc),
    )
    kwargs.update(overrides)
    return ET.fromstring(cap_alert.generate_cap_alert(**kwargs))


def _text(root, path):
    return root.find(path, NS).text


class CapMessageTests(unittest.TestCase):
    def test_same_alert_gives_the_same_message(self):
        a = cap_alert.generate_cap_alert(
            "flood", "HIGH", "S4", 29.0, 79.0, "m", "NODE-04", 0.8,
            reading_id=5, sent_at=datetime(2026, 10, 5, 1, 2, 3, tzinfo=timezone.utc),
        )
        b = cap_alert.generate_cap_alert(
            "flood", "HIGH", "S4", 29.0, 79.0, "m", "NODE-04", 0.8,
            reading_id=5, sent_at=datetime(2026, 10, 5, 1, 2, 3, tzinfo=timezone.utc),
        )
        self.assertEqual(a, b)
        root = ET.fromstring(a)
        self.assertEqual(_text(root, "cap:identifier"), "sanjeevni-NODE-04-5")

    def test_sent_is_the_reading_time_in_cap_utc_form(self):
        root = _cap()
        self.assertEqual(_text(root, "cap:sent"), "2026-10-05T22:15:03-00:00")
        self.assertEqual(_text(root, "cap:info/cap:expires"), "2026-10-06T04:15:03-00:00")

    def test_no_plus_zero_offset_anywhere(self):
        xml = cap_alert.generate_cap_alert(
            "flood", "HIGH", "S4", 29.0, 79.0, "m", "N", 0.8, reading_id=1,
            sent_at=datetime(2026, 10, 5, 1, 2, 3, tzinfo=timezone.utc),
        )
        self.assertNotIn("+00:00", xml)

    def test_naive_and_ist_times_are_written_as_utc(self):
        ist = timezone(timedelta(hours=5, minutes=30))
        self.assertEqual(
            _text(_cap(sent_at=datetime(2026, 10, 6, 3, 45, 3, tzinfo=ist)), "cap:sent"),
            "2026-10-05T22:15:03-00:00",
        )
        self.assertEqual(
            _text(_cap(sent_at=datetime(2026, 10, 5, 22, 15, 3)), "cap:sent"),
            "2026-10-05T22:15:03-00:00",
        )

    def test_cap_datetime_matches_the_xsd_pattern(self):
        value = cap_alert.cap_datetime(datetime(2026, 1, 2, 3, 4, 5, 999999, tzinfo=timezone.utc))
        self.assertRegex(value, r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[-+]\d\d:\d\d$")

    def test_without_stored_time_falls_back_to_now(self):
        root = _cap(sent_at=None, reading_id=None)
        sent = datetime.strptime(_text(root, "cap:sent")[:19], "%Y-%m-%dT%H:%M:%S").replace(
            tzinfo=timezone.utc
        )
        self.assertLess(abs((datetime.now(timezone.utc) - sent).total_seconds()), 60)

    def test_identifier_has_no_cap_restricted_characters(self):
        ident = _text(_cap(node_id="NODE 4,<a&b>"), "cap:identifier")
        self.assertIsNone(re.search(r"[\s,<&]", ident), ident)
        self.assertTrue(ident.endswith("-17"))

    def test_status_defaults_to_actual(self):
        root = _cap()
        self.assertEqual(_text(root, "cap:status"), "Actual")
        self.assertIsNone(root.find("cap:note", NS))

    def test_exercise_status_with_note(self):
        root = _cap(status="Exercise")
        self.assertEqual(_text(root, "cap:status"), "Exercise")
        self.assertIn("simulator", _text(root, "cap:note"))

    def test_unknown_status_is_rejected(self):
        with self.assertRaises(ValueError):
            _cap(status="Demo")

    def test_element_order_follows_the_cap_schema(self):
        root = _cap(status="Exercise")
        top = [c.tag.split("}")[1] for c in root]
        self.assertEqual(
            top[:7], ["identifier", "sender", "sent", "status", "msgType", "scope", "note"]
        )
        info = [c.tag.split("}")[1] for c in root.find("cap:info", NS)]
        self.assertEqual(
            info[info.index("certainty"):info.index("certainty") + 3],
            ["certainty", "expires", "senderName"],
        )

    def test_radius_follows_severity(self):
        def radius_km(sev):
            circle = _text(_cap(severity=sev), "cap:info/cap:area/cap:circle")
            return float(circle.split(" ")[1])

        self.assertEqual(radius_km("MEDIUM"), 0.5)
        self.assertEqual(radius_km("HIGH"), 1.0)
        self.assertEqual(radius_km("CRITICAL"), 2.0)
        circle = _text(_cap(radius_m=750), "cap:info/cap:area/cap:circle")
        self.assertEqual(circle, "29.3919,79.4542 0.75")

    def test_radius_table_matches_server_hazard_zone(self):
        # The map and WhatsApp reach come from server.js; the CAP area must
        # describe the same zone.
        with open(os.path.join(ROOT, "server", "server.js"), encoding="utf-8") as f:
            m = re.search(r"const HAZARD_RADIUS_M = \{([^}]*)\}", f.read())
        self.assertIsNotNone(m)
        server_table = {k: int(v) for k, v in re.findall(r"(\w+):\s*(\d+)", m.group(1))}
        self.assertEqual(server_table, cap_alert.CAP_RADIUS_M)


# --- /api/alerts/{id}/cap ---------------------------------------------------

class CapEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="sj_cap_")
        cls._real_db = bs.DB_PATH
        cls._real_get = bs.requests.get
        bs.DB_PATH = os.path.join(cls._tmp, "test.db")
        bs.requests.get = _offline
        bs.init_db()

    @classmethod
    def tearDownClass(cls):
        bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
        bs.DB_PATH = cls._real_db
        bs.requests.get = cls._real_get
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def _insert(self, **cols):
        row = dict(
            node_id="NODE-04", location="Sector 4", status="alert_dispatched",
            hazard_type="flood", severity="CRITICAL", risk_score=0.93,
            severity_source="ml_model", message="Evacuate low ground",
            timestamp="2026-10-05T22:15:03.512000+00:00", simulated=0,
            latitude=29.1, longitude=79.2,
        )
        row.update(cols)
        conn = sqlite3.connect(bs.DB_PATH)
        cur = conn.execute(
            f"INSERT INTO readings ({', '.join(row)}) VALUES ({', '.join('?' for _ in row)})",
            tuple(row.values()),
        )
        conn.commit()
        conn.close()
        return cur.lastrowid

    def _cap_root(self, alert_id):
        return ET.fromstring(bs.get_alert_as_cap(alert_id).body)

    def test_repeated_export_is_identical(self):
        alert_id = self._insert()
        first = bs.get_alert_as_cap(alert_id).body
        second = bs.get_alert_as_cap(alert_id).body
        self.assertEqual(first, second)
        root = ET.fromstring(first)
        self.assertEqual(_text(root, "cap:identifier"), f"sanjeevni-NODE-04-{alert_id}")
        self.assertEqual(_text(root, "cap:sent"), "2026-10-05T22:15:03-00:00")

    def test_simulated_alert_is_an_exercise(self):
        root = self._cap_root(self._insert(simulated=1))
        self.assertEqual(_text(root, "cap:status"), "Exercise")
        real = self._cap_root(self._insert(simulated=0))
        self.assertEqual(_text(real, "cap:status"), "Actual")

    def test_area_uses_severity_radius_and_stored_position(self):
        # Stored position wins over the live registry (the node may have
        # moved since); CRITICAL = 2 km like the map zone.
        root = self._cap_root(self._insert(latitude=29.1, longitude=79.2))
        self.assertEqual(_text(root, "cap:info/cap:area/cap:circle"), "29.1,79.2 2.0")

    def test_old_row_without_position_uses_registry(self):
        alert_id = self._insert(latitude=None, longitude=None, severity="MEDIUM")
        with mock.patch.dict(bs.NODE_REGISTRY, {"NODE-04": {"latitude": 29.4, "longitude": 79.5}}):
            root = self._cap_root(alert_id)
        self.assertEqual(_text(root, "cap:info/cap:area/cap:circle"), "29.4,79.5 0.5")

    def test_unknown_location_is_refused_not_placed_at_zero(self):
        alert_id = self._insert(node_id="NODE-GONE", latitude=None, longitude=None)
        with self.assertRaises(HTTPException) as ctx, \
                mock.patch.dict(bs.NODE_REGISTRY, clear=False):
            bs.NODE_REGISTRY.pop("NODE-GONE", None)
            bs.get_alert_as_cap(alert_id)
        self.assertEqual(ctx.exception.status_code, 409)

    def test_save_reading_stores_the_node_position(self):
        enriched = {
            "node_id": "NODE-04", "location": "Sector 4", "river_level_m": 1.0,
            "temp_c": 25.0, "humidity_pct": 60.0, "gas_ppm": 10.0,
            "flame_reading": 4000.0, "rainfall_24h_mm": 0.0,
        }
        result = {"status": "logged", "latitude": 29.55, "longitude": 79.66}
        bs.save_reading(enriched, result, "2026-10-05T00:00:00+00:00")
        conn = sqlite3.connect(bs.DB_PATH)
        row = conn.execute(
            "SELECT latitude, longitude FROM readings ORDER BY id DESC LIMIT 1"
        ).fetchone()
        conn.close()
        self.assertEqual(row, (29.55, 79.66))


# --- grouped flood-model evaluation ----------------------------------------

def _event_frame(pos_groups=4, neg_groups=4, rows=30, seed=0):
    """Export-like rows: each node-day is one episode of near-identical
    readings seconds apart, flood (1) or not (0)."""
    rng = np.random.default_rng(seed)
    frames = []
    for g in range(pos_groups + neg_groups):
        flood = int(g < pos_groups)
        start = datetime(2026, 9, 1 + g, 10, 0, tzinfo=timezone.utc)
        level = (3.2 if flood else 1.4) + rng.normal(0, 0.3)
        frames.append(pd.DataFrame({
            "id": range(g * rows, (g + 1) * rows),
            "node_id": f"NODE-{g % 3}",
            "timestamp": [(start + timedelta(seconds=6 * i)).isoformat() for i in range(rows)],
            "land_use": "urban_low",
            "curve_number": 80.0,
            "rainfall_24h_mm": (60.0 if flood else 5.0) + rng.normal(0, 3, rows),
            "rainfall_intensity_mm_hr": 4.0 + rng.normal(0, 0.5, rows),
            "forecast_rainfall_6h_mm": 10.0,
            "river_level_m": level + rng.normal(0, 0.01, rows),
            "river_level_rate_m_per_hr": rng.normal(0, 0.01, rows),
            "upstream_level_m": level + rng.normal(0, 0.01, rows),
            "soil_saturation": 0.5,
            "flood_event": flood,
        }))
    return pd.concat(frames, ignore_index=True)


class FloodGroupingTests(unittest.TestCase):
    def test_groups_are_node_and_utc_day(self):
        df = pd.DataFrame({
            "node_id": ["A", "A", "A", "B"],
            "timestamp": [
                "2026-10-06T23:59:00+00:00",
                "2026-10-07T00:01:00.123456+00:00",
                "2026-10-07T04:00:00+05:30",  # 22:30 UTC on the 6th
                "2026-10-06T10:00:00+00:00",
            ],
        })
        self.assertEqual(
            list(tm.flood_row_groups(df)),
            ["A_2026-10-06", "A_2026-10-07", "A_2026-10-06", "B_2026-10-06"],
        )

    def test_event_id_overrides_where_labelled(self):
        df = pd.DataFrame({
            "node_id": ["A", "A", "B"],
            "timestamp": ["2026-10-06T10:00:00+00:00"] * 3,
            "event_id": ["storm-1", None, "storm-1"],
        })
        self.assertEqual(list(tm.flood_row_groups(df)), ["event_storm-1", "A_2026-10-06", "event_storm-1"])

    def test_template_csv_has_no_groups(self):
        df = pd.read_csv(os.path.join(ROOT, "data", "flood_history_template.csv"))
        self.assertIsNone(tm.flood_row_groups(df))

    def test_holdout_never_splits_a_group(self):
        df = _event_frame()
        groups = tm.flood_row_groups(df)
        y = df["flood_event"]
        train_idx, test_idx = tm.grouped_holdout(y, groups)
        self.assertFalse(set(groups.iloc[train_idx]) & set(groups.iloc[test_idx]))
        self.assertEqual(y.iloc[test_idx].nunique(), 2)
        self.assertEqual(y.iloc[train_idx].nunique(), 2)

    def test_too_few_flood_events_is_refused(self):
        df = _event_frame(pos_groups=2, neg_groups=5)
        with self.assertRaises(SystemExit) as ctx:
            tm.grouped_holdout(df["flood_event"], tm.flood_row_groups(df))
        self.assertIn("flood_event=1", str(ctx.exception))

    def test_calibration_folds_are_group_aware(self):
        df = _event_frame(pos_groups=4, neg_groups=5)
        groups = tm.flood_row_groups(df)
        y = df["flood_event"]
        folds = tm.grouped_calibration_folds(y, groups)
        self.assertGreaterEqual(len(folds), 2)
        for tr, te in folds:
            self.assertFalse(set(groups.iloc[tr]) & set(groups.iloc[te]))
            self.assertEqual(y.iloc[tr].nunique(), 2)

    def test_train_flood_model_uses_grouped_split_end_to_end(self):
        tmp = tempfile.mkdtemp(prefix="sj_train_")
        try:
            csv = os.path.join(tmp, "flood_history.csv")
            _event_frame(pos_groups=4, neg_groups=4, rows=25).to_csv(csv, index=False)
            seen = {}
            real_fit = tm.CalibratedClassifierCV.fit

            def spy_fit(model, X, y, *a, **k):
                seen["cv"] = model.cv
                seen["n_train"] = len(X)
                return real_fit(model, X, y, *a, **k)

            with mock.patch.object(tm, "FLOOD_CSV", csv), \
                    mock.patch.object(tm, "MODELS_DIR", tmp), \
                    mock.patch.object(tm.CalibratedClassifierCV, "fit", spy_fit), \
                    mock.patch("builtins.print"):
                model, cols = tm.train_flood_model()
            # precomputed group folds, not an integer (row-level StratifiedKFold)
            self.assertIsInstance(seen["cv"], list)
            # whole 25-row groups held out
            self.assertEqual((8 * 25 - seen["n_train"]) % 25, 0)
            self.assertTrue(os.path.exists(os.path.join(tmp, "flood_model.joblib")))
            self.assertIn("river_level_m", cols)
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
