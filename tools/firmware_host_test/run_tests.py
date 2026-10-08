"""
Host-side checks for the Phase 2 firmware (no ESP32 needed):
  1. shared headers are identical in the node and gateway sketches
  2. packet layout, ACK matching and the LittleFS queue (compiled with g++
     against small Arduino/LittleFS stand-ins)
  3. the JSON the firmware sends is accepted by the backend's own
     pydantic models (ReadingBatch / RawReading in backend_server.py)
  4. the pins in both config.h files: no clashes, flash/input-only/ADC2
     misuse, or 5 V outputs reaching a 3.3 V pin (tools/wiring)

Run from the repo root:  venv/Scripts/python.exe tools/firmware_host_test/run_tests.py
What this can't check: compiling against the real ESP32 core, RadioLib,
sensors, LoRa radio behaviour, timing. That still needs the boards.
"""

import filecmp
import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SHARED = ["sj_packet.h", "sj_file_queue.h"]
NODE_DIR = os.path.join(REPO, "firmware", "sanjeevni_lora_node")
GATEWAY_DIR = os.path.join(REPO, "firmware", "sanjeevni_lora_gateway")


def main() -> int:
    ok = True

    print("== 1. shared headers identical in node and gateway ==")
    for name in SHARED:
        same = filecmp.cmp(os.path.join(NODE_DIR, name), os.path.join(GATEWAY_DIR, name), shallow=False)
        print(f"   {name}: {'identical' if same else 'DIFFERENT - copy the updated one to both sketches'}")
        ok &= same

    print("\n== 2. C++ logic tests ==")
    compiler = shutil.which("g++") or shutil.which("clang++")
    if not compiler:
        print("   no g++/clang++ found - skipped")
        return 1
    with tempfile.TemporaryDirectory() as tmp:
        exe = os.path.join(tmp, "firmware_test.exe")
        build = subprocess.run(
            [compiler, "-std=c++17", "-Wall", "-I", HERE, os.path.join(HERE, "test_firmware_logic.cpp"), "-o", exe],
            capture_output=True, text=True,
        )
        if build.returncode != 0:
            print(build.stdout + build.stderr)
            return 1
        if build.stderr.strip():
            print("   compiler warnings:\n" + build.stderr)
        samples = os.path.join(tmp, "samples.jsonl")
        run = subprocess.run([exe, tmp, samples], capture_output=True, text=True)
        print("   " + run.stdout.strip().replace("\n", "\n   "))
        ok &= run.returncode == 0

        print("\n== 3. firmware JSON accepted by the backend models ==")
        sys.path.insert(0, os.path.join(REPO, "backend"))
        from backend_server import ReadingBatch  # noqa: E402 - heavy import, only needed here

        lines = open(samples, encoding="utf-8").read().splitlines()
        readings = [json.loads(line) for line in lines]  # raises if not valid JSON
        batch = ReadingBatch(readings=readings)
        full, core, tilt_only = batch.readings
        checks = {
            "12-char node id kept intact": full.node_id == "NODE-INDB-12",
            "reading_uid = session-seq": full.reading_uid == "3-9",
            "fixed-point values decoded": (full.river_level_m, full.temp_c, full.soil_moisture_pct, full.water_ph)
            == (1.234, -1.5, 45.6, 6.12),
            "optional sensors present": None not in (full.tilt_angle_deg, full.pm25_ugm3, full.turbidity_ntu, full.battery_pct),
            "edge verdict + link + age": (full.edge_risk_level, full.link, full.age_seconds) == ("URGENT", "lora", 125),
            "unknown age omitted": core.age_seconds is None and "age_seconds" not in readings[1],
            "absent sensors omitted, not 0": core.soil_moisture_pct is None and core.water_ph is None and core.battery_pct is None,
            "no edge verdict -> omitted": core.edge_risk_level is None,
            "modular node: absent core sensors omitted": all(
                k not in readings[2] for k in ("river_level_m", "temp_c", "humidity_pct", "gas_ppm", "flame_reading")
            ),
            "modular node: tilt + battery decoded": (tilt_only.tilt_angle_deg, tilt_only.vibration_magnitude,
                                                     tilt_only.battery_pct) == (12.5, 0.4, 90.0),
        }
        for name, passed in checks.items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

    print("\n== 4. wiring in both config.h files (tools/wiring/generate_wiring.py --check) ==")
    wiring = subprocess.run([sys.executable, os.path.join(REPO, "tools", "wiring", "generate_wiring.py"), "--check"],
                            capture_output=True, text=True)
    print("   " + wiring.stdout.strip().replace("\n", "\n   "))
    ok &= wiring.returncode == 0

    print("\nALL PASSED" if ok else "\nSOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
