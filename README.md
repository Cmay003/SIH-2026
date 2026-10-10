# SANJEEVNI

**AI + IoT environmental monitoring network for early disaster detection and response** — Smart India Hackathon 2026, problem statement SIH26178 (Disaster Management, Hardware), Team V.A.S.H.I.K.A.R.A.N.

ESP32 sensor nodes check their readings on the device (thresholds, sensor-fault checks and, on full nodes, a small neural network), talk to a gateway over point-to-point **LoRa radio links with our own acknowledged, de-duplicated protocol (not LoRaWAN)** - no internet needed at the node - and the gateway forwards readings over WiFi or NB-IoT. A backend combines a physics model (SCS Curve Number) with machine learning to score risk, confirms alerts across nodes before they go public, and gives officers a live map while citizens get an SOS page and opt-in WhatsApp alerts (dry run until a WhatsApp Business account is approved). The nodes' solar power path is designed and documented, not yet built or measured.

> **Status (October 2026):** working prototype, not field-deployed. The software runs end to end with the included simulator, and **all data shown in the demo is simulated**. The LoRa/NB-IoT node and gateway firmware compiles for the ESP32: all 29 configuration variants in `tools/firmware_build/compile_variants.py` passed on 2026-10-10 after the latest firmware changes (19 build; the 10 "must fail" unsafe combinations are refused as designed; node ~36% of flash, gateway with the offline SOS Wi-Fi 88%). The firmware passes its unit tests on a PC, but has **not yet been flashed on real boards**; the SIM7020 NB-IoT driver has never run on a module. The flood, LSTM and edge models are trained on **synthetic data** — they demonstrate the pipeline, not real-world accuracy. Parts and indicative prices: [`docs/BOM.md`](docs/BOM.md).

---

## What it does

