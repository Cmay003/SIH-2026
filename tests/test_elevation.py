"""
Unit tests for the terrain-derived curve number in backend_server.py
(fetch_terrain_derived_curve_number, Open-Meteo Elevation API).

requests.get is mocked - these tests never touch the network.
Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import backend_server as bs  # noqa: E402

LAT, LON = 29.3919, 79.4542  # NODE-04 seed position
OFF = bs.ELEVATION_SAMPLE_OFFSET_DEG
DIST_M = OFF * 111_320  # same spacing the backend assumes


def ok_response(elevations):
    resp = mock.Mock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"elevation": elevations}
    return resp


class TerrainCurveNumberTests(unittest.TestCase):
    def setUp(self):
        # Module-level state: start every test with an empty cache and no back-off.
        bs._elevation_cache.clear()
        bs._api_failed_at.pop("elevation", None)
        self.addCleanup(bs._elevation_cache.clear)
        self.addCleanup(bs._api_failed_at.pop, "elevation", None)
        # The failure path prints a log line; keep test output clean.
        patcher = mock.patch("builtins.print")
        patcher.start()
        self.addCleanup(patcher.stop)

    def call(self, node_id="NODE-T", land_use="urban_low"):
        return bs.fetch_terrain_derived_curve_number(LAT, LON, land_use, node_id)

    def test_request_url_and_params(self):
        with mock.patch.object(bs.requests, "get", return_value=ok_response([100.0] * 5)) as get:
            self.call()
        get.assert_called_once()
        args, kwargs = get.call_args
        self.assertEqual(args[0], "https://api.open-meteo.com/v1/elevation")
        lats = [float(x) for x in kwargs["params"]["latitude"].split(",")]
        lons = [float(x) for x in kwargs["params"]["longitude"].split(",")]
        # centre, north, south, east, west - in that order (centre is [0])
        expected = [
            (LAT, LON),
            (LAT + OFF, LON),
            (LAT - OFF, LON),
            (LAT, LON + OFF),
            (LAT, LON - OFF),
        ]
        self.assertEqual(len(lats), 5)
        self.assertEqual(len(lons), 5)
        for (lat, lon), (elat, elon) in zip(zip(lats, lons), expected):
            self.assertAlmostEqual(lat, elat, places=9)
            self.assertAlmostEqual(lon, elon, places=9)
        self.assertEqual(kwargs["timeout"], bs.ELEVATION_FETCH_TIMEOUT_SECONDS)

    def test_success_gives_slope_and_curve_number(self):
        # Real values returned for NODE-04's five points (one curl, 2026-10-08).
        elevs = [1966.0, 1985.0, 1952.0, 1963.0, 1974.0]
        with mock.patch.object(bs.requests, "get", return_value=ok_response(elevs)):
            result = self.call(land_use="urban_low")
        slope = max(abs(elevs[0] - e) for e in elevs[1:]) / DIST_M * 100  # 19 m / 111 m
        adj = min(bs.SLOPE_CN_ADJUSTMENT_MAX, slope / 15.0 * bs.SLOPE_CN_ADJUSTMENT_MAX)
        self.assertEqual(result["slope_pct"], round(slope, 2))
        self.assertEqual(result["curve_number"], round(min(98, 80 + adj), 1))
        self.assertEqual(result["curve_number"], 86.0)  # steep: capped at base + 6
        self.assertEqual(result["source"], "terrain_derived")

    def test_flat_terrain_keeps_land_use_base(self):
        with mock.patch.object(bs.requests, "get", return_value=ok_response([500.0] * 5)):
            result = self.call(land_use="forest")
        self.assertEqual(result["slope_pct"], 0.0)
        self.assertEqual(result["curve_number"], 45.0)

    def test_gentle_slope_is_proportional(self):
        # 5.566 m over 111.32 m = 5% slope -> 5/15 of the 6-point cap = +2
        rise = 0.05 * DIST_M
        elevs = [100.0, 100.0 + rise, 100.0, 100.0, 100.0]
        with mock.patch.object(bs.requests, "get", return_value=ok_response(elevs)):
            result = self.call(land_use="agricultural")
        self.assertEqual(result["slope_pct"], 5.0)
        self.assertEqual(result["curve_number"], 67.0)

    def test_cache_hit_makes_no_second_request(self):
        with mock.patch.object(bs.requests, "get", return_value=ok_response([100.0] * 5)) as get:
            first = self.call()
            second = self.call()
        self.assertEqual(get.call_count, 1)
        self.assertEqual(first, second)

    def assert_falls_back_and_backs_off(self, get_mock):
        with mock.patch.object(bs.requests, "get", get_mock):
            self.assertIsNone(self.call())  # caller then uses the hand-typed CN
            self.assertIn("elevation", bs._api_failed_at)
            # Within the back-off window: no new request at all.
            self.assertIsNone(self.call(node_id="NODE-OTHER"))
        self.assertEqual(get_mock.call_count, 1)
        self.assertNotIn("NODE-T", bs._elevation_cache)

    def test_malformed_response_falls_back(self):
        resp = mock.Mock()
        resp.raise_for_status.return_value = None
        resp.json.return_value = {"results": [{"elevation": 1.0}]}  # old Open-Elevation shape
        self.assert_falls_back_and_backs_off(mock.Mock(return_value=resp))

    def test_wrong_point_count_falls_back(self):
        self.assert_falls_back_and_backs_off(mock.Mock(return_value=ok_response([1.0, 2.0])))

    def test_null_elevation_falls_back(self):
        self.assert_falls_back_and_backs_off(
            mock.Mock(return_value=ok_response([1.0, None, 1.0, 1.0, 1.0]))
        )

    def test_http_error_falls_back(self):
        # Open-Meteo answers bad input with HTTP 400 + {"error": true, "reason": ...}
        resp = mock.Mock()
        resp.raise_for_status.side_effect = requests.HTTPError("400 Client Error")
        resp.json.return_value = {"error": True, "reason": "Latitude must be in range"}
        self.assert_falls_back_and_backs_off(mock.Mock(return_value=resp))

    def test_timeout_falls_back(self):
        self.assert_falls_back_and_backs_off(mock.Mock(side_effect=requests.Timeout("timed out")))

    def test_retries_after_back_off_expires(self):
        bs._api_failed_at["elevation"] = datetime.now(timezone.utc) - timedelta(
            minutes=bs.EXTERNAL_API_RETRY_AFTER_MINUTES + 1
        )
        with mock.patch.object(bs.requests, "get", return_value=ok_response([100.0] * 5)) as get:
            result = self.call()
        self.assertEqual(get.call_count, 1)
        self.assertIsNotNone(result)
        self.assertNotIn("elevation", bs._api_failed_at)  # success clears the back-off


if __name__ == "__main__":
    unittest.main()
