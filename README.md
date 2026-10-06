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
| Citizens | SOS page (English / Hindi, voice note, nearest hospital), WhatsApp SOS and opt-in hazard alerts, CAP 1.2 alert export (NDMA SACHET-compatible format) |
| Security | Staff login (scrypt-hashed passwords, roles, lockout), device keys for sensor ingestion, strict Content-Security-Policy on the React pages |

## Architecture

```
 ESP32 nodes ──LoRa──► LoRa gateway ──WiFi / NB-IoT──┐
 (sensors, edge AI,     (flash queue)                │  X-Device-Key
  flash queue)                                       ▼
 simulation.js ─────────────────────────────► server.js (Node, :3000) ──► backend_server.py (FastAPI, 127.0.0.1:8000)
                                              pages, login, SOS,            AI pipeline, node registry,
 browsers / phones / WhatsApp ──────────────► WhatsApp, device keys         forecasts, CAP, reports
                                                        └──────── sanjeevni.db (SQLite, shared) ────────┘
```

## Quick start (Windows PowerShell)

Requirements: Python 3.12, Node.js 22.5+ (built-in `node:sqlite`), optionally ngrok and the Arduino IDE.

```powershell
# 1. Install
python -m venv venv; venv\Scripts\activate
pip install fastapi "uvicorn[standard]" pydantic scikit-learn pandas numpy matplotlib `
            chromadb sentence-transformers anthropic joblib requests shap python-dotenv fpdf
npm install
cd frontend; npm install; npm run build; cd ..

# 2. Models (trained on synthetic data if data/*.csv is absent)
venv\Scripts\python train_models.py
venv\Scripts\python train_river_forecast.py      # optional, needs tensorflow

# 3. A staff login and a device key for the simulator (no defaults exist)
node create_user.js add <your-name> officer
node device_keys.js add simulator --kind simulator   # put the printed key in .env as SANJEEVNI_INGEST_KEY=...

# 4. Run (three terminals)
venv\Scripts\python -m uvicorn backend_server:app --host 127.0.0.1 --port 8000
node server.js
node simulation.js            # optional fake sensor network; --help for options
```

Open <http://localhost:3000/> (dashboard), `/officer.html` (officer map), `/sos.html` (citizen page, public). React pages are served by default; `FRONTEND=classic` serves the original HTML pages instead.

### Optional `.env` settings
`OFFICER_API_KEY` (API access for scripts), `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_VERIFY_TOKEN` / `WHATSAPP_ALERT_TEMPLATE` (without them WhatsApp runs in dry-run mode and only logs), `CDSE_CLIENT_ID` / `CDSE_CLIENT_SECRET` (Sentinel-1), `CAP_WEB_URL`, `SANJEEVNI_INGEST_KEY` (simulator).

## Hardware

| Sketch | Purpose |
|---|---|
| `Arduino/sanjeevni_lora_node/` | Sensor node: DHT22, HC-SR04, IR flame, MQ135, rain gauge, soil moisture, MPU6050, PMS5003, pH, turbidity; edge AI; flash queue; LoRa (or WiFi for a bench demo) |
| `Arduino/sanjeevni_lora_gateway/` | LoRa → WiFi / SIM7020 NB-IoT gateway with its own flash queue |
| `Arduino/sanjeevni_node*/` | Earlier WiFi-only sketches |

Pins and modules are set in each sketch's `config.h`; copy `secrets.example.h` to `secrets.h` (git-ignored) for WiFi, backend URL and `DEVICE_KEY` (`node device_keys.js add node-04 --nodes NODE-04`). Several sensor outputs are 5 V and need voltage dividers — see the comments in `config.h`. The SX1278 is a 433 MHz part; confirm the band and power you may legally use in India.

**Power note:** the MQ135 gas sensor's heater draws ~150 mA continuously, so nodes with a gas sensor cannot deep-sleep (~4.8 Ah/day). Measure real runtime before quoting battery life.

## Tests

```powershell
venv\Scripts\python -m unittest discover -s tests -v        # confirmation rule, forecast, satellite (mocked)
venv\Scripts\python tools\firmware_host_test\run_tests.py    # firmware logic on a PC + JSON accepted by the backend
cd frontend; npm test; npm run typecheck                     # React: components, logic, axe accessibility checks
```

## Known limitations

- Models are trained on synthetic data; validate on real gauge and rainfall records (e.g. CWC / India-WRIS) before relying on them. The LSTM beats both baselines on synthetic tests but still under-predicts sharp rises.
- New firmware is untested on hardware; the SIM7020 AT sequence in particular must be verified on the module.
- Sentinel-1 revisits every 6–12 days: the satellite check corroborates after the fact, it does not trigger alerts.
- WhatsApp alerts need a Meta Business account and an approved message template.
- Sample SOPs in `sample_sops/` contain only general public guidance — replace them with the district's official SOPs.

## Project layout

```
backend_server.py      FastAPI AI backend (ingest, models, node registry, CAP, PDF, forecast, satellite)
integration_pipeline.py, hazard_classification.py, hazard_confirmation.py, river_forecast.py,
satellite_check.py, rag_alert_pipeline.py, cap_alert.py, situation_report.py, predictive_maintenance.py
server.js              Node web server: pages, login, SOS, WhatsApp, device-key ingestion, backups
auth.js, device_auth.js, security_headers.js, create_user.js, device_keys.js
frontend/              React + TypeScript pages (Vite)       public/   original HTML pages (fallback)
simulation.js          simulated sensor network              Arduino/  firmware
tests/, tools/         test suites                           sample_sops/, data/, hospitals.json
```

## Team

Team V.A.S.H.I.K.A.R.A.N (Team ID 153384) — Smart India Hackathon 2026. Repository: Cmay003/SIH-2026.

## License

Developed for educational, research, and hackathon purposes.
