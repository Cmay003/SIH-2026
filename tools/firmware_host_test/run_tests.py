"""
Host-side checks for the Phase 2 firmware (no ESP32 needed):
  1. shared headers are identical in the node and gateway sketches
  2. packet layout, ACK matching and the LittleFS queue (compiled with g++
     against small Arduino/LittleFS stand-ins; queue_tests.h covers wrap,
     reboots, flash wear per push, corruption, capacity/format changes and
     a simulated power cut at every flash commit); protocol v1 packets and
     queued v1 records, reading_uid session starts (sj_session.h), the
     deep-sleep drain budget, the gateway's pop-after-upload rule, the
     node's gas/PM warm-up gate (sj_warmup.h) against config.h's times and
     the SOS button (sj_sos.h: hold/cooldown/stuck rules, SOS readings
     sent before a backlog and kept over deep sleep / a reboot on node and
     gateway - sos_tests.h), the village siren (sj_siren.h: offline
     fallback, on-time / cooldown / re-arm, commands, millis() wrap; the
     command in the gateway's ACK; the server's "commands" JSON; the
     gateway's table of commands waiting for their node, sj_siren_cmd.h -
     siren_tests.h; the command's HMAC and forgeries, a stale backlog
     reading never "confirming" a command, an empty / cut-off server answer
     never dropping one) and that node, gateway and server agree on the
     siren limits; a refused SOS no longer holding back the readings
     (sj_forward.h) and old backlog readings not counted as urgent;
     the offline SOS Wi-Fi (sj_hotspot.h: the SOS-message packet + ACK,
     UTF-8 cleaning / truncation, form + HTTP parsing, captive-portal
     routes, rate limit, one request per phone, outbox + NVS copy, pages -
     hotspot_tests.h) and that node and gateway agree on its defaults;
     protocol v3 (v2 readings widened + ACKed in v2, queued v2 records
     converted at the update) and the node's river rise rate + anomaly
     checks (sj_anomaly.h: a day of sensor noise with no flag, every check's
     true positive, real steps flagged once, bench scaling, gaps / clock
     restart / millis() wrap, and a doubtful value never sounding the
     offline siren - anomaly_tests.h); smart sending (sj_report.h: the
     NORMAL-mode summary's aggregation, compact encoding, packet and JSON;
     what goes at once and ahead of a backlog; the airtime figures quoted in
     sj_report.h; urgent readings overtaking a 2000-reading backlog after an
     outage on node and gateway with nothing lost or reordered -
     report_tests.h); the optional gas / PM duty cycle (sj_duty.h: timing,
     millis() wrap, never a cold value - also with lost PMS5003 commands -,
     the reports that carry the values, the hold while elevated, the
     on-time behind config.h's energy estimate - duty_tests.h)
     The edge models' inputs (sj_edge_input.h: main / lite input mapping,
     absent sensors, a doubted rise rate, bench scale, int8 quantisation -
     and for 2 x 256 readings the exact int8 input tensor the Python
     training pipeline computed, edge_vectors_*.h - edge_tests.h), and the
     offline siren never acting on an edge verdict.
     The siren-command MAC (sj_auth.h) is recomputed with Python's hmac.
     The edge models' label rules (ml/make_edge_dataset.py) against the
     backend's thresholds (IMD heat, flood level, gas, flash-flood rates,
     landslide tilt score); the installed headers against var/edge_ai_build;
     with tensorflow installed, the golden and host-test vectors against
     the TFLite interpreter on the bytes the firmware embeds.
  3. the JSON the firmware sends is accepted by the backend's own
     pydantic models (ReadingBatch / RawReading in backend_server.py),
     including fast_rise / rise_rate_cm_per_min / edge_anomaly / summary;
     every "<check>:<field>" the firmware can send fits the backend's
     pattern; the node's fast-rise limits = the backend's flash-flood MEDIUM
     rates; the hotspot SOS JSON matches the /api/ingest/sos contract and
     the limits server.js applies; the hotspot pages load nothing from
     outside
  4. the pins in both config.h files: no clashes, flash/input-only/ADC2
     misuse, or 5 V outputs reaching a 3.3 V pin (tools/wiring)
  5. the firmware build tool's helpers (tools/firmware_build), e.g. a
     var/ on another drive than the repo

Run from the repo root:  venv/Scripts/python.exe tools/firmware_host_test/run_tests.py
What this can't check: compiling against the real ESP32 core, RadioLib,
sensors, LoRa radio behaviour, timing. That still needs the boards.
"""

import filecmp
import html.parser
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(os.path.dirname(HERE))
SHARED = ["sj_packet.h", "sj_auth.h", "sj_file_queue.h", "sj_hotspot.h", "sj_hotspot_ap.h"]
NODE_DIR = os.path.join(REPO, "firmware", "sanjeevni_lora_node")
GATEWAY_DIR = os.path.join(REPO, "firmware", "sanjeevni_lora_gateway")


def read_defines(path):
    """#define NAME <integer> -> {NAME: int}; other values are skipped."""
    values = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*#define\s+(\w+)\s+(\d+)(?:UL|U|L)?\b", line)
        if m:
            values[m.group(1)] = int(m.group(2))
    return values


def read_string_defines(path):
    """#define NAME "text" -> {NAME: text}."""
    values = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r'\s*#define\s+(\w+)\s+"([^"]*)"', line)
        if m:
            values[m.group(1)] = m.group(2)
    return values


