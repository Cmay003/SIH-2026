"""
SANJEEVNI - Train models from real historical data.

Put your data in:
  data/flood_history.csv    (see data/flood_history_template.csv for columns)
  data/anomaly_history.csv  (see data/anomaly_history_template.csv for columns)

If a file is missing, that model trains on synthetic data instead (same as
before) so the pipeline still runs.

Run: python train_models.py
"""

import os
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import train_test_split
from sklearn.metrics import classification_report, roc_auc_score, brier_score_loss

from flood_risk_model import generate_synthetic_data, scs_cn_runoff
from anomaly_detection import generate_sensor_stream

DATA_DIR = "data"
MODELS_DIR = "models"
os.makedirs(MODELS_DIR, exist_ok=True)

FLOOD_CSV = os.path.join(DATA_DIR, "flood_history.csv")
ANOMALY_CSV = os.path.join(DATA_DIR, "anomaly_history.csv")

# Inputs read from a real flood_history.csv. Anything else in the file
# (export_readings_to_csv.py adds id/node_id/timestamp/... to help with
# labelling) is ignored instead of being trained on as a "feature".
FLOOD_INPUT_COLS = [
    "land_use",
    "curve_number",
    "rainfall_24h_mm",
    "rainfall_intensity_mm_hr",
    "forecast_rainfall_6h_mm",
    "river_level_m",
    "river_level_rate_m_per_hr",
    "upstream_level_m",
    "soil_saturation",
]
# Fixed category list so one-hot columns are always land_use_forest /
# _urban_high / _urban_low (what integration_pipeline.py builds at
# prediction time), even if the real data has no "agricultural" rows -
# otherwise drop_first dropped a different category and prediction failed.
LAND_USE_CATEGORIES = ["agricultural", "forest", "urban_high", "urban_low"]

ANOMALY_FEATURES = [
    "river_level_m",
    "temp_c",
    "humidity_pct",
    "gas_ppm",
    "flame_reading",
]


def train_flood_model():
    if os.path.exists(FLOOD_CSV):
        print(f"[flood] Training on real data: {FLOOD_CSV}")
        df = pd.read_csv(FLOOD_CSV)
        if "forecast_rainfall_6h_mm" not in df.columns:
            # Real-data CSVs exported before the weather API was added won't
            # have this column yet - default to 0 (no forecast signal)
            # rather than failing, so old exports still train fine.
            print(
                "[flood] 'forecast_rainfall_6h_mm' not in flood_history.csv - "
                "defaulting to 0 for all rows. Re-export once forecast data "
                "has been logged to actually use this feature."
            )
            df["forecast_rainfall_6h_mm"] = 0.0
        # Forecast is legitimately missing whenever the weather API was
        # unreachable - 0 means "no forecast signal", same as at prediction time.
        df["forecast_rainfall_6h_mm"] = df["forecast_rainfall_6h_mm"].fillna(0.0)

        missing = [c for c in FLOOD_INPUT_COLS + ["flood_event"] if c not in df.columns]
        if missing:
            raise SystemExit(
                f"[flood] {FLOOD_CSV} is missing columns {missing} - re-export it with "
                "export_readings_to_csv.py"
            )
        df = df[FLOOD_INPUT_COLS + ["flood_event"]].dropna()
        unknown_land_use = set(df["land_use"]) - set(LAND_USE_CATEGORIES)
        if unknown_land_use:
            raise SystemExit(
                f"[flood] unknown land_use values {unknown_land_use}; "
                f"expected one of {LAND_USE_CATEGORIES}"
            )
        if df.empty:
            raise SystemExit(
                f"[flood] no labelled rows in {FLOOD_CSV} - fill in flood_event (0/1) first"
            )
        df["flood_event"] = df["flood_event"].astype(int)
        df["land_use"] = pd.Categorical(df["land_use"], categories=LAND_USE_CATEGORIES)
        df["runoff_mm"] = scs_cn_runoff(
            df["rainfall_24h_mm"].to_numpy(), df["curve_number"].to_numpy()
        )
        print(f"[flood] {len(df)} labelled rows, {int(df['flood_event'].sum())} flood events")
    else:
        print(
            "[flood] No data/flood_history.csv found - training on synthetic data instead"
        )
        df = generate_synthetic_data()

    df = pd.get_dummies(df, columns=["land_use"], drop_first=True)
    feature_cols = [c for c in df.columns if c != "flood_event"]
    X = df[feature_cols]
    y = df["flood_event"]

    # A one-class model only outputs one probability column, and the
    # backend's predict_proba(X)[0, 1] then crashes on EVERY reading.
    # Refuse before anything in models/ is overwritten. Needs a few
    # examples of each class for the train/test split + calibration CV.
    class_counts = y.value_counts()
    if len(class_counts) < 2 or class_counts.min() < 4:
        raise SystemExit(
            f"[flood] need at least 4 rows of BOTH flood_event=0 and =1 to train, got "
            f"{class_counts.to_dict()} - label more data. Existing model left unchanged."
        )

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if y.nunique() > 1 else None
    )

    # UPGRADE: calibrated probabilities (CalibratedClassifierCV). Raw
    # gradient-boosting outputs are a SCORE, not a true probability - a
    # model can say "0.9" for a class it's only actually right about 60%
    # of the time. Calibration (Platt/sigmoid scaling here, via internal
    # cross-validation) adjusts the output so a 0.7 risk score actually
    # corresponds to roughly 70% real-world frequency of that outcome in
    # the training distribution. sigmoid (not isotonic) is used because
    # our dataset sizes (hundreds-thousands of rows) are on the smaller
    # side where isotonic calibration tends to overfit.
    base_model = HistGradientBoostingClassifier(
        max_iter=200, learning_rate=0.08, max_depth=4, random_state=42
    )
    calibration_cv = (
        min(5, y_train.value_counts().min()) if y_train.nunique() > 1 else 2
    )
    model = CalibratedClassifierCV(
        base_model, method="sigmoid", cv=max(2, calibration_cv)
    )
    model.fit(X_train, y_train)

    if y_test.nunique() > 1:
        y_proba = model.predict_proba(X_test)[:, 1]
        print(
            classification_report(
                y_test, model.predict(X_test), target_names=["No Flood", "Flood"]
            )
        )
        print(f"ROC-AUC: {roc_auc_score(y_test, y_proba):.3f}")
        # Brier score - lower is better-calibrated (0 = perfect). This is
        # the metric calibration is actually optimizing for, distinct
        # from ROC-AUC (which only cares about ranking, not the actual
        # probability values being meaningful).
        print(
            f"Brier score (calibration quality, lower=better): {brier_score_loss(y_test, y_proba):.4f}"
        )

    joblib.dump(model, os.path.join(MODELS_DIR, "flood_model.joblib"))
    joblib.dump(feature_cols, os.path.join(MODELS_DIR, "flood_feature_cols.joblib"))
    print(f"[flood] Saved model + {len(feature_cols)} feature columns to {MODELS_DIR}/")
    return model, feature_cols


