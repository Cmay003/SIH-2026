# SANJEEVNI - bill of materials (BOM)

**Indicative single-unit retail prices, checked on 2026-10-09, in INR, including 18 % GST, excluding shipping.**
Every price below was read from the linked product page on that date. Prices, stock and listings change; re-check before ordering.
"Out of stock" means the page said so on 2026-10-09 - the price is still the listed one.
**price to check** = no Indian retail price could be verified; it is left out of every total, and the totals say so.

This is a prototype BOM. Nothing here has been field-built: the parts come from the firmware configuration
(`firmware/sanjeevni_lora_node/config.h`, `firmware/sanjeevni_lora_gateway/config.h`) and the wiring generator
(`tools/wiring/generate_wiring.py`, output [`docs/wiring.html`](wiring.html)). No battery runtime, panel size or LoRa range has been measured yet.

## Summary per kit

| Kit | Electronics + solar power path | With enclosure + glands (estimate) | Not in the total |
|---|---:|---:|---|
| Slope / landslide node (tilt only) | Rs 2,394 | Rs 3,453 | mounting, anchoring |
| River / flood node (bench HC-SR04) | Rs 2,493 | Rs 3,552 | rain gauge, mounting, DHT22 radiation shield |
| River / flood node (waterproof AJ-SR04M) | Rs 2,793 | Rs 3,852 | rain gauge, mounting, DHT22 radiation shield |
| + water-quality add-on (pH + turbidity) | + Rs 2,898 | | pH buffer solutions |
| Air-quality node | Rs 4,300.82 | Rs 5,359.82 | adequately sized solar panel + charger (see power), DHT22 radiation shield, PMS5003 vent / vented enclosure, mounting |
| Full node (every sensor + SOS button + siren) | Rs 8,422.82 | Rs 9,481.82 | rain gauge, MOSFET, mounting, adequately sized solar panel + charger, DHT22 radiation shield, PMS5003 vent, pH buffer solutions |
| Gateway, Wi-Fi only (mains 5 V; `ENABLE_NBIOT 0`, not a compile-checked variant) | Rs 1,504 | Rs 2,563 | mounting |
| Gateway, Wi-Fi + NB-IoT (mains 5 V) | Rs 3,272.82 | Rs 4,331.82 | NB-IoT SIM + data plan, mounting; uses the G2 HAT (out of stock, untested with the ESP32) - see G2b |
| SOS push-button add-on (any node) | + Rs 149 | | |
| Village siren add-on (always-on node, mains 12 V) | + Rs 688 | | MOSFET (price to check) |

How the totals are built (sums of the line items below, computed, not quoted):
- **Core** (every node and the gateway) = ESP32 DevKit Rs 499 + Ra-02 LoRa with antenna Rs 706 = **Rs 1,205**.
- **Solar power path** (every node) = TP4056 Rs 49 + MT3608 Rs 49 + 18650 cell Rs 169 + holder Rs 29 + 6 V 5 W panel Rs 599 = **Rs 895**.
- **Passives** (every node) = one 150-piece resistor kit Rs 95 (dividers, pull-ups, gate and series resistors).
- **Enclosure (estimate)** = IP65 box Rs 999 + 4 cable glands x Rs 15 = **Rs 1,059**. The size and the number of glands are a guess for a bench-sized build; no field enclosure has been designed or tested.
- **Gateway** has no solar path and no passives in these totals: it is powered from a 5 V mains adapter (Rs 299).

### Compared with the earlier cost claims

The slides and planning notes quoted **"~Rs 2,500 per sensor node"** and **"~Rs 3,500 per gateway"** with no BOM behind them.
Against these prices:
- About Rs 2,500 holds only for the **electronics of the simplest nodes** (tilt-only Rs 2,394; river node with the bench ultrasonic Rs 2,493 *before* a rain gauge). With an enclosure it is about Rs 3,450 - 3,850, and an air-quality node is about Rs 5,360 (the PMS5003 alone is Rs 1,768.82). A full node with every sensor, SOS button and siren is about Rs 8,420 for the electronics, about Rs 9,480 with the enclosure.
- About Rs 3,500 matches the **Wi-Fi + NB-IoT gateway electronics** (Rs 3,272.82) without enclosure, SIM or data plan; about Rs 4,330 with the enclosure. That figure uses the G2 NB-IoT HAT, which was out of stock on 2026-10-09 and has never been wired to an ESP32; the in-stock G2b module (Rs 2,999) also needs an unpriced carrier board.
- The always-on air-quality and full-node totals include only the 5 W panel (P5), which the project's own estimate rates as too small for them, and no larger panel + charger pairing that stays within the charger module's input limit has been priced (see the panel warning).

