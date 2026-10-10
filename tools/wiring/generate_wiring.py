"""
SANJEEVNI - wiring diagram + wiring checks, generated from the firmware's
own config.h files (so the drawing can never disagree with the code).

  venv/Scripts/python.exe tools/wiring/generate_wiring.py          # write docs/
  venv/Scripts/python.exe tools/wiring/generate_wiring.py --check  # checks only

Writes docs/wiring.html (diagrams + connection tables + parts list +
power path + checks) and docs/wiring_node.svg / docs/wiring_gateway.svg /
docs/wiring_power.svg (for slides).
Exit code 1 if a check finds an ERROR (pin clash, flash pin, 5 V into a
3.3 V pin, SIM7020 on the 3V3 pin, ...) - tools/firmware_host_test/run_tests.py runs it.

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
RTC_GPIO = {0, 2, 4, 12, 13, 14, 15, 25, 26, 27, 32, 33, 34, 35, 36, 37, 38, 39}  # can wake from deep sleep
# A push-button to GND (internal pull-up) pulls its pin LOW whenever it is
# pressed - also during a reset, so on a strapping pin it picks the boot mode.
BUTTON_STRAPPING = {0: ("ERROR", "pressed during a reset = download mode, the node hangs until the next reset"),
                    12: ("ERROR", "never put an external pull-up on it (1.8 V flash - board won't boot)"),
                    15: ("INFO", "pressed during a reset it only silences the ROM boot log - harmless")}
# A switch input (MOSFET gate / relay board) with its REQUIRED pull-down to
# GND holds its pin LOW at every reset - fine where LOW is the safe boot level.
GATE_PULLDOWN_STRAPPING = {
    0: ("ERROR", "the gate pull-down holds it LOW at reset = download mode, the node hangs"),
    2: ("INFO", "LOW at reset is the normal boot level - the pull-down is harmless"),
    5: ("WARN", "the gate pull-down holds it LOW at reset, which it must not be - pick another pin"),
    12: ("INFO", "the gate pull-down keeps it LOW at reset as the 3.3 V flash needs - so the 10k is REQUIRED, and "
                 "never use an active-LOW relay board here (its input pulls the pin HIGH: 1.8 V flash, won't boot)"),
    15: ("INFO", "LOW at reset only silences the ROM boot log - harmless")}
# An input of a module that has its OWN pull-up (PMS5003 SET: "pulled up
# inside", datasheet) holds its pin HIGH at every reset.
MODULE_PULLUP_STRAPPING = {
    0: ("ERROR", "the firmware refuses it (config.h): keep GPIO0 for the boot button"),
    2: ("ERROR", "the module's pull-up holds it HIGH at reset - serial flashing (download mode) then fails"),
    12: ("ERROR", "the module's pull-up holds it HIGH at reset = 1.8 V flash, the board won't boot"),
    5: ("INFO", "HIGH at reset is its normal boot level - harmless"),
    15: ("INFO", "HIGH at reset is its normal boot level - harmless")}
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


def divider_pair(ratio, big=False):
    """One place for the analog-divider resistor rule, so the power diagram,
    GPIO diagram and parts list can never name different resistors. 'big'
    (high-Z 100k pair) is for always-on sense lines such as the battery,
    where a 10k pair would drain the cell continuously."""
    if big and abs(float(ratio) - 2.0) < 1e-6:
        return "100k / 100k"
    return divider_for(float(ratio))


# ---- module catalogue ------------------------------------------------------
# signal: (module pin, config key, direction seen from the ESP32, extra)
#   direction: "out" ESP32 drives it, "in" ESP32 reads it, "io" both, "analog"
#   extra: dict(level_v=module output voltage, divider=ratio key, pullup=text,
#               pulldown=text: a resistor from the pin to GND that the wiring REQUIRES,
#               gate_pulldown=True: that pull-down holds a switch's input LOW at reset)
# module flags read by power_checks() (flags, not name/note text, so a
# rename cannot switch a check off):
#   needs_own_supply=True: current the ESP32's rails cannot feed (SIM7020 transmit
#                          peaks, a 12 V siren) - must be supply "ext"
#   own_supply=(short power-table note, power-budget <li> html) for an "ext" module
#   max_supply="3V3": highest rail the module tolerates - power_checks() flags any other rail


def node_modules(c):
    lora = c.get("TRANSPORT") == c.get("TRANSPORT_LORA")
    mods = []
    if lora:
        mods.append(dict(name="SX1278 LoRa (Ra-02)", supply="3V3", max_supply="3V3", note="3.3 V ONLY - 5 V destroys it. Fit the antenna before powering.",
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
        heater = ("Heater ~150 mA from 5 V, switched by the MQ135 heater switch below (duty cycle: on only around "
                  "the reports that carry gas)." if c.get("MQ135_DUTY_CYCLE") else
                  "Heater ~150 mA from 5 V, always on (no deep sleep).")
        mods.append(dict(name="MQ135 gas", supply="5V", note=heater,
                         signals=[("AO", "MQ135_PIN", "analog", {"level_v": 5.0, "divider": "MQ135_ADC_DIVIDER_RATIO"})]))
    if c.get("ENABLE_GAS") and isinstance(c.get("MQ135_HEATER_PIN"), int) and c["MQ135_HEATER_PIN"] >= 0:
        mods.append(dict(name="MQ135 heater switch", supply="-",
                         note="Duty cycle (MQ135_DUTY_CYCLE): a logic-level N-MOSFET (Rds(on) specified at a gate "
                              "voltage of 3.3 V or less - check its datasheet) in the MQ135 module's GND lead: drain "
                              "to the module's GND pin, source to the common GND, 100R gate resistor, 10k "
                              "gate-to-GND REQUIRED (heater off while the ESP32 resets). Switched off, the module's "
                              "AO rises towards 5 V; the 10k/10k divider keeps the ADC pin near 2.5 V and the "
                              "firmware does not read it then.",
                         part="logic-level N-MOSFET for ~150 mA (heater), 100R gate resistor, 10k gate to GND",
                         signals=[("GATE", "MQ135_HEATER_PIN", "out", {"pulldown": "10k gate to GND (REQUIRED)",
                                                                       "gate_pulldown": True})]))
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
        pms_sig = [("TX", "PMS_RX_PIN", "in", {"level_v": 3.3}), ("RX", "PMS_TX_PIN", "out", {})]
        note = "Fan needs 5 V; its UART is 3.3 V logic."
        if isinstance(c.get("PMS5003_SET_PIN"), int) and c["PMS5003_SET_PIN"] >= 0:
            pms_sig.append(("SET", "PMS5003_SET_PIN", "out", {"module_pullup": True}))
            note += " SET (3.3 V level, pulled up inside the module): LOW = sleep - the duty cycle uses it."
        elif c.get("PMS5003_DUTY_CYCLE"):
            note += " Duty cycle: slept / woken by its serial command over the RX line - no extra wire."
        mods.append(dict(name="PMS5003 particulate", supply="5V", note=note, signals=pms_sig))
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
    if isinstance(c.get("SOS_BUTTON_PIN"), int) and c["SOS_BUTTON_PIN"] >= 0:
        hold = c.get("SOS_HOLD_MS", 2000)
        hold_s = f"{hold / 1000:g} s" if isinstance(hold, (int, float)) else "SOS_HOLD_MS"
        mods.append(dict(name="SOS push-button", supply="-",
                         note=f"For people without a phone: hold {hold_s} = SOS at this node's position. Normally-open "
                              f"weatherproof button between the pin and GND; the ESP32's internal pull-up, so no resistor "
                              f"to 3V3. The 1k in series protects the pin from ESD on an outdoor cable. Wakes a deep-sleeping node.",
                         signals=[("SW", "SOS_BUTTON_PIN", "in", {"series": "1k in series", "internal_pullup": True,
                                                                   "wakes": True})]))
    if isinstance(c.get("SIREN_PIN"), int) and c["SIREN_PIN"] >= 0:
        on_s = c.get("SIREN_ON_S", 180)
        offline_s = c.get("SIREN_OFFLINE_AFTER_S", 900)
        mods.append(dict(name="Village siren + strobe (12 V)", supply="ext", needs_own_supply=True,
                         note=f"Sounds on a server command (officer / confirmed CRITICAL evacuation hazard), or by "
                              f"itself only when the gateway has been silent {offline_s} s and the water level or gas "
                              f"is at its siren danger level; "
                              f"{on_s} s per trigger. Switched on the LOW side by a logic-level N-MOSFET (Rds(on) "
                              f"specified at a gate voltage of 3.3 V or less - check its datasheet) or a relay board "
                              f"with an active-HIGH input that works from 3.3 V: drain to the siren / strobe "
                              f"(-), their (+) to the 12 V supply, source to the common GND. 100R gate resistor; "
                              f"10k gate-to-GND REQUIRED (keeps the siren off while the ESP32 resets). A diode "
                              f"across any coil or motor load (cathode to +12 V). Never an active-LOW relay board.",
                         own_supply=("12 V supply sized for the siren + strobe current from THEIR datasheets; its (−) "
                                     "is the common GND (low-side switch)",
                                     "<li><strong>Village siren + strobe</strong>: its own 12 V supply (battery or "
                                     "adapter) sized for the siren and strobe current from their datasheets - not "
                                     "the node's 18650 / MT3608 chain. Common GND with the ESP32, because the MOSFET "
                                     "switches the (−) side. Take the switch's current rating and the wire gauge "
                                     "from the siren's current (not verified here).</li>"),
                         signals=[("GATE", "SIREN_PIN", "out", {"pulldown": "10k gate to GND (REQUIRED)",
                                                                "gate_pulldown": True})]))
    mods.append(dict(name="Status LED", supply="-", note="On-board LED on most DevKits.",
                     signals=[("LED", "LED_PIN", "out", {})]))
    return mods


def gateway_modules(c):
    mods = [dict(name="SX1278 LoRa (Ra-02)", supply="3V3", max_supply="3V3", note="3.3 V ONLY. Same frequency / SF / sync word as every node.",
                 signals=[("SCK", "LORA_SCK", "out", {}), ("MISO", "LORA_MISO", "in", {}), ("MOSI", "LORA_MOSI", "out", {}),
                          ("NSS", "LORA_NSS", "out", {}), ("RST", "LORA_RST", "out", {}), ("DIO0", "LORA_DIO0", "in", {})])]
    if c.get("ENABLE_NBIOT"):
        sig = [("TX", "NBIOT_RX_PIN", "in", {"uart_level": True}), ("RX", "NBIOT_TX_PIN", "out", {"uart_level": True})]
        if isinstance(c.get("NBIOT_PWRKEY_PIN"), int) and c["NBIOT_PWRKEY_PIN"] >= 0:
            sig.append(("PWRKEY", "NBIOT_PWRKEY_PIN", "out", {}))
        mods.append(dict(name="SIM7020 NB-IoT", supply="ext", needs_own_supply=True,
                         note="Own supply that can deliver its transmit peaks (not the ESP32 3V3 pin); common GND. "
                              "Check its UART level - use a level shifter if it is not 3.3 V.",
                         own_supply=("Must deliver the module's transmit peaks; voltage per its board's datasheet. "
                                     "Never the ESP32 3V3 pin.",
                                     "<li><strong>SIM7020</strong>: its own supply that can deliver its transmit peaks, "
                                     "common GND with the ESP32. Take the voltage range and peak current from SIMCom's "
                                     "<em>SIM7020 Hardware Design</em> document for your exact module/board (not "
                                     "verified here).</li>"),
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
                note = STRAPPING[gpio]
                if extra.get("internal_pullup"):
                    level, note = BUTTON_STRAPPING.get(gpio, (level, note))
                if extra.get("gate_pulldown"):
                    level, note = GATE_PULLDOWN_STRAPPING.get(gpio, (level, note))
                if extra.get("module_pullup"):
                    level, note = MODULE_PULLUP_STRAPPING.get(gpio, (level, note))
                out.append((level, f"{where}: strapping pin - {note}"))
            if extra.get("needs_external_pullup") and gpio in INPUT_ONLY:
                out.append(("INFO", f"{where}: input-only pin has no internal pull-up - the external 10k to 3V3 is required"))
            if extra.get("internal_pullup") and gpio in INPUT_ONLY:
                out.append(("ERROR", f"{where}: GPIO34-39 have no internal pull-up - the firmware uses INPUT_PULLUP, "
                                     f"the pin would float"))
            if c.get("DEEP_SLEEP_ENABLED") and key == "RAIN_GAUGE_PIN" and gpio not in RTC_GPIO:
                out.append(("ERROR", f"{where}: deep sleep needs an RTC GPIO to wake on a bucket tip"))
            if extra.get("wakes") and gpio not in RTC_GPIO:
                out.append(("ERROR" if c.get("DEEP_SLEEP_ENABLED") else "WARN",
                            f"{where}: not an RTC GPIO - it cannot wake the node from deep sleep"))
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
    out += power_checks(board, c, mods)
    rank = {"ERROR": 0, "WARN": 1, "INFO": 2}
    return sorted(out, key=lambda x: rank[x[0]])


# Output-capable GPIOs nobody uses (for an extra switch, e.g. the MQ135 heater
# MOSFET of the duty cycle). Strapping pins are listed apart: each needs its
# boot level kept (see STRAPPING / GATE_PULLDOWN_STRAPPING).
def free_output_pins(c, mods):
    """(free non-strapping GPIOs, free strapping GPIOs), both output-capable."""
    used = {c.get(key) for m in mods for _p, key, _d, _e in m["signals"]}
    free = sorted(p for p in VALID - INPUT_ONLY - USB_SERIAL_PINS if p not in used)
    return [p for p in free if p not in STRAPPING], [p for p in free if p in STRAPPING]


# ---- power path ------------------------------------------------------------
# The power diagram and the power checks both read the module catalogue's
# "supply" field through power_nets(), so a module can only ever be drawn
# on the rail the catalogue gives it.
#   "5V"  = MT3608 VOUT+ (node) / the 5 V source (gateway) - same net as the
#           DevKit's 5V/VIN pin
#   "3V3" = the DevKit's 3V3 pin (output of the board's own LDO)
#   "ext" = the module's own supply (SIM7020: transmit peaks)
#   "-"   = no supply pin (switch, divider, on-board LED)
RAILS = ("3V3", "5V", "ext", "-")
TP4056_FLOAT_V = 4.2  # TP4056 datasheet: "preset 4.2V charge voltage" (Top Power)


def power_nets(mods):
    """{rail: [module, ...]}; a supply outside RAILS lands in "?" (an ERROR)."""
    nets = {r: [] for r in RAILS}
    nets["?"] = []
    for m in mods:
        nets[m["supply"] if m["supply"] in RAILS else "?"].append(m)
    return nets


def sensor_switch(c, nets):
    """(gpio or None, {rail: [switched modules]}). SENSOR_POWER_PIN gates "the
    sensors' power" (config.h); the radio is not a sensor, so it stays on its rail."""
    pin = c.get("SENSOR_POWER_PIN")
    if not (isinstance(pin, int) and pin >= 0):
        return None, {}
    return pin, {r: [m for m in nets[r] if "LoRa" not in m["name"]] for r in ("5V", "3V3")}


