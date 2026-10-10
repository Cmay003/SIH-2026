"""
Extreme weather + IMD heat fix (backend lane step B1, 2026-10-09):

  - extreme heat graded with IMD's heat-wave criteria (45 C heat wave /
    47 C severe heat wave on plains; departure-from-normal criterion when a
    normal is known; 40 / 37 / 30 C minimum for plains / coastal / hills)
  - heavy_rain from the node's gauge (24 h, >= 2 reports) and the 24 h
    forecast, with IMD rainfall categories (64.5 / 115.6 / 204.5 mm)
  - high_wind from the forecast (IMD gale force 62 km/h; gust thresholds
    are demo defaults)
  - forecast-only alerts: capped at HIGH, confirmed by their source (basis
    "forecast"), never by node repeats, a mock forecast never confirms a
    real reading, confidence at most Medium with a "Forecast-based" reason,
    CAP urgency Future / certainty Possible
  - Open-Meteo fetch extended to 24 h rain + wind; SANJEEVNI_WEATHER_MOCK

No network: requests.get is stubbed and the forecast comes from fake
payloads or the SYNTHETIC files in data/weather_mock/. Uses a throwaway
SQLite file - var/ is never touched.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import collections
import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from xml.dom import minidom

import joblib
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

import alert_confidence as ac  # noqa: E402
import backend_server as bs  # noqa: E402
import cap_alert  # noqa: E402
import hazard_classification as hcl  # noqa: E402
import hazard_confirmation as hc  # noqa: E402
import integration_pipeline as ip  # noqa: E402
import paths  # noqa: E402

MODELS = paths.MODELS_DIR
HAVE_MODELS = os.path.exists(os.path.join(MODELS, "flood_model.joblib"))
MOCK_DIR = os.path.join(ROOT, "data", "weather_mock")
T0 = datetime(2026, 10, 8, 12, 0, tzinfo=timezone.utc)


def _offline(*_a, **_k):
    raise requests.ConnectionError("offline (test)")


def _fixed_datetime(at: datetime):
    class Fixed(datetime):
        @classmethod
        def now(cls, tz=None):
            return at if tz is None else at.astimezone(tz)

    return Fixed


class _FakeResponse:
    def __init__(self, payload):
        self._payload = payload

    def raise_for_status(self):
        pass

    def json(self):
        return self._payload


def _payload(start, hours, rain=1.0, wind=10.0, gust=20.0, units=None):
    times = [(start + timedelta(hours=h)).strftime("%Y-%m-%dT%H:00") for h in range(hours)]

    def series(v):
        return v if isinstance(v, list) else [v] * hours

    hourly = {"time": times, "precipitation": series(rain)}
    if wind is not None:
        hourly["wind_speed_10m"] = series(wind)
    if gust is not None:
        hourly["wind_gusts_10m"] = series(gust)
    out = {"hourly": hourly}
    if units:
        out["hourly_units"] = units
    return out


def heat(temp_c, **extra):
    return hcl.classify_extreme_heat({"temp_c": temp_c, **extra})


# --- IMD heat-wave criteria ----------------------------------------------------

class HeatTests(unittest.TestCase):
    def test_plains_actual_temperature_criterion(self):
        # IMD: heat wave >= 45 C, severe heat wave >= 47 C (plains only).
        # The old code called 45 C "severe" (CRITICAL).
        self.assertEqual(heat(39.9)["severity"], "LOW")
        r = heat(40.0)
        self.assertEqual((r["severity"], r["imd_category"]), ("MEDIUM", "heat_wave_threshold"))
        self.assertEqual(heat(44.9)["severity"], "MEDIUM")
        r = heat(45.0)
        self.assertEqual((r["severity"], r["imd_category"], r["criterion"]), ("HIGH", "heat_wave", "actual"))
        self.assertEqual(heat(46.9)["severity"], "HIGH")
        r = heat(47.0)
        self.assertEqual((r["severity"], r["imd_category"]), ("CRITICAL", "severe_heat_wave"))

    def test_departure_from_normal_criterion(self):
        # 4.5-6.4 C above normal: heat wave; more than 6.4 C: severe
        r = heat(41.0, normal_max_temp_c=36.5)
        self.assertEqual((r["severity"], r["imd_category"], r["criterion"]), ("HIGH", "heat_wave", "departure"))
        self.assertEqual(heat(42.4, normal_max_temp_c=36.0)["imd_category"], "heat_wave")  # 6.4 exactly
        r = heat(42.5, normal_max_temp_c=36.0)
        self.assertEqual((r["severity"], r["imd_category"]), ("CRITICAL", "severe_heat_wave"))
        self.assertEqual(heat(41.0, normal_max_temp_c=38.0)["imd_category"], "heat_wave_threshold")

    def test_departure_needs_the_regions_minimum_temperature(self):
        # 7 C above normal but below the plains' 40 C: not a heat wave
        self.assertEqual(heat(39.0, normal_max_temp_c=32.0)["severity"], "LOW")

    def test_hills_have_no_absolute_criterion(self):
        r = heat(32.0, heat_region="hilly")
        self.assertEqual((r["severity"], r["imd_category"]), ("MEDIUM", "heat_wave_threshold"))
        # 46 C on a hill station: without a normal, IMD gives no absolute
        # criterion for hills, so it stays at the threshold level
        self.assertEqual(heat(46.0, heat_region="hilly")["severity"], "MEDIUM")
        self.assertEqual(heat(29.9, heat_region="hilly")["severity"], "LOW")
        r = heat(32.0, heat_region="hilly", normal_max_temp_c=27.0)
        self.assertEqual((r["severity"], r["imd_category"]), ("HIGH", "heat_wave"))
        self.assertEqual(heat(32.0, heat_region="hilly", normal_max_temp_c=25.0)["severity"], "CRITICAL")

    def test_coastal_needs_37_c(self):
        self.assertEqual(heat(38.0, heat_region="coastal", normal_max_temp_c=33.0)["severity"], "HIGH")
        self.assertEqual(heat(36.5, heat_region="coastal", normal_max_temp_c=30.0)["severity"], "LOW")

    def test_coastal_departure_stops_at_heat_wave(self):
        # 10 C above normal: severe elsewhere, but IMD's coastal clause
        # names only a heat wave - HIGH, never CRITICAL (siren-eligible)
        r = heat(43.0, heat_region="coastal", normal_max_temp_c=33.0)
        self.assertEqual((r["severity"], r["imd_category"], r["criterion"]), ("HIGH", "heat_wave", "departure"))
        self.assertLessEqual(r["risk_score"], 0.9)
        self.assertEqual(heat(43.0, normal_max_temp_c=33.0)["severity"], "CRITICAL")  # plains unchanged

    def test_region_default_and_unknown_region(self):
        with mock.patch.object(hcl, "DEFAULT_HEAT_REGION", "hilly"):
            self.assertEqual(heat(32.0)["heat_region"], "hilly")
        self.assertEqual(heat(45.0, heat_region="desert")["heat_region"], "plains")

    def test_alert_text_does_not_claim_an_imd_declaration(self):
        text = ip.alert_detail("extreme heat", heat(45.5))
        self.assertIn("IMD's heat wave level", text)
        self.assertIn("one sensor's reading", text)
        self.assertIn("severe heat wave", ip.alert_detail("extreme heat", heat(47.5)))


# --- heavy rain ------------------------------------------------------------------

def rain(measured=None, forecast=None, reports=None, source="open-meteo"):
    reading = {"rainfall_24h_mm": measured, "forecast_rainfall_24h_mm": forecast,
               "forecast_source": source if forecast is not None else None}
    if reports is not None:
        reading["rainfall_windows_count"] = {1: reports, 3: reports, 6: reports, 12: reports, 24: reports}
    return hcl.classify_heavy_rain(reading)


class RainCategoryTests(unittest.TestCase):
    def test_imd_category_boundaries(self):
        cases = [(64.4, None), (64.5, "heavy"), (115.5, "heavy"), (115.6, "very_heavy"),
                 (204.4, "very_heavy"), (204.5, "extremely_heavy"), (None, None)]
        for mm, expected in cases:
            self.assertEqual(hcl.imd_rain_category(mm), expected, mm)


class HeavyRainTests(unittest.TestCase):
    def test_no_rain_and_no_forecast_is_none(self):
        self.assertIsNone(rain())
        self.assertIsNone(rain(measured=0.0, reports=0))

    def test_forecast_only_is_forecast_based_and_capped_at_high(self):
        r = rain(forecast=80.0)
        self.assertEqual((r["severity"], r["basis"], r["forecast_based"], r["severity_source"]),
                         ("MEDIUM", "forecast", True, "weather_forecast"))
        r = rain(forecast=400.0)  # far into "extremely heavy"
        self.assertEqual(r["severity"], "HIGH")
        self.assertLessEqual(r["risk_score"], 0.9)

    def test_measured_rain_with_several_reports(self):
        r = rain(measured=130.0, reports=5)
        self.assertEqual((r["severity"], r["basis"], r["forecast_based"], r["severity_source"]),
                         ("HIGH", "measured", False, "threshold_classifier"))
        self.assertEqual(rain(measured=70.0, reports=3)["severity"], "MEDIUM")
        self.assertEqual(rain(measured=300.0, reports=9)["severity"], "HIGH")  # never CRITICAL

    def test_measured_total_from_one_or_unknown_reports_cannot_trigger(self):
        for reports in (1, None):
            r = rain(measured=130.0, reports=reports)
            self.assertEqual(r["severity"], "LOW", reports)
            self.assertTrue(r["measured_gated"])
            self.assertEqual(r["measured_category"], "very_heavy")  # still shown

    def test_measured_and_forecast_same_band_is_measured(self):
        # gauge "heavy" (MEDIUM) and forecast "heavy" (MEDIUM): the gauge
        # sets the severity, normal node confirmation applies
        r = rain(measured=70.0, forecast=100.0, reports=4)
        self.assertEqual((r["basis"], r["severity_basis"], r["forecast_based"], r["severity"],
                          r["severity_source"]),
                         ("both", "measured", False, "MEDIUM", "threshold_classifier"))
        text = ip.alert_detail("heavy_rain", r)
        self.assertIn("rain gauge measured 70.0 mm", text)
        self.assertNotIn("Forecast-based", text)
        self.assertNotIn("forecast-based", text)

    def test_forecast_above_the_gauge_makes_the_result_forecast_based(self):
        # Review 2026-10-09: gauge "heavy" (MEDIUM) + forecast "very heavy"
        # used to be a HIGH labelled as measured (node-repeat confirmation,
        # CAP Immediate / Observed, no forecast caveat).
        r = rain(measured=70.0, forecast=129.0, reports=5, source="mock")
        self.assertEqual((r["basis"], r["severity_basis"], r["forecast_based"], r["severity"],
                          r["severity_source"]),
                         ("both", "forecast", True, "HIGH", "weather_forecast"))
        self.assertLessEqual(r["risk_score"], 0.9)
        text = ip.alert_detail("heavy_rain", r)
        self.assertIn("rain gauge measured 70.0 mm", text)
        self.assertIn("very heavy rain", text)
        self.assertIn("Severity is forecast-based", text)
        self.assertIn("TEST forecast file", text)
        self.assertNotEqual(cap_alert.certainty_for(0.9, "persistent", "heavy_rain", r["severity_source"]),
                            "Observed")
        conf = ac.compute_confidence(
            {"status": "alert_dispatched", "severity": "HIGH", "hazard_type": "heavy_rain",
             "forecast_based": True, "forecast_source": "mock", "confirmation": "forecast",
             "hazard_scores": {"heavy_rain": r}}, {})
        self.assertIn("Forecast-based severity", conf["confidence_reasons"][0])

    def test_gauge_above_the_forecast_stays_measured(self):
        r = rain(measured=130.0, forecast=70.0, reports=5)
        self.assertEqual((r["severity_basis"], r["forecast_based"], r["severity"]), ("measured", False, "HIGH"))

    def test_quiet_gauge_with_small_forecast(self):
        r = rain(measured=10.0, forecast=5.0, reports=4)
        self.assertEqual((r["severity"], r["basis"], r["forecast_based"]), ("LOW", None, False))

    def test_forecast_alert_text_says_forecast_based_and_mock(self):
        text = ip.alert_detail("heavy_rain", rain(forecast=80.0))
        self.assertIn("Open-Meteo", text)
        self.assertIn("Forecast-based: not measured by SANJEEVNI sensors", text)
        self.assertIn("TEST forecast file", ip.alert_detail("heavy_rain", rain(forecast=80.0, source="mock")))


# --- high wind -------------------------------------------------------------------

def wind(speed=None, gust=None):
    return hcl.classify_high_wind({"forecast_wind_speed_max_kmh": speed, "forecast_wind_gust_max_kmh": gust,
                                   "forecast_source": "open-meteo"})


class HighWindTests(unittest.TestCase):
    def test_none_without_forecast(self):
        self.assertIsNone(wind())

    def test_thresholds(self):
        self.assertEqual(wind(speed=61.9, gust=30)["severity"], "LOW")
        r = wind(speed=62.0, gust=70)
        self.assertEqual((r["severity"], r["wind_trigger"]), ("HIGH", "gale_force_wind"))
        self.assertEqual(wind(speed=30, gust=90.0)["severity"], "HIGH")
        r = wind(speed=30, gust=60.0)
        self.assertEqual((r["severity"], r["wind_trigger"]), ("MEDIUM", "gust"))
        self.assertEqual(wind(speed=30, gust=59.0)["severity"], "LOW")

    def test_always_forecast_based_and_never_critical(self):
        r = wind(speed=250.0, gust=300.0)
        self.assertEqual((r["severity"], r["forecast_based"], r["severity_source"]),
                         ("HIGH", True, "weather_forecast"))
        self.assertLessEqual(r["risk_score"], 0.9)
        self.assertIn("IMD gale force", ip.alert_detail("high_wind", wind(speed=70, gust=95)))


# --- pipeline rules --------------------------------------------------------------

STORM = {"forecast_rainfall_24h_mm": 129.0, "forecast_wind_speed_max_kmh": 48.0,
         "forecast_wind_gust_max_kmh": 96.0, "forecast_source": "open-meteo"}


class PipelineRuleTests(unittest.TestCase):
    def test_forecast_never_bypasses_the_anomaly_filter(self):
        self.assertFalse(ip.is_hazard_signature({**STORM, "temp_c": 25.0}))
        self.assertTrue(ip.is_hazard_signature({**STORM, "temp_c": 46.0}))

    def test_cap_forecast_candidate(self):
        c = {"severity": "CRITICAL", "risk_score": 0.97, "forecast_based": True}
        self.assertEqual(ip.cap_forecast_candidate(c)["severity"], "HIGH")
        self.assertLessEqual(ip.cap_forecast_candidate(c)["risk_score"], 0.9)
        measured = {"severity": "CRITICAL", "risk_score": 0.97}
        self.assertIs(ip.cap_forecast_candidate(measured), measured)


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class PipelineTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.models = (
            joblib.load(os.path.join(MODELS, "anomaly_model.joblib")),
            joblib.load(os.path.join(MODELS, "anomaly_scaler.joblib")),
            joblib.load(os.path.join(MODELS, "flood_model.joblib")),
            joblib.load(os.path.join(MODELS, "flood_feature_cols.joblib")),
        )

    def run_pipeline(self, **overrides):
        reading = {**ip.demo_readings()[0], **overrides}  # the quiet NODE-04 reading
        return ip.process_reading(reading, *self.models, None, None)

    def test_quiet_reading_without_forecast_is_unchanged(self):
        r = self.run_pipeline()
        self.assertEqual(r["status"], "logged")
        # 12 mm measured: reported as LOW, not forecast-based; no wind entry
        self.assertEqual(r["hazard_scores"]["heavy_rain"]["severity"], "LOW")
        self.assertFalse(r["hazard_scores"]["heavy_rain"]["forecast_based"])
        self.assertNotIn("high_wind", r["hazard_scores"])
        self.assertNotIn("forecast_based", r)

    def test_storm_forecast_raises_a_forecast_based_high(self):
        r = self.run_pipeline(**STORM)
        self.assertEqual((r["status"], r["hazard_type"], r["severity"]), ("alert_dispatched", "heavy_rain", "HIGH"))
        self.assertEqual(r["severity_source"], "weather_forecast")
        self.assertTrue(r["forecast_based"])
        self.assertEqual(r["forecast_source"], "open-meteo")
        self.assertEqual(r["hazard_scores"]["high_wind"]["severity"], "HIGH")
        self.assertIn("Forecast-based", r["message"])

    def test_quiet_reading_with_calm_forecast_keeps_its_hazard_type(self):
        calm = {"forecast_rainfall_24h_mm": 0.0, "forecast_wind_speed_max_kmh": 10.0,
                "forecast_wind_gust_max_kmh": 20.0, "forecast_source": "open-meteo"}
        before = self.run_pipeline()["hazard_type"]
        r = self.run_pipeline(**calm)
        self.assertEqual((r["status"], r["hazard_type"]), ("logged", before))
        self.assertIn("heavy_rain", r["hazard_scores"])

    def test_measured_medium_outranks_a_forecast_high(self):
        r = self.run_pipeline(**STORM, temp_c=41.0)
        self.assertEqual((r["hazard_type"], r["severity"]), ("extreme heat", "MEDIUM"))
        self.assertNotIn("forecast_based", r)
        self.assertEqual(r["hazard_scores"]["heavy_rain"]["severity"], "HIGH")  # still reported


# --- confirmation / confidence / CAP ---------------------------------------------

class ConfirmationTests(unittest.TestCase):
    def test_forecast_only_is_confirmed_by_its_source_and_not_recorded(self):
        c = hc.HazardConfirmer()
        self.assertEqual(c.assess("A", "heavy_rain", "HIGH", T0, {}, forecast_only=True,
                                  forecast_source="open-meteo"), (True, "forecast"))
        # not evidence for a later MEASURED heavy rain at the same node
        self.assertEqual(c.assess("A", "heavy_rain", "MEDIUM", T0 + timedelta(minutes=1), {}),
                         (False, None))

    def test_mock_forecast_confirms_only_simulated_readings(self):
        c = hc.HazardConfirmer()
        self.assertEqual(c.assess("A", "high_wind", "HIGH", T0, {}, forecast_only=True,
                                  forecast_source="mock"), (False, None))
        self.assertEqual(c.assess("A", "high_wind", "HIGH", T0, {}, simulated=True, forecast_only=True,
                                  forecast_source="mock"), (True, "forecast"))

    def test_low_forecast_is_not_assessed(self):
        self.assertEqual(hc.HazardConfirmer().assess("A", "heavy_rain", "LOW", T0, {}, forecast_only=True),
                         (False, None))


def forecast_result(confirmation="forecast", source="open-meteo"):
    return {"status": "alert_dispatched", "hazard_type": "heavy_rain", "severity": "HIGH",
            "severity_source": "weather_forecast", "forecast_based": True, "forecast_source": source,
            "confirmation": confirmation}


class ConfidenceTests(unittest.TestCase):
    def test_forecast_alert_is_medium_with_a_forecast_reason(self):
        conf = ac.compute_confidence(forecast_result(),
                                     {"edge_anomaly": ["stuck:gas_ppm"], "delay_seconds": 9000})
        self.assertEqual((conf["confidence"], conf["confidence_label"]), (0.6, "Medium"))
        self.assertTrue(conf["confidence_reasons"][0].startswith("Forecast-based"))
        self.assertIn("Open-Meteo", conf["confidence_reasons"][0])

    def test_unconfirmed_mock_forecast_is_low(self):
        conf = ac.compute_confidence(forecast_result("unconfirmed", "mock"), {})
        self.assertEqual(conf["confidence_label"], "Low")
        self.assertIn("test forecast", conf["confidence_reasons"][1])

    def test_measured_rain_with_forecast_agreement_says_so(self):
        result = {"status": "alert_dispatched", "hazard_type": "heavy_rain", "severity": "HIGH",
                  "severity_source": "threshold_classifier", "confirmation": "persistent",
                  "hazard_scores": {"heavy_rain": {"basis": "both"}}}
        conf = ac.compute_confidence(result, {})
        self.assertIn("The weather forecast also expects heavy rain", conf["confidence_reasons"])
        self.assertFalse(any(r.startswith("Forecast-based") for r in conf["confidence_reasons"]))


class CapTests(unittest.TestCase):
    def info(self, hazard_type, severity_source, confidence=None, confirmation=None):
        xml = cap_alert.generate_cap_alert(
            hazard_type=hazard_type, severity="HIGH", location="Sector 4", latitude=29.39, longitude=79.45,
            message="test", node_id="NODE-04", risk_score=0.8, severity_source=severity_source,
            reading_id=1, sent_at=T0, confidence=confidence, confirmation=confirmation)
        info = minidom.parseString(xml).getElementsByTagName("info")[0]
        return {t: info.getElementsByTagName(t)[0].firstChild.data
                for t in ("event", "category", "urgency", "certainty")}

    def test_event_and_category(self):
        self.assertEqual(self.info("heavy_rain", "weather_forecast")["event"], "Heavy Rain Warning")
        self.assertEqual(self.info("high_wind", "weather_forecast")["event"], "High Wind Warning")
        self.assertEqual(self.info("high_wind", "weather_forecast")["category"], "Met")
        self.assertEqual(self.info("heavy_rain", "threshold_classifier")["category"], "Met")

    def test_forecast_is_future_and_at_most_possible(self):
        i = self.info("heavy_rain", "weather_forecast", confidence=0.95, confirmation="persistent")
        self.assertEqual((i["urgency"], i["certainty"]), ("Future", "Possible"))
        self.assertEqual(self.info("high_wind", "weather_forecast")["certainty"], "Possible")  # no score

    def test_measured_heavy_rain_can_be_observed(self):
        i = self.info("heavy_rain", "threshold_classifier", confidence=0.9, confirmation="persistent")
        self.assertEqual((i["urgency"], i["certainty"]), ("Immediate", "Observed"))


# --- Open-Meteo fetch and the mock ------------------------------------------------

class WeatherFetchTests(unittest.TestCase):
    NODE = "TEST-WEATHER"
    NOW = datetime(2026, 10, 8, 21, 30, tzinfo=timezone.utc)
    DAY = datetime(2026, 10, 8, 0, 0, tzinfo=timezone.utc)

    def setUp(self):
        bs._weather_cache.pop(self.NODE, None)
        self._saved_backoff = bs._api_failed_at.pop("weather", None)
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        os.environ.pop(bs.WEATHER_MOCK_ENV, None)

    def tearDown(self):
        self._env.stop()
        bs._weather_cache.pop(self.NODE, None)
        bs._api_failed_at.pop("weather", None)
        if self._saved_backoff is not None:
            bs._api_failed_at["weather"] = self._saved_backoff

    def fetch(self, payload):
        calls = []

        def fake_get(url, params=None, timeout=None):
            calls.append(params)
            return _FakeResponse(payload)

        with mock.patch.object(bs, "datetime", _fixed_datetime(self.NOW)), \
                mock.patch.object(bs.requests, "get", fake_get):
            return bs.fetch_weather_forecast(29.39, 79.45, self.NODE), calls

    def test_24h_rain_and_wind_from_the_current_hour(self):
        rain_series = [0.0] * 48
        rain_series[20] = 500.0  # 20:00 UTC - already past
        for h in range(21, 45):
            rain_series[h] = 5.0  # 21:00 .. 20:00 next day = 24 h
        rain_series[45] = 500.0  # 25th hour - outside
        gust = [20.0] * 48
        gust[40] = 95.0
        w, calls = self.fetch(_payload(self.DAY, 48, rain=rain_series, wind=30.0, gust=gust))
        self.assertIn("wind_gusts_10m", calls[0]["hourly"])
        self.assertEqual(calls[0]["forecast_days"], 2)
        self.assertEqual((w["rain_6h_mm"], w["rain_24h_mm"]), (30.0, 120.0))
        self.assertEqual((w["wind_speed_max_kmh"], w["wind_gust_max_kmh"], w["source"]), (30.0, 95.0, "open-meteo"))
        self.assertEqual(bs._weather_cache[self.NODE]["value"], 30.0)

    def test_incomplete_24h_window_is_unknown_not_less(self):
        # 30 hours from midnight: at 21:00 only 9 remain - enough for the
        # 6 h flood input, not for 24 h
        w, _ = self.fetch(_payload(self.DAY, 30, rain=5.0))
        self.assertEqual(w["rain_6h_mm"], 30.0)
        self.assertIsNone(w["rain_24h_mm"])
        self.assertIsNone(w["wind_gust_max_kmh"])

    def test_null_gust_or_missing_wind_is_unknown(self):
        gust = [20.0] * 48
        gust[30] = None
        w, _ = self.fetch(_payload(self.DAY, 48, wind=None, gust=gust))
        self.assertEqual((w["wind_speed_max_kmh"], w["wind_gust_max_kmh"]), (None, None))
        self.assertIsNotNone(w["rain_24h_mm"])

    def test_declared_units_are_converted(self):
        w, _ = self.fetch(_payload(self.DAY, 48, wind=10.0, gust=25.0,
                                   units={"wind_speed_10m": "m/s", "wind_gusts_10m": "m/s"}))
        self.assertEqual((w["wind_speed_max_kmh"], w["wind_gust_max_kmh"]), (36.0, 90.0))

    def test_old_six_hour_cache_entry_still_serves_the_flood_input(self):
        bs._weather_cache[self.NODE] = {"value": 42.0, "fetched_at": self.NOW - timedelta(minutes=5)}
        with mock.patch.object(bs, "datetime", _fixed_datetime(self.NOW)):
            w = bs.fetch_weather_forecast(29.39, 79.45, self.NODE)
            self.assertEqual(bs.fetch_forecast_rainfall_mm(29.39, 79.45, self.NODE), 42.0)
        self.assertEqual((w["rain_6h_mm"], w["rain_24h_mm"]), (42.0, None))

    def test_mock_file_is_used_without_network_and_rebased(self):
        os.environ[bs.WEATHER_MOCK_ENV] = os.path.join(MOCK_DIR, "storm.json")
        with mock.patch.object(bs.requests, "get", _offline):
            w = bs.fetch_weather_forecast(29.39, 79.45, self.NODE, simulated=True)
        self.assertEqual(w["source"], "mock")
        self.assertEqual((w["rain_24h_mm"], w["wind_gust_max_kmh"], w["wind_speed_max_kmh"]), (129.0, 96.0, 48.0))
        self.assertNotIn(self.NODE, bs._weather_cache)  # never cached

    def test_missing_mock_file_means_no_forecast_and_no_network(self):
        os.environ[bs.WEATHER_MOCK_ENV] = os.path.join(tempfile.gettempdir(), "sj-no-such-weather.json")
        with mock.patch.object(bs.requests, "get", side_effect=AssertionError("network used")):
            self.assertIsNone(bs.fetch_weather_forecast(29.39, 79.45, self.NODE, simulated=True))

    def test_mock_is_never_applied_to_a_real_reading(self):
        # Review 2026-10-09: the mock's 6 h rain reached the flood model of
        # REAL nodes. A real reading now gets no forecast at all while the
        # mock is configured - and no internet fallback either.
        os.environ[bs.WEATHER_MOCK_ENV] = os.path.join(MOCK_DIR, "storm.json")
        with mock.patch.object(bs.requests, "get", side_effect=AssertionError("network used")):
            self.assertIsNone(bs.fetch_weather_forecast(29.39, 79.45, self.NODE))
            self.assertIsNone(bs.fetch_weather_forecast(29.39, 79.45, self.NODE, simulated=False))
            self.assertIsNone(bs.fetch_forecast_rainfall_mm(29.39, 79.45, self.NODE))
            self.assertEqual(bs.fetch_forecast_rainfall_mm(29.39, 79.45, self.NODE, simulated=True), 42.0)

    def test_bundled_mock_files_are_marked_synthetic_and_classify_as_documented(self):
        expected = {"storm.json": ("HIGH", "HIGH"), "heavy_rain.json": ("MEDIUM", "LOW"),
                    "calm.json": ("LOW", "LOW")}
        for name, (rain_sev, wind_sev) in expected.items():
            with open(os.path.join(MOCK_DIR, name), encoding="utf-8") as f:
                payload = json.load(f)
            self.assertIn("SYNTHETIC", payload["_about"])
            w = bs.summarise_forecast(payload, self.NOW, allow_rebase=True)
            reading = {"forecast_rainfall_24h_mm": w["rain_24h_mm"],
                       "forecast_wind_speed_max_kmh": w["wind_speed_max_kmh"],
                       "forecast_wind_gust_max_kmh": w["wind_gust_max_kmh"]}
            self.assertEqual(hcl.classify_heavy_rain(reading)["severity"], rain_sev, name)
            self.assertEqual(hcl.classify_high_wind(reading)["severity"], wind_sev, name)

    def test_live_payload_is_never_rebased(self):
        with self.assertRaises(ValueError):
            bs.summarise_forecast(_payload(self.DAY - timedelta(days=3), 48), self.NOW)


# --- end to end through ingest ------------------------------------------------------

@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class IngestTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._tmp = tempfile.mkdtemp(prefix="sj_test_weather_")
        cls._real_db = bs.DB_PATH
        cls._real_get = bs.requests.get
        bs.DB_PATH = os.path.join(cls._tmp, "test.db")
        bs.requests.get = _offline
        bs.init_db()
        cls._real_models = (bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols)
        bs._anomaly_model = joblib.load(os.path.join(MODELS, "anomaly_model.joblib"))
        bs._anomaly_scaler = joblib.load(os.path.join(MODELS, "anomaly_scaler.joblib"))
        bs._flood_model = joblib.load(os.path.join(MODELS, "flood_model.joblib"))
        bs._flood_feature_cols = joblib.load(os.path.join(MODELS, "flood_feature_cols.joblib"))

    @classmethod
    def tearDownClass(cls):
        bs._anomaly_model, bs._anomaly_scaler, bs._flood_model, bs._flood_feature_cols = cls._real_models
        bs.close_ingest_connection()  # its kept-open DB handle (Windows cannot delete an open file)
        bs.DB_PATH = cls._real_db
        bs.requests.get = cls._real_get
        shutil.rmtree(cls._tmp, ignore_errors=True)

    def setUp(self):
        for node, cfg in bs._SEED_NODES.items():
            bs.NODE_REGISTRY[node] = {**cfg, "report_interval_seconds": None}
            bs.node_history[node] = collections.deque(maxlen=bs.HISTORY_WINDOW)
            bs.node_health[node] = {}
            bs.node_rainfall.pop(node, None)
        self._real_confirmer = bs._confirmer
        bs._confirmer = bs.HazardConfirmer()
        self._env = mock.patch.dict(os.environ, {bs.WEATHER_MOCK_ENV: os.path.join(MOCK_DIR, "storm.json")})
        self._env.start()

    def tearDown(self):
        self._env.stop()
        bs._confirmer = self._real_confirmer

    def test_simulated_reading_gets_a_confirmed_forecast_alert(self):
        r = bs.ingest_reading(bs.RawReading(node_id="NODE-04", simulated=True, temp_c=28.0, reading_uid="wx-1"))
        self.assertEqual((r["status"], r["hazard_type"], r["severity"]), ("alert_dispatched", "heavy_rain", "HIGH"))
        self.assertEqual((r["confirmation"], r["confidence"], r["confidence_label"]), ("forecast", 0.6, "Medium"))
        self.assertTrue(r["forecast_based"])
        self.assertIn("Forecast-based", r["confidence_reasons"][0])
        conn = sqlite3.connect(bs.DB_PATH)
        row = conn.execute("SELECT forecast_source, forecast_rainfall_24h_mm, forecast_wind_gust_max_kmh, "
                           "severity_source FROM readings WHERE reading_uid='wx-1'").fetchone()
        conn.close()
        self.assertEqual(row, ("mock", 129.0, 96.0, "weather_forecast"))

    def _reset_nodes(self):
        for node in bs._SEED_NODES:
            bs.node_history[node] = collections.deque(maxlen=bs.HISTORY_WINDOW)
            bs.node_health[node] = {}
            bs.node_rainfall.pop(node, None)
        bs._confirmer = bs.HazardConfirmer()

    def test_real_reading_never_sees_the_mock_forecast(self):
        # Review 2026-10-09: a storm mock reached REAL readings (heavy_rain /
        # high_wind inputs and the flood model's 6 h rain). Now a real
        # reading's result is identical with and without the mock.
        keys = ("status", "hazard_type", "severity", "risk_score", "severity_source",
                "forecast_rainfall_6h_mm", "forecast_based", "hazard_scores")

        def run(uid_prefix):
            self._reset_nodes()
            out = []
            for i, node in enumerate(("NODE-04", "NODE-07")):
                r = bs.ingest_reading(bs.RawReading(node_id=node, temp_c=28.0, river_level_m=0.4,
                                                    rainfall_mm_since_last=2.0,
                                                    reading_uid=f"{uid_prefix}-{i}"))
                out.append({k: r.get(k) for k in keys})
            return out

        with_mock = run("real-mock")
        self._env.stop()
        try:
            os.environ.pop(bs.WEATHER_MOCK_ENV, None)
            without_mock = run("real-nomock")
        finally:
            self._env.start()
        self.assertEqual(with_mock, without_mock)
        for r in with_mock:
            self.assertNotIn(r["hazard_type"], ("heavy_rain", "high_wind"))
            self.assertFalse(r["forecast_based"])
        conn = sqlite3.connect(bs.DB_PATH)
        rows = conn.execute("SELECT forecast_source, forecast_rainfall_6h_mm, forecast_rainfall_24h_mm "
                            "FROM readings WHERE reading_uid LIKE 'real-mock-%'").fetchall()
        conn.close()
        self.assertTrue(rows)
        self.assertTrue(all(row == (None, None, None) for row in rows), rows)

    def test_mock_result_on_a_real_reading_still_stays_pending(self):
        # Defence in depth (hazard_confirmation): should a mock forecast
        # result ever reach a real reading, it is not confirmed.
        confirmer = bs.HazardConfirmer()
        for _ in range(2):
            ok, basis = confirmer.assess("NODE-04", "heavy_rain", "HIGH", datetime.now(timezone.utc),
                                         bs.NODE_REGISTRY, simulated=False,
                                         forecast_only=True, forecast_source="mock")
            self.assertEqual((ok, basis), (False, None))


if __name__ == "__main__":
    unittest.main()
