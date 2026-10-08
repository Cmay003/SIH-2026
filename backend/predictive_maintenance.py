"""
SANJEEVNI - Predictive maintenance / sensor drift detection.

Distinct from anomaly_detection.py's IsolationForest, which catches
SUDDEN spikes/outliers in a single reading. This catches the opposite
failure mode: a slow, sustained drift over many readings (a corroding
probe, a slowly-drifting ADC reference, dust accumulating on a lens) -
the kind of degradation that never looks anomalous reading-by-reading,
but is clearly a real problem once you look at the trend.

Uses simple linear regression over a rolling window per (node, sensor):
if the slope is both (a) large enough to matter, and (b) consistent
enough that a straight line actually explains the trend (not just noise
that happens to slope one way this window), it's flagged.
"""

import numpy as np

DRIFT_WINDOW = 30  # readings to look back over

# Per-sensor: how much sustained change per READING counts as meaningful
# drift. These are deliberately conservative defaults - tune based on
# your actual sensors' real-world noise floor once you have field data.
DRIFT_SLOPE_THRESHOLDS = {
    "temp_c": 0.05,
    "humidity_pct": 0.3,
    "gas_ppm": 5.0,
}


def detect_sensor_drift(history: list, sensor_key: str) -> dict | None:
    """Returns None if there's not enough history yet, or no meaningful
    drift detected. Otherwise returns a dict describing the drift.

    `history` is a list/deque of the same per-reading dicts already
    stored in backend_server.py's node_history."""
    if sensor_key not in DRIFT_SLOPE_THRESHOLDS:
        return None

    recent = list(history)[-DRIFT_WINDOW:]
    values = [r.get(sensor_key) for r in recent if r.get(sensor_key) is not None]
    if len(values) < DRIFT_WINDOW:
        return None  # not enough history yet to trust a trend

    x = np.arange(len(values))
    values_arr = np.array(values, dtype=float)
    slope, intercept = np.polyfit(x, values_arr, 1)
    residuals = values_arr - (slope * x + intercept)
    noise = float(np.std(residuals))
    threshold = DRIFT_SLOPE_THRESHOLDS[sensor_key]

    total_drift = float(slope * len(values))

    # Two conditions must BOTH hold:
    # 1. The slope itself is large enough to matter (not just tiny jitter)
    # 2. The straight-line trend actually explains the data (total drift
    #    is clearly bigger than the noise around that trend line) - this
    #    is what distinguishes "sensor is genuinely drifting" from "this
    #    window happened to wobble upward a bit".
    if abs(slope) > threshold and abs(total_drift) > 3 * max(noise, 1e-6):
        return {
            "sensor": sensor_key,
            "slope_per_reading": round(float(slope), 4),
            "total_drift_over_window": round(total_drift, 3),
            "window_size": len(values),
            "noise_level": round(noise, 4),
        }
    return None


def check_all_sensors_for_drift(history: list) -> list:
    """Convenience wrapper - checks every monitored sensor and returns
    all detected drift issues (usually empty)."""
    results = []
    for sensor_key in DRIFT_SLOPE_THRESHOLDS:
        drift = detect_sensor_drift(history, sensor_key)
        if drift:
            results.append(drift)
    return results
