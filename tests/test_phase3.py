"""
Unit tests for hazard_confirmation.py, river_forecast.py and
satellite_check.py (Copernicus API mocked - no network or account needed).

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import hazard_confirmation as hc  # noqa: E402
import river_forecast as rf  # noqa: E402
import satellite_check as sc  # noqa: E402

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
REGISTRY = {
    "NODE-04": {"latitude": 29.3919, "longitude": 79.4542, "upstream_node": "NODE-07"},
    "NODE-07": {"latitude": 29.4002, "longitude": 79.4610, "upstream_node": None},
    "FAR": {"latitude": 28.6139, "longitude": 77.2090, "upstream_node": None},  # ~250 km away
}


class HazardConfirmationTests(unittest.TestCase):
    def test_single_reading_is_not_confirmed(self):
        c = hc.HazardConfirmer()
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", T0, REGISTRY), (False, None))

    def test_repeat_on_same_node_confirms(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-04", "flood", "MEDIUM", T0, REGISTRY)
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", T0 + timedelta(seconds=5), REGISTRY), (True, "persistent"))

    def test_repeat_outside_window_does_not_confirm(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-04", "flood", "HIGH", T0, REGISTRY)
        later = T0 + timedelta(minutes=hc.CONFIRM_WINDOW_MINUTES + 1)
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", later, REGISTRY), (False, None))

    def test_neighbour_confirms_but_distant_node_does_not(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-07", "flood", "HIGH", T0, REGISTRY)
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", T0 + timedelta(minutes=1), REGISTRY),
                         (True, "neighbour:NODE-07"))
        c2 = hc.HazardConfirmer()
        c2.assess("FAR", "flood", "HIGH", T0, REGISTRY)
        self.assertEqual(c2.assess("NODE-04", "flood", "HIGH", T0, REGISTRY), (False, None))

    def test_different_hazard_or_low_severity_does_not_confirm(self):
        c = hc.HazardConfirmer()
        c.assess("NODE-04", "gas leak", "HIGH", T0, REGISTRY)
        c.assess("NODE-04", "flood", "LOW", T0, REGISTRY)  # LOW is never recorded
        self.assertEqual(c.assess("NODE-04", "flood", "HIGH", T0 + timedelta(seconds=5), REGISTRY), (False, None))


class RiverForecastTests(unittest.TestCase):
    def _rows(self, minutes, every_s=60, level=lambda m: 2.0, rain=0.0):
        return [(T0 - timedelta(minutes=minutes) + timedelta(seconds=s), level(s / 60), rain)
                for s in range(0, minutes * 60 + 1, every_s)]

    def test_resample_needs_full_two_hours(self):
        self.assertIsNone(rf.resample_readings(self._rows(60), T0))
        levels, rains = rf.resample_readings(self._rows(130), T0)
        self.assertEqual(len(levels), rf.WINDOW_STEPS)

    def test_resample_sums_rain_and_takes_last_level(self):
        levels, rains = rf.resample_readings(self._rows(130, every_s=60, level=lambda m: m / 100, rain=0.1), T0)
        self.assertAlmostEqual(rains[-1], 0.5, places=6)  # five 1-minute readings per 5-min step
        self.assertAlmostEqual(levels[-1], 1.30, places=6)  # last reading at 130 min

    def test_resample_rejects_big_gaps(self):
        rows = [r for r in self._rows(130) if not (T0 - timedelta(minutes=90) < r[0] < T0 - timedelta(minutes=30))]
        self.assertIsNone(rf.resample_readings(rows, T0))

    def test_linear_baseline_extrapolates_last_15_minutes(self):
        levels = np.linspace(2.0, 2.0 + 0.1 * (rf.WINDOW_STEPS - 1), rf.WINDOW_STEPS)  # +0.1 m per step
        X = np.stack([(levels - levels[-1]) / rf.LEVEL_SCALE_M, np.zeros(rf.WINDOW_STEPS)], axis=1)[None]
        pred_m = rf.linear_baseline(X)[0] * rf.LEVEL_SCALE_M
        np.testing.assert_allclose(pred_m, [0.1 * h for h in rf.HORIZON_STEPS], atol=1e-6)


def _stats_response(days):
    """days: list of (date, mean or None for a no-pass day)"""
    data = []
    for date, mean in days:
        stats = {"mean": mean, "sampleCount": 100, "noDataCount": 0} if mean is not None else \
            {"mean": "NaN", "sampleCount": 100, "noDataCount": 100}
        data.append({"interval": {"from": f"{date}T00:00:00Z"}, "outputs": {"water": {"bands": {"B0": {"stats": stats}}}}})
    return {"data": data, "status": "OK"}


class SatelliteCheckTests(unittest.TestCase):
    def setUp(self):
        sc._cache.clear()
        sc._token.update(value=None, expires_at=0)

    def test_bbox_is_about_2km(self):
        lon0, lat0, lon1, lat1 = sc.bbox_around(29.39, 79.45)
        self.assertAlmostEqual((lat1 - lat0) * 111.32, 2.0, places=2)
        self.assertAlmostEqual((lon1 - lon0) * 111.32 * np.cos(np.radians(29.39)), 2.0, places=2)

    def test_request_shape(self):
        req = sc.build_statistics_request([1, 2, 3, 4], T0 - timedelta(days=12), T0)
        self.assertEqual(req["input"]["data"][0]["type"], "sentinel-1-grd")
        self.assertEqual(req["aggregation"]["timeRange"]["to"], "2026-10-06T12:00:00Z")
        self.assertIn("dataMask", req["aggregation"]["evalscript"])

    def test_parse_skips_days_without_a_pass(self):
        parsed = sc.parse_water_fractions(_stats_response([("2026-10-01", 0.2), ("2026-10-02", None), ("2026-09-28", 0.1)]))
        self.assertEqual(parsed, [("2026-09-28", 0.1), ("2026-10-01", 0.2)])

    def test_interpret(self):
        ref = [("2026-07-01", 0.05), ("2026-07-13", 0.07), ("2026-07-25", 0.06)]
        self.assertEqual(sc.interpret([("2026-10-01", 0.25)], ref)["status"], "flood_signal")
        self.assertEqual(sc.interpret([("2026-10-01", 0.10)], ref)["status"], "no_flood_signal")
        self.assertEqual(sc.interpret([], ref)["status"], "no_recent_pass")
        self.assertEqual(sc.interpret([("2026-10-01", 0.3)], [])["status"], "no_reference")

    def test_unavailable_without_credentials(self):
        with mock.patch.dict(os.environ, {"CDSE_CLIENT_ID": "", "CDSE_CLIENT_SECRET": ""}):
            self.assertEqual(sc.satellite_flood_check("NODE-04", 29.39, 79.45)["status"], "unavailable")

    def test_full_flow_with_mocked_api(self):
        calls = []

        def fake_post(url, **kwargs):
            calls.append(url)
            resp = mock.Mock()
            resp.raise_for_status = lambda: None
            if url == sc.TOKEN_URL:
                resp.json = lambda: {"access_token": "tok", "expires_in": 600}
            elif kwargs["json"]["aggregation"]["timeRange"]["to"].startswith("2026-10-06"):  # recent window
                resp.json = lambda: _stats_response([("2026-10-03", 0.31)])
            else:
                resp.json = lambda: _stats_response([("2026-07-01", 0.05), ("2026-07-13", 0.07)])
            return resp

        with mock.patch.dict(os.environ, {"CDSE_CLIENT_ID": "id", "CDSE_CLIENT_SECRET": "secret"}), \
                mock.patch.object(sc.requests, "post", side_effect=fake_post):
            result = sc.satellite_flood_check("NODE-04", 29.39, 79.45, now=T0)
            self.assertEqual(result["status"], "flood_signal")
            self.assertEqual(result["latest_pass_date"], "2026-10-03")
            self.assertAlmostEqual(result["increase"], 0.25, places=3)
            self.assertEqual(calls.count(sc.TOKEN_URL), 1)  # token fetched once, reused
            sc.satellite_flood_check("NODE-04", 29.39, 79.45, now=T0)
            self.assertEqual(len(calls), 3)  # second call served from cache

    def test_api_error_is_reported_not_raised(self):
        with mock.patch.dict(os.environ, {"CDSE_CLIENT_ID": "id", "CDSE_CLIENT_SECRET": "secret"}), \
                mock.patch.object(sc.requests, "post", side_effect=ConnectionError("offline")):
            result = sc.satellite_flood_check("NODE-04", 29.39, 79.45, now=T0)
            self.assertEqual(result["status"], "unavailable")
            self.assertIn("offline", result["message"])


if __name__ == "__main__":
    unittest.main()