class PageScan(html.parser.HTMLParser):
    """Collects what a hotspot page would load or link to."""

    def __init__(self):
        super().__init__()
        self.tags, self.urls, self.hindi = set(), [], 0

    def handle_starttag(self, tag, attrs):
        self.tags.add(tag)
        for name, value in attrs:
            if name in ("src", "href", "action", "formaction", "data"):
                self.urls.append(value or "")
            if name == "content" and value and "url=" in value:
                self.urls.append(value.split("url=", 1)[1])
            if name == "lang" and value == "hi":
                self.hindi += 1


def hotspot_checks(tmp):
    """The offline SOS Wi-Fi's JSON (sj_hotspot.h sjAppendSosMsgJson) against
    the /api/ingest/sos contract and the limits server.js applies, and its
    pages. Returns {check name: passed}."""
    lines = open(os.path.join(tmp, "hotspot_samples.jsonl"), encoding="utf-8").read().splitlines()
    full, bare, twelve = [json.loads(line) for line in lines]  # raises if not valid JSON
    keys = {"node_id", "sos_uid", "client_id", "people", "needs", "note", "latitude", "longitude", "age_seconds"}
    server = open(os.path.join(REPO, "server", "server.js"), encoding="utf-8").read()
    needs_m = re.search(r"const HOTSPOT_NEEDS = new Set\(\[([^\]]*)\]\)", server)
    server_needs = set(re.findall(r'"(\w+)"', needs_m.group(1))) if needs_m else None
    note_m = re.search(r"const HOTSPOT_NOTE_MAX = (\d+)", server)
    people_m = re.search(r"const HOTSPOT_PEOPLE_MAX = (\d+)", server)
    uid_m = re.search(r"const HOTSPOT_UID_PATTERN = /(.+)/;", server)
    packet = read_defines(os.path.join(NODE_DIR, "sj_packet.h"))
    hindi_note = 'Near "temple" <b> \u092c\u093e\u0922\u093c \u092e\u0947\u0902 \u092b\u0901\u0938\u0947'
    checks = {
        "SOS JSON: exactly the contract's keys": all(set(x) == keys for x in (full, bare, twelve)),
        "SOS JSON: values + types": (full["node_id"], full["sos_uid"], full["client_id"], full["people"],
                                     full["latitude"], full["longitude"], full["age_seconds"])
        == ("NODE-07", "3000000003-h2", "ab12cd34", 4, 30.3165, -78.0322, 125)
        and isinstance(full["people"], int) and isinstance(full["latitude"], float),
        "SOS JSON: Hindi + quotes + markup survive the escaping": full["note"] == hindi_note,
        "SOS JSON: not given -> null / [] / \"\" (contract)": (bare["people"], bare["needs"], bare["note"],
                                                         bare["latitude"], bare["longitude"], bare["age_seconds"])
        == (None, [], "", None, None, None),
        "SOS JSON: 12-char node id, 32-bit uid": (twelve["node_id"], twelve["sos_uid"])
        == ("NODE.INDB-12", "4294967295-h4294967295"),
        "server.js HOTSPOT_NEEDS found and == the firmware's needs": server_needs == {
            "trapped", "injured", "medical", "fire"} and set(full["needs"]) == server_needs,
        "SJ_SOS_NOTE_MAX (bytes) <= server.js HOTSPOT_NOTE_MAX (chars)": bool(note_m)
        and packet.get("SJ_SOS_NOTE_MAX", 10**9) <= int(note_m.group(1)),
        "SJ_SOS_PEOPLE_MAX == server.js HOTSPOT_PEOPLE_MAX": bool(people_m)
        and packet.get("SJ_SOS_PEOPLE_MAX") == int(people_m.group(1)),
        "sos_uid matches server.js HOTSPOT_UID_PATTERN": bool(uid_m) and all(
            re.fullmatch(uid_m.group(1).strip("^$"), x["sos_uid"]) for x in (full, bare, twelve)),
    }
    for name in ("hotspot_form.html", "hotspot_status.html"):
        page = open(os.path.join(tmp, name), encoding="utf-8").read()
        scan = PageScan()
        scan.feed(page)
        local = all(u.startswith("/") and not u.startswith("//") for u in scan.urls)
        checks[f"{name}: loads / links nothing outside the hotspot"] = local and not (
            scan.tags & {"script", "link", "img", "iframe", "object", "embed"})
        checks[f"{name}: English + Hindi"] = scan.hindi >= 2 and "SOS" in page
    return checks


def auth_checks(tmp):
    """sj_auth.h's node-key derivation and ACK_CMD MAC (siren_tests.h
    authTests wrote the vectors) recomputed with Python's hmac - the same
    computation as the key command in the node's secrets.example.h."""
    import hashlib
    import hmac
    lines = open(os.path.join(tmp, "auth_samples.jsonl"), encoding="utf-8").read().splitlines()
    samples = [json.loads(line) for line in lines]
    keys_ok, macs_ok = len(samples) == 3, len(samples) == 3
    for x in samples:
        master = bytes.fromhex(x["master"])
        node_key = hmac.new(master, x["node_id"].encode(), hashlib.sha256).digest()[:16]
        keys_ok &= node_key.hex() == x["node_key"]
        ack = bytes.fromhex(x["ack_cmd"])
        macs_ok &= len(ack) == 34 and hmac.new(node_key, ack[:26], hashlib.sha256).digest()[:8] == ack[26:]
    return {
        "node key = HMAC-SHA256(master, NODE_ID)[:16], as secrets.example.h computes it": keys_ok,
        "ACK_CMD MAC = HMAC-SHA256(node key, first 26 bytes)[:8]": macs_ok,
    }


