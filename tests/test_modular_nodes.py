"""
Modular nodes (P2.7): readings that leave out sensors the node doesn't have.

Runs the real derive_features() + process_reading() with the trained models
in var/models/ (skipped if they are missing). Network calls are stubbed out.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import collections
import os
import sys
import unittest
from datetime import datetime, timedelta, timezone

import joblib
import requests
from pydantic import ValidationError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import backend_server as bs  # noqa: E402
import paths  # noqa: E402
from integration_pipeline import process_reading  # noqa: E402

MODELS = paths.MODELS_DIR
T0 = datetime(2026, 10, 7, 12, 0, tzinfo=timezone.utc)


def _offline(*_a, **_k):
    raise requests.ConnectionError("offline (test)")


@unittest.skipUnless(os.path.exists(os.path.join(MODELS, "flood_model.joblib")), "trained models not present")
class ModularNodeTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._real_get = bs.requests.get
        bs.requests.get = _offline
        cls.models = (
            joblib.load(os.path.join(MODELS, "anomaly_model.joblib")),
            joblib.load(os.path.join(MODELS, "anomaly_scaler.joblib")),
            joblib.load(os.path.join(MODELS, "flood_model.joblib")),
            joblib.load(os.path.join(MODELS, "flood_feature_cols.joblib")),
        )

    @classmethod
    def tearDownClass(cls):
        bs.requests.get = cls._real_get

    def setUp(self):
        self.tick = 0
        for node, cfg in bs._SEED_NODES.items():
            bs.NODE_REGISTRY[node] = dict(cfg)
            bs.node_history[node] = collections.deque(maxlen=bs.HISTORY_WINDOW)
            bs.node_rainfall.pop(node, None)

    def run_reading(self, **fields):
        fields.setdefault("node_id", "NODE-07")
        fields.setdefault("simulated", True)
        raw = bs.RawReading(**fields)
        self.tick += 1
        features = bs.derive_features(raw, (T0 + timedelta(seconds=10 * self.tick)).isoformat())
        return features, process_reading(features, *self.models, None, None)

    def test_reading_with_no_sensor_values_is_rejected(self):
        with self.assertRaises(ValidationError):
            bs.RawReading(node_id="NODE-07")
        with self.assertRaises(ValidationError):
            bs.RawReading(node_id="NODE-07", rainfall_mm_since_last=2.0)  # 0.0 default = can't tell "no gauge"

    def test_full_reading_still_works(self):
        _, r = self.run_reading(river_level_m=1.8, temp_c=28, humidity_pct=60, gas_ppm=410, flame_reading=0)
        self.assertEqual(r["status"], "logged")
        self.assertIn("flood", r["hazard_scores"])

    def test_landslide_only_node_detects_tilt(self):
        features, r = self.run_reading(tilt_angle_deg=12.0, vibration_magnitude=0.8)
        self.assertIsNone(features["river_level_m"])
        self.assertIsNone(features["river_level_rate_m_per_hr"])
        self.assertNotIn("flood", r["hazard_scores"])
        self.assertEqual(r["hazard_type"], "landslide")
        self.assertIn(r["severity"], ("MEDIUM", "HIGH", "CRITICAL"))

    def test_water_only_node_gets_flood_scoring(self):
        _, r = self.run_reading(river_level_m=1.8)
        self.assertIn("flood", r["hazard_scores"])
        self.assertNotIn("gas leak", r["hazard_scores"])
        self.assertEqual(r["severity"], "LOW")

    def test_gas_leak_without_water_or_dht(self):
        _, r = self.run_reading(gas_ppm=980)
        self.assertEqual(r["hazard_type"], "gas leak")
        self.assertEqual(r["status"], "alert_dispatched")

    def test_soil_only_node_is_logged_not_crashing(self):
        _, r = self.run_reading(soil_moisture_pct=40)
        self.assertEqual((r["status"], r["hazard_type"], r["severity"]), ("logged", "none", "LOW"))

    def test_impossible_value_still_suppressed_without_anomaly_model(self):
        _, r = self.run_reading(river_level_m=14.2)
        self.assertEqual(r["status"], "suppressed")

    def test_water_sensor_dropping_out_keeps_rate_history_sane(self):
        # A flat river: if the gap were treated as 0 m, the slope would be tens of m/hr.
        for _ in range(3):
            self.run_reading(river_level_m=1.80, temp_c=28, humidity_pct=60, gas_ppm=410, flame_reading=0)
        _, gap = self.run_reading(temp_c=28, humidity_pct=60, gas_ppm=410, flame_reading=0)  # HC-SR04: no echo
        self.assertNotIn("flood", gap["hazard_scores"])
        features, r = self.run_reading(river_level_m=1.80, temp_c=28, humidity_pct=60, gas_ppm=410, flame_reading=0)
        self.assertAlmostEqual(features["river_level_rate_m_per_hr"], 0.0, places=6)
        self.assertEqual(r["severity"], "LOW")

    def test_upstream_node_without_recent_level_is_ignored(self):
        # NODE-04's upstream is NODE-07; NODE-07 only sent a heat reading
        self.run_reading(node_id="NODE-07", temp_c=30)
        features, _ = self.run_reading(node_id="NODE-04", river_level_m=1.8)
        self.assertEqual(features["upstream_level_m"], 1.8)  # falls back to its own level
        self.assertEqual(features["upstream_rate_m_per_hr"], 0.0)


if __name__ == "__main__":
    unittest.main()
