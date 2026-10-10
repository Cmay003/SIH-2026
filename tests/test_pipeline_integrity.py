"""
Pipeline / data-integrity fixes (progress.txt section 4, backend lane):

  - one faulty or saturated sensor no longer suppresses the whole reading;
    gas at the firmware clamp (65535) is saturated-high, not impossible
  - simulated readings never corroborate a real alert or feed a real
    node's upstream features
  - stale upstream level/rate is ignored
  - node health remembers the normal interval across an elevated burst
  - the river forecast and interval estimate skip 'untimed' backlog rows
  - NODE_REGISTRY is swapped under the ingest lock

Uses a throwaway SQLite file (backend_server.DB_PATH is pointed at it), so
var/sanjeevni.db is never touched. Network calls are stubbed out. Tests that
need the trained models in var/models/ are skipped if they are missing.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import collections
import os
import shutil
import sqlite3
import sys
import tempfile
import threading
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import joblib
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import backend_server as bs  # noqa: E402
import hazard_confirmation as hc  # noqa: E402
import integration_pipeline as ip  # noqa: E402
import paths  # noqa: E402

MODELS = paths.MODELS_DIR
HAVE_MODELS = os.path.exists(os.path.join(MODELS, "flood_model.joblib"))
T0 = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def _offline(*_a, **_k):
    raise requests.ConnectionError("offline (test)")


def _load_models():
    return (
        joblib.load(os.path.join(MODELS, "anomaly_model.joblib")),
        joblib.load(os.path.join(MODELS, "anomaly_scaler.joblib")),
        joblib.load(os.path.join(MODELS, "flood_model.joblib")),
        joblib.load(os.path.join(MODELS, "flood_feature_cols.joblib")),
    )


def _reset_nodes():
    for node, cfg in bs._SEED_NODES.items():
        bs.NODE_REGISTRY[node] = {**cfg, "report_interval_seconds": None}
        bs.node_history[node] = collections.deque(maxlen=bs.HISTORY_WINDOW)
        bs.node_health[node] = {}
        bs.node_rainfall.pop(node, None)


class TempDbMixin:
    """Points backend_server at an empty temp database for one test class."""

    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="sj_test_")
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


# --- one bad / saturated sensor -------------------------------------------

class FaultyFieldTests(unittest.TestCase):
    """Pure functions - no models needed."""

    def test_only_out_of_range_fields_are_dropped(self):
        reading = {"river_level_m": 14.2, "river_level_rate_m_per_hr": 5.0, "gas_ppm": 950,
                   "temp_c": 30, "location": "x"}
        clean, faults = ip.drop_implausible_fields(reading)
        self.assertEqual(faults, ["river_level_m"])
        self.assertIsNone(clean["river_level_m"])
        # the rise rate came from the bad level, so it goes too - it could
        # otherwise pass is_flood_signature on its own
        self.assertIsNone(clean["river_level_rate_m_per_hr"])
        self.assertEqual((clean["gas_ppm"], clean["temp_c"]), (950, 30))
        self.assertEqual(reading["river_level_m"], 14.2)  # caller's dict untouched

    def test_gas_at_firmware_clamp_is_saturated_not_impossible(self):
        self.assertEqual(ip.implausible_fields({"gas_ppm": 65535}), [])
        self.assertEqual(ip.saturated_fields({"gas_ppm": 65535}), ["gas_ppm"])
        self.assertEqual(ip.saturated_fields({"gas_ppm": 950}), [])
        self.assertEqual(ip.implausible_fields({"gas_ppm": 70000}), ["gas_ppm"])  # firmware can't send it

    def test_clean_reading_is_returned_as_is(self):
        reading = {"river_level_m": 1.8, "gas_ppm": 410}
        self.assertEqual(ip.drop_implausible_fields(reading), (reading, []))


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class FaultyFieldPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = _load_models()

    def run_pipeline(self, **overrides):
        reading = {**ip.demo_readings()[3], **overrides}  # the CRITICAL flood demo reading
        return ip.process_reading(reading, *self.models, None, None)

    def test_flood_still_alerts_when_gas_channel_is_impossible(self):
        r = self.run_pipeline(gas_ppm=70000)
        self.assertEqual(r["status"], "alert_dispatched")
        self.assertEqual(r["hazard_type"], "flood")
        self.assertEqual(r["sensor_faults"], ["gas_ppm"])
        self.assertNotIn("gas leak", r["hazard_scores"])

    def test_saturated_gas_is_a_critical_leak_not_a_fault(self):
        r = self.run_pipeline(gas_ppm=65535)
        self.assertEqual(r["status"], "alert_dispatched")
        self.assertEqual(r["hazard_scores"]["gas leak"]["severity"], "CRITICAL")
        self.assertIn("flood", r["hazard_scores"])
        self.assertEqual(r["saturated_sensors"], ["gas_ppm"])
        self.assertNotIn("sensor_faults", r)

    def test_gas_leak_still_alerts_when_water_channel_is_impossible(self):
        r = self.run_pipeline(river_level_m=14.2, river_level_rate_m_per_hr=5.0, gas_ppm=950)
        self.assertEqual((r["status"], r["hazard_type"]), ("alert_dispatched", "gas leak"))
        self.assertEqual(r["sensor_faults"], ["river_level_m"])
        self.assertNotIn("flood", r["hazard_scores"])

    def test_fault_with_nothing_else_elevated_is_still_suppressed(self):
        r = self.run_pipeline(river_level_m=14.2, rainfall_intensity_mm_hr=0, gas_ppm=410)
        self.assertEqual((r["status"], r["hazard_type"]), ("suppressed", "sensor_fault"))
        self.assertEqual(r["reason"], "physically_impossible_river_level_m")
        self.assertEqual(r["sensor_faults"], ["river_level_m"])


# --- simulated vs real corroboration ----------------------------------------

REGISTRY = {
    "NODE-04": {"latitude": 29.3919, "longitude": 79.4542, "upstream_node": "NODE-07"},
    "NODE-INDB": {"latitude": 29.3850, "longitude": 79.4480, "upstream_node": None},  # ~1 km away
}


class SimulatedConfirmationTests(unittest.TestCase):
    def test_simulated_neighbour_does_not_confirm_a_real_alert(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-INDB", "gas leak", "CRITICAL", T0, REGISTRY, simulated=True)
        self.assertEqual(c.assess("NODE-04", "gas leak", "CRITICAL", T0 + timedelta(seconds=5), REGISTRY),
                         (False, None))

    def test_simulated_reading_on_same_node_does_not_make_a_real_one_persistent(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-04", "flood", "HIGH", T0, REGISTRY, simulated=True)
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", T0 + timedelta(seconds=5), REGISTRY),
                         (False, None))

    def test_simulated_readings_still_confirm_each_other(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-INDB", "gas leak", "CRITICAL", T0, REGISTRY, simulated=True)
        self.assertEqual(
            c.assess("NODE-04", "gas leak", "CRITICAL", T0 + timedelta(seconds=5), REGISTRY, simulated=True),
            (True, "neighbour:NODE-INDB"),
        )

    def test_real_evidence_can_confirm_a_simulated_alert(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-INDB", "gas leak", "CRITICAL", T0, REGISTRY)
        self.assertEqual(
            c.assess("NODE-04", "gas leak", "CRITICAL", T0 + timedelta(seconds=5), REGISTRY, simulated=True),
            (True, "neighbour:NODE-INDB"),
        )


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class IngestTests(TempDbMixin, unittest.TestCase):
    """End to end through ingest_reading() on the temp database."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls._real_models = (bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols)
        bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols = _load_models()

    @classmethod
    def tearDownClass(cls):
        bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols = cls._real_models
        super().tearDownClass()

    def setUp(self):
        _reset_nodes()
        self._real_confirmer = bs._confirmer
        bs._confirmer = bs.HazardConfirmer()

    def tearDown(self):
        bs._confirmer = self._real_confirmer

    def test_simulator_event_does_not_publish_a_real_glitch(self):
        sim = bs.ingest_reading(bs.RawReading(node_id="NODE-INDB", simulated=True, gas_ppm=950))
        self.assertEqual(sim["status"], "pending_confirmation")
        real = bs.ingest_reading(bs.RawReading(node_id="NODE-04", gas_ppm=950))
        self.assertEqual(real["status"], "pending_confirmation")
        self.assertEqual(real["confirmation"], "unconfirmed")

    def test_two_simulated_readings_still_confirm(self):
        bs.ingest_reading(bs.RawReading(node_id="NODE-INDB", simulated=True, gas_ppm=950))
        second = bs.ingest_reading(bs.RawReading(node_id="NODE-04", simulated=True, gas_ppm=950))
        self.assertEqual((second["status"], second["confirmation"]), ("alert_dispatched", "neighbour:NODE-INDB"))

    def test_faulty_channel_is_stored_as_null_with_the_fault_recorded(self):
        r = bs.ingest_reading(bs.RawReading(node_id="NODE-INDB", simulated=True, gas_ppm=950,
                                            river_level_m=14.2, reading_uid="fault-1"))
        self.assertEqual(r["hazard_type"], "gas leak")
        self.assertIsNone(r["river_level_m"])
        conn = sqlite3.connect(bs.DB_PATH)
        row = conn.execute("SELECT river_level_m, river_level_rate_m_per_hr, gas_ppm, sensor_faults "
                           "FROM readings WHERE reading_uid='fault-1'").fetchone()
        conn.close()
        self.assertEqual(row, (None, None, 950.0, "river_level_m"))
        self.assertIsNone(bs.node_history["NODE-INDB"][-1]["river_level_m"])  # kept out of rates too


