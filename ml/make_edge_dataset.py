"""
SANJEEVNI - training data for the two on-device edge models (B19: the
original script that produced edge_X.npy / edge_y.npy was never committed,
so the edge model could not be rebuilt).

Both models say NORMAL (0) / WATCH (1) / URGENT (2). Their labels come from
FIXED RULES (label() / label_lite() below) built on the backend's own
thresholds, so the edge verdict agrees with the cloud pipeline. The data is
SYNTHETIC: random readings, not a real river or a real hillside. A network
trained on it can only learn to copy the rule - the model card
(ml/evaluate_models.py) reports "agreement with the rule", never "hazard
accuracy".

MAIN model (firmware EDGE_MODEL_MAIN; nodes with water level, DHT22, MQ135
and flame): 5 inputs [river_level_m, temp_c, humidity_pct, gas_ppm, flame].
LITE model (EDGE_MODEL_LITE; every other node: deep-sleep battery nodes,
gas-free, tilt-only, MQ135 duty-cycled, any modular kit): 7 inputs
[river_level_m, rise_x, temp_c, gas_ppm, flame, tilt_deg, vibration_g],
any of the five sensor groups may be ABSENT (see LITE_ABSENT).

Node verdict vs backend severity (severity_band: MEDIUM > 0.4, HIGH > 0.7,
CRITICAL > 0.9). A WATCH reading is sent at once and every sample while it
lasts; URGENT is the node's top class.
  hazard       WATCH                         URGENT                    backend source
  river level  >= 2.75 m                     >= 3.5 m                  FLOOD_CRITICAL_LEVEL_M (backend_server.py)
  gas (MQ135)  >= 600 ppm                    >= 800 ppm                GAS_LEAK_THRESHOLD_PPM / GAS_CRITICAL_PPM
  flame        -                             detected                  classify_fire_smoke
  heat         >= 45 C (IMD heat wave,       >= 47 C (IMD severe       hazard_classification.py IMD_HEAT_WAVE_ACTUAL_C /
               plains; backend HIGH)         heat wave; CRITICAL)      IMD_SEVERE_HEAT_WAVE_ACTUAL_C
  -- lite only --
  rise rate    >= 2 x the fast-rise limit    never on its own          FLASH_FLOOD_HIGH = 2 x MEDIUM (= the node's
               (2 cm/min river scale =                                 fast-rise limit, config.h). CRITICAL needs rain /
               backend flash-flood HIGH)                               upstream corroboration the node cannot see.
  tilt score   > 0.4 (backend MEDIUM)        > 0.7 (backend HIGH)      classify_landslide: 0.7 x min(1, |tilt|/15 deg)
                                                                       + 0.3 x min(1, vibration/2 g)
HEAT, IMD (verified 2026-10-09 by the backend lane - sources cited in
backend/hazard_classification.py: https://mausam.imd.gov.in/pdfs/heatcolduser/
Definition.pdf and .../morning_heat_bulletin.pdf): for PLAINS, actual maximum
>= 45 C is a heat wave, >= 47 C a severe heat wave; heat waves are only
considered from 40 C. Until 2026-10-09 this file called 45 C "IMD severe"
(URGENT) and 40 C WATCH - wrong. 40-45 C is backend MEDIUM ("heat-wave
level possible") and stays NORMAL on the node: a WATCH is sent every 5-s
sample, and 40 C is an ordinary summer afternoon on the plains - the 5-min
summary (its max) still carries it to the backend. A node reads an
instantaneous temperature, not IMD's screened daily maximum, and the node
applies the PLAINS rule only (hilly/coastal regions are graded by the
backend). Landslide tilt: the node has no CRITICAL band; the backend's HIGH
is its "evacuate" level for landslides (rain alone is capped below it).
Neither heat nor tilt nor flame sounds the node's offline siren - that is
decided from the water level and gas only (firmware sj_siren.h, user
decision 2026-10-09); the edge verdict is not a siren trigger.

Full rebuild (needs requirements-training.txt), from the project folder.
Every step works in var\\edge_ai_build; --model lite does the same for the
lite model (files edge_lite_*):
  .\\venv\\Scripts\\python.exe ml\\make_edge_dataset.py [--model lite]
  .\\venv\\Scripts\\python.exe ml\\train_edge_model.py [--model lite]
  .\\venv\\Scripts\\python.exe ml\\quantize_edge_model.py [--model lite] --install
  .\\venv\\Scripts\\python.exe ml\\verify_quantized_model.py [--model lite]
--install copies the generated header (model bytes + input scaling +
golden vectors) into firmware\\sanjeevni_lora_node\\ and the host-test
vectors into tools\\firmware_host_test\\; nothing is pasted by hand.
Then: ml\\evaluate_models.py (model card) and
tools\\firmware_host_test\\run_tests.py.
"""

