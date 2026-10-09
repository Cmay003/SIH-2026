"""
Model card (upgrade "model-card", backend lane step 4):

  - GET /api/model-card: admin auth like the node-registry endpoints,
    returns ml/evaluate_models.py's JSON as-is, 404 with the command to run
    when it has not been generated, 500 when the file is broken
  - ml/evaluate_models.py: metric helpers, held-out data that is really
    held out (generators take their own rng without touching the training
    RNG), the response contract (validate_card), determinism, the
    real-data path scoring train_models.py's own whole-group test split

Uses temp folders for every file it writes - var/ is never touched. The
end-to-end card test reads the trained models in var/models (skipped if
missing) with tiny held-out sets; the edge (TensorFlow) part runs only when
tensorflow is installed.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import importlib.util
import json
import os
import shutil
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import numpy as np
import pandas as pd
from fastapi.testclient import TestClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "ml"))

import anomaly_detection  # noqa: E402
import backend_server as bs  # noqa: E402
import evaluate_models as em  # noqa: E402
import flood_risk_model  # noqa: E402
import paths  # noqa: E402
import train_models as tm  # noqa: E402

KEY = "test-admin-key"
MODELS = paths.MODELS_DIR
HAVE_MODELS = all(
    os.path.exists(os.path.join(MODELS, f))
    for f in ("flood_model.joblib", "flood_feature_cols.joblib", "anomaly_model.joblib",
              "anomaly_scaler.joblib", "river_forecast_lstm.npz")
)
HAVE_TF = importlib.util.find_spec("tensorflow") is not None
HAVE_EDGE = os.path.exists(os.path.join(paths.EDGE_BUILD_DIR, "edge_model_int8.tflite"))
SMALL = {"flood": 600, "anomaly": (300, 20), "edge": 300, "lstm": (1, 2)}


def _minimal_card():
    entries = []
    for model_id in ("flood", "anomaly_filter", "edge", "lstm"):
        entry = em.new_entry(model_id, model_id, "purpose", "where", os.path.join(MODELS, "nope.bin"))
        entries.append(em._unavailable(entry, "missing (test)"))
    return {
        "schema_version": em.SCHEMA_VERSION,
        "generated_by": "ml/evaluate_models.py",
        "seed": 1,
        "provenance": "NONE",
        "banner": "No model could be evaluated",
        "models_updated_at": None,
        "models": entries,
    }


# --- GET /api/model-card ------------------------------------------------------

class ModelCardEndpointTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sj_card_")
        self.card_path = os.path.join(self.tmp, "model_card.json")
        patches = [
            mock.patch.object(bs, "MODEL_CARD_PATH", self.card_path),
            mock.patch.object(bs, "ADMIN_API_KEY", KEY),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)
        # No `with`: the app's startup (DB, models, knowledge base) must not run.
        self.client = TestClient(bs.app)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def get(self, key=KEY):
        headers = {"X-API-Key": key} if key is not None else {}
        return self.client.get("/api/model-card", headers=headers)

    def test_missing_card_is_404_with_the_command_to_run(self):
        r = self.get()
        self.assertEqual(r.status_code, 404)
        self.assertIn("evaluate_models.py", r.json()["detail"])

    def test_returns_the_card_unchanged(self):
        card = _minimal_card()
        em.write_card(card, self.card_path)
        r = self.get()
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.json(), card)

    def test_needs_the_admin_key(self):
        em.write_card(_minimal_card(), self.card_path)
        self.assertEqual(self.get(key=None).status_code, 401)
        self.assertEqual(self.get(key="wrong").status_code, 401)

    def test_disabled_without_officer_api_key(self):
        em.write_card(_minimal_card(), self.card_path)
        with mock.patch.object(bs, "ADMIN_API_KEY", None):
            self.assertEqual(self.get().status_code, 503)

    def test_auth_is_checked_before_the_file(self):
        # An outsider must not learn whether a card exists.
        self.assertEqual(self.get(key="wrong").status_code, 401)

    def test_corrupt_card_is_500_not_404(self):
        with open(self.card_path, "w", encoding="utf-8") as f:
            f.write('{"schema_version": 1, "models": [')  # truncated
        r = self.get()
        self.assertEqual(r.status_code, 500)
        self.assertIn("evaluate_models.py", r.json()["detail"])

    def test_json_that_is_not_a_card_is_500(self):
        with open(self.card_path, "w", encoding="utf-8") as f:
            json.dump([1, 2, 3], f)
        self.assertEqual(self.get().status_code, 500)

    def test_card_path_lives_in_models_dir(self):
        self.assertEqual(paths.MODEL_CARD_PATH, os.path.join(paths.MODELS_DIR, "model_card.json"))


# --- metric helpers -------------------------------------------------------------

class MetricHelperTests(unittest.TestCase):
    def test_counts_and_rates(self):
        y = [1, 1, 1, 0, 0, 0, 0, 0]
        p = [1, 1, 0, 1, 0, 0, 0, 0]
        c = em.binary_counts(y, p)
        self.assertEqual(c, {"tp": 2, "fp": 1, "fn": 1, "tn": 4})
        r = em.binary_rates(c)
        self.assertAlmostEqual(r["false_alarm_rate"], 1 / 5, places=4)  # FP / negatives
        self.assertAlmostEqual(r["false_alert_share"], 1 / 3, places=4)  # FP / flags
        self.assertAlmostEqual(r["miss_rate"], 1 / 3, places=4)
        self.assertAlmostEqual(r["f1"], 2 / 3, places=4)

    def test_rates_with_no_flags_are_null_not_nan(self):
        r = em.binary_rates(em.binary_counts([0, 0], [0, 0]))
        self.assertIsNone(r["precision"])
        self.assertIsNone(r["recall"])
        json.dumps(r, allow_nan=False)

    def test_num_drops_nan_and_inf(self):
        self.assertIsNone(em._num(float("nan")))
        self.assertIsNone(em._num(float("inf")))
        self.assertEqual(em._num(0.123456), 0.1235)

    def test_reliability_bins_and_ece(self):
        prob = np.array([0.05] * 20 + [0.95] * 20)
        y = np.array([0] * 19 + [1] + [1] * 19 + [0])  # 5% / 95% observed
        bins, ece = em.reliability(y, prob)
        self.assertEqual(len(bins), em.RELIABILITY_BINS)
        self.assertEqual(sum(b["count"] for b in bins), 40)
        self.assertAlmostEqual(ece, 0.0, places=4)
        # p == 1.0 lands in the last bin, not off the end
        bins, _ = em.reliability([1], [1.0])
        self.assertEqual(bins[-1]["count"], 1)
        empty = bins[0]
        self.assertIsNone(empty["mean_predicted"])

    def test_overconfident_model_has_positive_ece(self):
        _, ece = em.reliability([0, 1] * 10, [0.95] * 20)
        self.assertAlmostEqual(ece, 0.45, places=4)

    def test_operating_points_match_live_severity_bands(self):
        em.check_operating_points()  # raises if the bands moved
        with mock.patch.object(em, "OPERATING_POINTS", (("HIGH", 0.6),)):
            with self.assertRaises(SystemExit):
                em.check_operating_points()


# --- held-out data ----------------------------------------------------------------

class HeldOutGeneratorTests(unittest.TestCase):
    def test_flood_generator_rng_does_not_touch_training_rng(self):
        before = flood_risk_model.RNG.bit_generator.state
        a = flood_risk_model.generate_synthetic_data(200, rng=np.random.default_rng(5))
        b = flood_risk_model.generate_synthetic_data(200, rng=np.random.default_rng(5))
        self.assertEqual(flood_risk_model.RNG.bit_generator.state, before)
        pd.testing.assert_frame_equal(a, b)

    def test_flood_default_still_draws_the_training_rows(self):
        # train_models.py's synthetic rows = the first draw of default_rng(42)
        saved = flood_risk_model.RNG
        try:
            flood_risk_model.RNG = np.random.default_rng(42)
            default = flood_risk_model.generate_synthetic_data(300)
        finally:
            flood_risk_model.RNG = saved
        explicit = flood_risk_model.generate_synthetic_data(300, rng=np.random.default_rng(42))
        pd.testing.assert_frame_equal(default, explicit)

    def test_held_out_flood_rows_differ_from_training_rows(self):
        train = flood_risk_model.generate_synthetic_data(500, rng=np.random.default_rng(42))
        child = np.random.SeedSequence(em.DEFAULT_SEED).spawn(5)[0]
        test = flood_risk_model.generate_synthetic_data(500, rng=np.random.default_rng(child))
        overlap = set(train["rainfall_24h_mm"].round(9)) & set(test["rainfall_24h_mm"].round(9))
        self.assertEqual(overlap, set())

    def test_anomaly_generator_rng_does_not_touch_training_rng(self):
        before = anomaly_detection.RNG.bit_generator.state
        a = anomaly_detection.generate_sensor_stream(100, 5, rng=np.random.default_rng(3))
        b = anomaly_detection.generate_sensor_stream(100, 5, rng=np.random.default_rng(3))
        self.assertEqual(anomaly_detection.RNG.bit_generator.state, before)
        pd.testing.assert_frame_equal(a, b)
        self.assertEqual(int(a["is_anomaly"].sum()), 5)


# --- contract -----------------------------------------------------------------------

class ContractTests(unittest.TestCase):
    def test_minimal_card_is_valid(self):
        em.validate_card(_minimal_card())

    def test_missing_key_or_bad_matrix_is_rejected(self):
        card = _minimal_card()
        del card["models"][0]["limitations"]
        with self.assertRaises(ValueError):
            em.validate_card(card)
        card = _minimal_card()
        card["models"][0]["confusion_matrices"] = [em.confusion("x", ["a", "b"], [[1, 2]])]
        with self.assertRaises(ValueError):
            em.validate_card(card)
        card = _minimal_card()
        card["models"].reverse()
        with self.assertRaises(ValueError):
            em.validate_card(card)

    def test_not_available_needs_a_reason(self):
        card = _minimal_card()
        card["models"][1]["status_reason"] = None
        with self.assertRaises(ValueError):
            em.validate_card(card)

    def test_write_card_is_strict_json_and_leaves_no_temp_file(self):
        tmp = tempfile.mkdtemp(prefix="sj_card_")
        try:
            out = os.path.join(tmp, "sub", "model_card.json")
            em.write_card(_minimal_card(), out)
            with open(out, encoding="utf-8") as f:
                self.assertEqual(json.load(f), _minimal_card())
            self.assertEqual(os.listdir(os.path.dirname(out)), ["model_card.json"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_no_models_gives_not_available_entries(self):
        tmp = tempfile.mkdtemp(prefix="sj_card_")
        try:
            with mock.patch.object(tm, "FLOOD_CSV", os.path.join(tmp, "none.csv")), \
                    mock.patch.object(tm, "ANOMALY_CSV", os.path.join(tmp, "none.csv")):
                card = em.build_card(seed=1, models_dir=tmp, sizes=SMALL,
                                     edge_build_dir=tmp, firmware_dir=tmp)
            self.assertEqual(card["provenance"], "NONE")
            self.assertEqual([e["status"] for e in card["models"]], ["not_available"] * 4)
            self.assertTrue(all(e["status_reason"] for e in card["models"]))
            self.assertIsNone(card["models_updated_at"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


# --- end to end on the trained models ------------------------------------------------

@unittest.skipUnless(HAVE_MODELS, "trained models not present in var/models")
class BuildCardTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="sj_card_")
        # Synthetic paths only (a real CSV, if someone added one, has its own test below);
        # no edge build -> no TensorFlow import here.
        with mock.patch.object(tm, "FLOOD_CSV", os.path.join(cls._tmp, "none.csv")), \
                mock.patch.object(tm, "ANOMALY_CSV", os.path.join(cls._tmp, "none.csv")):
            cls.card = em.build_card(seed=11, sizes=SMALL, edge_build_dir=cls._tmp, firmware_dir=cls._tmp)
            cls.card_again = em.build_card(seed=11, sizes=SMALL, edge_build_dir=cls._tmp, firmware_dir=cls._tmp)
            cls.card_other_seed = em.build_card(seed=12, sizes=SMALL, edge_build_dir=cls._tmp,
                                                firmware_dir=cls._tmp)
        cls.by_id = {e["id"]: e for e in cls.card["models"]}

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def test_same_seed_same_bytes(self):
        self.assertEqual(json.dumps(self.card, indent=2), json.dumps(self.card_again, indent=2))
        self.assertNotEqual(json.dumps(self.card), json.dumps(self.card_other_seed))

    def test_everything_is_labelled_synthetic(self):
        self.assertEqual(self.card["provenance"], "SYNTHETIC")
        self.assertIn("SYNTHETIC", self.card["banner"])
        for e in self.card["models"]:
            if e["status"] == "evaluated":
                self.assertEqual(e["training_data"]["provenance"], "SYNTHETIC")
                self.assertEqual(e["evaluation"]["provenance"], "SYNTHETIC")
                self.assertTrue(e["limitations"])
                self.assertTrue(any("SYNTHETIC" in s for s in e["limitations"]))

    def test_confusion_counts_sum_to_test_size(self):
        for e in self.card["models"]:
            for cm in e["confusion_matrices"]:
                self.assertEqual(sum(map(sum, cm["matrix"])), e["evaluation"]["test_size"], cm["title"])

    def test_flood_entry(self):
        flood = self.by_id["flood"]
        self.assertEqual(flood["status"], "evaluated")
        self.assertEqual(flood["evaluation"]["test_size"], SMALL["flood"])
        self.assertEqual(flood["evaluation"]["split_kind"], "independent_draw")
        self.assertEqual([o["band"] for o in flood["details"]["operating_points"]], ["MEDIUM", "HIGH", "CRITICAL"])
        # A higher cut-off can only flag fewer cases.
        flagged = [o["counts"]["tp"] + o["counts"]["fp"] for o in flood["details"]["operating_points"]]
        self.assertEqual(flagged, sorted(flagged, reverse=True))
        cal = flood["calibration"]
        self.assertTrue(cal["applicable"])
        for key in ("brier", "brier_uncalibrated", "brier_reference", "ece"):
            self.assertIsInstance(cal[key], float, key)
        self.assertEqual(sum(b["count"] for b in cal["reliability"]), SMALL["flood"])
        self.assertIsInstance(flood["beats_baseline"], bool)
        self.assertIn("river level", flood["baseline"]["name"])

    def test_anomaly_reports_held_out_and_in_sample_separately(self):
        an = self.by_id["anomaly_filter"]
        self.assertEqual(an["status"], "evaluated")
        self.assertEqual(an["evaluation"]["test_size"], sum(SMALL["anomaly"]))
        self.assertEqual(an["evaluation"]["test_positives"], SMALL["anomaly"][1])
        # The saved scaler matches the rebuilt training stream, so the old
        # in-sample figure is there to compare - and it is not the held-out one.
        self.assertIsNotNone(an["details"]["in_sample_rates"])
        self.assertNotEqual(an["details"]["in_sample_rates"], an["details"]["held_out_rates"])
        self.assertFalse(an["calibration"]["applicable"])

    def test_lstm_is_scored_on_new_catchments_against_linear_eta(self):
        lstm = self.by_id["lstm"]
        self.assertEqual(lstm["status"], "evaluated")
        self.assertEqual(lstm["evaluation"]["split_kind"], "catchment")
        self.assertEqual(set(lstm["details"]["mae_m"]), {"persistence", "linear", "lstm"})
        self.assertIn("linear", lstm["baseline"]["name"])

    def test_lstm_rise_metrics_are_labelled_by_what_they_measure(self):
        # Constructed counts: 1 TP, 1 FP, 0 FN, 9 TN. FP / (FP + TN) = 0.1 is
        # the share of calm windows warned; FP / (FP + TP) = 0.5 is the share
        # of warnings that were wrong. The old label described the second
        # number while showing the first.
        counts = {"tp": 1, "fp": 1, "fn": 0, "tn": 9}
        with mock.patch.object(em, "_rise_detection", lambda *a: (counts, em.binary_rates(counts))):
            entry = em.evaluate_lstm(MODELS, np.random.default_rng(5), catchments=1, days=2)
        rows = {m["key"]: m for m in entry["headline_metrics"]}
        self.assertAlmostEqual(rows["rise_false_alarm_rate"]["value"], 0.1, places=6)
        self.assertAlmostEqual(rows["rise_false_alert_share"]["value"], 0.5, places=6)
        self.assertFalse(rows["rise_false_alarm_rate"]["higher_is_better"])
        self.assertFalse(rows["rise_false_alert_share"]["higher_is_better"])
        labels = " ".join(m["label"] for m in entry["headline_metrics"])
        self.assertNotIn("Rises predicted that did not come", labels)
        self.assertIn("MAE", entry["details"]["beats_baseline_basis"])

    def test_edge_without_build_is_not_available(self):
        edge = self.by_id["edge"]
        self.assertEqual(edge["status"], "not_available")
        self.assertIn("edge_model_int8.tflite", edge["status_reason"])

    def test_no_absolute_paths_leak(self):
        for e in self.card["models"]:
            self.assertFalse(os.path.isabs(e["artifact"]["path"]), e["artifact"]["path"])


@unittest.skipUnless(HAVE_TF and HAVE_EDGE, "tensorflow or var/edge_ai_build/edge_model_int8.tflite missing")
class EdgeCardTests(unittest.TestCase):
    def test_edge_entry_scores_the_int8_model(self):
        entry = em.evaluate_edge(test_seed=123, n=300)
        self.assertEqual(entry["status"], "evaluated")
        self.assertEqual(entry["evaluation"]["test_size"], 300)
        (cm,) = entry["confusion_matrices"]
        self.assertEqual(cm["labels"], ["NORMAL", "WATCH", "URGENT"])
        self.assertEqual(sum(map(sum, cm["matrix"])), 300)
        self.assertIn("NOT hazard-detection accuracy", " ".join(entry["limitations"]))
        # the firmware embeds exactly this build
        self.assertTrue(entry["details"]["firmware_header_matches_tflite"])
        self.assertTrue(entry["details"]["firmware_scaler_matches"])


# --- real flood data: the card scores train_models.py's own group split ----------------

def _event_frame(pos_groups=4, neg_groups=4, rows=20, seed=3):
    rng = np.random.default_rng(seed)
    frames = []
    for g in range(pos_groups + neg_groups):
        flood = int(g < pos_groups)
        start = datetime(2026, 9, 1 + g, 10, 0, tzinfo=timezone.utc)
        level = (3.2 if flood else 1.4) + rng.normal(0, 0.3)
        frames.append(pd.DataFrame({
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


class RealFloodPathTests(unittest.TestCase):
    def test_real_csv_is_scored_on_whole_held_out_groups(self):
        tmp = tempfile.mkdtemp(prefix="sj_card_real_")
        try:
            csv = os.path.join(tmp, "flood_history.csv")
            df = _event_frame()
            df.to_csv(csv, index=False)
            with mock.patch.object(tm, "FLOOD_CSV", csv), \
                    mock.patch.object(tm, "MODELS_DIR", tmp), \
                    mock.patch("builtins.print"):
                tm.train_flood_model()
                entry = em.evaluate_flood(tmp, np.random.default_rng(0), np.random.default_rng(1))
                # the split train_models.py used
                loaded, groups, source = tm.load_flood_frame()
                X, y = loaded.drop(columns=["flood_event"]), loaded["flood_event"]
                _, X_test, _, _, groups_train = tm.split_flood_rows(X, y, groups)
            self.assertEqual(source, "real")
            test_groups = set(groups.reset_index(drop=True).iloc[X_test.index])
            self.assertFalse(test_groups & set(groups_train))

            self.assertEqual(entry["status"], "evaluated", entry["status_reason"])
            self.assertEqual(entry["evaluation"]["provenance"], "REAL")
            self.assertEqual(entry["training_data"]["provenance"], "REAL")
            self.assertEqual(entry["evaluation"]["split_kind"], "group")
            self.assertEqual(entry["evaluation"]["test_size"], len(X_test))
            self.assertEqual(entry["evaluation"]["test_size"] % 20, 0)  # whole 20-row groups
            self.assertIn("sha256", entry["training_data"]["description"])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
