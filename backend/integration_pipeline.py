"""
SANJEEVNI - Integrated Pipeline
raw sensor reading -> anomaly filter -> risk model -> RAG alert
Requires flood_risk_model.py, anomaly_detection.py, rag_alert_pipeline.py
in the same folder.
"""

import os

import numpy as np
import pandas as pd
import shap
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split

import fast_inference
from flood_risk_model import generate_synthetic_data, scs_cn_runoff
from anomaly_detection import generate_sensor_stream
from hazard_classification import (
    FLOOD_SIGNATURE_RAIN_MM_HR,
    FLOOD_SIGNATURE_RATE_M_PER_HR,
    classify_all_hazards,
)
from rag_alert_pipeline import (
    build_knowledge_base,
    generate_alert_message,
    severity_band,
)

ANOMALY_FEATURES = [
    "river_level_m",
    "temp_c",
    "humidity_pct",
    "gas_ppm",
    "flame_reading",
]
GAS_LEAK_THRESHOLD_PPM = 800
FLAME_THRESHOLD = 0.3

# --- ESP32 HARDWARE BENCH-TEST OVERRIDE ---------------------------------
# Your flood_risk_model was trained expecting river_level_m on a REAL
# river's scale (roughly 1.5-5 meters). An ultrasonic sensor in a
# benchtop test (cup/bucket) can only ever report a tiny fraction of that
# range, so the ML model will correctly - but unhelpfully, for demo
# purposes - always call it LOW risk, no matter how "full" your test
# container gets.
#
# This override does NOT change the ML model or its thresholds anywhere
# else. It ONLY adds a raw-reading check, specifically for flood-type
# hazards, that can force MEDIUM/HIGH severity when your test rig's
# water level crosses a small physical threshold you set below - the
# same "trust the raw sensor over the model" pattern your gas/flame
# hazard-signature check above already uses.
#
# BENCH MODE IS OFF BY DEFAULT (B22). Turn it on only for the tabletop rig:
#   PowerShell:  $env:SANJEEVNI_BENCH_MODE="1"   (before starting uvicorn)
# On a real river gauge a 0.6-1.0 m reading is often NOT dangerous - this
# override left on in the field would cause false MEDIUM/HIGH alerts.
# Thresholds are fractions of the sensor's mount height above the empty
# container (SANJEEVNI_BENCH_MOUNT_M, default 0.0234 m = the measured rig):
# MEDIUM at 40 % full, HIGH at 75 % full.
HARDWARE_TEST_MODE = os.environ.get("SANJEEVNI_BENCH_MODE", "0") == "1"
BENCH_MOUNT_HEIGHT_M = float(os.environ.get("SANJEEVNI_BENCH_MOUNT_M", "0.0234"))
HARDWARE_TEST_WATER_MEDIUM_M = 0.40 * BENCH_MOUNT_HEIGHT_M
HARDWARE_TEST_WATER_HIGH_M = 0.75 * BENCH_MOUNT_HEIGHT_M
print(f"[pipeline] bench mode {'ON - tabletop thresholds active' if HARDWARE_TEST_MODE else 'off'}")


def bench_mount_for(reading: dict):
    """The bench rig's mount height when the tabletop thresholds apply to
    this reading (bench mode on, real hardware), else None. Simulated
    traffic always gets the river-scale thresholds - see
    hardware_test_water_severity()."""
    if not HARDWARE_TEST_MODE or reading.get("simulated"):
        return None
    return BENCH_MOUNT_HEIGHT_M

# Values no working sensor can produce. A reading outside these is a sensor
# fault, full stop - checked BEFORE the anomaly model, because Isolation
# Forest scores every value beyond its training range about the same, so a
# 14 m "river" could slip through as a flood (B32).
#
# The firmware sends gas_ppm through sjClampU16, so a pegged MQ135 (Rs near
# 0 in a big leak - or a shorted pin) arrives as exactly 65535. That is a
# SATURATED-HIGH reading, not an impossible one: calling it a sensor fault
# hid the largest leaks of all. Anything above GAS_SATURATED_PPM is beyond
# the MQ135's calibrated range, so it is classified as a (very high) gas
# reading and flagged "saturated"; only values the firmware cannot send at
# all (> 65535) are impossible. A shorted pin that reads 65535 is still
# held back from the public by the multi-node cross-check
# (hazard_confirmation.py), so this trades no extra public false alarms.
GAS_FIRMWARE_CLAMP_PPM = 65535.0
GAS_SATURATED_PPM = 50000.0
PHYSICAL_LIMITS = {
    "river_level_m": (0.0, float(os.environ.get("SANJEEVNI_MAX_RIVER_LEVEL_M", "10"))),
    "temp_c": (-40.0, 70.0),
    "humidity_pct": (0.0, 100.0),
    "gas_ppm": (0.0, GAS_FIRMWARE_CLAMP_PPM),
    "flame_reading": (0.0, 1.0),
}
# Rain gauge range check. Rain arrives as mm since the previous report, so
# the believable maximum depends on how long ago that report was: the
# firmware keeps adding to pendingRainMm across intervals when a queue push
# fails, so one report can legitimately carry several intervals' rain.
# A cap in mm/h, scaled by the time since the previous reading, allows
# that; a flat cap would either reject a real catch-up report or let a
# 300 mm glitch through. One impossible value used to land in the rain log
# and raise a landslide WATCH that re-scored itself for up to 24 h.
# Kept OUT of the pydantic model on purpose: a Field limit would 422 the
# whole /api/ingest/batch and the node would retry it forever (review R7).
RAIN_MAX_MM_PER_HR = 300.0       # about the 1 h world record; no gauge reports more
RAIN_MAX_MM_PER_READING = 400.0  # hard cap, even after a long gap
RAIN_MIN_GAP_HOURS = 1 / 6       # floor, so a 5 s interval still allows a real burst


def rain_reading_plausible(mm, hours_since_prev) -> bool:
    """False when `mm` (rain since the previous report) is more than any
    working gauge could have caught in `hours_since_prev` hours (None = no
    previous reading known). Negative is always a fault; None (no value)
    is not."""
    if mm is None:
        return True
    if mm < 0:
        return False
    hours = RAIN_MIN_GAP_HOURS if hours_since_prev is None else max(RAIN_MIN_GAP_HOURS, hours_since_prev)
    return mm <= min(RAIN_MAX_MM_PER_READING, RAIN_MAX_MM_PER_HR * hours)


# Values the backend derives FROM a sensor field. When the field is a fault
# its derived values are garbage too (a 14 m spike makes a huge "rise"
# rate, which alone could pass is_flood_signature), so they go with it.
DERIVED_FROM = {
    # The node's own rise rate / fast-rise flag come from the same sensor,
    # so a faulty level discards them too (else they alone could raise a
    # flash flood - hazard_classification.classify_flash_flood).
    "river_level_m": ("river_level_rate_m_per_hr", "node_rise_rate_m_per_hr", "fast_rise"),
    "gas_ppm": ("gas_ppm_rate_per_hr",),
}


