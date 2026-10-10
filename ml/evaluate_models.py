r"""
SANJEEVNI - honest evaluation report ("model card") for the five models.

Writes var/models/model_card.json (paths.MODEL_CARD_PATH). The backend
serves it to admins at GET /api/model-card.

Covers the flood-risk model, the Isolation Forest anomaly filter, the two
on-device edge networks (main, and lite for reduced / deep-sleep sensor
kits) and the LSTM river forecaster. For each one it
records what it is for, what it was trained on, held-out metrics, the
baseline it has to beat, the false-alarm rate, calibration and known
limitations.

Why a separate script: train_models.py printed its scores to the console
only, scored the Isolation Forest on the rows it was fitted on, and the
"98.28 % edge accuracy" only measures how well the network copies the
threshold rule that made its labels. Judges and officers asking "evaluated
on what, against what?" need one file that answers that honestly.

Held-out data, per model (none of it was seen in training):
  flood   - synthetic: a fresh draw from generate_synthetic_data() with its
            own seed (rows are independent draws, so no near-duplicates);
            real data/flood_history.csv: the SAME whole-group test split
            train_models.py held out (node + UTC day / event_id).
  anomaly - a fresh synthetic sensor stream (own seed). The stream the
            model was fitted on is rebuilt too, only to set the old
            in-sample score next to the held-out one.
  edge    - a fresh draw from make_edge_dataset.generate() (own seed), run
            through the actual int8 .tflite the firmware embeds.
  edge_lite - the same with make_edge_dataset.generate_lite() (random sensor
            kits; own seed).
  lstm    - fresh synthetic catchments (own seed): different rivers from
            the 30 it was trained on.
Every figure is from SYNTHETIC data unless the card says REAL. They show
the pipeline works; they are not evidence of real-world accuracy (B13).

Run (from the project folder):
  venv\Scripts\python.exe ml\evaluate_models.py [--seed 2026] [--out file]
The same seed and the same model files give a byte-identical JSON (no
wall-clock time is written). The edge sections need tensorflow
(requirements-training.txt); without it those entries are "not_available".
"""

import argparse
import hashlib
import json
import math
import os
# Windows 11 Smart App Control blocks wrapt's unsigned compiled helper
# (_wrappers.*.pyd, pulled in by TensorFlow / ChromaDB) with "Part of this
# app has been blocked". wrapt's pure-Python fallback behaves the same.
# Must run before those imports. To keep the compiled helper, set
# WRAPT_DISABLE_EXTENSIONS to an EMPTY value (wrapt treats "0" as set).
os.environ.setdefault("WRAPT_DISABLE_EXTENSIONS", "1")
import re
import sys
import warnings
from datetime import datetime, timezone

import joblib
import numpy as np
import pandas as pd
from sklearn.metrics import (
    average_precision_score,
    brier_score_loss,
    f1_score,
    roc_auc_score,
)
from sklearn.preprocessing import StandardScaler

_ML_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(_ML_DIR), "backend"))
sys.path.insert(0, _ML_DIR)
import paths  # noqa: E402

import river_forecast as rf  # noqa: E402
import train_models as tm  # noqa: E402
import train_river_forecast as trf  # noqa: E402
import make_edge_dataset as med  # noqa: E402
from anomaly_detection import generate_sensor_stream  # noqa: E402
from flood_risk_model import generate_synthetic_data  # noqa: E402
from integration_pipeline import ANOMALY_FEATURES, implausible_fields  # noqa: E402
from rag_alert_pipeline import severity_band  # noqa: E402

SCHEMA_VERSION = 1
DEFAULT_SEED = 2026
DECIMALS = 4  # rounding keeps the file stable and readable

# Risk cut-offs of the live severity bands (rag_alert_pipeline.severity_band:
# strictly ABOVE the value). MEDIUM+ is what raises an alert (pending
# confirmation, hazard_confirmation.ELEVATED_SEVERITIES), so it is the
# headline operating point. check_operating_points() fails loudly if the
# bands move without this table.
OPERATING_POINTS = (("MEDIUM", 0.4), ("HIGH", 0.7), ("CRITICAL", 0.9))
ALERT_BAND = "MEDIUM"

FLOOD_TEST_ROWS = 6000  # same size as the synthetic training draw
ANOMALY_TRAIN_SEED = 7  # anomaly_detection.RNG - rebuilds the fitted stream
EDGE_TEST_ROWS = med.N_SAMPLES
LITE_TEST_ROWS = med.LITE_N_SAMPLES
LSTM_TEST_CATCHMENTS = trf.TEST_CATCHMENTS
LSTM_DAYS = trf.DAYS_PER_CATCHMENT
EDGE_CLASSES = ["NORMAL", "WATCH", "URGENT"]
RELIABILITY_BINS = 10

SYNTHETIC_BANNER = (
    "SYNTHETIC DATA: every model on this card was trained and tested on "
    "computer-generated data. These numbers show the software pipeline "
    "works; they are NOT evidence of accuracy on real floods, sensor faults "
    "or rivers. Do not quote them as field performance."
)
MIXED_BANNER = (
    "PARTLY SYNTHETIC: some models below were trained or tested on "
    "computer-generated data - check each model's provenance before quoting "
    "a number. Synthetic scores are not evidence of real-world accuracy."
)
REAL_BANNER = (
    "Evaluated on logged project data. Check each model's test size and "
    "limitations: a small number of real events gives very noisy scores."
)


# --- small, testable helpers -------------------------------------------------

def _num(x):
    """JSON-safe rounded float (NaN/inf -> None: JSON has no NaN, and the
    browser's JSON.parse rejects it)."""
    if x is None:
        return None
    x = float(x)
    if not math.isfinite(x):
        return None
    return round(x, DECIMALS)


def _pct(x):
    return "n/a" if x is None else f"{100 * x:.1f}%"


def _div(a, b):
    return a / b if b else None


def check_operating_points():
    """OPERATING_POINTS must match the live severity_band() edges."""
    for band, cut in OPERATING_POINTS:
        if severity_band(cut) == band or severity_band(float(np.nextafter(cut, 1.0))) != band:
            raise SystemExit(
                f"severity_band() no longer switches to {band} just above {cut} - "
                "update OPERATING_POINTS in evaluate_models.py"
            )


def binary_counts(y_true, y_pred) -> dict:
    y_true = np.asarray(y_true).astype(bool)
    y_pred = np.asarray(y_pred).astype(bool)
    return {
        "tp": int((y_pred & y_true).sum()),
        "fp": int((y_pred & ~y_true).sum()),
        "fn": int((~y_pred & y_true).sum()),
        "tn": int((~y_pred & ~y_true).sum()),
    }


def binary_rates(c: dict) -> dict:
    """Rates from counts. false_alarm_rate = share of truly calm cases that
    were flagged (FP / negatives); false_alert_share = share of raised
    flags that were wrong (FP / flags) - the one the public feels, and the
    one that worsens as real hazards get rarer."""
    tp, fp, fn, tn = c["tp"], c["fp"], c["fn"], c["tn"]
    precision, recall = _div(tp, tp + fp), _div(tp, tp + fn)
    f1 = _div(2 * tp, 2 * tp + fp + fn)
    return {
        "precision": _num(precision),
        "recall": _num(recall),
        "f1": _num(f1),
        "false_alarm_rate": _num(_div(fp, fp + tn)),
        "miss_rate": _num(_div(fn, fn + tp)),
        "false_alert_share": _num(_div(fp, fp + tp)),
    }


def reliability(y_true, prob, bins: int = RELIABILITY_BINS):
    """(bins, ECE). Equal-width bins on [0, 1]; ECE is the count-weighted
    gap between mean predicted probability and observed frequency."""
    y_true = np.asarray(y_true, dtype=float)
    prob = np.asarray(prob, dtype=float)
    edges = np.linspace(0.0, 1.0, bins + 1)
    # right-closed last bin so p == 1.0 is counted
    idx = np.clip(np.digitize(prob, edges[1:-1], right=False), 0, bins - 1)
    out, ece = [], 0.0
    for b in range(bins):
        mask = idx == b
        n = int(mask.sum())
        mean_p = float(prob[mask].mean()) if n else None
        observed = float(y_true[mask].mean()) if n else None
        if n:
            ece += n / len(prob) * abs(mean_p - observed)
        out.append({
            "bin_lower": _num(edges[b]),
            "bin_upper": _num(edges[b + 1]),
            "count": n,
            "mean_predicted": _num(mean_p),
            "observed_rate": _num(observed),
        })
    return out, _num(ece) if len(prob) else None


