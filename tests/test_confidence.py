"""
Confidence score per alert + node anomaly flags as a fault signal (round
2026-10-09, backend lane step B2):

  - alert_confidence.compute_confidence: the explainable formula's edges -
    pending vs confirmed (repeat / neighbour), the node's edge verdict
    agreeing or not, node anomaly flags, other faulty sensors, late
    readings, model-card calibration (only for the model file it describes)
  - cap_alert: the score -> CAP <certainty> (Observed/Likely/Possible/
    Unlikely), old rows keep the per-source fallback
  - integration_pipeline: a river level the node flags stuck / spike /
    impossible rate does not raise a flood or flash flood unless rain or a
    rising upstream node independently backs it up
  - end to end through ingest: stored columns, alert text, CAP export

Uses a throwaway SQLite file for the ingest tests (see test_pipeline_integrity).

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import hashlib
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from unittest import mock

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import alert_confidence as ac  # noqa: E402
import backend_server as bs  # noqa: E402
import cap_alert  # noqa: E402
import integration_pipeline as ip  # noqa: E402
from test_pipeline_integrity import HAVE_MODELS, TempDbMixin, _load_models, _reset_nodes  # noqa: E402

NS = {"cap": "urn:oasis:names:tc:emergency:cap:1.2"}


def alert(hazard_type="gas leak", severity="HIGH", confirmation="unconfirmed",
          source="threshold_classifier", status=None, **extra):
    """A pipeline result after HazardConfirmer, as compute_confidence sees it."""
    if status is None:
        status = "pending_confirmation" if confirmation == "unconfirmed" else "alert_dispatched"
    return {"status": status, "hazard_type": hazard_type, "severity": severity,
            "severity_source": source, "confirmation": confirmation, "risk_score": 0.8, **extra}


def score(result, calibration=None, **reading):
    return ac.compute_confidence(result, reading, calibration)


# --- the formula -------------------------------------------------------------

class ConfirmationComponentTests(unittest.TestCase):
    def test_pending_alone_is_low(self):
        c = score(alert())
        self.assertEqual((c["confidence"], c["confidence_label"]), (0.40, "Low"))
        self.assertIn("Not confirmed yet", c["confidence_reasons"][0])

    def test_repeat_and_neighbour_confirmation(self):
        repeat = score(alert(confirmation="persistent"))
        self.assertEqual((repeat["confidence"], repeat["confidence_label"]), (0.70, "Medium"))
        neighbour = score(alert(confirmation="neighbour:NODE-07"))
        self.assertEqual((neighbour["confidence"], neighbour["confidence_label"]), (0.90, "High"))
        self.assertEqual(neighbour["confidence_reasons"][0], "Confirmed by nearby node NODE-07")

    def test_a_pending_alert_is_never_high(self):
        # best case: edge agrees and the model's bin was 100 % floods
        calibration = {"provenance": "SYNTHETIC",
                       "bins": [{"bin_lower": 0.0, "bin_upper": 1.0, "count": 500, "observed_rate": 1.0}]}
        result = alert("flood", "HIGH", source="ml_model",
                       hazard_scores={"flood": {"model_probability": 0.95}})
        c = score(result, calibration, edge_risk_level="URGENT")
        self.assertEqual(c["confidence"], 0.70)
        self.assertEqual(c["confidence_label"], "Medium")

    def test_non_alerts_have_no_score(self):
        for result in (
            alert(severity="LOW", status="logged"),
            {"status": "suppressed", "hazard_type": "sensor_fault", "severity": "N/A"},
            alert(status="logged"),  # elevated but never an alert
        ):
            self.assertEqual(score(result), {"confidence": None, "confidence_label": None,
                                             "confidence_reasons": None})


class EdgeComponentTests(unittest.TestCase):
    def test_agree_partly_and_disagree(self):
        confirmed = alert(confirmation="persistent")  # HIGH gas leak -> URGENT expected
        self.assertEqual(score(confirmed, edge_risk_level="URGENT")["confidence"], 0.80)
        self.assertEqual(score(confirmed, edge_risk_level="WATCH")["confidence"], 0.67)
        disagree = score(confirmed, edge_risk_level="NORMAL")
        self.assertEqual(disagree["confidence"], 0.53)
        self.assertIn("Node's own check disagrees (NORMAL)", disagree["confidence_reasons"])

    def test_medium_expects_watch(self):
        c = score(alert(severity="MEDIUM", confirmation="persistent"), edge_risk_level="WATCH")
        self.assertEqual(c["confidence"], 0.80)

    def test_heat_uses_the_node_heat_levels(self):
        # node: 45 C heat wave (backend HIGH) = WATCH, 47 C severe (CRITICAL) = URGENT,
        # 40-45 C (MEDIUM) = NORMAL (ml/make_edge_dataset.py label())
        for severity, level in (("HIGH", "WATCH"), ("CRITICAL", "URGENT"), ("MEDIUM", "NORMAL")):
            c = score(alert("extreme heat", severity, confirmation="persistent"), edge_risk_level=level)
            self.assertEqual(c["confidence"], 0.80, severity)
            self.assertIn(f"Node's own check agrees ({level})", c["confidence_reasons"])
        self.assertEqual(score(alert("extreme heat", "HIGH", confirmation="persistent"),
                               edge_risk_level="URGENT")["confidence"], 0.67)

    def test_verdict_is_normalised_and_garbage_ignored(self):
        confirmed = alert(confirmation="persistent")
        self.assertEqual(score(confirmed, edge_risk_level=" urgent ")["confidence"], 0.80)
        for junk in ("BOGUS", 2, None, ""):
            self.assertEqual(score(confirmed, edge_risk_level=junk)["confidence"], 0.70, junk)

    def test_hazards_the_edge_model_cannot_see_are_not_compared(self):
        for hazard in ("landslide", "air pollution", "water quality degradation"):
            c = score(alert(hazard, confirmation="persistent"), edge_risk_level="NORMAL")
            self.assertEqual(c["confidence"], 0.70, hazard)

    def test_flash_flood_and_smoke_edge_only_supports(self):
        for hazard in ("flash_flood", "smoke"):
            self.assertEqual(score(alert(hazard, confirmation="persistent"),
                                   edge_risk_level="NORMAL")["confidence"], 0.70, hazard)
            supported = score(alert(hazard, confirmation="persistent"), edge_risk_level="WATCH")
            self.assertEqual(supported["confidence"], 0.80, hazard)
            self.assertIn("Node's own check also flags it (WATCH)", supported["confidence_reasons"])

    def test_summary_window_worst_is_only_partial_support(self):
        confirmed = alert(confirmation="persistent")  # HIGH gas leak
        # the window's worst verdict is not the latest sample's: never full agreement
        c = score(confirmed, edge_risk_level_window_max="URGENT")
        self.assertEqual(c["confidence"], 0.67)  # (0.5*0.70 + 0.25*0.6) / 0.75
        self.assertIn("Node's own check flagged URGENT earlier in its report window", c["confidence_reasons"])
        # a NORMAL maximum: every sample was NORMAL, a real disagreement
        self.assertEqual(score(confirmed, edge_risk_level_window_max="NORMAL")["confidence"], 0.53)
        # the latest verdict, when sent, wins
        self.assertEqual(score(confirmed, edge_risk_level="URGENT",
                               edge_risk_level_window_max="WATCH")["confidence"], 0.80)
        # support-only hazards: the window maximum is weaker support than the latest
        self.assertEqual(score(alert("smoke", confirmation="persistent"),
                               edge_risk_level_window_max="URGENT")["confidence"], 0.67)
        # hazards the edge model cannot see still ignore it
        self.assertEqual(score(alert("landslide", confirmation="persistent"),
                               edge_risk_level_window_max="URGENT")["confidence"], 0.70)

    def test_bench_threshold_is_not_compared_with_the_river_scale_edge_model(self):
        c = score(alert("flood", confirmation="persistent", source="hardware_test_threshold"),
                  edge_risk_level="NORMAL")
        # (0.5*0.70 + 0.25*0.30) / 0.75 - the edge verdict is left out
        self.assertEqual(c["confidence"], 0.57)
        self.assertIn("Bench-test threshold, not a field-calibrated model", c["confidence_reasons"])


class DataQualityTests(unittest.TestCase):
    def test_anomaly_flag_on_the_hazards_own_sensor(self):
        confirmed = alert(confirmation="neighbour:NODE-07")  # 0.90 clean
        spike = score(confirmed, edge_anomaly=["spike:gas_ppm"])
        self.assertEqual(spike["confidence"], 0.63)  # x 0.70
        self.assertIn("Node's anomaly check flags gas_ppm (spike)", spike["confidence_reasons"])
        self.assertEqual(score(confirmed, edge_anomaly=["dropout:gas_ppm"])["confidence"], 0.77)  # x 0.85

    def test_strongest_own_flag_counts_once(self):
        confirmed = alert(confirmation="neighbour:NODE-07")
        both = score(confirmed, edge_anomaly=["dropout:gas_ppm", "spike:gas_ppm"])
        self.assertEqual(both["confidence"], 0.63)

    def test_flag_on_another_sensor_costs_little(self):
        c = score(alert(confirmation="neighbour:NODE-07"), edge_anomaly=["stuck:temp_c"])
        self.assertEqual(c["confidence"], 0.85)  # 0.90 x 0.95
        self.assertIn("Node's anomaly check flags another sensor (stuck:temp_c)", c["confidence_reasons"])

    def test_stuck_sensor_cannot_confirm_itself_by_repeating(self):
        c = score(alert(confirmation="persistent"), edge_anomaly=["stuck:gas_ppm"])
        # repeat not counted (0.40) and the flag (x 0.70)
        self.assertEqual(c["confidence"], 0.28)
        self.assertEqual(c["confidence_reasons"][0], "Not confirmed: node reports gas_ppm stuck, so repeat "
                                                     "readings do not count - waiting for a nearby node")
        self.assertEqual(ac.stuck_hazard_fields("gas leak", ["stuck:gas_ppm", "stuck:temp_c", "spike:gas_ppm"]),
                         ["gas_ppm"])
        self.assertEqual(ac.stuck_hazard_fields("fire", ["stuck:temp_c"]), ["temp_c"])
        self.assertEqual(ac.stuck_hazard_fields("gas leak", ["spike:gas_ppm", "garbage"]), [])
        # a neighbour is independent of this node's sensor and still counts
        self.assertEqual(score(alert(confirmation="neighbour:NODE-07"),
                               edge_anomaly=["stuck:gas_ppm"])["confidence"], 0.63)

    def test_other_faulty_sensor(self):
        c = score(alert(confirmation="neighbour:NODE-07", sensor_faults=["temp_c"]))
        self.assertEqual(c["confidence"], 0.81)
        self.assertIn("Another sensor on this node is faulty (temp_c)", c["confidence_reasons"])

    def test_late_readings_lose_confidence(self):
        confirmed = alert(confirmation="neighbour:NODE-07")
        cases = [(60, 0.90, None), (299, 0.90, None), (600, 0.77, "Reading arrived 10 min late"),
                 (2 * 3600, 0.59, "Reading arrived 2.0 h late"), (8 * 3600, 0.36, "Reading arrived 8.0 h late")]
        for delay, expected, reason in cases:
            c = score(confirmed, delay_seconds=delay)
            self.assertEqual(c["confidence"], expected, delay)
            if reason:
                self.assertIn(reason, c["confidence_reasons"])
            else:
                self.assertEqual(len(c["confidence_reasons"]), 1)

    def test_everything_wrong_at_once_stays_in_range_and_in_the_server_limits(self):
        c = score(alert(confirmation="persistent", sensor_faults=["temp_c", "humidity_pct"]),
                  edge_risk_level="NORMAL", delay_seconds=40 * 3600,
                  edge_anomaly=["stuck:gas_ppm", "spike:temp_c", "dropout:pm25_ugm3"])
        self.assertGreaterEqual(c["confidence"], 0.0)
        self.assertEqual(c["confidence_label"], "Low")
        self.assertLessEqual(len(c["confidence_reasons"]), 8)
        for reason in c["confidence_reasons"]:
            self.assertIsInstance(reason, str)
            self.assertLessEqual(len(reason), 120)


class CalibrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sj_conf_")
        self.model = os.path.join(self.tmp, "flood_model.joblib")
        with open(self.model, "wb") as f:
            f.write(b"pretend model bytes")
        self.sha = hashlib.sha256(b"pretend model bytes").hexdigest()

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def write_card(self, sha=None, bins=None, **flood_overrides):
        bins = bins if bins is not None else [
            {"bin_lower": i / 10, "bin_upper": (i + 1) / 10, "count": 100 if i != 5 else 12,
             "mean_predicted": i / 10 + 0.05, "observed_rate": round(i / 10 + 0.04, 2)}
            for i in range(10)
        ]
        flood = {"id": "flood", "status": "evaluated", "artifact": {"sha256": sha or self.sha},
                 "evaluation": {"provenance": "SYNTHETIC"},
                 "calibration": {"applicable": True, "reliability": bins}, **flood_overrides}
        path = os.path.join(self.tmp, "model_card.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump({"provenance": "SYNTHETIC", "models": [flood]}, f)
        return path

    def load(self, card_path):
        with mock.patch("builtins.print"):
            return ac.load_flood_calibration(card_path, self.model)

    def test_card_for_the_loaded_model_is_used(self):
        cal = self.load(self.write_card())
        self.assertEqual(cal["provenance"], "SYNTHETIC")
        self.assertEqual(ac.calibration_rate(cal, 0.93), (0.94, 100))
        self.assertEqual(ac.calibration_rate(cal, 1.0), (0.94, 100))  # last bin includes 1.0
        self.assertEqual(ac.calibration_rate(cal, 0.0), (0.04, 100))
        self.assertIsNone(ac.calibration_rate(cal, 0.55))  # only 12 test cases in that bin

    def test_card_for_another_model_file_is_not_used(self):
        self.assertIsNone(self.load(self.write_card(sha="0" * 64)))

    def test_missing_or_broken_card_is_not_used(self):
        self.assertIsNone(self.load(os.path.join(self.tmp, "nope.json")))
        broken = os.path.join(self.tmp, "broken.json")
        with open(broken, "w") as f:
            f.write("{not json")
        self.assertIsNone(self.load(broken))
        self.assertIsNone(self.load(self.write_card(bins=[{"bin_lower": 0, "bin_upper": 2, "count": 1}])))
        self.assertIsNone(self.load(self.write_card(status="not_evaluated")))

    def test_model_component_for_a_flood_alert(self):
        cal = self.load(self.write_card())
        result = alert("flood", confirmation="persistent", source="ml_model",
                       hazard_scores={"flood": {"model_probability": 0.93}})
        c = score(result, cal)
        # (0.5*0.70 + 0.25*0.94) / 0.75
        self.assertEqual(c["confidence"], 0.78)
        self.assertIn("Flood model on synthetic data: 94% of similar scores were floods", c["confidence_reasons"])
        # a threshold hazard never borrows the flood model's numbers
        self.assertEqual(score(alert(confirmation="persistent"), cal)["confidence"], 0.70)

    def test_the_real_model_card_matches_the_shipped_model(self):
        card = os.path.join(ROOT, "var", "models", "model_card.json")
        model = os.path.join(ROOT, "var", "models", "flood_model.joblib")
        if not (os.path.exists(card) and os.path.exists(model)):
            self.skipTest("trained model / model card not present")
        with mock.patch("builtins.print"):
            cal = ac.load_flood_calibration(card, model)
        if cal is None:
            self.skipTest("model card is out of date for this model (re-run ml/evaluate_models.py)")
        self.assertIsNotNone(ac.calibration_rate(cal, 0.95))


class AlertTextTests(unittest.TestCase):
    CONF = {"confidence": 0.6, "confidence_label": "Medium",
            "confidence_reasons": ["Not confirmed yet: waiting", "Node's own check agrees (URGENT)", "third"]}

    def test_sentence(self):
        self.assertEqual(ac.confidence_sentence(self.CONF),
                         "Confidence: Medium (60%) - Not confirmed yet: waiting; Node's own check agrees (URGENT).")
        self.assertIsNone(ac.confidence_sentence({"confidence": None}))

    def test_line_goes_at_the_end_of_the_headline_paragraph(self):
        msg = "[HIGH ALERT] GAS LEAK risk detected in X. Risk score: 0.80. Follow it.\n\nRelevant guidance:\n\nSOP"
        out = ac.add_confidence_to_message(msg, self.CONF)
        head, rest = out.split("\n\n", 1)
        self.assertTrue(head.endswith("agrees (URGENT)."))
        self.assertTrue(head.startswith("[HIGH ALERT] GAS LEAK"))
        self.assertEqual(rest, "Relevant guidance:\n\nSOP")
        self.assertEqual(ac.add_confidence_to_message("One paragraph.", self.CONF),
                         "One paragraph. " + ac.confidence_sentence(self.CONF))
        self.assertEqual(ac.add_confidence_to_message(msg, {"confidence": None}), msg)


# --- CAP <certainty> -----------------------------------------------------------

class CapCertaintyTests(unittest.TestCase):
    def test_mapping(self):
        f = cap_alert.certainty_for
        self.assertEqual(f(0.9, "neighbour:NODE-07", "gas leak", "threshold_classifier"), "Observed")
        self.assertEqual(f(0.8, "persistent", "flash_flood", "threshold_classifier"), "Observed")
        # a risk estimate or a landslide warning is never "Observed"
        self.assertEqual(f(0.9, "persistent", "flood", "ml_model"), "Likely")
        self.assertEqual(f(0.9, "persistent", "landslide", "threshold_classifier"), "Likely")
        # High but not confirmed
        self.assertEqual(f(0.8, "unconfirmed", "gas leak", "threshold_classifier"), "Likely")
        self.assertEqual(f(0.6, "persistent", "gas leak", "threshold_classifier"), "Likely")
        self.assertEqual(f(0.4, "unconfirmed", "gas leak", "threshold_classifier"), "Possible")
        self.assertEqual(f(0.1, "persistent", "gas leak", "threshold_classifier"), "Unlikely")
        # the bench rig never claims more than Possible
        self.assertEqual(f(0.9, "persistent", "flood", "hardware_test_threshold"), "Possible")
        self.assertEqual(f(0.1, "persistent", "flood", "hardware_test_threshold"), "Unlikely")

    def test_old_rows_keep_the_per_source_fallback(self):
        self.assertEqual(cap_alert.certainty_for(None, None, "flood", "ml_model"), "Likely")
        self.assertEqual(cap_alert.certainty_for(None, None, "flood", "hardware_test_threshold"), "Possible")

    def cap(self, **kwargs):
        args = dict(hazard_type="gas leak", severity="HIGH", location="Zone B", latitude=29.0,
                    longitude=79.0, message="m", node_id="NODE-INDB", risk_score=0.8,
                    severity_source="threshold_classifier", reading_id=3,
                    sent_at=datetime(2026, 10, 9, 1, 2, 3, tzinfo=timezone.utc))
        args.update(kwargs)
        return ET.fromstring(cap_alert.generate_cap_alert(**args))

    def params(self, root):
        return {p.find("cap:valueName", NS).text: p.find("cap:value", NS).text
                for p in root.findall("cap:info/cap:parameter", NS)}

    def test_cap_document_carries_certainty_and_score(self):
        root = self.cap(confidence=0.9, confirmation="neighbour:NODE-07")
        self.assertEqual(root.find("cap:info/cap:certainty", NS).text, "Observed")
        self.assertEqual(self.params(root)["sanjeevni_confidence"], "0.90")
        info = [c.tag.split("}")[1] for c in root.find("cap:info", NS)]
        self.assertEqual(info[info.index("certainty") + 1], "expires")  # schema order kept

    def test_cap_without_or_with_a_damaged_score(self):
        for bad in (None, 1.7, -0.1, "high"):
            root = self.cap(confidence=bad, confirmation="persistent")
            self.assertEqual(root.find("cap:info/cap:certainty", NS).text, "Likely", bad)
            self.assertNotIn("sanjeevni_confidence", self.params(root))


# --- node anomaly flags as a river-sensor fault signal --------------------------

class EdgeRiverHoldTests(unittest.TestCase):
    def candidates(self):
        return {"flood": {"risk_score": 0.95, "severity": "CRITICAL", "severity_source": "ml_model"},
                "flash_flood": {"risk_score": 0.8, "severity": "HIGH"},
                "gas leak": {"risk_score": 0.9, "severity": "HIGH"}}

    def test_doubt_flags(self):
        reading = {"edge_anomaly": ["spike:river_level_m", "dropout:river_level_m", "stuck:gas_ppm",
                                    "rate:river_level_m", "spike:river_level_m"]}
        self.assertEqual(ip.edge_river_doubts(reading), ["spike:river_level_m", "rate:river_level_m"])
        self.assertEqual(ip.edge_river_doubts({}), [])

    def test_doubted_level_is_held_without_corroboration(self):
        for check in ("stuck", "spike", "rate"):
            c = self.candidates()
            held = ip.hold_doubtful_river_hazards({"edge_anomaly": [f"{check}:river_level_m"]}, c)
            self.assertEqual(held, [f"{check}:river_level_m"])
            self.assertEqual((c["flood"]["severity"], c["flash_flood"]["severity"]), ("LOW", "LOW"))
            self.assertEqual(c["flood"]["severity_before_hold"], "CRITICAL")
            self.assertEqual(c["gas leak"]["severity"], "HIGH")  # other sensors untouched

    def test_corroborated_rise_is_not_held(self):
        reading = {"edge_anomaly": ["spike:river_level_m"], "river_level_rate_m_per_hr": 0.5,
                   "rainfall_intensity_mm_hr": 12}
        c = self.candidates()
        self.assertEqual(ip.hold_doubtful_river_hazards(reading, c), [])
        self.assertEqual(c["flood"]["severity"], "CRITICAL")
        upstream = {**reading, "rainfall_intensity_mm_hr": 0, "upstream_rate_m_per_hr": 0.4}
        self.assertEqual(ip.hold_doubtful_river_hazards(upstream, self.candidates()), [])

    def test_dropout_or_other_sensor_flags_do_not_hold(self):
        for flags in (["dropout:river_level_m"], ["spike:gas_ppm"], ["stuck:temp_c"]):
            c = self.candidates()
            self.assertEqual(ip.hold_doubtful_river_hazards({"edge_anomaly": flags}, c), [], flags)
            self.assertEqual(c["flood"]["severity"], "CRITICAL")

    def test_bench_mode_waives_the_hold_for_real_readings_only(self):
        reading = {"edge_anomaly": ["spike:river_level_m"]}
        with mock.patch.object(ip, "HARDWARE_TEST_MODE", True):
            self.assertEqual(ip.hold_doubtful_river_hazards(reading, self.candidates()), [])
            self.assertEqual(ip.hold_doubtful_river_hazards({**reading, "simulated": True}, self.candidates()),
                             ["spike:river_level_m"])


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class EdgeRiverHoldPipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = _load_models()

    def run_pipeline(self, **overrides):
        reading = {**ip.demo_readings()[3], **overrides}  # the CRITICAL flood demo reading
        return ip.process_reading(reading, *self.models, None, None)

    # no rain, no upstream rise: the flood rests on the river value alone
    UNCORROBORATED = {"rainfall_intensity_mm_hr": 0, "upstream_rate_m_per_hr": 0,
                      "river_level_rate_m_per_hr": 0.05}

    def test_flagged_river_alone_is_suppressed_like_an_anomaly(self):
        self.assertEqual(self.run_pipeline(**self.UNCORROBORATED)["severity"], "CRITICAL")
        for check in ("stuck", "spike"):
            r = self.run_pipeline(**self.UNCORROBORATED, edge_anomaly=[f"{check}:river_level_m"])
            self.assertEqual((r["status"], r["hazard_type"]), ("suppressed", "sensor_fault"), check)
            self.assertEqual(r["reason"], f"edge_anomaly_{check}:river_level_m")
            self.assertEqual(r["hazard_scores"]["flood"]["held_by_edge_anomaly"], [f"{check}:river_level_m"])

    def test_corroborated_flood_still_alerts(self):
        r = self.run_pipeline(edge_anomaly=["spike:river_level_m"])  # 22 mm/h rain, rising 0.4 m/h
        self.assertEqual((r["status"], r["hazard_type"], r["severity"]), ("alert_dispatched", "flood", "CRITICAL"))

    def test_other_hazard_on_the_node_still_alerts(self):
        r = self.run_pipeline(**self.UNCORROBORATED, gas_ppm=950, edge_anomaly=["stuck:river_level_m"])
        self.assertEqual((r["status"], r["hazard_type"]), ("alert_dispatched", "gas leak"))
        self.assertEqual(r["hazard_scores"]["flood"]["severity"], "LOW")

    def test_flood_result_carries_the_raw_model_probability(self):
        r = self.run_pipeline()
        p = r["hazard_scores"]["flood"]["model_probability"]
        self.assertTrue(0.0 <= p <= 1.0)
        self.assertLessEqual(p, r["hazard_scores"]["flood"]["risk_score"] + 1e-9)  # boost only raises


# --- end to end through ingest -------------------------------------------------

@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class IngestConfidenceTests(TempDbMixin, unittest.TestCase):
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
        # recent enough that the readings are not "late" (staleness factor 1.0)
        self.start = datetime.now(timezone.utc) - timedelta(minutes=4)

    def tearDown(self):
        bs._confirmer = self._real_confirmer

    def send(self, i, step_s=30, **fields):
        ts = (self.start + timedelta(seconds=i * step_s)).isoformat()
        return bs.ingest_reading(bs.RawReading(timestamp=ts, reading_uid=f"{self._testMethodName}-{i}", **fields))

    def stored(self, i):
        conn = sqlite3.connect(bs.DB_PATH)
        conn.row_factory = sqlite3.Row
        row = conn.execute("SELECT * FROM readings WHERE reading_uid=?", (f"{self._testMethodName}-{i}",)).fetchone()
        conn.close()
        return dict(row)

    def rising_river(self, n=16, **last_fields):
        """6 cm/min on NODE-04 (a HIGH flash flood), edge URGENT; extra
        fields on the last reading only."""
        results = []
        for i in range(n):
            extra = last_fields if i == n - 1 else {}
            results.append(self.send(i, step_s=15, node_id="NODE-04", river_level_m=1.0 + 0.015 * i,
                                     edge_risk_level="URGENT", **extra))
        return results

    def test_pending_then_confirmed_scores_and_storage(self):
        results = self.rising_river()
        alerts = [r for r in results if r["hazard_type"] == "flash_flood" and r["severity"] != "LOW"]
        first, last = alerts[0], alerts[-1]
        self.assertEqual(first["status"], "pending_confirmation")
        self.assertEqual((first["confidence"], first["confidence_label"]), (0.6, "Medium"))  # pending + edge
        self.assertEqual(last["status"], "alert_dispatched")
        self.assertEqual((last["confidence"], last["confidence_label"]), (0.8, "High"))  # repeat + edge
        self.assertIn("Confidence: High (80%)", last["message"])
        self.assertLess(last["message"].index("Confidence:"), last["message"].index("Relevant guidance"))
        row = self.stored(len(results) - 1)
        self.assertEqual((row["confidence"], row["confidence_label"]), (0.8, "High"))
        self.assertEqual(json.loads(row["confidence_reasons"]), last["confidence_reasons"])
        # a calm reading gets the keys, empty
        calm = self.send(100, step_s=1, node_id="NODE-07", river_level_m=1.5)
        self.assertEqual(calm["status"], "logged")
        self.assertIsNone(calm["confidence"])
        self.assertIsNone(self.stored(100)["confidence"])

    def test_cap_export_uses_the_stored_score(self):
        results = self.rising_river()
        self.assertEqual(results[-1]["status"], "alert_dispatched")
        row = self.stored(len(results) - 1)
        xml = bs.get_alert_as_cap(row["id"]).body.decode()
        root = ET.fromstring(xml)
        # High + confirmed by repeat + a measured fast rise
        self.assertEqual(root.find("cap:info/cap:certainty", NS).text, "Observed")
        self.assertIn("Confidence: High (80%)", root.find("cap:info/cap:description", NS).text)

    def test_node_flagged_river_does_not_raise_the_flash_flood(self):
        results = self.rising_river(edge_anomaly=["stuck:river_level_m"])
        self.assertEqual(results[-2]["hazard_type"], "flash_flood")  # it was alerting before the flag
        last = results[-1]
        self.assertEqual((last["status"], last["hazard_type"]), ("suppressed", "sensor_fault"))
        self.assertEqual(last["reason"], "edge_anomaly_stuck:river_level_m")
        self.assertIsNone(last["confidence"])
        self.assertEqual(self.stored(len(results) - 1)["edge_anomaly"], "stuck:river_level_m")

    def test_stuck_gas_sensor_never_confirms_its_own_critical(self):
        # a frozen high value repeats by definition: it must stay pending
        # (no public alert, no WhatsApp, no automatic siren)
        results = [self.send(i, node_id="NODE-INDB", gas_ppm=1500, edge_anomaly=["stuck:gas_ppm"],
                             edge_risk_level="URGENT") for i in range(4)]
        for r in results:
            self.assertEqual((r["hazard_type"], r["severity"]), ("gas leak", "CRITICAL"))
            self.assertEqual((r["status"], r["confirmation"]), ("pending_confirmation", "unconfirmed"))
            self.assertLess(r["confidence"], ac.HIGH_CONFIDENCE)
        # the same readings without the flag confirm on the repeat
        results = [self.send(10 + i, node_id="NODE-INDB", gas_ppm=1500, edge_risk_level="URGENT")
                   for i in range(2)]
        self.assertEqual([r["status"] for r in results], ["pending_confirmation", "alert_dispatched"])

    def test_late_backlog_reading_is_marked_down(self):
        self.start = datetime.now(timezone.utc) - timedelta(hours=2)
        last = self.rising_river()[-1]
        self.assertEqual(last["status"], "alert_dispatched")
        # (0.5*0.70 + 0.25*1.0) / 0.75 x 0.65 (arrived ~1.9 h late)
        self.assertEqual(last["confidence"], 0.52)
        self.assertTrue(any(r.startswith("Reading arrived") for r in last["confidence_reasons"]))


if __name__ == "__main__":
    unittest.main()
