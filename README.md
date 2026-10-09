# SANJEEVNI

**AI + IoT environmental monitoring network for early disaster detection and response** — Smart India Hackathon 2026, problem statement SIH26178 (Disaster Management, Hardware), Team V.A.S.H.I.K.A.R.A.N.

Solar ESP32 sensor nodes detect hazards on the device, talk to a gateway over LoRa (no internet needed at the node), and the gateway forwards readings over WiFi or NB-IoT. A backend combines a physics model (SCS Curve Number) with machine learning to score risk, confirms alerts across nodes before they go public, and gives officers a live map while citizens get an SOS page and opt-in WhatsApp alerts.

> **Status (October 2026):** working prototype. The software runs end to end with the included simulator. The new LoRa/NB-IoT firmware is written and unit-tested on a PC but **not yet compiled or flashed on real boards**. The flood and LSTM models are trained on **synthetic data** — they demonstrate the pipeline, not real-world accuracy.

---

## What it does

| Area | Details |
|---|---|
| Hazards | Flood (SCS-CN runoff + calibrated gradient boosting + SHAP explanations), gas leak, fire/smoke, extreme heat (IMD thresholds), landslide (tilt + vibration), air pollution (PM2.5, CPCB bands), water quality (WHO pH / turbidity) |
| False-alarm control | Isolation Forest sensor-fault filter; **multi-node cross-check** — an alert becomes public only when a repeat reading or a neighbouring node confirms it (officers see it immediately as "pending") |
| Edge AI | int8 TensorFlow Lite Micro model on the ESP32 (NORMAL / WATCH / URGENT); node sends at once when elevated, otherwise a heartbeat every minute |
| Offline / outages | Node and gateway keep readings in a flash queue until acknowledged (store-and-forward); readings carry their age so late uploads keep correct timestamps; duplicates are ignored |
| Officers | Live map: hazard zones, SOS requests (with triage queue and routes), sensor node health and missing-node alerts, river-level forecast (LSTM vs straight-line), Sentinel-1 radar cross-check |
| Citizens | SOS page (English / Hindi, voice note; inside a confirmed hazard zone: the hazard, its severity and 2-3 things to do now; nearest hospital outside any HIGH/CRITICAL zone, by straight-line distance; if location is denied, unavailable or slow, the person can tap their position on a map or type coordinates, and officers see that SOS marked "set by hand"), WhatsApp SOS (share a location, or text SOS / HELP / EMERGENCY after sharing one) and opt-in hazard alerts (`ALERTS ON` / `STOP`), CAP 1.2 alert export (NDMA SACHET-compatible format) |
| Administration | Node registry page: add, edit or remove sensor nodes (position on a map, land use, upstream node, report interval) with live status — admin role only, every change logged. **Model card** on the same page: each model's purpose, training/test data (labelled SYNTHETIC), results vs a simple baseline, false-alarm and miss rates, calibration and limitations (generate it with `venv\Scripts\python.exe ml\evaluate_models.py`) |
| Security | Staff login (scrypt-hashed passwords, roles, lockout), device keys for sensor ingestion, strict Content-Security-Policy on the React pages |

## Architecture

```
 ESP32 nodes ──LoRa──► LoRa gateway ──WiFi / NB-IoT──┐
 (sensors, edge AI,     (flash queue)                │  X-Device-Key
  flash queue)                                       ▼
 server/simulation.js ──────────────────────► server/server.js (Node, :3000) ──► backend/backend_server.py (FastAPI, 127.0.0.1:8000)
                                              pages, login, SOS,                   AI pipeline, node registry,
 browsers / phones / WhatsApp ──────────────► WhatsApp, device keys                forecasts, CAP, reports
                                                        └──────── var/sanjeevni.db (SQLite, shared) ────────┘
```

## Quick start (Windows PowerShell)

Requirements: Python 3.12, Node.js 22.5+ (built-in `node:sqlite`), optionally ngrok and the Arduino IDE.

Every command runs from the project folder (`SIH-2026`); they also work from any other folder.

