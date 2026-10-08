"""
SANJEEVNI - wiring diagram + wiring checks, generated from the firmware's
own config.h files (so the drawing can never disagree with the code).

  venv/Scripts/python.exe tools/wiring/generate_wiring.py          # write docs/
  venv/Scripts/python.exe tools/wiring/generate_wiring.py --check  # checks only

Writes docs/wiring.html (diagrams + connection tables + parts list +
checks) and docs/wiring_node.svg / docs/wiring_gateway.svg (for slides).
Exit code 1 if a check finds an ERROR (pin clash, flash pin, 5 V into a
3.3 V pin, ...) - tools/firmware_host_test/run_tests.py runs it.

The diagrams are LOGICAL: pins are grouped per module, not in the order
they sit on your board's header (that differs between ESP32 boards).
Module facts below (supply voltages, output levels) are typical values
for the common breakout boards - check the datasheet of the exact module
you bought.
"""

import argparse
import html
import os
import re
import sys

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
NODE_CFG = os.path.join(REPO, "firmware", "sanjeevni_lora_node", "config.h")
GATEWAY_CFG = os.path.join(REPO, "firmware", "sanjeevni_lora_gateway", "config.h")
DOCS = os.path.join(REPO, "docs")

# ---- classic ESP32 (ESP32-WROOM-32 / DevKit) GPIO facts -----------------
FLASH_PINS = set(range(6, 12))           # wired to the SPI flash: never use
USB_SERIAL_PINS = {1, 3}                 # UART0 = USB Serial Monitor
INPUT_ONLY = {34, 35, 36, 37, 38, 39}    # no output driver, no internal pull-ups
ADC1 = set(range(32, 40))                # analog inputs that work with WiFi on
STRAPPING = {0: "must not be held LOW at boot", 2: "must not be held HIGH at boot",
             5: "must not be held LOW at boot", 12: "HIGH at boot selects 1.8 V flash - board won't boot",
             15: "must not be held LOW at boot (boot log)"}
VALID = set(range(0, 6)) | set(range(12, 20)) | {21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39}
ESP_ADC_MAX_V = 3.3  # absolute pin limit; ADC at 11 dB reads reliably up to ~3.1 V


def parse_config(path):
    """#define NAME value -> {NAME: int|float|bool|str}"""
    values = {}
    for line in open(path, encoding="utf-8"):
        m = re.match(r"\s*#define\s+(\w+)\s+([^/\n]+?)\s*(//.*)?$", line)
        if not m:
            continue
        raw = m.group(2).strip()
        val = raw
        if raw in ("true", "false"):
            val = raw == "true"
        else:
            num = re.sub(r"(UL|U|L|f)$", "", raw)
            try:
                val = int(num, 0)
            except ValueError:
                try:
                    val = float(num)
                except ValueError:
                    val = values.get(raw, raw)  # e.g. TRANSPORT TRANSPORT_LORA
        values[m.group(1)] = val
    return values


ESP_ADC_GOOD_V = 3.1  # ADC at 11 dB is accurate up to about here
STANDARD_DIVIDERS = [(1.5, "10k / 20k"), (2.0, "10k / 10k"), (3.0, "20k / 10k")]


def suggest_divider(level_v):
    """Smallest standard divider that keeps level_v within the ADC's good range."""
    for ratio, pair in STANDARD_DIVIDERS:
        if level_v / ratio <= ESP_ADC_GOOD_V:
            return ratio, pair
    return STANDARD_DIVIDERS[-1]


def divider_for(ratio, fast=False):
    """Resistor pair (R1 top, R2 bottom) giving Vin/Vout = ratio. 10k-range
    for analog sensors; 1k/2k only for a fast digital edge (HC-SR04 ECHO)."""
    if fast and abs(ratio - 1.5) < 1e-6:
        return "1k / 2k"
    for r, pair in STANDARD_DIVIDERS:
        if abs(r - ratio) < 1e-6:
            return pair
    for r2 in (2.0, 10.0, 20.0, 100.0):
        r1 = r2 * (ratio - 1)
        for nice in (1.0, 2.0, 4.7, 5.1, 10.0, 20.0, 47.0, 51.0, 100.0):
            if abs(r1 - nice) < 1e-6:
                return f"{nice:g}k / {r2:g}k"
    return f"R1 = {ratio - 1:.2f} x R2"


