r"""
SANJEEVNI - Train models from real historical data.

Put your data in:
  data/flood_history.csv    (see data/flood_history_template.csv for columns)
  data/anomaly_history.csv  (see data/anomaly_history_template.csv for columns)

If a file is missing, that model trains on synthetic data instead (same as
before) so the pipeline still runs.

Real flood data is evaluated and calibrated on whole groups of rows (an
optional event_id column, else node_id + UTC day from the export), never on
a random row split - see flood_row_groups().

Run (from the project folder): venv\Scripts\python.exe ml\train_models.py
"""

import os
import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import HistGradientBoostingClassifier, IsolationForest
from sklearn.calibration import CalibratedClassifierCV
from sklearn.preprocessing import StandardScaler
from sklearn.model_selection import StratifiedGroupKFold, train_test_split
from sklearn.metrics import classification_report, roc_auc_score, brier_score_loss, f1_score
import os as _os
import sys as _sys

# backend/ holds the shared modules + paths.py (file locations)
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "backend"))
import paths  # noqa: E402

from flood_risk_model import generate_synthetic_data, scs_cn_runoff
from anomaly_detection import generate_sensor_stream

DATA_DIR = paths.DATA_DIR
MODELS_DIR = paths.MODELS_DIR
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

# --- Grouped evaluation --------------------------------------------------
# Real readings arrive every few seconds, and one flood spans many almost
# identical consecutive rows. A random row-level split put a near-twin of
# every test row (same node, same event, ~9 s away) in the training set, so
# ROC-AUC / F1 / Brier measured memorisation, and the calibration folds had
# the same leak - making the deployed probabilities (which set the
# LOW..CRITICAL bands) overconfident. Rows are therefore split by GROUP: a
# whole group is either all-train or all-test.
#
# Group = the flood_history.csv "event_id" column where someone has
# labelled one (best: one id per real flood / non-flood episode), else
# node_id + UTC day. A UTC day rolls over at 05:30 IST, so a monsoon-night
# event usually stays inside one group. Residual leak this does NOT remove:
# an upstream and a downstream node see the same flood on the same day (and
# the downstream row carries the upstream level as a feature), so two
# groups can still be correlated - label event_id to close that.
#
# The synthetic generator draws every row independently, so it has no
# groups and keeps the plain stratified row split.
MIN_GROUPS_PER_CLASS = 3  # 1 for the test set + 2 for the calibration folds
HOLDOUT_FOLDS = 5  # one fold of 5 = the ~20% test set


def flood_row_groups(df: pd.DataFrame):
    """Group key per row (same index as df), or None when the CSV has
    nothing to group by (the hand-made template has no node_id/timestamp)."""
    node_day = None
    if "node_id" in df.columns and "timestamp" in df.columns:
        ts = pd.to_datetime(df["timestamp"], utc=True, errors="coerce", format="ISO8601")
        # An unparseable time gets one per-node bucket rather than being
        # spread across days.
        day = ts.dt.strftime("%Y-%m-%d").fillna("unknown-day")
        node_day = df["node_id"].astype(str) + "_" + day
    if "event_id" in df.columns:
        event = df["event_id"].astype("string").str.strip()
        labelled = event.notna() & (event != "")
        if labelled.any():
            if node_day is not None:
                fallback = node_day
            else:
                fallback = pd.Series("row_" + df.index.astype(str), index=df.index)
            return ("event_" + event).where(labelled, fallback).astype(str)
    return node_day


def _class_groups(y: pd.Series, groups: pd.Series, cls: int) -> int:
    return groups[y == cls].nunique()


def grouped_holdout(y: pd.Series, groups: pd.Series, seed: int = 42):
    """(train_idx, test_idx) positions for a ~20% test set made of whole
    groups, with both classes on both sides. Raises SystemExit when the
    data cannot give an honest held-out score."""
    for cls in (0, 1):
        n = _class_groups(y, groups, cls)
        if n < MIN_GROUPS_PER_CLASS:
            raise SystemExit(
                f"[flood] flood_event={cls} occurs in only {n} group(s) (node+day or "
                f"event_id); need at least {MIN_GROUPS_PER_CLASS} so a whole group can be "
                "held out for testing and two remain for calibration. Rows of one event "
                "are near-duplicates, so a row-level split would only measure "
                "memorisation. Collect/label more events. Existing model left unchanged."
            )
    n_splits = min(HOLDOUT_FOLDS, groups.nunique())
    splitter = StratifiedGroupKFold(n_splits=n_splits, shuffle=True, random_state=seed)
    # The first fold with both classes in train AND test. Choosing among
    # folds only on class presence (never on a score) keeps it unbiased.
    for train_idx, test_idx in splitter.split(np.zeros(len(y)), y, groups):
        if y.iloc[test_idx].nunique() == 2 and y.iloc[train_idx].nunique() == 2:
            return train_idx, test_idx
    raise SystemExit(
        "[flood] no grouped train/test split has both classes on both sides - "
        "label more events. Existing model left unchanged."
    )


