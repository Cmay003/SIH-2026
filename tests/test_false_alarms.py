"""
False alarms on NORMAL readings (backend lane, step B1, 2026-10-09).

Round 3's load test saw ~8-10 % of normal synthetic readings suppressed as
"sensor faults" and +-1 cm of river noise raising MEDIUM flash floods.
Root causes and fixes (numbers: tests/false_alarm_streams.py):

  1. The Isolation Forest scored sub-threshold flame NOISE (0.03-0.05; the
     firmware only ever sends 0.0 or 1.0) as a 3-sigma outlier ->
     integration_pipeline.anomaly_model_input scores it as the hardware's 0.0.
  2. The forest knows ONE synthetic site/season; whole normal climates (a hot
     dry summer) fall outside it -> its flag only suppresses a reading that is
     also out of line with the node's own recent readings
     (anomaly_flag_stands); a dropout frame is caught by an explicit rule
     (dropout_fields) instead.
  3. The river rate was a least-squares slope through as few as 2 noisy
     points -> backend_server.river_rate_per_hour needs 3 points and a slope
     3 standard errors clear of the noise.
  4. User decision (1): node health expects a summary every 300 s from a node
     without a siren and every 60 s from one with a siren.

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import sqlite3
import sys
import unittest
from collections import deque
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))
sys.path.insert(0, os.path.join(ROOT, "tests"))

import false_alarm_streams as fa  # noqa: E402  (sets OMP_NUM_THREADS before sklearn loads)
import backend_server as bs  # noqa: E402
import hazard_classification as hcl  # noqa: E402
import integration_pipeline as ip  # noqa: E402
from test_pipeline_integrity import HAVE_MODELS, TempDbMixin, _load_models, _reset_nodes  # noqa: E402

T0 = datetime(2026, 10, 9, 12, 0, tzinfo=timezone.utc)


def river_history(levels, step_s=60):
    """(history, current level, now) for readings every step_s seconds."""
    h = deque({"timestamp": T0 + timedelta(seconds=i * step_s), "river_level_m": v}
              for i, v in enumerate(levels[:-1]))
    return h, levels[-1], T0 + timedelta(seconds=(len(levels) - 1) * step_s)


def river_rate(levels, step_s=60, bench_mount_m=None):
    h, current, now = river_history(levels, step_s)
    return bs.river_rate_per_hour(h, current, now, bench_mount_m)


# --- 3. river rate vs sensor noise -----------------------------------------------

class RiverRateNoiseTests(unittest.TestCase):
    def test_two_noisy_readings_are_not_a_rise(self):
        # 1.5 cm of jitter in 60 s: the plain slope is 0.9 m/h, above the
        # flash-flood MEDIUM rate - the round-3 false alarm
        levels = [1.500, 1.515]
        h, current, now = river_history(levels)
        self.assertAlmostEqual(bs.rate_per_hour(h, "river_level_m", current, now), 0.9, places=6)
        self.assertGreater(0.9, hcl.FLASH_FLOOD_MEDIUM_RATE_M_PER_HR)
        self.assertEqual(river_rate(levels), 0.0)

    def test_three_noisy_readings_are_not_a_rise(self):
        self.assertEqual(river_rate([1.500, 1.492, 1.512]), 0.0)

    def test_noisy_calm_river_over_the_whole_window(self):
        rand = fa.mulberry32(3)
        for k in range(2, 17):
            levels = [1.5 + (rand() - 0.5) * 0.02 for _ in range(k)]
            self.assertLess(abs(river_rate(levels)), hcl.FLOOD_SIGNATURE_RATE_M_PER_HR, k)

    def test_clean_rise_is_seen_on_the_third_reading(self):
        # 2 cm/min = 1.2 m/h (flash-flood HIGH)
        self.assertEqual(river_rate([1.50, 1.52]), 0.0)  # 2 points: not yet
        self.assertAlmostEqual(river_rate([1.50, 1.52, 1.54]), 1.2, places=6)

    def test_noisy_real_rise_is_measured(self):
        rand = fa.mulberry32(9)
        levels = [1.5 + 0.02 * k + (rand() - 0.5) * 0.02 for k in range(6)]  # 2 cm/min, +-1 cm
        self.assertGreater(river_rate(levels), hcl.FLASH_FLOOD_MEDIUM_RATE_M_PER_HR)

    def test_fast_elevated_cadence_is_unaffected(self):
        # 5 s readings of a 0.5 m/h rise: many points, measured as before
        levels = [1.8 + i * 0.5 / 720 for i in range(60)]
        self.assertAlmostEqual(river_rate(levels, step_s=5), 0.5, places=3)

    def test_falling_river_keeps_its_sign_and_is_clamped(self):
        self.assertAlmostEqual(river_rate([2.0, 1.97, 1.94, 1.91]), -1.8, places=6)
        self.assertEqual(river_rate([1.8] * 5 + [3.5, 3.6, 3.7], step_s=9), bs.MAX_RIVER_RATE_M_PER_HR)

    def test_bench_floor_scales_with_the_rig(self):
        mount = 0.0234
        self.assertAlmostEqual(bs.river_noise_floor_m(mount), 0.05 * mount)
        self.assertEqual(bs.river_noise_floor_m(None), bs.RIVER_NOISE_FLOOR_M)
        # a rig filling 20 % of its height per minute is still seen
        levels = [0.002 + 0.2 * mount * k for k in range(4)]
        self.assertGreater(river_rate(levels, bench_mount_m=mount), 0.2 * mount * 60 * 0.99)

    def test_a_step_then_plateau_after_sparse_history_is_not_gated(self):
        # integration 2026-10-10 (judge demo): one 150-s-old point, dense
        # calm readings, a 2 m step, then a plateau - the step landed in the
        # "calm" fit's noise and the rate read 0.0 for the whole plateau
        h = deque([{"timestamp": T0, "river_level_m": 1.65}])
        live = [1.65, 1.66, 1.667, 1.658, 2.903, 3.395, 3.798, 3.798, 3.798, 4.009, 4.096]
        rates = []
        for k, v in enumerate(live):
            now = T0 + timedelta(seconds=150 + 2 * k)
            rates.append(bs.river_rate_per_hour(h, v, now))
            h.append({"timestamp": now, "river_level_m": v})
        self.assertTrue(all(r == bs.MAX_RIVER_RATE_M_PER_HR for r in rates[6:]), rates)
        # ... and a falling step the same way, with its sign
        self.assertEqual(river_rate([3.0] * 6 + [2.5, 2.5, 2.5], step_s=20), -bs.MAX_RIVER_RATE_M_PER_HR)
        # below the clear-change level the gate still decides: +-1 cm jitter
        # around a 25 cm step is not "clear" (2 newest only)
        self.assertEqual(bs.clear_level_change([(-0.1, 1.5), (-0.05, 1.5), (-0.02, 1.5), (-0.01, 1.75), (0.0, 1.76)]), 0)
        self.assertEqual(bs.clear_level_change([(-0.1, 1.5), (-0.05, 1.5), (-0.02, 1.8), (-0.01, 1.81), (0.0, 1.8)]), 1)

    def test_a_rise_after_a_calm_stretch_is_not_gated(self):
        # review 2026-10-09: the whole-fit residual includes the bend between
        # the calm stretch and the rise, which gated minutes 1 and 2 to 0.0
        for cm_per_min in (20, 30, 50):
            for minute in (1, 2, 3):
                levels = [1.5] * 15 + [1.5 + cm_per_min / 100 * (k + 1) for k in range(minute)]
                h, current, now = river_history(levels)
                plain = bs.clamp_river_rate(bs.rate_per_hour(h, "river_level_m", current, now))
                self.assertAlmostEqual(river_rate(levels), plain, places=6, msg=(cm_per_min, minute))
        # 50 cm/min reaches flash-flood HIGH at minute 2, as the plain slope does
        self.assertGreaterEqual(river_rate([1.5] * 15 + [2.0, 2.5]), hcl.FLASH_FLOOD_HIGH_RATE_M_PER_HR)

    def test_a_noisy_rise_after_a_calm_stretch_reaches_high_as_before(self):
        rand = fa.mulberry32(21)
        calm = [1.5 + (rand() - 0.5) * 0.02 for _ in range(15)]

        def plain(levels):
            h, current, now = river_history(levels)
            return bs.rate_per_hour(h, "river_level_m", current, now)

        for cm_per_min in (20, 30, 50):
            first = {}
            for name, rate in (("gated", river_rate), ("plain", plain)):
                for minute in range(1, 6):
                    levels = calm + [1.5 + cm_per_min / 100 * (k + 1) for k in range(minute)]
                    if rate(levels) >= hcl.FLASH_FLOOD_HIGH_RATE_M_PER_HR:
                        first[name] = minute
                        break
            self.assertLessEqual(first["gated"], first["plain"], (cm_per_min, first))

    def test_backlog_out_of_order_span_uses_the_oldest_point(self):
        # history in ARRIVAL order: the oldest reading arrived last
        h = deque([{"timestamp": T0 + timedelta(seconds=60), "river_level_m": 1.52},
                   {"timestamp": T0, "river_level_m": 1.50}])
        fit = bs.rate_fit(h, "river_level_m", 1.54, T0 + timedelta(seconds=120))
        self.assertEqual(fit["n"], 3)
        self.assertAlmostEqual(fit["slope"], 1.2, places=6)


# --- 1./2. the anomaly filter -----------------------------------------------------

class DropoutTests(unittest.TestCase):
    def test_joint_zeros_are_a_dropout(self):
        r = {"river_level_m": 0.0, "temp_c": 0.0, "humidity_pct": 0.0, "gas_ppm": 0.0}
        self.assertEqual(ip.dropout_fields(r), ["temp_c", "humidity_pct", "gas_ppm", "river_level_m"])
        self.assertEqual(ip.dropout_fields({"temp_c": 0.0, "gas_ppm": 0.0, "river_level_m": 1.4}),
                         ["temp_c", "gas_ppm"])

    def test_one_zero_is_a_measurement(self):
        self.assertEqual(ip.dropout_fields({"temp_c": 0.0, "humidity_pct": 80, "gas_ppm": 410,
                                            "river_level_m": 0.0}), [])
        self.assertEqual(ip.dropout_fields({"river_level_m": 0.0}), [])

    def test_dropout_is_dropped_like_an_impossible_value(self):
        r = {"river_level_m": 0.0, "river_level_rate_m_per_hr": 3.0, "temp_c": 0.0,
             "humidity_pct": 0.0, "gas_ppm": 0.0, "pm25_ugm3": 40}
        clean, faults = ip.drop_implausible_fields(r)
        self.assertEqual(set(faults), {"river_level_m", "temp_c", "humidity_pct", "gas_ppm"})
        self.assertIsNone(clean["river_level_rate_m_per_hr"])  # derived from the dropped level
        self.assertEqual(clean["pm25_ugm3"], 40)


class RiverSpikeTests(unittest.TestCase):
    MAX_RATE = 5.0

    def spike(self, value, last_good=1.5, hours=None, known=True, corroborated=False, held=(), prev_good=None):
        """Readings 1 min apart: the held levels in the minutes just before
        this one, the last good level the minute before them; prev_good =
        (minutes before now, level)."""
        n = len(held)
        held_pts = [((n - i) / 60, v) for i, v in enumerate(held)]
        hours = (n + 1) / 60 if hours is None else hours
        prev = (prev_good[0] / 60, prev_good[1]) if prev_good else None
        return ip.river_spike(value, last_good, hours, known, self.MAX_RATE, corroborated, held_pts, prev)

    def test_a_jump_the_river_cannot_make_is_a_spike(self):
        self.assertTrue(self.spike(6.0))           # 4.5 m in a minute
        self.assertTrue(self.spike(0.2))           # and downwards
        self.assertFalse(self.spike(1.9))          # within the 0.5 m tolerance
        # after an hour's gap the river could have moved 5 m
        self.assertFalse(self.spike(5.0, hours=1.0))

    def test_corroborated_or_unknown_is_never_a_spike(self):
        self.assertFalse(self.spike(6.0, corroborated=True))
        self.assertFalse(self.spike(6.0, known=False))
        self.assertFalse(self.spike(6.0, last_good=None))

    def test_a_level_that_stays_is_accepted(self):
        self.assertTrue(self.spike(4.0, held=[4.05]))             # held once: not yet
        self.assertFalse(self.spike(4.0, held=[4.05, 3.98]))      # third in a row: accepted
        self.assertTrue(self.spike(4.0, held=[6.5, 9.0]))         # random spikes don't add up

    def test_a_steady_ramp_is_accepted_on_the_third_reading(self):
        # review 2026-10-09: +0.7 m/min with no rain / fast_rise was held 8+ readings
        self.assertTrue(self.spike(2.35, last_good=1.65))                    # 1st: held
        self.assertTrue(self.spike(3.05, last_good=1.65, held=[2.35]))       # 2nd: held
        self.assertFalse(self.spike(3.75, last_good=1.65, held=[2.35, 3.05]))  # 3rd: a ramp
        self.assertFalse(self.spike(1.55, last_good=3.75, held=[3.05, 2.35]))  # falling too
        # accelerating / slowing waves still count
        self.assertFalse(self.spike(3.85, last_good=1.65, held=[1.95, 2.65]))  # +0.3, +0.7, +1.2
        self.assertFalse(self.spike(3.45, last_good=1.65, held=[2.45, 3.05]))  # +0.8, +0.6, +0.4
        # three random spikes are not a ramp
        self.assertTrue(self.spike(5.3, last_good=1.65, held=[9.1, 6.0]))      # up, down, down
        self.assertTrue(self.spike(12.0, last_good=1.65, held=[5.0, 6.0]))     # up, up, but 3.35/1.0/6.0

    def test_a_ramp_once_accepted_is_not_held_again(self):
        # last good 3.75 (accepted), the one before it 1.65 three minutes earlier
        self.assertFalse(self.spike(4.45, last_good=3.75, hours=1 / 60, prev_good=(4, 1.65)))
        # but a spike off the trend still is
        self.assertTrue(self.spike(9.0, last_good=3.75, hours=1 / 60, prev_good=(4, 1.65)))
        self.assertTrue(self.spike(6.2, last_good=1.65, hours=1 / 60, prev_good=(2, 1.66)))  # calm trend

    def test_the_spike_rate_is_its_own_setting(self):
        self.assertIsNot(bs.RIVER_SPIKE_MAX_RATE_M_PER_HR, None)
        # 1.0 m in 10 min: within 0.5 m + 5 m/h x 10 min
        self.assertFalse(self.spike(2.5, hours=10 / 60))
        self.MAX_RATE = 1.0
        self.assertTrue(self.spike(2.5, hours=10 / 60))

    def test_reason_names_the_kind_of_fault(self):
        self.assertEqual(ip.fault_reason({"river_level_m": 14.2}, ["river_level_m"]),
                         "physically_impossible_river_level_m")
        self.assertEqual(ip.fault_reason({"river_level_m": 6.0, "river_spike": True}, ["river_level_m"]),
                         "spike_river_level_m")
        self.assertEqual(ip.fault_reason({"temp_c": 0.0, "gas_ppm": 0.0, "river_level_m": 1.2},
                                         ["temp_c", "gas_ppm"]), "dropout_temp_c,gas_ppm")


class BaselineGateTests(unittest.TestCase):
    BASE = {"river_level_m": {"median": 0.7, "samples": 5}, "temp_c": {"median": 37.0, "samples": 5},
            "humidity_pct": {"median": 22.0, "samples": 5}, "gas_ppm": {"median": 400.0, "samples": 5}}
    HOT = {"river_level_m": 0.72, "temp_c": 38.1, "humidity_pct": 20.0, "gas_ppm": 405.0, "flame_reading": 0.0}

    def test_no_or_short_history_keeps_the_flag(self):
        self.assertTrue(ip.anomaly_flag_stands(dict(self.HOT)))
        short = {k: {**v, "samples": 2} for k, v in self.BASE.items()}
        self.assertTrue(ip.anomaly_flag_stands({**self.HOT, "anomaly_baseline": short}))

    def test_consistent_with_the_node_waives_the_flag(self):
        self.assertFalse(ip.anomaly_flag_stands({**self.HOT, "anomaly_baseline": self.BASE}))

    def test_a_jump_on_any_channel_keeps_the_flag(self):
        for field, value in (("river_level_m", 3.5), ("temp_c", 0.0), ("humidity_pct", 70.0),
                             ("gas_ppm", 1600.0)):
            self.assertTrue(ip.anomaly_flag_stands({**self.HOT, field: value, "anomaly_baseline": self.BASE}),
                            field)

    def test_baseline_median_skips_missing_values(self):
        b = ip.anomaly_baseline([{"temp_c": 30}, {"temp_c": None}, {"temp_c": 32}, {"temp_c": 100}])
        self.assertEqual(b["temp_c"], {"median": 32.0, "samples": 3})
        self.assertNotIn("gas_ppm", b)


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class FlameInputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.model, cls.scaler, _, _ = _load_models()

    def test_flame_noise_no_longer_flags_a_normal_reading(self):
        import pandas as pd
        reading = {"river_level_m": 1.3, "temp_c": 30.5, "humidity_pct": 48, "gas_ppm": 400,
                   "flame_reading": 0.045}
        raw = pd.DataFrame([reading])[ip.ANOMALY_FEATURES]
        # the forest itself calls it an outlier - only because of the flame noise
        self.assertEqual(self.model.predict(self.scaler.transform(raw))[0], -1)
        self.assertFalse(ip.check_anomaly(reading, self.model, self.scaler)[0])
        self.assertEqual(ip.anomaly_model_input(reading)["flame_reading"], 0.0)

    def test_a_real_flame_is_still_scored_as_sent(self):
        self.assertEqual(ip.anomaly_model_input({"river_level_m": 1, "temp_c": 1, "humidity_pct": 1,
                                                 "gas_ppm": 1, "flame_reading": 1.0})["flame_reading"], 1.0)


# --- end to end through ingest (small replays) -------------------------------------

@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class IngestFalseAlarmTests(unittest.TestCase):
    def test_noisy_calm_river_raises_nothing(self):
        streams = fa.stream("noisy_river", 4, 4)  # +-1 cm river noise, 60 s
        rates = fa.normal_rates(fa.replay(streams, 60))
        self.assertEqual(rates["flash_flood_medium_plus"], 0, rates)
        self.assertEqual(rates["sensor_fault"], 0, rates)
        self.assertEqual(rates["elevated"], 0, rates)

    def test_real_flash_flood_ramp_is_still_caught(self):
        # 3 cm/min (1.8 m/h, flash-flood HIGH) with +-1 cm noise, after 4 calm minutes
        out = fa.ramp_detection(3.0, minutes=6, calm_minutes=4)
        self.assertEqual(out["calm_part_false_alarms"], 0, out)
        self.assertIsNotNone(out["first_elevated_minute"], out)
        self.assertLessEqual(out["first_elevated_minute"], 3, out)
        self.assertEqual(out["worst"], "HIGH", out)

    def test_injected_faults_are_still_caught(self):
        streams, warmup = {}, 4
        kinds = ("spike_river", "dropout", "spike_temp", "stuck", "drift")
        for i, kind in enumerate(kinds):
            rand = fa.mulberry32(500 + i)
            readings = [fa.normal_reading(i + 1, rand, 0.004) for _ in range(warmup + 1)]
            readings[warmup] = fa.inject_fault(readings[warmup], kind, rand)
            streams[fa.node_id(i)] = readings
        results = fa.replay(streams, 60)
        got = {kind: fa.outcome(results[fa.node_id(i)][warmup]) for i, kind in enumerate(kinds)}
        self.assertEqual(got["spike_river"], "suppressed")       # river_spike: a jump the river can't make
        self.assertEqual(results[fa.node_id(0)][warmup]["reason"], "spike_river_level_m")
        self.assertIn(got["dropout"], ("suppressed", "field_dropped"))
        self.assertEqual(got["spike_temp"], "suppressed")        # > 70 C: range check
        # x4 gas / +300-600 ppm passes the gas-leak signature on purpose
        # (a real leak must never be filtered); HazardConfirmer then needs
        # a repeat or a neighbour before anything goes public. Unchanged.
        self.assertEqual(got["stuck"], "hazard")
        self.assertEqual(got["drift"], "hazard")
        # and no normal reading before the fault was thrown away
        for nid, rs in results.items():
            for r in rs[:warmup]:
                self.assertNotEqual(r["hazard_type"], "sensor_fault", nid)

    def calm(self, n, level=1.65, **extra):
        return [{"node_id": "LT-0001", "simulated": True, "river_level_m": level, "temp_c": 27.0,
                 "humidity_pct": 60.0, "gas_ppm": 400.0, "flame_reading": 0.0,
                 "rainfall_mm_since_last": 0, **extra} for _ in range(n)]

    def test_a_spike_leaves_no_trace_in_the_river_rate(self):
        readings = self.calm(5) + self.calm(1, level=6.2) + self.calm(4)
        results = fa.replay({"LT-0001": readings}, 60)["LT-0001"]
        self.assertEqual(results[5]["reason"], "spike_river_level_m")
        for r in results[6:]:
            self.assertEqual(r["hazard_scores"]["flash_flood"]["severity"], "LOW")
            self.assertEqual(r["river_level_m"], 1.65)
        self.assertIsNone(bs.node_history.get("LT-0001"))  # (Backend cleaned up)

    def test_a_rain_backed_jump_is_a_measurement_not_a_spike(self):
        # the judge demo's cue 2: storm rain, then one reading at 3.4 m
        readings = self.calm(4, rainfall_mm_since_last=2.0) + self.calm(1, level=3.4, rainfall_mm_since_last=2.0)
        last = fa.replay({"LT-0001": readings}, 60)["LT-0001"][-1]
        self.assertNotEqual(last.get("reason"), "spike_river_level_m")
        self.assertFalse(last.get("sensor_faults"))
        self.assertEqual(last["river_level_m"], 3.4)

    @staticmethod
    def first_flood(results, calm):
        """1-based reading (after the calm part) of the first flood /
        flash-flood result that was not held back, or None."""
        for k, r in enumerate(results[calm:]):
            if r.get("hazard_type") in ("flood", "flash_flood") and r.get("status") != "suppressed":
                return k + 1
        return None

    def test_a_sustained_uncorroborated_ramp_is_a_flood_within_3_readings(self):
        # review 2026-10-09: +0.7 m/min with no rain, no upstream node and no
        # fast_rise was held as a spike for 8+ readings
        for cm_per_min, step_s in ((70, 60), (30, 300)):
            per = cm_per_min / 100 * step_s / 60
            readings = self.calm(10) + [self.calm(1, level=round(1.65 + per * (k + 1), 3))[0] for k in range(5)]
            results = fa.replay({"LT-0001": readings}, step_s)["LT-0001"]
            first = self.first_flood(results, 10)
            self.assertIsNotNone(first, (cm_per_min, step_s))
            self.assertLessEqual(first, 3, (cm_per_min, step_s))
            for r in results[10 + first - 1:]:  # and the ramp is not held again afterwards
                self.assertNotEqual(r.get("reason"), "spike_river_level_m", (cm_per_min, step_s, r))

    def test_a_rise_that_starts_with_heavy_rain_is_not_a_spike(self):
        # server/simulation.js "flood" event: rain at 60-100 mm/h starts on the
        # same reading as the jump to 2.4 m; the 1 h total is still under 5 mm
        mm = round(80 * 24 / 3600, 3)
        rise = [self.calm(1, level=round(2.4 + 1.6 * k / 7, 3), rainfall_mm_since_last=mm)[0] for k in range(4)]
        results = fa.replay({"LT-0001": self.calm(10) + rise}, 24)["LT-0001"]
        for r in results[10:]:
            self.assertNotEqual(r.get("reason"), "spike_river_level_m", r)
        self.assertEqual(self.first_flood(results, 10), 1)

    def test_hot_dry_site_is_not_a_sensor_fault_once_its_baseline_is_known(self):
        streams = fa.stream("hot_dry", 1, 6)
        results = fa.replay(streams, 60)["LT-0001"]
        # start-up: no history to compare with, the forest's flag stands (as before)
        self.assertEqual(results[0]["hazard_type"], "sensor_fault")
        later = results[ip.ANOMALY_BASELINE_MIN_SAMPLES:]
        for r in later:
            self.assertNotEqual(r["hazard_type"], "sensor_fault", r)
        self.assertTrue(any(r.get("anomaly_flag_waived") == "consistent_with_node_baseline" for r in later))


@unittest.skipUnless(HAVE_MODELS, "trained models not present")
class RestartAndSlowNodeBaselineTests(unittest.TestCase):
    """review 2026-10-09: node_history was not restored on restart, and a
    slow node never had 3 readings in the 60 min baseline window."""

    def test_baseline_is_restored_after_a_restart(self):
        readings = fa.stream("hot_dry", 1, 7)["LT-0001"]
        with fa.Backend(["LT-0001"]):
            t = fa.T_START
            for k in range(6):
                fa.Backend.send(readings[k], t + timedelta(minutes=k), f"hd-{k}")
            restart_at = t + timedelta(minutes=6)
            live = list(bs.node_history["LT-0001"])
            # without the seed: no baseline, the forest's flag stands
            bs.node_history["LT-0001"].clear()
            cold = fa.Backend.send(readings[6], restart_at, "hd-6-cold")
            self.assertEqual(cold["hazard_type"], "sensor_fault", cold)
            # "restart" (just before that reading): history rebuilt from the database
            bs.node_history["LT-0001"].clear()
            bs.seed_node_history_from_db(now=restart_at - timedelta(seconds=1))
            seeded = list(bs.node_history["LT-0001"])
            self.assertEqual(len(seeded), 6)
            for a, b in zip(live, seeded):
                for field in ("timestamp", "temp_c", "humidity_pct", "gas_ppm", "river_level_m"):
                    self.assertEqual(a[field], b[field], field)
            # the same reading is now judged against the restored baseline
            warm = fa.Backend.send(readings[6], restart_at, "hd-6-warm")
            self.assertNotEqual(warm["hazard_type"], "sensor_fault", warm)

    def test_seed_skips_untimed_and_old_rows_and_nulls_faulty_fields(self):
        with fa.Backend(["LT-0001"]):
            conn = sqlite3.connect(bs.DB_PATH)
            rows = [
                ("logged", T0 - timedelta(hours=3), 1.0, None),          # older than the window
                ("untimed", T0 - timedelta(minutes=5), 1.1, None),       # arrival time only
                ("suppressed", T0 - timedelta(minutes=4), 9.9, "river_level_m"),  # held spike
                ("logged", T0 - timedelta(minutes=3), 1.2, None),
            ]
            for status, at, level, faults in rows:
                conn.execute("INSERT INTO readings (node_id, status, timestamp, river_level_m, temp_c, "
                             "soil_saturation, sensor_faults, simulated) VALUES (?,?,?,?,?,?,?,1)",
                             ("LT-0001", status, at.isoformat(), level, 30.0, 0.4, faults))
            conn.commit()
            conn.close()
            bs.node_history["LT-0001"].clear()
            bs.seed_node_history_from_db(now=T0)
            h = list(bs.node_history["LT-0001"])
            self.assertEqual([e["timestamp"] for e in h], [T0 - timedelta(minutes=4), T0 - timedelta(minutes=3)])
            self.assertIsNone(h[0]["river_level_m"])
            self.assertIsNone(h[0]["raw_water_level_m"])
            self.assertEqual(h[0]["temp_c"], 30.0)
            self.assertEqual((h[1]["river_level_m"], h[1]["raw_water_level_m"]), (1.2, 1.2))
            # a node with live history is left alone
            bs.seed_node_history_from_db(now=T0)
            self.assertEqual(len(bs.node_history["LT-0001"]), 2)

    def test_slow_node_baseline_window_scales_with_its_interval(self):
        with fa.Backend(["LT-0001"], report_interval_seconds=1800):
            self.assertEqual(bs.baseline_max_age("LT-0001"), timedelta(hours=2))
        with fa.Backend(["LT-0001"]):  # 5-min node: the 60 min floor
            self.assertEqual(bs.baseline_max_age("LT-0001"),
                             timedelta(minutes=ip.ANOMALY_BASELINE_MAX_AGE_MIN))
        readings = fa.stream("hot_dry", 1, 7)["LT-0001"]
        with fa.Backend(["LT-0001"], report_interval_seconds=1800):
            results = [fa.Backend.send(r, fa.T_START + timedelta(minutes=30 * k), f"slow-{k}")
                       for k, r in enumerate(readings)]
        later = results[ip.ANOMALY_BASELINE_MIN_SAMPLES:]
        for r in later:
            self.assertNotEqual(r["hazard_type"], "sensor_fault", r)


# --- 4. node health: decision (1) ---------------------------------------------------

class NodeHealthDecisionTests(TempDbMixin, unittest.TestCase):
    def setUp(self):
        _reset_nodes()

    def report(self, at, siren):
        bs.node_history["NODE-07"].append({"timestamp": at})
        bs.update_node_health(bs.RawReading(node_id="NODE-07", temp_c=25, siren_fitted=siren), at, at, [])

    def status_at(self, now):
        return next(n for n in bs.compute_node_health(now) if n["node_id"] == "NODE-07")

    def test_five_minute_node_is_not_offline_between_summaries(self):
        self.report(T0, siren=False)  # first report: nothing learned yet
        node = self.status_at(T0 + timedelta(minutes=4))
        self.assertEqual((node["status"], node["expected_interval_seconds"]), ("online", 300))
        self.assertEqual(self.status_at(T0 + timedelta(minutes=29))["status"], "online")
        self.assertEqual(self.status_at(T0 + timedelta(minutes=31))["status"], "offline")

    def test_five_minute_node_after_a_burst_of_urgent_readings(self):
        t = T0
        for _ in range(12):  # urgent readings sent at once, 5 s apart
            self.report(t, siren=False)
            t += timedelta(seconds=5)
        node = self.status_at(t + timedelta(minutes=5))
        self.assertEqual((node["status"], node["expected_interval_seconds"]), ("online", 300))

    def test_siren_node_expects_a_minute(self):
        self.report(T0, siren=True)
        node = self.status_at(T0 + timedelta(minutes=5))
        self.assertEqual((node["status"], node["expected_interval_seconds"]), ("online", 60))
        self.assertEqual(self.status_at(T0 + timedelta(minutes=7))["status"], "offline")

    def test_slower_observed_cadence_still_wins(self):
        t = T0
        for _ in range(6):  # a deep-sleep node waking every 15 min
            self.report(t, siren=False)
            t += timedelta(minutes=15)
        self.assertEqual(self.status_at(t)["expected_interval_seconds"], 900)

    def test_configured_interval_still_wins(self):
        bs.NODE_REGISTRY["NODE-07"]["report_interval_seconds"] = 120
        self.report(T0, siren=False)
        self.assertEqual(self.status_at(T0)["expected_interval_seconds"], 120)

    def test_siren_flag_survives_a_restart(self):
        conn = sqlite3.connect(bs.DB_PATH)
        conn.execute("DELETE FROM readings")
        conn.execute("INSERT INTO readings (node_id, status, timestamp, siren_fitted) VALUES (?,?,?,?)",
                     ("NODE-07", "logged", T0.isoformat(), 1))
        conn.commit()
        conn.close()
        bs.node_health["NODE-07"] = {}
        bs.seed_node_health_from_db()
        self.assertTrue(bs.node_health["NODE-07"]["siren_fitted"])
        self.assertEqual(self.status_at(T0 + timedelta(minutes=2))["expected_interval_seconds"], 60)

    @unittest.skipUnless(HAVE_MODELS, "trained models not present")
    def test_ingest_stores_the_siren_flag(self):
        with fa.Backend(["LT-0001"]):
            fa.Backend.send({"node_id": "LT-0001", "simulated": True, "temp_c": 25.0, "siren_fitted": True},
                            T0, "siren-1")
            conn = sqlite3.connect(bs.DB_PATH)
            row = conn.execute("SELECT siren_fitted FROM readings WHERE reading_uid='siren-1'").fetchone()
            conn.close()
            self.assertEqual(row, (1,))
            self.assertTrue(bs.node_health["LT-0001"]["siren_fitted"])


if __name__ == "__main__":
    unittest.main()