# ---- module catalogue ------------------------------------------------------
# signal: (module pin, config key, direction seen from the ESP32, extra)
#   direction: "out" ESP32 drives it, "in" ESP32 reads it, "io" both, "analog"
#   extra: dict(level_v=module output voltage, divider=ratio key, pullup=text)


def node_modules(c):
    lora = c.get("TRANSPORT") == c.get("TRANSPORT_LORA")
    mods = []
    if lora:
        mods.append(dict(name="SX1278 LoRa (Ra-02)", supply="3V3", note="3.3 V ONLY - 5 V destroys it. Fit the antenna before powering.",
                         signals=[("SCK", "LORA_SCK", "out", {}), ("MISO", "LORA_MISO", "in", {}), ("MOSI", "LORA_MOSI", "out", {}),
                                  ("NSS", "LORA_NSS", "out", {}), ("RST", "LORA_RST", "out", {}), ("DIO0", "LORA_DIO0", "in", {})]))
    if c.get("ENABLE_DHT"):
        mods.append(dict(name="DHT22 temp/humidity", supply="3V3", note="Bare sensor: 10k pull-up DATA->3V3 (modules have one).",
                         signals=[("DATA", "DHT_PIN", "io", {"pullup": "10k to 3V3 (if not on module)"})]))
    if c.get("ENABLE_WATER_LEVEL"):
        mods.append(dict(name="HC-SR04 water level", supply="5V", note="5 V module: ECHO must go through a divider.",
                         signals=[("TRIG", "ULTRASONIC_TRIG", "out", {}),
                                  ("ECHO", "ULTRASONIC_ECHO", "in", {"level_v": 5.0, "fixed_divider": 1.5})]))
    if c.get("ENABLE_FLAME"):
        mods.append(dict(name="IR flame sensor", supply="3V3", note="Power it from 3V3 so DO is a 3.3 V signal.",
                         signals=[("DO", "FLAME_PIN", "in", {"level_v": 3.3})]))
    if c.get("ENABLE_GAS"):
        mods.append(dict(name="MQ135 gas", supply="5V", note="Heater ~150 mA from 5 V, always on (no deep sleep).",
                         signals=[("AO", "MQ135_PIN", "analog", {"level_v": 5.0, "divider": "MQ135_ADC_DIVIDER_RATIO"})]))
    if c.get("ENABLE_RAIN_GAUGE"):
        mods.append(dict(name="Rain gauge (reed switch)", supply="-", note="Switch between the pin and GND.",
                         signals=[("reed", "RAIN_GAUGE_PIN", "in", {"pullup": "10k to 3V3 (REQUIRED)", "needs_external_pullup": True})]))
    if c.get("ENABLE_SOIL"):
        mods.append(dict(name="Capacitive soil moisture v1.2", supply="3V3", note="At 3.3 V supply AO stays below ~3 V.",
                         signals=[("AO", "SOIL_PIN", "analog", {"level_v": 3.0})]))
    if c.get("ENABLE_MPU6050"):
        mods.append(dict(name="MPU6050 tilt/vibration", supply="3V3", note=f"I2C address 0x{c.get('MPU6050_ADDR', 0x68):02X} (AD0 to GND).",
                         signals=[("SDA", "I2C_SDA", "io", {}), ("SCL", "I2C_SCL", "out", {})]))
    if c.get("ENABLE_PMS5003"):
        mods.append(dict(name="PMS5003 particulate", supply="5V", note="Fan needs 5 V; its UART is 3.3 V logic.",
                         signals=[("TX", "PMS_RX_PIN", "in", {"level_v": 3.3}), ("RX", "PMS_TX_PIN", "out", {})]))
    if c.get("ENABLE_PH"):
        mods.append(dict(name="pH board (PH-4502C)", supply="5V", note="Calibrate with pH 7 and pH 4 buffers ('p' command).",
                         signals=[("PO", "PH_PIN", "analog", {"level_v": 5.0, "divider": "PH_ADC_DIVIDER_RATIO"})]))
    if c.get("ENABLE_TURBIDITY"):
        mods.append(dict(name="Turbidity (SEN0189)", supply="5V", note="Output 0-4.5 V.",
                         signals=[("AO", "TURBIDITY_PIN", "analog", {"level_v": 4.5, "divider": "TURBIDITY_ADC_DIVIDER_RATIO"})]))
    if c.get("ENABLE_BATTERY"):
        mods.append(dict(name="18650 battery sense", supply="-", note="Divider from battery + to the pin (high values: tiny drain).",
                         signals=[("BAT+", "BATTERY_PIN", "analog", {"level_v": 4.2, "divider": "BATTERY_DIVIDER_RATIO", "big": True})]))
    if isinstance(c.get("SENSOR_POWER_PIN"), int) and c["SENSOR_POWER_PIN"] >= 0:
        mods.append(dict(name="Sensor power switch", supply="-", note="MOSFET/load switch; resistor keeps it OFF in deep sleep.",
                         signals=[("EN", "SENSOR_POWER_PIN", "out", {})]))
    mods.append(dict(name="Status LED", supply="-", note="On-board LED on most DevKits.",
                     signals=[("LED", "LED_PIN", "out", {})]))
    return mods