# --- upstream features ---------------------------------------------------------

class UpstreamFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._real_get = bs.requests.get
        bs.requests.get = _offline

    @classmethod
    def tearDownClass(cls):
        bs.requests.get = cls._real_get

    def setUp(self):
        _reset_nodes()

    def rising_upstream(self, last_at, simulated=True):
        """NODE-07 rising 1.0 -> 1.6 m over 15 min, last reading at last_at."""
        for i in range(16):
            raw = bs.RawReading(node_id="NODE-07", simulated=simulated, river_level_m=1.0 + 0.04 * i)
            bs.derive_features(raw, (last_at - timedelta(minutes=15 - i)).isoformat())

    def downstream(self, simulated=True):
        raw = bs.RawReading(node_id="NODE-04", simulated=simulated, river_level_m=1.8)
        return bs.derive_features(raw, T0.isoformat())

    def test_fresh_upstream_rise_is_used(self):
        self.rising_upstream(T0 - timedelta(minutes=1))
        f = self.downstream()
        self.assertGreater(f["upstream_rate_m_per_hr"], 1.0)
        self.assertAlmostEqual(f["upstream_level_m"], 1.6, places=6)

    def test_six_hour_old_upstream_rise_is_ignored(self):
        self.rising_upstream(T0 - timedelta(hours=6))
        f = self.downstream()
        self.assertEqual(f["upstream_rate_m_per_hr"], 0.0)
        self.assertEqual(f["upstream_level_m"], f["river_level_m"])

    def test_simulated_upstream_never_feeds_a_real_node(self):
        self.rising_upstream(T0 - timedelta(minutes=1), simulated=True)
        f = self.downstream(simulated=False)
        self.assertEqual(f["upstream_rate_m_per_hr"], 0.0)
        self.assertEqual(f["upstream_level_m"], f["river_level_m"])

    def test_slow_upstream_node_gets_a_few_of_its_intervals(self):
        bs.NODE_REGISTRY["NODE-07"]["report_interval_seconds"] = 600  # 30 min allowance
        self.rising_upstream(T0 - timedelta(minutes=25))
        self.assertGreater(self.downstream()["upstream_rate_m_per_hr"], 0.0)

    def test_impossible_values_are_kept_out_of_history(self):
        raw = bs.RawReading(node_id="NODE-07", simulated=True, river_level_m=14.2, gas_ppm=70000, temp_c=30)
        bs.derive_features(raw, T0.isoformat())
        entry = bs.node_history["NODE-07"][-1]
        self.assertEqual((entry["river_level_m"], entry["raw_water_level_m"], entry["gas_ppm"], entry["temp_c"]),
                         (None, None, None, 30))
        self.assertTrue(entry["simulated"])


