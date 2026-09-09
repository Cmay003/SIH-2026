"""
SANJEEVNI - Integrated Pipeline
raw sensor reading -> anomaly filter -> risk model -> RAG alert
Requires flood_risk_model.py, anomaly_detection.py, rag_alert_pipeline.py
in the same folder.
"""

import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split

from flood_risk_model import generate_synthetic_data, scs_cn_runoff
from anomaly_detection import generate_sensor_stream
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
# >>> SET HARDWARE_TEST_MODE = False BEFORE REAL DEPLOYMENT. <<<
# Once you're reading a real river gauge on its true scale, a modest
# 0.6-1.0m reading is often genuinely NOT dangerous - leaving this on
# in production would cause false MEDIUM/HIGH alerts the ML model would
# have correctly called LOW.
HARDWARE_TEST_MODE = True
HARDWARE_TEST_WATER_MEDIUM_M = (
    0.05  # lowered - your ESP32's real range is much smaller than first assumed
)
HARDWARE_TEST_WATER_HIGH_M = (
    0.15  # tune both of these once you confirm your rig's real max
)


def hardware_test_water_severity(reading: dict) -> str | None:
    """Returns 'HIGH', 'MEDIUM', or None based on the RAW water-level
    reading alone - bypassing the ML model's absolute-scale expectation.
    Only meaningful while HARDWARE_TEST_MODE is True; returns None (no
    override) otherwise, so process_reading() falls back to the normal
    ML-computed severity untouched."""
    if not HARDWARE_TEST_MODE:
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
    return (
        reading["gas_ppm"] > GAS_LEAK_THRESHOLD_PPM
        or reading["flame_reading"] > FLAME_THRESHOLD
    )


def train_flood_model():
    df = generate_synthetic_data()
    df = pd.get_dummies(df, columns=["land_use"], drop_first=True)
    feature_cols = [c for c in df.columns if c != "flood_event"]
    X = df[feature_cols]
    y = df["flood_event"]
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )
    model = HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.08, max_depth=4, random_state=42
    )
    model.fit(X_train, y_train)
    return model, feature_cols


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


def check_anomaly(reading: dict, anomaly_model, anomaly_scaler) -> tuple[bool, float]:
    vector = pd.DataFrame([{k: reading[k] for k in ANOMALY_FEATURES}])
    scaled = anomaly_scaler.transform(vector)
    pred = anomaly_model.predict(scaled)[0]
    score = -anomaly_model.score_samples(scaled)[0]
    return pred == -1, score


def compute_flood_risk(reading: dict, flood_model, feature_cols) -> float:
    runoff_mm = scs_cn_runoff(
        np.array([reading["rainfall_24h_mm"]]), np.array([reading["curve_number"]])
    )[0]

    row = {
        "curve_number": reading["curve_number"],
        "rainfall_24h_mm": reading["rainfall_24h_mm"],
        "rainfall_intensity_mm_hr": reading["rainfall_intensity_mm_hr"],
        # .get(...) with a fallback: older callers (demo_readings, any code
        # written before the weather API was added) won't have this key,
        # and even the live backend can return None here if the weather
        # API was unreachable and there's no cached value yet. Either way,
        # falling back to 0.0 means "no forecast signal available" rather
        # than crashing the whole risk computation.
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
    X = pd.DataFrame([row])[feature_cols]
    return flood_model.predict_proba(X)[0, 1]


def process_reading(
    reading: dict,
    anomaly_model,
    anomaly_scaler,
    flood_model,
    flood_feature_cols,
    rag_collection,
    rag_embedder,
):
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

    if reading["gas_ppm"] > GAS_LEAK_THRESHOLD_PPM:
        hazard_type = "gas leak"
        risk_score = min(1.0, (reading["gas_ppm"] - 400) / 600)
    else:
        hazard_type = "flood"
        risk_score = compute_flood_risk(reading, flood_model, flood_feature_cols)

    severity = severity_band(risk_score)
    severity_source = "ml_model"

    # Apply the hardware bench-test override ONLY for flood-type hazards -
    # never overrides the gas-leak path, which already has its own
    # correctly-scaled threshold above. Only escalates, never downgrades:
    # if the ML model somehow already says HIGH, a MEDIUM-level override
    # doesn't quietly water that down.
    if hazard_type == "flood":
        override_severity = hardware_test_water_severity(reading)
        severity_rank = {"LOW": 0, "MEDIUM": 1, "HIGH": 2, "CRITICAL": 3}
        if (
            override_severity
            and severity_rank[override_severity] > severity_rank[severity]
        ):
            severity = override_severity
            severity_source = "hardware_test_threshold"

    if severity == "LOW":
        return {
            "status": "logged",
            "hazard_type": hazard_type,
            "risk_score": float(risk_score),
            "severity": severity,
            "severity_source": severity_source,
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
