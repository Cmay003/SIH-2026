"""
Flash flood + smoke (round 2026-10-09, backend lane step B1), and the new
optional reading fields of the gateway JSON contract:

  - RawReading accepts siren_fitted / siren_on / siren_reason / fast_rise /
    rise_rate_cm_per_min / edge_anomaly / summary, and DROPS a malformed
    value instead of rejecting the reading (a 422 would jam a whole batch)
  - "flash_flood": a fast river rise, from the backend's rate or the node's
    own, bench-mode aware; CRITICAL only when rain / upstream corroborate
  - "smoke": PM2.5 and gas rising together over a short window - not slow
    urban pollution, not normal noise, not one spiked sample
  - wired through the pipeline, HazardConfirmer, CAP, RAG and the shared
    citizen advice table

Uses a throwaway SQLite file for the ingest tests (see test_pipeline_integrity).

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import json
import os
import random
import sqlite3
import sys
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock
from xml.dom import minidom

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))  # shared helpers below, however the test is started

import backend_server as bs  # noqa: E402
import cap_alert  # noqa: E402
import hazard_classification as hcl  # noqa: E402
import hazard_confirmation as hc  # noqa: E402
import integration_pipeline as ip  # noqa: E402
import paths  # noqa: E402
import rag_alert_pipeline as rag  # noqa: E402
from test_pipeline_integrity import HAVE_MODELS, TempDbMixin, _load_models, _reset_nodes  # noqa: E402

T0 = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)
BENCH_MOUNT_M = 0.0234


# --- the JSON contract's new reading fields ---------------------------------

FULL_CONTRACT_READING = {
    "node_id": "NODE-07",
    "river_level_m": 1.42,
    "temp_c": 24.5,
    "siren_fitted": True,
    "siren_on": True,
    "siren_reason": "auto_offline",
    "fast_rise": True,
    "rise_rate_cm_per_min": 2.7,
    "edge_anomaly": ["stuck:river_level_m", "spike:gas_ppm", "rate:river_level_m", "dropout:temp_c"],
    "summary": {
        "samples": 12, "window_s": 60, "max_edge_risk_level": "WATCH",
        "river_level_m": {"min": 1.30, "max": 1.42, "mean": 1.36},
        "temp_c": {"min": 24.1, "max": 24.6, "mean": 24.4},
        "humidity_pct": {"min": 70, "max": 72, "mean": 71},
        "gas_ppm": {"min": 400, "max": 420, "mean": 410},
        "pm25_ugm3": {"min": 30, "max": 34, "mean": 31.5},
        "tilt_angle_deg": {"min": 0.1, "max": 0.2, "mean": 0.15},
    },
}


class ContractFieldTests(unittest.TestCase):
    def test_every_new_field_is_accepted_and_kept(self):
        r = bs.RawReading(**FULL_CONTRACT_READING)
        self.assertTrue(r.siren_fitted and r.siren_on and r.fast_rise)
        self.assertEqual(r.siren_reason, "auto_offline")
        self.assertEqual(r.rise_rate_cm_per_min, 2.7)
        self.assertEqual(r.edge_anomaly, FULL_CONTRACT_READING["edge_anomaly"])
        self.assertEqual(r.summary.samples, 12)
        self.assertEqual(r.summary.max_edge_risk_level, "WATCH")
        self.assertEqual(r.summary.stats("pm25_ugm3"), {"min": 30.0, "max": 34.0, "mean": 31.5})
        self.assertIsNone(r.summary.stats("pm10_ugm3"))  # not part of the summary contract

    def test_fields_default_off_when_omitted(self):
        r = bs.RawReading(node_id="NODE-07", river_level_m=1.4)
        self.assertEqual((r.siren_fitted, r.siren_on, r.siren_reason, r.fast_rise), (False, False, None, False))
        self.assertIsNone(r.rise_rate_cm_per_min)
        self.assertIsNone(r.edge_anomaly)
        self.assertIsNone(r.summary)

    def test_malformed_values_are_dropped_not_rejected(self):
        r = bs.RawReading(node_id="NODE-07", river_level_m=1.4, siren_on="perhaps", siren_reason="because",
                          fast_rise=[1], rise_rate_cm_per_min="fast", edge_anomaly="spike:gas_ppm",
                          summary="none")
        self.assertEqual((r.siren_on, r.siren_reason, r.fast_rise), (False, None, False))
        self.assertIsNone(r.rise_rate_cm_per_min)
        self.assertIsNone(r.edge_anomaly)
        self.assertIsNone(r.summary)

    def test_a_bad_summary_cannot_reject_a_batch(self):
        batch = bs.ReadingBatch(readings=[
            {"node_id": "NODE-07", "temp_c": 24, "summary": {"samples": -3, "gas_ppm": {"min": 9, "max": 1, "mean": 5},
                                                             "pm25_ugm3": {"min": 1, "max": 2, "mean": 1.5}}},
            {"node_id": "NODE-04", "temp_c": 25},
        ])
        s = batch.readings[0].summary
        self.assertIsNone(s.samples)                 # out of range
        self.assertIsNone(s.stats("gas_ppm"))        # min > max
        self.assertIsNotNone(s.stats("pm25_ugm3"))   # the good part survives
        self.assertEqual(len(batch.readings), 2)

    def test_edge_anomaly_items_are_checked_one_by_one(self):
        r = bs.RawReading(node_id="NODE-07", temp_c=20,
                          edge_anomaly=["spike:gas_ppm", 7, "<script>", "spike:gas_ppm", "dropout:temp_c"])
        self.assertEqual(r.edge_anomaly, ["spike:gas_ppm", "dropout:temp_c"])
        many = bs.RawReading(node_id="NODE-07", temp_c=20, edge_anomaly=[f"spike:f{i}" for i in range(50)])
        self.assertEqual(len(many.edge_anomaly), bs.MAX_EDGE_ANOMALY_ITEMS)

    def test_siren_reason_only_while_the_siren_sounds(self):
        self.assertIsNone(bs.RawReading(node_id="NODE-07", temp_c=20, siren_reason="command").siren_reason)
        self.assertEqual(
            bs.RawReading(node_id="NODE-07", temp_c=20, siren_on=True, siren_reason="command").siren_reason, "command")

    def test_non_finite_rate_is_dropped(self):
        r = bs.RawReading.model_validate_json('{"node_id": "NODE-07", "temp_c": 20, "rise_rate_cm_per_min": 1e999}')
        self.assertIsNone(r.rise_rate_cm_per_min)

    def test_a_summary_alone_is_still_not_a_measurement(self):
        with self.assertRaises(Exception):
            bs.RawReading(node_id="NODE-07", summary={"samples": 3, "temp_c": {"min": 1, "max": 2, "mean": 1.5}})


# --- flash flood classifier ---------------------------------------------------

def flash(bench_mount_m=None, **fields):
    reading = {"river_level_m": 1.2, "river_level_rate_m_per_hr": 0.0, **fields}
    return hcl.classify_flash_flood(reading, bench_mount_m)


class FlashFloodClassifierTests(unittest.TestCase):
    def test_backend_rate_bands(self):
        self.assertEqual(flash(river_level_rate_m_per_hr=0.3)["severity"], "LOW")
        self.assertEqual(flash(river_level_rate_m_per_hr=0.8)["severity"], "MEDIUM")
        r = flash(river_level_rate_m_per_hr=1.5)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("HIGH", "backend"))

    def test_node_rate_counts_when_the_backend_has_not_seen_the_rise_yet(self):
        r = flash(fast_rise=True, node_rise_rate_m_per_hr=2.5 * hcl.CM_PER_MIN_TO_M_PER_HR)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("HIGH", "node"))
        self.assertAlmostEqual(r["rise_rate_m_per_hr"], 1.5)

    def test_both_rates_fast(self):
        r = flash(river_level_rate_m_per_hr=0.9, node_rise_rate_m_per_hr=1.3)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("HIGH", "both"))

    def test_fast_rise_flag_without_a_rate_is_a_watch(self):
        r = flash(fast_rise=True)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("MEDIUM", "node_flag"))

    def test_critical_needs_rain_or_upstream(self):
        alone = flash(river_level_rate_m_per_hr=4.0)
        self.assertEqual(alone["severity"], "HIGH")
        self.assertFalse(alone["corroborated"])
        rain = flash(river_level_rate_m_per_hr=4.0, rainfall_intensity_mm_hr=12)
        self.assertEqual((rain["severity"], rain["corroborated"]), ("CRITICAL", True))
        upstream = flash(river_level_rate_m_per_hr=4.0, upstream_rate_m_per_hr=0.5)
        self.assertEqual(upstream["severity"], "CRITICAL")

    def test_falling_or_steady_river_is_low(self):
        self.assertEqual(flash(river_level_rate_m_per_hr=-3.0)["severity"], "LOW")
        self.assertEqual(flash(river_level_rate_m_per_hr=None)["severity"], "LOW")

    def test_no_water_level_means_no_result(self):
        self.assertIsNone(hcl.classify_flash_flood({"river_level_m": None, "fast_rise": True}))
        self.assertIsNone(hcl.classify_flash_flood({"temp_c": 30}))

    def test_critical_never_rests_on_the_node_rate_alone(self):
        # rain is exactly when an ultrasonic sensor misreads: the node's rate
        # plus rain, with the backend's smoothed levels flat, stays HIGH
        r = flash(river_level_m=1.0, node_rise_rate_m_per_hr=3.5, rainfall_intensity_mm_hr=6)
        self.assertEqual((r["severity"], r["rise_rate_source"], r["corroborated"]), ("HIGH", "node", True))
        self.assertEqual(rag.severity_band(r["risk_score"]), "HIGH")
        # the backend under its HIGH threshold is not enough either
        r = flash(river_level_rate_m_per_hr=1.0, node_rise_rate_m_per_hr=3.5, rainfall_intensity_mm_hr=6)
        self.assertEqual(r["severity"], "HIGH")
        # once the backend's own rate is HIGH too, rain makes it CRITICAL
        r = flash(river_level_rate_m_per_hr=1.3, node_rise_rate_m_per_hr=3.5, rainfall_intensity_mm_hr=6)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("CRITICAL", "both"))

    def test_a_spiked_node_rate_cannot_raise_a_critical(self):
        # reviewer's case: spike flag, backend 0.25 m/h, rain 6 mm/h - passes
        # is_flood_signature (so the B2 hold does not apply), node says 3.5
        reading = {"river_level_m": 1.0, "river_level_rate_m_per_hr": 0.25, "node_rise_rate_m_per_hr": 3.5,
                   "fast_rise": True, "rainfall_intensity_mm_hr": 6, "edge_anomaly": ["spike:river_level_m"]}
        self.assertTrue(ip.is_flood_signature(reading))
        r = hcl.classify_flash_flood(reading)
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("LOW", None))

    def test_node_rate_ignored_when_the_node_distrusts_its_own_sensor(self):
        # spike too: the node's rate is computed from the spiked sample. The
        # same checks (minus dropout) make the B2 hold hold a river alert.
        for check in ("stuck", "dropout", "rate", "spike"):
            r = flash(fast_rise=True, node_rise_rate_m_per_hr=3.0, edge_anomaly=[f"{check}:river_level_m"])
            self.assertEqual(r["severity"], "LOW", check)
        self.assertLessEqual(set(ip.EDGE_RIVER_HOLD_CHECKS), set(hcl.NODE_RATE_DISTRUST_CHECKS))
        # the backend's own rate still counts on a spike-flagged reading
        r = flash(river_level_rate_m_per_hr=1.5, edge_anomaly=["spike:river_level_m"])
        self.assertEqual((r["severity"], r["rise_rate_source"]), ("HIGH", "backend"))
        # a flag on another sensor changes nothing
        r = flash(node_rise_rate_m_per_hr=1.5, edge_anomaly=["stuck:gas_ppm"])
        self.assertEqual(r["severity"], "HIGH")

    def test_bench_mode_uses_rig_scale_thresholds(self):
        rate = 0.3  # m/h - nothing on a river, 21 % of the 2.34 cm rig per minute on the bench
        self.assertEqual(flash(river_level_rate_m_per_hr=rate)["severity"], "LOW")
        self.assertEqual(flash(BENCH_MOUNT_M, river_level_rate_m_per_hr=rate)["severity"], "HIGH")
        # the rig has no rain or upstream node, so CRITICAL needs no corroboration there
        self.assertEqual(flash(BENCH_MOUNT_M, river_level_rate_m_per_hr=0.8)["severity"], "CRITICAL")

    def test_bench_mount_only_for_real_readings_in_bench_mode(self):
        with mock.patch.object(ip, "HARDWARE_TEST_MODE", True):
            self.assertEqual(ip.bench_mount_for({"simulated": False}), ip.BENCH_MOUNT_HEIGHT_M)
            self.assertIsNone(ip.bench_mount_for({"simulated": True}))
        with mock.patch.object(ip, "HARDWARE_TEST_MODE", False):
            self.assertIsNone(ip.bench_mount_for({"simulated": False}))

    def test_risk_score_agrees_with_severity_band(self):
        for rate in (0.0, 0.6, 0.9, 1.2, 2.0, 2.999, 3.0, 6.0):
            for rain in (0, 10):
                r = flash(river_level_rate_m_per_hr=rate, rainfall_intensity_mm_hr=rain)
                self.assertEqual(rag.severity_band(r["risk_score"]), r["severity"], (rate, rain))

    def test_calm_river_jitter_never_looks_like_a_flash_flood(self):
        rng = random.Random(11)
        history = []
        for i in range(60):
            now = T0 + timedelta(seconds=10 * i)
            level = 1.8 + rng.uniform(-0.01, 0.01)
            rate = bs.clamp_river_rate(bs.rate_per_hour(history, "river_level_m", level, now))
            history.append({"timestamp": now, "river_level_m": level})
            self.assertEqual(flash(river_level_m=level, river_level_rate_m_per_hr=rate)["severity"], "LOW")

    def test_a_faulty_level_takes_the_node_rate_with_it(self):
        clean, faults = ip.drop_implausible_fields(
            {"river_level_m": 14.2, "river_level_rate_m_per_hr": 5.0, "node_rise_rate_m_per_hr": 5.0, "fast_rise": True})
        self.assertEqual(faults, ["river_level_m"])
        self.assertIsNone(clean["node_rise_rate_m_per_hr"])
        self.assertFalse(clean["fast_rise"])
        self.assertNotIn("flash_flood", hcl.classify_all_hazards(clean))


# --- smoke --------------------------------------------------------------------

def trend(prior, current, summary=None):
    return hcl.short_window_trend(prior, current, summary)


def smoke_reading(pm_prior, pm_now, gas_prior, gas_now, temp=None, rh=None, flame=None, summary=None):
    """A reading as derive_features() builds it: current values plus the
    short-window trends from the earlier values."""
    summary = summary or {}
    reading = {"pm25_ugm3": pm_now, "gas_ppm": gas_now, "flame_reading": flame, "short_trends": {}}
    series = {"pm25_ugm3": (pm_prior, pm_now), "gas_ppm": (gas_prior, gas_now)}
    if temp:
        series["temp_c"] = temp
    if rh:
        series["humidity_pct"] = rh
    for field, (prior, now) in series.items():
        reading[field] = now
        t = trend(prior, now, summary.get(field))
        if t:
            reading["short_trends"][field] = t
    return reading


def ramp(start, end, n):
    return [start + (end - start) * i / (n - 1) for i in range(n)]


class ShortTrendTests(unittest.TestCase):
    def test_sustained_rise(self):
        t = trend([40, 41, 40, 42, 90, 110], 120)
        self.assertEqual(t["baseline_source"], "history")
        self.assertEqual(t["recent"], 110)  # median of 90, 110, 120
        self.assertAlmostEqual(t["rise"], 69.5)  # baseline = median(40, 41, 40, 42) = 40.5

    def test_one_spiked_sample_is_outvoted(self):
        self.assertLess(trend([40] * 10, 400)["rise"], 1)
        self.assertLess(trend([40] * 9 + [400], 40)["rise"], 1)

    def test_summary_gives_the_baseline_when_history_is_short(self):
        # a node reporting every few minutes: one earlier report in the window
        t = trend([40], 130, {"min": 41, "max": 131, "mean": 95})
        self.assertEqual(t["baseline_source"], "summary")
        self.assertEqual(t["recent"], 95)  # median of 40, 130, 95
        self.assertEqual(t["rise"], 54)

    def test_too_little_evidence(self):
        self.assertIsNone(trend([], 100))          # one sample
        self.assertIsNone(trend([40, 41], 100))    # no older baseline, no summary
        self.assertIsNone(trend([40] * 5, None))   # sensor missing now


class SmokeClassifierTests(unittest.TestCase):
    def test_pm_and_gas_rising_together_is_smoke(self):
        r = hcl.classify_smoke(smoke_reading(ramp(40, 45, 8) + [80, 100], 110, [400] * 8 + [520, 560], 580))
        self.assertEqual(r["severity"], "MEDIUM")
        self.assertEqual(r["smoke_support"], [])

    def test_smoke_is_never_rated_below_its_own_pm25_band(self):
        # 160 ug/m3 is CPCB "Very Poor" (HIGH): the smoke result must not
        # lose to plain "air pollution" and give people the haze advice
        reading = smoke_reading([40] * 8 + [110, 150], 160, [400] * 8 + [520, 560], 580)
        scores = hcl.classify_all_hazards(reading)
        self.assertEqual(scores["air pollution"]["severity"], "HIGH")
        self.assertEqual(scores["smoke"]["severity"], "HIGH")
        self.assertLess(scores["smoke"]["risk_score"], 0.9)

    def test_heat_or_dry_air_supports_it(self):
        r = hcl.classify_smoke(smoke_reading(
            [40] * 8 + [110, 150], 160, [400] * 8 + [520, 560], 580,
            temp=([28] * 8 + [29.5, 30.5], 31), rh=([70] * 8 + [62, 60], 58)))
        self.assertEqual(r["severity"], "HIGH")
        self.assertEqual(r["smoke_support"], ["temp_rising", "humidity_falling"])
        flame = hcl.classify_smoke(smoke_reading([40] * 8 + [110, 150], 160, [400] * 8 + [520, 560], 580, flame=0.6))
        self.assertEqual((flame["severity"], flame["smoke_support"]), ("HIGH", ["flame"]))

    def test_smoke_alone_is_never_critical(self):
        r = hcl.classify_smoke(smoke_reading(
            [40] * 8 + [900, 950], 990, [400] * 8 + [1500, 1600], 1700,
            temp=([28] * 8 + [35, 38], 40), rh=([70] * 8 + [40, 35], 30), flame=0.9))
        self.assertEqual(r["severity"], "HIGH")

    def test_slow_urban_pollution_is_not_smoke(self):
        # PM2.5 climbing ~30 ug/m3 an hour - 5 in this 10-minute window,
        # gas creeping with traffic: air pollution grades it, smoke does not fire
        reading = smoke_reading(ramp(150, 155, 10), 155.5, ramp(420, 428, 10), 429)
        self.assertEqual(hcl.classify_smoke(reading)["severity"], "LOW")
        scores = hcl.classify_all_hazards(reading)
        self.assertEqual(scores["air pollution"]["severity"], "HIGH")
        self.assertEqual(scores["smoke"]["severity"], "LOW")

    def test_normal_noise_is_not_smoke(self):
        rng = random.Random(3)
        for _ in range(200):
            pm = [45 + rng.uniform(-8, 8) for _ in range(12)]
            gas = [410 + rng.uniform(-25, 25) for _ in range(12)]
            self.assertEqual(hcl.classify_smoke(smoke_reading(pm[:-1], pm[-1], gas[:-1], gas[-1]))["severity"], "LOW")

    def test_one_spiked_sample_on_both_sensors_is_not_smoke(self):
        # e.g. a brown-out glitch hitting both channels in the same sample
        self.assertEqual(hcl.classify_smoke(smoke_reading([40] * 10, 400, [400] * 10, 900))["severity"], "LOW")
        self.assertEqual(
            hcl.classify_smoke(smoke_reading([40] * 9 + [400], 41, [400] * 9 + [900], 402))["severity"], "LOW")

    def test_dust_without_gas_is_not_smoke(self):
        r = hcl.classify_smoke(smoke_reading([40] * 8 + [140, 160], 170, [400] * 10, 405))
        self.assertEqual(r["severity"], "LOW")

    def test_rise_in_clean_air_stays_low(self):
        # +30 but still under CPCB "Satisfactory" (60)
        r = hcl.classify_smoke(smoke_reading([15] * 8 + [45, 48], 50, [400] * 8 + [520, 540], 550))
        self.assertEqual(r["severity"], "LOW")

    def test_summary_mode_node_with_one_earlier_report(self):
        summaries = {"pm25_ugm3": {"min": 42, "max": 110, "mean": 85},
                     "gas_ppm": {"min": 401, "max": 560, "mean": 520}}
        r = hcl.classify_smoke(smoke_reading([40], 110, [400], 560, summary=summaries))
        self.assertEqual(r["severity"], "MEDIUM")
        # same report shape, but only the LAST sample spiked: mean stays low
        spike = {"pm25_ugm3": {"min": 40, "max": 400, "mean": 70}, "gas_ppm": {"min": 400, "max": 900, "mean": 441}}
        self.assertEqual(hcl.classify_smoke(smoke_reading([40], 400, [400], 900, summary=spike))["severity"], "LOW")

    def test_a_noisy_summary_is_not_smoke(self):
        # the min baseline is the LOWEST sample, so noise inflates the rise by
        # up to its amplitude - the same noise test_normal_noise_is_not_smoke
        # uses (+-8 ug/m3, +-25 ppm) must stay under the thresholds
        rng = random.Random(5)
        for _ in range(200):
            pm = [45 + rng.uniform(-8, 8) for _ in range(30)]
            gas = [410 + rng.uniform(-25, 25) for _ in range(30)]
            summary = {"pm25_ugm3": {"min": min(pm), "max": max(pm), "mean": sum(pm) / 30},
                       "gas_ppm": {"min": min(gas), "max": max(gas), "mean": sum(gas) / 30}}
            r = hcl.classify_smoke(smoke_reading([45], pm[-1], [410], gas[-1], summary=summary))
            self.assertEqual(r["severity"], "LOW")

    def test_not_assessable_without_pm_gas_or_history(self):
        self.assertIsNone(hcl.classify_smoke({"pm25_ugm3": 200, "gas_ppm": 600}))  # no trends
        self.assertIsNone(hcl.classify_smoke(smoke_reading([40] * 10, 150, [400] * 10, None)))
        self.assertNotIn("smoke", hcl.classify_all_hazards({"pm25_ugm3": 200}))

    def test_smoke_supports_a_flame_fire(self):
        flame_only = hcl.classify_fire_smoke({"flame_reading": 0.5})
        with_smoke = hcl.classify_fire_smoke(
            smoke_reading([40] * 8 + [110, 150], 160, [400] * 8 + [520, 560], 580, flame=0.5))
        self.assertAlmostEqual(with_smoke["risk_score"] - flame_only["risk_score"], hcl.SMOKE_FIRE_SUPPORT)


# --- wiring: primary hazard, confirmation, CAP, RAG, advice ---------------------

class WiringTests(unittest.TestCase):
    def test_flash_flood_wins_a_severity_tie_with_the_flood_model(self):
        self.assertGreater(ip.HAZARD_TIE_PRIORITY["flash_flood"], ip.HAZARD_TIE_PRIORITY.get("flood", 0))
        self.assertGreater(ip.HAZARD_TIE_PRIORITY["fire"], ip.HAZARD_TIE_PRIORITY["smoke"])
        self.assertGreater(ip.HAZARD_TIE_PRIORITY["smoke"], ip.HAZARD_TIE_PRIORITY.get("air pollution", 0))

    def test_alert_detail_text(self):
        text = ip.alert_detail("flash_flood", {"rise_rate_m_per_hr": 1.5, "corroborated": True})
        self.assertIn("2.5 cm per minute", text)
        self.assertIn("confirms", text)
        self.assertIn("PM2.5", ip.alert_detail("smoke", {}))
        self.assertIsNone(ip.alert_detail("flood", {}))

    def test_same_event_families_corroborate_each_other_across_nodes(self):
        registry = {"A": {"latitude": 29.39, "longitude": 79.45}, "B": {"latitude": 29.391, "longitude": 79.451}}
        c = hc.HazardConfirmer()
        c.assess("B", "flood", "HIGH", T0, registry)
        self.assertEqual(c.assess("A", "flash_flood", "HIGH", T0 + timedelta(seconds=30), registry),
                         (True, "neighbour:B"))
        c = hc.HazardConfirmer()
        c.assess("B", "fire", "HIGH", T0, registry)
        self.assertEqual(c.assess("A", "smoke", "MEDIUM", T0 + timedelta(seconds=30), registry),
                         (True, "neighbour:B"))
        c = hc.HazardConfirmer()
        c.assess("B", "flood", "HIGH", T0, registry)
        self.assertEqual(c.assess("A", "smoke", "MEDIUM", T0 + timedelta(seconds=30), registry), (False, None))

    def test_families_never_confirm_a_different_type_at_the_same_node(self):
        # one flash-flood CRITICAL after an earlier slow-flood MEDIUM at the
        # same node is still one reading of it: no persistence, so it stays
        # pending and cannot auto-sound the siren
        registry = {"A": {"latitude": 29.39, "longitude": 79.45}}
        for earlier, later in (("flood", "flash_flood"), ("smoke", "fire"), ("fire", "smoke")):
            c = hc.HazardConfirmer()
            c.assess("A", earlier, "MEDIUM", T0, registry)
            self.assertEqual(c.assess("A", later, "CRITICAL", T0 + timedelta(minutes=1), registry),
                             (False, None), (earlier, later))
            # a repeat of the SAME type still confirms
            self.assertEqual(c.assess("A", later, "CRITICAL", T0 + timedelta(minutes=2), registry),
                             (True, "persistent"), (earlier, later))

    def test_a_stuck_sensor_can_only_be_confirmed_by_a_neighbour(self):
        registry = {"A": {"latitude": 29.39, "longitude": 79.45}, "B": {"latitude": 29.391, "longitude": 79.451}}
        c = hc.HazardConfirmer()
        for i in range(3):
            self.assertEqual(c.assess("A", "gas leak", "CRITICAL", T0 + timedelta(seconds=30 * i), registry,
                                      sensor_stuck=True), (False, None))
        # ...and its frozen readings are no evidence for anyone else
        self.assertEqual(c.assess("B", "gas leak", "HIGH", T0 + timedelta(minutes=2), registry), (False, None))
        # an independent node does confirm it
        self.assertEqual(c.assess("A", "gas leak", "CRITICAL", T0 + timedelta(minutes=3), registry,
                                  sensor_stuck=True), (True, "neighbour:B"))

    def cap_info(self, hazard_type):
        xml = cap_alert.generate_cap_alert(
            hazard_type=hazard_type, severity="HIGH", location="Sector 7", latitude=29.39, longitude=79.45,
            message="test", node_id="NODE-07", risk_score=0.8, reading_id=1, sent_at=T0)
        info = minidom.parseString(xml).getElementsByTagName("info")[0]
        return tuple(info.getElementsByTagName(t)[0].firstChild.data for t in ("event", "category"))

    def test_cap_event_and_category(self):
        self.assertEqual(self.cap_info("flash_flood"), ("Flash Flood Warning", "Met"))
        self.assertEqual(self.cap_info("flood"), ("Flood Warning", "Met"))  # CAP 1.2: "Met (inc. flood)"
        self.assertEqual(self.cap_info("smoke"), ("Smoke Warning", "Fire"))

    def test_every_backend_hazard_has_cap_sop_and_citizen_advice(self):
        backend_types = set(cap_alert.HAZARD_TO_CAP)
        self.assertTrue({"flash_flood", "smoke"} <= backend_types)
        with open(os.path.join(ROOT, "data", "hazard_advice.json"), encoding="utf-8") as f:
            advice = json.load(f)["hazards"]
        self.assertEqual(set(advice), backend_types)
        for hazard in backend_types:
            source = rag.HAZARD_SOURCE_MAP[hazard]
            self.assertTrue(os.path.exists(os.path.join(paths.SOPS_DIR, source)), source)
            entry = advice[hazard]
            self.assertEqual(entry["source"], source)
            for lang in ("en", "hi"):
                self.assertTrue(entry["name"][lang])
                self.assertNotRegex(entry["whatsapp"][lang], r"[\n\t]| {4,}")  # Meta template rule
            for level in ("MEDIUM", "HIGH"):
                en, hi = entry["actions"][level]["en"], entry["actions"][level]["hi"]
                self.assertTrue(2 <= len(en) <= 3 and len(hi) == len(en), (hazard, level))
        for hazard in ("flash_flood", "smoke"):
            self.assertIn("native-speaker review", advice[hazard]["_review"])


# --- end to end through ingest -------------------------------------------------

@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class IngestFlashFloodSmokeTests(TempDbMixin, unittest.TestCase):
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
        self.start = datetime.now(timezone.utc) - timedelta(minutes=30)

    def tearDown(self):
        bs._confirmer = self._real_confirmer

    def send(self, i, step_s=30, **fields):
        ts = (self.start + timedelta(seconds=i * step_s)).isoformat()
        return bs.ingest_reading(bs.RawReading(timestamp=ts, reading_uid=f"{self._testMethodName}-{i}", **fields))

    def test_fast_real_rise_becomes_a_flash_flood_alert(self):
        results = [self.send(i, node_id="NODE-04", river_level_m=1.0 + 0.03 * i) for i in range(16)]  # 6 cm/min
        last = results[-1]
        self.assertEqual(last["hazard_type"], "flash_flood")
        self.assertEqual(last["severity"], "HIGH")  # no rain / upstream: never CRITICAL alone
        self.assertEqual(last["status"], "alert_dispatched")  # confirmed by its own earlier readings
        self.assertEqual(last["confirmation"], "persistent")
        self.assertIn("rising fast", last["message"])
        self.assertIsNotNone(last["eta_minutes"])

    def test_one_spike_on_a_calm_river_is_not_a_flash_flood(self):
        levels = [1.50] * 10 + [3.2] + [1.50] * 5
        for i, level in enumerate(levels):
            r = self.send(i, node_id="NODE-04", river_level_m=level)
            if i == 10:
                # Since step B1 the spike itself is a sensor fault (a jump
                # the river cannot make, uncorroborated): no level, so no
                # flash-flood score at all for that reading.
                self.assertEqual(r["reason"], "spike_river_level_m")
                self.assertNotIn("flash_flood", r.get("hazard_scores", {}))
                continue
            self.assertEqual(r["hazard_scores"]["flash_flood"]["severity"], "LOW", i)

    def test_node_fast_rise_is_used_and_stored(self):
        for i in range(3):
            self.send(i, node_id="NODE-04", river_level_m=1.2)
        # A flag on ANOTHER sensor changes nothing here. (A spike / stuck
        # flag on the river itself holds the alert unless rain or upstream
        # back it up - step B2, tests/test_confidence.py.)
        r = self.send(3, node_id="NODE-04", river_level_m=1.21, fast_rise=True, rise_rate_cm_per_min=2.5,
                      edge_anomaly=["dropout:temp_c"])
        self.assertEqual((r["hazard_type"], r["severity"]), ("flash_flood", "HIGH"))
        self.assertEqual(r["hazard_scores"]["flash_flood"]["rise_rate_source"], "node")
        conn = sqlite3.connect(bs.DB_PATH)
        row = conn.execute("SELECT fast_rise, rise_rate_cm_per_min, edge_anomaly FROM readings "
                           "WHERE reading_uid=?", (f"{self._testMethodName}-3",)).fetchone()
        conn.close()
        self.assertEqual(row, (1, 2.5, "dropout:temp_c"))

    def test_smoke_from_a_sequence_of_readings(self):
        pm = [40, 41, 39, 40, 42, 40, 95, 140, 160]
        gas = [400, 402, 399, 401, 400, 400, 500, 560, 590]
        results = [self.send(i, step_s=20, node_id="NODE-INDB", pm25_ugm3=p, gas_ppm=g)
                   for i, (p, g) in enumerate(zip(pm, gas))]
        self.assertNotIn("smoke", [r["hazard_type"] for r in results[:7]])
        # 160 ug/m3 is CPCB "Very Poor": smoke takes that band (HIGH) and,
        # at equal severity, wins over plain air pollution
        self.assertEqual((results[-1]["hazard_type"], results[-1]["severity"]), ("smoke", "HIGH"))
        self.assertEqual(results[-1]["hazard_scores"]["air pollution"]["severity"], "HIGH")
        self.assertIn("burning", results[-1]["message"])
        self.assertEqual(results[-1]["status"], "alert_dispatched")  # its previous reading was smoke too

    def test_slow_pollution_build_up_is_air_pollution_not_smoke(self):
        for i in range(30):  # +1.2 ug/m3 a minute for 15 min, gas steady
            r = self.send(i, node_id="NODE-INDB", pm25_ugm3=100 + 0.6 * i, gas_ppm=410 + (i % 3))
        self.assertEqual(r["hazard_type"], "air pollution")
        self.assertEqual(r["hazard_scores"]["smoke"]["severity"], "LOW")

    def test_summary_mode_reports_are_used_for_smoke(self):
        # a NORMAL-mode node reporting every 5 minutes: only one earlier report in the window
        self.send(0, step_s=300, node_id="NODE-INDB", pm25_ugm3=40, gas_ppm=400)
        r = self.send(1, step_s=300, node_id="NODE-INDB", pm25_ugm3=110, gas_ppm=560, summary={
            "samples": 10, "window_s": 300,
            "pm25_ugm3": {"min": 41, "max": 110, "mean": 85},
            "gas_ppm": {"min": 401, "max": 560, "mean": 520}})
        self.assertEqual((r["hazard_type"], r["severity"]), ("smoke", "MEDIUM"))

    def test_a_summary_longer_than_the_short_window_is_not_used(self):
        # the same numbers over an HOUR are a slow build-up, not smoke
        self.send(0, step_s=300, node_id="NODE-INDB", pm25_ugm3=40, gas_ppm=400)
        r = self.send(1, step_s=300, node_id="NODE-INDB", pm25_ugm3=110, gas_ppm=560, summary={
            "samples": 120, "window_s": 3600,
            "pm25_ugm3": {"min": 41, "max": 110, "mean": 85},
            "gas_ppm": {"min": 401, "max": 560, "mean": 520}})
        self.assertNotEqual(r["hazard_type"], "smoke")
        # one earlier report and no usable summary: not assessable at all
        self.assertNotIn("smoke", r["hazard_scores"])

    def test_smoke_trend_uses_time_order_not_arrival_order(self):
        # Round item E: the node sends its elevated reading (t8) FIRST and
        # the older backlog (t6, t7) after it. t9 must still see t8 as recent.
        pm = {i: 40 for i in range(8)}
        gas = {i: 400 for i in range(8)}
        pm.update({8: 150, 9: 160})
        gas.update({8: 580, 9: 600})
        results = {}
        for i in (0, 1, 2, 3, 4, 5, 8, 6, 7, 9):
            results[i] = self.send(i, step_s=20, node_id="NODE-INDB", pm25_ugm3=pm[i], gas_ppm=gas[i])
        self.assertNotEqual(results[8]["hazard_type"], "smoke")  # one smoky sample is not enough
        self.assertEqual(results[9]["hazard_type"], "smoke")
        self.assertGreaterEqual(results[9]["hazard_scores"]["smoke"]["pm25_rise_ugm3"], 100)


if __name__ == "__main__":
    unittest.main()