# --- node health -------------------------------------------------------------------

class NodeHealthIntervalTests(unittest.TestCase):
    def setUp(self):
        _reset_nodes()

    def report(self, at):
        # A siren node: its normal-time summary is every 60 s (user
        # decision (1), 2026-10-09; a node without a siren reports every
        # 300 s - tests/test_false_alarms.py NodeHealthDecisionTests).
        bs.node_history["NODE-07"].append({"timestamp": at})
        bs.update_node_health(bs.RawReading(node_id="NODE-07", temp_c=25, siren_fitted=True), at, at, [])

    def status_at(self, now):
        return next(n for n in bs.compute_node_health(now) if n["node_id"] == "NODE-07")

    def test_expected_gap_ignores_one_outage(self):
        ts = [T0 + timedelta(seconds=60 * i) for i in range(10)] + [T0 + timedelta(seconds=540 + 3600)]
        self.assertEqual(bs.expected_gap_seconds(ts), 60)

    def test_node_is_online_right_after_an_elevated_burst(self):
        t = T0
        for _ in range(11):  # normal 60 s heartbeat
            self.report(t)
            t += timedelta(seconds=60)
        for _ in range(10):  # hazard: 5 s cadence, then back to 60 s
            self.report(t)
            t += timedelta(seconds=5)
        last = t - timedelta(seconds=5)
        node = self.status_at(last + timedelta(seconds=65))
        self.assertEqual(node["status"], "online")
        self.assertEqual(node["expected_interval_seconds"], 60)

    def test_a_node_that_really_goes_silent_is_still_flagged(self):
        t = T0
        for _ in range(11):
            self.report(t)
            t += timedelta(seconds=60)
        node = self.status_at(t + timedelta(minutes=7))
        self.assertEqual(node["status"], "offline")

    def test_memory_expires_so_a_retuned_node_is_relearned(self):
        health = {"observed_interval_seconds": 300.0,
                  "observed_interval_at": (T0 - timedelta(hours=25)).isoformat()}
        hist = [{"timestamp": T0 + timedelta(seconds=60 * i)} for i in range(11)]
        bs.remember_report_interval(health, hist, T0 + timedelta(minutes=10))
        self.assertEqual(health["observed_interval_seconds"], 60)