def gateway_modules(c):
    mods = [dict(name="SX1278 LoRa (Ra-02)", supply="3V3", note="3.3 V ONLY. Same frequency / SF / sync word as every node.",
                 signals=[("SCK", "LORA_SCK", "out", {}), ("MISO", "LORA_MISO", "in", {}), ("MOSI", "LORA_MOSI", "out", {}),
                          ("NSS", "LORA_NSS", "out", {}), ("RST", "LORA_RST", "out", {}), ("DIO0", "LORA_DIO0", "in", {})])]
    if c.get("ENABLE_NBIOT"):
        sig = [("TX", "NBIOT_RX_PIN", "in", {"uart_level": True}), ("RX", "NBIOT_TX_PIN", "out", {"uart_level": True})]
        if isinstance(c.get("NBIOT_PWRKEY_PIN"), int) and c["NBIOT_PWRKEY_PIN"] >= 0:
            sig.append(("PWRKEY", "NBIOT_PWRKEY_PIN", "out", {}))
        mods.append(dict(name="SIM7020 NB-IoT", supply="ext",
                         note="Own supply that can deliver its transmit peaks (not the ESP32 3V3 pin); common GND. "
                              "Check its UART level - use a level shifter if it is not 3.3 V.",
                         signals=sig))
    mods.append(dict(name="Status LED", supply="-", note="On-board LED on most DevKits.", signals=[("LED", "LED_PIN", "out", {})]))
    return mods


