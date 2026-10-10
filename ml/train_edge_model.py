"""
Trains a genuinely tiny neural network for ESP32 on-device inference
(see make_edge_dataset.py for the data, the label rules and the full
rebuild sequence).
  --model main: 5 inputs -> 16 -> 8 -> 3 outputs (softmax), 259 parameters
  --model lite: 7 inputs -> 16 -> 8 -> 3 outputs (softmax), 291 parameters
Both are trivially small for TFLite Micro (an int8 model of a few KB, an
8 KB tensor arena), so the lite model fits a deep-sleep battery node too.
Seeded (tf.keras.utils.set_random_seed, oneDNN off) so a rebuild gives the
same model on the same machine / TensorFlow version. Epochs: 60 for both
(main: 30 / 60 / 100 compared 2026-10-09 on an independent draw of 20,000 -
60 had the fewest URGENT readings called a lower class).
"""
import json
import os
# Windows 11 Smart App Control blocks wrapt's unsigned compiled helper
# (_wrappers.*.pyd, pulled in by TensorFlow / ChromaDB) with "Part of this
# app has been blocked". wrapt's pure-Python fallback behaves the same.
# Must run before those imports. To keep the compiled helper, set
# WRAPT_DISABLE_EXTENSIONS to an EMPTY value (wrapt treats "0" as set).
os.environ.setdefault("WRAPT_DISABLE_EXTENSIONS", "1")

# oneDNN's reordered float sums make a rebuild differ slightly from run to run
os.environ.setdefault("TF_ENABLE_ONEDNN_OPTS", "0")

import numpy as np  # noqa: E402
import tensorflow as tf
from sklearn.metrics import classification_report, confusion_matrix
from sklearn.model_selection import train_test_split
from sklearn.preprocessing import StandardScaler

import make_edge_dataset as med
import paths  # noqa: E402 - make_edge_dataset put backend/ on sys.path

EPOCHS = {"main": 60, "lite": 60}
TRAIN_SEED = 42


def main():
    args = med.model_arg("Train an edge model.").parse_args()
    s = med.spec(args.model)
    os.makedirs(paths.EDGE_BUILD_DIR, exist_ok=True)
    os.chdir(paths.EDGE_BUILD_DIR)
    tf.keras.utils.set_random_seed(TRAIN_SEED)

    X, y = np.load(s["X"]), np.load(s["y"])

    # Normalize features - critical for a small NN to train well, and the
    # scaler's mean/scale get baked into the ESP32 firmware as constants
    # (can't run sklearn on the device, so normalization becomes fixed
    # arithmetic in C).
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X).astype(np.float32)

    X_train, X_test, y_train, y_test = train_test_split(
        X_scaled, y, test_size=0.2, random_state=42, stratify=y
    )

    h1, h2 = s["hidden"]
    model = tf.keras.Sequential([
        tf.keras.layers.Input(shape=(len(s["features"]),)),
        tf.keras.layers.Dense(h1, activation="relu"),
        tf.keras.layers.Dense(h2, activation="relu"),
        tf.keras.layers.Dense(3, activation="softmax"),
    ])
    model.compile(optimizer="adam", loss="sparse_categorical_crossentropy", metrics=["accuracy"])

    print(f"[{args.model}] total trainable parameters: {model.count_params()}")

    model.fit(X_train, y_train, validation_split=0.15, epochs=EPOCHS[args.model], batch_size=64, verbose=0)

    print(f"\n=== [{args.model}] full-precision Keras model (held-out test set) ===")
    y_pred = np.argmax(model.predict(X_test, verbose=0), axis=1)
    print(classification_report(y_test, y_pred, target_names=["NORMAL", "WATCH", "URGENT"], digits=4))
    print("Confusion matrix:\n", confusion_matrix(y_test, y_pred))

    model.save(s["keras"])

    # The scaler's parameters as plain JSON - quantize_edge_model.py writes
    # them into the firmware header for normalizing raw sensor readings
    # before they go into the quantized model.
    scaler_params = {
        "mean": scaler.mean_.tolist(),
        "scale": scaler.scale_.tolist(),
        "feature_order": s["features"],
    }
    if args.model == "lite":
        scaler_params["absent_fill"] = [med.LITE_ABSENT[f] for f in s["features"]]
    with open(s["scaler"], "w") as f:
        json.dump(scaler_params, f, indent=2)
    print(f"\nSaved {s['keras']} and {s['scaler']}")


if __name__ == "__main__":
    main()