# --- 'untimed' backlog rows ----------------------------------------------------------

class UntimedRowTests(TempDbMixin, unittest.TestCase):
    def setUp(self):
        _reset_nodes()
        conn = sqlite3.connect(bs.DB_PATH)
        conn.execute("DELETE FROM readings")
        now = datetime.now(timezone.utc)
        for m in range(150, 0, -1):  # 150 min of a steady 3.0 m river
            conn.execute("INSERT INTO readings (node_id, river_level_m, status, timestamp) VALUES (?,?,?,?)",
                         ("NODE-04", 3.0, "logged", (now - timedelta(minutes=m)).isoformat()))
        # an hours-old backlog reading, stamped with its arrival time (R6)
        conn.execute("INSERT INTO readings (node_id, river_level_m, status, timestamp) VALUES (?,?,?,?)",
                     ("NODE-04", 1.2, "untimed", now.isoformat()))
        conn.commit()
        conn.close()

    def test_forecast_ignores_untimed_rows(self):
        seen = {}

        def capture(parsed, end):
            seen["levels"] = [level for _, level, _ in parsed]
            return {"available": True, "current_level_m": parsed[-1][1]}

        with mock.patch.object(bs.river_forecast, "forecast_from_readings", side_effect=capture):
            out = bs.get_river_forecast("NODE-04")
        self.assertEqual(out["current_level_m"], 3.0)
        self.assertNotIn(1.2, seen["levels"])

    def test_interval_estimate_ignores_untimed_rows(self):
        conn = sqlite3.connect(bs.DB_PATH)
        # a long backlog trickling in after reboots: arrival times 1 s apart
        later = datetime.now(timezone.utc)
        for s in range(1, 61):
            conn.execute("INSERT INTO readings (node_id, river_level_m, status, timestamp) VALUES (?,?,?,?)",
                         ("NODE-04", 1.2, "untimed", (later + timedelta(seconds=s)).isoformat()))
        self.assertEqual(bs.observed_interval_from_db(conn, "NODE-04"), 60)
        conn.close()