def battery_divider(c):
    """(resistor pair, ratio) of the battery-sense divider, as the GPIO diagram draws it."""
    ratio = float(c.get("BATTERY_DIVIDER_RATIO", 1.0) or 1.0)
    # big=True: the catalogue's BAT+ signal (node_modules) carries "big": True
    return divider_pair(ratio, big=True), ratio


def power_checks(board, c, mods):
    """Only mechanical checks on the catalogue + config.h - no electrical
    figures are invented here (those are notes, to be measured)."""
    out = []
    nets = power_nets(mods)
    for m in nets["?"]:
        out.append(("ERROR", f"{m['name']}: supply '{m['supply']}' is not one of {', '.join(RAILS)} - "
                             f"the power diagram cannot place it"))
    # An "ext" module can never be drawn on 3V3 / 5V: the diagrams only take
    # rail members from power_nets(). What can go wrong is the catalogue
    # itself giving a module the wrong supply - checked here.
    # flags, not name/note text, so a rename cannot switch the check off
    for m in mods:
        if m.get("needs_own_supply") and m["supply"] != "ext":
            out.append(("ERROR", f"{m['name']}: supply is '{m['supply']}' - it needs its own supply that can deliver "
                                 f"its peak current, never the ESP32 3V3 pin"))
        if m.get("max_supply") == "3V3" and m["supply"] != "3V3":
            out.append(("ERROR", f"{m['name']}: 3.3 V-only module is on the '{m['supply']}' rail"))
    if board == "node" and c.get("ENABLE_BATTERY"):
        full = c.get("BATTERY_FULL_V")
        if isinstance(full, (int, float)) and abs(float(full) - TP4056_FLOAT_V) > 0.05:
            effect = "never reaches 100 %" if full > TP4056_FLOAT_V else "shows 100 % before the cell is full"
            out.append(("WARN", f"BATTERY_FULL_V is {full:g} V but the TP4056 charges the cell to {TP4056_FLOAT_V} V - "
                                f"the battery level {effect}"))
    if board == "node" and c.get("DEEP_SLEEP_ENABLED"):
        # Fires with or without a sensor switch: the boost, the board's own
        # parts and the radio are never behind it, so the sleep current is
        # never just the ESP32's - no figure here, it has to be measured.
        pin, sw = sensor_switch(c, nets)
        gated = {m["name"] for r in sw for m in sw[r]}
        still = ["MT3608 boost", "ESP32 board LDO / USB-UART / power LED"] + \
                [m["name"] for m in nets["5V"] + nets["3V3"] if m["name"] not in gated]
        how = (f"SENSOR_POWER_PIN GPIO{pin} switches off {', '.join(sorted(gated)) or '(nothing)'}; "
               if pin is not None else "SENSOR_POWER_PIN -1: ")
        out.append(("INFO", f"deep sleep, {how}these stay powered while the ESP32 sleeps - "
                            f"{', '.join(still)}; MEASURE the sleep current"))
        if isinstance(c.get("SOS_BUTTON_PIN"), int) and c["SOS_BUTTON_PIN"] >= 0:
            out.append(("INFO", "deep sleep with the SOS button: its pull-up needs the RTC peripherals powered "
                                "while the ESP32 sleeps - part of the sleep current to MEASURE"))
    return out


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
                    part = f"divider {divider_pair(ratio, extra.get('big'))}"
                else:
                    part = "NO DIVIDER - see checks"
            elif extra.get("pullup"):
                part = f"pull-up {extra['pullup'].split(' (')[0]}"
            elif extra.get("pulldown"):
                part = f"pull-down {extra['pulldown'].split(' (')[0]}"
            elif extra.get("series"):
                part = extra["series"]
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
                via = (f"divider {divider_pair(ratio, extra.get('big'))} "
                       f"({extra['divider']} = {ratio:g})") if ratio > 1.0 else f"none ({extra['divider']} = 1.0)"
            elif extra.get("pullup"):
                via = f"pull-up {extra['pullup']}"
            elif extra.get("pulldown"):
                via = f"pull-down {extra['pulldown']}; 100R gate resistor"
            elif extra.get("series"):
                via = f"{extra['series']}; internal pull-up (INPUT_PULLUP), button to GND"
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
                    pair = divider_pair(ratio, extra.get("big"))
                    items.append(f"{m['name']} {pin_name}: resistors {pair} (top / bottom)")
            elif extra.get("pullup") and extra.get("needs_external_pullup"):
                items.append(f"{m['name']}: 10k resistor, pin to 3V3")
            elif extra.get("gate_pulldown") and m.get("part"):
                items.append(f"{m['name']}: {m['part']}")
            elif extra.get("gate_pulldown"):
                items.append(f"{m['name']}: logic-level N-MOSFET (or an active-HIGH 3.3 V relay board), 100R gate "
                             f"resistor, 10k gate to GND, flyback diode for a coil / motor load, its own 12 V supply")
            elif extra.get("series"):
                items.append(f"{m['name']}: {extra['series'].split(' in ')[0]} resistor in series + a normally-open "
                             f"weatherproof push-button to GND")
    return items