def implausible_fields(reading: dict) -> list[str]:
    """Every field outside what a working sensor can report."""
    return [
        field
        for field, (low, high) in PHYSICAL_LIMITS.items()
        if reading.get(field) is not None and not (low <= reading[field] <= high)
    ]


# A DROPOUT frame: two or more of the environment channels read exactly 0
# at once (a sensor bus that returned nothing, a node that sent an empty
# struct). No working DHT22 + MQ135 pair reads 0 % humidity AND 0 ppm gas
# (or 0.0 C) together in open air. Each zero on its own can be a real
# value (0 C in a Himalayan winter, an empty river bed), so one zero is
# not a dropout. The river level of a dropout frame is dropped too when it
# is also exactly 0 - it came from the same empty frame.
# Added in step B1 (2026-10-09): the Isolation Forest used to be the only
# thing catching dropouts, and its flag is now only trusted when the
# reading is also out of line with the node's own recent readings
# (anomaly_flag_stands), which a dropout that LASTS stops being after a
# few readings.
DROPOUT_CHANNELS = ("temp_c", "humidity_pct", "gas_ppm")
DROPOUT_MIN_ZERO_CHANNELS = 2


def dropout_fields(reading: dict) -> list[str]:
    """Fields of a dropout frame (see above), or [] when it is not one."""
    zeros = [f for f in DROPOUT_CHANNELS if reading.get(f) is not None and reading[f] == 0]
    if len(zeros) < DROPOUT_MIN_ZERO_CHANNELS:
        return []
    if reading.get("river_level_m") is not None and reading["river_level_m"] == 0:
        zeros.append("river_level_m")
    return zeros


def fault_fields(reading: dict) -> list[str]:
    """Every field a working sensor cannot have produced: out of range
    (implausible_fields) or part of a dropout frame (dropout_fields)."""
    faults = implausible_fields(reading)
    for field in dropout_fields(reading):
        if field not in faults:
            faults.append(field)
    return faults


def physically_implausible(reading: dict) -> str | None:
    """Name of the first field outside what a working sensor can report."""
    faults = implausible_fields(reading)
    return faults[0] if faults else None


def drop_implausible_fields(reading: dict) -> tuple[dict, list[str]]:
    """(copy of reading with every faulty field - and what was derived from
    it - set to None, list of faulty fields). Modular nodes treat each
    sensor independently (P2.7), so one bad channel removes only that
    channel: suppressing the WHOLE reading let a floating MQ135 pin hide a
    real flood on the same node (B32 fix was too broad).

    Faults the caller already found are in reading["sensor_faults"]: a
    check that needs context this dict lacks (rain_reading_plausible needs
    the time since the previous reading) is done in derive_features, and
    reported here the same way as a PHYSICAL_LIMITS fault. A dropout frame
    (dropout_fields) is a fault the same way."""
    faults = fault_fields(reading)
    for field in reading.get("sensor_faults") or ():
        if field not in faults:
            faults.append(field)
    if not faults:
        return reading, []
    clean = dict(reading)
    for field in faults:
        clean[field] = None
        for derived in DERIVED_FROM.get(field, ()):
            if derived in clean:
                clean[derived] = None
    return clean, faults


def fault_reason(reading: dict, faults: list[str]) -> str:
    """The suppression reason for a reading whose only finding is faulty
    fields: "physically_impossible_<fields>" (out of range, impossible
    rain), "dropout_<fields>" (dropout_fields) and/or "spike_river_level_m"
    (a river spike - backend_server sets reading["river_spike"]), joined
    by ";" when there are several kinds."""
    dropout = set(dropout_fields(reading))
    out_of_range = set(implausible_fields(reading))
    kinds = {"physically_impossible_": [], "dropout_": [], "spike_": []}
    for field in faults:
        if field in out_of_range:
            kinds["physically_impossible_"].append(field)
        elif field in dropout:
            kinds["dropout_"].append(field)
        elif field == "river_level_m" and reading.get("river_spike"):
            kinds["spike_"].append(field)
        else:
            kinds["physically_impossible_"].append(field)
    return ";".join(prefix + ",".join(fields) for prefix, fields in kinds.items() if fields)


def saturated_fields(reading: dict) -> list[str]:
    """Sensors pinned at (or near) the top of their range - see
    GAS_SATURATED_PPM. The true value is at least this high."""
    gas = reading.get("gas_ppm")
    return ["gas_ppm"] if gas is not None and gas >= GAS_SATURATED_PPM else []


# A flood announces itself physically: the water rises fast WHILE it rains
# hard or the upstream node rises too. Such a reading must reach the flood
# model even if the anomaly model has never seen values like it (B15).
# FLOOD_SIGNATURE_RATE_M_PER_HR / _RAIN_MM_HR live in hazard_classification
# (imported above), which uses them to corroborate a flash flood too.


def is_flood_signature(reading: dict) -> bool:
    rising = (reading.get("river_level_rate_m_per_hr") or 0) >= FLOOD_SIGNATURE_RATE_M_PER_HR
    corroborated = (
        (reading.get("rainfall_intensity_mm_hr") or 0) >= FLOOD_SIGNATURE_RAIN_MM_HR
        or (reading.get("upstream_rate_m_per_hr") or 0) >= FLOOD_SIGNATURE_RATE_M_PER_HR
    )
    return rising and corroborated


# The node's own anomaly checks (edge_anomaly, "<check>:<field>") as a
# sensor-fault signal for the RIVER sensor. A level the node itself calls
# stuck (frozen), a spike (jump vs its rolling mean) or an impossible rate
# must not create a flood / flash-flood alert on its own - the same rule
# the Isolation Forest applies to an unusual reading: held back UNLESS the
# physical flood signature (is_flood_signature: rising AND heavy rain or a
# rising upstream node) independently backs it up.
#
# Why only the river: for gas, flame, heat or PM2.5 the threshold reading
# IS the hazard signature (is_hazard_signature), so the Isolation Forest
# never suppresses those either; a flagged value there only lowers the
# alert's confidence (alert_confidence.py), and a one-off spike cannot
# pass HazardConfirmer, which needs a repeat. The river is the one sensor
# with independent corroboration (rain gauge, upstream node) to check
# against.
#
# Cost: a real flash flood whose first samples the node flags as a spike,
# with no rain and no upstream node rising, is held for those samples -
# once the level stays up the spike check stops firing (and the backend's
# own rate, from median-smoothed levels, sees the rise). "dropout" (missing
# samples) is not here: the value that did arrive is a measurement.
# Waived in bench mode, like the flash-flood corroboration: a tabletop rig
# has no rain gauge or upstream node, and bench mode exists to demo the
# alert chain (it is never for field use).
EDGE_RIVER_HOLD_CHECKS = ("stuck", "spike", "rate")
RIVER_HAZARDS = ("flood", "flash_flood")


