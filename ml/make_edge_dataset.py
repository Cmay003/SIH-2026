"""
SANJEEVNI - training data for the on-device edge model (B19: the original
script that produced edge_X.npy / edge_y.npy was never committed, so the
edge model could not be rebuilt).

Writes edge_X.npy (N x 5: river_level_m, temp_c, humidity_pct, gas_ppm,
flame 0/1) and edge_y.npy (0 NORMAL, 1 WATCH, 2 URGENT) into OUT_DIR.

Labels follow the SAME thresholds the backend uses, so the edge verdict
agrees with the cloud pipeline:
  URGENT: gas >= 800 ppm (GAS_LEAK_THRESHOLD_PPM), flame detected,
          river >= 3.5 m (FLOOD_CRITICAL_LEVEL_M), temp >= 45 C (IMD severe)
  WATCH:  river >= 2.75 m, gas >= 600 ppm, temp >= 40 C (IMD heat wave)
  NORMAL: otherwise
This is SYNTHETIC data - like the flood model, it shows the pipeline works,
not how the model behaves on a real river.

Full rebuild (needs requirements-training.txt), from the project folder.
Every step works in var\\edge_ai_build:
  .\\venv\\Scripts\\python.exe ml\\make_edge_dataset.py
  .\\venv\\Scripts\\python.exe ml\\train_edge_model.py
  .\\venv\\Scripts\\python.exe ml\\quantize_edge_model.py
  .\\venv\\Scripts\\python.exe ml\\verify_quantized_model.py
then copy var\\edge_ai_build\\edge_model_data.h into firmware\\sanjeevni_lora_node\\
and paste the printed EDGE_FEATURE_MEAN / EDGE_FEATURE_SCALE into edge_ai.h.
"""

import os
import sys

import numpy as np
import os as _os
import sys as _sys

# backend/ holds the shared modules + paths.py (file locations)
_sys.path.insert(0, _os.path.join(_os.path.dirname(_os.path.dirname(_os.path.abspath(__file__))), "backend"))
import paths  # noqa: E402

N_SAMPLES = 20000
SEED = 7


def label(level_m, temp_c, gas_ppm, flame):
    if gas_ppm >= 800 or flame >= 0.5 or level_m >= 3.5 or temp_c >= 45:
        return 2
    if level_m >= 2.75 or gas_ppm >= 600 or temp_c >= 40:
        return 1
    return 0


def generate(n=N_SAMPLES, seed=SEED):
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


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else paths.EDGE_BUILD_DIR
    os.makedirs(out_dir, exist_ok=True)
    X, y = generate()
    np.save(os.path.join(out_dir, "edge_X.npy"), X)
    np.save(os.path.join(out_dir, "edge_y.npy"), y)
    counts = np.bincount(y, minlength=3)
    print(f"wrote {len(y)} samples to {out_dir}: NORMAL {counts[0]}, WATCH {counts[1]}, URGENT {counts[2]}")


if __name__ == "__main__":
    main()
