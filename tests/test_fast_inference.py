"""
Step B2 (2026-10-09): backend/fast_inference.py must give EXACTLY the
numbers scikit-learn gives for the saved models (and for the synthetic
fallback models backend_server trains when none is saved), and the
pipeline must fall back to scikit-learn when the fast path is off or the
model is of another kind.
"""

import os
import sys
import unittest
import warnings

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import fast_inference as fi  # noqa: E402
import integration_pipeline as ip  # noqa: E402
from test_pipeline_integrity import HAVE_MODELS, _load_models  # noqa: E402


def _random_readings(n, seed):
    """Reading dicts across (and well beyond) normal ranges."""
    rng = np.random.default_rng(seed)
    out = []
    for _ in range(n):
        out.append({
            "river_level_m": float(rng.choice([rng.uniform(0, 6), rng.uniform(0.4, 2.5), 0.0])),
            "temp_c": float(rng.uniform(-5, 60)),
            "humidity_pct": float(rng.uniform(0, 100)),
            "gas_ppm": float(rng.choice([rng.uniform(300, 500), rng.uniform(0, 5000)])),
            "flame_reading": float(rng.choice([0.0, 1.0, rng.uniform(0, 1)])),
            "rainfall_24h_mm": float(rng.choice([0.0, rng.uniform(0, 300)])),
            "rainfall_intensity_mm_hr": float(rng.choice([0.0, rng.uniform(0, 80)])),
            "forecast_rainfall_6h_mm": rng.choice([None, 0.0, float(rng.uniform(0, 120))]),
            "curve_number": float(rng.uniform(55, 95)),
            "river_level_rate_m_per_hr": float(rng.choice([0.0, rng.uniform(-1, 3)])),
            "upstream_level_m": float(rng.uniform(0, 6)),
            "soil_saturation": float(rng.uniform(0, 1)),
            "land_use": str(rng.choice(["forest", "urban_high", "urban_low", "agricultural"])),
        })
    return out


def _sklearn_anomaly(reading, model, scaler):
    scaled = scaler.transform(pd.DataFrame([ip.anomaly_model_input(reading)]))
    return model.predict(scaled)[0] == -1, -model.score_samples(scaled)[0]


def _sklearn_flood(reading, model, cols):
    return model.predict_proba(pd.DataFrame([ip._build_flood_feature_row(reading)])[cols])[0, 1]


def _rows(readings):
    anomaly = np.array([[ip.anomaly_model_input(r)[k] for k in ip.ANOMALY_FEATURES] for r in readings])
    flood = [ip._build_flood_feature_row(r) for r in readings]
    return anomaly, flood


class _Exactness:
    """Mixin: self.models = (anomaly, scaler, flood, cols). scikit-learn
    takes ~0.1 s per ONE-row call, so the pipeline functions are compared
    one reading at a time on a small set and the fast models on 2000 rows
    in one call (each row is scored independently either way)."""

    def test_pipeline_functions_identical_one_reading_at_a_time(self):
        anomaly, scaler, flood, cols = self.models
        self.assertIsNotNone(fi.fast_isolation_forest(anomaly, scaler, ip.ANOMALY_FEATURES))
        self.assertIsNotNone(fi.fast_flood_model(flood, cols))
        for r in _random_readings(20, 1):
            fast = ip.check_anomaly(r, anomaly, scaler)
            want = _sklearn_anomaly(r, anomaly, scaler)
            self.assertEqual(bool(fast[0]), bool(want[0]), r)
            self.assertEqual(float(fast[1]), float(want[1]), r)  # exact, not approximate
            self.assertEqual(float(ip.compute_flood_risk(r, flood, cols)), float(_sklearn_flood(r, flood, cols)), r)

    def test_anomaly_flags_and_scores_identical_on_2000_rows(self):
        anomaly, scaler, _, _ = self.models
        X, _ = _rows(_random_readings(2000, 2))
        flags, scores = fi.fast_isolation_forest(anomaly, scaler, ip.ANOMALY_FEATURES).predict_and_score(X)
        scaled = scaler.transform(pd.DataFrame(X, columns=ip.ANOMALY_FEATURES))
        np.testing.assert_array_equal(flags, anomaly.predict(scaled) == -1)
        np.testing.assert_array_equal(scores, -anomaly.score_samples(scaled))
        self.assertTrue(50 < flags.sum() < 1950, flags.sum())  # outliers AND inliers

    def test_flood_probability_identical_on_2000_rows(self):
        _, _, flood, cols = self.models
        _, rows = _rows(_random_readings(2000, 3))
        X = np.array([[np.nan if row[c] is None else row[c] for c in cols] for row in rows])
        got = fi.fast_flood_model(flood, cols).predict_proba(X)
        want = flood.predict_proba(pd.DataFrame(rows)[cols])
        np.testing.assert_array_equal(got, want)
        self.assertLess(want[:, 1].min(), 0.2)
        self.assertGreater(want[:, 1].max(), 0.8)


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class SavedModelExactnessTests(_Exactness, unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = _load_models()


class FallbackModelExactnessTests(_Exactness, unittest.TestCase):
    """The models backend_server trains itself when var/models is empty."""

    @classmethod
    def setUpClass(cls):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            flood, cols = ip.train_flood_model()
            anomaly, scaler = ip.train_anomaly_detector()
        cls.models = (anomaly, scaler, flood, cols)


class FallbackToSklearnTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            cls.anomaly, cls.scaler = ip.train_anomaly_detector()

    def test_switch_off_uses_sklearn(self):
        r = _random_readings(1, 4)[0]
        os.environ[fi.FAST_INFERENCE_ENV] = "0"
        try:
            self.assertIsNone(fi.fast_isolation_forest(self.anomaly, self.scaler, ip.ANOMALY_FEATURES))
            off = ip.check_anomaly(r, self.anomaly, self.scaler)
        finally:
            os.environ.pop(fi.FAST_INFERENCE_ENV, None)
        on = ip.check_anomaly(r, self.anomaly, self.scaler)
        self.assertEqual((bool(off[0]), float(off[1])), (bool(on[0]), float(on[1])))

    def test_unknown_model_kind_is_not_accelerated(self):
        from sklearn.linear_model import LogisticRegression

        X = pd.DataFrame({"a": [0.0, 1.0, 2.0, 3.0], "b": [1.0, 0.0, 1.0, 0.0]})
        lr = LogisticRegression().fit(X, [0, 0, 1, 1])
        self.assertIsNone(fi.fast_flood_model(lr, ["a", "b"]))
        # wrong column list for the scaler: refused, sklearn keeps working
        self.assertIsNone(fi.fast_isolation_forest(self.anomaly, self.scaler, ["x"] * 5))

    def test_probe_mismatch_refuses_the_fast_path(self):
        fi._iforest_cache.clear()
        real = fi.FastIsolationForest.predict_and_score

        def off_by_one_bit(self, X):
            flags, scores = real(self, X)
            return flags, np.nextafter(scores, np.inf)

        fi.FastIsolationForest.predict_and_score = off_by_one_bit
        try:
            self.assertIsNone(fi.fast_isolation_forest(self.anomaly, self.scaler, ip.ANOMALY_FEATURES))
        finally:
            fi.FastIsolationForest.predict_and_score = real
            fi._iforest_cache.clear()
        self.assertIsNotNone(fi.fast_isolation_forest(self.anomaly, self.scaler, ip.ANOMALY_FEATURES))


if __name__ == "__main__":
    unittest.main()