def c_string_array(text, name):
    """static const char* const NAME[] = {"a", "b"}; -> ["a", "b"] (None if absent)."""
    m = re.search(name + r"\[\]\s*=\s*\{([^}]*)\}", text)
    return re.findall(r'"([^"]*)"', m.group(1)) if m else None


def read_float_define(path, name):
    """#define NAME 1.0f -> 1.0 (None if absent or not a plain number)."""
    m = re.search(r"#define\s+" + name + r"\s+([0-9.]+)f?\b", open(path, encoding="utf-8").read())
    return float(m.group(1)) if m else None


def edge_contract_checks():
    """The node's anomaly names and fast-rise limits against the backend lane's
    code (backend_server.EDGE_ANOMALY_PATTERN / RawReading fields,
    hazard_classification flash-flood rates). Needs backend/ on sys.path."""
    import backend_server  # noqa: E402 - already imported by the caller
    import hazard_classification  # noqa: E402
    packet = open(os.path.join(NODE_DIR, "sj_packet.h"), encoding="utf-8").read()
    fields = c_string_array(packet, "SJ_AF_NAMES") or []
    checks_ = c_string_array(packet, "SJ_AC_NAMES") or []
    pattern = getattr(backend_server, "EDGE_ANOMALY_PATTERN", None)
    items = [f"{c}:{f}" for c in checks_ for f in fields]
    cfg = os.path.join(NODE_DIR, "config.h")
    fast = read_float_define(cfg, "FAST_RISE_CM_PER_MIN")
    bench = read_float_define(cfg, "FAST_RISE_BENCH_FRACTION_PER_MIN")
    medium = getattr(hazard_classification, "FLASH_FLOOD_MEDIUM_RATE_M_PER_HR", None)
    bench_fracs = getattr(hazard_classification, "FLASH_FLOOD_BENCH_FRACTIONS_PER_MIN", None)
    cm_per_min = getattr(hazard_classification, "CM_PER_MIN_TO_M_PER_HR", 0.6)
    return {
        "anomaly names found: 4 checks x 6 fields": len(checks_) == 4 and len(fields) == 6,
        "every \"<check>:<field>\" fits backend EDGE_ANOMALY_PATTERN": pattern is not None and all(
            pattern.match(i) for i in items),
        "anomaly field names are backend RawReading fields": all(
            f in backend_server.RawReading.model_fields for f in fields),
        "FAST_RISE_CM_PER_MIN == backend flash-flood MEDIUM (cm/min)": fast is not None and medium is not None
        and abs(fast * cm_per_min - medium) < 1e-9,
        "FAST_RISE_BENCH_FRACTION_PER_MIN == backend bench MEDIUM fraction": bench is not None
        and bool(bench_fracs) and abs(bench - bench_fracs[0]) < 1e-9,
    }


def c_float_array(text, name):
    """static const float NAME[n] = {1.0f, ...}; -> [floats] (None if absent)."""
    m = re.search(re.escape(name) + r"\[\d+\]\s*=\s*\{([^}]*)\}", text)
    return [float(v.strip().rstrip("fF")) for v in m.group(1).split(",")] if m else None


