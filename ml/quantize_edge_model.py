"""
SANJEEVNI - convert a trained edge model to int8 TensorFlow Lite and write
the C header the ESP32 firmware compiles in (B19: this step was referenced
by edge_model_data.h as "quantize_model.py" but never committed).

Run after train_edge_model.py (see make_edge_dataset.py for the full
sequence). Writes, in var/edge_ai_build:
  <prefix>_model_int8.tflite
  <header>             the model bytes, the input scaling (mean / scale per
                       input, from the training scaler), the lite model's
                       absent-sensor values, and GOLDEN VECTORS: a few
                       hand-picked readings with the class the int8 model
                       gives them here - the node's self-test runs them
                       through TFLite Micro on the ESP32 and compares
  edge_vectors_<model>.h  host-test vectors (tools/firmware_host_test):
                       reading fields -> the int8 input tensor the
                       firmware must build, computed here in float32
                       exactly as sj_edge_input.h does it
--install copies the header into firmware/sanjeevni_lora_node/ and the
vectors into tools/firmware_host_test/.
"""

import json
import os
# Windows 11 Smart App Control blocks wrapt's unsigned compiled helper
# (_wrappers.*.pyd, pulled in by TensorFlow / ChromaDB) with "Part of this
# app has been blocked". wrapt's pure-Python fallback behaves the same.
# Must run before those imports. To keep the compiled helper, set
# WRAPT_DISABLE_EXTENSIONS to an EMPTY value (wrapt treats "0" as set).
os.environ.setdefault("WRAPT_DISABLE_EXTENSIONS", "1")
import shutil

import numpy as np
import tensorflow as tf

import make_edge_dataset as med
import paths  # noqa: E402 - make_edge_dataset put backend/ on sys.path

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIRMWARE_NODE = os.path.join(REPO, "firmware", "sanjeevni_lora_node")
HOST_TEST = os.path.join(REPO, "tools", "firmware_host_test")
VECTOR_ROWS = 256
VECTOR_SEED = 99

# Golden vectors: clear cases of every rule, far from any threshold, so a
# TFLite Micro kernel that is not bit-exact with the PC interpreter still
# gives the same class; a mismatch on the device means a wrong model /
# scaling / library, not rounding. (raw inputs, the rule's class)
GOLDEN = {
    "main": [  # river_level_m, temp_c, humidity_pct, gas_ppm, flame
        ("calm", [1.9, 29.0, 62.0, 430.0, 0.0]),
        ("river watch", [3.0, 29.0, 62.0, 430.0, 0.0]),
        ("river urgent", [4.2, 29.0, 62.0, 430.0, 0.0]),
        ("gas watch", [1.9, 29.0, 62.0, 690.0, 0.0]),
        ("gas urgent", [1.9, 29.0, 62.0, 1100.0, 0.0]),
        ("heat wave 46 C", [1.9, 46.0, 25.0, 430.0, 0.0]),
        ("severe heat 49.5 C", [1.9, 49.5, 20.0, 430.0, 0.0]),
        ("flame", [1.9, 29.0, 62.0, 430.0, 1.0]),
    ],
    "lite": [  # river_level_m, rise_x, temp_c, gas_ppm, flame, tilt_deg, vibration_g (None = absent)
        ("calm, all fitted", [1.9, 0.0, 29.0, 430.0, 0.0, 0.5, 0.05]),
        ("calm, tilt only", [None, None, None, None, None, 0.5, 0.05]),
        ("river urgent, water only", [4.2, 0.2, None, None, None, None, None]),
        ("river watch", [3.0, 0.0, 29.0, None, 0.0, None, None]),
        ("fast rise 4x", [2.2, 4.0, 29.0, None, 0.0, None, None]),
        ("slope moving: 20 deg, 1 g", [None, None, 29.0, None, None, 20.0, 1.0]),
        ("slope tilted 11 deg", [None, None, None, None, None, 11.0, 0.05]),
        ("severe heat 49.5 C", [None, None, 49.5, None, 0.0, 0.5, 0.05]),
        ("gas urgent, no water", [None, None, 29.0, 1100.0, 0.0, None, None]),
        ("flame, deep-sleep kit", [1.9, 0.0, 29.0, None, 1.0, None, None]),
    ],
}


def representative_data(X_scaled, samples=500):
    # Lets the converter pick int8 ranges from realistic inputs
    idx = np.random.default_rng(0).choice(len(X_scaled), size=min(samples, len(X_scaled)), replace=False)
    for i in idx:
        yield [X_scaled[i:i + 1]]


