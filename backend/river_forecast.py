"""
SANJEEVNI - LSTM river-level forecast (+30 / +60 min).

Inputs: the last 2 hours of one node's readings resampled to 5-minute
steps - water level relative to the current level, and rainfall per step.
Output: predicted level change at +30 and +60 minutes.

Why relative levels: the same model can then run on a river gauge (metres)
and the bench tank (centimetres) without knowing the absolute scale.

IMPORTANT CAVEAT: there is no real river-gauge history yet, so the model
is trained on SYNTHETIC hydrology (generate_synthetic_catchment below).
train_river_forecast.py reports how it compares with the simple baselines
on held-out synthetic catchments; that says the pipeline works, NOT how
accurate it is on a real river. Retrain on real gauge + rain data
(e.g. CWC / India-WRIS) before relying on it.

Inference is plain numpy (weights exported from Keras to a .npz), so the
backend doesn't need TensorFlow at runtime.
"""

import math
import os
from datetime import datetime, timedelta

import numpy as np

import paths

STEP_MINUTES = 5
WINDOW_STEPS = 24  # 2 hours of history
HORIZON_STEPS = (6, 12)  # +30 and +60 minutes
LEVEL_SCALE_M = 0.5  # normalisation for level changes
RAIN_SCALE_MM = 5.0  # normalisation for rain per 5-min step
MODEL_PATH = os.path.join(paths.MODELS_DIR, "river_forecast_lstm.npz")

# Resampling tolerance: at most this share of 5-min steps may be empty
# (filled from the previous step) before the forecast is refused.
MAX_EMPTY_STEP_FRACTION = 0.25


# ---------------------------------------------------------------------
# Synthetic hydrology (training data only)
# ---------------------------------------------------------------------
def generate_synthetic_catchment(rng: np.random.Generator, days: int = 30) -> tuple[np.ndarray, np.ndarray]:
    """Returns (level_m, rain_mm_per_step) at 5-min steps for one random
    catchment. Storms arrive every ~2 days, last 1-12 h; rain fills a soil
    store and the runoff share grows as the soil gets wetter (SCS-like);
    runoff is routed through two linear reservoirs (a Nash cascade, giving
    the delayed, smoothed river response) and converted to a level with a
    power-law rating curve."""
    n = days * 24 * 60 // STEP_MINUTES
    rain = np.zeros(n)
    t = 0
    while t < n:
        t += int(rng.exponential(2 * 24 * 60 / STEP_MINUTES))  # gap before next storm
        if t >= n:
            break
        duration = int(rng.uniform(1, 12) * 60 / STEP_MINUTES)
        intensity_mm_hr = rng.gamma(2.0, 5.0)
        profile = intensity_mm_hr * STEP_MINUTES / 60 * rng.uniform(0.3, 1.7, duration)
        end = min(n, t + duration)
        rain[t:end] += profile[: end - t]
        t = end

    soil_max = rng.uniform(80, 200)  # mm
    soil = rng.uniform(0.2, 0.6) * soil_max
    k1, k2 = rng.uniform(0.5, 3.0, 2) * 60 / STEP_MINUTES  # reservoir time constants in steps
    area_factor = rng.uniform(0.5, 2.0)
    base_level = rng.uniform(0.8, 2.0)
    rating_a = rng.uniform(0.3, 0.8)
    evaporation = rng.uniform(3, 6) / (24 * 60 / STEP_MINUTES)  # mm per step

    s1 = s2 = 0.0
    level = np.zeros(n)
    for i in range(n):
        runoff_share = min(1.0, (soil / soil_max) ** 2)
        runoff = rain[i] * runoff_share
        soil = min(soil_max, max(0.0, soil + rain[i] - runoff - evaporation))
        s1 += runoff * area_factor - s1 / k1
        s2 += s1 / k1 - s2 / k2
        discharge = s2 / k2
        level[i] = base_level + rating_a * discharge**0.6
    level += rng.normal(0, 0.005, n)  # 5 mm gauge noise
    return level, rain


def make_windows(level: np.ndarray, rain: np.ndarray, stride: int = 1):
    """Model inputs/targets from one series. Returns X (n, WINDOW, 2),
    y (n, len(HORIZON_STEPS)) - both normalised - and the raw current
    levels (for baselines)."""
    max_h = max(HORIZON_STEPS)
    X, y, current = [], [], []
    for end in range(WINDOW_STEPS, len(level) - max_h, stride):
        now = level[end - 1]
        window_level = (level[end - WINDOW_STEPS:end] - now) / LEVEL_SCALE_M
        window_rain = rain[end - WINDOW_STEPS:end] / RAIN_SCALE_MM
        X.append(np.stack([window_level, window_rain], axis=1))
        y.append([(level[end - 1 + h] - now) / LEVEL_SCALE_M for h in HORIZON_STEPS])
        current.append(now)
    return np.array(X, dtype=np.float32), np.array(y, dtype=np.float32), np.array(current)