def edge_model_checks():
    """The two edge models: ml/make_edge_dataset.py's label rules against the
    backend's own thresholds (IMD heat, flood level, gas, flash-flood rates,
    the landslide tilt score), the node's config.h / sj_edge_input.h against
    the training code, the installed headers against var/edge_ai_build, and
    - with tensorflow installed - the headers' golden vectors and the host-
    test vectors against the TFLite interpreter running the very model bytes
    the firmware embeds. Needs backend/ on sys.path. Returns {check: passed}."""
    import numpy as np  # noqa: E402 - the backend's dependency anyway
    import backend_server  # noqa: E402 - already imported by the caller
    import hazard_classification as hc  # noqa: E402
    import integration_pipeline  # noqa: E402
    from rag_alert_pipeline import severity_band  # noqa: E402
    sys.path.insert(0, os.path.join(REPO, "ml"))
    import make_edge_dataset as med  # noqa: E402

    cfg = os.path.join(NODE_DIR, "config.h")
    cfg_int = read_defines(cfg)
    edge_input = open(os.path.join(NODE_DIR, "sj_edge_input.h"), encoding="utf-8").read()
    headers = {m: open(os.path.join(NODE_DIR, med.spec(m)["header"]), encoding="utf-8").read() for m in med.SPECS}
    rise_min = re.search(r"#define SJ_EDGE_RISE_X_MIN (-?[0-9.]+)f", edge_input)
    rise_max = re.search(r"#define SJ_EDGE_RISE_X_MAX (-?[0-9.]+)f", edge_input)
    pairs = [(0.0, 0.0), (5.0, 0.1), (8.6, 0.0), (12.0, 0.8), (15.0, 0.0), (15.0, 1.4), (30.0, 3.0)]
    tilt_same = all(
        round(med.tilt_score(t, v), 4) == hc.classify_landslide({"tilt_angle_deg": t, "vibration_magnitude": v})[
            "risk_score"] for t, v in pairs)
    f32 = lambda values: [float(np.float32(v)) for v in values]  # noqa: E731
    checks = {
        "edge heat WATCH = IMD heat wave (backend IMD_HEAT_WAVE_ACTUAL_C, 45 C)":
            med.HEAT_WATCH_C == hc.IMD_HEAT_WAVE_ACTUAL_C == 45.0,
        "edge heat URGENT = IMD severe heat wave (IMD_SEVERE_HEAT_WAVE_ACTUAL_C, 47 C)":
            med.HEAT_URGENT_C == hc.IMD_SEVERE_HEAT_WAVE_ACTUAL_C == 47.0,
        "node LOCAL_TEMP_LIMIT_C = IMD heat wave": read_float_define(cfg, "LOCAL_TEMP_LIMIT_C")
        == hc.IMD_HEAT_WAVE_ACTUAL_C,
        "edge river URGENT = backend FLOOD_CRITICAL_LEVEL_M": med.LEVEL_URGENT_M == backend_server.FLOOD_CRITICAL_LEVEL_M,
        "edge gas URGENT = backend GAS_LEAK_THRESHOLD_PPM = GAS_CRITICAL_PPM = node SIREN_LOCAL_GAS_PPM":
            med.GAS_URGENT_PPM == integration_pipeline.GAS_LEAK_THRESHOLD_PPM == backend_server.GAS_CRITICAL_PPM
            == cfg_int.get("SIREN_LOCAL_GAS_PPM"),
        "lite rise WATCH (x fast-rise limit) = backend flash-flood HIGH / MEDIUM rate": abs(
            med.RISE_WATCH_X - hc.FLASH_FLOOD_HIGH_RATE_M_PER_HR / hc.FLASH_FLOOD_MEDIUM_RATE_M_PER_HR) < 1e-9,
        "lite tilt score = backend classify_landslide tilt risk (7 points)": tilt_same,
        "lite tilt WATCH / URGENT = severity_band MEDIUM / HIGH edges": severity_band(med.TILT_WATCH_SCORE) == "LOW"
        and severity_band(med.TILT_WATCH_SCORE + 1e-6) == "MEDIUM" and severity_band(med.TILT_URGENT_SCORE) == "MEDIUM"
        and severity_band(med.TILT_URGENT_SCORE + 1e-6) == "HIGH",
        "rise clamp: sj_edge_input.h = make_edge_dataset.py": bool(rise_min and rise_max)
        and (float(rise_min.group(1)), float(rise_max.group(1))) == (med.RISE_X_MIN, med.RISE_X_MAX),
        "lite header absent values = make_edge_dataset.LITE_ABSENT, every one calm": f32(c_float_array(
            headers["lite"], "EDGE_LITE_ABSENT") or []) == f32([med.LITE_ABSENT[f] for f in med.LITE_FEATURES])
        and med.label_lite(*[med.LITE_ABSENT[f] for f in med.LITE_FEATURES]) == 0,
        "header input order = make_edge_dataset features": all(
            f"// input order: {', '.join(med.spec(m)['features'])}" in headers[m] for m in med.SPECS),
    }
    for m in med.SPECS:
        s = med.spec(m)
        built = os.path.join(REPO, "var", "edge_ai_build", s["header"])
        if os.path.exists(built):
            same = open(built, encoding="utf-8").read() == headers[m]
            checks[f"{m}: firmware {s['header']} = var/edge_ai_build build"] = same
            scaler = json.load(open(os.path.join(os.path.dirname(built), s["scaler"]), encoding="utf-8"))
            prefix = "EDGE" if m == "main" else "EDGE_LITE"
            checks[f"{m}: header MEAN / SCALE = the training scaler (as float32)"] = f32(c_float_array(
                headers[m], f"{prefix}_FEATURE_MEAN") or []) == f32(scaler["mean"]) and f32(c_float_array(
                headers[m], f"{prefix}_FEATURE_SCALE") or []) == f32(scaler["scale"])
    checks.update(edge_tflite_checks(headers))
    return checks


def edge_tflite_checks(headers):
    """The golden vectors (run by the node at setup) and the host-test vectors'
    classes against the TFLite interpreter on the model bytes embedded in the
    firmware headers. Skipped (no checks) without tensorflow."""
    try:
        os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
        import numpy as np  # noqa: E402
        sys.path.insert(0, os.path.join(REPO, "ml"))
        import quantize_edge_model as qem  # noqa: E402 - imports tensorflow
    except Exception as exc:  # noqa: BLE001 - tensorflow is optional (requirements-training.txt)
        print(f"   (edge models: TFLite checks skipped - {type(exc).__name__}: no tensorflow)")
        return {}
    import make_edge_dataset as med  # noqa: E402
    checks = {}
    with tempfile.TemporaryDirectory() as tmp:
        for m in med.SPECS:
            s = med.spec(m)
            text = headers[m]
            body = text.split(f"{s['c_name']}[]", 1)[-1]
            path = os.path.join(tmp, f"{m}.tflite")
            with open(path, "wb") as f:
                f.write(bytes(int(h, 16) for h in re.findall(r"0x([0-9a-fA-F]{2})", body)))
            model = qem.Int8Model(path)
            prefix = "EDGE" if m == "main" else "EDGE_LITE"
            mean = np.array(c_float_array(text, f"{prefix}_FEATURE_MEAN"), dtype=np.float32)
            scale = np.array(c_float_array(text, f"{prefix}_FEATURE_SCALE"), dtype=np.float32)
            g = re.search(rf"{prefix}_GOLDEN_INPUT\[\d+\]\[\d+\]\s*=\s*\{{(.*?)\n\}};", text, re.S)
            golden = [[float(v.strip().rstrip("fF")) for v in row.split(",")]
                      for row in re.findall(r"\{([^{}]*)\}", g.group(1))] if g else []
            gc = re.search(rf"{prefix}_GOLDEN_CLASS\[\d+\]\s*=\s*\{{([^}}]*)\}}", text)
            want = [int(v) for v in gc.group(1).split(",")] if gc else []
            got = [model.classify_q(qem.quantize_inputs(row, mean, scale, model.in_scale, model.in_zp))
                   for row in golden]
            checks[f"{m}: {len(golden)} golden vectors = TFLite interpreter on the embedded bytes"] = bool(
                golden) and got == want
            vec_text = open(os.path.join(HERE, f"edge_vectors_{m}.h"), encoding="utf-8").read()
            rows = re.findall(r"\{\{?([-0-9, ]+)\{([-0-9, ]+)\}, (\d)\}", vec_text)
            vec_ok = bool(rows) and all(
                model.classify_q(np.array([int(v) for v in q.split(",")][:len(mean)], dtype=np.int8)) == int(c)
                for _, q, c in rows)
            checks[f"{m}: host-test vectors' classes ({len(rows)}) = TFLite interpreter"] = vec_ok
    return checks