# ---- checks ----------------------------------------------------------------
def check(board, c, mods):
    """-> list of (level, message), level ERROR / WARN / INFO"""
    out = []
    users = {}
    for m in mods:
        for pin_name, key, direction, extra in m["signals"]:
            gpio = c.get(key)
            if not isinstance(gpio, int):
                out.append(("ERROR", f"{m['name']} {pin_name}: {key} is not defined in config.h"))
                continue
            users.setdefault(gpio, []).append(f"{m['name']} {pin_name}")
            where = f"{m['name']} {pin_name} on GPIO{gpio} ({key})"
            if gpio in FLASH_PINS:
                out.append(("ERROR", f"{where}: GPIO6-11 are wired to the flash chip"))
            elif gpio in USB_SERIAL_PINS:
                out.append(("ERROR", f"{where}: GPIO1/3 are the USB Serial Monitor"))
            elif gpio not in VALID:
                out.append(("ERROR", f"{where}: not a usable GPIO on an ESP32-WROOM-32"))
            if gpio in INPUT_ONLY and direction in ("out", "io"):
                out.append(("ERROR", f"{where}: GPIO34-39 are input-only"))
            if direction == "analog" and gpio not in ADC1:
                out.append(("ERROR", f"{where}: analog input on an ADC2 pin - ADC2 does not work while WiFi is on; use GPIO32-39"))
            if gpio in STRAPPING:
                level = "ERROR" if gpio == 12 and (extra.get("pullup") or direction == "in") else "INFO"
                out.append((level, f"{where}: strapping pin - {STRAPPING[gpio]}"))
            if extra.get("needs_external_pullup") and gpio in INPUT_ONLY:
                out.append(("INFO", f"{where}: input-only pin has no internal pull-up - the external 10k to 3V3 is required"))
            if c.get("DEEP_SLEEP_ENABLED") and key == "RAIN_GAUGE_PIN" and gpio not in {0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39}:
                out.append(("ERROR", f"{where}: deep sleep needs an RTC GPIO to wake on a bucket tip"))
            level_v = extra.get("level_v")
            if level_v:
                ratio = extra.get("fixed_divider") or (c.get(extra["divider"]) if extra.get("divider") else 1.0) or 1.0
                at_pin = level_v / float(ratio)
                if at_pin > ESP_ADC_MAX_V + 0.05:
                    ratio_fix, pair = suggest_divider(level_v)
                    fix = f"fit a {pair} divider (top / bottom) and set {extra['divider']} {ratio_fix:g}" \
                        if extra.get("divider") else f"fit a {pair} divider"
                    out.append(("ERROR", f"{where}: up to {level_v:g} V from the module reaches the pin as {at_pin:.2f} V "
                                         f"(pin limit {ESP_ADC_MAX_V} V) - {fix}"))
                elif direction == "analog" and at_pin > ESP_ADC_GOOD_V:
                    out.append(("WARN", f"{where}: up to {at_pin:.2f} V at the pin - above ~{ESP_ADC_GOOD_V} V the ESP32 ADC "
                                        f"reads low; a bigger divider gives better accuracy"))
            if extra.get("uart_level"):
                out.append(("INFO", f"{where}: confirm the module's UART runs at 3.3 V logic"))
    for gpio, who in sorted(users.items()):
        if len(who) > 1:
            out.append(("ERROR", f"GPIO{gpio} is used twice: {', '.join(who)}"))
    rank = {"ERROR": 0, "WARN": 1, "INFO": 2}
    return sorted(out, key=lambda x: rank[x[0]])


# ---- rendering ---------------------------------------------------------------
SUPPLY_COLOR = {"3V3": "#c62828", "5V": "#e65100", "ext": "#6a1b9a", "-": "#546e7a"}


def esc(s):
    return html.escape(str(s), quote=True)