def grouped_calibration_folds(y_train: pd.Series, groups_train: pd.Series, max_k: int = 5):
    """Group-aware CV folds for CalibratedClassifierCV, as a precomputed
    list: passing groups= to fit() needs sklearn metadata routing switched
    on, and a splitter object without it does not see the groups. Every
    fold's training part must contain both classes or the base model
    cannot be fitted, so k is lowered until that holds."""
    k = min(
        max_k,
        _class_groups(y_train, groups_train, 0),
        _class_groups(y_train, groups_train, 1),
    )
    while k >= 2:
        splitter = StratifiedGroupKFold(n_splits=k, shuffle=True, random_state=42)
        folds = list(splitter.split(np.zeros(len(y_train)), y_train, groups_train))
        if all(y_train.iloc[tr].nunique() == 2 for tr, _ in folds):
            return folds
        k -= 1
    raise SystemExit(
        "[flood] cannot build group-aware calibration folds with both classes in "
        "every training fold - label more events. Existing model left unchanged."
    )


def load_flood_frame():
    """(df, groups, source): the labelled rows train_flood_model() learns
    from, before one-hot encoding. groups is the per-row group key (or
    None), source is "real" or "synthetic". Shared with
    ml/evaluate_models.py so the model card scores exactly the rows this
    script held out, never a re-derived (and possibly overlapping) split."""
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
        # Group key from the context columns BEFORE they are dropped,
        # re-aligned to the surviving rows by index.
        all_groups = flood_row_groups(df)
        df = df[FLOOD_INPUT_COLS + ["flood_event"]].dropna()
        groups = all_groups.loc[df.index] if all_groups is not None else None
        if groups is None:
            print(
                "[flood] !!! No node_id/timestamp/event_id columns - falling back to a\n"
                "        !!! random ROW split. If these rows are consecutive readings, the\n"
                "        !!! scores below are optimistic (near-duplicates on both sides).\n"
                "        !!! Export with export_readings_to_csv.py for grouped evaluation."
            )
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
        source = "real"
    else:
        print(
            "[flood] No data/flood_history.csv found - training on SYNTHETIC data.\n"
            "        !!! The scores below only show the pipeline works. Their labels\n"
            "        !!! are computed from the same features, so they are NOT evidence\n"
            "        !!! of real-world accuracy - do not quote them as such (B13)."
        )
        df = generate_synthetic_data()
        groups = None  # independent rows - see flood_row_groups()
        source = "synthetic"
    return df, groups, source


def split_flood_rows(X: pd.DataFrame, y: pd.Series, groups):
    """(X_train, X_test, y_train, y_test, groups_train) - whole groups when
    groups is given, else the plain stratified 80/20 row split (synthetic
    rows are independent draws, so that one does not leak)."""
    if groups is not None:
        groups = groups.reset_index(drop=True)
        X, y = X.reset_index(drop=True), y.reset_index(drop=True)
        train_idx, test_idx = grouped_holdout(y, groups)
        print(
            f"[flood] grouped split: {groups.nunique()} groups; test = "
            f"{groups.iloc[test_idx].nunique()} whole groups / {len(test_idx)} rows, "
            "none of which shares a group with a training row"
        )
        return (
            X.iloc[train_idx], X.iloc[test_idx],
            y.iloc[train_idx], y.iloc[test_idx],
            groups.iloc[train_idx],
        )
    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y if y.nunique() > 1 else None
    )
    return X_train, X_test, y_train, y_test, None


def train_flood_model():
    df, groups, _source = load_flood_frame()

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

    X_train, X_test, y_train, y_test, groups_train = split_flood_rows(X, y, groups)

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
    if groups is not None:
        # The sigmoid is fitted on out-of-fold predictions; with row-level
        # folds those "unseen" rows had twins in-fold, so the calibrator
        # learned overconfident probabilities. Whole groups per fold.
        calibration_cv = grouped_calibration_folds(y_train, groups_train)
    else:
        calibration_cv = max(
            2, min(5, y_train.value_counts().min()) if y_train.nunique() > 1 else 2
        )
    model = CalibratedClassifierCV(base_model, method="sigmoid", cv=calibration_cv)
    model.fit(X_train, y_train)

    if y_test.nunique() > 1:
        y_proba = model.predict_proba(X_test)[:, 1]
        print(
            classification_report(
                y_test, model.predict(X_test), target_names=["No Flood", "Flood"]
            )
        )
        print(f"ROC-AUC: {roc_auc_score(y_test, y_proba):.3f}")
        # Baseline every score must beat to mean anything: "flood if the
        # river is above a level", threshold picked on the TRAINING set (B13)
        # - the same grouped split, so the baseline gets no leak the model lacks.
        levels_train, levels_test = X_train["river_level_m"], X_test["river_level_m"]
        candidates = sorted(set(levels_train.round(2)))
        best_t = max(candidates, key=lambda t: f1_score(y_train, levels_train >= t, zero_division=0))
        print(
            f"Baseline 'river_level_m >= {best_t:.2f} m': F1 {f1_score(y_test, levels_test >= best_t, zero_division=0):.3f}, "
            f"ROC-AUC {roc_auc_score(y_test, levels_test):.3f}   vs model F1 "
            f"{f1_score(y_test, model.predict(X_test), zero_division=0):.3f}"
        )
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
