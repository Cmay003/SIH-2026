"""
CAP 1.2 XML schema validation - reproducible from the repo.

Validates the CAP XML that cap_alert.generate_cap_alert (and the
/api/alerts/{id}/cap endpoint) produces against the official OASIS CAP 1.2
schema, kept unmodified in data/cap_schema/CAP-v1.2.xsd (source URL,
licence and SHA-256 in data/cap_schema/README.md).

Covers every hazard type in cap_alert.HAZARD_TO_CAP - including flash_flood,
smoke, heavy_rain and high_wind - plus an unmapped one, at every severity,
for Actual and Exercise status and every severity_source / confidence path
that changes <urgency> or <certainty>.

Schema validity is necessary but not sufficient for a conforming CAP
message (CAP 1.2 section 4.2 also requires the data-dictionary rules);
the element-order / datetime rules are tested in test_forecast_cap_training.py.

Needs lxml (requirements.txt). Skipped with a clear message if it is not
installed:   venv\\Scripts\\python.exe -m pip install lxml
Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import hashlib
import os
import re
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import cap_alert  # noqa: E402

try:
    from lxml import etree
except ImportError:  # pragma: no cover - exercised only without lxml
    etree = None

XSD_PATH = os.path.join(ROOT, "data", "cap_schema", "CAP-v1.2.xsd")
XSD_README = os.path.join(ROOT, "data", "cap_schema", "README.md")
NO_LXML = "lxml is not installed - CAP XSD validation skipped (pip install -r requirements.txt)"
REQUIRED_HAZARDS = ("flood", "flash_flood", "smoke", "gas leak", "fire", "extreme heat", "landslide",
                    "air pollution", "water quality degradation", "heavy_rain", "high_wind")
SENT = datetime(2026, 10, 9, 6, 30, 15, 123456, tzinfo=timezone.utc)


class CapSchemaFileTests(unittest.TestCase):
    def test_schema_file_is_the_documented_unmodified_download(self):
        with open(XSD_PATH, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        with open(XSD_README, encoding="utf-8") as f:
            documented = re.search(r"`([0-9a-f]{64})`", f.read()).group(1)
        self.assertEqual(digest, documented)

    def test_every_project_hazard_has_a_cap_mapping(self):
        for hazard in REQUIRED_HAZARDS:
            self.assertIn(hazard, cap_alert.HAZARD_TO_CAP, hazard)


@unittest.skipIf(etree is None, NO_LXML)
class CapSchemaValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.schema = etree.XMLSchema(etree.parse(XSD_PATH))

    def assertValid(self, xml: str, label: str):
        doc = etree.fromstring(xml.encode("utf-8"))
        if not self.schema.validate(doc):
            self.fail(f"{label}: {self.schema.error_log.last_error}")
        return doc

    def _cap(self, **kw):
        args = dict(hazard_type="flood", severity="HIGH", location="Sector 4, Riverside",
                    latitude=29.376, longitude=79.52, message="Test message & <escaping>",
                    node_id="NODE-04", risk_score=0.8, reading_id=42, sent_at=SENT)
        args.update(kw)
        return cap_alert.generate_cap_alert(**args)

    def test_every_hazard_and_severity_validates(self):
        hazards = list(cap_alert.HAZARD_TO_CAP) + ["some_unmapped_hazard"]
        count = 0
        for hazard in hazards:
            for severity in cap_alert.SEVERITY_TO_CAP:
                for status in ("Actual", "Exercise"):
                    self.assertValid(self._cap(hazard_type=hazard, severity=severity, status=status),
                                     f"{hazard}/{severity}/{status}")
                    count += 1
        self.assertGreaterEqual(count, len(REQUIRED_HAZARDS) * 4 * 2)

    def test_certainty_and_urgency_paths_validate(self):
        cases = [
            # (severity_source, confidence, confirmation, hazard)
            ("ml_model", None, None, "flood"),
            ("threshold_classifier", 0.9, "persistent", "smoke"),            # Observed
            ("threshold_classifier", 0.9, "neighbour:NODE-07", "flash_flood"),
            ("threshold_classifier", 0.1, "unconfirmed", "gas leak"),        # Unlikely
            ("hardware_test_threshold", 0.9, "persistent", "fire"),          # capped Possible
            ("weather_forecast", 0.6, "forecast", "heavy_rain"),             # Future / Possible
            ("weather_forecast", 0.4, "unconfirmed", "high_wind"),
            ("threshold_classifier", 0.75, "persistent", "heavy_rain"),      # measured rain
        ]
        ns = {"c": cap_alert.CAP_NAMESPACE}
        for source, conf, confirmation, hazard in cases:
            doc = self.assertValid(self._cap(hazard_type=hazard, severity_source=source, confidence=conf,
                                             confirmation=confirmation), f"{hazard}/{source}/{conf}")
            if source == "weather_forecast":
                self.assertEqual(doc.findtext("c:info/c:urgency", namespaces=ns), "Future")
                self.assertIn(doc.findtext("c:info/c:certainty", namespaces=ns), ("Possible", "Unlikely"))

    def test_without_stored_id_or_time_still_validates(self):
        self.assertValid(self._cap(reading_id=None, sent_at=None), "ad-hoc")

    def test_validator_really_rejects_a_broken_message(self):
        """Guards the test itself: a fractional-second <sent> (forbidden by
        the XSD pattern) and a made-up <severity> must both fail."""
        good = self._cap()
        bad_time = re.sub(r"<sent>[^<]+</sent>", "<sent>2026-10-09T06:30:15.12-00:00</sent>", good)
        bad_sev = good.replace("<severity>Severe</severity>", "<severity>HIGH</severity>")
        for bad in (bad_time, bad_sev):
            self.assertFalse(self.schema.validate(etree.fromstring(bad.encode("utf-8"))))

    def test_endpoint_output_validates_for_new_hazards(self):
        from fastapi.testclient import TestClient
        import backend_server as bs

        tmp = tempfile.mkdtemp(prefix="sj_cap_xsd_")
        real_db = bs.DB_PATH
        bs.DB_PATH = os.path.join(tmp, "test.db")
        try:
            bs.init_db()
            client = TestClient(bs.app)  # no `with`: startup must not run
            conn = sqlite3.connect(bs.DB_PATH)
            for i, (hazard, source, sim) in enumerate([
                ("flash_flood", "threshold_classifier", 0), ("smoke", "threshold_classifier", 1),
                ("heavy_rain", "weather_forecast", 1), ("high_wind", "weather_forecast", 0),
            ]):
                cur = conn.execute(
                    "INSERT INTO readings (node_id, location, status, hazard_type, severity, risk_score, "
                    "severity_source, message, timestamp, simulated, latitude, longitude, confidence, "
                    "confirmation) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    ("NODE-04", "Sector 4", "alert_dispatched", hazard, "HIGH", 0.8, source, "msg",
                     f"2026-10-09T06:3{i}:00.5+00:00", sim, 29.1, 79.2, 0.6, "persistent"),
                )
                conn.commit()
                r = client.get(f"/api/alerts/{cur.lastrowid}/cap")
                self.assertEqual(r.status_code, 200, hazard)
                self.assertValid(r.text, f"endpoint {hazard}")
            conn.close()
        finally:
            bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
            bs.DB_PATH = real_db
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
