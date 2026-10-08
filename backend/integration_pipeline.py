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

from flood_risk_model import generate_synthetic_data, scs_cn_runoff
from anomaly_detection import generate_sensor_stream
from hazard_classification import classify_all_hazards
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

# Values no working sensor can produce. A reading outside these is a sensor
# fault, full stop - checked BEFORE the anomaly model, because Isolation
# Forest scores every value beyond its training range about the same, so a
# 14 m "river" could slip through as a flood (B32).
PHYSICAL_LIMITS = {
    "river_level_m": (0.0, float(os.environ.get("SANJEEVNI_MAX_RIVER_LEVEL_M", "10"))),
    "temp_c": (-40.0, 70.0),
    "humidity_pct": (0.0, 100.0),
    "gas_ppm": (0.0, 50000.0),
    "flame_reading": (0.0, 1.0),
}


def physically_implausible(reading: dict) -> str | None:
    """Name of the first field outside what a working sensor can report."""
    for field, (low, high) in PHYSICAL_LIMITS.items():
        value = reading.get(field)
        if value is not None and not (low <= value <= high):
            return field
    return None


# A flood announces itself physically: the water rises fast WHILE it rains
# hard or the upstream node rises too. Such a reading must reach the flood
# model even if the anomaly model has never seen values like it (B15).
FLOOD_SIGNATURE_RATE_M_PER_HR = 0.2
FLOOD_SIGNATURE_RAIN_MM_HR = 5.0


def is_flood_signature(reading: dict) -> bool:
    rising = (reading.get("river_level_rate_m_per_hr") or 0) >= FLOOD_SIGNATURE_RATE_M_PER_HR
    corroborated = (
        (reading.get("rainfall_intensity_mm_hr") or 0) >= FLOOD_SIGNATURE_RAIN_MM_HR
        or (reading.get("upstream_rate_m_per_hr") or 0) >= FLOOD_SIGNATURE_RATE_M_PER_HR
    )
    return rising and corroborated


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

    for result in classify_all_hazards(reading).values():
        if result["severity"] in ("MEDIUM", "HIGH", "CRITICAL"):
            return True
    return False


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


def check_anomaly(reading: dict, anomaly_model, anomaly_scaler) -> tuple[bool, float | None]:
    # The Isolation Forest was trained on all five core sensors together.
    # A modular node without one of them (P2.7) can't be scored, so it is
    # skipped - the physical range checks still run on what it does send.
    if any(reading.get(k) is None for k in ANOMALY_FEATURES):
        return False, None
    vector = pd.DataFrame([{k: reading[k] for k in ANOMALY_FEATURES}])
    scaled = anomaly_scaler.transform(vector)
    pred = anomaly_model.predict(scaled)[0]
    score = -anomaly_model.score_samples(scaled)[0]
    return pred == -1, score


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
        X = pd.DataFrame([row])[feature_cols]

        shap_values = explainer(X)
        # Binary classifier - take the "flood" class's contributions
        values = shap_values.values[0]
        if values.ndim > 1:
            values = values[:, 1]

        contributions = sorted(
            zip(feature_cols, values, X.iloc[0].tolist()),
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
    impossible_field = physically_implausible(reading)
    if impossible_field:
        return {
            "status": "suppressed",
            "reason": f"physically_impossible_{impossible_field}",
            "hazard_type": "sensor_fault",
            "risk_score": 0.0,
            "severity": "N/A",
        }

    is_anomaly, anomaly_score = check_anomaly(reading, anomaly_model, anomaly_scaler)
    hazard_signature = is_hazard_signature(reading)

    if is_anomaly and not hazard_signature:
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
        flood_risk = compute_flood_risk(reading, flood_model, flood_feature_cols)
        flood_risk = apply_spatial_correlation_boost(flood_risk, reading)
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
        }
        flood_explanation = explain_flood_risk(reading, flood_model, flood_feature_cols)

    for hazard_type, result in classify_all_hazards(reading).items():
        candidates[hazard_type] = {
            "risk_score": result["risk_score"],
            "severity": result["severity"],
            "severity_source": "threshold_classifier",
        }

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

    # Pick the most severe candidate as primary - ties broken by risk_score
    hazard_type = max(
        candidates,
        key=lambda k: (
            severity_rank[candidates[k]["severity"]],
            candidates[k]["risk_score"],
        ),
    )
    winner = candidates[hazard_type]
    risk_score = winner["risk_score"]
    severity = winner["severity"]
    severity_source = winner["severity_source"]
    explanation = flood_explanation if hazard_type == "flood" else []

    if severity == "LOW":
        return {
            "status": "logged",
            "hazard_type": hazard_type,
            "risk_score": float(risk_score),
            "severity": severity,
            "severity_source": severity_source,
            "explanation": explanation,
            "hazard_scores": candidates,
        }

    message = generate_alert_message(
        hazard_type=hazard_type,
        risk_score=risk_score,
        location=reading["location"],
        collection=rag_collection,
        embedder=rag_embedder,
        use_llm=False,  # flip to True once ANTHROPIC_API_KEY is set
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