def svg_diagram(title, c, mods):
    """ESP32 column on the left, one row per GPIO; modules on the right with
    their pins in the same rows, so every wire is a straight line."""
    row_h, top, left_w, gap, mod_x, mod_w = 26, 84, 200, 230, 0, 380
    mod_x = 40 + left_w + gap
    rows = []
    for m in mods:
        for pin_name, key, direction, extra in m["signals"]:
            rows.append((m, pin_name, key, direction, extra))
    height = top + len(rows) * row_h + 30 + sum(14 for _ in mods)
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {mod_x + mod_w + 30} {height}" '
             f'font-family="Arial, Helvetica, sans-serif" font-size="13" role="img" aria-label="{esc(title)}">',
             f'<rect width="100%" height="100%" fill="#ffffff"/>',
             f'<text x="20" y="26" font-size="18" font-weight="bold" fill="#1b5e20">{esc(title)}</text>',
             f'<text x="20" y="44" font-size="11.5" fill="#5f6b60">Logical diagram - pins grouped by module, not in header order. '
             f'Generated from config.h.</text>']
    y = top
    esp_top = y
    # module blocks: compute their row spans first
    mod_spans = []
    idx = 0
    cursor = y
    for m in mods:
        n = len(m["signals"])
        mod_spans.append((m, cursor, n))
        cursor += n * row_h + 14
    esp_bottom = cursor - 14
    parts.append(f'<rect x="40" y="{esp_top - 8}" width="{left_w}" height="{esp_bottom - esp_top + 16}" rx="10" '
                 f'fill="#e8f5e9" stroke="#1b5e20" stroke-width="2"/>')
    parts.append(f'<text x="{40 + left_w / 2}" y="{esp_top - 16}" text-anchor="middle" font-weight="bold" fill="#1b5e20">ESP32 DevKit</text>')
    for m, my, n in mod_spans:
        color = SUPPLY_COLOR.get(m["supply"], "#546e7a")
        parts.append(f'<rect x="{mod_x}" y="{my - 8}" width="{mod_w}" height="{n * row_h + 4}" rx="8" fill="#ffffff" '
                     f'stroke="{color}" stroke-width="2"/>')
        label = m["name"] + ("" if m["supply"] == "-" else f'  [{m["supply"] if m["supply"] != "ext" else "own supply"}]')
        parts.append(f'<text x="{mod_x + 90}" y="{my + 9}" font-weight="bold" fill="{color}">{esc(label)}</text>')
        for i, (pin_name, key, direction, extra) in enumerate(m["signals"]):
            ry = my + i * row_h + 5
            gpio = c.get(key)
            parts.append(f'<text x="{48}" y="{ry + 4}" fill="#1b1b1b">GPIO{esc(gpio)}</text>')
            parts.append(f'<text x="{40 + left_w - 8}" y="{ry + 4}" text-anchor="end" font-size="11" fill="#5f6b60">{esc(key)}</text>')
            x1, x2 = 40 + left_w, mod_x
            arrow = {"out": "→", "in": "←", "io": "↔", "analog": "← analog"}[direction]
            parts.append(f'<line x1="{x1}" y1="{ry}" x2="{x2}" y2="{ry}" stroke="#37474f" stroke-width="1.6"/>')
            part = None
            if extra.get("fixed_divider"):
                part = f"divider {divider_for(extra['fixed_divider'], fast=True)}"
            elif extra.get("divider"):
                ratio = c.get(extra["divider"], 1.0)
                if ratio and float(ratio) > 1.0:
                    part = f"divider {'100k / 100k' if extra.get('big') and float(ratio) == 2.0 else divider_for(float(ratio))}"
                else:
                    part = "NO DIVIDER - see checks"
            elif extra.get("pullup"):
                part = f"pull-up {extra['pullup'].split(' (')[0]}"
            if part:
                bad = part.startswith("NO DIVIDER")
                w = 7 * len(part) + 12
                cx = (x1 + x2) / 2
                parts.append(f'<rect x="{cx - w / 2}" y="{ry - 10}" width="{w}" height="20" rx="4" '
                             f'fill="{"#fdecea" if bad else "#fff8e1"}" stroke="{"#c62828" if bad else "#f9a825"}"/>')
                parts.append(f'<text x="{cx}" y="{ry + 4}" text-anchor="middle" font-size="11" '
                             f'fill="{"#c62828" if bad else "#5d4037"}">{esc(part)}</text>')
            else:
                parts.append(f'<text x="{(x1 + x2) / 2}" y="{ry - 4}" text-anchor="middle" font-size="13" fill="#78909c">{esc(arrow)}</text>')
            parts.append(f'<text x="{mod_x + 10}" y="{ry + 4}" fill="#1b1b1b">{esc(pin_name)}</text>')
    legend_y = esp_bottom + 26
    lx = 40
    for supply, text in (("3V3", "powered from 3.3 V"), ("5V", "powered from 5 V"), ("ext", "own supply"), ("-", "no supply pin")):
        parts.append(f'<rect x="{lx}" y="{legend_y - 10}" width="12" height="12" fill="none" stroke="{SUPPLY_COLOR[supply]}" stroke-width="2"/>')
        parts.append(f'<text x="{lx + 18}" y="{legend_y}" font-size="11.5" fill="#37474f">{esc(text)}</text>')
        lx += 150
    parts.append("</svg>")
    return "\n".join(parts)