# ---- power rendering --------------------------------------------------------
NET_COLOR = {"pv": "#b8860b", "bat": "#00838f", "batneg": "#78909c", "5V": SUPPLY_COLOR["5V"],
             "3V3": SUPPLY_COLOR["3V3"], "ext": SUPPLY_COLOR["ext"], "gnd": "#263238", "sense": "#6d4c41"}
POS_Y, NEG_Y = 230, 268  # the + and - wires of the node chain run straight across at these heights


def _t(x, y, s, size=13, anchor="start", bold=False, fill="#1b1b1b"):
    return (f'<text x="{x}" y="{y}" font-size="{size}" text-anchor="{anchor}"'
            f'{" font-weight=" + chr(34) + "bold" + chr(34) if bold else ""} fill="{fill}">{esc(s)}</text>')


def _box(x, y, w, h, stroke, fill="#ffffff"):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="8" fill="{fill}" stroke="{stroke}" stroke-width="2"/>'


def _wire(pts, net, dash=False):
    d = " ".join(f"{x},{y}" for x, y in pts)
    return (f'<polyline points="{d}" fill="none" stroke="{NET_COLOR[net]}" stroke-width="2.6" '
            f'stroke-linejoin="round"{" stroke-dasharray=" + chr(34) + "6 4" + chr(34) if dash else ""}/>')