def linear_baseline(X: np.ndarray) -> np.ndarray:
    """What the system does today (backend ETA): extrapolate the rate of
    the last 15 minutes. Returns normalised predicted changes."""
    rate_per_step = -X[:, -4, 0] / 3  # X level is relative to now; 3 steps = 15 min
    return np.stack([rate_per_step * h for h in HORIZON_STEPS], axis=1)


# ---------------------------------------------------------------------
# numpy LSTM inference (matches Keras LSTM -> Dense(relu) -> Dense)
# ---------------------------------------------------------------------
def _sigmoid(x):
    return 1.0 / (1.0 + np.exp(-x))


def lstm_forward(weights: dict, X: np.ndarray) -> np.ndarray:
    """X: (batch, steps, features) -> (batch, outputs). Keras gate order
    is i, f, c, o; activation tanh, recurrent activation sigmoid."""
    W, U, b = weights["lstm_kernel"], weights["lstm_recurrent"], weights["lstm_bias"]
    units = U.shape[0]
    h = np.zeros((X.shape[0], units), dtype=np.float32)
    c = np.zeros_like(h)
    for t in range(X.shape[1]):
        z = X[:, t, :] @ W + h @ U + b
        i = _sigmoid(z[:, :units])
        f = _sigmoid(z[:, units:2 * units])
        g = np.tanh(z[:, 2 * units:3 * units])
        o = _sigmoid(z[:, 3 * units:])
        c = f * c + i * g
        h = o * np.tanh(c)
    hidden = np.maximum(0, h @ weights["dense1_kernel"] + weights["dense1_bias"])
    return hidden @ weights["dense2_kernel"] + weights["dense2_bias"]


_cached_weights = None


def load_weights(path: str = MODEL_PATH):
    global _cached_weights
    if _cached_weights is None and os.path.exists(path):
        with np.load(path) as data:
            _cached_weights = {k: data[k] for k in data.files}
    return _cached_weights


# ---------------------------------------------------------------------
# Live forecast from stored readings
# ---------------------------------------------------------------------
def resample_readings(rows: list[tuple[datetime, float, float]], end: datetime):
    """rows: (timestamp, level_m, rain_mm_since_last), oldest first.
    Returns (levels, rains) for WINDOW_STEPS 5-min steps ending at `end`,
    or None when there isn't enough data. Level = last reading in a step
    (empty steps carry the previous level forward); rain = sum."""
    start = end - timedelta(minutes=STEP_MINUTES * WINDOW_STEPS)
    levels = [None] * WINDOW_STEPS
    rains = [0.0] * WINDOW_STEPS
    before_window = None
    for ts, level, rain in rows:
        if ts <= start:
            before_window = level
            continue
        if ts > end:
            continue
        # Steps are half-open (start + k*5min, start + (k+1)*5min], so a
        # reading exactly on a boundary belongs to exactly one step.
        step = math.ceil((ts - start).total_seconds() / (STEP_MINUTES * 60)) - 1
        levels[step] = level
        rains[step] += rain or 0.0
    empty = sum(1 for v in levels if v is None)
    if levels[0] is None and before_window is None:
        return None  # history doesn't reach back the full 2 hours
    if empty > MAX_EMPTY_STEP_FRACTION * WINDOW_STEPS:
        return None
    previous = before_window if levels[0] is None else levels[0]
    for i in range(WINDOW_STEPS):
        if levels[i] is None:
            levels[i] = previous
        previous = levels[i]
    return np.array(levels), np.array(rains)


def forecast_from_readings(rows: list[tuple[datetime, float, float]], end: datetime) -> dict:
    weights = load_weights()
    if weights is None:
        return {"available": False, "reason": "no trained model - run train_river_forecast.py"}
    series = resample_readings(rows, end)
    if series is None:
        return {
            "available": False,
            "reason": f"needs {WINDOW_STEPS * STEP_MINUTES} min of recent readings with few gaps",
        }
    levels, rains = series
    now_level = float(levels[-1])
    X = np.stack([(levels - now_level) / LEVEL_SCALE_M, rains / RAIN_SCALE_MM], axis=1)[None].astype(np.float32)
    lstm = lstm_forward(weights, X)[0] * LEVEL_SCALE_M
    linear = linear_baseline(X)[0] * LEVEL_SCALE_M
    return {
        "available": True,
        "current_level_m": round(now_level, 4),
        "forecast": [
            {
                "minutes_ahead": h * STEP_MINUTES,
                "level_m": round(now_level + float(lstm[k]), 4),
                "change_m": round(float(lstm[k]), 4),
                "linear_baseline_level_m": round(now_level + float(linear[k]), 4),
            }
            for k, h in enumerate(HORIZON_STEPS)
        ],
        "model": "LSTM trained on SYNTHETIC hydrology - indicative only, not validated on a real river",
    }