def edge_river_doubts(reading: dict) -> list[str]:
    """The node's anomaly flags that put its river level in doubt, e.g.
    ["spike:river_level_m"] (empty when there are none)."""
    doubts = []
    for item in reading.get("edge_anomaly") or ():
        check, _, field = str(item).partition(":")
        if field == "river_level_m" and check in EDGE_RIVER_HOLD_CHECKS and item not in doubts:
            doubts.append(str(item))
    return doubts


def hold_doubtful_river_hazards(reading: dict, candidates: dict) -> list[str]:
    """Applies the rule above to the candidates IN PLACE: an elevated
    flood / flash_flood is set to LOW and marked "held_by_edge_anomaly".
    Returns the flags that held something (empty = nothing held)."""
    doubts = edge_river_doubts(reading)
    if not doubts or is_flood_signature(reading) or bench_mount_for(reading) is not None:
        return []
    held = False
    for hazard_type in RIVER_HAZARDS:
        candidate = candidates.get(hazard_type)
        if candidate and candidate["severity"] != "LOW":
            candidates[hazard_type] = {
                **candidate, "severity": "LOW", "held_by_edge_anomaly": doubts,
                "severity_before_hold": candidate["severity"],
            }
            held = True
    return doubts if held else []


def hardware_test_water_severity(reading: dict) -> str | None:
    """Returns 'HIGH', 'MEDIUM', or None based on the RAW water-level
    reading alone - bypassing the ML model's absolute-scale expectation.
    Only meaningful while HARDWARE_TEST_MODE is True; returns None (no
    override) otherwise, so process_reading() falls back to the normal
    ML-computed severity untouched.

    Also skipped entirely for simulated readings (reading["simulated"]) -
    this override's thresholds are calibrated to one specific physical
    ultrasonic sensor's tiny real-world range. A simulator sending
    realistic river-scale values (1.5-4m) would blow straight through
    HARDWARE_TEST_WATER_HIGH_M every time otherwise, always forcing HIGH
    regardless of the actual scenario being tested."""
    if not HARDWARE_TEST_MODE or reading.get("simulated"):
        return None
    level = reading.get("river_level_m")
    if level is None:
        return None
    if level >= HARDWARE_TEST_WATER_HIGH_M:
        return "HIGH"
    if level >= HARDWARE_TEST_WATER_MEDIUM_M:
        return "MEDIUM"
    return None


def is_hazard_signature(reading: dict) -> bool:
    """A raw, unambiguous physical signal strong enough to bypass the
    anomaly filter, even though it's statistically rare (which is
    exactly what an anomaly detector would otherwise flag it as).

    BUG FOUND VIA END-TO-END TESTING, FIXED HERE: originally only
    checked gas/flame. A genuine 46C extreme-heat reading was getting
    silently suppressed as a "sensor fault" by the anomaly detector,
    because temp_c/tilt/PM2.5/water-quality were never included here -
    the anomaly detector (trained only on what counts as "normal" for
    its original 5 features) had no way to know a real heat wave,
    landslide, pollution spike, or water contamination event isn't just
    a broken sensor. Now reuses the SAME thresholds the classifiers
    themselves use (via classify_all_hazards), so a genuine MEDIUM+ on
    ANY hazard type always bypasses suppression - not just gas/flame."""
    if (
        (reading.get("gas_ppm") or 0) > GAS_LEAK_THRESHOLD_PPM
        or (reading.get("flame_reading") or 0) > FLAME_THRESHOLD
        or is_flood_signature(reading)
    ):
        return True

    for result in classify_all_hazards(reading, bench_mount_for(reading)).values():
        # A forecast-only result (heavy rain / high wind from Open-Meteo)
        # says nothing about whether THIS node's sensors are working, so it
        # must not let an anomalous reading past the filter: the garbage
        # values would be stored as live data. The forecast is re-checked
        # on the node's next clean reading.
        if result.get("forecast_based"):
            continue
        if result["severity"] in ("MEDIUM", "HIGH", "CRITICAL"):
            return True
    return False


# One line added to a landslide alert saying WHY it fired, so a reader
# can tell a rain WATCH (nothing has moved yet) from measured movement.
# SAFETY-CRITICAL TEXT - shown to officers and, once confirmed, sent to
# citizens: needs human review (wording, and a Hindi version) before
# field use.
LANDSLIDE_TRIGGER_TEXT = {
    "rain": "Trigger: rainfall is above the landslide warning threshold for this slope. "
            "No ground movement has been measured yet.",
    "tilt": "Trigger: ground tilt or vibration measured at the sensor.",
    "both": "Trigger: rainfall is above the landslide warning threshold AND ground "
            "movement has been measured at the sensor.",
}


def alert_detail(hazard_type: str, winner: dict) -> str | None:
    """The one "why it fired" sentence for an alert, or None.
    SAFETY-CRITICAL TEXT, same review note as LANDSLIDE_TRIGGER_TEXT."""
    if hazard_type == "landslide":
        return LANDSLIDE_TRIGGER_TEXT.get(winner.get("trigger"))
    if hazard_type == "flash_flood":
        cm_per_min = (winner.get("rise_rate_m_per_hr") or 0) / 0.6
        text = (f"Trigger: the river is rising fast, about {cm_per_min:.1f} cm per minute."
                if cm_per_min > 0 else "Trigger: the river sensor reports a fast rise.")
        if winner.get("corroborated"):
            text += " Heavy rain or a rising river upstream confirms it."
        return text
    if hazard_type == "smoke":
        return ("Trigger: smoke particles (PM2.5) and gas are rising together at the sensor - "
                "something may be burning nearby.")
    if hazard_type == "extreme heat":
        return heat_detail(winner)
    if hazard_type == "heavy_rain":
        return heavy_rain_detail(winner)
    if hazard_type == "high_wind":
        return high_wind_detail(winner)
    return None


# IMD category names as written in alert text (hazard_classification has
# the sources). "range" / "level" wording on purpose: one SANJEEVNI node is
# not an IMD station and these are not IMD warnings.
IMD_RAIN_CATEGORY_TEXT = {
    "heavy": "heavy rain",
    "very_heavy": "very heavy rain",
    "extremely_heavy": "extremely heavy rain",
}
FORECAST_SOURCE_TEXT = {
    "open-meteo": "Open-Meteo weather forecast",
    "mock": "TEST forecast file (SANJEEVNI_WEATHER_MOCK), not a live forecast",
}


def _forecast_source_text(winner: dict) -> str:
    return FORECAST_SOURCE_TEXT.get(winner.get("forecast_source"), "weather forecast")


def heat_detail(winner: dict) -> str | None:
    category = winner.get("imd_category")
    if category in ("heat_wave", "severe_heat_wave"):
        name = "severe heat wave" if category == "severe_heat_wave" else "heat wave"
        if winner.get("criterion") == "departure":
            basis = f"{winner.get('departure_c')} C above this place's normal maximum"
        else:
            basis = "the temperature at the sensor"
        return (f"Trigger: {basis} is at IMD's {name} level. IMD itself declares a heat wave "
                "only after 2 days at 2 stations - this is one sensor's reading.")
    if category == "heat_wave_threshold":
        return ("Trigger: the temperature at the sensor has reached the level at which IMD "
                "starts to consider a heat wave.")
    return None