import argparse
import os
import sys

import numpy as np

# backend/ holds the shared modules + paths.py (file locations)
sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "backend"))
import paths  # noqa: E402

N_SAMPLES = 20000
SEED = 7
LITE_N_SAMPLES = 40000
LITE_SEED = 11

# --- thresholds (run_tests.py checks them against the backend's constants) ---
LEVEL_WATCH_M = 2.75
LEVEL_URGENT_M = 3.5          # backend_server.FLOOD_CRITICAL_LEVEL_M
GAS_WATCH_PPM = 600.0
GAS_URGENT_PPM = 800.0        # integration_pipeline.GAS_LEAK_THRESHOLD_PPM
FLAME_ON = 0.5
HEAT_WATCH_C = 45.0           # hazard_classification.IMD_HEAT_WAVE_ACTUAL_C (plains)
HEAT_URGENT_C = 47.0          # hazard_classification.IMD_SEVERE_HEAT_WAVE_ACTUAL_C (plains)
RISE_WATCH_X = 2.0            # x the node's fast-rise limit = backend flash-flood HIGH / MEDIUM
TILT_FULL_DEG = 15.0          # classify_landslide: 15 degrees treated as a severe tilt
VIBRATION_FULL_G = 2.0        # classify_landslide: 2.0 g treated as severe
TILT_WEIGHT, VIBRATION_WEIGHT = 0.7, 0.3
TILT_WATCH_SCORE = 0.4        # severity_band MEDIUM
TILT_URGENT_SCORE = 0.7       # severity_band HIGH

FEATURES = ["river_level_m", "temp_c", "humidity_pct", "gas_ppm", "flame_reading"]
LITE_FEATURES = ["river_level_m", "rise_x", "temp_c", "gas_ppm", "flame_reading", "tilt_deg", "vibration_g"]
# rise_x is clipped to this range on the node and here (sj_edge_input.h)
RISE_X_MIN, RISE_X_MAX = -5.0, 10.0

# What the firmware puts in for a sensor the node does not have (or that
# gave no value this sample): a CALM reading, so an absent sensor can never
# raise the verdict - exactly what label_lite() does with a missing value.
# The firmware takes these from the generated header (edge_lite_model_data.h).
LITE_ABSENT = {
    "river_level_m": 1.9, "rise_x": 0.0, "temp_c": 29.0, "gas_ppm": 430.0,
    "flame_reading": 0.0, "tilt_deg": 0.0, "vibration_g": 0.05,
}
# sensor groups that come and go together (a reading's SJ_HAS_* flags)
LITE_GROUPS = {
    "water": ["river_level_m", "rise_x"],
    "dht": ["temp_c"],
    "gas": ["gas_ppm"],
    "flame": ["flame_reading"],
    "tilt": ["tilt_deg", "vibration_g"],
}
LITE_ABSENT_P = 0.35   # each group is missing in this share of training rows
LITE_RISE_ABSENT_P = 0.15  # water fitted but no rate yet / a doubtful level


def label(level_m, temp_c, gas_ppm, flame):
    """MAIN model rule (table above). Plain numbers on purpose: tools/demo/simulation.test.js parses them."""
    if gas_ppm >= 800 or flame >= 0.5 or level_m >= 3.5 or temp_c >= 47:
        return 2
    if level_m >= 2.75 or gas_ppm >= 600 or temp_c >= 45:
        return 1
    return 0


# label() repeats the named thresholds as numbers (above); they must agree
assert (label(LEVEL_URGENT_M, 0, 0, 0), label(LEVEL_URGENT_M - 0.01, 0, 0, 0), label(LEVEL_WATCH_M - 0.01, 0, 0, 0),
        label(0, HEAT_URGENT_C, 0, 0), label(0, HEAT_URGENT_C - 0.01, 0, 0), label(0, HEAT_WATCH_C - 0.01, 0, 0),
        label(0, 0, GAS_URGENT_PPM, 0), label(0, 0, GAS_URGENT_PPM - 1, 0), label(0, 0, GAS_WATCH_PPM - 1, 0),
        label(0, 0, 0, FLAME_ON), label(0, 0, 0, FLAME_ON - 0.01)) == (2, 1, 0, 2, 1, 0, 2, 1, 0, 2, 0), \
    "make_edge_dataset.label() and the named thresholds disagree"