def f32_literal(v):
    """A C float literal that parses to exactly np.float32(v) (9 significant
    digits round-trip a float32; "29" needs its ".0" - "29f" is no literal)."""
    text = f"{float(np.float32(v)):.9g}"
    if not any(c in text for c in ".en"):
        text += ".0"
    return text + "f"


roundf = med.roundf
quantize_inputs = med.quantize_inputs


class Int8Model:
    """The int8 .tflite through the TFLite interpreter (reference kernels when available)."""

    def __init__(self, path):
        try:
            self.it = tf.lite.Interpreter(model_path=path,
                                          experimental_op_resolver_type=tf.lite.experimental.OpResolverType.BUILTIN_REF)
        except (AttributeError, TypeError, ValueError):
            self.it = tf.lite.Interpreter(model_path=path)
        self.it.allocate_tensors()
        self.inp, self.out = self.it.get_input_details()[0], self.it.get_output_details()[0]
        self.in_scale, self.in_zp = self.inp["quantization"]

    def classify_q(self, q):
        """argmax over the int8 output, first index on a tie (as edge_ai.h)."""
        self.it.set_tensor(self.inp["index"], np.asarray(q, dtype=np.int8)[None])
        self.it.invoke()
        return int(np.argmax(self.it.get_tensor(self.out["index"])[0]))


def golden_rows(model):
    """(name, raw float32 inputs as the firmware fills them, rule label)."""
    rows = []
    for name, values in GOLDEN[model]:
        if model == "main":
            raw = values
            lab = med.label(values[0], values[1], values[3], values[4])
        else:
            raw = [med.LITE_ABSENT[f] if v is None else v for f, v in zip(med.LITE_FEATURES, values)]
            names = ("level_m", "rise_x", "temp_c", "gas_ppm", "flame", "tilt_deg", "vibration_g")
            lab = med.label_lite(**dict(zip(names, values)))
        rows.append((name, np.array(raw, dtype=np.float32), lab))
    return rows


def vector_rows(model, n=VECTOR_ROWS, seed=VECTOR_SEED):
    """Reading fields (the integers of SjReading) for the host test, drawn
    from the training generator. Presence per group for the lite model."""
    rng = np.random.default_rng(seed)
    if model == "main":
        X, _ = med.generate(n=n, seed=seed)
        present = np.ones((n, 7), dtype=bool)
        rise = np.zeros(n)
        tilt = np.zeros(n)
        vib = np.zeros(n)
        level, temp, hum, gas, flame = X.T
    else:
        X, _, present = med.generate_lite(n=n, seed=seed, return_present=True)
        level, rise, temp, gas, flame, tilt, vib = X.T
        hum = np.clip(rng.normal(62, 18, n), 5, 100)
    rows = []
    for i in range(n):
        rows.append({
            "has_water": bool(present[i, 0]), "has_rise": bool(present[i, 1]), "has_dht": bool(present[i, 2]),
            "has_gas": bool(present[i, 3]), "has_flame": bool(present[i, 4]), "has_tilt": bool(present[i, 5]),
            "water_level_mm": int(np.clip(round(level[i] * 1000), 0, 65535)),
            # rise_x x the 1 cm/min river limit = cm/min
            "rise_cm_min_x100": int(np.clip(round(rise[i] * 100), -32768, 32767)),
            "temp_c_x100": int(round(temp[i] * 100)),
            "humidity_x100": int(round(hum[i] * 100)),
            "gas_ppm": int(np.clip(round(gas[i]), 0, 65535)),
            "flame": bool(flame[i] >= 0.5),
            # signed: the firmware feeds |tilt| (a tilt either way)
            "tilt_deg_x100": int(round(tilt[i] * 100)) * (-1 if i % 3 == 0 else 1),
            "vibration_g_x1000": int(round(vib[i] * 1000)),
        })
    return rows


