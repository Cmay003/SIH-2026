"""
Unit tests for the river rate-of-rise calculation in backend_server.py (B33).

Run from the repo root:  venv/Scripts/python.exe -m unittest discover -s tests -v
"""

import os
import random
import sys
import unittest
from collections import deque
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))

import backend_server as bs  # noqa: E402

T0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)


def history_of(levels, step_seconds=10):
    """Readings every step_seconds; the LAST level is returned separately as the current one."""
    h = deque(
        {"timestamp": T0 + timedelta(seconds=i * step_seconds), "river_level_m": lv}
        for i, lv in enumerate(levels[:-1])
    )
    now = T0 + timedelta(seconds=(len(levels) - 1) * step_seconds)
    return h, levels[-1], now


def river_rate(levels, step_seconds=10):
    h, current, now = history_of(levels, step_seconds)
    return bs.clamp_river_rate(bs.rate_per_hour(h, "river_level_m", current, now))


class RiverRateTests(unittest.TestCase):
    def test_clean_rise_is_measured_exactly(self):
        # 0.5 m/hr = 0.5/360 m every 10 s
        levels = [1.8 + i * 0.5 / 360 for i in range(60)]
        self.assertAlmostEqual(river_rate(levels), 0.5, places=3)

    def test_calm_river_jitter_is_not_a_rise(self):
        rng = random.Random(7)
        levels = [1.8 + rng.uniform(-0.01, 0.01) for _ in range(60)]
        self.assertLess(abs(river_rate(levels)), 0.2)  # below the flood-signature threshold

    def test_too_little_history_gives_zero(self):
        self.assertEqual(river_rate([1.8, 2.5], step_seconds=5), 0.0)

    def test_sudden_step_is_capped_not_hundreds_of_m_per_hr(self):
        # river jumps 1.7 m between two readings then FALLS - the window
        # still holds the jump, which used to give +100..+400 m/hr
        levels = [1.8] * 10 + [3.5, 3.45, 3.40, 3.35]
        rate = river_rate(levels, step_seconds=9)
        self.assertLessEqual(rate, bs.MAX_RIVER_RATE_M_PER_HR)
        self.assertGreaterEqual(rate, -bs.MAX_RIVER_RATE_M_PER_HR)

    def test_clamp_is_symmetric_and_leaves_normal_values(self):
        self.assertEqual(bs.clamp_river_rate(0.3), 0.3)
        self.assertEqual(bs.clamp_river_rate(1e6), bs.MAX_RIVER_RATE_M_PER_HR)
        self.assertEqual(bs.clamp_river_rate(-1e6), -bs.MAX_RIVER_RATE_M_PER_HR)


if __name__ == "__main__":
    unittest.main()
