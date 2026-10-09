"""
Air pollution severity from PM2.5 AND PM10 (CPCB NAQI breakpoints).

classify_air_pollution() bands each pollutant on its own CPCB table and
keeps the worse one; a node may send only one of the two. Pure functions -
no models or network needed.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from hazard_classification import classify_air_pollution, classify_all_hazards  # noqa: E402
from integration_pipeline import is_hazard_signature, process_reading  # noqa: E402
from rag_alert_pipeline import severity_band  # noqa: E402


def classify(pm25=None, pm10=None):
    reading = {}
    if pm25 is not None:
        reading["pm25_ugm3"] = pm25
    if pm10 is not None:
        reading["pm10_ugm3"] = pm10
    return classify_air_pollution(reading)


class SinglePollutantTests(unittest.TestCase):
    def test_pm25_only(self):
        result = classify(pm25=200)
        self.assertEqual(result["hazard_type"], "air pollution")
        self.assertEqual(result["severity"], "HIGH")  # CPCB Very Poor 121-250
        self.assertEqual(result["responsible_pollutant"], "PM2.5")

    def test_pm10_only(self):
        # The gap this closes: PM10 used to be ignored, so this was None.
        result = classify(pm10=300)
        self.assertEqual(result["severity"], "MEDIUM")  # CPCB Poor 251-350
        self.assertEqual(result["responsible_pollutant"], "PM10")

    def test_neither_is_not_classified(self):
        self.assertIsNone(classify())
        self.assertNotIn("air pollution", classify_all_hazards({"temp_c": 25}))


class BandEdgeTests(unittest.TestCase):
    """CPCB writes integer ranges (31-60, 61-90, ...): a band's top value
    stays in the band, anything above it is the next category."""

    PM25_EDGES = [
        (0, "LOW"), (60, "LOW"), (61, "MEDIUM"),  # Satisfactory | Moderately polluted
        (90, "MEDIUM"), (91, "MEDIUM"),  # Moderately polluted | Poor: both MEDIUM
        (120, "MEDIUM"), (121, "HIGH"),  # Poor | Very Poor
        (250, "HIGH"), (251, "CRITICAL"),  # Very Poor | Severe
        (1000, "CRITICAL"),
        # Fractional values just above a top: the 4-dp rounded score must
        # not land on the band floor (severity_band() would call it the
        # band below). API clients can send floats; the node sends integers.
        (60.004, "MEDIUM"), (120.01, "HIGH"), (250.05, "CRITICAL"),
    ]
    PM10_EDGES = [
        (0, "LOW"), (100, "LOW"), (101, "MEDIUM"),  # Satisfactory | Moderately polluted
        (250, "MEDIUM"), (251, "MEDIUM"),  # Moderately polluted | Poor: both MEDIUM
        (350, "MEDIUM"), (351, "HIGH"),  # Poor | Very Poor
        (430, "HIGH"), (431, "CRITICAL"),  # Very Poor | Severe
        (2000, "CRITICAL"),
        (100.01, "MEDIUM"), (350.01, "HIGH"), (430.1, "CRITICAL"),  # see PM25_EDGES
    ]

    def check_edges(self, edges, field):
        for value, expected in edges:
            with self.subTest(field=field, value=value):
                result = classify(**{field: value})
                self.assertEqual(result["severity"], expected)
                # risk_score must agree with the shared severity_band() scale,
                # so the dashboard number and the band never contradict.
                self.assertEqual(severity_band(result["risk_score"]), expected)
                self.assertTrue(0.0 <= result["risk_score"] <= 1.0)

    def test_pm25_edges(self):
        self.check_edges(self.PM25_EDGES, "pm25")

    def test_pm10_edges(self):
        self.check_edges(self.PM10_EDGES, "pm10")

    def test_fractional_value_just_above_a_top(self):
        self.assertEqual(classify(pm25=60.5)["severity"], "MEDIUM")
        self.assertEqual(classify(pm10=100.5)["severity"], "MEDIUM")

    def test_risk_rises_with_concentration(self):
        for field, top in (("pm25", 1000), ("pm10", 2000)):
            scores = [classify(**{field: v})["risk_score"] for v in range(0, top, 5)]
            self.assertEqual(scores, sorted(scores), field)

    def test_negative_reading_is_clamped_low(self):
        result = classify(pm25=-5)
        self.assertEqual(result["severity"], "LOW")
        self.assertEqual(result["risk_score"], 0.0)


class WorseWinsTests(unittest.TestCase):
    def test_pm10_worse_than_pm25(self):
        # Dust: coarse particles high, fine particles fine.
        result = classify(pm25=40, pm10=480)
        self.assertEqual(result["severity"], "CRITICAL")
        self.assertEqual(result["responsible_pollutant"], "PM10")

    def test_pm25_worse_than_pm10(self):
        # Smoke: fine particles high, PM10 still only Satisfactory.
        result = classify(pm25=180, pm10=90)
        self.assertEqual(result["severity"], "HIGH")
        self.assertEqual(result["responsible_pollutant"], "PM2.5")

    def test_same_band_tie_broken_by_risk_score(self):
        # Both MEDIUM; PM10 at the top of Poor is further into the band.
        result = classify(pm25=65, pm10=340)
        self.assertEqual(result["severity"], "MEDIUM")
        self.assertEqual(result["responsible_pollutant"], "PM10")
        self.assertEqual(result["risk_score"], classify(pm10=340)["risk_score"])

    def test_classify_all_hazards_keeps_the_detail(self):
        scores = classify_all_hazards({"pm25_ugm3": 40, "pm10_ugm3": 480})
        self.assertEqual(scores["air pollution"]["severity"], "CRITICAL")
        self.assertEqual(scores["air pollution"]["responsible_pollutant"], "PM10")

    def test_process_reading_keeps_the_detail(self):
        # process_reading() used to rebuild each candidate from risk_score
        # and severity only, so responsible_pollutant never reached
        # hazard_scores. A PM-only reading needs no models: the anomaly
        # check skips it (core sensors missing) and there is no flood
        # candidate; with no RAG collection the alert text is a template.
        reading = {"pm25_ugm3": 40, "pm10_ugm3": 480, "location": "test site"}
        result = process_reading(reading, None, None, None, None, None, None)
        self.assertEqual(result["hazard_type"], "air pollution")
        self.assertEqual(result["hazard_scores"]["air pollution"]["responsible_pollutant"], "PM10")


class AnomalyBypassTests(unittest.TestCase):
    """A real pollution spike is statistically rare, so the anomaly model
    may flag it - is_hazard_signature() must let it through."""

    BASE = {"gas_ppm": 400, "flame_reading": 0.0}

    def test_pm10_only_severe_reading_bypasses_the_filter(self):
        self.assertTrue(is_hazard_signature({**self.BASE, "pm10_ugm3": 500}))

    def test_pm10_only_clean_reading_does_not(self):
        self.assertFalse(is_hazard_signature({**self.BASE, "pm10_ugm3": 60}))


if __name__ == "__main__":
    unittest.main()