def tilt_score(tilt_deg, vibration_g):
    """classify_landslide()'s tilt risk (hazard_classification.py)."""
    return TILT_WEIGHT * min(1.0, abs(tilt_deg) / TILT_FULL_DEG) + VIBRATION_WEIGHT * min(
        1.0, max(0.0, vibration_g) / VIBRATION_FULL_G)


def label_lite(level_m=None, rise_x=None, temp_c=None, gas_ppm=None, flame=None, tilt_deg=None, vibration_g=None):
    """LITE model rule. None = that sensor is absent: it can never raise
    the verdict."""
    score = tilt_score(tilt_deg, vibration_g or 0.0) if tilt_deg is not None else 0.0
    if ((level_m is not None and level_m >= LEVEL_URGENT_M) or (gas_ppm is not None and gas_ppm >= GAS_URGENT_PPM)
            or (flame is not None and flame >= FLAME_ON) or (temp_c is not None and temp_c >= HEAT_URGENT_C)
            or score > TILT_URGENT_SCORE):
        return 2
    if ((level_m is not None and level_m >= LEVEL_WATCH_M) or (gas_ppm is not None and gas_ppm >= GAS_WATCH_PPM)
            or (temp_c is not None and temp_c >= HEAT_WATCH_C) or (rise_x is not None and rise_x >= RISE_WATCH_X)
            or score > TILT_WATCH_SCORE):
        return 1
    return 0


def lite_reason(level_m=None, rise_x=None, temp_c=None, gas_ppm=None, flame=None, tilt_deg=None, vibration_g=None):
    """Which rule set the lite label (for the model card's per-reason
    figures): the first of water / gas / flame / heat / tilt / rise at the
    label's level, or "none"."""
    lab = label_lite(level_m, rise_x, temp_c, gas_ppm, flame, tilt_deg, vibration_g)
    if lab == 0:
        return "none"
    only = {
        "water": dict(level_m=level_m), "gas": dict(gas_ppm=gas_ppm), "flame": dict(flame=flame),
        "heat": dict(temp_c=temp_c), "tilt": dict(tilt_deg=tilt_deg, vibration_g=vibration_g),
        "rise": dict(rise_x=rise_x),
    }
    for name, kwargs in only.items():
        if label_lite(**kwargs) == lab:
            return name
    return "none"


def generate(n=N_SAMPLES, seed=SEED):
    """MAIN model data: (X n x 5, y)."""
    rng = np.random.default_rng(seed)
    # Mostly calm readings, with enough hazard cases for every class
    level = np.where(rng.random(n) < 0.75, rng.normal(1.9, 0.35, n), rng.uniform(2.3, 4.5, n))
    temp = np.where(rng.random(n) < 0.85, rng.normal(29, 5, n), rng.uniform(38, 50, n))
    humidity = np.clip(rng.normal(62, 18, n), 5, 100)
    gas = np.where(rng.random(n) < 0.85, rng.normal(430, 60, n), rng.uniform(550, 1200, n))
    flame = (rng.random(n) < 0.04).astype(float)
    level, gas = np.clip(level, 0, None), np.clip(gas, 0, None)
    X = np.stack([level, temp, humidity, gas, flame], axis=1).astype(np.float32)
    y = np.array([label(*row[[0, 1, 3, 4]]) for row in X], dtype=np.int64)
    return X, y


def lite_row_values(row, present):
    """The label_lite() keyword arguments of one lite row (None = absent)."""
    names = ("level_m", "rise_x", "temp_c", "gas_ppm", "flame", "tilt_deg", "vibration_g")
    return {k: (float(v) if ok else None) for k, v, ok in zip(names, row, present)}