def heavy_rain_detail(winner: dict) -> str | None:
    parts = []
    measured_cat = winner.get("measured_category")
    if winner.get("basis") in ("measured", "both") and measured_cat:
        parts.append(f"the node's rain gauge measured {winner.get('measured_24h_mm')} mm in the "
                     f"last 24 h (IMD {IMD_RAIN_CATEGORY_TEXT[measured_cat]} range)")
    forecast_cat = winner.get("forecast_category")
    if winner.get("basis") in ("forecast", "both") and forecast_cat:
        parts.append(f"the {_forecast_source_text(winner)} expects about "
                     f"{winner.get('forecast_24h_mm')} mm in the next 24 h (IMD "
                     f"{IMD_RAIN_CATEGORY_TEXT[forecast_cat]} range)")
    if not parts:
        return None
    text = "Trigger: " + "; ".join(parts) + "."
    if winner.get("forecast_based") and winner.get("basis") == "both":
        # The gauge measured heavy rain too, but less than the forecast:
        # the severity is the forecast's (hazard_classification).
        text += (" Severity is forecast-based: the forecast expects more rain than "
                 "SANJEEVNI's gauge has measured so far.")
    elif winner.get("forecast_based"):
        text += " Forecast-based: not measured by SANJEEVNI sensors."
    return text


def high_wind_detail(winner: dict) -> str | None:
    gust = winner.get("forecast_wind_gust_max_kmh")
    speed = winner.get("forecast_wind_speed_max_kmh")
    values = []
    if speed is not None:
        values.append(f"wind up to {speed:.0f} km/h")
    if gust is not None:
        values.append(f"gusts up to {gust:.0f} km/h")
    if not values or not winner.get("wind_trigger"):
        return None
    text = f"Trigger: the {_forecast_source_text(winner)} expects {' and '.join(values)} in the next 24 h"
    if winner.get("wind_trigger") == "gale_force_wind":
        text += " (IMD gale force)"
    return text + ". Forecast-based: not measured by SANJEEVNI sensors."


# When two hazards reach the SAME severity, the more specific (and more
# urgent to act on) one becomes the reading's primary hazard_type, so its
# advice is the one people get: a flash flood ("move away from the river
# now") over the flood model's level-based flood, a flame-confirmed fire
# over smoke, and smoke ("something is burning") over the gas leak and
# air-pollution readings it causes. Unlisted hazards are 0; risk_score
# still breaks the remaining ties. Never applied at LOW, so a quiet
# reading's logged hazard_type is unchanged.
HAZARD_TIE_PRIORITY = {"flash_flood": 2, "fire": 2, "smoke": 1}

# A forecast-only hazard (heavy rain / high wind from the weather forecast)
# can never be above this - so it can never auto-sound the village siren,
# which needs a confirmed CRITICAL. hazard_classification already caps it;
# this is the pipeline-level guarantee for any future forecast classifier.
FORECAST_MAX_SEVERITY = "HIGH"
FORECAST_MAX_RISK = 0.9  # severity_band(): CRITICAL is > 0.9


def cap_forecast_candidate(candidate: dict) -> dict:
    if not candidate.get("forecast_based") or candidate["severity"] != "CRITICAL":
        return candidate
    return {**candidate, "severity": FORECAST_MAX_SEVERITY,
            "risk_score": min(candidate["risk_score"], FORECAST_MAX_RISK)}


def train_flood_model():
    df = generate_synthetic_data()
    df = pd.get_dummies(df, columns=["land_use"], drop_first=True)
    feature_cols = [c for c in df.columns if c != "flood_event"]
    X = df[feature_cols]
    y = df["flood_event"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    # UPGRADE: calibrated probabilities - see the matching comment in
    # train_models.py for the full explanation. Kept consistent here
    # since this is the fallback path used when no saved model exists.
    base_model = HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.08, max_depth=4, random_state=42
    )
    model = CalibratedClassifierCV(base_model, method="sigmoid", cv=5)
    model.fit(X_train, y_train)
    return model, feature_cols


def get_base_tree_model(flood_model):
    """Extracts the underlying (uncalibrated) tree model for SHAP
    explanation purposes. Calibration (CalibratedClassifierCV) wraps the
    tree model and doesn't change WHICH features drove a decision, only
    the final probability's real-world meaning - so explaining via the
    base tree is a standard, defensible approach, not a workaround.

    Falls back to treating flood_model as the tree model directly, for
    backward compatibility with any older saved .joblib model trained
    before calibration was added (a plain HistGradientBoostingClassifier
    has no .calibrated_classifiers_ attribute)."""
    if hasattr(flood_model, "calibrated_classifiers_"):
        return flood_model.calibrated_classifiers_[0].estimator
    return flood_model


def train_anomaly_detector():
    df = generate_sensor_stream()
    X = df[ANOMALY_FEATURES]
    y_true = df["is_anomaly"]
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    contamination = y_true.mean()
    model = IsolationForest(
        n_estimators=200, contamination=contamination, random_state=42
    )
    model.fit(X_scaled)
    return model, scaler


def anomaly_model_input(reading: dict) -> dict:
    """The five values the Isolation Forest scores, with the flame channel
    as the hardware sends it.

    Every production firmware sends flame_reading as exactly 0.0 or 1.0
    (a digital IR flame module: firmware/*/sj_packet.h, sanjeevni_node*.ino).
    The forest was fitted on synthetic flame NOISE (clip(N(0, 0.02)), so
    its scaler's flame sigma is 0.012) and scored any sub-threshold value
    from 0.03 up as a 3-sigma outlier: measured 2026-10-09 on load-test
    normal readings (flame uniform 0-0.05, server/simulation.js and
    tools/loadtest/ingest_load.js), 48 % of readings with flame 0.04-0.05
    were suppressed as "sensor faults" - the main cause of the ~8-10 %
    fault rate in the round-3 load test. A value at or below
    FLAME_THRESHOLD says "no flame" and is scored as the 0.0 the hardware
    would send; above it is_hazard_signature lets the reading through
    anyway."""
    vector = {k: reading[k] for k in ANOMALY_FEATURES}
    if vector["flame_reading"] <= FLAME_THRESHOLD:
        vector["flame_reading"] = 0.0
    return vector


def check_anomaly(reading: dict, anomaly_model, anomaly_scaler) -> tuple[bool, float | None]:
    # The Isolation Forest was trained on all five core sensors together.
    # A modular node without one of them (P2.7) can't be scored, so it is
    # skipped - the physical range checks still run on what it does send.
    if any(reading.get(k) is None for k in ANOMALY_FEATURES):
        return False, None
    vector = anomaly_model_input(reading)
    # Same numbers, ~0.5 ms instead of ~160 ms (fast_inference.py: the
    # library's own arithmetic on flattened trees, checked at build time;
    # None = not a model shape it knows -> scikit-learn as before).
    fast = fast_inference.fast_isolation_forest(anomaly_model, anomaly_scaler, ANOMALY_FEATURES)
    if fast is not None:
        flags, scores = fast.predict_and_score(
            np.array([[vector[k] for k in ANOMALY_FEATURES]], dtype=np.float64)
        )
        return flags[0], scores[0]
    scaled = anomaly_scaler.transform(pd.DataFrame([vector]))
    pred = anomaly_model.predict(scaled)[0]
    score = -anomaly_model.score_samples(scaled)[0]
    return pred == -1, score


