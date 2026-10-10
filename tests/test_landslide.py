"""
Landslide rainfall trigger (upgrade "landslide-rain-trigger"):

  - the Caine (1980) intensity-duration threshold gives an early WATCH
    (MEDIUM, trigger "rain") before any tilt
  - wet antecedent soil lowers the rain needed for that WATCH
  - rain alone never goes above MEDIUM; rain + tilt past the confirm angle
    is at least HIGH (trigger "both"); tilt alone is scored exactly as before
  - a node without a tilt sensor only gets the rain trigger when the
    registry marks it as a slope node (per-node threshold override)
  - the override is stored per node and a PUT that leaves it out keeps it
  - the rainfall soil proxy has the storm's own rain removed before the
    antecedent test (a storm cannot be its own antecedent wetness)
  - an impossible rain value is a sensor fault, kept out of the rain log;
    one rain report alone can never trigger (nor self-confirm) a WATCH

Pure classifier tests need nothing. Pipeline tests use the trained models in
var/models/ (skipped if missing) and a throwaway SQLite file - never
var/sanjeevni.db. Network calls are stubbed out.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import collections
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import joblib
import requests
from pydantic import ValidationError

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import backend_server as bs  # noqa: E402
import hazard_classification as hcl  # noqa: E402
import integration_pipeline as ip  # noqa: E402
import paths  # noqa: E402
from rag_alert_pipeline import generate_alert_message  # noqa: E402

MODELS = paths.MODELS_DIR
HAVE_MODELS = os.path.exists(os.path.join(MODELS, "flood_model.joblib"))
T0 = datetime(2026, 10, 8, 6, 0, tzinfo=timezone.utc)


def _offline(*_a, **_k):
    raise requests.ConnectionError("offline (test)")


def windows(**mm_by_hours):
    """windows(h1=20, h24=40) -> {1: 20, 24: 40}"""
    return {int(k[1:]): v for k, v in mm_by_hours.items()}


def old_tilt_score(tilt, vibration):
    """The pre-upgrade classify_landslide() formula, for regression checks."""
    return 0.7 * min(1.0, abs(tilt) / 15.0) + 0.3 * min(1.0, (vibration or 0) / 2.0)


class CaineThresholdTests(unittest.TestCase):
    def test_matches_the_published_table(self):
        # Caine (1980) as tabulated in NRCan climate-change report 72:
        # duration (h) -> intensity (mm/h) needed for initiation.
        table = {0.25: 25.4, 1: 14.8, 2: 11.3, 6: 7.4, 12: 5.6, 24: 4.3}
        for hours, mm_hr in table.items():
            self.assertAlmostEqual(hcl.caine_threshold_mm_hr(hours), mm_hr, delta=0.05, msg=hours)

    def test_override_constants_are_used(self):
        self.assertAlmostEqual(hcl.caine_threshold_mm_hr(1, alpha=5.0, beta=0.5), 5.0)
        self.assertAlmostEqual(hcl.caine_threshold_mm_hr(4, alpha=5.0, beta=0.5), 2.5)


class RainTriggerClassifierTests(unittest.TestCase):
    """classify_landslide() on hand-built readings."""

    def classify(self, **reading):
        return hcl.classify_landslide(reading)

    def test_dry_slope_heavy_rain_gives_medium_watch(self):
        r = self.classify(tilt_angle_deg=0.4, vibration_magnitude=0.02,
                          rainfall_windows_mm=windows(h1=20, h3=20, h6=20, h12=20, h24=20),
                          soil_saturation=0.3)
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))
        self.assertEqual(r["rain_window_hours"], 1)
        self.assertAlmostEqual(r["rain_exceedance"], 20 / 14.82, places=3)
        self.assertEqual(r["rain_threshold_source"], "caine_1980_global")
        self.assertFalse(r["antecedent_saturated"])

    def test_rain_plus_five_degrees_tilt_is_high_both(self):
        r = self.classify(tilt_angle_deg=5.0, vibration_magnitude=0.0,
                          rainfall_windows_mm=windows(h1=20, h24=20), soil_saturation=0.3)
        self.assertEqual((r["severity"], r["trigger"]), ("HIGH", "both"))
        # without the rain the same tilt is LOW
        self.assertEqual(self.classify(tilt_angle_deg=5.0, vibration_magnitude=0.0)["severity"], "LOW")

    def test_negative_tilt_confirms_too(self):
        r = self.classify(tilt_angle_deg=-6.0, rainfall_windows_mm=windows(h1=20))
        self.assertEqual(r["trigger"], "both")

    def test_rain_alone_never_goes_above_medium(self):
        r = self.classify(tilt_angle_deg=0.0,
                          rainfall_windows_mm=windows(h1=150, h3=400, h6=500, h12=500, h24=500),
                          soil_saturation=1.0)
        self.assertEqual(r["severity"], "MEDIUM")
        self.assertLessEqual(r["risk_score"], hcl.RAIN_ONLY_MAX_RISK)

    def test_vibration_alone_does_not_confirm_rain(self):
        # heavy rain shakes a pole too - only tilt confirms ground movement
        r = self.classify(tilt_angle_deg=1.0, vibration_magnitude=2.0,
                          rainfall_windows_mm=windows(h1=20))
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))

    def test_critical_tilt_stays_critical_with_rain(self):
        r = self.classify(tilt_angle_deg=20.0, vibration_magnitude=2.0,
                          rainfall_windows_mm=windows(h1=20))
        self.assertEqual((r["severity"], r["trigger"]), ("CRITICAL", "both"))

    def test_storm_seen_only_in_the_six_hour_window(self):
        # 60 mm in 6 h = 10 mm/h: above Caine's 6 h threshold (7.4 mm/h) but
        # below both the 1 h (14.8) and 24 h (4.3 mm/h = 103 mm) ones.
        storm = windows(h1=10, h3=30, h6=60, h12=60, h24=60)
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=storm)
        self.assertEqual((r["severity"], r["trigger"], r["rain_window_hours"]), ("MEDIUM", "rain", 6))
        # the old 1 h / 24 h fields alone would miss it
        r = self.classify(tilt_angle_deg=0.0, rainfall_intensity_mm_hr=10, rainfall_24h_mm=60)
        self.assertEqual(r["severity"], "LOW")

    def test_falls_back_to_1h_and_24h_fields(self):
        r = self.classify(tilt_angle_deg=0.0, rainfall_intensity_mm_hr=16, rainfall_24h_mm=16)
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))

    def test_saturated_soil_lowers_the_threshold(self):
        rain = windows(h1=9, h24=9)  # 9 / 14.82 = 0.61 of the threshold
        dry = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, soil_saturation=0.3)
        wet = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, soil_saturation=0.85)
        self.assertEqual((dry["severity"], dry["trigger"]), ("LOW", None))
        self.assertEqual((wet["severity"], wet["trigger"]), ("MEDIUM", "rain"))
        self.assertTrue(wet["antecedent_saturated"])

    def test_saturated_soil_raises_the_score_within_medium(self):
        rain = windows(h1=20)
        dry = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, soil_saturation=0.3)
        wet = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, soil_saturation=0.9)
        self.assertGreater(wet["risk_score"], dry["risk_score"])
        self.assertEqual(wet["severity"], "MEDIUM")

    # --- antecedent wetness: the proxy must not count the storm itself ----
    # 60 mm in 12 h = 0.889 of Caine's 12 h threshold: LOW on dry soil,
    # MEDIUM only if the soil was wet BEFORE the storm.
    STORM_60MM = windows(h1=5, h3=15, h6=30, h12=60, h24=60)

    def test_proxy_saturation_has_the_storms_own_rain_removed(self):
        # 0.92 is what the rainfall proxy reaches after this very 60 mm
        # (0.32 before it), so the slope was not wet beforehand.
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=self.STORM_60MM,
                          soil_saturation=0.92, soil_saturation_source="rainfall_proxy")
        self.assertEqual((r["severity"], r["trigger"]), ("LOW", None))
        self.assertFalse(r["antecedent_saturated"])
        self.assertAlmostEqual(r["rain_exceedance"], 0.889, places=3)

    def test_sensor_saturation_is_used_as_it_is(self):
        # A capacitive sensor measures the soil, not the rain gauge.
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=self.STORM_60MM,
                          soil_saturation=0.92, soil_saturation_source="sensor")
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))
        self.assertTrue(r["antecedent_saturated"])

    def test_proxy_wet_before_the_storm_still_counts(self):
        # 0.85 - 9 mm * 0.01 = 0.76 before the storm: not saturated, so
        # 9 mm in 1 h (0.61 of the threshold) stays LOW...
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=9, h24=9),
                          soil_saturation=0.85, soil_saturation_source="rainfall_proxy")
        self.assertEqual((r["severity"], r["antecedent_saturated"]), ("LOW", False))
        # ...while 0.85 - 0.02 = 0.83 means the wetness really came first
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=2, h24=2),
                          soil_saturation=0.85, soil_saturation_source="rainfall_proxy")
        self.assertTrue(r["antecedent_saturated"])
        # and a slope that was wet first (0.92 - 0.09 = 0.83) gets the
        # lowered threshold for the same 9 mm
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=9, h24=9),
                          soil_saturation=0.92, soil_saturation_source="rainfall_proxy")
        self.assertEqual((r["severity"], r["trigger"], r["antecedent_saturated"]), ("MEDIUM", "rain", True))

    def test_proxy_constant_is_shared_with_the_backend(self):
        self.assertEqual(bs.SOIL_SATURATION_PER_MM, hcl.PROXY_SATURATION_PER_MM)

    # --- one rain report cannot trigger on its own ------------------------
    def test_single_report_window_is_reported_but_does_not_trigger(self):
        rain = windows(h1=20, h3=20, h6=20, h12=20, h24=20)
        one = {h: 1 for h in rain}
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, rainfall_windows_count=one)
        self.assertEqual((r["severity"], r["trigger"]), ("LOW", None))
        # still shown to the officer: how close the rain is
        self.assertAlmostEqual(r["rain_exceedance"], 20 / 14.82, places=3)
        self.assertEqual(r["rain_window_hours"], 1)
        two = {h: 2 for h in rain}
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain, rainfall_windows_count=two)
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))

    def test_only_windows_with_two_reports_can_trigger(self):
        # 1 h window: one 20 mm report (would trigger); 24 h window: two
        # reports but only 21 mm (0.2 of the 24 h threshold) -> LOW.
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=20, h24=21),
                          rainfall_windows_count={1: 1, 24: 2})
        self.assertEqual(r["severity"], "LOW")

    def test_saturated_soil_without_rain_raises_nothing(self):
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=0, h24=0), soil_saturation=1.0)
        self.assertEqual((r["severity"], r["trigger"]), ("LOW", None))

    def test_tilt_only_scoring_is_unchanged(self):
        for tilt in (0.0, 2.0, 5.0, 9.0, 12.0, 15.0, 30.0):
            for vib in (None, 0.0, 0.5, 1.5, 3.0):
                with self.subTest(tilt=tilt, vib=vib):
                    expected = round(old_tilt_score(tilt, vib), 4)
                    # no rain keys at all, and rain keys that are all dry
                    for extra in ({}, {"rainfall_windows_mm": windows(h1=0, h24=0), "soil_saturation": 0.3}):
                        r = self.classify(tilt_angle_deg=tilt, vibration_magnitude=vib, **extra)
                        self.assertEqual(r["risk_score"], expected)
                        self.assertEqual(r["severity"], hcl.severity_band(expected))
                        self.assertEqual(r["trigger"], None if r["severity"] == "LOW" else "tilt")

    def test_no_tilt_and_no_rain_data_gives_nothing(self):
        self.assertIsNone(self.classify())
        self.assertIsNone(self.classify(temp_c=30))

    def test_no_tilt_sensor_node_without_override_never_gets_a_landslide(self):
        # a rain gauge on a river-plain flood node is not a slope
        self.assertIsNone(self.classify(rainfall_windows_mm=windows(h1=40, h24=200), soil_saturation=1.0))

    def test_no_tilt_sensor_node_with_override_gets_the_rain_watch(self):
        r = self.classify(rainfall_windows_mm=windows(h1=20, h24=20), landslide_rain_alpha=14.82)
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))
        self.assertEqual(r["rain_threshold_source"], "node_override")
        # and it reports LOW (not None) when dry, so officers see it is watched
        r = self.classify(rainfall_windows_mm=windows(h1=0, h24=0), landslide_rain_alpha=14.82)
        self.assertEqual((r["severity"], r["trigger"]), ("LOW", None))

    def test_node_override_changes_the_threshold(self):
        rain = windows(h1=6, h24=6)
        self.assertEqual(self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain)["severity"], "LOW")
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=rain,
                          landslide_rain_alpha=5.0, landslide_rain_beta=0.3)
        self.assertEqual((r["severity"], r["trigger"]), ("MEDIUM", "rain"))

    def test_invalid_override_falls_back_to_caine(self):
        r = self.classify(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=20), landslide_rain_alpha=0.0)
        self.assertEqual(r["rain_threshold_source"], "caine_1980_global")
        self.assertEqual(r["severity"], "MEDIUM")

    def test_risk_score_agrees_with_severity(self):
        # generate_alert_message() derives the headline band from risk_score
        cases = [
            dict(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=15)),
            dict(tilt_angle_deg=0.0, rainfall_windows_mm=windows(h1=500), soil_saturation=1.0),
            dict(tilt_angle_deg=5.0, rainfall_windows_mm=windows(h1=15)),
            dict(tilt_angle_deg=14.0, vibration_magnitude=1.9, rainfall_windows_mm=windows(h1=15)),
        ]
        for reading in cases:
            r = self.classify(**reading)
            self.assertEqual(r["severity"], hcl.severity_band(r["risk_score"]), reading)

    def test_classify_all_hazards_carries_the_trigger(self):
        scores = hcl.classify_all_hazards({"tilt_angle_deg": 0.0, "rainfall_windows_mm": windows(h1=20)})
        self.assertEqual(scores["landslide"]["trigger"], "rain")
        self.assertNotIn("hazard_type", scores["landslide"])


class RainGaugeRangeTests(unittest.TestCase):
    """integration_pipeline.rain_reading_plausible: the cap scales with the
    time since the node's previous reading."""

    def test_cases(self):
        ok = ip.rain_reading_plausible
        self.assertTrue(ok(None, None))
        self.assertTrue(ok(0.0, None))
        self.assertFalse(ok(-0.5, None))
        self.assertFalse(ok(-0.5, 1.0))
        # no previous reading / a 5 s gap: the 10-minute floor -> 50 mm
        self.assertTrue(ok(50.0, None))
        self.assertFalse(ok(50.1, None))
        self.assertTrue(ok(50.0, 5 / 3600))
        self.assertFalse(ok(300.0, 5 / 3600))
        # a backlogged reading older than the previous one: still the floor
        self.assertTrue(ok(50.0, -2.0))
        # 1 h since the previous reading -> 300 mm
        self.assertTrue(ok(300.0, 1.0))
        self.assertFalse(ok(300.1, 1.0))
        # a long gap is capped at 400 mm in one reading
        self.assertTrue(ok(400.0, 12.0))
        self.assertFalse(ok(400.1, 12.0))