def _dot(x, y, net):
    return f'<circle cx="{x}" cy="{y}" r="4.5" fill="{NET_COLOR[net]}"/>'


def _svg_head(w, h, title, subtitle):
    return [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" font-family="Arial, Helvetica, sans-serif" '
            f'font-size="13" role="img" aria-label="{esc(title)}">',
            f'<rect width="100%" height="100%" fill="#ffffff"/>',
            _t(20, 28, title, 18, bold=True, fill="#1b5e20"),
            _t(20, 47, subtitle, 11.5, fill="#5f6b60")]


def _rail_box(x, y, w, rail, heading, members):
    """Box listing the modules whose VCC is on one rail -> (svg parts, bottom y)."""
    names = [m["name"] for m in members] or ["(none)"]
    h = 34 + 18 * len(names)
    parts = [_box(x, y, w, h, SUPPLY_COLOR[rail]), _t(x + 12, y + 22, heading, 13, bold=True, fill=SUPPLY_COLOR[rail])]
    parts += [_t(x + 16, y + 42 + 18 * i, "• " + n, 12) for i, n in enumerate(names)]
    return parts, y + h


def _legend(y, items, footnotes):
    parts, lx = [], 40
    for net, text in items:
        parts.append(f'<line x1="{lx}" y1="{y - 4}" x2="{lx + 26}" y2="{y - 4}" stroke="{NET_COLOR[net]}" stroke-width="3"/>')
        parts.append(_t(lx + 32, y, text, 11.5, fill="#37474f"))
        lx += 44 + 6.4 * len(text)
    parts.append(_dot(lx + 6, y - 4, "gnd"))
    parts.append(_t(lx + 16, y, "= wires joined (crossing wires without a dot are not)", 11.5, fill="#37474f"))
    for i, line in enumerate(footnotes):
        parts.append(_t(40, y + 22 + 17 * i, line, 11.5, fill="#5f6b60"))
    return parts


