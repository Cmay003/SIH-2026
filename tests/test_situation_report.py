"""
Situation-report PDF labelling (backend lane, review 2026-10-09):

  - a report built on SIMULATED readings carries the banner
    "EXERCISE - SIMULATED DATA, NOT A REAL EVENT" on EVERY page (same
    meaning as CAP status "Exercise" / the Atom feed's "[EXERCISE]");
  - a forecast-only alert (severity_source "weather_forecast") gets a
    "Forecast-based" row naming the forecast source;
  - the confirmation basis is printed.

The PDF page streams are zlib-compressed (fpdf 1.7); the test inflates
them and searches the text operators. Writes only to a temp directory.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import re
import shutil
import sys
import tempfile
import unittest
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import situation_report as sr  # noqa: E402


def _pdf_text(path: str) -> str:
    with open(path, "rb") as f:
        data = f.read()
    chunks = []
    for m in re.finditer(rb"stream\r?\n(.*?)\r?\nendstream", data, re.S):
        raw = m.group(1)
        try:
            chunks.append(zlib.decompress(raw))
        except zlib.error:
            chunks.append(raw)
    # PDF string literals escape "(" and ")"
    return b"\n".join(chunks).decode("latin-1").replace("\\(", "(").replace("\\)", ")")


def _page_count(path: str) -> int:
    with open(path, "rb") as f:
        return len(re.findall(rb"/Type /Page\b(?!s)", f.read()))


BASE_EVENT = {
    "node_id": "NODE-04", "location": "Test hill", "timestamp": "2026-10-09T10:00:00Z",
    "hazard_type": "heavy_rain", "severity": "HIGH", "risk_score": 0.82,
    "severity_source": "threshold_classifier", "status": "alert_dispatched",
    "confirmation": "persistent", "confidence": 0.8, "confidence_label": "High",
    "confidence_reasons": "[]", "message": "Test alert.",
}


class SituationReportLabelTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="sj_test_report_")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def render(self, event, timeline=()):
        path = os.path.join(self.tmp, "r.pdf")
        sr.generate_situation_report_pdf(event, list(timeline), path)
        return path

    def test_simulated_alert_has_exercise_banner_on_every_page(self):
        # a long message forces a second page
        event = {**BASE_EVENT, "simulated": 1, "message": "Long simulated alert text. " * 300}
        path = self.render(event)
        pages = _page_count(path)
        self.assertGreaterEqual(pages, 2)
        text = _pdf_text(path)
        self.assertEqual(text.count(sr.EXERCISE_BANNER), pages)
        self.assertIn("SIMULATED / synthetic (exercise)", text)

    def test_real_alert_has_no_exercise_banner(self):
        text = _pdf_text(self.render({**BASE_EVENT, "simulated": 0}))
        self.assertNotIn("EXERCISE", text)
        self.assertIn("Live sensor data", text)
        self.assertIn("Persistent - the same node repeated the assessment", text)
        self.assertNotIn("Forecast-based", text)

    def test_forecast_alert_says_forecast_based_and_its_source(self):
        event = {**BASE_EVENT, "simulated": 1, "severity_source": "weather_forecast",
                 "forecast_source": "mock", "confirmation": "forecast"}
        text = _pdf_text(self.render(event))
        self.assertIn("Forecast-based", text)
        self.assertIn("TEST forecast file", text)
        self.assertIn("measured by SANJEEVNI sensors", text)  # the row wraps after "not"
        self.assertIn("confirmed by its external forecast source", text)

    def test_pending_alert_says_not_confirmed(self):
        event = {**BASE_EVENT, "status": "pending_confirmation", "confirmation": "unconfirmed"}
        self.assertIn("NOT confirmed", _pdf_text(self.render(event)))

    def test_is_exercise_values(self):
        for value, expected in ((1, True), (0, False), (None, False), ("1", True),
                                ("true", True), ("0", False), (True, True)):
            self.assertEqual(sr.is_exercise({"simulated": value}), expected, value)


if __name__ == "__main__":
    unittest.main()
