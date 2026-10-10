"""
SANJEEVNI - fast single-reading inference for the two scikit-learn models
(backend lane, step B2, 2026-10-09).

WHY: profiling one ordinary reading end to end (tests/ingest_bench.py,
cProfile, OMP_NUM_THREADS=1 as the load test runs the backend) showed
~0.26 s of CPU per reading, ~90 % of it inside scikit-learn's per-call
machinery, not in the maths:
  - IsolationForest: ~160 ms. predict() and score_samples() each walk all
    200 trees through joblib's Parallel (one task per tree, a warnings
    filter set up and torn down per task) - and check_anomaly called both.
  - CalibratedClassifierCV(HistGradientBoosting, cv=5): ~80 ms. Five
    boosted models, each a Python loop over ~200 tree predictors, plus
    input validation of a one-row pandas DataFrame per model.

WHAT: the same models, evaluated with plain NumPy over arrays flattened
once from the fitted trees - all trees of a model walked together, one
level per step. The arithmetic is the library's own, in the same order:
  - every comparison is the library's (float32 input vs float64 threshold
    for the isolation trees, float64 for the boosted trees; NaN follows
    missing_go_to_left);
  - per-tree contributions are added SEQUENTIALLY in tree order
    (np.add.accumulate), exactly like the library's `+=` loop - not with a
    pairwise sum, which could change the last bit;
  - the scaler, the path-length normalisation, the sigmoid calibrators
    and the averaging over the five calibrated models call / repeat the
    library's code on the same arrays.
So the outputs are bit-for-bit those of sklearn 1.9 (proved per model at
build time, below, and by tests/test_fast_inference.py).

SAFETY: a fast model is only built for the exact shapes it understands
(binary sigmoid-calibrated HistGradientBoosting without categorical
features; an IsolationForest + StandardScaler fitted on named columns).
At build time it is checked against the library on a fixed set of probe
rows (random rows around the training data, NaN-free and with NaNs) and
must agree EXACTLY (np.array_equal); otherwise None is returned and the
caller keeps using scikit-learn. SANJEEVNI_FAST_INFERENCE=0 turns the fast
path off entirely (to compare, or if a future scikit-learn changes its
internals - the probe check then refuses to build and logs why).
"""

import os
import warnings

import numpy as np
from scipy.special import expit

FAST_INFERENCE_ENV = "SANJEEVNI_FAST_INFERENCE"
PROBE_ROWS = 512
_CACHE_MAX = 8


def enabled() -> bool:
    return os.environ.get(FAST_INFERENCE_ENV, "1") != "0"


# --------------------------------------------------------------- trees ----

class _FlatTrees:
    """All trees of one ensemble in flat arrays (global node indices).
    feature: column of the INPUT row for each node (a per-tree feature
    subset is already mapped back); leaf nodes have left == -1."""

    def __init__(self, feature, threshold, left, right, missing_left, roots, max_depth):
        self.feature = feature
        self.threshold = threshold
        self.left = left
        self.right = right
        self.missing_left = missing_left
        self.roots = roots
        self.max_depth = max_depth

    def leaves(self, X: np.ndarray) -> np.ndarray:
        """(n_samples, n_trees) global leaf index of each row in each tree."""
        n = X.shape[0]
        node = np.broadcast_to(self.roots, (n, self.roots.shape[0])).copy()
        rows = np.arange(n)[:, None]
        for _ in range(self.max_depth + 1):
            left = self.left[node]
            internal = left >= 0
            if not internal.any():
                break
            values = X[rows, self.feature[node]]
            nan = np.isnan(values)
            # NaN: missing_go_to_left; otherwise value <= threshold (the
            # comparison promotes like the library's C code)
            go_left = np.where(nan, self.missing_left[node], values <= self.threshold[node])
            nxt = np.where(go_left, left, self.right[node])
            node = np.where(internal, nxt, node)
        return node


def _sequential_sum(start: np.ndarray, terms: np.ndarray) -> np.ndarray:
    """start + terms[:, 0] + terms[:, 1] + ... added left to right, like a
    `+=` loop (np.add.accumulate is strictly sequential)."""
    stacked = np.concatenate([start.reshape(-1, 1), terms], axis=1)
    return np.add.accumulate(stacked, axis=1)[:, -1]