class AlertTextTests(unittest.TestCase):
    def test_detail_is_added_after_the_headline(self):
        msg = generate_alert_message("landslide", 0.5, "Slope A", None, None, use_llm=False,
                                     detail=ip.LANDSLIDE_TRIGGER_TEXT["rain"])
        self.assertTrue(msg.startswith("[MEDIUM ALERT] LANDSLIDE risk detected in Slope A. Trigger: rainfall"))
        self.assertIn("No ground movement has been measured yet.", msg)

    def test_no_detail_keeps_the_old_text(self):
        msg = generate_alert_message("flood", 0.5, "Riverside", None, None, use_llm=False)
        self.assertTrue(msg.startswith("[MEDIUM ALERT] FLOOD risk detected in Riverside. Risk score: 0.50."))


class TempDbMixin:
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="sj_landslide_")
        cls._real_db = bs.DB_PATH
        cls._real_get = bs.requests.get
        cls._real_registry = dict(bs.NODE_REGISTRY)
        bs.DB_PATH = os.path.join(cls._tmp, "test.db")
        bs.requests.get = _offline
        bs.init_db()

    @classmethod
    def tearDownClass(cls):
        bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
        bs.DB_PATH = cls._real_db
        bs.requests.get = cls._real_get
        bs.NODE_REGISTRY.clear()
        bs.NODE_REGISTRY.update(cls._real_registry)
        shutil.rmtree(cls._tmp, ignore_errors=True)