# --- The forest's flag vs the node's OWN recent readings (step B1) --------
#
# The Isolation Forest scores ABSOLUTE values and was fitted on one
# synthetic site in one season (river 1.4-2.2 m, 23-31 C, 45-74 % RH:
# anomaly_detection.generate_sensor_stream). Every reading outside that
# envelope looks "unusual" to it, whatever the cause. Measured 2026-10-09
# with the saved model (flame already scored as the hardware sends it):
# 97 % of hot, dry pre-monsoon readings (35-42 C, 15-30 % RH, river
# 0.4-1 m - SYNTHETIC, ordinary plains conditions) were flagged, and every
# flagged reading without a hazard signature was suppressed as a sensor
# fault - a node in such a place would have gone dark all summer.
#
# A sensor FAULT, though, is a change relative to the node itself: a
# spike, a dropout, a channel that suddenly reads garbage. So a flag now
# suppresses a reading only when the reading is ALSO out of line with the
# node's own recent readings (backend_server puts their per-field median
# in reading["anomaly_baseline"]). When the node has too little recent
# history to judge (start-up, after a restart or a long gap), the flag
# stands, as before.
# A fault that LASTS becomes the node's "own" baseline after about half
# the window; the dropout case is caught by dropout_fields regardless, and
# a sensor stuck at a plausible value is the node's edge checks' job
# (edge_anomaly "stuck:<field>") and predictive_maintenance's drift check.
#
# TOLERANCES ARE DEMO DEFAULTS chosen for this project (no standard to
# cite): wider than the normal change of each quantity within the window
# (ANOMALY_BASELINE_WINDOW readings, at most ANOMALY_BASELINE_MAX_AGE_MIN
# old), far narrower than the injected faults (x3-x8 spikes, drops to 0).
# Tune per site from field data.
ANOMALY_BASELINE_TOLERANCE = {
    "river_level_m": 0.5,   # m
    "temp_c": 6.0,          # C
    "humidity_pct": 20.0,   # % RH
    "gas_ppm": 150.0,       # MQ135 "ppm" (uncalibrated)
}
ANOMALY_BASELINE_WINDOW = 10
ANOMALY_BASELINE_MAX_AGE_MIN = 60
ANOMALY_BASELINE_MIN_SAMPLES = 3


def anomaly_baseline(history_entries) -> dict:
    """{field: {"median": m, "samples": n}} over the given earlier readings
    of one node (each a dict with the ANOMALY_BASELINE_TOLERANCE fields;
    None = no value, e.g. a faulty field, and is skipped). The caller
    passes the last ANOMALY_BASELINE_WINDOW readings no older than
    ANOMALY_BASELINE_MAX_AGE_MIN."""
    out = {}
    for field in ANOMALY_BASELINE_TOLERANCE:
        values = [e.get(field) for e in history_entries if e.get(field) is not None]
        if values:
            out[field] = {"median": float(np.median(values)), "samples": len(values)}
    return out


# --- River SPIKE: a level the river cannot have reached (step B1) ---------
#
# Measured 2026-10-09 (tests/false_alarm_streams.py, load-test stream):
# a one-reading river spike (x3-x8, like the forest's training faults) was
# held back in 1 of 6 cases and became a MEDIUM+ flood / flash-flood
# candidate in 5 - the forest's flag never mattered, because the spike's
# own flood score passes is_hazard_signature. (On real hardware the median
# smoothing and the node's own "spike:river_level_m" flag catch most of
# these; simulated / smoothing-free traffic had nothing.)
# So a level further from the node's LAST good level than the river could
# have moved since - ANOMALY_BASELINE_TOLERANCE plus RIVER_SPIKE_MAX_RATE_M_PER_HR
# (backend_server; its own setting, separate from the rate clamp) over the
# time between the two - is a sensor fault for that reading, like an
# out-of-range value, UNLESS
#   - the node has too little recent history to judge (fewer than
#     ANOMALY_BASELINE_MIN_SAMPLES levels in the baseline window); or
#   - something independent says the river really is rising: heavy rain
#     (the last hour's total OR this reading's own rain rate - the hourly
#     total lags at the start of a storm), a rising upstream node
#     (is_flood_signature's evidence) or the node's own fast-rise check; or
#   - it continues the node's recent TREND: within the tolerance (plus
#     RIVER_SPIKE_RAMP_SLACK of the step) of the last good level carried on
#     at the rate between the last two good levels - so a ramp, once
#     accepted, is not held again on every reading; or
#   - the level has STAYED there: the RIVER_SPIKE_ACCEPT_AFTER readings
#     just before were all held as spikes at about this level (a re-mounted
#     sensor or a real step) - a spike does not repeat itself; or
#   - the held readings and this one form a STEADY RAMP away from the last
#     good level: every step in the same direction, each step's size within
#     the tolerance (plus RIVER_SPIKE_RAMP_SLACK of it) of what the previous
#     step's rate predicts (review 2026-10-09: a sustained uncorroborated
#     0.7 m/min rise was held for 8+ readings, because "stayed there" never
#     held for a level that keeps moving).
#   The accepted level is then the new "last good level".
# Cost: an uncorroborated real jump or steep ramp (no rain, no upstream
# node, a node without the fast-rise check) is held for
# RIVER_SPIKE_ACCEPT_AFTER readings (measured 2026-10-09 with
# tests/false_alarm_streams.py replays: 0.7 m/min at 60 s and 0.3 m/min at
# 300 s both accepted on the 3rd reading). Residual risk: a failing sensor
# whose garbage happens to form three steady steps in one direction passes
# as a ramp (measured rates at RIVER_SPIKE_RAMP_SLACK below).
RIVER_SPIKE_ACCEPT_AFTER = 2
# DEMO DEFAULT (no standard to cite): how far a step may differ from the one
# the previous step's rate predicts, as a fraction of that predicted step,
# on top of ANOMALY_BASELINE_TOLERANCE. Measured 2026-10-09 (synthetic,
# 60 s cadence, 200 000 runs of 3 consecutive x3-x8 spikes, the forest's
# fault model): 3rd spike accepted in 1.76 % of runs before the ramp rule,
# 2.77 % with slack 0.25, 5.31 % with 0.5. Steady (0.7, 1.5 m/reading),
# accelerating (0.3/0.7/1.2, 0.6/0.9/1.3) and slowing (0.8/0.6/0.4) ramps
# are all accepted at 0.25.
RIVER_SPIKE_RAMP_SLACK = 0.25


