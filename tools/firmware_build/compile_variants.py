"""
SANJEEVNI - compile the ESP32 sketches in every configuration that matters,
so a config.h combination nobody has flashed yet can't hide a compile error.

Each variant is the real sketch with a few #define values overridden
(config.h is never edited). Variants marked "must fail" check that
config.h's static_asserts refuse an unsafe combination with the expected
message.

  venv/Scripts/python.exe tools/firmware_build/compile_variants.py
  ... --cli C:/path/arduino-cli.exe --config-file C:/path/arduino-cli.yaml
  ... --only node-deepsleep-lora gateway

Needs arduino-cli with the esp32:esp32 core and the libraries RadioLib,
"DHT sensor library", "Adafruit Unified Sensor" and Chirale_TensorFLowLite.
arduino-cli is found via --cli, the ARDUINO_CLI environment variable, or
PATH. Build output goes to var/fw_build/ (git-ignored; SANJEEVNI_VAR_DIR
moves var/ as for the backend); all variants of a
sketch share one build folder, so libraries compile once (the first run
takes several minutes, later ones far less).
"""

import argparse
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
FIRMWARE = os.path.join(REPO, "firmware")
VAR_DIR = os.environ.get("SANJEEVNI_VAR_DIR") or os.path.join(REPO, "var")  # as in backend/paths.py
BUILD_ROOT = os.path.join(VAR_DIR, "fw_build")
FQBN = "esp32:esp32:esp32"

DEEP_SLEEP_BATTERY = {"DEEP_SLEEP_ENABLED": "1", "ENABLE_GAS": "0", "ENABLE_PMS5003": "0"}

# name, sketch, #define overrides, expected error text (None = must compile)
VARIANTS = [
    ("node-default", "sanjeevni_lora_node", {}, None),
    ("node-deepsleep-lora", "sanjeevni_lora_node", DEEP_SLEEP_BATTERY, None),
    ("node-deepsleep-wifi", "sanjeevni_lora_node", {**DEEP_SLEEP_BATTERY, "TRANSPORT": "TRANSPORT_WIFI"}, None),
    # always-on WiFi node: its flushQueue() is called from loop(), one batch per call
    ("node-wifi", "sanjeevni_lora_node", {"TRANSPORT": "TRANSPORT_WIFI"}, None),
    # modular landslide node: only MPU6050 + battery, no self-test at boot
    ("node-tilt-only", "sanjeevni_lora_node",
     {"ENABLE_WATER_LEVEL": "0", "ENABLE_DHT": "0", "ENABLE_GAS": "0", "ENABLE_FLAME": "0",
      "ENABLE_RAIN_GAUGE": "0", "ENABLE_SOIL": "0", "ENABLE_PMS5003": "0", "ENABLE_PH": "0",
      "ENABLE_TURBIDITY": "0", "SELF_TEST_ON_POWER_ON": "0"}, None),
    ("node-deepsleep-with-mq135", "sanjeevni_lora_node", {"DEEP_SLEEP_ENABLED": "1", "ENABLE_PMS5003": "0"},
     "DEEP_SLEEP_ENABLED needs ENABLE_GAS 0"),
    ("gateway", "sanjeevni_lora_gateway", {}, None),
]


def shown_path(path):
    """`path` relative to the repo for the summary line, or absolute when that
    is impossible: on Windows os.path.relpath raises ValueError ("path is on
    mount 'C:', start on mount 'D:'") when SANJEEVNI_VAR_DIR puts var/ on
    another drive - which crashed the run after the first variant compiled."""
    try:
        return os.path.relpath(path, REPO)
    except ValueError:
        return os.path.abspath(path)


def find_cli(explicit):
    for candidate in (explicit, os.environ.get("ARDUINO_CLI"), shutil.which("arduino-cli")):
        if candidate and os.path.isfile(candidate):
            return candidate
    return None