Safe wording: *"Node electronics with the solar power path from about Rs 2,400 (tilt-only) to about Rs 8,400 (all sensors + SOS button + siren); gateway about Rs 3,300 (Wi-Fi + NB-IoT, using an NB-IoT HAT that was out of stock and is untested with the ESP32); indicative single-unit retail prices incl. GST on 2026-10-09, excl. shipping, enclosure, mounting, and an adequately sized panel and charger for the always-on gas/PM nodes - see docs/BOM.md."* Volume prices are somewhat lower (the Probots 25+ tiers checked are about 2-5 % below the single-unit price), but no volume quote has been asked for.

Not known yet: how many nodes one gateway can serve (not measured), the real panel and battery size (not measured), and the price of a field-legal radio (see below).

## Line items

All Probots prices are the GST-inclusive total shown on the page (base + 18 % GST). Hubtronics shows the price before GST; the figure here is its own GST-inclusive figure.

### Core (every node and the gateway)

| # | Part | Qty | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---:|---|---|
| C1 | ESP32 30-pin DevKit, ESP-WROOM-32, CP2102, micro-USB (Probots PRO5511) | 1 | Rs 499.00 | <https://probots.co.in/esp32-30-pin-cp2102-development-board.html> | In stock |
| C2 | Ai-Thinker Ra-02 SX1278 433 MHz LoRa module + IPEX spring antenna (Probots) | 1 | Rs 706.00 | <https://probots.co.in/ai-thinker-ra-02-lora-module-sx1278-433mhz-ipex-antenna.html> | In stock; antenna included. **433 MHz - see "Radio band" below** |

### Sensors

| # | Part | Unit price | Product page (accessed 2026-10-09) | Used by | Notes |
|---|---|---:|---|---|---|
| S1 | HC-SR04 ultrasonic, 5 V (Probots PRO936) | Rs 99.00 | <https://probots.co.in/hc-sr04-5v-ultrasonic-distance-sensor-2-450cm-range-for-arduino.html> | river, full | In stock. Open mesh transducers: bench use, not weatherproof |
| S1f | AJ-SR04M waterproof ultrasonic, 2.5 m cable (Probots PRO656) | Rs 399.00 | <https://probots.co.in/waterproof-ultrasonic-distance-sensor-module-jsn-sr04t.html> | river (field option) | **Out of stock.** The page says its default mode uses HC-SR04-style trigger/echo; **not yet tested with our firmware**; 20 cm blind zone; its control board is not waterproof |
| S2 | DHT22 (AM2302) module (Probots PRO1287) | Rs 199.00 | <https://probots.co.in/dht22-humidity-and-temperature-sensor-module.html> | river, air, full | In stock. Outdoors it needs a radiation shield (price to check) |
| S3 | MQ-135 gas module (Probots PRO2169) | Rs 99.00 | <https://probots.co.in/mq135-air-quality-hazardous-gas-sensor-module.html> | air, full | **Out of stock.** Non-selective, uncalibrated gas indicator; heater keeps the node always on |
| S4 | IR flame module, 3-pin, LM393 (Probots PRO1261) | Rs 39.00 | <https://probots.co.in/ir-flame-sensor-module-3-pin-digital-fire-detector-for-arduino.html> | air, full | In stock. The page warns of false triggers in direct sunlight |
| S5 | Capacitive soil moisture (Probots PRO1003, sold as "V2.0"; config.h names v1.2) | Rs 89.00 | <https://probots.co.in/soil-moisture-sensor-capacitive-v1-2.html> | full (slope option) | In stock. Re-run the dry/wet calibration (`s` command) for whichever version arrives |
| S6 | MPU6050 GY-521 (Probots PRO419) | Rs 199.00 | <https://probots.co.in/mpu6050-6dof-imu-sensor-module-gyroscope-accelerometer-gy521.html> | slope, full | In stock. Exposed PCB: needs the enclosure |
| S7 | Plantower PMS5003 PM2.5/PM10 + cable (Hubtronics) | Rs 1,768.82 | <https://hubtronics.in/pms5003-pm2.5-sensor> | air, full | **Out of stock.** Listed Rs 1,499 + 18 % GST |
| S8 | Analog pH board + E-201-C BNC probe (Probots PRO662) | Rs 1,899.00 | <https://probots.co.in/ph-sensor-with-analog-output-for-arduino-and-raspberry-pi.html> | water-quality add-on, full | In stock. The page does not name the board PH-4502C; check its output range against `PH_ADC_DIVIDER_RATIO`. Buffer solutions not included (price to check) |
| S9 | Turbidity module kit (Probots PRO4604) | Rs 999.00 | <https://probots.co.in/turbidity-sensor-module-testing-suspended-particle-value-detection-kit.html> | water-quality add-on, full | In stock. The page says both 0-4.5 V and 0-5 V output - measure before trusting the divider |
| S10 | Tipping-bucket rain gauge with reed switch | **price to check** | - | river, full (slope option) | No hobby-grade reed-switch gauge could be verified at an Indian retailer on 2026-10-09. The firmware needs a plain reed-switch contact (`RAIN_GAUGE_PIN`); a gauge with only an I2C/UART output would need firmware changes |