# --- NODE_REGISTRY reload -------------------------------------------------------------

class RegistryReloadTests(TempDbMixin, unittest.TestCase):
    def test_reload_waits_for_ingest_and_keeps_the_same_dict(self):
        registry = bs.NODE_REGISTRY
        registry.clear()
        registry["MARKER"] = {"location": "old"}
        bs._ingest_lock.acquire()
        try:
            worker = threading.Thread(target=bs.reload_node_registry)
            worker.start()
            worker.join(timeout=0.3)
            # An ingest holding the lock must never see a half-built registry
            self.assertTrue(worker.is_alive())
            self.assertEqual(list(registry), ["MARKER"])
        finally:
            bs._ingest_lock.release()
        worker.join(timeout=5)
        self.assertFalse(worker.is_alive())
        self.assertIs(bs.NODE_REGISTRY, registry)
        self.assertEqual(set(registry), set(bs._SEED_NODES))
        for node in bs._SEED_NODES:
            self.assertIn(node, bs.node_history)
            self.assertIn(node, bs.node_health)

    # Fresh tracking dicts: other tests here leave hand-made history
    # entries (no river_level_m) that get_nodes() would trip over.
    @mock.patch.object(bs, "node_health", {})
    @mock.patch.object(bs, "node_history", {})
    def test_new_node_has_history_before_it_is_visible(self):
        # get_nodes() runs outside the ingest lock: a node it can see in
        # NODE_REGISTRY must already have a node_history entry, or the
        # direct lookup used to raise KeyError -> 500 for a just-added node.
        conn = sqlite3.connect(bs.DB_PATH)
        conn.execute("INSERT INTO nodes (node_id, location, land_use, curve_number, latitude, longitude) "
                     "VALUES ('LATE-1', 'Late node', 'forest', 55, 29.4, 79.45)")
        conn.commit()
        conn.close()
        bs.node_history.pop("LATE-1", None)
        bs.node_health.pop("LATE-1", None)

        seen = {}

        class SpyRegistry(dict):
            def update(self, *args, **kwargs):
                super().update(*args, **kwargs)
                # the moment the new node becomes visible to readers
                seen["missing_history"] = [n for n in self if n not in bs.node_history]
                seen["nodes"] = bs.get_nodes()

        real = bs.NODE_REGISTRY
        bs.NODE_REGISTRY = SpyRegistry(real)
        try:
            bs.reload_node_registry()
        finally:
            real.clear()
            real.update(bs.NODE_REGISTRY)
            bs.NODE_REGISTRY = real
            conn = sqlite3.connect(bs.DB_PATH)
            conn.execute("DELETE FROM nodes WHERE node_id='LATE-1'")
            conn.commit()
            conn.close()
            bs.reload_node_registry()
            bs.node_history.pop("LATE-1", None)
            bs.node_health.pop("LATE-1", None)
        self.assertEqual(seen["missing_history"], [])
        late = [n for n in seen["nodes"] if n["node_id"] == "LATE-1"]
        self.assertEqual(len(late), 1)
        self.assertEqual(late[0]["reading_count"], 0)

    @mock.patch.object(bs, "node_history", {})
    def test_get_nodes_tolerates_a_node_without_history(self):
        bs.NODE_REGISTRY["GHOST-1"] = {"location": "g", "land_use": "forest", "latitude": 29.0, "longitude": 79.0}
        bs.node_history.pop("GHOST-1", None)
        try:
            ghost = [n for n in bs.get_nodes() if n["node_id"] == "GHOST-1"]
        finally:
            bs.NODE_REGISTRY.pop("GHOST-1", None)
        self.assertEqual(len(ghost), 1)
        self.assertEqual(ghost[0]["reading_count"], 0)
        self.assertIsNone(ghost[0]["last_river_level_m"])


if __name__ == "__main__":
    unittest.main()