class NodeOverrideRegistryTests(TempDbMixin, unittest.TestCase):
    """The per-node threshold in the nodes table and admin API."""

    def node(self, **extra):
        fields = dict(location="Slope A", land_use="forest", curve_number=55, latitude=29.4, longitude=79.45)
        return bs.NodeConfig(**{**fields, **extra})

    def test_old_nodes_table_gets_the_columns(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, location TEXT, land_use TEXT, "
                     "curve_number REAL, latitude REAL, longitude REAL, upstream_node TEXT)")
        conn.execute("INSERT INTO nodes VALUES ('N1','x','forest',55,29,79,NULL)")
        bs.init_node_registry_table(conn)
        cols = {row[1] for row in conn.execute("PRAGMA table_info(nodes)")}
        self.assertTrue({"landslide_rain_alpha", "landslide_rain_beta"} <= cols)
        conn.close()

    def test_override_bounds_are_validated(self):
        for bad in ({"landslide_rain_alpha": 0}, {"landslide_rain_alpha": -3},
                    {"landslide_rain_beta": -0.1}, {"landslide_rain_alpha": 5000}):
            with self.subTest(bad=bad), self.assertRaises(ValidationError):
                self.node(**bad)

    def test_create_update_keeps_override_unless_sent(self):
        bs.admin_create_node("SLOPE-1", self.node(landslide_rain_alpha=9.5, landslide_rain_beta=0.3), auth=None)
        self.assertEqual(bs.NODE_REGISTRY["SLOPE-1"]["landslide_rain_alpha"], 9.5)
        self.assertEqual(bs.NODE_REGISTRY["SLOPE-1"]["landslide_rain_beta"], 0.3)

        # the current admin page sends no override fields: they must survive
        bs.admin_update_node("SLOPE-1", self.node(location="Slope A (renamed)"), auth=None)
        self.assertEqual(bs.NODE_REGISTRY["SLOPE-1"]["location"], "Slope A (renamed)")
        self.assertEqual(bs.NODE_REGISTRY["SLOPE-1"]["landslide_rain_alpha"], 9.5)

        # explicit null clears one, a new value replaces the other
        bs.admin_update_node("SLOPE-1", self.node(landslide_rain_alpha=None, landslide_rain_beta=0.25), auth=None)
        self.assertIsNone(bs.NODE_REGISTRY["SLOPE-1"]["landslide_rain_alpha"])
        self.assertEqual(bs.NODE_REGISTRY["SLOPE-1"]["landslide_rain_beta"], 0.25)
        bs.admin_delete_node("SLOPE-1", auth=None)


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class RainTriggerPipelineTests(TempDbMixin, unittest.TestCase):
    """derive_features() + process_reading() end to end."""

    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.models = (
            joblib.load(os.path.join(MODELS, "anomaly_model.joblib")),
            joblib.load(os.path.join(MODELS, "anomaly_scaler.joblib")),
            joblib.load(os.path.join(MODELS, "flood_model.joblib")),
            joblib.load(os.path.join(MODELS, "flood_feature_cols.joblib")),
        )

    def setUp(self):
        for node, cfg in bs._SEED_NODES.items():
            bs.NODE_REGISTRY[node] = {**cfg, "report_interval_seconds": None}
            bs.node_history[node] = collections.deque(maxlen=bs.HISTORY_WINDOW)
            bs.node_health[node] = {}
            bs.node_rainfall.pop(node, None)

    def send(self, at, **fields):
        fields.setdefault("node_id", "NODE-07")
        fields.setdefault("simulated", True)
        features = bs.derive_features(bs.RawReading(**fields), at.isoformat())
        return features, ip.process_reading(features, *self.models, None, None)

    def test_rain_windows_are_trailing_sums(self):
        self.send(T0, tilt_angle_deg=0.2, rainfall_mm_since_last=10)
        self.send(T0 + timedelta(hours=4), tilt_angle_deg=0.2, rainfall_mm_since_last=5)
        features, _ = self.send(T0 + timedelta(hours=5, minutes=30), tilt_angle_deg=0.2,
                                rainfall_mm_since_last=2)
        self.assertEqual(features["rainfall_windows_mm"], {1: 2, 3: 7, 6: 17, 12: 17, 24: 17})
        self.assertEqual(features["rainfall_intensity_mm_hr"], features["rainfall_windows_mm"][1])
        self.assertEqual(features["rainfall_24h_mm"], features["rainfall_windows_mm"][24])

    def test_tilt_node_warns_on_rain_then_escalates_on_tilt(self):
        _, calm = self.send(T0, tilt_angle_deg=0.3, vibration_magnitude=0.02, rainfall_mm_since_last=2)
        self.assertEqual(calm["severity"], "LOW")
        self.assertNotIn("trigger", calm)

        _, watch = self.send(T0 + timedelta(minutes=10), tilt_angle_deg=0.3, vibration_magnitude=0.02,
                             rainfall_mm_since_last=16)  # 18 mm in the last hour > 14.82
        self.assertEqual((watch["hazard_type"], watch["severity"], watch["trigger"]),
                         ("landslide", "MEDIUM", "rain"))
        self.assertEqual(watch["status"], "alert_dispatched")
        self.assertIn("No ground movement has been measured yet.", watch["message"])

        _, moved = self.send(T0 + timedelta(minutes=20), tilt_angle_deg=6.0, vibration_magnitude=0.3,
                             rainfall_mm_since_last=1)
        self.assertEqual((moved["hazard_type"], moved["severity"], moved["trigger"]),
                         ("landslide", "HIGH", "both"))
        self.assertEqual(moved["hazard_scores"]["landslide"]["trigger"], "both")

    def test_no_tilt_sensor_node_needs_the_registry_override(self):
        # NODE-04 is a river node: soil sensor + rain gauge, no MPU6050
        _, r = self.send(T0, node_id="NODE-04", soil_moisture_pct=60, rainfall_mm_since_last=25)
        self.assertNotIn("landslide", r["hazard_scores"])

        bs.node_rainfall.pop("NODE-04", None)
        bs.NODE_REGISTRY["NODE-04"]["landslide_rain_alpha"] = 14.82
        features, r = self.send(T0 + timedelta(minutes=5), node_id="NODE-04", soil_moisture_pct=60,
                                rainfall_mm_since_last=25)
        self.assertEqual(features["landslide_rain_alpha"], 14.82)
        self.assertIsNone(features["tilt_angle_deg"])
        # one rain report alone never triggers (see the glitch tests below)
        self.assertEqual(r["hazard_scores"]["landslide"]["severity"], "LOW")
        _, r = self.send(T0 + timedelta(minutes=10), node_id="NODE-04", soil_moisture_pct=60,
                         rainfall_mm_since_last=5)
        self.assertEqual((r["hazard_type"], r["severity"], r["trigger"]), ("landslide", "MEDIUM", "rain"))

    # --- a glitched rain gauge -------------------------------------------
    def confirmed_persistent(self, readings):
        """Runs (time, fields) readings through send() and, like
        _process_raw_reading, through a FRESH HazardConfirmer for every
        alert. Returns (results, True if any alert was confirmed as
        'persistent')."""
        confirmer = bs.HazardConfirmer()
        results, persistent = [], False
        for at, fields in readings:
            features, r = self.send(at, **fields)
            if r["status"] == "alert_dispatched":
                confirmed, basis = confirmer.assess(fields.get("node_id", "NODE-07"), r["hazard_type"],
                                                    r["severity"], at, bs.NODE_REGISTRY, simulated=True)
                persistent = persistent or (confirmed and basis == "persistent")
            results.append((features, r))
        return results, persistent

    def test_impossible_rain_value_is_a_fault_not_a_watch(self):
        results, persistent = self.confirmed_persistent([
            (T0, dict(tilt_angle_deg=0.3, rainfall_mm_since_last=300)),
            (T0 + timedelta(minutes=5), dict(tilt_angle_deg=0.3, rainfall_mm_since_last=0)),
            (T0 + timedelta(minutes=10), dict(tilt_angle_deg=0.3, rainfall_mm_since_last=0)),
        ])
        self.assertEqual(len(bs.node_rainfall["NODE-07"]), 0)  # never reached the rain log
        features, first = results[0]
        self.assertEqual(features["sensor_faults"], ["rainfall_mm_since_last"])
        self.assertIn("rainfall_mm_since_last", first["sensor_faults"])
        self.assertEqual(features["soil_saturation"], 0.3)  # proxy not filled by the glitch
        # kept out of history (the river forecast's training input)
        self.assertIsNone(bs.node_history["NODE-07"][0]["rainfall_mm_since_last"])
        for _, r in results:
            self.assertEqual(r["hazard_scores"]["landslide"]["severity"], "LOW")
        self.assertFalse(persistent)

    def test_single_rain_report_never_raises_a_watch(self):
        # 20 mm is plausible (under the 50 mm floor cap) and 1.35x Caine's
        # 1 h threshold - but one report cannot be told from a chattering
        # reed switch, and the dry reading after it must not re-score it.
        results, persistent = self.confirmed_persistent([
            (T0, dict(tilt_angle_deg=0.3, rainfall_mm_since_last=20)),
            (T0 + timedelta(minutes=5), dict(tilt_angle_deg=0.3, rainfall_mm_since_last=0)),
        ])
        for _, r in results:
            self.assertEqual(r["hazard_scores"]["landslide"]["severity"], "LOW")
            self.assertGreater(r["hazard_scores"]["landslide"]["rain_exceedance"], 1.0)  # still shown
        self.assertFalse(persistent)

    def test_two_rain_reports_raise_the_watch(self):
        self.send(T0, tilt_angle_deg=0.3, rainfall_mm_since_last=10)
        _, r = self.send(T0 + timedelta(minutes=10), tilt_angle_deg=0.3, rainfall_mm_since_last=9)
        self.assertEqual((r["hazard_type"], r["severity"], r["trigger"]), ("landslide", "MEDIUM", "rain"))

    def test_tilt_node_without_rain_reports_no_rain_window(self):
        # The four rain fields are always present on a live slope node (the
        # firmware sends 0.0 rain when there is no gauge); a null window
        # means "no rain in 24 h, or no gauge" - the UI hides the line then.
        _, r = self.send(T0, tilt_angle_deg=0.3)
        ls = r["hazard_scores"]["landslide"]
        self.assertIsNone(ls["rain_window_hours"])
        self.assertEqual(ls["rain_exceedance"], 0.0)
        self.assertFalse(ls["antecedent_saturated"])
        self.assertEqual(ls["rain_threshold_source"], "caine_1980_global")

    def test_tilt_only_alert_is_unchanged(self):
        _, r = self.send(T0, tilt_angle_deg=12.0, vibration_magnitude=0.8)
        self.assertEqual(r["hazard_type"], "landslide")
        self.assertEqual(r["risk_score"], round(old_tilt_score(12.0, 0.8), 4))
        self.assertEqual(r["trigger"], "tilt")
        self.assertIn("Trigger: ground tilt or vibration", r["message"])


if __name__ == "__main__":
    unittest.main()