### Solar power path (every node; designed, not built or measured)

| # | Part | Qty | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---:|---|---|
| P1 | TP4056 1 A charger with DW01 protection, USB-C (Probots PRO2685) | 1 | Rs 49.00 | <https://probots.co.in/tp4056-1a-li-ion-lithium-battery-charging-module-with-current-protection-type-c.html> | Listed in stock, but the page also says this board is no longer made - confirm availability. **The page lists the module's input as 4.5-5.5 V** - narrower than the TP4056 IC's 4.0-8.0 V; see the panel warning |
| P2 | MT3608 boost module (Probots PRO701) | 1 | Rs 49.00 | <https://probots.co.in/mt3608-step-up-boost-module-3-24v-to-5-28v-2a-power-regulator.html> | In stock. Set to 5.0 V before connecting the ESP32 |
| P3 | 18650 Li-ion cell (Probots PRO1088) | 1 | Rs 169.00 | <https://probots.co.in/samsung-icr-18650-26j-2600mah-li-ion-cell-original.html> | In stock. The page says both 2500 and 2600 mAh - check the cell |
| P4 | 1 x 18650 holder with wires (Probots PRO859) | 1 | Rs 29.00 | <https://probots.co.in/1-x-18650-lithium-ion-battery-holder-socket-with-wire.html> | In stock |
| P5 | Solar panel 6 V 5 W (Probots PRO2149) | 1 | Rs 599.00 | <https://probots.co.in/solaris-solar-panel-for-diy-projects-and-robotics-6v-5-watt.html> | **Out of stock; open-circuit voltage not listed.** See the panel warning below |
| P6 | Resistor kit, 1/4 W, 150 pcs, 10 R - 470 k (Probots PRO129) | 1 | Rs 95.00 | <https://probots.co.in/assorted-resistor-box-1-4-watt.html> | In stock. The listed values include 100 R, 1 k, 10 k, 100 k; **no 2 k or 20 k** - use 2 x 1 k and 2 x 10 k in series for the 1k/2k and 10k/20k dividers. The seller says the values supplied vary with stock ("call and confirm before placing the order") - check the kit before relying on these values |