# ------------------------------------------------------ isolation forest ---

class FastIsolationForest:
    """StandardScaler + IsolationForest, as check_anomaly uses them."""

    def __init__(self, model, scaler):
        from sklearn.ensemble._iforest import _average_path_length

        self.model = model
        self.scaler = scaler
        n_features = int(scaler.n_features_in_)
        feature, threshold, left, right, missing, roots, path_len = [], [], [], [], [], [], []
        offset, max_depth = 0, 0
        subsample = model._max_features != n_features
        for tree, features, dpl, apl in zip(model.estimators_, model.estimators_features_,
                                            model._decision_path_lengths,
                                            model._average_path_length_per_tree):
            t = tree.tree_
            cols = np.asarray(features) if subsample else np.arange(n_features)
            is_leaf = t.children_left < 0
            feature.append(np.where(is_leaf, 0, cols[np.where(is_leaf, 0, t.feature)]))
            threshold.append(t.threshold.astype(np.float64))
            left.append(np.where(is_leaf, -1, t.children_left + offset))
            right.append(np.where(is_leaf, -1, t.children_right + offset))
            missing.append(np.asarray(getattr(t, "missing_go_to_left", np.zeros(t.node_count)), dtype=bool))
            # the library's per-leaf term, same dtypes, same expression
            path_len.append(np.asarray(dpl) + np.asarray(apl) - 1.0)
            roots.append(offset)
            offset += t.node_count
            max_depth = max(max_depth, int(t.max_depth))
        self.trees = _FlatTrees(
            np.concatenate(feature).astype(np.intp), np.concatenate(threshold),
            np.concatenate(left).astype(np.intp), np.concatenate(right).astype(np.intp),
            np.concatenate(missing), np.asarray(roots, dtype=np.intp), max_depth,
        )
        self.path_len = np.concatenate(path_len)
        self.denominator = len(model.estimators_) * _average_path_length([model._max_samples])
        self.offset_ = model.offset_

    def scaled(self, X: np.ndarray) -> np.ndarray:
        """StandardScaler.transform on a float64 array (X -= mean; X /= scale)."""
        X = np.array(X, dtype=np.float64, copy=True)
        if self.scaler.with_mean:
            X -= self.scaler.mean_.astype(X.dtype)
        if self.scaler.with_std:
            X /= self.scaler.scale_.astype(X.dtype)
        return X

    def score_samples_scaled(self, X_scaled: np.ndarray) -> np.ndarray:
        """IsolationForest.score_samples (input already scaled)."""
        X32 = np.asarray(X_scaled, dtype=np.float32)
        terms = self.path_len[self.trees.leaves(X32)]
        depths = _sequential_sum(np.zeros(X32.shape[0]), terms)
        scores = 2 ** (-np.divide(depths, self.denominator, out=np.ones_like(depths),
                                  where=self.denominator != 0))
        return -scores

    def predict_and_score(self, X: np.ndarray):
        """(is_anomaly bool array, anomaly score = -score_samples) for RAW
        rows - what check_anomaly takes from predict() and score_samples()."""
        score_samples = self.score_samples_scaled(self.scaled(X))
        decision = score_samples - self.offset_
        return decision < 0, -score_samples

    def reference(self, X: np.ndarray):
        """The library's own answer for the same rows (for the probe check)."""
        import pandas as pd

        frame = pd.DataFrame(X, columns=list(self.scaler.feature_names_in_))
        scaled = self.scaler.transform(frame)
        return self.model.predict(scaled) == -1, -self.model.score_samples(scaled)


# --------------------------------------------------------- flood model ----