def _continues(prev, last, value_at_hours, value, tolerance) -> bool:
    """True when `value`, taken `value_at_hours` before this reading,
    carries on the step from `prev` to `last` - both (hours_before_this_
    reading, level), prev the older: its step from last is within the
    tolerance (plus RIVER_SPIKE_RAMP_SLACK of it) of that step's rate x the
    time since last."""
    (t_prev, v_prev), (t_last, v_last) = prev, last
    dt_prev = t_prev - t_last
    if dt_prev <= 0:
        return False
    predicted_step = (v_last - v_prev) / dt_prev * (t_last - value_at_hours)
    return abs((value - v_last) - predicted_step) <= tolerance + RIVER_SPIKE_RAMP_SLACK * abs(predicted_step)


def _steady_ramp(points, tolerance) -> bool:
    """points: (hours_before_now, level), oldest first, the last one = this
    reading. True when every step goes the same way (none flat) and each
    one carries on the step before it (_continues)."""
    steps = [b[1] - a[1] for a, b in zip(points, points[1:])]
    if not steps or any(d == 0 for d in steps) or len({d > 0 for d in steps}) != 1:
        return False
    return all(_continues(points[i - 1], points[i], points[i + 1][0], points[i + 1][1], tolerance)
               for i in range(1, len(points) - 1))


def river_spike(value, last_good, hours_since_last_good: float, history_known: bool,
                max_rate_m_per_hr: float, corroborated: bool, held_before: list,
                prev_good=None) -> bool:
    """True when `value` (this reading's water level) is a spike - see above.
    last_good: the node's most recent level that was not held (None = none
    in the window), hours_since_last_good before this reading;
    history_known: the baseline window has enough levels; held_before: the
    immediately preceding readings that were held as spikes, as
    (hours_before_this_reading, level), oldest first (the run ends at the
    previous reading); prev_good: the good level before last_good, as
    (hours_before_this_reading, level), or None."""
    if value is None or last_good is None or corroborated or not history_known:
        return False
    tolerance = ANOMALY_BASELINE_TOLERANCE["river_level_m"]
    hours_since_last_good = max(0.0, hours_since_last_good)
    if abs(value - last_good) <= tolerance + max_rate_m_per_hr * hours_since_last_good:
        return False
    good = (hours_since_last_good, last_good)
    if prev_good is not None and _continues(prev_good, good, 0.0, value, tolerance):
        return False  # carries on the node's recent trend
    recent = list(held_before[-RIVER_SPIKE_ACCEPT_AFTER:])
    if len(recent) < RIVER_SPIKE_ACCEPT_AFTER:
        return True
    if all(abs(value - v) <= tolerance for _, v in recent):
        return False  # it stayed there: accept the new level
    # A steady ramp from the level before the held run (the last good one
    # when the run is just RIVER_SPIKE_ACCEPT_AFTER long).
    before = held_before[-RIVER_SPIKE_ACCEPT_AFTER - 1] if len(held_before) > RIVER_SPIKE_ACCEPT_AFTER else good
    if _steady_ramp([before, *recent, (0.0, value)], tolerance):
        return False
    return True


def anomaly_flag_stands(reading: dict) -> bool:
    """True when an Isolation Forest flag should suppress this reading: the
    node has too little recent history to judge, or at least one value is
    further from the node's own recent median than its tolerance."""
    baseline = reading.get("anomaly_baseline")
    if not baseline:
        return True
    for field, tolerance in ANOMALY_BASELINE_TOLERANCE.items():
        value = reading.get(field)
        if value is None:
            continue
        ref = baseline.get(field)
        if ref is None or ref["samples"] < ANOMALY_BASELINE_MIN_SAMPLES:
            return True
        if abs(value - ref["median"]) > tolerance:
            return True
    return False


def _build_flood_feature_row(reading: dict) -> dict:
    """Shared feature-row construction, used by both compute_flood_risk()
    and explain_flood_risk() so they can never drift out of sync with
    each other."""
    runoff_mm = scs_cn_runoff(
        np.array([reading["rainfall_24h_mm"]]), np.array([reading["curve_number"]])
    )[0]
    return {
        "curve_number": reading["curve_number"],
        "rainfall_24h_mm": reading["rainfall_24h_mm"],
        "rainfall_intensity_mm_hr": reading["rainfall_intensity_mm_hr"],
        "forecast_rainfall_6h_mm": reading.get("forecast_rainfall_6h_mm") or 0.0,
        "runoff_mm": runoff_mm,
        "river_level_m": reading["river_level_m"],
        "river_level_rate_m_per_hr": reading["river_level_rate_m_per_hr"],
        "upstream_level_m": reading["upstream_level_m"],
        "soil_saturation": reading["soil_saturation"],
        "land_use_forest": 1 if reading["land_use"] == "forest" else 0,
        "land_use_urban_high": 1 if reading["land_use"] == "urban_high" else 0,
        "land_use_urban_low": 1 if reading["land_use"] == "urban_low" else 0,
    }


def compute_flood_risk(reading: dict, flood_model, feature_cols) -> float:
    row = _build_flood_feature_row(reading)
    # Same numbers, ~1 ms instead of ~80 ms - see check_anomaly above.
    fast = fast_inference.fast_flood_model(flood_model, feature_cols)
    if fast is not None:
        X = np.array([[np.nan if row[c] is None else row[c] for c in feature_cols]], dtype=np.float64)
        return fast.predict_proba(X)[0, 1]
    X = pd.DataFrame([row])[feature_cols]
    return flood_model.predict_proba(X)[0, 1]


# UPGRADE: SHAP explainability. shap.TreeExplainer computes, for a SINGLE
# prediction, how much each feature pushed the risk score up or down from
# the model's average baseline output - not just "which features matter
# in general" (that's what permutation_importance already gave you), but
# "why did THIS SPECIFIC reading score HIGH". This is what actually
# answers a judge's "why did the AI flag this one?" question.
_shap_explainer_cache = {}


def explain_flood_risk(
    reading: dict, flood_model, feature_cols, top_n: int = 3
) -> list[dict]:
    """Returns the top_n features that most influenced THIS reading's
    risk score, each as {"feature": name, "value": raw_value,
    "impact": +/-float, "direction": "increased"/"decreased"}.

    Never raises - if SHAP computation fails for any reason (unexpected
    model type, version mismatch, etc.), returns an empty list so a
    missing explanation never blocks an actual alert from being sent."""
    try:
        base_tree_model = get_base_tree_model(flood_model)
        model_id = id(base_tree_model)
        if model_id not in _shap_explainer_cache:
            _shap_explainer_cache[model_id] = shap.TreeExplainer(base_tree_model)
        explainer = _shap_explainer_cache[model_id]

        row = _build_flood_feature_row(reading)
        if any(row[c] is None for c in feature_cols):
            # The original path, unchanged, for a row with a gap.
            X = pd.DataFrame([row])[feature_cols]
            values = explainer(X).values[0]
            row_values = X.iloc[0].tolist()
        else:
            # Step B2: the same SHAP numbers without the one-row DataFrame
            # and the Explanation wrapper (~6 ms of the ~8 ms per reading):
            # explainer(X) is shap_values(X) wrapped, and shap turns a
            # DataFrame into this same float array first.
            row_values = [float(row[c]) for c in feature_cols]
            values = explainer.shap_values(np.array([row_values], dtype=np.float64))[0]
        # Binary classifier - take the "flood" class's contributions
        if values.ndim > 1:
            values = values[:, 1]

        contributions = sorted(
            zip(feature_cols, values, row_values),
            key=lambda t: abs(t[1]),
            reverse=True,
        )[:top_n]

        return [
            {
                "feature": name,
                "value": round(float(val), 4),
                "impact": round(float(impact), 4),
                "direction": "increased" if impact > 0 else "decreased",
            }
            for name, impact, val in contributions
        ]
    except Exception as e:
        print(f"[SHAP] explanation failed, continuing without it: {e}")
        return []