def confusion(title: str, labels: list, matrix) -> dict:
    """Rows = actual class, columns = predicted class, in `labels` order."""
    return {"title": title, "labels": list(labels), "matrix": [[int(v) for v in row] for row in matrix]}


def binary_confusion(title: str, labels: list, c: dict) -> dict:
    return confusion(title, labels, [[c["tn"], c["fp"]], [c["fn"], c["tp"]]])


def metric(key, label, value, baseline=None, higher_is_better=True) -> dict:
    return {
        "key": key,
        "label": label,
        "value": _num(value),
        "baseline": _num(baseline),
        "higher_is_better": bool(higher_is_better),
    }


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _mtime_iso(path):
    return datetime.fromtimestamp(int(os.path.getmtime(path)), tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _display_path(path):
    """var/... relative path - the card goes to a web page, so it should
    not leak the server's absolute folder layout."""
    try:
        rel = os.path.relpath(path, paths.VAR_DIR)
    except ValueError:  # Windows: a different drive than var/
        return os.path.basename(path)
    if rel.startswith(".."):
        return os.path.basename(path)
    return "var/" + rel.replace(os.sep, "/")


def artifact_info(path):
    if not os.path.exists(path):
        return {"path": _display_path(path), "sha256": None, "modified_at": None}
    return {"path": _display_path(path), "sha256": _sha256(path), "modified_at": _mtime_iso(path)}


def new_entry(model_id, name, purpose, runs_where, artifact_path) -> dict:
    """Every entry has every key (the web page relies on that); a model
    that cannot be evaluated keeps nulls/empty lists and says why."""
    return {
        "id": model_id,
        "name": name,
        "status": "not_available",
        "status_reason": None,
        "purpose": purpose,
        "runs_where": runs_where,
        "artifact": artifact_info(artifact_path),
        "training_data": {"provenance": None, "generator": None, "size": None, "description": None},
        "evaluation": {
            "provenance": None,
            "split": None,
            "split_kind": None,
            "test_size": None,
            "test_positives": None,
            "leakage_guard": None,
        },
        "baseline": {"name": None, "description": None},
        "beats_baseline": None,
        "headline_metrics": [],
        "false_alarm": {
            "definition": None,
            "rate": None,
            "miss_definition": None,
            "miss_rate": None,
        },
        "calibration": {
            "applicable": False,
            "method": None,
            "brier": None,
            "brier_uncalibrated": None,
            "brier_reference": None,
            "ece": None,
            "reliability": [],
            "note": None,
        },
        "confusion_matrices": [],
        "details": {},
        "limitations": [],
    }


def _unavailable(entry, reason):
    entry["status"] = "not_available"
    entry["status_reason"] = reason
    return entry


# --- flood risk model --------------------------------------------------------

def _flood_xy(df: pd.DataFrame, feature_cols):
    df = df.copy()
    # Fixed categories -> the same one-hot columns training produced.
    df["land_use"] = pd.Categorical(df["land_use"], categories=tm.LAND_USE_CATEGORIES)
    df = pd.get_dummies(df, columns=["land_use"], drop_first=True)
    X = df.reindex(columns=feature_cols, fill_value=False)
    return X, df["flood_event"].astype(int).reset_index(drop=True)


def _level_threshold(levels: pd.Series, y: pd.Series) -> float:
    """River-level cut-off with the best F1 on the FIT data (never the test
    data) - the same baseline train_models.py prints."""
    candidates = sorted(set(levels.round(2)))
    return float(max(candidates, key=lambda t: f1_score(y, levels >= t, zero_division=0)))


def evaluate_flood(models_dir, test_rng, fit_rng, n_test=FLOOD_TEST_ROWS):
    model_path = os.path.join(models_dir, "flood_model.joblib")
    entry = new_entry(
        "flood",
        "Flood risk model",
        "Turns one node's rainfall, river level, rate of rise, upstream level, soil "
        "saturation, land use and the 6 h rain forecast into a flood probability. "
        "The probability sets the LOW/MEDIUM/HIGH/CRITICAL band; MEDIUM and above "
        "raise an alert (shown to officers, published after cross-check).",
        "Backend (backend/integration_pipeline.py: compute_flood_risk)",
        model_path,
    )
    cols_path = os.path.join(models_dir, "flood_feature_cols.joblib")
    if not (os.path.exists(model_path) and os.path.exists(cols_path)):
        return _unavailable(entry, "flood_model.joblib / flood_feature_cols.joblib missing - run ml\\train_models.py")
    model = joblib.load(model_path)
    feature_cols = joblib.load(cols_path)
    real = os.path.exists(tm.FLOOD_CSV)

    if real:
        try:
            df, groups, _ = tm.load_flood_frame()
            X_all, y_all = _flood_xy(df, feature_cols)
            g = groups.reset_index(drop=True) if groups is not None else None
            X_fit, X_test, y_fit, y_test, _ = tm.split_flood_rows(X_all, y_all, g)
        except SystemExit as exc:
            return _unavailable(entry, f"real flood data cannot give an honest held-out score: {exc}")
        n_train_rows = len(X_fit)
        entry["training_data"] = {
            "provenance": "REAL",
            "generator": "data/flood_history.csv (ml/export_readings_to_csv.py + hand labels)",
            "size": int(n_train_rows),
            "description": f"{len(X_all)} labelled rows, {int(y_all.sum())} flood rows; the model "
            f"was trained on the {n_train_rows}-row training part of the split below. "
            f"CSV sha256 {_sha256(tm.FLOOD_CSV)}.",
        }
        grouped = groups is not None
        entry["evaluation"].update({
            "provenance": "REAL",
            "split": (
                "the whole-group test split train_models.py held out (group = event_id, else "
                "node + UTC day)" if grouped else
                "random 20% ROW split - the CSV has no node_id/timestamp/event_id to group by"
            ),
            "split_kind": "group" if grouped else "row",
            "leakage_guard": (
                "no group appears on both sides" if grouped else
                "NONE: consecutive readings of one event can sit on both sides, so these "
                "scores are optimistic - export with node_id/timestamp"
            ),
        })
        entry["limitations"] += [
            "Valid only if flood_model.joblib was trained by ml/train_models.py from this exact "
            "CSV (sha256 above); retrain, then re-run this script, after the CSV changes.",
            "An upstream and a downstream node see the same flood on the same day, so two groups "
            "can still be correlated - label event_id per real flood to close that.",
            "Few real flood events means a test set of a handful of events: treat every score as "
            "very noisy.",
        ]
        fit_source = "the training part of the same split"
    else:
        # Rows are independent draws, so a fresh draw with its own seed is a
        # held-out set by construction - no row of it was in training.
        test_df = generate_synthetic_data(n_test, rng=test_rng)
        fit_df = generate_synthetic_data(n_test, rng=fit_rng)
        X_test, y_test = _flood_xy(test_df, feature_cols)
        X_fit, y_fit = _flood_xy(fit_df, feature_cols)
        n_train_rows = int(round(FLOOD_TEST_ROWS * 0.8))
        entry["training_data"] = {
            "provenance": "SYNTHETIC",
            "generator": "backend/flood_risk_model.py: generate_synthetic_data (seed 42)",
            "size": n_train_rows,
            "description": (
                f"{FLOOD_TEST_ROWS} synthetic rows (SCS-CN runoff, random land use, gamma "
                f"rainfall); 80% = {n_train_rows} rows trained the model, with 5-fold sigmoid "
                "calibration inside them. Label = top 15% of a weighted risk formula of the "
                "same features plus small noise."
            ),
        }
        entry["evaluation"].update({
            "provenance": "SYNTHETIC",
            "split": f"an independent draw of {n_test} rows from the same generator with its own seed",
            "split_kind": "independent_draw",
            "leakage_guard": "each row is drawn independently and the seed differs from training, "
            "so no test row (or near-twin of one) was trained on",
        })
        entry["limitations"] += [
            "SYNTHETIC: the label is computed from the same input features by a fixed formula, "
            "so the model is re-learning that formula. High scores show the pipeline works, not "
            "that it can forecast a real flood (B13).",
            "Flood prevalence is fixed at 15% by construction. Real flood readings are far rarer, "
            "so at the same false-alarm rate a much larger share of real alerts would be false.",
            "Rows are independent snapshots: this cannot measure warning lead time or whether a "
            "whole flood event is caught.",
            "Probabilities are calibrated on synthetic data only; the LOW..CRITICAL bands they "
            "set have not been checked against real floods. Label real events in "
            "data/flood_history.csv and retrain.",
        ]
        fit_source = "a second independent synthetic draw (not the test rows)"

    prob = model.predict_proba(X_test)[:, 1]
    # "Uncalibrated" = the same fitted trees without the sigmoid: the mean
    # of the per-fold base models CalibratedClassifierCV averages over.
    prob_raw = None
    if hasattr(model, "calibrated_classifiers_"):
        prob_raw = np.mean(
            [cc.estimator.predict_proba(X_test)[:, 1] for cc in model.calibrated_classifiers_], axis=0
        )
    y = y_test.to_numpy()
    positives = int(y.sum())
    entry["evaluation"]["test_size"] = int(len(y))
    entry["evaluation"]["test_positives"] = positives
    if positives == 0 or positives == len(y):
        return _unavailable(entry, "the held-out set has only one class - no honest score possible")

    # Baseline: "flood if the river is at or above X m", X chosen on fit data.
    level_cut = _level_threshold(X_fit["river_level_m"], y_fit)
    base_pred = X_test["river_level_m"].to_numpy() >= level_cut
    base_counts = binary_counts(y, base_pred)
    base_rates = binary_rates(base_counts)
    base_auc = roc_auc_score(y, X_test["river_level_m"])
    # Reference forecast for Brier: always say the base rate seen in the
    # fit data (no skill). The model must beat it to be informative.
    base_rate = float(np.mean(y_fit))
    brier_ref = brier_score_loss(y, np.full(len(y), base_rate))

    operating = []
    for band, cut in OPERATING_POINTS:
        c = binary_counts(y, prob > cut)
        operating.append({"band": band, "cutoff": cut, "counts": c, "rates": binary_rates(c)})
        entry["confusion_matrices"].append(
            binary_confusion(f"{band} and above (risk > {cut})", ["no flood", "flood"], c)
        )
    entry["confusion_matrices"].append(
        binary_confusion(f"Baseline: river level >= {level_cut:.2f} m", ["no flood", "flood"], base_counts)
    )
    alert = next(o for o in operating if o["band"] == ALERT_BAND)

    auc = roc_auc_score(y, prob)
    brier = brier_score_loss(y, prob)
    bins, ece = reliability(y, prob)
    entry["baseline"] = {
        "name": f"river level >= {level_cut:.2f} m",
        "description": f"Flag a flood when the river is at or above one level, chosen for the best "
        f"F1 on {fit_source}. Anything the model adds must beat this one-line rule.",
    }
    entry["headline_metrics"] = [
        metric("roc_auc", "ROC-AUC (ranking, threshold-free)", auc, base_auc),
        metric("f1_alert", f"F1 at the alert cut-off ({ALERT_BAND}+)", alert["rates"]["f1"], base_rates["f1"]),
        metric("recall_alert", f"Floods caught ({ALERT_BAND}+)", alert["rates"]["recall"], base_rates["recall"]),
        metric("false_alarm_rate_alert", f"False-alarm rate ({ALERT_BAND}+)",
               alert["rates"]["false_alarm_rate"], base_rates["false_alarm_rate"], higher_is_better=False),
        metric("brier", "Brier score (vs always predicting the base rate)", brier, brier_ref, higher_is_better=False),
    ]
    f1_alert = alert["rates"]["f1"]
    entry["beats_baseline"] = bool(
        auc > base_auc and f1_alert is not None and base_rates["f1"] is not None and f1_alert > base_rates["f1"]
    )
    entry["false_alarm"] = {
        "definition": f"Share of no-flood cases that got an alert ({ALERT_BAND}+, risk > "
        f"{dict(OPERATING_POINTS)[ALERT_BAND]}): FP / (FP + TN).",
        "rate": alert["rates"]["false_alarm_rate"],
        "miss_definition": f"Share of floods that got no alert ({ALERT_BAND}+): FN / (FN + TP).",
        "miss_rate": alert["rates"]["miss_rate"],
    }
    entry["calibration"] = {
        "applicable": True,
        "method": "sigmoid (Platt) via CalibratedClassifierCV",
        "brier": _num(brier),
        "brier_uncalibrated": _num(brier_score_loss(y, prob_raw)) if prob_raw is not None else None,
        "brier_reference": _num(brier_ref),
        "ece": ece,
        "reliability": bins,
        "note": "Lower Brier/ECE is better. brier_reference = always predicting the base rate "
        f"({base_rate:.3f}). Reliability bins: of the cases given ~p, how many were floods.",
    }
    entry["details"] = {
        "operating_points": operating,
        "baseline_rates": base_rates,
        "baseline_level_cutoff_m": _num(level_cut),
        "pr_auc": _num(average_precision_score(y, prob)),
        "pr_auc_baseline_prevalence": _num(positives / len(y)),
        "brier_skill_score": _num(1 - brier / brier_ref) if brier_ref else None,
        "ece_uncalibrated": reliability(y, prob_raw)[1] if prob_raw is not None else None,
    }
    brier_raw = entry["calibration"]["brier_uncalibrated"]
    if brier_raw is not None and entry["calibration"]["brier"] > brier_raw:
        entry["limitations"].append(
            f"On this held-out set the sigmoid calibration did not improve the probabilities "
            f"(Brier {entry['calibration']['brier']} calibrated vs {brier_raw} without it)."
        )
    entry["status"] = "evaluated"
    return entry


# --- anomaly filter (Isolation Forest) -----------------------------------------

def _flag_rates(y, flagged):
    c = binary_counts(y, flagged)
    return c, binary_rates(c)


def evaluate_anomaly(models_dir, test_rng, n_normal=2000, n_anomalies=100):
    model_path = os.path.join(models_dir, "anomaly_model.joblib")
    entry = new_entry(
        "anomaly_filter",
        "Sensor-fault filter (Isolation Forest)",
        "Flags readings whose five core values (river level, temperature, humidity, gas, "
        "flame) look like a sensor fault rather than the environment. A flagged reading "
        "is suppressed unless it also matches a hazard signature, so a fault does not "
        "become a public alert.",
        "Backend (backend/integration_pipeline.py: check_anomaly)",
        model_path,
    )
    scaler_path = os.path.join(models_dir, "anomaly_scaler.joblib")
    if not (os.path.exists(model_path) and os.path.exists(scaler_path)):
        return _unavailable(entry, "anomaly_model.joblib / anomaly_scaler.joblib missing - run ml\\train_models.py")
    model = joblib.load(model_path)
    scaler = joblib.load(scaler_path)
    real = os.path.exists(tm.ANOMALY_CSV)

    def scores(df):
        X = scaler.transform(df[ANOMALY_FEATURES])
        return (model.predict(X) == -1), -model.score_samples(X), X

    test = generate_sensor_stream(n_normal, n_anomalies, rng=test_rng)
    y = test["is_anomaly"].astype(int).to_numpy()
    flagged, score, X_scaled = scores(test)
    c, rates = _flag_rates(y, flagged)

    # Baseline 1 (the one to beat): any value more than 3 sigma from the
    # training mean, using the SAME scaler - a rule anyone could write.
    z_flag = (np.abs(X_scaled) > 3).any(axis=1)
    zc, zr = _flag_rates(y, z_flag)
    # Baseline 2: the physical range check the pipeline runs anyway. The
    # forest is only worth having for faults that pass it.
    range_flag = np.array([bool(implausible_fields(r)) for r in test[ANOMALY_FEATURES].to_dict("records")])
    rc, rr = _flag_rates(y, range_flag)
    past_range = (y == 1) & ~range_flag
    caught_past_range = _div(int((flagged & past_range).sum()), int(past_range.sum()))

    # The training stream, rebuilt exactly (same seed) - only to show what
    # the old in-sample score said. Confirmed by matching the saved scaler.
    in_sample = None
    if not real:
        train = generate_sensor_stream(rng=np.random.default_rng(ANOMALY_TRAIN_SEED))
        refit = StandardScaler().fit(train[ANOMALY_FEATURES])
        if np.allclose(refit.mean_, scaler.mean_) and np.allclose(refit.scale_, scaler.scale_):
            tflag, _, _ = scores(train)
            _, in_sample = _flag_rates(train["is_anomaly"].astype(int).to_numpy(), tflag)

    n_train = len(pd.read_csv(tm.ANOMALY_CSV)) if real else 2100
    entry["training_data"] = {
        "provenance": "REAL" if real else "SYNTHETIC",
        "generator": "data/anomaly_history.csv" if real else
        "backend/anomaly_detection.py: generate_sensor_stream (seed 7)",
        "size": int(n_train),
        "description": (
            "Logged readings from data/anomaly_history.csv; the forest is unsupervised and was "
            "fitted on every row." if real else
            "2000 synthetic normal readings (slow sine cycles + noise) and 100 injected faults "
            "of four hand-made kinds: spike, dropout to 0, stuck humidity + gas, temperature/gas "
            "drift. contamination = 100/2100, so it flags about 4.8% of readings by design."
        ),
    }
    entry["evaluation"].update({
        "provenance": "SYNTHETIC",
        "split": f"a fresh synthetic stream ({n_normal} normal + {n_anomalies} faults) with its own seed",
        "split_kind": "independent_draw",
        "test_size": int(len(y)),
        "test_positives": int(y.sum()),
        "leakage_guard": "different random stream from the one the forest was fitted on; "
        "train_models.py only ever scored the forest on its own training rows",
    })
    entry["baseline"] = {
        "name": "3-sigma rule",
        "description": "Flag a reading when any value is more than 3 standard deviations from the "
        "training mean (same scaler as the forest).",
    }
    auc = roc_auc_score(y, score) if 0 < y.sum() < len(y) else None
    entry["headline_metrics"] = [
        metric("f1", "F1 (faults)", rates["f1"], zr["f1"]),
        metric("recall", "Faults caught", rates["recall"], zr["recall"]),
        metric("precision", "Flags that were real faults", rates["precision"], zr["precision"]),
        metric("false_alarm_rate", "Good readings flagged", rates["false_alarm_rate"],
               zr["false_alarm_rate"], higher_is_better=False),
        metric("roc_auc", "ROC-AUC of the anomaly score", auc, None),
    ]
    entry["beats_baseline"] = (
        bool(rates["f1"] > zr["f1"]) if rates["f1"] is not None and zr["f1"] is not None else None
    )
    entry["false_alarm"] = {
        "definition": "Share of good readings the forest flags: FP / (FP + TN). A flagged reading "
        "without a hazard signature is suppressed, so this is the share of good data thrown away.",
        "rate": rates["false_alarm_rate"],
        "miss_definition": "Share of injected faults NOT flagged: FN / (FN + TP). These reach the risk models.",
        "miss_rate": rates["miss_rate"],
    }
    entry["calibration"]["note"] = (
        "Not applicable: the forest gives an anomaly score and a fixed cut-off "
        "(contamination), not a probability."
    )
    entry["confusion_matrices"] = [
        binary_confusion("Isolation Forest (held-out stream)", ["good", "fault"], c),
        binary_confusion("Baseline: 3-sigma rule", ["good", "fault"], zc),
        binary_confusion("Physical range check (runs anyway)", ["good", "fault"], rc),
    ]
    entry["details"] = {
        "held_out_rates": rates,
        "in_sample_rates": in_sample,
        "in_sample_note": (
            "Scored on the exact rows the forest was fitted on (what train_models.py prints). "
            "Shown only for comparison - not an honest score."
        ) if in_sample else "Training stream could not be rebuilt (real data or a different seed).",
        "baseline_3sigma_rates": zr,
        "range_check_rates": rr,
        "faults_passing_range_check": int(past_range.sum()),
        "of_those_caught_by_forest": _num(caught_past_range),
    }
    entry["limitations"] = [
        "SYNTHETIC: the held-out faults are the same four hand-made kinds as in training (spike, "
        "dropout, stuck, drift). Real faults - a floating ADC pin, slow calibration drift over "
        "days, a cobweb on the ultrasonic sensor - were never tested.",
        "'Normal' is a gentle sine cycle. Real monsoon readings that are extreme but genuine may "
        "be flagged; the hazard-signature override in the pipeline is what stops a real flood "
        "being suppressed.",
        "The cut-off is fixed by contamination (~4.8%): on real data with fewer faults that "
        "floor of flagged good readings stays.",
        "Readings from modular nodes missing any of the five inputs skip the forest entirely "
        "(only the range check runs).",
    ]
    if real:
        entry["limitations"].insert(0, "The deployed forest was fitted on every row of "
                                    "data/anomaly_history.csv - no real held-out set exists; "
                                    "the held-out score above is on the synthetic fault stream.")
    entry["status"] = "evaluated"
    return entry


# --- on-device edge networks (main + lite) ------------------------------------

def _load_interpreter(tflite_path):
    """TFLite interpreter with the REFERENCE kernels (closer to TFLite
    Micro on the ESP32 than the default XNNPACK path), or (None, reason)."""
    os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")
    try:
        import tensorflow as tf  # noqa: WPS433 - optional, heavy, training-only
    except Exception as exc:  # ImportError, or a broken TF install
        return None, f"tensorflow not installed ({type(exc).__name__}) - pip install -r requirements-training.txt"
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        try:
            interp = tf.lite.Interpreter(
                model_path=tflite_path,
                experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_REF,
            )
        except (AttributeError, TypeError, ValueError):
            interp = tf.lite.Interpreter(model_path=tflite_path)
    interp.allocate_tensors()
    return interp, None


def _header_bytes(header_path, c_name="edge_model_data"):
    with open(header_path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    body = text.split(f"{c_name}[]", 1)[-1]
    return bytes(int(h, 16) for h in re.findall(r"0x([0-9a-fA-F]{2})", body))


def _firmware_scaler(header_path, prefix="EDGE", n=5):
    """The input scaling compiled into the firmware: the generated model
    header's <prefix>_FEATURE_MEAN / _SCALE (ml/quantize_edge_model.py)."""
    with open(header_path, encoding="utf-8", errors="replace") as f:
        text = f.read()
    out = {}
    for key in ("MEAN", "SCALE"):
        m = re.search(rf"{prefix}_FEATURE_{key}\[{n}\]\s*=\s*\{{([^}}]*)\}}", text)
        if not m:
            return None
        out[key] = np.array([float(v.strip().rstrip("fF")) for v in m.group(1).split(",")])
    return out


def _near_threshold(X):
    """Rows whose rule label changes when river level, temperature or gas
    moves by 5% - the boundary cases where imitation errors live."""
    base = np.array([med.label(*r[[0, 1, 3, 4]]) for r in X])
    near = np.zeros(len(X), dtype=bool)
    for col in (0, 1, 3):
        for factor in (0.95, 1.05):
            Xp = X.copy()
            Xp[:, col] *= factor
            near |= np.array([med.label(*r[[0, 1, 3, 4]]) for r in Xp]) != base
    return near


def _lite_labels(X, present):
    return np.array([med.label_lite(**med.lite_row_values(X[i], present[i])) for i in range(len(X))])


def _near_threshold_lite(X, present):
    """As _near_threshold for the lite model: river level, rise, temperature,
    gas, tilt or vibration moved by 5% (only where the sensor is present)."""
    base = _lite_labels(X, present)
    near = np.zeros(len(X), dtype=bool)
    for col in (0, 1, 2, 3, 5, 6):
        for factor in (0.95, 1.05):
            Xp = X.copy()
            Xp[:, col] = np.where(present[:, col], Xp[:, col] * factor, Xp[:, col])
            near |= _lite_labels(Xp, present) != base
    return near


def _int8_run(interp, X, mean, scale):
    """De-quantised outputs of the int8 model; the input tensor is built
    exactly as the firmware builds it (make_edge_dataset.quantize_inputs:
    float32, roundf, clamp)."""
    inp, out = interp.get_input_details()[0], interp.get_output_details()[0]
    in_scale, in_zp = inp["quantization"]
    out_scale, out_zp = out["quantization"]
    q_all = med.quantize_inputs(X, mean, scale, in_scale, in_zp)
    probs = np.zeros((len(X), 3))
    for i in range(len(X)):
        interp.set_tensor(inp["index"], q_all[i:i + 1])
        interp.invoke()
        probs[i] = (interp.get_tensor(out["index"])[0].astype(np.float64) - out_zp) * out_scale
    return probs


def _per_reason_recall(y, pred, reasons, cls=2):
    """Recall of class `cls` per rule that produced it (water / gas / ...)."""
    out = {}
    for reason in ("water", "gas", "flame", "heat", "tilt", "rise"):
        m = (y == cls) & (reasons == reason)
        if m.any():
            out[reason] = {"count": int(m.sum()), "recall": _num(_div(int((pred[m] == cls).sum()), int(m.sum())))}
    return out


def _edge_metrics(entry, X, y, probs, near, n_train, generator, description):
    """Fills the parts the main and the lite edge entry share. Returns
    (pred, numbers used in the limitations)."""
    pred = probs.argmax(axis=1)  # the firmware's first maximum of the int8 output (same scale for all)
    cm = np.zeros((3, 3), dtype=int)
    for t, p in zip(y, pred):
        cm[t, p] += 1
    agreement = float((pred == y).mean())
    macro_f1 = f1_score(y, pred, average="macro", labels=[0, 1, 2], zero_division=0)
    majority = int(np.bincount(y, minlength=3).argmax())
    maj_pred = np.full_like(y, majority)
    maj_acc = float((maj_pred == y).mean())
    maj_f1 = f1_score(y, maj_pred, average="macro", labels=[0, 1, 2], zero_division=0)
    normal = y == 0
    urgent = y == 2
    false_alarm = _div(int((normal & (pred != 0)).sum()), int(normal.sum()))
    urgent_as_normal = int((urgent & (pred == 0)).sum())
    urgent_missed = _div(int((urgent & (pred != 2)).sum()), int(urgent.sum()))
    near_agree = _div(int((pred[near] == y[near]).sum()), int(near.sum()))

    onehot = np.eye(3)[y]
    brier_mc = float(((probs - onehot) ** 2).sum(axis=1).mean())
    conf = probs.max(axis=1)
    bins, ece = reliability((pred == y).astype(float), conf)

    entry["training_data"] = {
        "provenance": "SYNTHETIC",
        "generator": generator,
        "size": n_train,
        "description": description,
    }
    entry["evaluation"].update({
        "provenance": "SYNTHETIC",
        "split": f"an independent draw of {len(y)} readings from the same generator with its own seed, "
        "run through the int8 .tflite (not the float Keras model), inputs quantised exactly as the firmware does",
        "split_kind": "independent_draw",
        "test_size": int(len(y)),
        "test_positives": int((y != 0).sum()),
        "leakage_guard": "readings are drawn independently and the seed differs from training",
    })
    entry["baseline"] = {
        "name": "always NORMAL (majority class)",
        "description": "Predict the most common class every time. The real reference is the "
        "threshold rule itself, which scores 100% on these labels by definition - the network "
        "can only match it here, never beat it.",
    }
    entry["headline_metrics"] = [
        metric("agreement", "Agreement with the threshold rule", agreement, maj_acc),
        metric("macro_f1", "Macro F1 over NORMAL/WATCH/URGENT", macro_f1, maj_f1),
        metric("false_alarm_rate", "NORMAL readings raised to WATCH/URGENT", false_alarm, 0.0,
               higher_is_better=False),
        metric("urgent_missed_rate", "URGENT readings not called URGENT", urgent_missed, 1.0,
               higher_is_better=False),
        metric("near_threshold_agreement", "Agreement within 5% of a threshold", near_agree, None),
    ]
    entry["beats_baseline"] = bool(macro_f1 > maj_f1)
    entry["false_alarm"] = {
        "definition": "Share of NORMAL readings the network calls WATCH or URGENT.",
        "rate": _num(false_alarm),
        "miss_definition": "Share of URGENT readings the network calls NORMAL or WATCH.",
        "miss_rate": _num(urgent_missed),
    }
    entry["calibration"] = {
        "applicable": True,
        "method": "none (int8 softmax output, de-quantised)",
        "brier": _num(brier_mc),
        "brier_uncalibrated": None,
        "brier_reference": _num(float(((np.bincount(y, minlength=3) / len(y) - onehot) ** 2).sum(axis=1).mean())),
        "ece": ece,
        "reliability": bins,
        "note": "Multi-class Brier (sum over the 3 classes). brier_reference = always predicting "
        "the class frequencies. Reliability bins use the top-class confidence vs whether that "
        "class was right. The firmware only uses the top class, so this is informational.",
    }
    entry["confusion_matrices"] = [confusion("int8 network vs threshold rule", EDGE_CLASSES, cm)]
    entry["details"] = {
        "urgent_called_normal": urgent_as_normal,
        "near_threshold_rows": int(near.sum()),
        "per_class_recall": {
            name: _num(_div(int(cm[i, i]), int(cm[i].sum()))) for i, name in enumerate(EDGE_CLASSES)
        },
    }
    return pred, {"agreement": agreement, "near_agree": near_agree, "urgent_missed": urgent_missed,
                  "urgent_as_normal": urgent_as_normal}


def _firmware_match(entry, firmware_dir, header_name, c_name, prefix, n_inputs, tflite_bytes, mean, scale):
    header = os.path.join(firmware_dir, header_name)
    header_matches = _header_bytes(header, c_name) == tflite_bytes if os.path.exists(header) else None
    fw = _firmware_scaler(header, prefix, n_inputs) if os.path.exists(header) else None
    scaler_matches = (
        bool(np.allclose(fw["MEAN"], mean, atol=1e-5) and np.allclose(fw["SCALE"], scale, atol=1e-5))
        if fw else None
    )
    entry["details"].update({
        "model_bytes": len(tflite_bytes),
        "firmware_header_matches_tflite": header_matches,
        "firmware_scaler_matches": scaler_matches,
    })
    if header_matches is False or scaler_matches is False:
        entry["limitations"].insert(0, "The firmware's embedded model or scaler constants DIFFER from "
                                    "the evaluated build - these numbers do not describe the device.")


SIREN_NOTE = ("Its verdict makes a reading 'send now' (WATCH and up) and feeds the backend's alert "
              "confidence; it is NOT a siren trigger - the node's offline siren decides from the water "
              "level and gas alone (decision 2026-10-09).")


def evaluate_edge(test_seed, n=EDGE_TEST_ROWS, build_dir=None, firmware_dir=None):
    build_dir = build_dir or paths.EDGE_BUILD_DIR
    firmware_dir = firmware_dir or os.path.join(paths.FIRMWARE_DIR, "sanjeevni_lora_node")
    s = med.spec("main")
    tflite_path = os.path.join(build_dir, s["tflite"])
    entry = new_entry(
        "edge",
        "On-device edge network, main (int8 TFLite Micro)",
        "A 5-16-8-3 neural network on ESP32 nodes with water level, temperature/humidity, gas and "
        "flame sensors that labels each reading NORMAL / WATCH / URGENT without the backend, so a "
        "node can raise its local alarm and report sooner when the LoRa link or the server is down. "
        + SIREN_NOTE,
        "ESP32 node firmware (firmware/sanjeevni_lora_node/edge_ai.h, EDGE_MODEL_MAIN)",
        tflite_path,
    )
    scaler_path = os.path.join(build_dir, s["scaler"])
    if not (os.path.exists(tflite_path) and os.path.exists(scaler_path)):
        return _unavailable(entry, f"{s['tflite']} / {s['scaler']} missing in var/edge_ai_build - "
                            "see the rebuild steps in ml/make_edge_dataset.py")
    interp, reason = _load_interpreter(tflite_path)
    if interp is None:
        return _unavailable(entry, reason)
    with open(scaler_path) as f:
        sp = json.load(f)
    mean, scale = np.array(sp["mean"], dtype=np.float32), np.array(sp["scale"], dtype=np.float32)

    X, y = med.generate(n=n, seed=test_seed)
    probs = _int8_run(interp, X, mean, scale)
    near = _near_threshold(X)
    n_train = int(round(med.N_SAMPLES * 0.8))
    pred, nums = _edge_metrics(
        entry, X, y, probs, near, n_train, f"ml/make_edge_dataset.py: generate (seed {med.SEED})",
        f"{med.N_SAMPLES} synthetic readings labelled by make_edge_dataset.label() - fixed thresholds "
        "from the backend: gas 600/800 ppm, flame, river 2.75/3.5 m, temperature 45/47 C (IMD heat wave / "
        f"severe heat wave, plains). 80% = {n_train} rows trained the network (15% of those for Keras "
        "validation); weights quantised to int8.")
    reasons = np.array([med.lite_reason(level_m=float(r[0]), temp_c=float(r[1]), gas_ppm=float(r[3]),
                                        flame=float(r[4])) for r in X])
    entry["details"]["urgent_recall_by_rule"] = _per_reason_recall(y, pred, reasons)
    with open(tflite_path, "rb") as f:
        tflite_bytes = f.read()
    entry["limitations"] = [
        "This is NOT hazard-detection accuracy: the labels come from fixed thresholds, so "
        "'agreement' only says how well the network copies that rule (the old '98.28% accuracy' "
        "figure meant the same thing).",
        "SYNTHETIC inputs: independent random readings, not real sensor time series - no "
        "drift, saturation or correlated faults.",
        f"Mistakes concentrate near the thresholds: {_pct(nums['near_agree'])} agreement within 5% of a "
        f"limit vs {_pct(nums['agreement'])} overall. {_pct(nums['urgent_missed'])} of URGENT readings were "
        f"called a lower class ({nums['urgent_as_normal']} of them NORMAL).",
        "Heat follows IMD's PLAINS criteria on one instantaneous reading (45 C heat wave = WATCH, 47 C "
        "severe = URGENT); it is not IMD's daily maximum, and hilly / coastal regions are graded only by "
        "the backend. Labels before 2026-10-09 called 40 C WATCH and 45 C URGENT.",
        "Humidity is an input but not part of the rule, so the network can react to it where the "
        "rule never would.",
    ]
    _firmware_match(entry, firmware_dir, s["header"], s["c_name"], "EDGE", len(s["features"]), tflite_bytes,
                    mean, scale)
    entry["status"] = "evaluated"
    return entry


def evaluate_edge_lite(test_seed, n=LITE_TEST_ROWS, build_dir=None, firmware_dir=None):
    build_dir = build_dir or paths.EDGE_BUILD_DIR
    firmware_dir = firmware_dir or os.path.join(paths.FIRMWARE_DIR, "sanjeevni_lora_node")
    s = med.spec("lite")
    tflite_path = os.path.join(build_dir, s["tflite"])
    entry = new_entry(
        "edge_lite",
        "On-device edge network, lite (int8 TFLite Micro)",
        "A 7-16-8-3 neural network for the nodes the main model cannot serve - deep-sleep battery "
        "nodes, gas-free, tilt-only and other modular kits, an MQ135 on the duty cycle. Inputs: river "
        "level, rise rate, temperature, gas, flame, tilt, vibration; any sensor may be missing. Same "
        "NORMAL / WATCH / URGENT output, also on every deep-sleep wake. " + SIREN_NOTE,
        "ESP32 node firmware (firmware/sanjeevni_lora_node/edge_ai.h, EDGE_MODEL_LITE)",
        tflite_path,
    )
    scaler_path = os.path.join(build_dir, s["scaler"])
    if not (os.path.exists(tflite_path) and os.path.exists(scaler_path)):
        return _unavailable(entry, f"{s['tflite']} / {s['scaler']} missing in var/edge_ai_build - "
                            "see the rebuild steps in ml/make_edge_dataset.py (--model lite)")
    interp, reason = _load_interpreter(tflite_path)
    if interp is None:
        return _unavailable(entry, reason)
    with open(scaler_path) as f:
        sp = json.load(f)
    mean, scale = np.array(sp["mean"], dtype=np.float32), np.array(sp["scale"], dtype=np.float32)

    X, y, present = med.generate_lite(n=n, seed=test_seed, return_present=True)
    probs = _int8_run(interp, X, mean, scale)
    near = _near_threshold_lite(X, present)
    n_train = int(round(med.LITE_N_SAMPLES * 0.8))
    groups = [[med.LITE_FEATURES.index(f) for f in g] for g in med.LITE_GROUPS.values()]
    pred, nums = _edge_metrics(
        entry, X, y, probs, near, n_train, f"ml/make_edge_dataset.py: generate_lite (seed {med.LITE_SEED})",
        f"{med.LITE_N_SAMPLES} synthetic readings labelled by make_edge_dataset.label_lite(): river "
        "2.75/3.5 m, gas 600/800 ppm, flame, temperature 45/47 C (IMD, plains), rise rate >= 2x the "
        "node's fast-rise limit = WATCH (backend flash-flood HIGH; never URGENT on its own), the "
        "backend's landslide tilt score > 0.4 WATCH / > 0.7 URGENT. Each of the five sensor groups is "
        f"missing in {med.LITE_ABSENT_P:.0%} of rows (filled with a calm stand-in, as the firmware does). "
        f"80% = {n_train} rows trained the network; weights quantised to int8.")
    reasons = np.array([med.lite_reason(**med.lite_row_values(X[i], present[i])) for i in range(len(X))])
    fitted = np.array([sum(bool(present[i, g[0]]) for g in groups) for i in range(len(X))])
    entry["details"]["urgent_recall_by_rule"] = _per_reason_recall(y, pred, reasons)
    entry["details"]["agreement_by_groups_fitted"] = {
        str(k): {"count": int((fitted == k).sum()),
                 "agreement": _num(_div(int((pred[fitted == k] == y[fitted == k]).sum()), int((fitted == k).sum())))}
        for k in range(1, len(groups) + 1) if (fitted == k).any()
    }
    entry["details"]["parameters"] = (7 * 16 + 16) + (16 * 8 + 8) + (8 * 3 + 3)
    with open(tflite_path, "rb") as f:
        tflite_bytes = f.read()
    entry["limitations"] = [
        "This is NOT hazard-detection accuracy: the labels come from fixed rules on the backend's "
        "thresholds, so 'agreement' only says how well the network copies that rule.",
        "SYNTHETIC inputs: independent random readings with random sensor kits - no real river, "
        "hillside or sensor faults, no time series.",
        f"Mistakes concentrate near the thresholds: {_pct(nums['near_agree'])} agreement within 5% of a "
        f"limit vs {_pct(nums['agreement'])} overall. {_pct(nums['urgent_missed'])} of URGENT readings were "
        f"called a lower class ({nums['urgent_as_normal']} of them NORMAL).",
        "A missing sensor is fed as a calm reading, so the network cannot say 'unknown' - a node without "
        "a water sensor is simply never flood-WATCH. The backend still sees which sensors reported.",
        "No rain input: the node only holds the rain since its last report (1-5 min, or a 30-s wake), "
        "too short for an intensity; rain is graded by the backend from its rain log. So a fast rise is "
        "WATCH at most here (the backend's CRITICAL needs rain / upstream corroboration).",
        "Landslide: the tilt score is the backend's formula, but URGENT is its HIGH band (> 0.7) - the "
        "node has no CRITICAL. Rain-triggered landslide WATCH (Caine I-D threshold) is backend-only.",
        "Heat follows IMD's PLAINS criteria on one instantaneous reading (45 C WATCH, 47 C URGENT).",
    ]
    _firmware_match(entry, firmware_dir, s["header"], s["c_name"], "EDGE_LITE", len(s["features"]), tflite_bytes,
                    mean, scale)
    entry["status"] = "evaluated"
    return entry


# --- LSTM river forecast --------------------------------------------------------

def _lstm_windows(rng, catchments, days):
    parts = [rf.make_windows(*rf.generate_synthetic_catchment(rng, days), stride=1) for _ in range(catchments)]
    return np.concatenate([p[0] for p in parts]), np.concatenate([p[1] for p in parts])


def _rise_detection(pred_m, true_m, threshold):
    c = binary_counts(true_m > threshold, pred_m > threshold)
    return c, binary_rates(c)


def evaluate_lstm(models_dir, test_rng, catchments=LSTM_TEST_CATCHMENTS, days=LSTM_DAYS):
    model_path = os.path.join(models_dir, os.path.basename(rf.MODEL_PATH))
    entry = new_entry(
        "lstm",
        "River-level forecast (LSTM)",
        "Predicts the change in one node's water level 30 and 60 minutes ahead from the last 2 "
        "hours of level and rainfall, to give officers an earlier view of a rise than the "
        "straight-line ETA.",
        "Backend (backend/river_forecast.py, numpy inference; GET /api/forecast/{node_id})",
        model_path,
    )
    if not os.path.exists(model_path):
        return _unavailable(entry, "river_forecast_lstm.npz missing - run ml\\train_river_forecast.py")
    with np.load(model_path) as data:
        weights = {k: data[k] for k in data.files}

    X, y = _lstm_windows(test_rng, catchments, days)
    pred = np.concatenate([rf.lstm_forward(weights, X[i:i + 8192]) for i in range(0, len(X), 8192)])
    linear = rf.linear_baseline(X)
    persistence = np.zeros_like(y)
    scale = rf.LEVEL_SCALE_M
    rise = trf.RISE_THRESHOLD_M
    rising = (y[:, -1] * scale) > rise

    def mae(p, mask=None):
        err = np.abs(p - y) * scale
        if mask is not None:
            err = err[mask]
        return [_num(v) for v in err.mean(axis=0)] if len(err) else [None, None]

    mae_table = {
        name: {"overall": mae(p), "rising": mae(p, rising)}
        for name, p in (("persistence", persistence), ("linear", linear), ("lstm", pred))
    }
    lstm_c, lstm_r = _rise_detection(pred[:, -1] * scale, y[:, -1] * scale, rise)
    lin_c, lin_r = _rise_detection(linear[:, -1] * scale, y[:, -1] * scale, rise)
    bias_rising = float(((pred[:, -1] - y[:, -1]) * scale)[rising].mean()) if rising.any() else None

    windows_per_catchment = len(range(rf.WINDOW_STEPS, trf.DAYS_PER_CATCHMENT * 24 * 60 // rf.STEP_MINUTES
                                      - max(rf.HORIZON_STEPS), 2))
    n_train = trf.TRAIN_CATCHMENTS * windows_per_catchment
    entry["training_data"] = {
        "provenance": "SYNTHETIC",
        "generator": "backend/river_forecast.py: generate_synthetic_catchment (ml/train_river_forecast.py, seed 1)",
        "size": int(n_train),
        "description": (
            f"{trf.TRAIN_CATCHMENTS} synthetic catchments x {trf.DAYS_PER_CATCHMENT} days at 5-min "
            "steps (random storms, a soil store, two linear reservoirs and a power-law rating "
            f"curve), cut into {n_train} two-hour windows (stride 2); 10% held back by Keras for "
            "early stopping."
        ),
    }
    entry["evaluation"].update({
        "provenance": "SYNTHETIC",
        "split": f"{catchments} NEW synthetic catchments x {days} days with their own seed - different "
        "rivers (storms, soil, reservoirs, rating curve) from every training catchment",
        "split_kind": "catchment",
        "test_size": int(len(y)),
        "test_positives": int(rising.sum()),
        "leakage_guard": "whole catchments are held out, so overlapping windows of one river never "
        "sit on both sides",
    })
    entry["baseline"] = {
        "name": "linear extrapolation (today's ETA)",
        "description": "Extend the last 15 minutes' rate of rise - what the backend's flood ETA "
        "does today. 'Persistence' (level stays put) is in details.",
    }
    entry["headline_metrics"] = [
        metric("mae_60_rising_m", "Error at +60 min during rises (m)", mae_table["lstm"]["rising"][1],
               mae_table["linear"]["rising"][1], higher_is_better=False),
        metric("mae_30_rising_m", "Error at +30 min during rises (m)", mae_table["lstm"]["rising"][0],
               mae_table["linear"]["rising"][0], higher_is_better=False),
        metric("mae_60_overall_m", "Error at +60 min, all windows (m)", mae_table["lstm"]["overall"][1],
               mae_table["linear"]["overall"][1], higher_is_better=False),
        metric("rise_recall", f"Rises > {rise:.2f} m in 60 min foreseen", lstm_r["recall"], lin_r["recall"]),
        # Two different questions, so two rows: false_alarm_rate is FP /
        # (FP + TN), the share of calm windows that got a warning; the old
        # label "Rises predicted that did not come" described FP / (FP + TP),
        # the share of warnings that were wrong - a different number.
        metric("rise_false_alarm_rate", "No-rise windows given a rise warning", lstm_r["false_alarm_rate"],
               lin_r["false_alarm_rate"], higher_is_better=False),
        metric("rise_false_alert_share", "Rise warnings that did not come true", lstm_r["false_alert_share"],
               lin_r["false_alert_share"], higher_is_better=False),
    ]
    lstm_60, lin_60 = mae_table["lstm"]["rising"][1], mae_table["linear"]["rising"][1]
    # On forecast error only. Rise recall can still be worse than the
    # linear ETA; the headline rows show that per metric ("worse on N of
    # M measures") and the limitations say it in words, so the verdict's
    # basis is spelled out in details rather than folded in here.
    entry["beats_baseline"] = (
        bool(lstm_60 < lin_60 and mae_table["lstm"]["overall"][1] < mae_table["linear"]["overall"][1])
        if lstm_60 is not None and lin_60 is not None else None
    )
    entry["false_alarm"] = {
        "definition": f"Treating 'predicted +60 min rise > {rise:.2f} m' as a rise warning: share of "
        "windows with no such rise that got one, FP / (FP + TN).",
        "rate": lstm_r["false_alarm_rate"],
        "miss_definition": f"Share of real rises > {rise:.2f} m in 60 min that were not foreseen.",
        "miss_rate": lstm_r["miss_rate"],
    }
    entry["calibration"]["note"] = (
        "Not applicable: a point forecast with no probability or uncertainty band. "
        "Bias during rises is in details (negative = forecasts too low)."
    )
    entry["confusion_matrices"] = [
        binary_confusion(f"LSTM rise warning (+60 min > {rise:.2f} m)", ["no rise", "rise"], lstm_c),
        binary_confusion("Baseline: linear extrapolation", ["no rise", "rise"], lin_c),
    ]
    reported = None
    metrics_file = os.path.join(models_dir, "river_forecast_metrics.json")
    if os.path.exists(metrics_file):
        with open(metrics_file) as f:
            reported = json.load(f)
    entry["details"] = {
        "horizons_min": [h * rf.STEP_MINUTES for h in rf.HORIZON_STEPS],
        "mae_m": mae_table,
        "bias_60_rising_m": _num(bias_rising),
        "rise_detection_rates": lstm_r,
        "rise_detection_rates_linear": lin_r,
        "beats_baseline_basis": "MAE at +60 min, during rises and over all windows",
        "reported_at_training": reported,
    }
    entry["limitations"] = [
        "SYNTHETIC hydrology only: no real river-gauge history (e.g. CWC / India-WRIS) has been "
        "used for training or testing. Not evidence of accuracy on a real river.",
        f"Rises are rare (about {100 * rising.mean():.1f}% of windows), so the overall error is "
        "dominated by calm periods - read the 'during rises' rows.",
        "A point forecast with no uncertainty band."
        + (f" It under-predicts fast rises (mean error {bias_rising:+.3f} m at +60 min during "
           "rises)." if bias_rising is not None and bias_rising < 0 else ""),
        "Uses only the node's own level and rain gauge - not upstream nodes or the rain forecast.",
        "Relative levels are assumed to transfer between a river (metres) and the bench tank "
        "(centimetres); that has not been tested.",
    ]
    if lstm_r["recall"] is not None and lin_r["recall"] is not None and lstm_r["recall"] < lin_r["recall"]:
        entry["limitations"].insert(1, (
            f"It foresees FEWER rises than the linear ETA ({_pct(lstm_r['recall'])} vs "
            f"{_pct(lin_r['recall'])}), with far fewer false rise warnings. Show it next to the "
            "ETA, not instead of it."
        ))
    entry["status"] = "evaluated"
    return entry


# --- the card -------------------------------------------------------------------

def build_card(seed=DEFAULT_SEED, models_dir=None, sizes=None, edge_build_dir=None, firmware_dir=None):
    """The whole card as a dict. sizes (tests only) shrinks the held-out
    sets: {"flood": n, "anomaly": (normal, faults), "edge": n,
    "edge_lite": n, "lstm": (catchments, days)}."""
    check_operating_points()
    models_dir = models_dir or paths.MODELS_DIR
    sizes = sizes or {}
    # One child stream per held-out set: changing one size never shifts
    # another model's test data, and none equals a training seed's stream.
    # spawn(6): the first five children are the ones spawn(5) gave before the
    # lite model was added, so the other entries' test data did not move.
    flood_test, flood_fit, anomaly_test, edge_test, lstm_test, lite_test = np.random.SeedSequence(seed).spawn(6)
    edge_seed = int(edge_test.generate_state(1)[0])
    if edge_seed == med.SEED:
        edge_seed += 1
    lite_seed = int(lite_test.generate_state(1)[0])
    if lite_seed == med.LITE_SEED:
        lite_seed += 1

    entries = [
        evaluate_flood(models_dir, np.random.default_rng(flood_test), np.random.default_rng(flood_fit),
                       n_test=sizes.get("flood", FLOOD_TEST_ROWS)),
        evaluate_anomaly(models_dir, np.random.default_rng(anomaly_test),
                         *sizes.get("anomaly", (2000, 100))),
        evaluate_edge(edge_seed, n=sizes.get("edge", EDGE_TEST_ROWS),
                      build_dir=edge_build_dir, firmware_dir=firmware_dir),
        evaluate_edge_lite(lite_seed, n=sizes.get("edge_lite", LITE_TEST_ROWS),
                           build_dir=edge_build_dir, firmware_dir=firmware_dir),
        evaluate_lstm(models_dir, np.random.default_rng(lstm_test),
                      *sizes.get("lstm", (LSTM_TEST_CATCHMENTS, LSTM_DAYS))),
    ]
    provenances = {
        e["evaluation"]["provenance"] for e in entries if e["status"] == "evaluated"
    } | {
        e["training_data"]["provenance"] for e in entries if e["status"] == "evaluated"
    }
    if not provenances:
        provenance, banner = "NONE", "No model could be evaluated - see each entry's status_reason."
    elif provenances == {"SYNTHETIC"}:
        provenance, banner = "SYNTHETIC", SYNTHETIC_BANNER
    elif provenances == {"REAL"}:
        provenance, banner = "REAL", REAL_BANNER
    else:
        provenance, banner = "MIXED", MIXED_BANNER
    stamps = [e["artifact"]["modified_at"] for e in entries if e["artifact"]["modified_at"]]
    card = {
        "schema_version": SCHEMA_VERSION,
        "generated_by": "ml/evaluate_models.py",
        "seed": int(seed),
        "provenance": provenance,
        "banner": banner,
        "models_updated_at": max(stamps) if stamps else None,
        "models": entries,
    }
    validate_card(card)
    return card


# The response contract of GET /api/model-card (the web page is built on
# it). validate_card() enforces it before anything is written.
_ENTRY_KEYS = {
    "id": str, "name": str, "status": str, "status_reason": (str, type(None)),
    "purpose": str, "runs_where": str, "artifact": dict, "training_data": dict,
    "evaluation": dict, "baseline": dict, "beats_baseline": (bool, type(None)),
    "headline_metrics": list, "false_alarm": dict, "calibration": dict,
    "confusion_matrices": list, "details": dict, "limitations": list,
}
_NUM = (int, float, type(None))
MODEL_IDS = ["flood", "anomaly_filter", "edge", "edge_lite", "lstm"]


def validate_card(card: dict):
    def need(cond, msg):
        if not cond:
            raise ValueError(f"model card contract: {msg}")

    need(card.get("schema_version") == SCHEMA_VERSION, "schema_version")
    need(card.get("provenance") in ("SYNTHETIC", "REAL", "MIXED", "NONE"), "provenance")
    need(isinstance(card.get("banner"), str) and card["banner"], "banner")
    need(isinstance(card.get("models"), list), "models list")
    # MODEL_IDS; a card written before the lite edge model (no "edge_lite") is still valid
    ids = [e.get("id") for e in card["models"]]
    need(ids in (MODEL_IDS, [i for i in MODEL_IDS if i != "edge_lite"]), "model ids/order")
    for e in card["models"]:
        for key, typ in _ENTRY_KEYS.items():
            need(isinstance(e.get(key), typ) and key in e, f"{e.get('id')}.{key}")
        need(e["status"] in ("evaluated", "not_available"), f"{e['id']}.status")
        need(e["status"] == "evaluated" or e["status_reason"], f"{e['id']}.status_reason")
        need(e["training_data"]["provenance"] in ("SYNTHETIC", "REAL", None), f"{e['id']}.training_data.provenance")
        for m in e["headline_metrics"]:
            need(set(m) == {"key", "label", "value", "baseline", "higher_is_better"}, f"{e['id']} metric keys")
            need(isinstance(m["value"], _NUM) and isinstance(m["baseline"], _NUM), f"{e['id']} metric numbers")
        for cm in e["confusion_matrices"]:
            n = len(cm["labels"])
            need(len(cm["matrix"]) == n and all(len(r) == n for r in cm["matrix"]), f"{e['id']} confusion shape")
            if e["evaluation"]["test_size"] is not None:
                need(sum(map(sum, cm["matrix"])) == e["evaluation"]["test_size"], f"{e['id']} confusion total")
        for b in e["calibration"]["reliability"]:
            need(set(b) == {"bin_lower", "bin_upper", "count", "mean_predicted", "observed_rate"},
                 f"{e['id']} reliability keys")
        need(all(isinstance(s, str) for s in e["limitations"]), f"{e['id']} limitations")
    # NaN would make the file invalid JSON for the browser.
    json.dumps(card, allow_nan=False)


def write_card(card: dict, out_path: str):
    """Atomic write: the backend may read the file at any moment, and a
    half-written card would be a 500 instead of the previous card."""
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    text = json.dumps(card, indent=2, allow_nan=False) + "\n"
    tmp = out_path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, out_path)


def _print_summary(card):
    print(f"\n[{card['provenance']}] {card['banner']}\n")
    for e in card["models"]:
        if e["status"] != "evaluated":
            print(f"- {e['name']}: NOT AVAILABLE ({e['status_reason']})")
            continue
        print(f"- {e['name']}  (test: {e['evaluation']['test_size']}, {e['evaluation']['split_kind']}; "
              f"beats baseline '{e['baseline']['name']}': {e['beats_baseline']})")
        for m in e["headline_metrics"]:
            print(f"    {m['label']:<48s} {m['value']!s:>8}   baseline {m['baseline']!s}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help="seed for every held-out set")
    parser.add_argument("--out", default=paths.MODEL_CARD_PATH, help="output JSON path")
    args = parser.parse_args(argv)
    card = build_card(seed=args.seed)
    write_card(card, args.out)
    _print_summary(card)
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