class FastCalibratedHGB:
    """CalibratedClassifierCV(method='sigmoid') over binary
    HistGradientBoostingClassifiers: predict_proba(X)[:, 1]."""

    def __init__(self, model):
        self.model = model
        self.members = []
        for cc in model.calibrated_classifiers_:
            est = cc.estimator
            feature, threshold, left, right, missing, roots, values = [], [], [], [], [], [], []
            offset, max_depth = 0, 0
            for iteration in est._predictors:
                (predictor,) = iteration  # binary: one tree per iteration
                nodes = predictor.nodes
                leaf = nodes["is_leaf"].astype(bool)
                feature.append(np.where(leaf, 0, nodes["feature_idx"]))
                threshold.append(nodes["num_threshold"].astype(np.float64))
                left.append(np.where(leaf, -1, nodes["left"].astype(np.int64) + offset))
                right.append(np.where(leaf, -1, nodes["right"].astype(np.int64) + offset))
                missing.append(nodes["missing_go_to_left"].astype(bool))
                values.append(nodes["value"])
                roots.append(offset)
                offset += len(nodes)
                max_depth = max(max_depth, int(nodes["depth"].max()))
            self.members.append({
                "trees": _FlatTrees(
                    np.concatenate(feature).astype(np.intp), np.concatenate(threshold),
                    np.concatenate(left).astype(np.intp), np.concatenate(right).astype(np.intp),
                    np.concatenate(missing), np.asarray(roots, dtype=np.intp), max_depth,
                ),
                "values": np.concatenate(values),
                "baseline": est._baseline_prediction,
                "calibrator": cc.calibrators[0],
            })
        self.n_classes = len(model.classes_)

    def predict_proba(self, X: np.ndarray) -> np.ndarray:
        X = np.asarray(X, dtype=np.float64)
        n = X.shape[0]
        mean_proba = np.zeros((n, self.n_classes))
        for m in self.members:
            leaf_values = m["values"][m["trees"].leaves(X)]
            start = np.zeros(n, dtype=m["baseline"].dtype) + m["baseline"].ravel()[0]
            raw = _sequential_sum(start, leaf_values)  # HGB decision_function
            proba = np.zeros((n, self.n_classes))
            # _SigmoidCalibration.predict without its input check (~0.5 ms
            # per call): the same expression on the same 1-D array
            cal = m["calibrator"]
            proba[:, 1] = expit(-(cal.a_ * raw + cal.b_))
            proba[:, 0] = 1.0 - proba[:, 1]
            proba[(1.0 < proba) & (proba <= 1.0 + 1e-5)] = 1.0
            mean_proba += proba
        mean_proba /= len(self.members)
        return mean_proba

    def reference(self, X: np.ndarray) -> np.ndarray:
        import pandas as pd

        frame = pd.DataFrame(X, columns=list(self.model.feature_names_in_))
        return self.model.predict_proba(frame)


# ------------------------------------------------------------- build ----

def _supported_iforest(model, scaler, features) -> bool:
    from sklearn.ensemble import IsolationForest
    from sklearn.preprocessing import StandardScaler

    return (
        type(model) is IsolationForest and type(scaler) is StandardScaler
        and list(getattr(scaler, "feature_names_in_", [])) == list(features)
        and int(scaler.n_features_in_) == len(features)
        and hasattr(model, "_decision_path_lengths") and hasattr(model, "_average_path_length_per_tree")
    )


def _supported_flood(model, feature_cols) -> bool:
    from sklearn.calibration import CalibratedClassifierCV, _SigmoidCalibration
    from sklearn.ensemble import HistGradientBoostingClassifier

    if type(model) is not CalibratedClassifierCV or getattr(model, "method", None) != "sigmoid":
        return False
    if len(model.classes_) != 2 or list(getattr(model, "feature_names_in_", [])) != list(feature_cols):
        return False
    for cc in model.calibrated_classifiers_:
        est = cc.estimator
        if (type(est) is not HistGradientBoostingClassifier or est.n_trees_per_iteration_ != 1
                or getattr(est, "_preprocessor", None) is not None
                or getattr(est, "is_categorical_", None) is not None
                or len(cc.calibrators) != 1 or type(cc.calibrators[0]) is not _SigmoidCalibration
                or list(est.classes_) != list(model.classes_)):
            return False
        for iteration in est._predictors:
            if len(iteration) != 1 or iteration[0].nodes["is_categorical"].any():
                return False
    return True