def svg_power_node(title, c, mods):
    """Node power path, left to right: panel -> TP4056 -> MT3608 -> ESP32,
    18650 under the TP4056, rails and their modules underneath, one GND bus."""
    nets = power_nets(mods)
    W = 1280
    p = _svg_head(W, 0, title, "Power path. Typical pinout of the common modules - check yours. "
                               "Module rails come from the same catalogue as the GPIO diagram.")
    # solar panel
    p += [_box(30, 110, 180, 180, NET_COLOR["pv"]), _t(120, 136, "Solar panel", 14, "middle", True, NET_COLOR["pv"]),
          _t(120, 158, "size = design input:", 11, "middle"), _t(120, 174, "project estimate ~6 W for", 11, "middle"),
          _t(120, 190, "an always-on gas node", 11, "middle"), _t(120, 206, "(MEASURE, then size it)", 11, "middle"),
          _t(200, POS_Y + 4, "+", 14, "end", True), _t(200, NEG_Y + 4, "−", 14, "end", True)]
    # TP4056 module (charger + DW01/FS8205 protection)
    p += [_box(300, 110, 220, 200, NET_COLOR["bat"]), _t(410, 136, "TP4056 charger", 14, "middle", True, NET_COLOR["bat"]),
          _t(410, 154, "+ DW01 / FS8205 protection", 11, "middle"), _t(410, 170, "4.2 V float, 1 A (R_PROG 1.2k)", 11, "middle"),
          _t(308, POS_Y + 4, "IN+"), _t(308, NEG_Y + 4, "IN−"), _t(512, POS_Y + 4, "OUT+", anchor="end"),
          _t(512, NEG_Y + 4, "OUT−", anchor="end"), _t(370, 302, "B+", anchor="middle"), _t(460, 302, "B−", anchor="middle")]
    # 18650 cell under the TP4056
    lo, hi = float(c.get("BATTERY_EMPTY_V", 3.0)), float(c.get("BATTERY_FULL_V", TP4056_FLOAT_V))
    p += [_wire([(370, 310), (370, 400)], "bat"), _wire([(460, 310), (460, 400)], "batneg"),
          _box(320, 400, 200, 80, NET_COLOR["bat"], "#e0f2f1"), _t(370, 418, "+", 14, "middle", True), _t(460, 418, "−", 14, "middle", True),
          _t(420, 444, "18650 Li-ion cell", 14, "middle", True), _t(420, 464, f"{lo:.1f}–{hi:.1f} V (config.h)", 11, "middle"),
          _t(420, 500, "B− goes ONLY to the cell −, never to GND:", 11, "middle", fill=NET_COLOR["batneg"]),
          _t(420, 515, "the protection switch sits between B− and OUT−", 11, "middle", fill=NET_COLOR["batneg"])]
    bottoms = [515]
    # battery-sense divider taps the cell + (B+)
    if c.get("ENABLE_BATTERY"):
        pair, ratio = battery_divider(c)
        p += [_wire([(370, 355), (240, 355)], "sense"), _dot(370, 355, "bat"),
              _box(40, 320, 200, 120, NET_COLOR["sense"], "#fff8e1"), _t(140, 342, "Battery sense", 13, "middle", True, NET_COLOR["sense"]),
              _t(52, 362, f"{pair} divider (top / bottom)", 11), _t(52, 378, "top: from B+ (cell +)", 11),
              _t(52, 394, f"mid: GPIO{c.get('BATTERY_PIN')} (BATTERY_PIN)", 11),
              _t(52, 410, f"BATTERY_DIVIDER_RATIO {ratio:g}", 11), _t(52, 426, "bottom: to GND", 11)]
        bottoms.append(440)
    # MT3608 boost
    p += [_box(610, 110, 210, 200, SUPPLY_COLOR["5V"]), _t(715, 136, "MT3608 boost", 14, "middle", True, SUPPLY_COLOR["5V"]),
          _t(715, 154, "set VOUT+ to 5.0 V with the", 11, "middle"), _t(715, 170, "trimmer BEFORE fitting the ESP32", 11, "middle"),
          _t(618, POS_Y + 4, "VIN+"), _t(618, NEG_Y + 4, "VIN−"), _t(812, POS_Y + 4, "VOUT+", anchor="end"),
          _t(812, NEG_Y + 4, "VOUT−", anchor="end")]
    # ESP32 DevKit
    p += [_box(930, 110, 180, 200, "#1b5e20", "#e8f5e9"), _t(1020, 136, "ESP32 DevKit", 14, "middle", True, "#1b5e20"),
          _t(1020, 154, "board LDO: 5 V → 3.3 V", 11, "middle"), _t(1020, 170, "(often AMS1117-3.3)", 11, "middle"),
          _t(938, POS_Y + 4, "5V / VIN"), _t(938, NEG_Y + 4, "GND"), _t(1102, POS_Y + 4, "3V3", anchor="end")]
    # the chain's + and - wires
    p += [_wire([(210, POS_Y), (300, POS_Y)], "pv"), _wire([(520, POS_Y), (610, POS_Y)], "bat"),
          _wire([(820, POS_Y), (930, POS_Y)], "5V"), _wire([(1110, POS_Y), (1190, POS_Y), (1190, 380)], "3V3"),
          _t(255, POS_Y - 8, "PV+", 11.5, "middle", True, NET_COLOR["pv"]), _t(565, POS_Y - 8, "BAT+", 11.5, "middle", True, NET_COLOR["bat"]),
          _t(850, POS_Y - 8, "5.0 V", 11.5, "middle", True, SUPPLY_COLOR["5V"]), _t(1150, POS_Y - 8, "3.3 V", 11.5, "middle", True, SUPPLY_COLOR["3V3"])]
    for x1, x2 in ((210, 300), (520, 610), (820, 930)):
        p.append(_wire([(x1, NEG_Y), (x2, NEG_Y)], "gnd"))
    # rails -> modules
    pin, sw = sensor_switch(c, nets)
    box5, b5 = _rail_box(620, 380, 290, "5V", "5 V rail (MT3608 VOUT+) → VCC of",
                         [m for m in nets["5V"] if m not in sw.get("5V", [])])
    box3, b3 = _rail_box(950, 380, 300, "3V3", "3.3 V rail (ESP32 3V3 pin) → VCC of",
                         [m for m in nets["3V3"] if m not in sw.get("3V3", [])])
    # the 5 V branch has to cross the VOUT- -> GND wire: draw a hop so it does not read as a joint
    p += [f'<path d="M890,{POS_Y} L890,{NEG_Y - 8} A8,8 0 0 1 890,{NEG_Y + 8} L890,380" fill="none" '
          f'stroke="{NET_COLOR["5V"]}" stroke-width="2.6"/>', _dot(890, POS_Y, "5V")] + box5 + box3
    bottoms += [b5, b3]
    drops = [(565, NEG_Y), (765, b5), (1100, b3)] + ([(140, 440)] if c.get("ENABLE_BATTERY") else [])
    # Switched sensors (SENSOR_POWER_PIN): a second box under each rail they
    # hang off, fed by a dashed rail wire - the switch sits between the rail
    # and their VCC, so the diagram must not show them on the rail itself.
    for rail, x, w, top in (("5V", 620, 290, b5), ("3V3", 950, 300, b3)):
        if pin is None or not sw.get(rail):
            continue
        # The rail box's GND drop moves to its left edge (x + 16) and the
        # switched box is inset past it, so that drop never runs through
        # the switched box (a crossing would read as a joint).
        drops[drops.index((x + w // 2, top))] = (x + 16, top)
        # short heading: the full "Sensor power switch (GPIO.., ON = ..)" is in the power table,
        # and would not fit the inset box at 13 px bold
        boxs, bs = _rail_box(x + 40, top + 20, w - 40, rail,
                             f"via switch, GPIO{pin} {c.get('SENSOR_POWER_ON')} = on", sw[rail])
        p += [_wire([(x + 80, top), (x + 80, top + 20)], rail, dash=True)] + boxs + \
             [_t(x + 52, bs + 16, "pull resistor: OFF in deep sleep", 11, fill=SUPPLY_COLOR[rail])]
        bottoms.append(bs + 16)
        drops.append((x + w - 16, bs))  # right edge: clear of the note text
    if nets["ext"]:
        # x 170..470: clear of the divider's GND drop (x 140) and the chain's (x 565)
        boxe, be = _rail_box(170, max(bottoms) + 20, 300, "ext", "Own supply (not a board rail)", nets["ext"])
        p += boxe
        bottoms.append(be)
        drops.append((320, be))
    # one common GND bus
    bus = max(bottoms) + 40
    p.append(_wire([(40, bus), (W - 30, bus)], "gnd"))
    for x, y in drops:
        p += [_wire([(x, y), (x, bus)], "gnd"), _dot(x, bus, "gnd")]
    p += [_dot(565, NEG_Y, "gnd"),
          _t(40, bus + 20, "common GND: TP4056 IN− / OUT−, MT3608 VIN− / VOUT−, ESP32 GND, every module, the divider bottom"
             + (", own supplies (−)" if nets["ext"] else ""), 12, bold=True, fill=NET_COLOR["gnd"])]
    p += _legend(bus + 52, [("pv", "panel"), ("bat", "cell + (B+ = OUT+)"), ("5V", "5 V"), ("3V3", "3.3 V")]
                 + ([("ext", "own supply")] if nets["ext"] else []) + [("gnd", "GND")],
                 ["ESP32 DevKit: power it from ONE source only (Espressif) - disconnect the MT3608 before plugging in USB.",
                  "Currents and panel size are typical/estimated values - MEASURE your build (see wiring.html, power budget)."])
    height = bus + 52 + 22 + 17 * 2
    p[0] = p[0].replace(f"viewBox=\"0 0 {W} 0\"", f"viewBox=\"0 0 {W} {height}\"")
    p.append("</svg>")
    return "\n".join(p)


def svg_power_gateway(title, c, mods):
    """Gateway: one 5 V source (USB / mains adapter, or the node's solar
    chain) into the DevKit; the SIM7020 on its own supply; common GND."""
    nets = power_nets(mods)
    W, POS, NEG = 1120, 170, 220
    p = _svg_head(W, 0, title, "Power options." + (" The SIM7020 has its own supply - never the ESP32 3V3 pin."
                                                    if nets["ext"] else ""))
    p += [_box(30, 100, 300, 150, SUPPLY_COLOR["5V"]), _t(42, 126, "5 V source - choose ONE", 14, bold=True, fill=SUPPLY_COLOR["5V"]),
          _t(42, 148, "A) USB cable or 5 V mains adapter", 12), _t(42, 168, "B) solar chain as on the node:", 12),
          _t(58, 186, "panel → TP4056 → 18650 →", 12), _t(58, 204, "MT3608 set to 5.0 V", 12),
          _t(320, POS + 4, "+", 14, "end", True), _t(320, NEG + 4, "−", 14, "end", True)]
    p += [_box(440, 100, 200, 150, "#1b5e20", "#e8f5e9"), _t(540, 126, "ESP32 DevKit", 14, "middle", True, "#1b5e20"),
          _t(540, 144, "board LDO: 5 V → 3.3 V", 11, "middle"),
          _t(448, POS + 4, "5V / VIN or USB", 12), _t(448, NEG + 4, "GND", 12), _t(632, POS + 4, "3V3", anchor="end")]
    p += [_wire([(330, POS), (440, POS)], "5V"), _wire([(330, NEG), (440, NEG)], "gnd"),
          _t(385, POS - 8, "5 V", 11.5, "middle", True, SUPPLY_COLOR["5V"]),
          _wire([(640, POS), (740, POS)], "3V3"), _t(690, POS - 8, "3.3 V", 11.5, "middle", True, SUPPLY_COLOR["3V3"])]
    # rail boxes start just above the wire so it always lands on the box; their
    # GND leaves on the right edge so it never runs through the boxes below
    box3, b3 = _rail_box(740, POS - 22, 320, "3V3", "3.3 V rail (ESP32 3V3 pin) → VCC of", nets["3V3"])
    p += box3
    side_gnd = [b3 - 14]
    drops = [(385, NEG)]
    y = max(250, b3) + 30
    if nets["5V"]:
        box5, b5 = _rail_box(740, y, 320, "5V", "5 V rail (5 V source) → VCC of", nets["5V"])
        # hop over the source's - wire, as on the node diagram
        p += box5 + [f'<path d="M400,{POS} L400,{NEG - 8} A8,8 0 0 1 400,{NEG + 8} L400,{y + 20} L740,{y + 20}" '
                     f'fill="none" stroke="{NET_COLOR["5V"]}" stroke-width="2.6" stroke-linejoin="round"/>',
                     _dot(400, POS, "5V")]
        side_gnd.append(b5 - 14)
        y = b5 + 30
    for m in nets["ext"]:
        p += [_box(440, y, 200, 90, SUPPLY_COLOR["ext"], "#f3e5f5"), _t(540, y + 24, "Own supply", 13, "middle", True, SUPPLY_COLOR["ext"]),
              _t(540, y + 44, "rated for the module's", 11, "middle"), _t(540, y + 60, "transmit peaks (see its", 11, "middle"),
              _t(540, y + 76, "board's datasheet)", 11, "middle"),
              _box(740, y, 320, 90, SUPPLY_COLOR["ext"]), _t(752, y + 24, f"{m['name']}  [own supply]", 13, bold=True, fill=SUPPLY_COLOR["ext"]),
              _t(756, y + 44, "power input: from its own supply only -", 12), _t(756, y + 62, "NOT the ESP32 3V3 pin", 12, bold=True),
              _t(756, y + 80, "UART / PWRKEY: see the GPIO diagram", 12),
              _wire([(640, y + 45), (740, y + 45)], "ext")]
        drops += [(540, y + 90), (900, y + 90)]
        y += 120
    bus = y + 10
    p.append(_wire([(40, bus), (W - 30, bus)], "gnd"))
    for x, yy in drops:
        p += [_wire([(x, yy), (x, bus)], "gnd"), _dot(x, bus, "gnd")]
    for yy in side_gnd:
        p += [_wire([(1060, yy), (1090, yy), (1090, bus)], "gnd"), _dot(1090, bus, "gnd")]
    p += [_dot(385, NEG, "gnd"),
          _t(40, bus + 20, "common GND" + (" - including the SIM7020 (its UART needs the shared reference)" if nets["ext"] else ""),
             12, bold=True, fill=NET_COLOR["gnd"])]
    p += _legend(bus + 52, [("5V", "5 V"), ("3V3", "3.3 V"), ("ext", "own supply"), ("gnd", "GND")],
                 ["ESP32 DevKit: power it from ONE source only (Espressif) - USB OR the 5V pin, not both."])
    height = bus + 52 + 22 + 17
    p[0] = p[0].replace(f"viewBox=\"0 0 {W} 0\"", f"viewBox=\"0 0 {W} {height}\"")
    p.append("</svg>")
    return "\n".join(p)


def power_rows(board, c, mods):
    """(from, to, net, note) rows for the power table - same data as the diagram."""
    nets = power_nets(mods)
    pin, sw = sensor_switch(c, nets)
    # modules wired straight to a rail (the rest sit behind the sensor switch)
    direct = lambda rail: [m for m in nets[rail] if m not in sw.get(rail, [])]
    names = lambda ms: ", ".join(m["name"] for m in ms) or "(none)"
    switch_label = f"Sensor power switch (GPIO{pin}, ON = {c.get('SENSOR_POWER_ON')})"
    switch_note = "resistor on the switch input keeps it OFF in deep sleep"
    if sw.get("5V") and sw.get("3V3"):
        switch_note += f"; one switch per rail (or a dual load switch), both driven from GPIO{pin}"
    rows = []
    if board == "node":
        rows += [("Solar panel +", "TP4056 IN+", "PV+", "Panel open-circuit voltage must stay inside the TP4056 input range"),
                 ("Solar panel −", "TP4056 IN−", "GND", ""),
                 ("TP4056 B+", "18650 cell +", "cell +",
                  f"{float(c.get('BATTERY_EMPTY_V', 3.0)):.1f}–{float(c.get('BATTERY_FULL_V', 4.2)):.1f} V "
                  f"(BATTERY_EMPTY_V / BATTERY_FULL_V)"),
                 ("TP4056 B−", "18650 cell −", "cell −", "ONLY to the cell; not GND (bypasses the protection)"),
                 ("TP4056 OUT+", "MT3608 VIN+", "cell +", "On the common module OUT+ = B+; the protection switches the − side"),
                 ("TP4056 OUT−", "MT3608 VIN−", "GND", "")]
        if c.get("ENABLE_BATTERY"):
            pair, ratio = battery_divider(c)
            rows.append(("TP4056 B+ (cell +)", f"divider {pair} → GPIO{c.get('BATTERY_PIN')} (BATTERY_PIN), bottom → GND",
                         "battery sense", f"BATTERY_DIVIDER_RATIO {ratio:g}"))
        rows += [("MT3608 VOUT+", "ESP32 DevKit 5V / VIN pin", "5V", "Set 5.0 V with the trimmer BEFORE connecting the ESP32"),
                 ("MT3608 VOUT+", "VCC of: " + names(direct("5V")), "5V", "")]
        if sw.get("5V"):
            rows.append(("MT3608 VOUT+", f"{switch_label} → VCC of: " + names(sw["5V"]), "5V switched", switch_note))
        rows.append(("MT3608 VOUT−", "ESP32 GND", "GND", ""))
    else:
        rows += [("5 V source: USB cable / 5 V mains adapter, OR the node's solar chain (MT3608 at 5.0 V)",
                  "ESP32 DevKit USB or 5V / VIN pin (one of them, not both)", "5V", "")]
        if nets["5V"]:
            rows.append(("5 V source", "VCC of: " + names(nets["5V"]), "5V", ""))
    rows.append(("ESP32 3V3 pin", "VCC of: " + names(direct("3V3")), "3V3", "Board LDO output - shared with the ESP32 itself"))
    if sw.get("3V3"):
        rows.append(("ESP32 3V3 pin", f"{switch_label} → VCC of: " + names(sw["3V3"]), "3V3 switched", switch_note))
    if pin is not None and (sw.get("5V") or sw.get("3V3")):
        rows.append((f"GPIO{pin} (SENSOR_POWER_PIN)", "switch EN / gate, pull resistor to its OFF level", "signal",
                     "pins float in deep sleep"))
    for m in nets["ext"]:
        rows.append(("Its own supply", f"{m['name']} power input", "own supply",
                     m.get("own_supply", ("Its own supply - never the ESP32 3V3 pin.",))[0]))
    rows.append(("All GNDs", "one common GND", "GND",
                 ("every module, the ESP32, TP4056 IN− / OUT−, MT3608 VIN− / VOUT−, the divider bottom" if board == "node"
                  else "every module, the ESP32, the 5 V source")
                 + "".join(f", the {m['name']}'s own supply (−)" for m in nets["ext"])))
    return rows


# Datasheets actually read for the figures below (copies, not the vendors'
# own sites, except Espressif) - re-check if you buy a different part.
POWER_SOURCES = {
    "ams1117": ("AMS1117 datasheet (Advanced Monolithic Systems), copy", "https://hirokun.jp/AMS1117.pdf"),
    "mt3608": ("MT3608 datasheet Rev 1.1 (Aerosemi), copy",
               "https://atta.szlcsc.com/upload/public/pdf/source/20250821/8D1549802DC2303BE2CA526A4E3E08C6.pdf"),
    "tp4056": ("TP4056 datasheet (NanJing Top Power ASIC), copy",
               "https://pdf.direnc.net/upload/tp4056-42-smd-sop8-kontrol-entegresi-datasheet.pdf"),
    "devkitc": ("ESP32-DevKitC user guide (Espressif)",
                "https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32/esp32-devkitc/user_guide.html"),
    "esp32": ("ESP32 Series Datasheet v5.3, Table 4-2 (Espressif)", "https://documentation.espressif.com/esp32_datasheet_en.html"),
    "mq135": ("Hanwei MQ-135 technical data, copy", "https://cdn.shopify.com/s/files/1/2132/9029/files/MQ-135.pdf"),
    "pms5003": ("Plantower PMS5003 datasheet PTQ3004-2015 V1.0 (2019-07-31), copy",
                "https://docs.smartcitizen.me/assets/datasheets/pms5003/PTQ3004-2015%20PMS5003%20series%20data%20manual%20English_SLT_V1.0K.pdf"),
}


def _src(key):
    name, url = POWER_SOURCES[key]
    return f" <span class='muted'>[<a href='{esc(url)}'>{esc(name)}</a>]</span>"


def power_notes_html(board, c, mods):
    """Power-budget notes. Every number is a typical datasheet value or the
    project's own estimate - labelled as such, to be MEASURED."""
    nets = power_nets(mods)
    li = []
    if board == "node":
        if c.get("ENABLE_GAS"):
            li.append("<li><strong>MQ135 heater</strong>: heater resistance 33 ohm +-5 %, heating consumption less "
                      "than 800 mW at 5 V, so ~150 mA (5 V / 33 ohm)" + _src("mq135") + ", "
                      + ("only around the reports that carry gas (MQ135_DUTY_CYCLE: by design 195 s per 600 s, "
                         "simulated 32.7 % on-time - ESTIMATE ~1,190 instead of ~3,640 mAh/day at 5 V, config.h). "
                         if c.get("MQ135_DUTY_CYCLE") else
                         "continuously - this is why a gas node cannot deep-sleep. MQ135_DUTY_CYCLE (config.h) "
                         "switches it on only around the reports that carry gas: ESTIMATE ~1,190 instead of "
                         "~3,640 mAh/day at 5 V (clean air; nothing is saved while the node is elevated), but a "
                         "leak between wakes is seen up to one period late, it needs a free GPIO for the MOSFET, "
                         "and it is refused on a siren node (gas is an offline-siren trigger). ")
                      + "The datasheet gives no re-heating time after a short off-time - MEASURE.</li>")
        if c.get("ENABLE_PMS5003"):
            li.append("<li><strong>PMS5003</strong>: active current max 100 mA, standby max 200 µA; stable data at least "
                      "30 s after a wake from sleep (fan)" + _src("pms5003") + ". "
                      + ("Duty cycle on (PMS5003_DUTY_CYCLE): awake 45 s per 300 s by design, simulated 15.4 % - "
                         "ESTIMATE ~375 instead of ~2,400 mAh/day at 5 V."
                         if c.get("PMS5003_DUTY_CYCLE") else
                         "Runs continuously (~2,400 mAh/day at 5 V at the maximum); PMS5003_DUTY_CYCLE (config.h) "
                         "sleeps it between reports by its serial command - no extra wire - ESTIMATE ~375 mAh/day.")
                      + "</li>")
        li.append("<li><strong>Panel size is a design input, not a fact.</strong> The project's own estimate "
                  "(<code>planning/progress.txt</code>): an always-on gas node draws ~200 mA, ~4.8 Ah/day, so one 18650 "
                  "lasts &lt; 1 day and solar needs <em>roughly a 6 W panel</em>. Measure the node's real current with a "
                  "USB meter, then size panel and cell for the worst month's sun at the site. The TP4056 (below) caps this: a "
                  "bigger panel cannot push more than its set current, so (derived, to be MEASURED) the charge into the cell per "
                  "day is at most about (charge current - load current) x hours of usable sun - e.g. (1 A - 0.2 A) x h must cover "
                  "0.2 A x the remaining (24 - h) hours, so h &gt;= ~4.8 h of full-current charging, more after the boost loss. "
                  "Check that against the measured daily consumption before buying a bigger panel.</li>")
        li.append("<li><strong>TP4056</strong>: charges the cell to 4.2 V; R_PROG 1.2k = 1 A (950-1050 mA); ends the "
                  "charge when the current falls to 1/10 of the set value; input (VCC) operating range 4.0-8.0 V, absolute "
                  "maximum 8 V - check the panel's open-circuit voltage (higher than its working voltage, and highest on "
                  "cold mornings) against that limit." + _src("tp4056") + "</li>")
        li.append("<li><strong>TP4056 module without load sharing</strong> (the common one): OUT+ is wired straight to "
                  "B+ (the DW01 / FS8205 protection switches the − side, between B− and OUT−), so the load always runs "
                  "from the cell node, also while charging - the charger's "
                  "current is split between cell and load. That is fine for this design. Side effect: the charger measures "
                  "its total output, so a load above 1/10 of the set current (100 mA at 1 A) can keep it from ever "
                  "seeing the end-of-charge current; it then holds the cell at 4.2 V.</li>")
        li.append("<li><strong>MT3608</strong> (VIN = 5 V, 25 °C): quiescent 100 µA typ / 200 µA max when not switching, "
                  "1.6 mA typ / 2.2 mA max when switching; 0.1 µA only with EN at 0 V - if your module ties EN to VIN "
                  "(check the board), it never shuts down. Input 2-24 V. A boost converter draws MORE current from the "
                  "cell than it delivers at 5 V (input power = output power / efficiency) - measure on the cell side."
                  + _src("mt3608") + "</li>")
    li.append("<li><strong>Board regulator</strong>: many DevKit boards use an AMS1117-3.3 (Espressif's DevKitC guide does "
              "not name the part - read the marking on yours). AMS1117: current limit 900 mA min / 1.1 A typ; quiescent "
              "current 5 mA typ / 11 mA max (at VIN-VOUT = 1.5 V); dropout up to 1.3 V at 0.8 A, so it needs ~4.6 V in"
              + (" - that is why the cell (3.0-4.2 V) goes through the boost to 5 V instead of straight to VIN"
                 if board == "node" else " - feed the 5V pin a real 5 V (on solar: the MT3608, never the bare cell)")
              + ". Its quiescent current flows whenever the board is powered, deep sleep included." + _src("ams1117") + "</li>")
    li.append("<li><strong>Deep sleep on a dev board</strong>: the ESP32 chip itself needs ~10 µA (RTC timer + RTC memory)"
              + _src("esp32") + ", but the board's LDO (above), its USB-UART bridge chip and the 5 V power-on LED"
              + _src("devkitc") + " keep drawing current while the chip sleeps - MEASURE the sleep current; long runs "
              "need a bare module and a low-quiescent regulator (as config.h says).</li>")
    li.append("<li><strong>3.3 V pin budget</strong>: the ESP32 and every 3V3 module (" +
              esc(", ".join(m["name"] for m in nets["3V3"]) or "none") + ") share the board regulator's current limit - "
              "add up their datasheet currents (radio transmit included). The 3V3 pin must not feed 5 V modules"
              + ((" or the " + esc(", ".join(m["name"] for m in nets["ext"]))) if nets["ext"] else "") + ".</li>")
    for m in nets["ext"]:
        if m.get("own_supply"):
            li.append(m["own_supply"][1])
    li.append("<li><strong>One supply at a time</strong>: Espressif - the DevKitC must be powered from one and only one of "
              "USB, the 5V pin or the 3V3 pin, otherwise the board and/or the supply can be damaged."
              + (" Disconnect the MT3608 before plugging in USB for Serial / flashing." if board == "node" else "")
              + _src("devkitc") + "</li>")
    return "<ul>" + "".join(li) + "</ul>"


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
           "All grounds are common. Each board ends with its <strong>power path</strong> and power-budget notes.</p>"]
    for kind, title, c, mods, results in boards:
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
        free, free_strap = free_output_pins(c, mods)
        out.append("<p class='muted'>Free output-capable GPIOs: "
                   + (", ".join(f"GPIO{p}" for p in free) or "none")
                   + "; free strapping pins (keep their boot level): "
                   + (", ".join(f"GPIO{p}" for p in free_strap) or "none") + ".</p>")
        items = parts_list(c, mods)
        if items:
            out.append("<h3>Extra parts</h3><ul>" + "".join(f"<li>{esc(i)}</li>" for i in items) + "</ul>")
        notes = [f"<li><strong>{esc(m['name'])}</strong>: {esc(m['note'])}</li>" for m in mods if m.get("note")]
        out.append("<h3>Module notes</h3><ul>" + "".join(notes) + "</ul>")
        power_svg = svg_power_node if kind == "node" else svg_power_gateway
        out.append(f"<h3 id='power-{kind}'>Power path</h3><div class='diagram'>" + power_svg(f"{title} - power", c, mods) + "</div>")
        out.append("<div class='wrap' style='margin-top:12px'><table><thead><tr><th scope='col'>From</th><th scope='col'>To</th>"
                   "<th scope='col'>Net</th><th scope='col'>Note</th></tr></thead><tbody>")
        for frm, to, net, note in power_rows(kind, c, mods):
            out.append(f"<tr><td>{esc(frm)}</td><td>{esc(to)}</td><td>{esc(net)}</td><td>{esc(note)}</td></tr>")
        out.append("</tbody></table></div>")
        out.append("<h3>Power budget - typical datasheet values and project estimates, to be MEASURED</h3>"
                   + power_notes_html(kind, c, mods))
    out.append("</main></body></html>")
    return "\n".join(out)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--check", action="store_true", help="run the checks only, write nothing")
    ap.add_argument("--set", action="append", default=[], metavar="NAME=VALUE",
                    help="try a node config.h change without editing it, e.g. --set ENABLE_PH=0 --set "
                         "MQ135_HEATER_PIN=33 (checks only - the docs always follow config.h)")
    args = ap.parse_args()

    node_c, gw_c = parse_config(NODE_CFG), parse_config(GATEWAY_CFG)
    for item in args.set:
        name, _, raw = item.partition("=")
        if name not in node_c:
            print(f"--set {item}: {name} is not a #define in the node's config.h")
            return 2
        try:
            node_c[name] = int(raw, 0)
        except ValueError:
            node_c[name] = raw
        args.check = True
    node_m, gw_m = node_modules(node_c), gateway_modules(gw_c)
    transport = "LoRa" if node_c.get("TRANSPORT") == node_c.get("TRANSPORT_LORA") else "WiFi"
    sleep = ", deep sleep" if node_c.get("DEEP_SLEEP_ENABLED") else ""
    boards = [
        ("node", f"Sensor node {node_c.get('NODE_ID', '').strip(chr(34))} ({transport}{sleep})", node_c, node_m,
         check("node", node_c, node_m)),
        ("gateway", "LoRa gateway", gw_c, gw_m, check("gateway", gw_c, gw_m)),
    ]
    errors = 0
    for _kind, title, _c, _m, results in boards:
        print(f"== {title}")
        for level, msg in results:
            print(f"   {level:5s} {msg}")
            errors += level == "ERROR"
        if not results:
            print("   no problems found")
        if _kind == "node":
            free, free_strap = free_output_pins(_c, _m)
            print(f"   free output-capable GPIOs: {', '.join(f'GPIO{p}' for p in free) or 'none'}"
                  f" (strapping, keep their boot level: {', '.join(f'GPIO{p}' for p in free_strap) or 'none'})")
    if not args.check:
        os.makedirs(DOCS, exist_ok=True)
        with open(os.path.join(DOCS, "wiring.html"), "w", encoding="utf-8") as f:
            f.write(page(boards))
        for name, (_kind, title, c, mods, _r) in zip(("wiring_node.svg", "wiring_gateway.svg"), boards):
            with open(os.path.join(DOCS, name), "w", encoding="utf-8") as f:
                f.write(svg_diagram(title, c, mods))
        # The slide shows the node's chain (solar -> TP4056 -> 18650 -> MT3608 -> ESP32);
        # the gateway's power options are in wiring.html.
        _kind, title, c, mods, _r = boards[0]
        with open(os.path.join(DOCS, "wiring_power.svg"), "w", encoding="utf-8") as f:
            f.write(svg_power_node(f"{title} - power path", c, mods))
        print(f"\nWrote docs/wiring.html, docs/wiring_node.svg, docs/wiring_gateway.svg, docs/wiring_power.svg")
    print(f"\n{errors} wiring error(s)")
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