| Area | Details |
|---|---|
| Hazards | Flood (SCS-CN runoff + calibrated gradient boosting + SHAP explanations), flash flood (rate of rise), gas (MQ135: a broad-spectrum gas anomaly indicator, not a chemical identifier), fire (IR flame) and smoke (PM2.5 and gas rising together), extreme heat (single-sensor thresholds based on IMD's heat-wave criteria - a node reading is not an IMD declaration), landslide (tilt + vibration), air pollution (instantaneous PM2.5 / PM10 banded on CPCB NAQI breakpoints for early warning - not an official AQI), water quality (pH and turbidity measured and classified; thresholds still being aligned to WHO / BIS) |
| False-alarm control | Isolation Forest sensor-fault filter; **multi-node cross-check** — an alert becomes public only when a repeat reading or a neighbouring node confirms it (officers see it immediately as "pending") |
| On the node (edge) | Every node: local thresholds and sensor checks (stuck value, spike, impossible rate, dropout - rule-based, sent as `edge_anomaly`) and the river's rate of rise. Full nodes only (water level, DHT22, MQ135 and flame all fitted): an int8 TensorFlow Lite Micro model (NORMAL / WATCH / URGENT) that compiled for the ESP32 (2026-10-09) but has not yet run on a board; trained on synthetic data, it reproduces the project's threshold rule and cannot beat it. Report by exception (team decision 2026-10-09): a WATCH / URGENT reading, a fast rise, a new anomaly flag and an SOS press go at once; otherwise a node sends one summary report (min / max / mean of the samples since the last one) every **5 minutes**, or every **minute** if it has a village siren (so a siren command, which rides on the answer to a report, arrives within a minute). Node health judges each node by its own interval: it is listed as missing only after 6 of its report intervals without a reading (at least 60 s), so a 5-minute node is not flagged early. Statistical anomaly filtering (Isolation Forest) runs on the server |
| Offline / outages | Node and gateway keep readings in a flash queue until acknowledged (store-and-forward); readings carry their age so late uploads keep correct timestamps; duplicates are ignored |
| Officers | Live map: hazard zones, SOS requests (with triage queue and routes), sensor node health and missing-node alerts, river-level forecast (LSTM vs straight-line), optional Sentinel-1 radar cross-check (tested with mocked API responses only), village sirens on nodes (firmware and server written, not yet on hardware; status per node; "Sound village siren" / "Silence" with a confirmation; sounds by itself only for a confirmed CRITICAL **evacuation** hazard at that node - flood, flash flood, landslide, fire, gas leak - never for heat, air pollution, smoke or a weather forecast, which officers can still sound it for by hand); WhatsApp alerts to officers' phones (dry run until Meta approves a template; one message per hazard episode, and a forecast alert says "FORECAST" and goes out once for the whole area, not once per node); hotspot layer with its definition shown next to the list; every alert shows **"Confidence: High (82%)"** and the reasons behind it on the dashboard, officer map and alarm pop-up (lists stay in severity order) - an explainable score from confirmation, edge agreement, data quality and calibration, not a measured probability |
| Citizens | SOS page (English / Hindi, voice note; inside a confirmed hazard zone: the hazard, its severity and 2-3 things to do now; nearest hospital outside any HIGH/CRITICAL zone, by straight-line distance; if location is denied, unavailable or slow, the person can tap their position on a map or type coordinates, and officers see that SOS marked "set by hand"; on a device without GPS - whose Wi-Fi / cell / IP position can be kilometres off - the page sends the browser's accuracy, says when the fix is approximate (worse than ±500 m) and offers the map, without ever holding the SOS back), SOS push-button on LoRa sensor nodes for people with no phone (shown to officers as "SOS button on node ..." at the node's position), offline "SANJEEVNI-SOS" Wi-Fi on gateways (and optionally mains/solar nodes) for phones without mobile data (shown to officers as "via offline SOS Wi-Fi at NODE - within ~150 m", with people count and needs), WhatsApp SOS (share a location, or text SOS / HELP / EMERGENCY after sharing one) and opt-in hazard alerts (`ALERTS ON` / `STOP`) - WhatsApp runs in dry-run mode (messages are logged, not sent) until a Meta Business account and message template are approved |
| Integration | Each confirmed alert can be exported as CAP 1.2 XML, the format NDMA's SACHET platform consumes (simulated alerts are marked `Exercise`); **not connected to SACHET**, which needs government authorisation. A PDF situation report per alert |
| Administration | Node registry page: add, edit or remove sensor nodes (position on a map, land use, upstream node, report interval) with live status — admin role only, every change logged. **Model card** on the same page: each model's purpose, training/test data (labelled SYNTHETIC), results vs a simple baseline, false-alarm and miss rates, calibration and limitations (generate it with `venv\Scripts\python.exe ml\evaluate_models.py`) |
| Security | Staff login (scrypt-hashed passwords, roles, lockout), device keys for sensor ingestion, strict Content-Security-Policy on the React pages |

## Architecture

```
 ESP32 nodes ──LoRa──► LoRa gateway ──WiFi / NB-IoT──┐
 (sensors, checks,      (flash queue)                │  X-Device-Key
  flash queue)                                       ▼
 server/simulation.js ──────────────────────► server/server.js (Node, :3000) ──► backend/backend_server.py (FastAPI, 127.0.0.1:8000)
                                              pages, login, SOS,                   AI pipeline, node registry,
 browsers / phones / WhatsApp ──────────────► WhatsApp, device keys                forecasts, CAP, reports
                                                        └──────── var/sanjeevni.db (SQLite, shared) ────────┘
```

## Problem statement coverage (SIH26178)

An honest summary of where the prototype stands against each part of the problem statement. "Built" means implemented and tested in software with simulated data; nothing has been field-deployed.

| PS part | Built | Partial / designed only | Not yet |
|---|---|---|---|
| 1. Distributed smart sensor nodes | Modular node firmware for water level, rain, temperature / humidity, gas, flame, PM2.5 / PM10, soil moisture, tilt / vibration, pH, turbidity; self-test; store-and-forward flash queue | Solar power path designed, not built or measured; firmware compiled (all 29 variants, 2026-10-10) but is not yet flashed on boards | Weatherproof field unit (enclosure, shields, mounting) |
| 2. On-device analytics | Local thresholds, rule-based sensor-fault checks, rate of rise, report by exception with per-minute summaries | int8 neural network on full nodes only, synthetic-trained, compiled but not yet run on a board | Learned anomaly detection on the node (the Isolation Forest runs on the server) |
| 3. Multi-hazard early warning | Flood, flash flood, fire, smoke, gas, heat (IMD heat-wave criteria), landslide, air pollution, water quality; heavy rain (IMD rainfall categories, from the node's gauge or the Open-Meteo forecast) and high wind (forecast only) - forecast-only alerts stop at HIGH and never sound a siren; the automatic village siren is for evacuation hazards only (`SIREN_AUTO_HAZARDS`); cross-node confirmation before an alert goes public; explainable confidence score | Thresholds marked as demo defaults still need calibrating per site | Validation on real hazard events |
| 4. Regional risk mapping | Live severity-coded hazard map, SOS layer, node health; hotspot layer and per-node sensor values on the officer map; Trends & Reports page (per-node trends over 24 h / 7 d / 30 d, district summary, CSV / print) - all on simulated data and labelled so | Hotspot score and exceedance node-hours are project choices / indicative, not an official index | Real historical data |
| 5. Community and authority alerts | Officer map with control-room alarm; citizen SOS page (EN / HI); node SOS button and offline SOS Wi-Fi (firmware, not on hardware); CAP 1.2 export per alert and a public Atom feed of active confirmed alerts (`/cap/feed.atom`, CAP checked against the OASIS 1.2 schema in tests) | WhatsApp alerts to citizens and officers in dry-run mode; village siren firmware written, not on hardware | SMS, app push, cell broadcast; SACHET connection |
| 6. Cloud + edge hybrid | Edge checks on the node, heavier models (SCS-CN + gradient boosting, LSTM forecast, Isolation Forest) on the server; siren command downlink (firmware not yet on hardware) | Retraining pipeline is manual; models trained on synthetic data | Remote node configuration / OTA updates |
| 7. Scalable, cost-effective | Several gateways can hear the same node (duplicates dropped); node registry; LoRa + WiFi / NB-IoT backhaul; itemised [BOM](docs/BOM.md) | NB-IoT driver untested on a module; one self-hosted server (SQLite). Load test on one laptop (`tools/loadtest`, simulated readings): `server.js` alone handled 1000 nodes at about 2 % of one core, but the AI backend (one reading at a time, about 0.25 s CPU each) already fell behind at 100-200 nodes reporting once a minute. Once a minute is the normal-time rate with a siren on every node, not the peak: during an area-wide hazard each affected node sends every sample (every 5 s, 12x that rate), so event bursts are the real capacity limit (model one with `--interval 5` over a subset of nodes) | LoRaWAN (we use our own LoRa protocol), native 5G, multi-district deployment |

**Cost:** with the indicative retail prices in [`docs/BOM.md`](docs/BOM.md) (2026-10-09, incl. GST, excl. shipping), node electronics including the solar power path range from about Rs 2,400 (tilt-only) to about Rs 8,400 (every sensor plus SOS button and siren; about Rs 9,500 with an enclosure); about Rs 3,450 - 5,360 for the river, slope and air-quality kits with an enclosure; a Wi-Fi + NB-IoT gateway is about Rs 3,300 (about Rs 4,330 with an enclosure; this uses an NB-IoT HAT that was out of stock on 2026-10-09 and has not been tested with the ESP32 - the in-stock alternative module is Rs 2,999 plus an unpriced carrier board). Earlier "~Rs 2,500 per node" figures hold only for the simplest node's electronics. Not priced yet: rain gauge, mounting, a field-legal 865-867 MHz radio, the NB-IoT plan, and an adequately sized panel and charger for the always-on gas/PM nodes (the air-quality and full-node totals use a 5 W panel that the project's own estimate rates as too small, and both larger panels checked exceed the charger module's input limit).

Hazard analytics (trend charts, hotspot summary), the public CAP Atom feed and forecast-based heavy-rain / high-wind alerts were integration-tested on 2026-10-09 with simulated data only (unit tests plus the scripted judge demo, 16/16 checkpoints).

## Quick start (Windows PowerShell)

Requirements: Python 3.12, Node.js 22.5+ (built-in `node:sqlite`), optionally ngrok and the Arduino IDE.

Every command runs from the project folder (`SIH-2026`); they also work from any other folder.

```powershell
# 1. Install
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt   # includes TensorFlow (large) for training + the model card
# requirements-lock.txt pins every package exactly, if a newer version ever breaks something
npm install --prefix server
npm install --prefix frontend
npm run build --prefix frontend

# 2. Models (trained on synthetic data if data\*.csv is absent) -> var\models\
venv\Scripts\python.exe ml\train_models.py
venv\Scripts\python.exe ml\train_river_forecast.py      # optional (LSTM river forecast)
# Edge models for the ESP32 (optional, built in var\edge_ai_build). Two models: --model main
# (full nodes: water, DHT, gas, flame) and --model lite (deep-sleep / gas-free / tilt-only nodes):
#   ml\make_edge_dataset.py --model main  ->  ml\train_edge_model.py --model main
#   ml\quantize_edge_model.py --model main --install   (copies the header into the firmware)
#   ml\verify_quantized_model.py --model main          (same four steps with --model lite)
# then venv\Scripts\python.exe ml\evaluate_models.py to refresh the model card.
# Windows 11 "Part of this app has been blocked ... _wrappers.cp312-win_amd64.pyd": Smart App
# Control blocks wrapt's compiled helper. backend_server.py and the ml\ TensorFlow scripts set
# WRAPT_DISABLE_EXTENSIONS=1 themselves (pure-Python wrapt); for any other script, run
# $env:WRAPT_DISABLE_EXTENSIONS = "1" in that PowerShell window first.

# 3. A staff login and a device key for the simulator (no defaults exist)
node server\create_user.js add <your-name> officer
node server\device_keys.js add simulator --kind simulator   # put the printed key in .env as SANJEEVNI_INGEST_KEY=...

# 4. Run (three terminals)
venv\Scripts\python.exe -m uvicorn backend_server:app --app-dir backend --host 127.0.0.1 --port 8000
node server\server.js
node server\simulation.js            # optional fake sensor network; --help for options

# Scripted judge demo (SIMULATED data, PASS/FAIL checkpoint after each cue). --fresh runs on a
# temporary copy of var\ with its own servers on ports 3100/8100 and never writes the real database.
node server\simulation.js --scenario judges --fresh
```

Open <http://localhost:3000/> (dashboard), `/officer.html` (officer map), `/sos.html` (citizen page, public), `/admin.html` (node registry and model card — admin accounts only: `node server\create_user.js add <name> admin`; needs `OFFICER_API_KEY` in `.env`). React pages are served by default; `FRONTEND=classic` serves the original HTML pages instead.

**Emergency alarm (control room, officer accounts only):** for officers, the dashboard and officer map pop up a full-screen alert and sound a siren for every confirmed HIGH/CRITICAL hazard until they press *Acknowledge* (on the dashboard, Acknowledge also opens the officer map on the most severe hazard; viewers and admins see the hazards without the alarm) (an acknowledged hazard stays quiet unless it escalates to CRITICAL or has been gone for 10 minutes). Forecast-based alerts (heavy rain, high wind from the weather forecast) are raised at every node in the forecast area, so the pop-up shows them as ONE area-wide item per hazard type ("Heavy rain forecast - 3 nodes", listing the nodes) instead of one item per node; a node joining an acknowledged forecast does not set the alarm off again. Alerts measured by a node's own sensors are still one item per node. Browsers only allow sound after one click on the page, so click the page once after opening it (the header shows "Click to enable sound" until then). Keep the alarm screen in its own browser window or on its own monitor rather than in a background tab, and in Chrome add the site under *Settings > Performance > Memory Saver > Always keep these sites active*: a discarded tab cannot alarm at all.

### Optional `.env` settings
`OFFICER_API_KEY` (API access for scripts), `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ALERT_TEMPLATE` (without them WhatsApp runs in dry-run mode and only logs), `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (Sentinel-1), `CAP_WEB_URL`, `SANJEEVNI_INGEST_KEY` (simulator).

`WHATSAPP_APP_SECRET` is **required once WhatsApp is live**: incoming webhooks must carry Meta's `X-Hub-Signature-256`, and without the secret live webhooks are refused (dry-run mode accepts them unsigned for testing).

Tuning (defaults are fine): `SANJEEVNI_BENCH_MODE=1` (tabletop rig only — tiny water-level thresholds), `SANJEEVNI_BENCH_MOUNT_M` (bench sensor height, default 0.0234 m), `SANJEEVNI_MAX_RIVER_LEVEL_M` (above this a reading is treated as a sensor fault, default 10), `SANJEEVNI_MAX_RIVER_RATE_M_PER_HR` (rise/fall rates are capped at this, default 5), `SANJEEVNI_RIVER_RATE_CLEAR_CHANGE_M` (a step in river level at least this big, with the 3 newest readings on the same side, counts as a real rise even when older history is sparse; smaller steps must pass the noise test - demo default 0.3 m, verify per site), `STALE_HAZARD_MINUTES` (web server: a hazard whose node has sent nothing for this long is shown as stale and does not sound the alarm, default 30), `SIREN_AUTO_SEVERITY` (village sirens on nodes: `CRITICAL` = sound automatically for a confirmed CRITICAL hazard at that node, the default; `off` = officers only; any other value falls back to `CRITICAL` with a warning - never automatic on HIGH), `SIREN_AUTO_HAZARDS` (comma list of the hazard types the automatic siren may sound for, default `flood,flash_flood,landslide,fire,gas_leak` - the evacuation hazards; spaces and hyphens count as `_`, so the backend's `gas leak` matches `gas_leak`; an unknown name is kept with a warning; a forecast-only alert never sounds it whatever the list says), `SIREN_ON_SECONDS` (how long one trigger sounds, 10-900, default 180), `HOTSPOT_TYPED_MAX_M` (offline SOS Wi-Fi: typed coordinates further than this from the hotspot are not used for the pin, default 2000).

`WHATSAPP_VERIFY_TOKEN` must be set before Meta's one-time webhook verification can succeed: without it the verification GET is always refused.

Abuse limits: an SOS is limited to 5 per hour per device and 30 per 10 minutes per network (the 429 message points people to 112); reports to 20 per 10 minutes per network. Request bodies are capped at 1 MB, except `POST /api/citizen-reports` (3 MB). A report photo must be a JPEG, PNG or WebP, which the server checks from the decoded bytes, at most 2 MB. All photos together are capped at `CITIZEN_UPLOADS_MAX_MB` (default 500); past that, reports are saved without the photo. Files under `/citizen_uploads/` are served with a sandbox CSP, so they can never run script. The web SOS endpoints refuse `whatsapp:`, `node:` and `hotspot:` device IDs, which belong to SOS requests that come in through WhatsApp, sensor-node SOS buttons and the offline SOS Wi-Fi. Offline SOS Wi-Fi requests are limited to 60 per 10 minutes per hotspot on the server (429 = the gateway keeps them queued and retries); the hotspot page has its own per-AP limits.

Testing beside a running copy: `SANJEEVNI_PORT` (web server port, default 3000), `SANJEEVNI_BACKEND_URL` (default `http://127.0.0.1:8000`) and `SANJEEVNI_VAR_DIR` (database + uploads folder) let a second server run on a copy of the data.

**Device keys:** to replace a leaked key, run `node server\device_keys.js revoke node-04` and then `... add node-04 --nodes NODE-04`. The old row is kept as `node-04.revoked-<id>`. A gateway's key must list **every** node it can hear in `--nodes`. If a batch contains only readings the key may not send, the server answers 403 and the device keeps those readings queued. In a mixed batch, the readings the key may not send are only logged (`[ingest] rejected reading ...`) and then dropped.

## Hardware

| Sketch | Purpose |
|---|---|
| `firmware/sanjeevni_lora_node/` | Sensor node: DHT22, HC-SR04, IR flame, MQ135, rain gauge, soil moisture, MPU6050, PMS5003, pH, turbidity (each optional); on-node checks + edge model (full nodes); flash queue; LoRa (or WiFi for a bench demo); optional deep sleep |
| `firmware/sanjeevni_lora_gateway/` | LoRa → WiFi / SIM7020 NB-IoT gateway with its own flash queue |
| `firmware/sanjeevni_node*/`, `sanjeevni_mesh_relay_example/` | Legacy WiFi-only sketches (no offline queue) — kept for reference; use the two above |

Pins and modules are set in each sketch's `config.h`; copy `secrets.example.h` to `secrets.h` (git-ignored) for WiFi, backend URL and `DEVICE_KEY` (`node server\device_keys.js add node-04 --nodes NODE-04`). **Wiring diagram:** [`docs/wiring.html`](docs/wiring.html) (slides: `docs/wiring_node.svg`, `docs/wiring_gateway.svg`), generated from the two `config.h` files by `tools/wiring/generate_wiring.py`, which also checks the pins (clashes, input-only/flash/ADC2 pins, 5 V outputs needing a divider) — re-run it after changing a pin. The SX1278 is a 433 MHz part; confirm the band and power you may legally use in India (the 865-867 MHz band needs an SX1276-class module). **Parts and prices:** [`docs/BOM.md`](docs/BOM.md) - per-kit bill of materials with indicative retail prices (2026-10-09, incl. GST, excl. shipping), each linked to its product page.

**First flash / field check:** open the Serial Monitor at 115200 baud. After every power-on the node prints a **self-test** (send `t` to repeat it): each enabled sensor plus the LoRa radio, flash queue and edge model gets `OK`, `WAIT` (still warming up), `WARN` (sent but probably wrong — calibration, divider) or `FAIL` (not sent), with the pins to check. `FAIL` lines use the same rules that leave a value out of a reading. Other commands: `z` re-zero tilt, `r` MQ135 R0, `s` soil mV, `p` pH mV, `q` queue, `c` clear queue.

**Power note:** the solar power path (panel -> TP4056 -> 18650 -> MT3608) is designed and drawn in `docs/wiring.html`, but no node has been built or measured on solar. The MQ135 gas sensor's heater draws ~150 mA continuously, so nodes with a gas sensor cannot deep-sleep (project estimate ~4.8 Ah/day for an always-on gas node, roughly a 6 W panel). Nodes without the MQ135 and PMS5003 can use `DEEP_SLEEP_ENABLED 1` (measure once, send, sleep). Measure real runtime before quoting battery life, and check the panel's open-circuit voltage against the charger: the TP4056 module priced in `docs/BOM.md` lists a 4.5-5.5 V input, and the IC's absolute maximum is 8 V.

## Tests

```powershell
venv\Scripts\python.exe -m unittest discover -s tests -v       # confirmation rule, forecast, satellite (mocked), river rate, modular nodes
venv\Scripts\python.exe tools\firmware_host_test\run_tests.py   # firmware logic on a PC, JSON accepted by the backend, wiring checks
venv\Scripts\python.exe tools\firmware_build\compile_variants.py --cli <path>\arduino-cli.exe  # ESP32 compile: node (always-on, deep sleep LoRa/WiFi, tilt-only), gateway; deep sleep + MQ135 must be refused
npm test --prefix frontend; npm run typecheck --prefix frontend # React: components, logic, axe accessibility checks
node --test tools\demo\simulation.test.js tools\demo\run_demo.test.js   # simulator rain model + judge demo (name the files; a folder is not accepted)
node --test server\*.test.js   # SOS, village siren, offline SOS Wi-Fi, confidence, officer proxies, hotspots, trends & reports, public CAP, officer WhatsApp - each against a real server.js (temp var/, spare port, fake AI backend)
node --test tools\loadtest\ingest_load.test.js   # load-test tool (run the load test itself: node tools\loadtest\ingest_load.js --help)
```

## Known limitations

- Models are trained on synthetic data; validate on real gauge and rainfall records (e.g. CWC / India-WRIS) before relying on them. The LSTM beats both baselines on synthetic tests but still under-predicts sharp rises.
- New firmware is untested on hardware; the SIM7020 AT sequence in particular must be verified on the module.
- Sentinel-1 revisits every 6–12 days: the satellite check corroborates after the fact, it does not trigger alerts.
- WhatsApp alerts need a Meta Business account and an approved message template.
- Sample SOPs in `data/sample_sops/` contain only general public guidance — replace them with the district's official SOPs.
- Citizen advice (`data/hazard_advice.json`, used by the SOS page and WhatsApp alerts) is worded from those sample SOPs; its Hindi text still needs a native speaker's review. Hospital distances are straight-line, not road distance.
- A hand-placed SOS location (`location_source: "manual"`) is only as good as the person's tap, and the map stays blank offline (typed coordinates still work). The device location comes first and replaces a hand-placed point whenever it works, unless it is only approximate (worse than ±500 m) - then the hand-placed point is kept. The classic `public/sos.html` has no map picker, so it always sends `location_source: "gps"` (with the accuracy); the classic `public/officer.html` shows the "set by hand" note and the accuracy like the React officer page.
- Location accuracy (`location_accuracy_m` on `POST /api/sos`, optional) is the browser's own estimate; a missing or invalid value is stored as unknown (with a server log line) and never blocks the SOS. Above 500 m the officer views show "Approximate location (±2.3 km) - confirm with the caller" and a dashed circle of that radius. The classic SOS page has no map picker, so its notice offers a retry and asks for a description in the note instead.
- Node SOS button: a reading with `"sos_button": true` from a device key allowed for that node opens an SOS at the node's registered position (`location_source: "node"`, filed by `server.js` before forwarding, so it works while the AI backend is down). One press = one SOS: `(node_id, reading_uid)` is remembered in `node_sos_presses`, so retries and replays never open a second one; a press while that node's SOS is open joins it - except that a real press never joins a simulated (test/demo) SOS: that one is closed as `superseded` and the real press opens its own. A node with no registered position still gets its SOS stored, without a pin: it is logged loudly and listed in `GET /api/sos` as `unlocated_node_sos`, shown as a red banner on the officer page until resolved - register the node's position. Readings without a `reading_uid` can't be de-duplicated after the SOS is resolved. Simulated readings add "SIMULATED" to the note.
- Offline SOS Wi-Fi: the gateway forwards each request to `POST /api/ingest/sos` with its device key (same node scoping as ingestion): `{node_id, sos_uid, client_id, people, needs, note, latitude, longitude, age_seconds}`. **A request from the gateway's own hotspot carries the gateway's id as `node_id`, so the gateway's key must list its own id** (`node server/device_keys.js add gateway-1 --nodes NODE-04,NODE-07,<GATEWAY_ID>`); otherwise every such SOS gets 403 and stays queued on the gateway, and the server log shows `[sos] !!! offline SOS Wi-Fi request from <id> REFUSED` (once per key and id per 10 minutes). Browsers give a plain-http page no location, so the SOS is placed at the node's registered position with `location_accuracy_m: 150` (a rough Wi-Fi range, not a measurement), or at coordinates the person typed (accuracy unknown, labelled "typed by the person (unverified)"). Typed coordinates more than `HOTSPOT_TYPED_MAX_M` (default 2000 m, a demo default) from the hotspot's registered position are not used for the pin - the person is within Wi-Fi range, so they are a typo, swapped lat/lon or abuse; the node position is kept and the note says "typed location ... is N km from the hotspot (unverified, NOT used for the pin)". `(node_id, sos_uid)` is remembered in `hotspot_sos`, so a retry answers `duplicate`; one open SOS per phone (`hotspot:<NODE>:<client_id>`) - a second request while it is open answers `already_active` and is merged into the open SOS as a follow-up (the larger people count, all needs, its description appended as `| update: "..."`; a test request never edits a real one). Notes are cut to 160 characters, needs outside trapped / injured / medical / fire are dropped. A hotspot with no registered position (e.g. an unregistered gateway) is listed as unlocated, like the node button.
- Alert confidence: the AI backend returns `confidence` (0-1), `confidence_label` (High / Medium / Low) and `confidence_reasons` with each result - an explainable formula over confirmation status, agreement with the node's own edge verdict, data quality and model calibration, **not** a measured probability (the models are trained on synthetic data). `server.js` stores them in `sensor_data` (columns `confidence`, `confidence_label`, `confidence_reasons` as a JSON array; added to an older database on start, old rows stay empty) and returns them on `/api/hazards`, `/api/hazard-zones`, `/api/sensors` and `/api/history`. Values outside the contract (a score outside 0-1, an unknown label) are dropped, never guessed; an alert without a score shows no confidence line. Confidence never re-orders or hides an alert. WhatsApp alerts carry it inside the severity variable (`{{2}}` = "CRITICAL, confidence High (82%)"), so the approved 4-variable template still fits.
- Uptime on the Trends page is the share of 15-minute slots (or 2x the node's report interval, if longer) with at least one reading. The stored readings are almost all from the demo simulator, which only sends while a demo runs, so uptime looks low between demos without anything having failed; the page says so. Judge uptime only from real nodes over a period they were deployed.
- Hotspots (officer map): per node over 7 or 30 days, intensity = (confirmed HIGH/CRITICAL alert readings from the node's own sensors + half the confirmed MEDIUM ones) / all readings it sent; forecast-only and unconfirmed alerts are not counted; High from 30 %, Moderate from 10 % (project thresholds, not an official index). The definition lives in `server/server.js` (`HOTSPOT_DEFINITION`) and is shown with the list; nodes report more often while a hazard is elevated, so it overstates the share of time elevated - use it to compare places.
- Flash flood and smoke are their own hazard types (`flash_flood`, `smoke`) with their own icons on every page and advice in `data/hazard_advice.json`; WhatsApp shows "flash flood".
- Village siren: a node with a siren output reports `siren_fitted` / `siren_on` / `siren_reason` in its readings; the server keeps the desired state per node (`node_sirens`) and adds `"commands": [{"node_id", "siren": "on"|"off", "for_s"}]` to the ingest answer (also to 5xx answers, so silencing works while the AI backend is down) until the node reports the same state - it is left out when there is nothing to send. Automatic sounding needs a CONFIRMED CRITICAL reading at that node of a hazard type in `SIREN_AUTO_HAZARDS` (default: flood, flash_flood, landslide, fire, gas leak - the hazards people must leave for; `gas leak` is the only chemical-leak type the backend has, from the MQ135 broad-spectrum gas sensor). Heat (including an IMD severe heat wave), air pollution, smoke, water quality and forecast-only heavy rain / high wind never sound it by themselves; officers still can, for anything. A non-siren hazard never raises the peak of an evacuation episode, so it can never make a later evacuation CRITICAL look like "no escalation" (this matters if an operator changes the list; the backend caps smoke at HIGH anyway). The backend names one primary hazard per reading, so an evacuation hazard can be measured at CRITICAL but sit only in `hazard_scores` behind another primary (a gas leak on a Severe-AQI day: air pollution CRITICAL 0.96 beats gas leak CRITICAL 0.92 on risk score). The backend did not confirm that hidden result, so the siren sounds for it only when it is measured, not held or read from a sensor the node calls stuck, and the same node measured the same hazard at MEDIUM or above on an earlier reading within 10 minutes (the backend's persistence window); the officer WhatsApp message names the hazard that sounded it. It fires once per hazard episode: one hazard family at one node (flood + flash_flood, fire + smoke) until 3 all-clear readings in a row (every hazard LOW - a suppressed / sensor-fault result is not an all-clear and never ends an episode) or 6 hours without a confirmed reading (both demo defaults in `siren.js`); inside an episode only a higher confirmed severity re-triggers it, so a silenced siren stays silent. Backlog readings more than 15 minutes old never sound it, and a simulated reading never commands a real node's siren (nor puts a request on a node a real node reports for). The reported state comes from the newest reading of the request; a batch reading without `age_seconds` / `timestamp` (age lost in a reboot) only counts when nothing newer is known and never cancels a request. An officer/auto "on" that has run out is answered with "off" only while the node sounds by command - a node sounding by its own offline fallback (`auto_offline`) is silenced only by an officer's explicit "off". Officers (and admins) use `POST /api/nodes/:node_id/siren {"action": "on"|"off"}` (optional `for_s` 10-900); every action is stored in `siren_audit` and logged. A command reaches a node only in its next ingest answer, so the delay is up to that node's report interval; "sounding" on the officer page is what the node last reported, not what was asked.

## Project layout

```
backend/     Python AI backend: backend_server.py (FastAPI: ingest, node registry, CAP, PDF,
             forecast, satellite) + integration_pipeline, hazard_*, river_forecast,
             rag_alert_pipeline, ... ; paths.py = where every file lives
ml/          training + export scripts (flood/anomaly models, LSTM, ESP32 edge model)
server/      Node web server (server.js: pages, login, SOS, WhatsApp, device-key ingestion,
             backups), auth.js, device_auth.js, CLIs create_user.js / device_keys.js,
             simulation.js; paths.js = Node twin of backend/paths.py
frontend/    React + TypeScript pages (Vite)     public/   original HTML pages (fallback)
firmware/    ESP32 sketches (node, gateway, legacy)
data/        hospitals.json, sample_sops/, hazard_advice.json (EN/HI citizen advice),
             training-CSV templates
docs/        wiring diagram (generated), BOM.md  tests/, tools/   test suites, wiring generator,
                                                 ESP32 variant compiler
var/         runtime data, git-ignored: sanjeevni.db, models/, chroma_db/, backups/,
             citizen_uploads/, edge_ai_build/, fw_build/   (SANJEEVNI_VAR_DIR moves it)
```

## Team

Team V.A.S.H.I.K.A.R.A.N (Team ID 153384) — Smart India Hackathon 2026. Repository: Cmay003/SIH-2026.

## Data sources

- Rain forecast (`forecast_rainfall_6h_mm`) and terrain elevation (used to derive each node's SCS curve number): [Weather data by Open-Meteo.com](https://open-meteo.com/), under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). The backend changes the data: it sums the hourly forecast and turns elevation samples into a slope-adjusted curve number.
- Elevation behind Open-Meteo's Elevation API: Copernicus DEM GLO-90 (2021 release), DOI [10.5270/ESA-c5d3d65](https://doi.org/10.5270/ESA-c5d3d65). Produced using Copernicus WorldDEM-90 © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA; all rights reserved.
- Sentinel-1 radar flood cross-check: Copernicus Data Space Ecosystem (see `backend/satellite_check.py`).

## License

Developed for educational, research, and hackathon purposes.