def features_from_fields(model, row, absent):
    """sj_edge_input.h's feature extraction, in float32 (river scale, fast-rise
    limit 1 cm/min)."""
    f32 = np.float32
    level = f32(row["water_level_mm"]) / f32(1000.0)
    temp = f32(row["temp_c_x100"]) / f32(100.0)
    hum = f32(row["humidity_x100"]) / f32(100.0)
    gas = f32(row["gas_ppm"])
    flame = f32(1.0) if row["flame"] else f32(0.0)
    if model == "main":
        return np.array([level, temp, hum, gas, flame], dtype=np.float32)
    rise = f32(row["rise_cm_min_x100"]) / f32(100.0) / f32(1.0)
    rise = min(max(rise, f32(med.RISE_X_MIN)), f32(med.RISE_X_MAX))
    tilt = abs(f32(row["tilt_deg_x100"]) / f32(100.0))
    vib = f32(row["vibration_g_x1000"]) / f32(1000.0)
    out = [level if row["has_water"] else absent[0],
           rise if (row["has_water"] and row["has_rise"]) else absent[1],
           temp if row["has_dht"] else absent[2],
           gas if row["has_gas"] else absent[3],
           flame if row["has_flame"] else absent[4],
           tilt if row["has_tilt"] else absent[5],
           vib if row["has_tilt"] else absent[6]]
    return np.array(out, dtype=np.float32)


def model_hash(model_bytes: bytes) -> int:
    """FNV-1a 32 over the model bytes (the host test recomputes it)."""
    h = 2166136261
    for b in model_bytes:
        h = ((h ^ b) * 16777619) & 0xFFFFFFFF
    return h


def to_c_header(model, s, model_bytes, mean, scale, absent, golden):
    p = "EDGE" if model == "main" else "EDGE_LITE"
    n_in = len(s["features"])
    rows = [", ".join(f"0x{b:02x}" for b in model_bytes[i:i + 12]) for i in range(0, len(model_bytes), 12)]
    body = ",\n  ".join(rows)
    arr = lambda values: ", ".join(f32_literal(v) for v in values)  # noqa: E731
    guard = "EDGE_MODEL_DATA_H" if model == "main" else "EDGE_LITE_MODEL_DATA_H"
    out = [
        f"// Auto-generated by ml/quantize_edge_model.py --model {model} from {s['tflite']} - do not edit.",
        "// Rebuild: the steps in ml/make_edge_dataset.py (then --install puts it here).",
        f"// {model.upper()} edge model: {n_in} inputs -> NORMAL / WATCH / URGENT (synthetic, rule-labelled data).",
        "",
        f"#ifndef {guard}",
        f"#define {guard}",
        "",
        "#include <stdint.h>",
        "",
        f"#define {p}_MODEL_INPUTS {n_in}",
        f"// input order: {', '.join(s['features'])}",
        f"// x_normalized = (x - MEAN) / SCALE (the training StandardScaler)",
        f"static const float {p}_FEATURE_MEAN[{n_in}] = {{{arr(mean)}}};",
        f"static const float {p}_FEATURE_SCALE[{n_in}] = {{{arr(scale)}}};",
    ]
    if absent is not None:
        out += [
            "// fed for a sensor the node lacks / that gave no value: a calm reading",
            f"static const float {p}_ABSENT[{n_in}] = {{{arr(absent)}}};",
        ]
    out += [
        "// Golden vectors for the self-test: raw inputs and the class the int8 model",
        "// gives them in the TFLite interpreter on the PC (= the label rule's class).",
        f"#define {p}_GOLDEN_COUNT {len(golden)}",
        f"static const float {p}_GOLDEN_INPUT[{len(golden)}][{n_in}] = {{",
    ]
    out += [f"  {{{arr(raw)}}},  // {name}" for name, raw, _ in golden]
    out += [
        "};",
        f"static const uint8_t {p}_GOLDEN_CLASS[{len(golden)}] = {{{', '.join(str(c) for _, _, c in golden)}}};",
        "",
        f"const unsigned int {s['c_name']}_len = {len(model_bytes)};",
        f"alignas(8) const unsigned char {s['c_name']}[] = {{\n  {body}\n}};",
        "",
        "#endif",
        "",
    ]
    return "\n".join(out)