def _probe_rows(center, spread, seed) -> np.ndarray:
    """Fixed probe rows: normal around the training data, wide outliers,
    exact copies of the thresholds' neighbourhoods and some NaNs."""
    rng = np.random.default_rng(seed)
    center = np.asarray(center, dtype=np.float64)
    spread = np.where(np.asarray(spread, dtype=np.float64) > 0, spread, 1.0)
    n, f = PROBE_ROWS, center.shape[0]
    rows = center + rng.normal(0, 1, (n, f)) * spread
    rows[n // 2:] = center + rng.normal(0, 6, (n - n // 2, f)) * spread
    rows[: n // 8] = np.round(rows[: n // 8], 1)  # ties with round thresholds
    nan_rows = rng.integers(0, n, n // 16)
    rows[nan_rows, rng.integers(0, f, n // 16)] = np.nan
    return rows


def _flood_probe(fast: FastCalibratedHGB) -> np.ndarray:
    est = fast.model.calibrated_classifiers_[0].estimator
    mapper = est._bin_mapper
    lo = np.array([t[0] if len(t) else 0.0 for t in mapper.bin_thresholds_])
    hi = np.array([t[-1] if len(t) else 1.0 for t in mapper.bin_thresholds_])
    rows = _probe_rows((lo + hi) / 2, (hi - lo) / 2 + 1e-9, 20261009)
    # values exactly ON split thresholds take the "<=" branch: probe them
    thr = np.concatenate([m["trees"].threshold[m["trees"].left >= 0] for m in fast.members])
    feat = np.concatenate([m["trees"].feature[m["trees"].left >= 0] for m in fast.members])
    k = min(len(thr), PROBE_ROWS // 4)
    rows[:k, :] = (lo + hi) / 2
    rows[np.arange(k), feat[:k]] = thr[:k]
    return rows


def _check(name, fast, rows) -> bool:
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        want = fast.reference(rows)
        got = fast.predict_and_score(rows) if isinstance(fast, FastIsolationForest) else fast.predict_proba(rows)
    if isinstance(want, tuple):
        same = all(np.array_equal(a, b) for a, b in zip(want, got))
    else:
        same = np.array_equal(want, got)
    if not same:
        print(f"[fast-inference] {name}: fast path disagrees with scikit-learn on probe rows - "
              "using scikit-learn (slower, same results)")
    return same


_iforest_cache: dict = {}
_flood_cache: dict = {}


def _remember(cache: dict, key, value):
    if len(cache) >= _CACHE_MAX:
        cache.pop(next(iter(cache)))
    cache[key] = value
    return value


def fast_isolation_forest(model, scaler, features):
    """The checked fast scorer for this (model, scaler), or None (use sklearn)."""
    if not enabled() or model is None or scaler is None:
        return None
    key = (id(model), id(scaler), tuple(features))
    hit = _iforest_cache.get(key)
    if hit is not None and hit[0] is model and hit[1] is scaler:
        return hit[2]
    fast = None
    try:
        if _supported_iforest(model, scaler, features):
            candidate = FastIsolationForest(model, scaler)
            rows = _probe_rows(scaler.mean_, scaler.scale_, 9102026)
            if _check("anomaly model", candidate, rows):
                fast = candidate
    except Exception as e:  # noqa: BLE001 - never block ingestion: sklearn still works
        print(f"[fast-inference] anomaly model: fast path unavailable ({e!r}) - using scikit-learn")
    return _remember(_iforest_cache, key, (model, scaler, fast))[2]


def fast_flood_model(model, feature_cols):
    """The checked fast predictor for this flood model, or None (use sklearn)."""
    if not enabled() or model is None:
        return None
    key = (id(model), tuple(feature_cols or ()))
    hit = _flood_cache.get(key)
    if hit is not None and hit[0] is model:
        return hit[1]
    fast = None
    try:
        if _supported_flood(model, feature_cols):
            candidate = FastCalibratedHGB(model)
            if _check("flood model", candidate, _flood_probe(candidate)):
                fast = candidate
    except Exception as e:  # noqa: BLE001
        print(f"[fast-inference] flood model: fast path unavailable ({e!r}) - using scikit-learn")
    return _remember(_flood_cache, key, (model, fast))[1]
