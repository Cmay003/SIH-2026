"""
SANJEEVNI - train the LSTM river-level forecaster (river_forecast.py).

Trains on synthetic catchments, evaluates on DIFFERENT held-out synthetic
catchments against two baselines:
  - persistence: level stays where it is
  - linear: extrapolate the last 15 minutes' rate (what the backend's ETA
    does today)
and reports MAE overall and during rises (when the real level goes up by
more than 0.1 m within the hour - the cases a flood warning is for).

Run: python train_river_forecast.py     (needs tensorflow; the backend doesn't)
Writes models/river_forecast_lstm.npz and models/river_forecast_metrics.json
"""

import json
import os

import numpy as np
import os as _os
import sys as _sys

# backend/ holds the shared modules + paths.py (file locations)
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "backend"))
import paths  # noqa: E402

import river_forecast as rf

TRAIN_CATCHMENTS = 30
TEST_CATCHMENTS = 10
DAYS_PER_CATCHMENT = 30
RISE_THRESHOLD_M = 0.10


def build_dataset(seed: int, catchments: int, stride: int):
    rng = np.random.default_rng(seed)
    parts = [rf.make_windows(*rf.generate_synthetic_catchment(rng, DAYS_PER_CATCHMENT), stride=stride)
             for _ in range(catchments)]
    return tuple(np.concatenate([p[i] for p in parts]) for i in range(3))


def mae_m(pred, true, mask=None):
    err = np.abs(pred - true) * rf.LEVEL_SCALE_M
    if mask is not None:
        err = err[mask]
    return err.mean(axis=0)


def main():
    import tensorflow as tf

    tf.keras.utils.set_random_seed(42)
    X_train, y_train, _ = build_dataset(seed=1, catchments=TRAIN_CATCHMENTS, stride=2)
    X_test, y_test, _ = build_dataset(seed=999, catchments=TEST_CATCHMENTS, stride=1)
    print(f"train windows: {len(X_train)}, test windows (unseen catchments): {len(X_test)}")

    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(rf.WINDOW_STEPS, 2)),
        tf.keras.layers.LSTM(32),
        tf.keras.layers.Dense(16, activation="relu"),
        tf.keras.layers.Dense(len(rf.HORIZON_STEPS)),
    ])
    model.compile(optimizer=tf.keras.optimizers.Adam(1e-3), loss="mse")
    model.fit(
        X_train, y_train, validation_split=0.1, epochs=15, batch_size=256, verbose=2,
        callbacks=[tf.keras.callbacks.EarlyStopping(patience=3, restore_best_weights=True)],
    )

    lstm_keras = model.predict(X_test, batch_size=1024, verbose=0)
    persistence = np.zeros_like(y_test)
    linear = rf.linear_baseline(X_test)
    rising = (y_test[:, -1] * rf.LEVEL_SCALE_M) > RISE_THRESHOLD_M

    metrics = {"test_windows": int(len(y_test)), "rising_windows": int(rising.sum()), "mae_m": {}}
    print(f"\nMAE in metres on {TEST_CATCHMENTS} unseen synthetic catchments "
          f"({rising.sum()} of {len(y_test)} windows are 'rising'):")
    print(f"{'':14s}{'+30 min':>10s}{'+60 min':>10s}{'+30 rising':>12s}{'+60 rising':>12s}")
    for name, pred in (("persistence", persistence), ("linear", linear), ("LSTM", lstm_keras)):
        overall, during_rise = mae_m(pred, y_test), mae_m(pred, y_test, rising)
        metrics["mae_m"][name] = {"overall": overall.round(4).tolist(), "rising": during_rise.round(4).tolist()}
        print(f"{name:14s}{overall[0]:10.4f}{overall[1]:10.4f}{during_rise[0]:12.4f}{during_rise[1]:12.4f}")

    # Export weights for the numpy runtime and prove it matches Keras
    lstm_layer, dense1, dense2 = model.layers
    kernel, recurrent, bias = lstm_layer.get_weights()
    weights = {
        "lstm_kernel": kernel, "lstm_recurrent": recurrent, "lstm_bias": bias,
        "dense1_kernel": dense1.get_weights()[0], "dense1_bias": dense1.get_weights()[1],
        "dense2_kernel": dense2.get_weights()[0], "dense2_bias": dense2.get_weights()[1],
    }
    numpy_pred = rf.lstm_forward(weights, X_test[:2000])
    max_diff = float(np.abs(numpy_pred - lstm_keras[:2000]).max())
    print(f"\nnumpy runtime vs Keras, max abs difference: {max_diff:.2e}")
    assert max_diff < 1e-4, "numpy LSTM does not match Keras - check gate order"

    os.makedirs(paths.MODELS_DIR, exist_ok=True)
    np.savez(rf.MODEL_PATH, **weights)
    metrics["numpy_vs_keras_max_abs_diff"] = max_diff
    metrics["caveat"] = "synthetic catchments only - not evidence of accuracy on a real river"
    with open(os.path.join(paths.MODELS_DIR, "river_forecast_metrics.json"), "w") as f:
        json.dump(metrics, f, indent=2)
    print(f"saved {rf.MODEL_PATH} and river_forecast_metrics.json in {paths.MODELS_DIR}")


if __name__ == "__main__":
    main()