```powershell
# 1. Install
python -m venv venv
venv\Scripts\python.exe -m pip install -r requirements.txt
# venv\Scripts\python.exe -m pip install -r requirements-training.txt   # only to retrain the LSTM / edge model (adds TensorFlow)
# requirements-lock.txt pins every package exactly, if a newer version ever breaks something
npm install --prefix server
npm install --prefix frontend
npm run build --prefix frontend

# 2. Models (trained on synthetic data if data\*.csv is absent) -> var\models\
venv\Scripts\python.exe ml\train_models.py
venv\Scripts\python.exe ml\train_river_forecast.py      # optional, needs requirements-training.txt
# Edge model for the ESP32 (optional, works in var\edge_ai_build): ml\make_edge_dataset.py ->
# ml\train_edge_model.py -> ml\quantize_edge_model.py -> ml\verify_quantized_model.py,
# then copy var\edge_ai_build\edge_model_data.h into firmware\sanjeevni_lora_node\

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

**Emergency alarm (control room):** the dashboard and officer map pop up a full-screen alert and sound a siren for every confirmed HIGH/CRITICAL hazard until someone presses *Acknowledge* (an acknowledged hazard stays quiet unless it escalates to CRITICAL or has been gone for 10 minutes). Browsers only allow sound after one click on the page, so click the page once after opening it (the header shows "Click to enable sound" until then). Keep the alarm screen in its own browser window or on its own monitor rather than in a background tab, and in Chrome add the site under *Settings > Performance > Memory Saver > Always keep these sites active*: a discarded tab cannot alarm at all.

### Optional `.env` settings
`OFFICER_API_KEY` (API access for scripts), `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ALERT_TEMPLATE` (without them WhatsApp runs in dry-run mode and only logs), `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (Sentinel-1), `CAP_WEB_URL`, `SANJEEVNI_INGEST_KEY` (simulator).

`WHATSAPP_APP_SECRET` is **required once WhatsApp is live**: incoming webhooks must carry Meta's `X-Hub-Signature-256`, and without the secret live webhooks are refused (dry-run mode accepts them unsigned for testing).

Tuning (defaults are fine): `SANJEEVNI_BENCH_MODE=1` (tabletop rig only — tiny water-level thresholds), `SANJEEVNI_BENCH_MOUNT_M` (bench sensor height, default 0.0234 m), `SANJEEVNI_MAX_RIVER_LEVEL_M` (above this a reading is treated as a sensor fault, default 10), `SANJEEVNI_MAX_RIVER_RATE_M_PER_HR` (rise/fall rates are capped at this, default 5), `STALE_HAZARD_MINUTES` (web server: a hazard whose node has sent nothing for this long is shown as stale and does not sound the alarm, default 30).

`WHATSAPP_VERIFY_TOKEN` must be set before Meta's one-time webhook verification can succeed: without it the verification GET is always refused.

Abuse limits: an SOS is limited to 5 per hour per device and 30 per 10 minutes per network (the 429 message points people to 112); reports to 20 per 10 minutes per network. Request bodies are capped at 1 MB, except `POST /api/citizen-reports` (3 MB). A report photo must be a JPEG, PNG or WebP, which the server checks from the decoded bytes, at most 2 MB. All photos together are capped at `CITIZEN_UPLOADS_MAX_MB` (default 500); past that, reports are saved without the photo. Files under `/citizen_uploads/` are served with a sandbox CSP, so they can never run script. The web SOS endpoints refuse `whatsapp:` device IDs, which belong to SOS requests that come in through WhatsApp.

Testing beside a running copy: `SANJEEVNI_PORT` (web server port, default 3000), `SANJEEVNI_BACKEND_URL` (default `http://127.0.0.1:8000`) and `SANJEEVNI_VAR_DIR` (database + uploads folder) let a second server run on a copy of the data.

**Device keys:** to replace a leaked key, run `node server\device_keys.js revoke node-04` and then `... add node-04 --nodes NODE-04`. The old row is kept as `node-04.revoked-<id>`. A gateway's key must list **every** node it can hear in `--nodes`. If a batch contains only readings the key may not send, the server answers 403 and the device keeps those readings queued. In a mixed batch, the readings the key may not send are only logged (`[ingest] rejected reading ...`) and then dropped.

## Hardware