def apply_overrides(config_path, overrides):
    with open(config_path, encoding="utf-8") as f:
        text = f.read()
    for name, value in overrides.items():
        pattern = re.compile(rf"^(#define {re.escape(name)}[ \t]+)(\S+)", re.MULTILINE)
        text, n = pattern.subn(lambda m: m.group(1) + value, text)
        if n != 1:
            raise SystemExit(f"{config_path}: expected exactly one '#define {name}', found {n}")
    with open(config_path, "w", encoding="utf-8", newline="") as f:  # closed before arduino-cli reads it
        f.write(text)


def prepare(sketch, overrides):
    """Copy the sketch to one fixed folder per sketch (keeps the build cache valid)."""
    work = os.path.join(BUILD_ROOT, "work", sketch)
    shutil.rmtree(work, ignore_errors=True)
    shutil.copytree(os.path.join(FIRMWARE, sketch), work)
    secrets = os.path.join(work, "secrets.h")
    if not os.path.exists(secrets):  # git-ignored: a fresh clone only has the example
        shutil.copy(os.path.join(work, "secrets.example.h"), secrets)
    apply_overrides(os.path.join(work, "config.h"), overrides)
    return work


def compile_one(cli, config_file, work, sketch, log_path, jobs):
    cmd = [cli]
    if config_file:
        cmd += ["--config-file", config_file]
    cmd += ["compile", "--fqbn", FQBN, "--warnings", "default", "--jobs", str(jobs),
            "--build-path", os.path.join(BUILD_ROOT, "build", sketch), work]
    start = time.time()
    run = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    output = run.stdout + run.stderr
    with open(log_path, "w", encoding="utf-8") as f:
        f.write(output)
    return run.returncode, output, time.time() - start


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cli", help="path to arduino-cli(.exe)")
    ap.add_argument("--config-file", help="arduino-cli.yaml to use (where the core + libraries are installed)")
    ap.add_argument("--only", nargs="*", help="variant names to build (default: all)")
    ap.add_argument("--jobs", type=int, default=4,
                    help="parallel compiler processes (default 4; arduino-cli's own default uses every core "
                         "and the TensorFlow Lite build can then exhaust RAM)")
    args = ap.parse_args()

    cli = find_cli(args.cli)
    if not cli:
        print("arduino-cli not found - pass --cli, set ARDUINO_CLI, or put it on PATH")
        return 2
    variants = [v for v in VARIANTS if not args.only or v[0] in args.only]
    if args.only and len(variants) != len(args.only):
        known = ", ".join(v[0] for v in VARIANTS)
        print(f"unknown variant in --only; known: {known}")
        return 2

    os.makedirs(os.path.join(BUILD_ROOT, "logs"), exist_ok=True)
    ok = True
    for name, sketch, overrides, expected_error in variants:
        work = prepare(sketch, overrides)
        log_path = os.path.join(BUILD_ROOT, "logs", f"{name}.log")
        code, output, secs = compile_one(cli, args.config_file, work, sketch, log_path, args.jobs)
        label = ", ".join(f"{k}={v}" for k, v in overrides.items()) or "config.h as committed"
        if expected_error is None:
            passed = code == 0
            usage = re.search(r"Sketch uses (\d+) bytes \((\d+)%\)", output)
            ram = re.search(r"Global variables use (\d+) bytes \((\d+)%\)", output)
            detail = (f"flash {usage.group(2)}%, RAM {ram.group(2)}%" if usage and ram else "") if passed else \
                "COMPILE ERROR:\n      " + "\n      ".join(
                    line.strip() for line in output.splitlines() if "error" in line.lower())[:1500]
        else:
            passed = code != 0 and expected_error in output
            detail = "refused as expected" if passed else (
                "compiled - the safety check did NOT fire" if code == 0 else
                f"failed, but without '{expected_error}'")
        print(f"{'ok  ' if passed else 'FAIL'} {name:28s} {secs:6.0f}s  {detail}")
        print(f"     ({label}; log: {shown_path(log_path)})")
        ok &= passed

    print("\nALL VARIANTS OK" if ok else "\nSOME VARIANTS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