def to_vectors_header(model, s, model_bytes, interp, mean, scale, absent):
    p = "MAIN" if model == "main" else "LITE"
    rows = vector_rows(model)
    lines = [
        f"// Auto-generated by ml/quantize_edge_model.py --model {model} - do not edit.",
        f"// Host-test vectors for {s['header']}: reading fields -> the int8 input tensor",
        "// sj_edge_input.h must build (float32, roundf, clamp - computed in numpy",
        "// float32), and the class the TFLite interpreter gives it (reference).",
        "// River scale, fast-rise limit 1 cm/min.",
        "#pragma once",
        "#include <stdint.h>",
        "",
        f"#define VEC_{p}_MODEL_LEN {len(model_bytes)}u",
        f"#define VEC_{p}_MODEL_FNV 0x{model_hash(model_bytes):08x}u",
        f"#define VEC_{p}_IN_SCALE {f32_literal(interp.in_scale)}",
        f"#define VEC_{p}_IN_ZERO {int(interp.in_zp)}",
        f"#define VEC_{p}_COUNT {len(rows)}",
        "// has_water, has_rise, has_dht, has_gas, has_flame, has_tilt, water_level_mm, rise_cm_min_x100,",
        "// temp_c_x100, humidity_x100, gas_ppm, flame, tilt_deg_x100, vibration_g_x1000, q[...], class",
        f"static const EdgeVector VEC_{p}[{len(rows)}] = {{",
    ]
    classes = []
    for row in rows:
        raw = features_from_fields(model, row, absent)
        q = quantize_inputs(raw, mean, scale, interp.in_scale, interp.in_zp)
        cls = interp.classify_q(q)
        classes.append(cls)
        fields = [int(row[k]) for k in ("has_water", "has_rise", "has_dht", "has_gas", "has_flame", "has_tilt")]
        fields += [row["water_level_mm"], row["rise_cm_min_x100"], row["temp_c_x100"], row["humidity_x100"],
                   row["gas_ppm"], int(row["flame"]), row["tilt_deg_x100"], row["vibration_g_x1000"]]
        lines.append(f"  {{{', '.join(str(v) for v in fields)}, {{{', '.join(str(int(v)) for v in q)}}}, {cls}}},")
    lines += ["};", ""]
    return "\n".join(lines), np.bincount(classes, minlength=3)


def main():
    parser = med.model_arg("Quantize an edge model to int8 and write its firmware header.")
    parser.add_argument("--install", action="store_true",
                        help="copy the header into firmware/sanjeevni_lora_node and the vectors into "
                             "tools/firmware_host_test")
    args = parser.parse_args()
    model_name = args.model
    s = med.spec(model_name)
    os.makedirs(paths.EDGE_BUILD_DIR, exist_ok=True)
    os.chdir(paths.EDGE_BUILD_DIR)

    model = tf.keras.models.load_model(s["keras"])
    with open(s["scaler"]) as f:
        scaler = json.load(f)
    # float32 as the firmware holds them (the header's literals parse to these)
    mean = np.array(scaler["mean"], dtype=np.float32)
    scale = np.array(scaler["scale"], dtype=np.float32)
    absent = np.array(scaler["absent_fill"], dtype=np.float32) if "absent_fill" in scaler else None
    X = np.load(s["X"])
    X_scaled = ((X - mean) / scale).astype(np.float32)

    converter = tf.lite.TFLiteConverter.from_keras_model(model)
    converter.optimizations = [tf.lite.Optimize.DEFAULT]
    converter.representative_dataset = lambda: representative_data(X_scaled)
    converter.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    converter.inference_input_type = tf.int8
    converter.inference_output_type = tf.int8
    tflite_model = converter.convert()
    with open(s["tflite"], "wb") as f:
        f.write(tflite_model)

    interp = Int8Model(s["tflite"])
    golden = []
    for name, raw, rule in golden_rows(model_name):
        got = interp.classify_q(quantize_inputs(raw, mean, scale, interp.in_scale, interp.in_zp))
        if got != rule:
            raise SystemExit(f"golden vector '{name}': the int8 model says {got}, the rule {rule} - "
                             "retrain (or pick a clearer golden case)")
        golden.append((name, raw, got))

    header = to_c_header(model_name, s, tflite_model, mean, scale, absent, golden)
    with open(s["header"], "w") as f:  # text mode, as before (CRLF on Windows)
        f.write(header)
    vectors, vec_classes = to_vectors_header(model_name, s, tflite_model, interp, mean, scale, absent)
    vec_name = f"edge_vectors_{model_name}.h"
    with open(vec_name, "w", newline="\n") as f:
        f.write(vectors)

    print(f"[{model_name}] wrote {s['tflite']} and {s['header']} ({len(tflite_model)} bytes), "
          f"{len(golden)} golden vectors, {vec_name} (classes N/W/U {vec_classes.tolist()}) in {paths.EDGE_BUILD_DIR}")
    if args.install:
        shutil.copy(s["header"], os.path.join(FIRMWARE_NODE, s["header"]))
        shutil.copy(vec_name, os.path.join(HOST_TEST, vec_name))
        print(f"installed {s['header']} -> firmware/sanjeevni_lora_node/, {vec_name} -> tools/firmware_host_test/")


if __name__ == "__main__":
    main()