def connection_rows(c, mods):
    rows = []
    for m in mods:
        for pin_name, key, direction, extra in m["signals"]:
            via = ""
            if extra.get("fixed_divider"):
                via = f"divider {divider_for(extra['fixed_divider'], fast=True)} (5 V -> 3.3 V)"
            elif extra.get("divider"):
                ratio = float(c.get(extra["divider"], 1.0) or 1.0)
                via = (f"divider {'100k / 100k' if extra.get('big') and ratio == 2.0 else divider_for(ratio)} "
                       f"({extra['divider']} = {ratio:g})") if ratio > 1.0 else f"none ({extra['divider']} = 1.0)"
            elif extra.get("pullup"):
                via = f"pull-up {extra['pullup']}"
            rows.append((m["name"], m["supply"], pin_name, c.get(key), key, direction, via))
    return rows


def parts_list(c, mods):
    items = []
    for m in mods:
        for pin_name, key, direction, extra in m["signals"]:
            if extra.get("fixed_divider"):
                items.append(f"{m['name']} {pin_name}: resistors {divider_for(extra['fixed_divider'], fast=True)} (top / bottom)")
            elif extra.get("divider"):
                ratio = float(c.get(extra["divider"], 1.0) or 1.0)
                if ratio > 1.0:
                    pair = "100k / 100k" if extra.get("big") and ratio == 2.0 else divider_for(ratio)
                    items.append(f"{m['name']} {pin_name}: resistors {pair} (top / bottom)")
            elif extra.get("pullup") and extra.get("needs_external_pullup"):
                items.append(f"{m['name']}: 10k resistor, pin to 3V3")
    return items


PAGE_CSS = """
:root{--bg:#f6f9f6;--surface:#fff;--text:#1b1b1b;--muted:#5f6b60;--border:#dbe7dc;--green:#1b5e20;
--err-bg:#fdecea;--err:#b71c1c;--warn-bg:#fff8e1;--warn:#8d6e00;--info-bg:#e8f1fd;--info:#1a4f8b;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#0f1511;--surface:#18211b;--text:#e6efe7;--muted:#a3b3a6;--border:#2c3a30;
--green:#a5d6a7;--err-bg:#3b1414;--err:#ffb4a9;--warn-bg:#3a2f05;--warn:#ffe08a;--info-bg:#10243d;--info:#a8c8ff;color-scheme:dark}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.5 Arial,Helvetica,sans-serif}
main{max-width:1100px;margin:0 auto;padding:20px 16px 48px}
h1{color:var(--green);margin:0 0 4px}h2{color:var(--green);margin:32px 0 8px}h3{margin:20px 0 6px}
.muted{color:var(--muted)}.diagram{background:#fff;border:1px solid var(--border);border-radius:12px;padding:8px;overflow-x:auto}
.diagram svg{display:block;min-width:760px;width:100%;height:auto}
table{border-collapse:collapse;width:100%;background:var(--surface);font-size:14px}
th,td{border-bottom:1px solid var(--border);padding:7px 10px;text-align:left;vertical-align:top}th{background:var(--green);color:#fff}
@media (prefers-color-scheme:dark){th{color:#0f1511}}
.wrap{overflow-x:auto;border:1px solid var(--border);border-radius:10px}
.checks{list-style:none;padding:0;margin:0}.checks li{padding:8px 12px;border-radius:8px;margin:6px 0}
.ERROR{background:var(--err-bg);color:var(--err)}.WARN{background:var(--warn-bg);color:var(--warn)}.INFO{background:var(--info-bg);color:var(--info)}
code{font-size:13px}
"""