UPSTREAM_BOOST_MAX = 0.15  # max +15% relative closing of the gap to 1.0


def apply_spatial_correlation_boost(risk_score: float, reading: dict) -> float:
    """UPGRADE: cross-node spatial correlation. If this node's configured
    upstream node is ALSO currently rising, that's real independent
    corroborating evidence - water flows downhill, so a rising upstream
    node is a leading indicator for this one, not just noise. Only ever
    boosts (a calm upstream node is not evidence of safety - it just
    means no boost applies), and is capped so it can tip a borderline
    MEDIUM into HIGH but can't manufacture a HIGH out of a genuinely calm
    reading on its own."""
    upstream_rate = reading.get("upstream_rate_m_per_hr") or 0.0
    if upstream_rate <= 0:
        return risk_score
    # Normalize against a 0.5 m/hr upstream rise as "fully triggering" -
    # matches the same rate-of-rise scale already used elsewhere (see
    # backend_server.py's FLOOD_CRITICAL_LEVEL_M / ETA projection).
    boost_strength = min(1.0, upstream_rate / 0.5)
    boosted = risk_score + (1 - risk_score) * UPSTREAM_BOOST_MAX * boost_strength
    return min(1.0, boosted)


def process_reading(
    reading: dict,
    anomaly_model,
    anomaly_scaler,
    flood_model,
    flood_feature_cols,
    rag_collection,
    rag_embedder,
):
    # Faulty fields are dropped BEFORE the anomaly model (B32: Isolation
    # Forest scores every value beyond its training range about the same,
    # so a 14 m "river" could slip through as a flood) - but only those
    # fields; the node's other sensors are still classified.
    clean, sensor_faults = drop_implausible_fields(reading)
    result = _classify_reading(
        clean, anomaly_model, anomaly_scaler, flood_model, flood_feature_cols,
        rag_collection, rag_embedder,
    )
    if sensor_faults:
        if result["status"] != "alert_dispatched":
            # Nothing else on the node is elevated: report the reading as
            # the sensor fault it is (as before), so maintainers see it and
            # the river forecast keeps skipping it.
            reason = fault_reason(reading, sensor_faults)
            return {
                "status": "suppressed",
                "reason": reason,
                "hazard_type": "sensor_fault",
                "risk_score": 0.0,
                "severity": "N/A",
                "sensor_faults": sensor_faults,
                "hazard_scores": result.get("hazard_scores", {}),
            }
        result["sensor_faults"] = sensor_faults
    saturated = saturated_fields(clean)
    if saturated:
        result["saturated_sensors"] = saturated
    return result


def _classify_reading(
    reading: dict,
    anomaly_model,
    anomaly_scaler,
    flood_model,
    flood_feature_cols,
    rag_collection,
    rag_embedder,
):
    """process_reading() minus the physical range check. `reading` must
    already have its faulty fields set to None."""
    # check_anomaly skips the Isolation Forest when any of its five inputs
    # is missing - which includes a field just dropped as faulty.
    is_anomaly, anomaly_score = check_anomaly(reading, anomaly_model, anomaly_scaler)
    hazard_signature = is_hazard_signature(reading)
    # The forest's flag alone no longer throws a reading away when the
    # reading matches this node's own recent readings - see
    # anomaly_flag_stands().
    flag_waived = is_anomaly and not hazard_signature and not anomaly_flag_stands(reading)

    if is_anomaly and not hazard_signature and not flag_waived:
        return {
            "status": "suppressed",
            "reason": "sensor_anomaly",
            "hazard_type": "sensor_fault",
            "risk_score": 0.0,
            "severity": "N/A",
        }

    # UPGRADE: full multi-hazard classification. Every candidate hazard
    # is scored independently (see hazard_classification.py for fire,
    # extreme heat, landslide, air pollution, water quality) - the most
    # severe one becomes this reading's primary hazard_type (for
    # backward compatibility with the DB schema/dashboard/CAP format,
    # which all expect one hazard per reading), while EVERY classifier's
    # result is preserved in "hazard_scores" for full transparency.
    candidates = {}
    severity_rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}

    if (reading.get("gas_ppm") or 0) > GAS_LEAK_THRESHOLD_PPM:
        gas_risk = min(1.0, (reading["gas_ppm"] - 400) / 600)
        candidates["gas leak"] = {
            "risk_score": gas_risk,
            "severity": severity_band(gas_risk),
            "severity_source": "threshold_classifier",  # a fixed ppm threshold, not the ML model (B26)
        }

    # Flood needs a water level; a node without a water sensor (P2.7)
    # simply has no flood candidate.
    flood_explanation = []
    if reading.get("river_level_m") is not None:
        model_probability = float(compute_flood_risk(reading, flood_model, flood_feature_cols))
        flood_risk = apply_spatial_correlation_boost(model_probability, reading)
        flood_severity = severity_band(flood_risk)
        flood_severity_source = "ml_model"
        override_severity = hardware_test_water_severity(reading)
        if (
            override_severity
            and severity_rank[override_severity] > severity_rank[flood_severity]
        ):
            flood_severity = override_severity
            flood_severity_source = "hardware_test_threshold"
        candidates["flood"] = {
            "risk_score": flood_risk,
            "severity": flood_severity,
            "severity_source": flood_severity_source,
            # The model's own output before the upstream boost: the model
            # card's calibration table describes THIS number, so the
            # confidence score looks it up (alert_confidence.py).
            "model_probability": round(model_probability, 4),
        }
        flood_explanation = explain_flood_risk(reading, flood_model, flood_feature_cols)

    for hazard_type, result in classify_all_hazards(reading, bench_mount_for(reading)).items():
        # Keep any extra detail a classifier adds (air pollution's
        # responsible_pollutant) so it reaches hazard_scores / the API.
        # A classifier may name its own severity_source ("weather_forecast"
        # for a forecast-only heavy rain / high wind result).
        candidates[hazard_type] = cap_forecast_candidate({
            "severity_source": "threshold_classifier",
            **result,
        })

    # A river level the node itself doubts (stuck / spike / impossible
    # rate) cannot raise a flood on its own - see EDGE_RIVER_HOLD_CHECKS.
    held_by_edge = hold_doubtful_river_hazards(reading, candidates)

    if not candidates:
        # e.g. a soil-moisture-only node: nothing here can be classified
        return {
            "status": "logged",
            "hazard_type": "none",
            "risk_score": 0.0,
            "severity": "LOW",
            "severity_source": "no_classifiable_sensor",
            "explanation": [],
            "hazard_scores": {},
        }

    # Pick the most severe candidate as primary - ties broken by
    # HAZARD_TIE_PRIORITY (above LOW only), then by risk_score.
    # A hazard this node MEASURED at MEDIUM+ always outranks a forecast-only
    # one: the forecast covers the whole area and every node near it reports
    # it, so letting it win here would hide this node's own measurement for
    # up to a day; the forecast result stays in hazard_scores. Among LOW
    # results a measured one also wins, so a quiet reading's logged
    # hazard_type does not turn into "heavy_rain" just because a forecast
    # was fetched.
    def rank(k):
        c = candidates[k]
        sev = severity_rank[c["severity"]]
        measured = not c.get("forecast_based")
        return (sev > 0 and measured, sev, measured,
                HAZARD_TIE_PRIORITY.get(k, 0) if sev > 0 else 0, c["risk_score"])

    hazard_type = max(candidates, key=rank)
    winner = candidates[hazard_type]
    risk_score = winner["risk_score"]
    severity = winner["severity"]
    severity_source = winner["severity_source"]
    explanation = flood_explanation if hazard_type == "flood" else []
    # What raised a landslide result ("rain" / "tilt" / "both") - lifted
    # to the top level so the map popup, CAP and the WhatsApp gate can
    # tell an early rain WATCH from measured ground movement without
    # digging into hazard_scores.
    trigger = winner.get("trigger")
    extra = {"trigger": trigger} if trigger else {}
    # Lifted for the same reason: the confirmation rule, confidence score,
    # CAP export and the server's siren / WhatsApp logic must all know an
    # alert came from the weather forecast, not from a sensor.
    if winner.get("forecast_based"):
        extra["forecast_based"] = True
        extra["forecast_source"] = winner.get("forecast_source")
    if flag_waived:
        # Kept for audit: the forest called it unusual, the node's own
        # recent readings said it is ordinary for this site.
        extra["anomaly_flag_waived"] = "consistent_with_node_baseline"

    if severity == "LOW" and held_by_edge:
        # Nothing else on the node is elevated: the only "hazard" was the
        # doubted river value - a sensor fault, reported like the
        # Isolation Forest's (status/reason), with the scores kept so an
        # officer auditing it can see what was held and at what severity.
        return {
            "status": "suppressed",
            "reason": "edge_anomaly_" + ",".join(held_by_edge),
            "hazard_type": "sensor_fault",
            "risk_score": 0.0,
            "severity": "N/A",
            "hazard_scores": candidates,
            "edge_suspect": held_by_edge,
        }

    if severity == "LOW":
        return {
            "status": "logged",
            "hazard_type": hazard_type,
            "risk_score": float(risk_score),
            "severity": severity,
            "severity_source": severity_source,
            "explanation": explanation,
            "hazard_scores": candidates,
            **extra,
        }

    message = generate_alert_message(
        hazard_type=hazard_type,
        risk_score=risk_score,
        location=reading["location"],
        collection=rag_collection,
        embedder=rag_embedder,
        use_llm=False,  # flip to True once ANTHROPIC_API_KEY is set
        detail=alert_detail(hazard_type, winner),
    )
    return {
        "status": "alert_dispatched",
        "hazard_type": hazard_type,
        "severity_source": severity_source,
        "risk_score": float(risk_score),
        "severity": severity,
        "message": message,
        "explanation": explanation,
        "hazard_scores": candidates,
        **extra,
    }


