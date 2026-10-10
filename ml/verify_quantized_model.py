"""
Runs the ACTUAL quantized int8 TFLite model (via the TFLite interpreter,
not the original Keras model) against the held-out test set, to prove
quantization didn't destroy the model - this is the test that actually
matters, not just "the conversion succeeded without erroring".

  .\\venv\\Scripts\\python.exe ml\\verify_quantized_model.py [--model lite]

The input tensor is built exactly as the firmware builds it
(sj_edge_input.h: float32, roundf, clamp - quantize_edge_model.quantize_inputs),
and the firmware's class is the first maximum of the int8 output.
Also reports: float (Keras) vs int8 agreement, URGENT recall per rule
(lite: which sensor made it URGENT), and whether the header installed in
firmware/sanjeevni_lora_node is this build. Fails (exit 1) if a single
URGENT test reading comes out NORMAL.
"""
import json
import os
# Windows 11 Smart App Control blocks wrapt's unsigned compiled helper
# (_wrappers.*.pyd, pulled in by TensorFlow / ChromaDB) with "Part of this
# app has been blocked". wrapt's pure-Python fallback behaves the same.
# Must run before those imports. To keep the compiled helper, set
# WRAPT_DISABLE_EXTENSIONS to an EMPTY value (wrapt treats "0" as set).
os.environ.setdefault("WRAPT_DISABLE_EXTENSIONS", "1")
import sys

import numpy as np
from sklearn.metrics import classification_report
from sklearn.model_selection import train_test_split

import make_edge_dataset as med
import paths  # noqa: E402 - make_edge_dataset put backend/ on sys.path
import quantize_edge_model as qem


def main():
    args = med.model_arg("Verify an int8 edge model on its held-out test set.").parse_args()
    s = med.spec(args.model)
    os.makedirs(paths.EDGE_BUILD_DIR, exist_ok=True)
    os.chdir(paths.EDGE_BUILD_DIR)

    X, y = np.load(s["X"]), np.load(s["y"])
    with open(s["scaler"]) as f:
        scaler = json.load(f)
    mean = np.array(scaler["mean"], dtype=np.float32)
    scale = np.array(scaler["scale"], dtype=np.float32)

    idx_train, idx_test = train_test_split(np.arange(len(y)), test_size=0.2, random_state=42, stratify=y)
    X_test, y_test = X[idx_test], y[idx_test]

    model = qem.Int8Model(s["tflite"])
    predictions = np.array([model.classify_q(qem.quantize_inputs(x, mean, scale, model.in_scale, model.in_zp))
                            for x in X_test])

    print(f"=== [{args.model}] QUANTIZED (int8) model on the held-out test set ({len(y_test)} readings) ===")
    print(classification_report(y_test, predictions, target_names=["NORMAL", "WATCH", "URGENT"], digits=4))
    accuracy = (predictions == y_test).mean()
    print(f"Quantized model agreement with the label rule: {accuracy:.4f}")

    try:
        import tensorflow as tf
        keras = tf.keras.models.load_model(s["keras"])
        float_pred = np.argmax(keras.predict(((X_test - mean) / scale).astype(np.float32), verbose=0), axis=1)
        print(f"Float (Keras) agreement with the rule: {(float_pred == y_test).mean():.4f}; float vs int8 agree on "
              f"{(float_pred == predictions).mean():.4f} ({int((float_pred != predictions).sum())} of {len(y_test)} "
              "differ)")
    except Exception as exc:  # the Keras file is optional for this check
        print(f"(float model not compared: {exc})")

    urgent = y_test == 2
    normal_as_urgent = int(((y_test == 0) & (predictions == 2)).sum())
    urgent_as_normal = int((urgent & (predictions == 0)).sum())
    urgent_missed = int((urgent & (predictions != 2)).sum())
    print(f"\nNORMAL misclassified as URGENT: {normal_as_urgent}")
    print(f"URGENT misclassified as NORMAL (the dangerous direction): {urgent_as_normal}")
    print(f"URGENT not called URGENT: {urgent_missed} of {int(urgent.sum())} ({urgent_missed / max(1, urgent.sum()):.4f})")

    if args.model == "lite":
        _, _, present = med.generate_lite(return_present=True)
        reasons = np.array([med.lite_reason(**med.lite_row_values(X[i], present[i])) for i in idx_test])
        print("\nURGENT recall per rule (lite):")
        for reason in ("water", "gas", "flame", "heat", "tilt"):
            m = urgent & (reasons == reason)
            if m.any():
                print(f"  {reason:<6} {int((predictions[m] == 2).sum())}/{int(m.sum())}")
        print("Agreement by number of sensor groups fitted:")
        groups = [[med.LITE_FEATURES.index(n) for n in g] for g in med.LITE_GROUPS.values()]
        fitted = np.array([sum(bool(present[i, g[0]]) for g in groups) for i in idx_test])
        for k in range(1, len(groups) + 1):
            m = fitted == k
            if m.any():
                print(f"  {k} group(s): {(predictions[m] == y_test[m]).mean():.4f} on {int(m.sum())}")

    installed = os.path.join(qem.FIRMWARE_NODE, s["header"])
    if os.path.exists(installed):
        with open(installed, encoding="utf-8") as a, open(s["header"], encoding="utf-8") as b:
            same = a.read() == b.read()
        print(f"\nfirmware/sanjeevni_lora_node/{s['header']} is this build: {same}")

    if urgent_as_normal:
        print("\nCRITICAL: the int8 model calls a real URGENT reading NORMAL")
        sys.exit(1)
    print("\nPASS: the quantized model never mistakes an URGENT test reading for NORMAL")


if __name__ == "__main__":
    main()
