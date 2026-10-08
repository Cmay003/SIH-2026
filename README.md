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
| Citizens | SOS page (English / Hindi, voice note, nearest hospital), WhatsApp SOS (share a location, or text SOS / HELP / EMERGENCY after sharing one) and opt-in hazard alerts (`ALERTS ON` / `STOP`), CAP 1.2 alert export (NDMA SACHET-compatible format) |
| Administration | Node registry page: add, edit or remove sensor nodes (position on a map, land use, upstream node, report interval) with live status — admin role only, every change logged |
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
```

Open <http://localhost:3000/> (dashboard), `/officer.html` (officer map), `/sos.html` (citizen page, public), `/admin.html` (node registry — admin accounts only: `node server\create_user.js add <name> admin`; needs `OFFICER_API_KEY` in `.env`). React pages are served by default; `FRONTEND=classic` serves the original HTML pages instead.

### Optional `.env` settings
`OFFICER_API_KEY` (API access for scripts), `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ALERT_TEMPLATE` (without them WhatsApp runs in dry-run mode and only logs), `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (Sentinel-1), `CAP_WEB_URL`, `SANJEEVNI_INGEST_KEY` (simulator).

`WHATSAPP_APP_SECRET` is **required once WhatsApp is live**: incoming webhooks must carry Meta's `X-Hub-Signature-256`, and without the secret live webhooks are refused (dry-run mode accepts them unsigned for testing).

Tuning (defaults are fine): `SANJEEVNI_BENCH_MODE=1` (tabletop rig only — tiny water-level thresholds), `SANJEEVNI_BENCH_MOUNT_M` (bench sensor height, default 0.0234 m), `SANJEEVNI_MAX_RIVER_LEVEL_M` (above this a reading is treated as a sensor fault, default 10), `SANJEEVNI_MAX_RIVER_RATE_M_PER_HR` (rise/fall rates are capped at this, default 5).

Abuse limits: an SOS is limited to 5 per hour per device and 30 per 10 minutes per network (the 429 message points people to 112); reports to 20 per 10 minutes per network.

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
```

## Known limitations

- Models are trained on synthetic data; validate on real gauge and rainfall records (e.g. CWC / India-WRIS) before relying on them. The LSTM beats both baselines on synthetic tests but still under-predicts sharp rises.
- New firmware is untested on hardware; the SIM7020 AT sequence in particular must be verified on the module.
- Sentinel-1 revisits every 6–12 days: the satellite check corroborates after the fact, it does not trigger alerts.
- WhatsApp alerts need a Meta Business account and an approved message template.
- Sample SOPs in `data/sample_sops/` contain only general public guidance — replace them with the district's official SOPs.

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
data/        hospitals.json, sample_sops/, training-CSV templates
docs/        wiring diagram (generated)          tests/, tools/   test suites, wiring generator,
                                                 ESP32 variant compiler
var/         runtime data, git-ignored: sanjeevni.db, models/, chroma_db/, backups/,
             citizen_uploads/, edge_ai_build/, fw_build/   (SANJEEVNI_VAR_DIR moves it)
```

## Team

Team V.A.S.H.I.K.A.R.A.N (Team ID 153384) — Smart India Hackathon 2026. Repository: Cmay003/SIH-2026.

## License

Developed for educational, research, and hackathon purposes.