def demo_readings():
    return [
        {
            "node_id": "NODE-04",
            "location": "Sector 4, Riverside",
            "land_use": "urban_low",
            "curve_number": 78,
            "rainfall_24h_mm": 12,
            "rainfall_intensity_mm_hr": 2,
            "river_level_m": 1.6,
            "river_level_rate_m_per_hr": 0.01,
            "upstream_level_m": 1.7,
            "soil_saturation": 0.3,
            "temp_c": 27.5,
            "humidity_pct": 58,
            "gas_ppm": 400,
            "flame_reading": 0.01,
        },
        {
            "node_id": "NODE-07",
            "location": "Sector 7, Hillside",
            "land_use": "forest",
            "curve_number": 45,
            "rainfall_24h_mm": 15,
            "rainfall_intensity_mm_hr": 3,
            "river_level_m": 14.2,
            "river_level_rate_m_per_hr": 0.02,
            "upstream_level_m": 1.5,
            "soil_saturation": 0.35,
            "temp_c": 26.8,
            "humidity_pct": 55,
            "gas_ppm": 390,
            "flame_reading": 0.01,
        },
        {
            "node_id": "NODE-04",
            "location": "Sector 4, Riverside",
            "land_use": "urban_low",
            "curve_number": 72,
            "rainfall_24h_mm": 48,
            "rainfall_intensity_mm_hr": 7,
            "river_level_m": 2.2,
            "river_level_rate_m_per_hr": 0.06,
            "upstream_level_m": 2.3,
            "soil_saturation": 0.5,
            "temp_c": 26.5,
            "humidity_pct": 65,
            "gas_ppm": 400,
            "flame_reading": 0.01,
        },
        {
            "node_id": "NODE-04",
            "location": "Sector 4, Riverside",
            "land_use": "urban_high",
            "curve_number": 92,
            "rainfall_24h_mm": 140,
            "rainfall_intensity_mm_hr": 22,
            "river_level_m": 3.8,
            "river_level_rate_m_per_hr": 0.4,
            "upstream_level_m": 4.1,
            "soil_saturation": 0.85,
            "temp_c": 25.5,
            "humidity_pct": 82,
            "gas_ppm": 410,
            "flame_reading": 0.01,
        },
        {
            "node_id": "NODE-INDB",
            "location": "Industrial Zone B",
            "land_use": "urban_high",
            "curve_number": 90,
            "rainfall_24h_mm": 5,
            "rainfall_intensity_mm_hr": 1,
            "river_level_m": 1.5,
            "river_level_rate_m_per_hr": 0.0,
            "upstream_level_m": 1.5,
            "soil_saturation": 0.2,
            "temp_c": 29.0,
            "humidity_pct": 45,
            "gas_ppm": 950,
            "flame_reading": 0.02,
        },
    ]


def main():
    print("Training models...")
    flood_model, flood_feature_cols = train_flood_model()
    anomaly_model, anomaly_scaler = train_anomaly_detector()
    print("Building RAG knowledge base...")
    rag_collection, rag_embedder = build_knowledge_base()

    results = []
    for reading in demo_readings():
        result = process_reading(
            reading,
            anomaly_model,
            anomaly_scaler,
            flood_model,
            flood_feature_cols,
            rag_collection,
            rag_embedder,
        )
        results.append(result)
        print(
            reading["node_id"],
            "->",
            result["status"],
            result.get("hazard_type"),
            result.get("severity"),
        )

    return results


if __name__ == "__main__":
    main()