def summary_checks(tmp):
    """The NORMAL-mode summary (report_tests.h jsonSamples) against the
    contract and the backend lane's ReadingSummary. Returns {check: passed}."""
    import backend_server  # noqa: E402 - already imported by the caller
    lines = open(os.path.join(tmp, "summary_samples.jsonl"), encoding="utf-8").read().splitlines()
    full_j, water_j, urgent_j = [json.loads(line) for line in lines]  # raises if not valid JSON
    packet = open(os.path.join(NODE_DIR, "sj_packet.h"), encoding="utf-8").read()
    fields = c_string_array(packet, "SJ_AF_NAMES") or []
    want = {  # what jsonSamples() put in, decoded (PM2.5 rounded outward: 20..900 -> 19..903)
        "river_level_m": {"min": 1.201, "max": 1.234, "mean": 1.22},
        "temp_c": {"min": -1.8, "max": -1.5, "mean": -1.6},
        "humidity_pct": {"min": 64.0, "max": 65.43, "mean": 65.0},
        "gas_ppm": {"min": 900, "max": 950, "mean": 930},
        "pm25_ugm3": {"min": 19, "max": 903, "mean": 95},
        "tilt_angle_deg": {"min": 7.0, "max": 7.12, "mean": 7.06},
    }
    summary_model = getattr(backend_server, "ReadingSummary", None)
    raw_fields = backend_server.RawReading.model_fields
    checks = {
        "summary JSON: contract keys (samples, window_s, max_edge_risk_level, 6 fields)": set(full_j.get(
            "summary", {})) == {"samples", "window_s", "max_edge_risk_level", *fields} and len(fields) == 6,
        "summary JSON: values decoded, min <= mean <= max": full_j["summary"].get("samples") == 12
        and full_j["summary"].get("window_s") == 55 and full_j["summary"].get("max_edge_risk_level") == "WATCH"
        and all(full_j["summary"].get(f) == v for f, v in want.items()),
        "summary JSON: top-level values = the latest sample": (full_j["river_level_m"], full_j["temp_c"],
                                                               full_j["pm25_ugm3"]) == (1.234, -1.5, 140),
        "summary JSON: water-only node, no edge model -> one field, no max_edge_risk_level": set(
            water_j.get("summary", {})) == {"samples", "window_s", "river_level_m"},
        "summary JSON: an urgent reading carries none": "summary" not in urgent_j
        and urgent_j.get("edge_risk_level") == "WATCH",
        "backend RawReading has a summary field": "summary" in raw_fields,
        "backend ReadingSummary has every field the firmware sends": summary_model is not None and all(
            k in summary_model.model_fields for k in ("samples", "window_s", "max_edge_risk_level", *fields)),
    }
    if "summary" in raw_fields and summary_model is not None:
        full = backend_server.RawReading(**full_j)
        water = backend_server.RawReading(**water_j)
        urgent = backend_server.RawReading(**urgent_j)
        s = full.summary
        checks["backend keeps the summary (nothing dropped as invalid)"] = s is not None and (
            s.samples, s.window_s, s.max_edge_risk_level) == (12, 55, "WATCH") and all(
            s.stats(f) == {k: float(x) for k, x in v.items()} for f, v in want.items())
        checks["backend keeps the water-only summary"] = water.summary is not None and water.summary.stats(
            "river_level_m") == {"min": 2.49, "max": 2.5, "mean": 2.496} and water.summary.max_edge_risk_level is None \
            and water.summary.temp_c is None
        checks["backend: no summary -> None"] = urgent.summary is None
    return checks