def generate_lite(n=LITE_N_SAMPLES, seed=LITE_SEED, return_present=False):
    """LITE model data: (X n x 7, y[, present n x 7 bool]). Absent sensors
    are filled with LITE_ABSENT and labelled as absent."""
    rng = np.random.default_rng(seed)
    level = np.where(rng.random(n) < 0.75, rng.normal(1.9, 0.35, n), rng.uniform(2.3, 4.5, n))
    rise = np.where(rng.random(n) < 0.8, rng.normal(0.0, 0.25, n), rng.uniform(-2.0, 8.0, n))
    temp = np.where(rng.random(n) < 0.85, rng.normal(29, 5, n), rng.uniform(38, 50, n))
    gas = np.where(rng.random(n) < 0.85, rng.normal(430, 60, n), rng.uniform(550, 1200, n))
    flame = (rng.random(n) < 0.04).astype(float)
    tilt = np.where(rng.random(n) < 0.8, np.abs(rng.normal(0.0, 1.0, n)), rng.uniform(0.0, 25.0, n))
    vib = np.where(rng.random(n) < 0.85, np.abs(rng.normal(0.05, 0.03, n)), rng.uniform(0.0, 3.0, n))
    level, gas = np.clip(level, 0, None), np.clip(gas, 0, None)
    rise = np.clip(rise, RISE_X_MIN, RISE_X_MAX)
    X = np.stack([level, rise, temp, gas, flame, tilt, vib], axis=1).astype(np.float32)

    # sensor groups present per row; at least one group always
    present = np.ones((n, len(LITE_FEATURES)), dtype=bool)
    groups = list(LITE_GROUPS.values())
    for i in range(n):
        while True:
            have = rng.random(len(groups)) >= LITE_ABSENT_P
            if have.any():
                break
        for g, ok in zip(groups, have):
            for name in g:
                present[i, LITE_FEATURES.index(name)] = ok
    rise_col = LITE_FEATURES.index("rise_x")
    present[:, rise_col] &= rng.random(n) >= LITE_RISE_ABSENT_P
    fill = np.array([LITE_ABSENT[f] for f in LITE_FEATURES], dtype=np.float32)
    X = np.where(present, X, fill).astype(np.float32)
    y = np.array([label_lite(**lite_row_values(X[i], present[i])) for i in range(n)], dtype=np.int64)
    return (X, y, present) if return_present else (X, y)


def roundf(x):
    """C roundf (half away from zero), elementwise; np.round rounds half to
    even. Done in float64: a float32 value + 0.5 is exact there (in float32,
    0.49999997 + 0.5 would round up to 1.0 - roundf gives 0)."""
    x = np.asarray(x, dtype=np.float64)
    return np.sign(x) * np.floor(np.abs(x) + 0.5)


def quantize_inputs(raw, mean, scale, in_scale, in_zp):
    """The int8 input tensor exactly as the firmware builds it
    (sj_edge_input.h sjEdgeQuantize): float32 throughout, roundf, clamp.
    raw: one row or a 2-D batch. (The firmware clamps the float to +-1000
    before roundf - only to keep the int conversion defined; every such
    value clamps to -128 / 127 anyway.)"""
    raw = np.asarray(raw, dtype=np.float32)
    normalized = (raw - np.asarray(mean, dtype=np.float32)) / np.asarray(scale, dtype=np.float32)
    q = roundf((normalized / np.float32(in_scale)).astype(np.float32)).astype(np.int64) + int(in_zp)
    return np.clip(q, -128, 127).astype(np.int8)


# Per-model file names in paths.EDGE_BUILD_DIR. The main model keeps its
# original names (evaluate_models.py / the backend tests look for them).
SPECS = {
    "main": {"prefix": "edge", "features": FEATURES, "generate": generate, "hidden": (16, 8),
             "c_name": "edge_model_data", "header": "edge_model_data.h", "scaler": "scaler_params.json"},
    "lite": {"prefix": "edge_lite", "features": LITE_FEATURES, "generate": generate_lite, "hidden": (16, 8),
             "c_name": "edge_lite_model_data", "header": "edge_lite_model_data.h",
             "scaler": "edge_lite_scaler_params.json"},
}


def spec(model):
    s = dict(SPECS[model])
    p = s["prefix"]
    s.update(X=f"{p}_X.npy", y=f"{p}_y.npy", keras=f"{p}_model.keras", tflite=f"{p}_model_int8.tflite", name=model)
    return s


def model_arg(description):
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument("--model", choices=sorted(SPECS), default="main", help="which edge model (default main)")
    return parser


def main():
    parser = model_arg("Write the synthetic training data of an edge model.")
    parser.add_argument("out_dir", nargs="?", default=paths.EDGE_BUILD_DIR)
    args = parser.parse_args()
    s = spec(args.model)
    os.makedirs(args.out_dir, exist_ok=True)
    X, y = s["generate"]()
    np.save(os.path.join(args.out_dir, s["X"]), X)
    np.save(os.path.join(args.out_dir, s["y"]), y)
    counts = np.bincount(y, minlength=3)
    print(f"[{args.model}] wrote {len(y)} samples to {args.out_dir}: NORMAL {counts[0]}, WATCH {counts[1]}, "
          f"URGENT {counts[2]}")


if __name__ == "__main__":
    main()