**Panel warning (from datasheet and seller limits, not a measurement).** The TP4056 IC's input operating range is 4.0-8.0 V with an absolute maximum of 8 V (TP4056 datasheet, cited in `tools/wiring/generate_wiring.py`). The module priced in P1 is stricter: its own page lists **4.5-5.5 V input** (accessed 2026-10-09). A nominal 6 V panel's open-circuit voltage is typically above its nominal voltage, so even the P5 panel (Voc not listed) may be outside the module seller's stated range - **confirm with the seller, or use a charger rated for a 6 V panel, or put a regulator in front of the TP4056.** Two panels checked on 2026-10-09 would also **exceed** the IC's 8 V limit:
a "9 V 6 W" panel ([Probots PRO5256](https://probots.co.in/9v-6-watt-solar-panel-for-diy-electronics-projects-robotics.html), Rs 1,399, Voc 9 V on its page - but the page's specs contradict each other: Vmp 11 V is above Voc, and Imp 320 mA x Vmp 11 V is about 3.5 W, not 6 W, so do not rely on its figures)
and a "6 V 10 W" panel ([Moglix, Solar Universe India](https://www.moglix.com/solar-universe-india-10w-6v-polycrystalline-solar-panel-for-batteries-systems/mp/msn85801o0ml92-g), Rs 649, Voc 11 V on its page).
A 12 V panel is also unsuitable. With this module, keep the charger input inside the seller's 4.5-5.5 V (and never above the IC's 8 V absolute maximum - a panel's open-circuit voltage rises on cold mornings), or put a suitable regulator / solar charger in front of the cell.
The project's own estimate (planning notes, also in `docs/wiring.html`) is that an always-on gas/PM node draws ~200 mA (~4.8 Ah/day) and needs **roughly a 6 W panel**; the 5 W panel priced here is below that, and the TP4056's 1 A ceiling limits what a bigger panel can add. Sensor-only nodes can deep-sleep and need much less. **Measure the node's current before choosing a panel.**

### SOS push-button add-on

| # | Part | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---|---|
| B1 | 16 mm metal momentary push-button, flat head, IP65 per seller (Probots PRO3071) | Rs 149.00 | <https://probots.co.in/16mm-metal-bell-horn-push-button-flat-head.html> | In stock. The page is inconsistent about the part number (-01F / -10F) and SPST/SPDT; NO contact needed. 1 k series resistor from P6 |

### Village siren add-on (always-on node only; `SIREN_PIN`)

| # | Part | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---|---|
| V1 | 12 V red strobe light with hooter, 300 mA, 103 dB (Probots PRO3589) | Rs 499.00 | <https://probots.co.in/promax-12v-red-strobe-warning-light-with-hooter-flashing-alarm.html> | In stock. No IP rating and 0-40 °C operating range on the page - not an outdoor-rated siren |
| V2 | 12 V 2 A SMPS adapter (Probots PRO1426) | Rs 189.00 | <https://probots.co.in/12v-2a-power-supply-smps-adaptor-premium.html> | In stock. Mains option for the siren's own supply; a solar/battery 12 V supply is **price to check** (size it from the siren's current) |
| V3 | AO3400A logic-level N-MOSFET (SOT-23) | **price to check** | Datasheet: <https://www.aosmd.com/res/datasheets/AO3400A.pdf> (Rev 3.1, July 2023) | Chosen because the datasheet specifies R<sub>DS(on)</sub> < 48 mOhm at V<sub>GS</sub> = 2.5 V (30 V, 5.7 A) - the ESP32 drives 3.3 V. No Indian retailer listing verified. 100 R gate + 10 k gate-to-GND from P6 |

A flyback diode is only needed for a coil or motor load (`docs/wiring.html`); price to check if used.

What the siren is for (team decision 2026-10-09, not a hardware fact): the server sounds it automatically only for a confirmed CRITICAL evacuation hazard at that node (flood, flash flood, landslide, fire, gas leak - `SIREN_AUTO_HAZARDS`), never for heat, air pollution, smoke or a weather forecast; officers can sound it for anything. A siren node sends its normal summary every minute (so a command arrives within a minute) and stays always-on; a node without a siren sends it every 5 minutes. Any energy figure for either cadence is an estimate until measured on a built node.

### Enclosure and mounting (estimate)

| # | Part | Qty | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---:|---|---|
| E1 | IP65 ABS enclosure 17.5 x 10 x 8 cm, ProtechT WPE17 (Probots PRO3138) | 1 | Rs 999.00 | <https://probots.co.in/protecht-ip65-waterproof-plastic-enclosure-wpe17.html> | In stock. IP65 is the seller's claim. Size not checked against a real layout |
| E2 | PG07 plastic cable gland, 3-6.5 mm cable (Probots PRO1029) | 4 (estimate) | Rs 15.00 | <https://probots.co.in/polymide-cable-glands-pg-07.html> | In stock. Pack size not stated - assumed one gland |
| E3 | DHT22 radiation shield, PMS5003 inlet/outlet vent, pole and clamps, solar panel bracket | - | **price to check** | - | Not designed. A sealed IP65 box cannot hold a PMS5003 or DHT22 measuring outside air |

### Gateway

| # | Part | Unit price | Product page (accessed 2026-10-09) | Notes |
|---|---|---:|---|---|
| G1 | ESP32 DevKit (C1) + Ra-02 with antenna (C2) | Rs 1,205.00 | see C1, C2 | |
| G2 | SIM7020E NB-IoT HAT (Waveshare design; Hubtronics) | Rs 1,768.82 | <https://hubtronics.in/sim7020e-nb-iot-hat> | **Out of stock.** Listed Rs 1,499 + 18 % GST. Page: 5 V supply, 3.3 V logic by default, antenna included. Made for a Raspberry Pi header - wire its UART/PWRKEY to the ESP32 by hand; **not yet tested** |
| G2b | SIM7020E bare module with FPC antenna (Probots PRO2896), alternative | Rs 2,999.00 | <https://probots.co.in/sim7020e-wireless-lte-nb-iot-gsm-gprs-module-with-with-fpc-antenna.html> | In stock, but a bare SMT module (2.1-3.6 V): needs a carrier board with SIM holder and supply - not in the total |
| G3 | 5 V 2 A adapter with micro-USB cable (Probots PRO2262) | Rs 299.00 | <https://probots.co.in/5v-2a-erd-adapter-with-micro-usb-cable-for-raspberry-pi.html> | **Out of stock.** Any 5 V supply that meets the DevKit's needs works; the HAT needs its own 5 V too |
| G4 | NB-IoT SIM and data plan | **price to check** | - | Check which operator offers NB-IoT on SIM7020E's bands (B1/B3/B5/B8/B20/B28) at the site |
| G5 | Enclosure + glands (E1, E2) | Rs 1,059.00 | see E1, E2 | estimate |

## Which parts each kit uses

Kits follow the `ENABLE_*` switches in `firmware/sanjeevni_lora_node/config.h` (every sensor is optional). Only the full node and the tilt-only node are named variants in `tools/firmware_build/compile_variants.py` (`node-default`, `node-tilt-only`); both compiled for the ESP32 on 2026-10-10 in the full 29-variant run after the latest firmware changes (`node-default` 36% flash, `node-tilt-only` 35%). The river and air kits are other combinations of the same switches and have not been compiled as named variants.

| Kit | Sensors | Power mode | Edge model (int8 TFLite Micro) |
|---|---|---|---|
| Slope / landslide (tilt-only) | S6 (+ battery sense); optional S5, S10 | can deep-sleep (no siren) | no - needs water, DHT, gas and flame |
| River / flood | S1 or S1f, S2, S10; optional S8 + S9 | can deep-sleep without the siren | no |
| Air quality | S7, S3, S2, S4 | always on (MQ135 heater, PMS5003 fan) | no |
| Full node | S1 (or S1f) and S2-S10, B1, V1-V3 | always on | yes (has water, DHT, gas, flame) |
| Gateway | - | mains 5 V (solar chain optional, as in `docs/wiring.html`) | - |

## Radio band - field cost not included

The SX1278 / Ra-02 is a **433 MHz** part. `config.h` already warns that the band and power must be confirmed for India (WPC rules) and that the 865-867 MHz LoRa band needs an SX1276/RFM95-class 868 MHz module instead. That module's price is **price to check**; a field deployment would replace C2 with it, which changes every total above.

## What this BOM does not prove

- These are prices, not measured costs of a working field unit: no node has been built into an enclosure, powered from solar, or tested outdoors.
- Battery runtime, panel size, LoRa range and nodes per gateway are not measured.
- Several listed parts were out of stock on 2026-10-09; a substitute may cost more.