def config_variant_checks(compiler, tmp):
    """Every node variant of tools/firmware_build/compile_variants.py against
    the node's config.h static_asserts, on the PC (g++ -fsyntax-only on
    config.h with the variant's overrides): a must-fail variant must be
    refused with its message, every other one accepted - so the variant list
    and config.h can't drift apart between two arduino-cli runs. Also pins
    the report interval in force (decision 2026-10-09: 60 s on a siren node,
    300 s without one). Returns {check name: passed}."""
    sys.path.insert(0, os.path.join(REPO, "tools", "firmware_build"))
    import compile_variants as cv  # noqa: E402

    interval = {"node-default": 60000, "node-no-siren": 300000, "node-no-siren-5min": 300000}
    # gas / PM duty cycle: reports per wake (PMS5003, MQ135) - 5-min nodes
    # every report / every 2nd, a siren node (1-min) every 5th / 10th
    duty_every = {"node-duty-pms": (1, 2), "node-duty-gas-pm": (1, 2), "node-duty-pms-set-pin": (5, 10)}
    # edge model in force (config.h EDGE_MODEL_IN_USE: 0 none, 1 main, 2 lite)
    edge_model = {"node-default": 1, "node-duty-pms": 1, "node-deepsleep-lora": 2, "node-deepsleep-wifi": 2,
                  "node-tilt-only": 2, "node-duty-gas-pm": 2, "node-edge-lite": 2, "node-edge-none": 0}
    model_names = {0: "none", 1: "main", 2: "lite"}
    checks = {}
    for name, sketch, overrides, expected_error in cv.VARIANTS:
        if sketch != "sanjeevni_lora_node":
            continue
        work = os.path.join(tmp, "cfg_" + name)
        os.makedirs(work, exist_ok=True)
        shutil.copy(os.path.join(NODE_DIR, "config.h"), os.path.join(work, "config.h"))
        cv.apply_overrides(os.path.join(work, "config.h"), overrides)
        stub = '#include "Arduino.h"\n#include "config.h"\n'
        if name in interval:
            stub += (f"static_assert(NORMAL_REPORT_INTERVAL_MS == {interval[name]}UL, "
                     f'"report interval in force: expected {interval[name] // 1000} s");\n')
        if name in duty_every:
            pm_n, gas_n = duty_every[name]
            stub += (f"static_assert(SJ_DUTY_EVERY_N(PMS5003_DUTY_PERIOD_S) == {pm_n} && "
                     f"SJ_DUTY_EVERY_N(MQ135_DUTY_PERIOD_S) == {gas_n}, \"duty cycle: reports per wake\");\n")
        if name in edge_model:
            stub += (f"static_assert(EDGE_MODEL_IN_USE == {edge_model[name]}, "
                     f'"edge model in force: expected {model_names[edge_model[name]]}");\n')
        src = os.path.join(work, "stub.cpp")
        with open(src, "w", encoding="utf-8") as f:
            f.write(stub)
        run = subprocess.run([compiler, "-std=c++17", "-fsyntax-only", "-I", HERE, src],
                             capture_output=True, text=True)
        if expected_error is None:
            label = f"{name}: config.h accepted" + (f", interval {interval[name] // 1000} s" if name in interval else "")
            if name in duty_every:
                label += f", PM / gas in every {duty_every[name][0]}. / {duty_every[name][1]}. report"
            if name in edge_model:
                label += f", {model_names[edge_model[name]]} edge model"
            checks[label] = run.returncode == 0
            if run.returncode != 0:
                print(run.stderr[:1500])
        else:
            checks[f"{name}: refused with \"{expected_error}\""] = run.returncode != 0 and expected_error in run.stderr
    must_fail = [v[0] for v in cv.VARIANTS if v[3]]
    checks["node-slow-report is a SIREN node at 300 s"] = any(
        v[0] == "node-slow-report" and v[2].get("SIREN_PIN", "12") != "-1"
        and v[2].get("SIREN_REPORT_INTERVAL_MS") == "300000UL" for v in cv.VARIANTS) and "node-slow-report" in must_fail
    names = {v[0] for v in cv.VARIANTS}
    checks["edge-model variants listed (lite, none build; main without gas must fail)"] = {
        "node-edge-lite", "node-edge-none"} <= names and "node-edge-main-no-gas" in must_fail
    checks["duty-cycle variants listed (3 build, 4 must fail - MQ135 duty cycle on a siren node too)"] = set(
        duty_every) <= names and {"node-duty-gas-no-pin", "node-duty-heater-pin-taken", "node-duty-set-strapping",
                                  "node-duty-gas-siren"} <= set(must_fail)
    return checks