def page(boards):
    out = ["<!doctype html><html lang='en'><head><meta charset='utf-8'>",
           "<meta name='viewport' content='width=device-width, initial-scale=1'>",
           "<title>SANJEEVNI Wiring</title><style>" + PAGE_CSS + "</style></head><body><main>",
           "<h1>SANJEEVNI wiring</h1>",
           "<p class='muted'>Generated from <code>firmware/sanjeevni_lora_node/config.h</code> and "
           "<code>firmware/sanjeevni_lora_gateway/config.h</code> by <code>tools/wiring/generate_wiring.py</code> - "
           "re-run it after changing a pin. Diagrams are logical (grouped by module), not the physical header order. "
           "Supply voltages and output levels are typical for the common breakout boards: check your module's datasheet. "
           "All grounds are common.</p>"]
    for title, c, mods, results in boards:
        errors = sum(1 for level, _ in results if level == "ERROR")
        out.append(f"<h2>{esc(title)}</h2>")
        out.append(f"<h3>Checks: {errors} error(s)</h3><ul class='checks'>")
        if not results:
            out.append("<li class='INFO'>No problems found.</li>")
        for level, msg in results:
            out.append(f"<li class='{level}'><strong>{level}</strong> - {esc(msg)}</li>")
        out.append("</ul><div class='diagram'>" + svg_diagram(title, c, mods) + "</div>")
        out.append("<h3>Connections</h3><div class='wrap'><table><thead><tr><th scope='col'>Module</th><th scope='col'>Supply</th>"
                   "<th scope='col'>Module pin</th><th scope='col'>ESP32</th><th scope='col'>config.h</th>"
                   "<th scope='col'>Direction</th><th scope='col'>In between</th></tr></thead><tbody>")
        for name, supply, pin_name, gpio, key, direction, via in connection_rows(c, mods):
            out.append(f"<tr><td>{esc(name)}</td><td>{esc(supply)}</td><td>{esc(pin_name)}</td><td>GPIO{esc(gpio)}</td>"
                       f"<td><code>{esc(key)}</code></td><td>{esc(direction)}</td><td>{esc(via)}</td></tr>")
        out.append("</tbody></table></div>")
        items = parts_list(c, mods)
        if items:
            out.append("<h3>Extra parts</h3><ul>" + "".join(f"<li>{esc(i)}</li>" for i in items) + "</ul>")
        notes = [f"<li><strong>{esc(m['name'])}</strong>: {esc(m['note'])}</li>" for m in mods if m.get("note")]
        out.append("<h3>Module notes</h3><ul>" + "".join(notes) + "</ul>")
    out.append("</main></body></html>")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="run the checks only, write nothing")
    args = ap.parse_args()

    node_c, gw_c = parse_config(NODE_CFG), parse_config(GATEWAY_CFG)
    node_m, gw_m = node_modules(node_c), gateway_modules(gw_c)
    transport = "LoRa" if node_c.get("TRANSPORT") == node_c.get("TRANSPORT_LORA") else "WiFi"
    sleep = ", deep sleep" if node_c.get("DEEP_SLEEP_ENABLED") else ""
    boards = [
        (f"Sensor node {node_c.get('NODE_ID', '').strip(chr(34))} ({transport}{sleep})", node_c, node_m, check("node", node_c, node_m)),
        ("LoRa gateway", gw_c, gw_m, check("gateway", gw_c, gw_m)),
    ]
    errors = 0
    for title, _c, _m, results in boards:
        print(f"== {title}")
        for level, msg in results:
            print(f"   {level:5s} {msg}")
            errors += level == "ERROR"
        if not results:
            print("   no problems found")
    if not args.check:
        os.makedirs(DOCS, exist_ok=True)
        with open(os.path.join(DOCS, "wiring.html"), "w", encoding="utf-8") as f:
            f.write(page(boards))
        for name, (title, c, mods, _r) in zip(("wiring_node.svg", "wiring_gateway.svg"), boards):
            with open(os.path.join(DOCS, name), "w", encoding="utf-8") as f:
                f.write(svg_diagram(title, c, mods))
        print(f"\nWrote docs/wiring.html, docs/wiring_node.svg, docs/wiring_gateway.svg")
    print(f"\n{errors} wiring error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