| Sketch | Purpose |
|---|---|
| `firmware/sanjeevni_lora_node/` | Sensor node: DHT22, HC-SR04, IR flame, MQ135, rain gauge, soil moisture, MPU6050, PMS5003, pH, turbidity (each optional); edge AI; flash queue; LoRa (or WiFi for a bench demo); optional deep sleep |
| `firmware/sanjeevni_lora_gateway/` | LoRa → WiFi / SIM7020 NB-IoT gateway with its own flash queue |
| `firmware/sanjeevni_node*/`, `sanjeevni_mesh_relay_example/` | Legacy WiFi-only sketches (no offline queue) — kept for reference; use the two above |

Pins and modules are set in each sketch's `config.h`; copy `secrets.example.h` to `secrets.h` (git-ignored) for WiFi, backend URL and `DEVICE_KEY` (`node server\device_keys.js add node-04 --nodes NODE-04`). **Wiring diagram:** [`docs/wiring.html`](docs/wiring.html) (slides: `docs/wiring_node.svg`, `docs/wiring_gateway.svg`), generated from the two `config.h` files by `tools/wiring/generate_wiring.py`, which also checks the pins (clashes, input-only/flash/ADC2 pins, 5 V outputs needing a divider) — re-run it after changing a pin. The SX1278 is a 433 MHz part; confirm the band and power you may legally use in India.

**First flash / field check:** open the Serial Monitor at 115200 baud. After every power-on the node prints a **self-test** (send `t` to repeat it): each enabled sensor plus the LoRa radio, flash queue and edge model gets `OK`, `WAIT` (still warming up), `WARN` (sent but probably wrong — calibration, divider) or `FAIL` (not sent), with the pins to check. `FAIL` lines use the same rules that leave a value out of a reading. Other commands: `z` re-zero tilt, `r` MQ135 R0, `s` soil mV, `p` pH mV, `q` queue, `c` clear queue.

**Power note:** the MQ135 gas sensor's heater draws ~150 mA continuously, so nodes with a gas sensor cannot deep-sleep (~4.8 Ah/day). Nodes without the MQ135 and PMS5003 can use `DEEP_SLEEP_ENABLED 1` (measure once, send, sleep). Measure real runtime before quoting battery life.

## Tests

```powershell
venv\Scripts\python.exe -m unittest discover -s tests -v       # confirmation rule, forecast, satellite (mocked), river rate, modular nodes
venv\Scripts\python.exe tools\firmware_host_test\run_tests.py   # firmware logic on a PC, JSON accepted by the backend, wiring checks
venv\Scripts\python.exe tools\firmware_build\compile_variants.py --cli <path>\arduino-cli.exe  # ESP32 compile: node (always-on, deep sleep LoRa/WiFi, tilt-only), gateway; deep sleep + MQ135 must be refused
npm test --prefix frontend; npm run typecheck --prefix frontend # React: components, logic, axe accessibility checks
node --test tools\demo\simulation.test.js tools\demo\run_demo.test.js   # simulator rain model + judge demo (name the files; a folder is not accepted)
```

## Known limitations

- Models are trained on synthetic data; validate on real gauge and rainfall records (e.g. CWC / India-WRIS) before relying on them. The LSTM beats both baselines on synthetic tests but still under-predicts sharp rises.
- New firmware is untested on hardware; the SIM7020 AT sequence in particular must be verified on the module.
- Sentinel-1 revisits every 6–12 days: the satellite check corroborates after the fact, it does not trigger alerts.
- WhatsApp alerts need a Meta Business account and an approved message template.
- Sample SOPs in `data/sample_sops/` contain only general public guidance — replace them with the district's official SOPs.
- Citizen advice (`data/hazard_advice.json`, used by the SOS page and WhatsApp alerts) is worded from those sample SOPs; its Hindi text still needs a native speaker's review. Hospital distances are straight-line, not road distance.
- A hand-placed SOS location (`location_source: "manual"`) is only as good as the person's tap, and the map stays blank offline (typed coordinates still work). The device location always comes first and replaces a hand-placed point whenever it works. The classic `public/` pages neither send nor show this flag.

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
docs/        wiring diagram (generated)          tests/, tools/   test suites, wiring generator,
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