def train_anomaly_detector():
    if os.path.exists(ANOMALY_CSV):
        print(f"[anomaly] Training on real data: {ANOMALY_CSV}")
        df = pd.read_csv(ANOMALY_CSV).dropna(subset=ANOMALY_FEATURES)
        # An exported-but-unlabelled is_anomaly column is all blank (NaN):
        # treat it as "no labels" instead of computing contamination = NaN.
        if "is_anomaly" in df.columns and df["is_anomaly"].isna().all():
            df = df.drop(columns=["is_anomaly"])
        elif "is_anomaly" in df.columns:
            df = df.dropna(subset=["is_anomaly"])
        labelled_rate = df["is_anomaly"].mean() if "is_anomaly" in df.columns else 0.0
        # IsolationForest needs 0 < contamination <= 0.5
        contamination = labelled_rate if 0 < labelled_rate <= 0.5 else 0.02
    else:
        print(
            "[anomaly] No data/anomaly_history.csv found - training on synthetic data instead"
        )
        df = generate_sensor_stream()
        contamination = df["is_anomaly"].mean()

    X = df[ANOMALY_FEATURES]
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    model = IsolationForest(
        n_estimators=200, contamination=contamination, random_state=42
    )
    model.fit(X_scaled)

    if "is_anomaly" in df.columns:
        y_true = df["is_anomaly"]
        y_pred = (model.predict(X_scaled) == -1).astype(int)
        tp = ((y_pred == 1) & (y_true == 1)).sum()
        fp = ((y_pred == 1) & (y_true == 0)).sum()
        fn = ((y_pred == 0) & (y_true == 1)).sum()
        precision = tp / (tp + fp) if (tp + fp) else 0
        recall = tp / (tp + fn) if (tp + fn) else 0
        print(f"[anomaly] Precision: {precision:.3f}  Recall: {recall:.3f}")

    joblib.dump(model, os.path.join(MODELS_DIR, "anomaly_model.joblib"))
    joblib.dump(scaler, os.path.join(MODELS_DIR, "anomaly_scaler.joblib"))
    print(f"[anomaly] Saved model + scaler to {MODELS_DIR}/")
    return model, scaler


if __name__ == "__main__":
    train_flood_model()
    train_anomaly_detector()
    print("\nDone. Restart backend_server.py to load these models.")