def duty_wiring_checks(shipped_output):
    """The duty-cycle pin choices of compile_variants.py through the wiring
    tool's checks (--set: config.h is not edited): the shipped node has no
    free output-capable GPIO for an extra switch, the variants' pins pass,
    a clash and a strapping pin are ERRORs. Returns {check name: passed}."""
    sys.path.insert(0, os.path.join(REPO, "tools", "firmware_build"))
    import compile_variants as cv  # noqa: E402

    tool = os.path.join(REPO, "tools", "wiring", "generate_wiring.py")
    variants = {v[0]: v[2] for v in cv.VARIANTS}

    def run(overrides):
        cmd = [sys.executable, tool, "--check"]
        for k, v in overrides.items():
            cmd += ["--set", f"{k}={v}"]
        return subprocess.run(cmd, capture_output=True, text=True)

    checks = {"shipped node: no free output-capable GPIO (so the heater MOSFET needs a sensor dropped)":
              "free output-capable GPIOs: none" in shipped_output}
    for name in ("node-duty-gas-pm", "node-duty-pms-set-pin"):
        r = run(variants[name])
        checks[f"{name}: 0 wiring errors"] = r.returncode == 0 and "0 wiring error(s)" in r.stdout
    sys.path.insert(0, os.path.join(REPO, "tools", "wiring"))
    import generate_wiring as gw  # noqa: E402
    c = gw.parse_config(gw.NODE_CFG)
    c.update({k: int(v, 0) for k, v in variants["node-duty-gas-pm"].items()})
    mods = gw.node_modules(c)
    heater = [m for m in mods if m["name"] == "MQ135 heater switch"]
    checks["node-duty-gas-pm: heater MOSFET drawn on GPIO33, with its 10k pull-down and own parts line"] = bool(
        heater) and heater[0]["signals"][0][1] == "MQ135_HEATER_PIN" and c["MQ135_HEATER_PIN"] == 33 and any(
        "150 mA" in i for i in gw.parts_list(c, mods)) and not any("12 V supply" in i and "heater" in i
                                                                    for i in gw.parts_list(c, mods))
    clash = run(variants["node-duty-heater-pin-taken"])
    checks["heater on the pH pin: ERROR GPIO33 used twice"] = clash.returncode == 1 and "GPIO33 is used twice" in clash.stdout
    strap = run(variants["node-duty-set-strapping"])
    checks["PMS5003 SET on GPIO12: ERROR (module pull-up = 1.8 V flash)"] = strap.returncode == 1 and \
        "PMS5003_SET_PIN" in strap.stdout and "won't boot" in strap.stdout
    return checks


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
        from backend_server import RawReading, ReadingBatch  # noqa: E402 - heavy import, only needed here
        from pydantic import ValidationError  # noqa: E402

        lines = open(samples, encoding="utf-8").read().splitlines()
        readings = [json.loads(line) for line in lines]  # raises if not valid JSON
        sos_only_json = readings.pop()  # the last sample must be REFUSED (no sensor values)
        batch = ReadingBatch(readings=readings)
        full, core, tilt_only, sos, siren_cmd, siren_auto, siren_idle, edge_fast, edge_fall, edge_tilt = batch.readings
        siren_cmd_json, siren_auto_json, siren_idle_json = readings[4:7]
        edge_fast_json, edge_fall_json, edge_tilt_json = readings[7:10]
        try:
            RawReading(**sos_only_json)
            sos_only_refused = False
        except ValidationError:
            sos_only_refused = True
        checks = {
            "12-char node id kept intact": full.node_id == "NODE-INDB-12",
            "reading_uid = session-seq (32-bit session)": full.reading_uid == "3000000003-9",
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
            "SOS button: sos_button true, measurements kept": sos.sos_button is True
            and readings[3].get("sos_button") is True
            and (sos.node_id, sos.reading_uid, sos.river_level_m, sos.temp_c, sos.age_seconds) == ("NODE-07", "77-12", 2.1, 24.0, 400),
            "no SOS: field omitted, model default False": all(
                "sos_button" not in r for r in readings[:3]) and not any(x.sos_button for x in (full, core, tilt_only)),
            "SOS flag alone (no sensor answered): sent, but the backend refuses it as a reading": sos_only_json.get(
                "sos_button") is True and sos_only_refused,
            # village siren - the JSON contract, firmware side...
            "siren JSON: by command": (siren_cmd_json.get("siren_fitted"), siren_cmd_json.get("siren_on"),
                                       siren_cmd_json.get("siren_reason")) == (True, True, "command"),
            "siren JSON: node's offline fallback": (siren_auto_json.get("siren_on"),
                                                    siren_auto_json.get("siren_reason")) == (True, "auto_offline"),
            "siren JSON: fitted but silent -> siren_on / siren_reason omitted": siren_idle_json.get(
                "siren_fitted") is True and "siren_on" not in siren_idle_json and "siren_reason" not in siren_idle_json,
            "siren JSON: no siren -> no siren fields": not any(
                k.startswith("siren") for r in readings[:4] for k in r),
            # ...and the backend's RawReading keeps the fields (the backend lane adds them)
            "backend RawReading has siren_fitted / siren_on / siren_reason": (
                getattr(siren_cmd, "siren_fitted", None), getattr(siren_cmd, "siren_on", None),
                getattr(siren_cmd, "siren_reason", None), getattr(siren_auto, "siren_reason", None),
                getattr(siren_idle, "siren_on", None)) == (True, True, "command", "auto_offline", False),
            # the node's rise rate + anomaly checks (sj_anomaly.h) - firmware side...
            "edge JSON: fast rise + its rate": (edge_fast_json.get("fast_rise"),
                                                edge_fast_json.get("rise_rate_cm_per_min")) == (True, 2.5),
            "edge JSON: anomalies as \"<check>:<field>\"": edge_fast_json.get("edge_anomaly")
            == ["stuck:gas_ppm", "dropout:temp_c"]
            and edge_fall_json.get("edge_anomaly") == ["spike:river_level_m", "rate:river_level_m"],
            "edge JSON: not fast -> fast_rise omitted, rate still sent (falling = negative)": "fast_rise" not in
            edge_fall_json and edge_fall_json.get("rise_rate_cm_per_min") == -1.25,
            "edge JSON: no water level -> no rise fields": not any(
                k in edge_tilt_json for k in ("fast_rise", "rise_rate_cm_per_min"))
            and edge_tilt_json.get("edge_anomaly") == ["stuck:tilt_angle_deg"],
            "edge JSON: nothing flagged -> no edge fields": not any(
                k in r for r in readings[:7] for k in ("fast_rise", "rise_rate_cm_per_min", "edge_anomaly")),
            # ...and the backend's RawReading keeps them (the backend lane adds them)
            "backend RawReading keeps fast_rise / rise_rate_cm_per_min / edge_anomaly": (
                getattr(edge_fast, "fast_rise", None), getattr(edge_fast, "rise_rate_cm_per_min", None),
                getattr(edge_fast, "edge_anomaly", None), getattr(edge_fall, "fast_rise", None),
                getattr(edge_fall, "rise_rate_cm_per_min", None), getattr(edge_fall, "edge_anomaly", None),
                getattr(edge_tilt, "edge_anomaly", None))
            == (True, 2.5, ["stuck:gas_ppm", "dropout:temp_c"], False, -1.25,
                ["spike:river_level_m", "rate:river_level_m"], ["stuck:tilt_angle_deg"]),
        }
        checks.update(edge_contract_checks())
        for name, passed in checks.items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

        print("\n   NORMAL-mode summary (contract \"summary\", backend ReadingSummary):")
        for name, passed in summary_checks(tmp).items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

        print("\n   edge models (ml/make_edge_dataset.py rules vs backend; headers vs build / TFLite):")
        for name, passed in edge_model_checks().items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

        print("\n   siren command authentication (sj_auth.h vs Python hmac):")
        for name, passed in auth_checks(tmp).items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

        print("\n   offline SOS Wi-Fi (/api/ingest/sos contract, server.js limits, pages):")
        for name, passed in hotspot_checks(tmp).items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

        print("\n   node config.h static_asserts vs the compile_variants.py list (g++ -fsyntax-only):")
        for name, passed in config_variant_checks(compiler, tmp).items():
            print(f"   {'ok  ' if passed else 'FAIL'} {name}")
            ok &= passed

    print("\n   siren defaults, node vs gateway config.h vs server siren.js:")
    node_cfg = read_defines(os.path.join(NODE_DIR, "config.h"))
    gw_cfg = read_defines(os.path.join(GATEWAY_DIR, "config.h"))
    siren_js = open(os.path.join(REPO, "server", "siren.js"), encoding="utf-8").read()
    server_max_m = re.search(r"const MAX_ON_SECONDS = (\d+)", siren_js)
    server_max = int(server_max_m.group(1)) if server_max_m else None
    siren_checks = {
        # siren_tests.h tests the gateway's table with the node's values
        "gateway SIREN_DEFAULT_ON_S == node SIREN_ON_S": gw_cfg.get("SIREN_DEFAULT_ON_S") == node_cfg.get("SIREN_ON_S"),
        "gateway SIREN_CMD_MAX_ON_S == node SIREN_MAX_ON_S":
            gw_cfg.get("SIREN_CMD_MAX_ON_S") == node_cfg.get("SIREN_MAX_ON_S"),
        "gateway SIREN_CMD_OFF_TTL_S == 900 (as tested)": gw_cfg.get("SIREN_CMD_OFF_TTL_S") == 900,
        # an officer's longest "on" must not be cut short by the firmware (it
        # stopped early, then the server re-commanded the rest)
        "server siren.js MAX_ON_SECONDS found and == node SIREN_MAX_ON_S": server_max is not None
        and node_cfg.get("SIREN_MAX_ON_S") == server_max,
        "gateway URGENT_MAX_AGE_S == 120 (as tested, report_tests.h)": gw_cfg.get("URGENT_MAX_AGE_S") == 120,
    }
    for name, passed in siren_checks.items():
        print(f"   {'ok  ' if passed else 'FAIL'} {name}")
        ok &= passed

    print("\n   offline SOS Wi-Fi defaults, node vs gateway config.h:")
    node_str = read_string_defines(os.path.join(NODE_DIR, "config.h"))
    gw_str = read_string_defines(os.path.join(GATEWAY_DIR, "config.h"))
    hotspot_defaults = {
        "same SSID": node_str.get("SOS_HOTSPOT_SSID") == gw_str.get("SOS_HOTSPOT_SSID") == "SANJEEVNI-SOS",
        "same limits (per window, window, per-phone gap)": all(
            node_cfg.get(k) == gw_cfg.get(k) is not None
            for k in ("SOS_HOTSPOT_MAX_PER_WINDOW", "SOS_HOTSPOT_WINDOW_S", "SOS_HOTSPOT_CLIENT_GAP_S")),
        "node default off, gateway default on": node_cfg.get("SOS_HOTSPOT_ENABLE") == 0
        and gw_cfg.get("SOS_HOTSPOT_ENABLE") == 1,
        "GATEWAY_ID is a valid node id (<= 12: letters, digits, - _ .)": bool(
            re.fullmatch(r"[A-Za-z0-9._-]{1,12}", gw_str.get("GATEWAY_ID", ""))),
    }
    for name, passed in hotspot_defaults.items():
        print(f"   {'ok  ' if passed else 'FAIL'} {name}")
        ok &= passed

    print("\n== 4. wiring in both config.h files (tools/wiring/generate_wiring.py --check) ==")
    wiring = subprocess.run([sys.executable, os.path.join(REPO, "tools", "wiring", "generate_wiring.py"), "--check"],
                            capture_output=True, text=True)
    print("   " + wiring.stdout.strip().replace("\n", "\n   "))
    ok &= wiring.returncode == 0

    print("\n   gas / PM duty-cycle pins (generate_wiring.py --set, the compile_variants.py choices):")
    for name, passed in duty_wiring_checks(wiring.stdout).items():
        print(f"   {'ok  ' if passed else 'FAIL'} {name}")
        ok &= passed

    print("\n== 5. firmware build tool (tools/firmware_build/test_compile_variants.py) ==")
    build_tool = subprocess.run(
        [sys.executable, os.path.join(REPO, "tools", "firmware_build", "test_compile_variants.py"), "-v"],
        capture_output=True, text=True, cwd=REPO,
    )
    print("   " + build_tool.stderr.strip().replace("\n", "\n   "))  # unittest reports on stderr
    ok &= build_tool.returncode == 0

    print("\nALL PASSED" if ok else "\nSOME CHECKS FAILED")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
