#!/usr/bin/env node
/*
 * SANJEEVNI - scripted judge demo
 * =====================================================================
 * One command, the same story every time:
 *
 *   1. all quiet - 2 h of normal history is back-filled first, so the
 *      river forecast popup has data (it needs 2 h of readings)
 *   2. the upstream node NODE-07 jumps        -> PENDING (officers only)
 *   3. the flood wave reaches NODE-04         -> CONFIRMED by the neighbour (HIGH),
 *                                                control-room alarm; the alert's
 *                                                confidence goes up with it
 *   4. heavy rain over NODE-04                -> CONFIRMED CRITICAL: the village
 *                                                siren on NODE-04 sounds by itself
 *                                                (never automatically on HIGH)
 *   5. NODE-INDB reports a 14.2 m river       -> suppressed as a sensor fault
 *   6. NODE-INDB: PM2.5 and gas rise together -> smoke (no flame needed)
 *   7. a citizen SOS lands inside the NODE-04 flood zone
 *   8. a villager with no phone holds the SOS button on NODE-07
 *                                             -> an SOS at the node's position
 *   9. no mobile data: an SOS from the offline "SANJEEVNI-SOS" Wi-Fi of NODE-04
 *                                             -> an SOS at the node's position (~150 m)
 *  10. the hillside LoRa gateway loses its uplink, then uploads the backlog
 *  11. the forecast turns: very heavy rain and strong gusts
 *                                             -> heavy_rain / high_wind ADVISORY,
 *                                                HIGH at most, no siren (--fresh only)
 *  12. a severe heat wave at NODE-INDB (>= 47 C) -> CONFIRMED CRITICAL, and its
 *                                                siren stays SILENT: the automatic
 *                                                siren is for evacuation hazards only
 *                                                (flood, flash flood, landslide, fire,
 *                                                gas leak - SIREN_AUTO_HAZARDS)
 *  13. for the control room: hotspots, trends & reports (SIMULATED banner),
 *      and the public CAP 1.2 feed (/cap/feed.atom)
 *
 * with a CUE block (what to say, what to show) before each step and a
 * PASS/FAIL checkpoint after it. Everything it sends is SIMULATED data
 * (simulated: true on every reading and SOS) - say so when presenting.
 * With --fresh the weather forecast is SIMULATED too: the demo's backend
 * reads a calm Open-Meteo-shaped answer from SANJEEVNI_WEATHER_MOCK (no
 * forecast rain, so the flood story scores the same on any day), and cue
 * 11 swaps in tools/demo/weather_storm.json.
 *
 * How long: at the default pace the scripted story is ~4.6 minutes (13 cues
 * of ~20 s, cue 3 ~30 s: 272 s on the test suite's fake clock, which leaves
 * out scoring time); a slow AI backend stretches the rounds, as each waits
 * for its readings to be scored (one --fresh run on 2026-10-09, this laptop:
 * story 4 min 28 s, back-fill ~1 min, plus the backend's start). The 2-hour
 * back-fill can take 1-3 minutes - start the demo before the judges sit down. Use --wait-enter to talk longer at a cue (cue 13 shows three
 * screens).
 *
 *   node server/simulation.js --scenario judges --fresh      (recommended)
 *   node tools/demo/run_demo.js --fresh                      (same thing)
 *
 * --fresh never touches var/: it copies the database (users, device keys,
 * node registry - NOT readings, SOS requests, siren state, sessions or
 * WhatsApp subscribers), the models and the RAG store into a temporary
 * SANJEEVNI_VAR_DIR, makes a demo-only simulator key in that copy, and
 * starts its own AI backend + web server on spare ports. Open the printed
 * URL and log in with an OFFICER account (only officers hear the browser alarm).
 * Without --fresh it runs against an already running stack (--server,
 * --backend) and needs a simulator device key; it then adds readings and
 * three SOS requests (the citizen's, NODE-07's button, NODE-04's offline
 * Wi-Fi) to THAT database, and sounds NODE-04's SIMULATED siren there.
 * Resolve the node:NODE-07 SOS on the officer map before running it again:
 * a node has one open SOS at a time, so a second press adds nothing new.
 * The node SOS, siren (cues 4 and 12), confidence and Wi-Fi SOS checkpoints read the
 * server's database (read-only), so without --fresh they can only pass in
 * full for a --server on this machine that uses var/. A REAL NODE-04 that
 * has reported its own siren keeps the demo's simulated readings from
 * changing that siren's state - the siren step then fails: use --fresh.
 * --fresh also runs its web server with SIREN_AUTO_SEVERITY=CRITICAL,
 * SIREN_ON_SECONDS=180 and SIREN_AUTO_HAZARDS=flood,flash_flood,landslide,
 * fire,gas_leak (the defaults, user decision 2026-10-09), and its backend
 * with SANJEEVNI_HEAT_REGION=plains (the default; a node's registry entry
 * still overrides it), whatever .env says, so the siren and heat steps show
 * the real rules. The extreme-weather cue (11) needs --fresh:
 * only then does the demo control the forecast its backend reads. The
 * trends checkpoint (13) asks the AI backend directly (the officer pages
 * use the login-protected /api/officer/* proxies); the CAP feed checkpoint
 * uses the web server's public /cap/feed.atom and /cap/alerts/<id>.xml.
 *
 * Options (all optional):
 *   --fresh                  run on a temporary copy of var/ (see above)
 *   --web-port 3100          --fresh: web server port
 *   --backend-port 8100      --fresh: AI backend port
 *   --python <path>          --fresh: Python for the backend (default venv\Scripts\python.exe)
 *   --keep-var               --fresh: keep the temporary copy afterwards (path is printed)
 *   --server http://localhost:3000     without --fresh: the running web server
 *   --backend http://127.0.0.1:8000    without --fresh: the running AI backend
 *   --key <device key>       without --fresh: or SANJEEVNI_INGEST_KEY (.env)
 *   --seed 42                same seed = same readings (default 42)
 *   --interval 4             seconds between reading rounds (one reading per node)
 *   --pace 20                seconds each cue is held before the next one
 *   --wait-enter             wait for Enter at each cue instead of --pace
 *   --outage 20              LoRa uplink outage length, seconds
 *   --backfill-minutes 130   history to back-fill (0 = none; the forecast needs >= 125)
 *   --exit                   stop after the checkpoints (default: keep the scene
 *                            live - nodes keep reporting - until Ctrl+C)
 *   --verbose                print every reading, not just status changes
 *   --help
 */
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const paths = require(path.join(ROOT, "server", "paths")); // also loads .env (SANJEEVNI_INGEST_KEY)
const sim = require(path.join(ROOT, "server", "simulation.js"));

// ---------------------------------------------------------------------
// The cast and the script
// ---------------------------------------------------------------------
const RIVER = "NODE-04"; // riverside, downstream
const UPSTREAM = "NODE-07"; // hillside, upstream of NODE-04, behind a LoRa gateway
const FAULT_NODE = "NODE-INDB"; // industrial zone - its water sensor glitches
const NODES = [RIVER, UPSTREAM, FAULT_NODE]; // also the order within every round
const LORA_NODES = new Set([UPSTREAM]);
// Cue 8: the SOS push-button on a sensor node, for people with no phone.
// server.js files it under this device ID, at the node's registered position.
const BUTTON_NODE = UPSTREAM;
const BUTTON_SOS_DEVICE = `node:${BUTTON_NODE}`;
// Cue 4: the village siren. Only the riverside node is fitted with one in
// the demo (kit "siren", added in resetSensors) - it is where the CRITICAL
// flood is. The server's auto rule (server/siren.js) sounds it for a
// CONFIRMED CRITICAL hazard only; HIGH stays an officer's decision.
const SIREN_NODE = RIVER;
// Cue 9: the offline "SANJEEVNI-SOS" Wi-Fi. Gateways run it by default;
// battery nodes never do (deep sleep). The demo's riverside station is
// taken to be mains/solar powered with SOS_HOTSPOT_ENABLE on, so the request
// lands at its registered position, inside the flood zone. server.js files
// it as hotspot:<node>:<client id>, location_source 'hotspot'.
const HOTSPOT_NODE = RIVER;
const HOTSPOT_ACCURACY_M = 150; // contract: the node's position stands in, ~Wi-Fi range
// Cue 6: smoke on the node whose water sensor glitched in cue 5 - a fault
// first, then a real event on the same node.
const SMOKE_NODE = FAULT_NODE;
// Cue 12: a severe heat wave on a node WITH a siren, which must stay silent.
// User decision 2026-10-09: the AUTOMATIC village siren is for evacuation
// hazards only (server/siren.js SIREN_AUTO_HAZARDS, default below) - not
// heat, air pollution / smoke, or forecast-only weather; officers can still
// sound it by hand. The industrial-zone node gets a siren in the demo kit
// (resetSensors) - the one it would sound for a gas leak.
const HEAT_NODE = FAULT_NODE;
const DEMO_SIREN_AUTO_HAZARDS = "flood,flash_flood,landslide,fire,gas_leak";
// The backend's name for it ("extreme heat"), compared like siren.js does
// (lower case, spaces / hyphens -> "_").
const HEAT_HAZARD = "extreme_heat";
const normHazard = (t) => String(t ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
// IMD heat-wave criteria, "Heat wave - definition / FAQ",
// https://mausam.imd.gov.in/pdfs/heatcolduser/Definition.pdf (read
// 2026-10-09): actual maximum temperature >= 45 C = heat wave, >= 47 C =
// severe heat wave (applied to plains in backend/hazard_classification.py).
// The ramp: one heat-wave (HIGH) reading - pending - then severe readings
// (CRITICAL) that the repeat confirms. Each value is +-0.1 C sensor noise
// (simulation.js script.tempC), so every severe reading stays >= 47.4 C.
// A node reports an instantaneous temperature, not IMD's daily maximum at a
// screened station: the alert means "severe-heat-wave level measured here".
const HEAT_RAMP_C = [45.6, 47.6, 48.1];
// Readings, not seconds (as for smoke): pending, confirmed, one more, and
// one for the node to report a siren it would have been told to sound.
const HEAT_MIN_ROUNDS = 4;
// Smoke needs a number of READINGS, not seconds: the backend takes the
// median of the node's last 3 samples as "now", and a repeat confirms it.
// The cue is held this many rounds at least - a short --pace (one round at
// --pace 2) ended it after the first smoke reading, before any could be
// confirmed. 4 = 3 for the median + 1 repeat.
const SMOKE_MIN_ROUNDS = 4;
// A river alert may come back as either: the backend's flash-flood check
// looks at the rate of rise, and the demo compresses a rise into seconds.
const RIVER_HAZARDS = new Set(["flood", "flash_flood"]);
const CONFIDENCE_RANK = { Low: 0, Medium: 1, High: 2 };
// Cue 11: the extreme-weather beat. The backend's forecast-based hazards
// (contract: heavy_rain, high_wind) are capped at HIGH - a forecast is not
// a measurement - so they can never auto-sound a village siren, and they
// carry a confidence reason saying they are forecast-based.
const WEATHER_HAZARDS = new Set(["heavy_rain", "high_wind"]);
const WEATHER_MAX_SEVERITIES = new Set(["MEDIUM", "HIGH"]); // public = MEDIUM+, never CRITICAL
const FORECAST_REASON = /forecast|open-meteo/i;
// Readings, not seconds (as for smoke): the first weather reading is
// pending, a repeat or a neighbour confirms it, one round of margin.
const WEATHER_MIN_ROUNDS = 3;
// The SIMULATED forecast (an Open-Meteo /v1/forecast answer). Its hourly
// index 2 is "now" once rebased (see weatherMock); 24 h from there: 151 mm
// of rain, 79 mm of it in the first 6 h, gusts to 95 km/h. 151 mm sits in
// IMD's "very heavy rain" band. IMD National Bulletin No. 17 (BOB/04/2024,
// 11.09.2024), footer: "Rainfall amount (mm): Heavy rain: 64.5-115.5, Very
// heavy rain: 115.6-204.4, Extremely heavy rain: 204.5 or more" -
// https://rsmcnewdelhi.imd.gov.in/uploads/archive/1/1_41a014_17.National%20Bulletin%20No%2017-11th%20Sept2024_1730%20IST.pdf
// (accessed 2026-10-09). The same bands, word for word, are in RSMC New
// Delhi's "Heavy Rainfall Warning Based on 0300 UTC of 16th September, 2024"
// - https://rsmcnewdelhi.imd.gov.in/uploads/archive/8/8_1566bc_8_f9822f_heavy%20rainfall%201606.pdf
// (text layer read 2026-10-09). Neither document's text states the
// accumulation period next to the bands, and no IMD text saying "24 hours"
// for them was read here (the MoES Rajya Sabha reply of 27-07-2023 answered
// HTTP 403): verify the 24 h basis. The storm's next-24 h sum is 151 mm,
// and 140 / 127 mm after one / two hourly rollovers - very heavy in each.
// The gust values are demo values with no official threshold behind them.
// Which band raises which severity is the backend's rule
// (hazard_classification); this file only has to clear it.
const WEATHER_STORM_FILE = path.join(__dirname, "weather_storm.json");
const WEATHER_NOW_INDEX = 2;
// Cue 13: what the public CAP feed must link to (contract), and the CAP 1.2
// namespace (OASIS CAP v1.2, http://docs.oasis-open.org/emergency/cap/v1.2/CAP-v1.2-os.html).
const CAP_LINK = /\/cap\/alerts\/[^/?#"]+\.xml$/;
const CAP_FEED_MAX_FOLLOW = 40; // feed entries the cap-feed checkpoint follows (demo nodes first)
const CAP_NS = "urn:oasis:names:tc:emergency:cap:1.2";
const ATOM_NS = "http://www.w3.org/2005/Atom";

// The weather and the river, tuned against the trained flood model
// (probed with the backend's /api/simulate what-if endpoint, risk bands:
// MEDIUM > 0.4, HIGH > 0.7):
//  - Above ~2.5 m the model barely looks at the level or its rate; what
//    lifts a riverside (urban_low) flood from MEDIUM (~0.5) to HIGH (~0.83)
//    is rain in the last hour (>= ~8 mm) on wet soil (>= ~60 %). A flood
//    after a dry day stayed MEDIUM - the siren never sounded. So the story
//    is a monsoon one: steady STORM_RAIN for RAIN_STARTED_MINUTES before the
//    river rises, on soil that starts at WET_SOIL_PCT.
//  - That rain must not make the CALM river elevated: at 1.65-1.7 m with up
//    to 10 mm/h on 80 % soil the model says <= ~0.25 (LOW) for both land
//    uses, even with 30 mm of forecast rain from Open-Meteo. At 1.8 m and
//    12+ mm/h it already reached MEDIUM, hence the low CALM_LEVEL_M.
const CALM_LEVEL_M = 1.65;
const STORM_RAIN_MM_PER_HR = 10;
const RAIN_STARTED_MINUTES = 80; // before the live story; the history covers it
const WET_SOIL_PCT = 45; // soil sensors at the start of the history (monsoon season)
const FLOOD_RAIN_MM_PER_HR = 80; // cloudburst rain while the river rises
const UPSTREAM_JUMP_M = 3.4; // cue 2: one reading - must come out MEDIUM+ (pending)
const UPSTREAM_RISE_M = [3.6, 3.8, 3.9]; // cue 3, then held at the last level
const RIVER_RISE_M = [2.9, 3.4, 3.8]; // cue 3 - the flood wave arrives downstream
const FAULT_LEVEL_M = 14.2; // what simulation.js's sensor_fault event sends
// Cue 4 - HIGH -> CRITICAL. The flood model's CRITICAL band (> 0.9) needs
// rain over the last 24 h, not a higher river: probed offline with the
// trained model (integration_pipeline.compute_flood_risk, riverside
// urban_low, river at 2.9-4.1 m rising, wet soil), ~15 mm in 24 h - all
// the story has by cue 3 - scored ~0.73-0.88 (the upstream boost adds at
// most ~0.02: HIGH), ~65-70 mm on saturated soil ~0.93-0.94 (with 0 or
// 30 mm of forecast rain). It must not fall earlier:
// on the CALM river ~60 mm in 24 h already scored up to ~0.5 (MEDIUM),
// which would break cues 1-2. So it comes as a downpour at NODE-04 only,
// one burst per NODE-04 reading (simulation.js rainBurstMm) - compressed
// like the rest of the demo: about an hour's heavy rain in two readings.
// Each burst stays under the backend's gauge plausibility cap for a short
// gap (RAIN_MAX_MM_PER_HR x RAIN_MIN_GAP_HOURS = 50 mm), or it would be
// dropped as a gauge fault. Forecast rain from Open-Meteo also feeds the
// model and was not part of the probe: with ~10 mm forecast the same
// readings scored ~0.88-0.89, so on such a day the siren step can fail.
// --fresh therefore gives its backend a calm SIMULATED forecast (0 mm,
// see weatherMock) until cue 11; without --fresh the real forecast applies.
const DOWNPOUR_MM = [28, 28];
const DOWNPOUR_LEVEL_M = [4.0, 4.1]; // NODE-04 keeps rising a little meanwhile

// The backend's multi-node confirmation window (hazard_confirmation.py
// CONFIRM_WINDOW_MINUTES). Back-filled history ends MORE than this before
// the live story starts, so even an unexpectedly elevated history reading
// could never corroborate a live alert - every confirmation in the story
// comes from the story itself.
const CONFIRM_WINDOW_MINUTES = 10;
const BACKFILL_GAP_MINUTES = CONFIRM_WINDOW_MINUTES + 1;
// Per node. The forecast resamples to 5-min steps and accepts few empty
// ones; 2.5 min gives every step two readings, so one reading the anomaly
// model happens to suppress leaves no gap.
const BACKFILL_STEP_SECONDS = 150;
// Readings per /api/ingest/batch request (backend max 200). Small, because
// the backend scores readings one by one (0.3 to 2 s each, see the
// OMP_NUM_THREADS note in startFreshStack) and the request must finish
// within BATCH_TIMEOUT_MS.
const BACKFILL_BATCH = 24;
const BATCH_TIMEOUT_MS = 180000;
const FORECAST_MINUTES = 120; // river_forecast.py WINDOW_STEPS x STEP_MINUTES
const ELEVATED = new Set(["pending_confirmation", "alert_dispatched"]);
const DELIVERED = new Set(["pending_confirmation", "alert_dispatched", "logged", "suppressed"]);

const MODEL_FILES = ["flood_model.joblib", "flood_feature_cols.joblib", "anomaly_model.joblib", "anomaly_scaler.joblib"];
const FORECAST_MODEL = "river_forecast_lstm.npz";
// Tables a --fresh copy starts without. Kept: users, device_keys, nodes,
// schema_meta. sessions go too: copied login tokens should not linger in a
// temp folder (log in again on the demo port). WhatsApp subscribers go so a
// demo can never message real people, whatever WHATSAPP_ALERTS_FOR_SIMULATED says.
// node_sos_presses (server.js: which node button press made which SOS) and
// hotspot_sos (which offline Wi-Fi request made which SOS) go with
// sos_requests - their sos_id values would point at deleted rows.
// node_sirens / siren_audit (server/siren.js) go too: a REAL node's stored
// siren state is never overwritten by simulated readings, so a copied row
// for NODE-04 would block the siren cue, and a copied desired 'on' or
// hazard episode would make it fire (or not) for reasons outside the story.
// The alerts behind /api/alerts, the CAP feed and the analytics are rows of
// `readings`, so a copied real alert never shows up in the demo's feed.
// Officer WhatsApp alerts (users get a phone): every table whose name
// matches FRESH_CLEARED_TABLE_PATTERN (any WhatsApp / officer alert /
// notification log) is emptied too, and the officers' contact numbers are
// blanked in the copy (FRESH_BLANKED_USER_COLUMNS) - the logins stay, but
// the demo's simulated alerts can never reach a real officer's phone,
// whatever WHATSAPP_ALERTS_FOR_SIMULATED or the credentials in .env say.
const FRESH_CLEARED_TABLES = [
  "readings", "sensor_data", "sos_requests", "node_sos_presses", "hotspot_sos", "citizen_reports", "sessions",
  "whatsapp_subscribers", "whatsapp_alert_log", "node_sirens", "siren_audit",
];
const FRESH_CLEARED_TABLE_PATTERN = /whatsapp|officer_alert|notification/i;
const FRESH_BLANKED_USER_COLUMNS = /phone|mobile|whatsapp/i;

const DEFAULTS = {
  seed: 42, fresh: false, webPort: 3100, backendPort: 8100, python: null, keepVar: false,
  server: "http://localhost:3000", backend: "http://127.0.0.1:8000", key: "",
  interval: 4, pace: 20, waitEnter: false, outage: 20, backfillMinutes: 130, exit: false, verbose: false,
};

class UsageError extends Error {}

function parseArgs(argv, env = process.env) {
  const opts = { ...DEFAULTS, key: env.SANJEEVNI_INGEST_KEY || "" };
  const num = (flag, val) => {
    const n = Number(val);
    if (val === undefined || !Number.isFinite(n)) throw new UsageError(`${flag} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const val = argv[i + 1];
    switch (flag) {
      case "--seed": opts.seed = num(flag, val); i++; break;
      case "--fresh": opts.fresh = true; break;
      case "--web-port": opts.webPort = num(flag, val); i++; break;
      case "--backend-port": opts.backendPort = num(flag, val); i++; break;
      case "--python": opts.python = val; i++; break;
      case "--keep-var": opts.keepVar = true; break;
      case "--server": opts.server = String(val).replace(/\/$/, ""); i++; break;
      case "--backend": opts.backend = String(val).replace(/\/$/, ""); i++; break;
      case "--key": opts.key = val; i++; break;
      case "--interval": opts.interval = num(flag, val); i++; break;
      case "--pace": opts.pace = num(flag, val); i++; break;
      case "--wait-enter": opts.waitEnter = true; break;
      case "--outage": opts.outage = num(flag, val); i++; break;
      case "--backfill-minutes": opts.backfillMinutes = num(flag, val); i++; break;
      case "--exit": opts.exit = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new UsageError(`Unknown option ${flag} - see --help`);
    }
  }
  if (!(opts.interval > 0)) throw new UsageError("--interval must be > 0");
  if (!(opts.pace >= opts.interval)) throw new UsageError("--pace must be at least --interval");
  if (!(opts.outage >= opts.interval)) throw new UsageError("--outage must be at least --interval (one queued reading)");
  if (!(opts.backfillMinutes >= 0)) throw new UsageError("--backfill-minutes must be >= 0");
  for (const p of [opts.webPort, opts.backendPort]) {
    if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new UsageError("ports must be 1024-65535");
  }
  if (opts.fresh && (opts.webPort === 3000 || opts.backendPort === 8000)) {
    // the normal stack's ports: a --fresh copy must never stand in for it
    throw new UsageError("--fresh runs beside the normal stack - pick ports other than 3000/8000");
  }
  if (opts.webPort === opts.backendPort) throw new UsageError("--web-port and --backend-port must differ");
  return opts;
}

// ---------------------------------------------------------------------
// Small pure helpers (tested in tools/demo/run_demo.test.js)
// ---------------------------------------------------------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function haversineM(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// A point `fraction` of the way from the zone centre to its edge, at a
// bearing of `unit` (0..1) of a full turn. Inside the circle the map draws.
function pointInZone(zone, fraction, unit) {
  const d = zone.radius_m * fraction;
  const bearing = unit * 2 * Math.PI;
  const lat = zone.latitude + (d * Math.cos(bearing)) / 111320;
  const lon = zone.longitude + (d * Math.sin(bearing)) / (111320 * Math.cos((zone.latitude * Math.PI) / 180));
  return { latitude: +lat.toFixed(6), longitude: +lon.toFixed(6) };
}

// Taken-at times (ms) of the back-filled history, oldest first: from
// `minutes` before `nowMs` up to BACKFILL_GAP_MINUTES before it.
function backfillTimes(nowMs, minutes, stepSeconds = BACKFILL_STEP_SECONDS) {
  const out = [];
  const end = nowMs - BACKFILL_GAP_MINUTES * 60000;
  for (let t = nowMs - minutes * 60000; t <= end; t += stepSeconds * 1000) out.push(t);
  return out;
}

// The confidence of one alert (an /api/hazards entry, a backend reading or
// a sensor_data row), or null when it has none (older server/backend, or a
// row from before the column). confidence_reasons is a JSON array in the
// database and an array in the API.
function confidenceOf(row) {
  if (!row) return null;
  const value = row.confidence == null ? NaN : Number(row.confidence);
  if (!Number.isFinite(value) || value < 0 || value > 1 || !(row.confidence_label in CONFIDENCE_RANK)) return null;
  let reasons = row.confidence_reasons;
  if (typeof reasons === "string") {
    try { reasons = JSON.parse(reasons); } catch { reasons = [reasons]; }
  }
  return { value, label: row.confidence_label, reasons: Array.isArray(reasons) ? reasons.map(String) : [] };
}
const showConfidence = (c) => `${c.label} ${c.value.toFixed(2)}` + (c.reasons.length ? ` (${c.reasons.slice(0, 3).join("; ")})` : "");

// The SIMULATED Open-Meteo answer the --fresh backend reads from
// SANJEEVNI_WEATHER_MOCK: "storm" = tools/demo/weather_storm.json, "calm" =
// the same hours with no rain and a light breeze. The template's clock is
// moved so its hourly index WEATHER_NOW_INDEX is the current UTC hour
// ("YYYY-MM-DDTHH:00", timezone UTC - the backend looks the current hour up
// by that key), and current.time is that hour. 48 hours, so the next 24 h
// stay inside the file for the whole run.
function weatherMock(kind, nowMs, template = JSON.parse(fs.readFileSync(WEATHER_STORM_FILE, "utf8"))) {
  if (kind !== "calm" && kind !== "storm") throw new Error(`unknown weather '${kind}'`);
  const mock = JSON.parse(JSON.stringify(template));
  const hourMs = 3600000;
  const start = Math.floor(nowMs / hourMs) * hourMs - WEATHER_NOW_INDEX * hourMs;
  const n = mock.hourly.time.length;
  const key = (ms) => new Date(ms).toISOString().slice(0, 13) + ":00";
  mock.hourly.time = Array.from({ length: n }, (_, i) => key(start + i * hourMs));
  if (mock.current) mock.current.time = mock.hourly.time[WEATHER_NOW_INDEX];
  if (kind === "calm") {
    const calm = { precipitation: 0, rain: 0, showers: 0, wind_speed_10m: 8, wind_gusts_10m: 15 };
    for (const [field, value] of Object.entries(calm)) {
      if (Array.isArray(mock.hourly[field])) mock.hourly[field] = mock.hourly[field].map(() => value);
      if (mock.current && field in mock.current) mock.current[field] = value;
    }
    mock._note = ["SANJEEVNI judge demo - a SIMULATED calm forecast (no rain, light wind), NOT real weather. " +
      "Written by tools/demo/run_demo.js --fresh until cue 11 swaps in weather_storm.json."];
  }
  return mock;
}

// Replace the mock file in one step (write a temporary file, then rename
// it over the old one), so the backend never reads half a file. Windows
// refuses the rename while another process has the file open: retried.
function writeWeatherMock(file, kind, nowMs, { sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(weatherMock(kind, nowMs), null, 1));
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(tmp, file);
      return file;
    } catch (e) {
      if (attempt >= 20 || !["EPERM", "EACCES", "EBUSY"].includes(e.code)) {
        try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
        throw e;
      }
      sleepMs(50);
    }
  }
}

// An Atom feed, as far as the CAP feed checkpoint needs it: is it Atom 1.0,
// and each <entry>'s text and link hrefs (entities decoded). A regex
// reading, not an XML parser - enough for a feed the demo only inspects.
function parseAtomFeed(text) {
  const xml = String(text || "");
  const decode = (s) => s.replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
  const feedTag = xml.match(/<feed\b[^>]*>/);
  const isAtom = !!feedTag && feedTag[0].includes(`"${ATOM_NS}"`);
  const entries = [...xml.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)].map((m) => ({
    text: m[1],
    hrefs: [...m[1].matchAll(/<link\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>/g)].map((l) => decode(l[2])),
  }));
  return { isAtom, entries };
}

// ---------------------------------------------------------------------
// I/O: real network + clock by default; the tests pass fakes.
// ---------------------------------------------------------------------
async function httpRequest(method, url, { body, headers = {}, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? headers : { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, data, text, type: res.headers.get("content-type") || "" };
}

const realIo = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  request: httpRequest,
  log: (line) => console.log(line),
  enterPressed: null, // set by main() when --wait-enter is on a terminal
  // Read-only views of the server's database, set by main() when it can be
  // read (see dbReaders); null otherwise. Each may throw (missing table...).
  sosRows: null, // (deviceId, nodeId) => that device's SOS rows, with the node's registered position
  sirenRow: null, // (nodeId) => the node's node_sirens row (server/siren.js), or undefined
  sensorRows: null, // (nodeId) => the node's newest sensor_data rows (what /api/hazards is built from)
  // ("calm" | "storm") => changes the forecast the AI backend reads (cue 11).
  // Set by main() for --fresh only: the demo controls no other backend's weather.
  setWeather: null,
};

// ---------------------------------------------------------------------
// The demo
// ---------------------------------------------------------------------
class Demo {
  constructor(opts, io = realIo) {
    this.opts = opts;
    this.io = io;
    this.server = opts.server;
    this.backend = opts.backend;
    this.key = opts.key;
    // Per run, not per seed: a second run against the same database must
    // not have its readings dropped as duplicates (reading_uid is unique).
    this.runId = opts.runId || crypto.randomBytes(3).toString("hex");
    this.rand = mulberry32((opts.seed ^ 0x9e3779b9) >>> 0); // RSSI, SOS spot - not the sensor values
    this.checks = [];
    this.sent = []; // every reading delivered: { node, label, level, action, uid, cue }
    this.lastAction = {};
    this.lastSiren = {}; // node -> siren_on of its last delivered reading (a change is always logged)
    this.queue = []; // LoRa gateway backlog while the uplink is down
    this.uplinkDown = false;
    this.cue = "setup";
    this.seq = 0;
    this.startedAt = io.now();
    this.vclock = io.now(); // the sensors' clock: rain = rate x this clock's elapsed time
    this.creditGap = false; // set by backfill(): credit the history-to-live gap's rain once
  }

  // --- output --------------------------------------------------------
  stamp() {
    const s = Math.round((this.io.now() - this.startedAt) / 1000);
    return `[+${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}]`;
  }
  log(line = "") { this.io.log(line); }
  showCue(n, total, title, say, show) {
    const bar = "=".repeat(72);
    this.log(`\n${bar}\n CUE ${n}/${total}  ${title}\n${"-".repeat(72)}`);
    for (const line of say) this.log(` SAY : ${line}`);
    for (const line of show) this.log(` SHOW: ${line}`);
    this.log(bar);
  }
  check(id, pass, detail) {
    this.checks.push({ id, pass: !!pass, detail });
    this.log(`   [${pass ? "PASS" : "FAIL"}] ${id}: ${detail}`);
    return !!pass;
  }

  // --- readings ------------------------------------------------------
  takeReading(node, atMs) {
    const { reading, label } = sim.makeReading(node, atMs);
    this.seq++;
    reading.reading_uid = `demo${this.runId}-${this.seq}`;
    if (reading.simulated !== true) throw new Error("simulation.js produced a reading without simulated:true");
    return { reading, label, takenAt: this.io.now() };
  }

  async post(pathname, body) {
    const res = await this.io.request("POST", `${this.server}${pathname}`, {
      body,
      headers: { "X-Device-Key": this.key },
      timeoutMs: BATCH_TIMEOUT_MS,
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(`HTTP ${res.status} from ${pathname}: the device key was refused ` +
        `(${(res.data && res.data.error) || res.text.slice(0, 120)}). Use --fresh, or create one: ` +
        "node server/device_keys.js add simulator --kind simulator");
    }
    return res;
  }

  // WiFi nodes post one reading; the LoRa gateway forwards in batches
  // (immediately while its uplink is up). age_seconds = how long it waited.
  async deliver(items, link) {
    if (!items.length) return [];
    const now = this.io.now();
    if (link === "wifi") {
      const it = items[0];
      const res = await this.post("/api/ingest", {
        ...it.reading, link: "wifi", signal_strength_dbm: Math.round(-45 - this.rand() * 30),
      });
      this.applyCommands(res.data, items);
      return [res.status === 200 ? res.data.ai_action : `HTTP ${res.status}`];
    }
    const readings = items.map((it) => ({
      ...it.reading,
      link: it.link || "lora",
      signal_strength_dbm: Math.round(-118 + this.rand() * 20),
      age_seconds: Math.max(0, Math.round((now - it.takenAt) / 1000) + (it.extraAge || 0)),
    }));
    const res = await this.post("/api/ingest/batch", { readings });
    this.applyCommands(res.data, items);
    if (res.status !== 200) return items.map(() => `HTTP ${res.status}`);
    return res.data.results.map((r) => r.ai_action);
  }

  // Siren commands in an ingest answer (server.js sends them with error
  // answers too): the node obeys the desired state, as the firmware does in
  // its ACK window, and its NEXT reading reports siren_on. Each command is
  // kept on the newest reading of its node in the request - the reading
  // whose answer carried it - for the siren checkpoint.
  applyCommands(data, items) {
    const commands = data && Array.isArray(data.commands) ? data.commands : [];
    for (const cmd of commands) {
      const item = cmd && [...items].reverse().find((it) => it.reading.node_id === cmd.node_id);
      if (item) item.command = cmd;
    }
    if (commands.length) sim.applySirenCommands(commands, this.vclock, (line) => this.log(`   ${this.stamp()} ${line.trim()}`));
  }

  record(item, action) {
    const node = item.reading.node_id;
    const entry = {
      node, label: item.label, level: item.reading.river_level_m, action, uid: item.reading.reading_uid, cue: this.cue,
      late: item.late || 0, sos: item.reading.sos_button === true,
      sirenOn: item.reading.siren_on === true, sirenReason: item.reading.siren_reason || null,
      command: item.command || null,
    };
    this.sent.push(entry);
    const sirenChanged = entry.sirenOn !== !!this.lastSiren[node];
    if (this.opts.verbose || this.lastAction[node] !== action || item.late || entry.sos || sirenChanged) {
      const level = entry.level == null ? "" : `${entry.level.toFixed(2)} m`;
      const late = item.late ? `  (delivered ${item.late}s late)` : "";
      const sos = entry.sos ? "  [SOS button]" : "";
      const siren = sirenChanged ? (entry.sirenOn ? `  [siren ON - ${entry.sirenReason}]` : "  [siren off]") : "";
      this.log(`   ${this.stamp()} ${node.padEnd(9)} ${String(item.label).padEnd(12)} ${level.padStart(8)}  -> ${action}${late}${sos}${siren}`);
    }
    this.lastAction[node] = action;
    this.lastSiren[node] = entry.sirenOn;
    return entry;
  }

  // One reading per node in `nodes`, then wait out the interval.
  async round(nodes) {
    const roundStart = this.io.now();
    const out = {};
    // The gauges kept filling between the last history reading (>= 12.5 min
    // ago, plus however long the back-fill took) and now. simulation.js caps
    // one reading's rain at 2 x interval x nodes seconds, which dropped most
    // of that rain and left the 'steady storm' short of the ~8 mm in the last
    // hour the cue-3 alarm (HIGH) needs - more so the slower the back-fill. For this
    // one round, raise the cap to cover the gap.
    const liveInterval = sim.opts.interval;
    if (this.creditGap) {
      this.creditGap = false;
      const oldest = Math.min(...NODES.map((n) => sim.state[n].lastAt));
      sim.opts.interval = Math.max(liveInterval, (this.vclock - oldest) / 1000 / (2 * sim.opts.nodes.length) + 1);
    }
    try {
      for (const node of NODES) {
        if (!nodes.includes(node)) continue;
        const item = this.takeReading(node, this.vclock);
        if (LORA_NODES.has(node) && this.uplinkDown) {
          this.queue.push(item);
          out[node] = { action: "queued" };
          if (this.opts.verbose) this.log(`   ${this.stamp()} ${node.padEnd(9)} queued at the gateway (uplink down)`);
          continue;
        }
        const [action] = await this.deliver([item], LORA_NODES.has(node) ? "lora" : "wifi");
        out[node] = this.record(item, action);
      }
    } finally {
      // back to the live guard (a later pause must still be capped)
      sim.opts.interval = liveInterval;
    }
    this.vclock += this.opts.interval * 1000;
    await this.io.sleep(roundStart + this.opts.interval * 1000 - this.io.now());
    // A rehearsal run stalled for 42 min when the laptop went into Modern
    // Standby: the story's timing (confirmation window, rain in the last
    // hour) was gone and later checkpoints failed for no visible reason.
    const took = this.io.now() - roundStart;
    if (took > (this.opts.interval + Math.max(60, 10 * this.opts.interval)) * 1000) {
      this.log(`   [warn] one round took ${Math.round(took / 1000)}s - did the computer sleep, or the backend stall? ` +
        "Restart the demo (keep the laptop on power, sleep off).");
    }
    return out;
  }

  // Hold a cue: keep the listed nodes reporting for --pace seconds (or
  // until Enter with --wait-enter). A COUNT of rounds, not a deadline, so
  // the same options always send the same readings.
  async hold(nodes, seconds = this.opts.pace) {
    if (this.opts.waitEnter && this.io.enterPressed) {
      this.log("   (press Enter for the next cue)");
      const pressed = this.io.enterPressed();
      let done = false;
      pressed.then(() => { done = true; });
      while (!done) await this.round(nodes);
      return;
    }
    const rounds = Math.max(1, Math.round(seconds / this.opts.interval));
    for (let i = 0; i < rounds; i++) await this.round(nodes);
  }

  // level null = the calm river in the steady storm rain; a level = flooding.
  setScript(node, level) {
    sim.state[node].script = level == null
      ? { label: "normal", level: null, rainMmPerHr: STORM_RAIN_MM_PER_HR }
      : { label: "flood", level, rainMmPerHr: FLOOD_RAIN_MM_PER_HR };
  }

  async backendGet(pathname) {
    const res = await this.io.request("GET", `${this.backend}${pathname}`, { timeoutMs: 15000 });
    return res.status === 200 ? res.data : null;
  }
  async ourRows(node) {
    const rows = (await this.backendGet(`/api/readings?node_id=${node}&limit=1000`)) || [];
    return rows.filter((r) => String(r.reading_uid || "").startsWith(`demo${this.runId}-`)).reverse(); // oldest first
  }

  // --- setup ---------------------------------------------------------
  resetSensors(startMs) {
    sim.reseed(this.opts.seed);
    sim.opts.nodes = [...NODES];
    // The riverside village siren (cue 4): NODE-04 reports siren_fitted on
    // every reading, so the server may command it.
    // The industrial-zone node has one too (cue 12: silent through a severe heat wave).
    for (const node of [SIREN_NODE, HEAT_NODE]) {
      if (!sim.NODE_PROFILES[node].includes("siren")) sim.NODE_PROFILES[node].push("siren");
    }
    // simulation.js caps one reading's rain at 2 x interval x nodes seconds
    // (a paused-simulator guard). Here a node can be silent for a whole cue.
    sim.opts.interval = Math.max(this.opts.interval, this.opts.pace);
    for (const node of NODES) {
      const s = (sim.state[node] = sim.initialState(startMs));
      s.baseLevel = CALM_LEVEL_M; // see CALM_LEVEL_M: a seeded 1.6-2.0 m could start MEDIUM in the rain
      s.soil = WET_SOIL_PCT;
    }
  }

  // ~2 h of quiet history via the store-and-forward path, so the river
  // forecast has its 2-hour window. Skipped when the nodes already have
  // readings in that period: history sent OUT OF ORDER into the backend's
  // per-node rate/rain state would distort the live readings.
  async backfill() {
    const minutes = this.opts.backfillMinutes;
    const now = this.io.now();
    this.resetSensors(now - minutes * 60000);
    this.vclock = now;
    const storm = () => NODES.forEach((node) => this.setScript(node, null)); // the live story starts in the rain
    if (!minutes) {
      storm();
      this.log("   back-fill: off (--backfill-minutes 0) - the forecast popup will say 'unavailable'");
      return;
    }
    if (minutes < FORECAST_MINUTES + 5) {
      this.log(`   note: ${minutes} min of history is less than the forecast's ${FORECAST_MINUTES} min window`);
    }
    const startMs = now - minutes * 60000;
    for (const node of NODES) {
      const [latest] = (await this.backendGet(`/api/readings?node_id=${node}&limit=1`)) || [];
      if (latest && latest.timestamp && Date.parse(latest.timestamp) > startMs) {
        // A skipped back-fill means there is no storm history: the backend's
        // rain_log has almost no rain in the last hour and the soil starts at
        // WET_SOIL_PCT. The flood model needs both (see the weather notes at
        // the top) to rate the riverside flood HIGH, so the alarm and siren
        // checkpoints and probably the forecast will fail. Say so here - it used to be a
        // PASS, which hid the cause of the later failures.
        // (No creditGap: lastAt is still the start of the would-be history,
        // and crediting it would dump 2 h of rain into one reading.)
        this.check("backfill", false, `skipped - ${node} already has readings from the last ${minutes} min, ` +
          `so there is no ${RAIN_STARTED_MINUTES}-min storm history: ${RIVER} will likely stay MEDIUM ` +
          "(no alarm, no siren) and the forecast may be unavailable. Use --fresh, or wait until the stack has been quiet " +
          `for ${minutes} min.`);
        storm();
        return;
      }
    }
    const times = backfillTimes(now, minutes);
    // The rain gauge caps one reading's rain at 2 x interval x nodes (a
    // paused-simulator guard); history readings are BACKFILL_STEP apart.
    const liveInterval = sim.opts.interval;
    sim.opts.interval = BACKFILL_STEP_SECONDS / NODES.length;
    const items = [];
    const rainFrom = now - RAIN_STARTED_MINUTES * 60000;
    for (const t of times) {
      for (const node of NODES) {
        if (t >= rainFrom) this.setScript(node, null); // the storm starts (drizzle before)
        const item = this.takeReading(node, t);
        item.link = LORA_NODES.has(node) ? "lora" : "wifi";
        item.historyAt = t;
        items.push(item);
      }
    }
    sim.opts.interval = liveInterval;
    storm();
    const tally = {};
    let elevated = 0;
    for (let i = 0; i < items.length; i += BACKFILL_BATCH) {
      const batch = items.slice(i, i + BACKFILL_BATCH);
      // age from the reading's history time, measured at send time
      for (const it of batch) {
        it.takenAt = this.io.now();
        it.extraAge = Math.round((this.io.now() - it.historyAt) / 1000);
      }
      const actions = await this.deliver(batch, "batch");
      if (items.length > BACKFILL_BATCH) this.log(`   ... ${Math.min(i + BACKFILL_BATCH, items.length)}/${items.length}`);
      actions.forEach((a) => {
        tally[a] = (tally[a] || 0) + 1;
        if (ELEVATED.has(a)) elevated++;
      });
    }
    const summary = Object.entries(tally).map(([a, n]) => `${n} ${a}`).join(", ");
    this.check("backfill", elevated === 0 && Object.keys(tally).every((a) => DELIVERED.has(a)),
      `${items.length} history readings (${minutes} to ${BACKFILL_GAP_MINUTES} min ago): ${summary}` +
        (elevated ? " - ELEVATED history readings: the scenario's quiet levels need re-tuning" : ""));
    this.vclock = this.io.now();
    this.creditGap = true; // only here: history was really delivered (see round())
  }

  // --- the story -----------------------------------------------------
  async story() {
    const T = 13;
    const pace = this.opts.pace;
    const interval = this.opts.interval;
    this.liveSince = this.io.now(); // live readings are taken from here on (history ends >= 11 min before)

    this.cue = "1-calm";
    this.showCue(1, T, "All quiet - three nodes reporting normally", [
      "Three SIMULATED sensor nodes: riverside NODE-04, hillside NODE-07 upstream of it, industrial NODE-INDB.",
      `It has rained steadily (~${STORM_RAIN_MM_PER_HR} mm/h) for over an hour; the rivers are still at their normal level.`,
      "Each reading is scored by the AI on the server; the last 2 hours feed a river-level forecast.",
    ], [
      "Dashboard: three nodes online, no hazards.",
      "Click NODE-04 -> river forecast for +30 / +60 min (indicative - trained on synthetic hydrology).",
    ]);
    await this.round(NODES);
    const forecast = await this.backendGet(`/api/forecast/${RIVER}`);
    this.check("forecast", forecast && forecast.available === true,
      forecast ? (forecast.available ? `available, now ${forecast.current_level_m} m` : `unavailable: ${forecast.reason}`)
        : "backend /api/forecast did not answer");
    await this.hold(NODES, pace - interval);

    this.cue = "2-upstream";
    this.showCue(2, T, `Upstream river jumps at ${UPSTREAM} (hillside)`, [
      "One reading from one node is never enough for a public alert.",
      "The AI rates it as a flood risk but holds it as PENDING until something independent agrees.",
    ], [
      `Officer map: amber PENDING marker at ${UPSTREAM}, with a LOW confidence score - open it to see why.`,
      "Public dashboard: still no hazard.",
    ]);
    this.setScript(UPSTREAM, UPSTREAM_JUMP_M);
    const jump = await this.round(NODES);
    this.check("upstream-pending", jump[UPSTREAM] && jump[UPSTREAM].action === "pending_confirmation",
      `${UPSTREAM} at ${UPSTREAM_JUMP_M} m -> ${jump[UPSTREAM] && jump[UPSTREAM].action}`);
    // NODE-07 is a battery LoRa node: its next report is not due during this
    // cue (it would confirm itself). The other two keep reporting.
    await this.hold([RIVER, FAULT_NODE], pace - interval);

    this.cue = "3-confirm";
    this.showCue(3, T, `Flood wave reaches ${RIVER} - confirmed by the neighbour (HIGH)`, [
      `Minutes later the riverside node downstream rises too. Two independent nodes agree,`,
      "so the alert is CONFIRMED and goes public - and the control-room alarm sounds.",
      "Every alert carries an explainable confidence score: it went UP when the neighbour agreed.",
      "The village siren stays silent: HIGH is an officer's decision - only CRITICAL sounds it automatically.",
    ], [
      "Dashboard / officer map: full-screen alarm with siren -> press Acknowledge.",
      `Hazard list: ${RIVER} flood with its expected time to the critical level, and its confidence.`,
      `Officer map: click ${UPSTREAM} - confidence now higher than while PENDING, with the reasons listed.`,
    ]);
    for (let i = 0; i < RIVER_RISE_M.length; i++) {
      this.setScript(RIVER, RIVER_RISE_M[i]);
      this.setScript(UPSTREAM, UPSTREAM_RISE_M[i]);
      await this.round(NODES);
    }
    const riverRows = await this.ourRows(RIVER);
    const firstElevated = riverRows.find((r) => ELEVATED.has(r.status));
    this.check("river-confirmed", firstElevated && firstElevated.status === "alert_dispatched" &&
      firstElevated.confirmation === `neighbour:${UPSTREAM}`,
      firstElevated ? `${RIVER} first elevated reading: ${firstElevated.status} (${firstElevated.severity}, ` +
        `confirmation ${firstElevated.confirmation})` : `${RIVER} never became elevated`);
    const hazards = await this.publicHazards();
    const riverHazard = hazards && hazards.find((h) => h.node_id === RIVER && RIVER_HAZARDS.has(h.hazard_type));
    this.check("alarm", riverHazard && ["HIGH", "CRITICAL"].includes(riverHazard.severity) && !riverHazard.stale,
      riverHazard ? `public hazard ${RIVER} ${riverHazard.hazard_type} ${riverHazard.severity} - the alarm sounds on open pages`
        : `no confirmed ${RIVER} flood in /api/hazards`);
    await this.checkConfidence(hazards);
    await this.hold(NODES, pace);

    this.cue = "4-village-siren";
    this.showCue(4, T, `Heavy rain over ${RIVER}: CRITICAL - the village siren sounds by itself`, [
      `A downpour over the riverside village (compressed: about an hour's heavy rain in two readings).`,
      "On top of the confirmed flood the AI now rates it CRITICAL - and for a CONFIRMED CRITICAL hazard",
      `the server switches ${RIVER}'s own village siren on, for people who never look at a phone.`,
      "The command rides on the server's reply; the node sounds the siren and reports back that it is on.",
    ], [
      `Hazard list: ${RIVER} flood CRITICAL. Officer map: ${RIVER} siren 'sounding (auto)' - an officer can silence it.`,
    ]);
    for (let i = 0; i < DOWNPOUR_MM.length; i++) {
      this.setScript(RIVER, DOWNPOUR_LEVEL_M[i]);
      sim.state[RIVER].rainBurstMm = DOWNPOUR_MM[i];
      this.log(`   ${this.stamp()} >>> downpour at ${RIVER}: its next reading carries +${DOWNPOUR_MM[i]} mm of rain`);
      await this.round(NODES);
    }
    // The siren comes on with the answer to the CRITICAL reading; the
    // node's next reading reports it - inside this hold.
    await this.hold(NODES, pace - DOWNPOUR_MM.length * interval);
    await this.checkVillageSiren();

    this.cue = "5-fault";
    this.showCue(5, T, `Sensor fault: ${FAULT_NODE} reports a ${FAULT_LEVEL_M} m river`, [
      `A glitching sensor reports ${FAULT_LEVEL_M} m - impossible for this site. The node's own check flags the spike too.`,
      "It is suppressed as a sensor fault: no alert, no siren; maintainers can see the faulty channel.",
    ], [
      `No new alarm. ${FAULT_NODE} stays calm on the map.`,
    ]);
    sim.state[FAULT_NODE].event = { type: "sensor_fault", step: 0, delay: 0 };
    const fault = await this.round(NODES);
    const faultRow = fault[FAULT_NODE];
    const faultListed = ((await this.publicHazards()) || []).some((h) => h.node_id === FAULT_NODE);
    this.check("fault-suppressed", faultRow && faultRow.level === FAULT_LEVEL_M && faultRow.action === "suppressed" &&
      !faultListed, `${FAULT_NODE} ${faultRow && faultRow.level} m -> ${faultRow && faultRow.action}` +
        (faultListed ? ` - but ${FAULT_NODE} IS in the public hazard list` : ", not in the public hazard list"));
    await this.hold(NODES, pace - interval);

    this.cue = "6-smoke";
    this.showCue(6, T, `${SMOKE_NODE}: fine dust and gas rise together - smoke, no flame needed`, [
      "Same node, and this time it is real: PM2.5 and gas climb TOGETHER, the air gets warmer and drier.",
      "No flame is in the sensor's view, but that pattern is smoke - reported as smoke, not as everyday pollution.",
    ], [
      `Officer map: ${SMOKE_NODE} smoke alert - PENDING first, then confirmed by its next reading.`,
    ]);
    sim.state[SMOKE_NODE].event = { type: "smoke", step: 0, delay: 0 };
    await this.hold(NODES, Math.max(pace, SMOKE_MIN_ROUNDS * interval));
    await this.checkSmoke();

    this.cue = "7-sos";
    this.showCue(7, T, `A citizen inside the ${RIVER} flood zone presses SOS`, [
      "Someone inside the flood zone presses SOS on the public page.",
      "Officers see it at once, with a route to them and to the nearest hospital.",
    ], [
      `Officer map: a new SOS pin inside the ${RIVER} circle -> open it, then Resolve.`,
    ]);
    await this.sendSos();
    await this.hold(NODES, pace);

    this.cue = "8-node-sos";
    this.showCue(8, T, `No phone: a villager holds the SOS button on ${BUTTON_NODE} (hillside)`, [
      "Not everyone has a phone. Every sensor node has an SOS push-button - held for 2 seconds.",
      "The press rides on the node's next LoRa packet; the server opens an SOS at the node's own position.",
    ], [
      `Officer map: a new SOS pin at ${BUTTON_NODE}, marked 'SOS button on node ${BUTTON_NODE}' -> open it, then Resolve.`,
    ]);
    await this.pressNodeSos();
    await this.hold(NODES, pace - interval);

    this.cue = "9-hotspot-sos";
    this.showCue(9, T, `No mobile data: an SOS over the offline "SANJEEVNI-SOS" Wi-Fi at ${HOTSPOT_NODE}`, [
      "The mobile network is down by the river. Phones still see an open Wi-Fi, SANJEEVNI-SOS, from the node;",
      "its page opens by itself and needs no internet: how many people, trapped / injured / medical / fire, where.",
      `The node forwards it; the server places it at the node (within ~${HOTSPOT_ACCURACY_M} m) - a phone page`,
      "without internet cannot read GPS - and the page tells the person it was sent.",
    ], [
      `Officer map: a new SOS pin at ${HOTSPOT_NODE}, marked 'via offline SOS Wi-Fi', with people and needs -> Resolve.`,
    ]);
    await this.sendHotspotSos();
    await this.hold(NODES, pace);

    this.cue = "10-outage";
    this.showCue(10, T, `LoRa uplink outage at the hillside gateway (${this.opts.outage}s)`, [
      "The hillside gateway loses its internet link. It keeps every reading in flash,",
      "uploads the backlog when the link returns, and each reading keeps its original time.",
    ], [
      `${UPSTREAM} readings arrive late in one batch ('delivered Ns late' here); nothing is lost.`,
    ]);
    this.log(`   ${this.stamp()} >>> gateway uplink DOWN - queueing ${UPSTREAM} readings`);
    this.uplinkDown = true;
    await this.hold(NODES, this.opts.outage);
    this.uplinkDown = false;
    const backlog = this.queue.splice(0);
    this.log(`   ${this.stamp()} >>> gateway uplink back - uploading ${backlog.length} queued reading(s)`);
    const now = this.io.now();
    const actions = backlog.length ? await this.deliver(backlog, "lora") : [];
    backlog.forEach((it, i) => {
      it.late = Math.round((now - it.takenAt) / 1000);
      this.record(it, actions[i]);
    });
    const upRows = await this.ourRows(UPSTREAM);
    const uids = new Set(backlog.map((it) => it.reading.reading_uid));
    const stored = upRows.filter((r) => uids.has(r.reading_uid));
    const oldest = backlog.length ? backlog[0].late : 0;
    this.check("outage-backlog", backlog.length > 0 && actions.every((a) => DELIVERED.has(a)) &&
      stored.length === backlog.length && stored.every((r) => r.delay_seconds > 0),
      `${backlog.length} queued, ${actions.filter((a) => DELIVERED.has(a)).length} delivered ` +
        `(${[...new Set(actions)].join(", ")}), oldest ${oldest}s late, ${stored.length} stored with their original time`);

    this.cue = "11-weather";
    this.showCue(11, T, "The forecast turns: very heavy rain and strong gusts - an advisory, never a siren", [
      "The weather forecast now says ~150 mm of rain in the next 24 h - IMD calls that 'very heavy rain' -",
      "and gusts up to ~95 km/h. SANJEEVNI warns BEFORE the rain arrives: a heavy-rain / high-wind advisory.",
      "A forecast is not a measurement: these alerts stop at HIGH, so they can never sound a village siren,",
      "and their confidence says they are forecast-based. (This forecast is SIMULATED for the demo.)",
    ], [
      `Hazard list / officer map: a heavy rain or high wind advisory, HIGH at most - on a node with no other hazard ` +
        `(${FAULT_NODE}) -> open it: the confidence reasons say 'forecast'. No new siren.`,
    ]);
    // Before the switch: every node's siren state and latest hazard, so a
    // siren that comes on during this cue - for ANY hazard type - shows up.
    // The forecast is global and also feeds the flood model (rain in the
    // next 6 h), so a forecast-driven flood escalation is caught here too.
    const beforeWeather = await this.weatherSnapshot();
    let switched = false;
    if (this.io.setWeather) {
      try {
        this.io.setWeather("storm");
        switched = true;
        this.log(`   ${this.stamp()} >>> forecast: SIMULATED very heavy rain + strong gusts (tools/demo/weather_storm.json)`);
      } catch (e) {
        this.log(`   [warn] could not write the simulated forecast (${e.message})`);
      }
    }
    await this.hold(NODES, Math.max(pace, WEATHER_MIN_ROUNDS * interval));
    await this.checkWeather(switched, beforeWeather);

    this.cue = "12-heat";
    this.showCue(12, T, `Severe heat wave at ${HEAT_NODE}: CRITICAL - and the siren stays silent`, [
      "Not every CRITICAL alert means 'leave now'. Fast-forward to a pre-monsoon afternoon (SIMULATED, compressed):",
      `${HEAT_NODE} in the industrial zone measures 47-48 C - IMD's severe heat-wave level (>= 47 C).`,
      "CRITICAL, confirmed by the next reading. This node has a village siren too - for a gas leak.",
      "It stays SILENT: the automatic siren is for evacuation hazards only - flood, flash flood, landslide,",
      "fire, gas leak. Heat needs water, shade and checks on the elderly; officers can still sound it by hand.",
      "(This shows the SERVER's rule. The node's own offline fallback - no word from the server for 15 min -",
      "is not part of this simulation; on the real node it must use water level and gas only.)",
    ], [
      `Hazard list: ${HEAT_NODE} extreme heat CRITICAL. Officer map, village sirens: ${HEAT_NODE} 'Silent', ` +
        "with its 'Sound village siren' button for an officer's decision.",
    ]);
    const beforeHeat = this.readDb("sirenRow", HEAT_NODE);
    for (let i = 0; i < HEAT_RAMP_C.length; i++) {
      sim.state[HEAT_NODE].script = { label: "heat", level: null, rainMmPerHr: STORM_RAIN_MM_PER_HR, tempC: HEAT_RAMP_C[i] };
      if (i === 0) this.log(`   ${this.stamp()} >>> ${HEAT_NODE}: ${HEAT_RAMP_C[0]} C, then ${HEAT_RAMP_C.slice(1).join(" / ")} C`);
      await this.round(NODES);
    }
    // held at the last temperature for the rest of the cue (and the demo)
    await this.hold(NODES, Math.max(pace, HEAT_MIN_ROUNDS * interval) - HEAT_RAMP_C.length * interval);
    await this.checkHeatNoSiren(beforeHeat);

    this.cue = "13-control-room";
    this.showCue(13, T, "For the control room and other agencies: hotspots, trends & reports, the CAP feed", [
      "Officers see more than live alerts: where hazards keep coming back, and how every sensor trends over days.",
      "Every confirmed alert is also published as a standard CAP 1.2 feed - the format emergency dashboards",
      "and NDMA's SACHET platform consume. (We export it; we are not connected to SACHET.)",
    ], [
      "Officer map: switch on 'Hotspots' - where alerts were frequent; click a node -> its latest sensor values.",
      `Trends & Reports: the SIMULATED-data banner, ${RIVER}'s river level and risk over 24 h, the district summary.`,
      `${this.server}/cap/feed.atom - one entry per confirmed alert, each linking to its CAP XML ('Exercise': simulated).`,
    ]);
    await this.checkTrends();
    await this.checkCapFeed();
    await this.hold(NODES, pace);
  }

  // Cue 11, before the forecast changes: per node, the siren row (null when
  // the database cannot be read, undefined when the node has none) and the
  // newest reading of this run (hazard, severity, risk).
  async weatherSnapshot() {
    const snap = {};
    for (const node of NODES) {
      const rows = await this.ourRows(node);
      snap[node] = { siren: this.readDb("sirenRow", node), latest: rows[rows.length - 1] || null };
    }
    return snap;
  }

  // Cue 11. The public list (confirmed alerts only) must show a heavy_rain or
  // high_wind hazard, none of them CRITICAL, each with a forecast-based
  // confidence reason; no reading of this cue may be a CRITICAL weather
  // alert; and NO siren may come on during this cue, whatever hazard type
  // the reading behind it has. Nothing measured changes in this cue (the
  // rivers are held), only the forecast - which is global and also feeds the
  // flood model - so a siren here (say, a flood the forecast rain lifted to
  // CRITICAL) would be the forecast sounding it, which the cue says never
  // happens. `before` is weatherSnapshot() from just before the switch.
  async checkWeather(switched, before = {}) {
    if (!switched) {
      this.check("weather-advisory", false, this.io.setWeather
        ? "the simulated forecast could not be written - see the warning above"
        : "not shown: the demo controls the forecast only on its own backend - run with --fresh");
      return;
    }
    const hazards = await this.publicHazards();
    const weather = (hazards || []).filter((h) => WEATHER_HAZARDS.has(h.hazard_type));
    const entries = this.sent.filter((e) => e.cue === "11-weather");
    const uids = new Set(entries.map((e) => e.uid));
    const rows = [];
    for (const node of NODES) rows.push(...(await this.ourRows(node)).filter((r) => uids.has(r.reading_uid)));
    const critical = rows.filter((r) => WEATHER_HAZARDS.has(r.hazard_type) && r.severity === "CRITICAL")
      .concat(weather.filter((h) => !WEATHER_MAX_SEVERITIES.has(h.severity)));
    // Sirens switched on during this cue, from two sources: an 'on' command
    // in a reply (unless the node already had an 'on' request before the
    // switch - the rest of an earlier, still running one), and a NEW 'on'
    // in the server's siren audit (readSirenRow's last_on_at changed).
    const sirenOn = new Map(); // node -> why
    const wasOn = (node) => {
      const s = before[node] && before[node].siren;
      return !!s && s.desired === "on";
    };
    for (const e of entries.filter((x) => x.command && x.command.siren === "on" && !wasOn(x.node))) {
      const row = rows.find((r) => r.reading_uid === e.uid);
      sirenOn.set(e.node, `'on' command with a ${row ? `${row.hazard_type || "-"} ${row.severity}` : "not stored"} reading`);
    }
    for (const node of NODES) {
      const b = before[node] && before[node].siren;
      const a = this.readDb("sirenRow", node);
      if (!a || b === null) continue; // no database view (then the commands above are all there is)
      const fresh = a.last_on_actor !== undefined
        ? !!a.last_on_at && a.last_on_at !== (b ? b.last_on_at : null)
        : a.desired === "on" && (!b || b.desired !== "on" || a.desired_at !== b.desired_at);
      if (fresh && !sirenOn.has(node)) {
        sirenOn.set(node, `switched on by ${a.last_on_actor || a.desired_by || "?"} (server siren state)`);
      }
    }
    const forecastBased = (h) => {
      const c = confidenceOf(h);
      return !!c && c.reasons.some((r) => FORECAST_REASON.test(r));
    };
    // The flood model also reads the forecast rain: how each node's flood
    // moved across the switch (information - a flood is measured, not
    // forecast-only, so it may rise; it may not sound a siren here).
    const risk = (r) => (r && typeof r.risk_score === "number" ? ` ${+r.risk_score.toFixed(2)}` : "");
    const floodMoves = [];
    for (const node of NODES) {
      const b = before[node] && before[node].latest;
      const mine = rows.filter((r) => r.node_id === node);
      const a = mine[mine.length - 1];
      const flood = (r) => !!r && RIVER_HAZARDS.has(r.hazard_type);
      if (flood(b) || flood(a)) {
        const show = (r) => (r ? `${flood(r) ? r.severity : `${r.hazard_type || "-"} ${r.severity}`}${risk(r)}` : "none");
        floodMoves.push(`${node} ${show(b)} -> ${show(a)}`);
      }
    }
    if (floodMoves.length) this.log(`   ${this.stamp()} flood across the forecast switch: ${floodMoves.join("; ")}`);
    const pass = weather.length > 0 && critical.length === 0 && sirenOn.size === 0 && weather.every(forecastBased);
    let detail;
    if (!hazards) {
      detail = "the web server's /api/hazards did not answer";
    } else if (!weather.length) {
      const seen = [...new Set(rows.map((r) => `${r.node_id} ${r.hazard_type || "-"}/${r.status}`))].join(", ");
      detail = `no heavy_rain / high_wind in /api/hazards; this cue's readings: ${seen || "none stored"} ` +
        "(does the backend read SANJEEVNI_WEATHER_MOCK on every forecast fetch? A cached calm forecast hides the storm)";
    } else {
      detail = weather.map((h) => {
        const c = confidenceOf(h);
        return `${h.node_id} ${h.hazard_type} ${h.severity}` +
          (c ? ` (${forecastBased(h) ? "forecast-based" : "NO forecast reason"}: ${showConfidence(c)})` : " (no confidence)");
      }).join("; ");
    }
    if (critical.length) detail += ` - CRITICAL weather alert(s): ${critical.map((r) => r.node_id).join(", ")} (forecast-only must stop at HIGH)`;
    if (floodMoves.length) detail += `; flood across the switch: ${floodMoves.join(", ")}`;
    if (sirenOn.size) {
      detail += ` - a siren came on during the forecast cue (the forecast must never sound one): ` +
        [...sirenOn].map(([node, why]) => `${node} ${why}`).join("; ");
    }
    this.check("weather-advisory", pass, detail);
  }

  // Cue 13: the analytics behind the Trends & Reports page, asked of the AI
  // backend directly (the page uses the officer-only /api/officer/* proxies,
  // which need a login). The NODE-04 flood must be in both, and both must say
  // the data is simulated (the page shows data_note as its banner).
  async checkTrends() {
    const trends = await this.backendGet(`/api/analytics/trends?node_id=${encodeURIComponent(RIVER)}&range=24h`);
    const summary = await this.backendGet("/api/analytics/summary?range=7d");
    const series = trends && Array.isArray(trends.series) ? trends.series : [];
    const peak = (pick) => series.reduce((m, b) => {
      const v = b ? Number(pick(b)) : NaN;
      return Number.isFinite(v) ? Math.max(m, v) : m;
    }, -Infinity);
    const peakLevel = peak((b) => b.river_level_m && b.river_level_m.max);
    const peakRisk = peak((b) => b.risk_score_max);
    const simulatedNote = (x) => !!x && typeof x.data_note === "string" && /simulat|synthetic/i.test(x.data_note);
    const byHazard = (summary && summary.alerts_by_hazard) || {};
    const floods = [...RIVER_HAZARDS].reduce((n, h) => n + (Number(byHazard[h] && byHazard[h].count) || 0), 0);
    const top = summary && Array.isArray(summary.top_hotspots) ? summary.top_hotspots[0] : null;
    const pass = series.length > 0 && peakLevel >= RIVER_RISE_M[0] && peakRisk > 0.7 && simulatedNote(trends) &&
      floods > 0 && simulatedNote(summary);
    const show = (v, unit = "") => (Number.isFinite(v) ? `${+v.toFixed(2)}${unit}` : "none");
    let detail = trends
      ? `trends ${RIVER} 24h: ${series.length} bucket(s)${trends.bucket_s ? ` of ${trends.bucket_s}s` : ""}, ` +
        `peak river ${show(peakLevel, " m")}, peak risk ${show(peakRisk)}` +
        (simulatedNote(trends) ? "" : ` - data_note does not say SIMULATED (${JSON.stringify(trends.data_note ?? null)})`)
      : "backend /api/analytics/trends did not answer";
    detail += summary
      ? `; summary 7d: ${floods} flood alert(s)` + (top ? `, top hotspot ${top.node_id} (${top.dominant_hazard || "-"})` : "") +
        (simulatedNote(summary) ? `; data_note: "${summary.data_note}"` : ` - data_note does not say SIMULATED`)
      : "; backend /api/analytics/summary did not answer";
    this.check("trends", pass, detail);
  }

  // Cue 13: the public CAP feed, as an emergency dashboard would read it:
  // Atom 1.0 served as application/atom+xml, entries for the demo's alerts,
  // and CONFIRMED alerts only (contract). Every entry is followed (demo
  // nodes first, at most CAP_FEED_MAX_FOLLOW): its link must be the public
  // /cap/alerts/<id>.xml on the feed's own host (a link to another host is
  // reported, never fetched - with --fresh it could be the user's normal
  // stack), answer a CAP 1.2 message, <status>Exercise</status> for a demo
  // node (simulated data), and must not be one of this run's readings that
  // was never confirmed. Then a reading the demo knows is NOT confirmed
  // (NODE-07's first, pending flood reading, say) must be a 404 on the
  // public route.
  async checkCapFeed() {
    const feedUrl = `${this.server}/cap/feed.atom`;
    const res = await this.io.request("GET", feedUrl);
    if (res.status !== 200) {
      this.check("cap-feed", false, `GET /cap/feed.atom -> HTTP ${res.status}` + (res.status === 404 ? " (no feed route on this server)" : ""));
      return;
    }
    const typeOk = /application\/atom\+xml/i.test(res.type || "");
    const feed = parseAtomFeed(res.text);
    const origin = new URL(feedUrl).origin;
    // This run's readings by id (the backend's readings.id is the alert id
    // in /cap/alerts/<id>.xml); a reading's status never changes later
    const byId = new Map();
    for (const node of NODES) {
      for (const r of await this.ourRows(node)) if (r.id != null) byId.set(String(r.id), r);
    }
    // A demo entry: its CAP link is one of this run's readings, or its text
    // names a demo node. Integration 2026-10-09: the real backend's entry
    // title/summary name the LOCATION ("Riverside"), not the node id, so
    // matching on the node id alone found no demo entry in the real feed.
    const linkedId = (e) => {
      for (const h of e.hrefs) {
        let u;
        try { u = new URL(h, feedUrl); } catch { continue; }
        const m = u.pathname.match(/\/cap\/alerts\/([^/]+)\.xml$/);
        if (m) return decodeURIComponent(m[1]);
      }
      return null;
    };
    const isOurs = (e) => byId.has(linkedId(e)) || NODES.some((n) => e.text.includes(n));
    const ours = feed.entries.filter(isOurs);
    const problems = [];
    let followed = 0;
    let exercise = 0;
    const todo = ours.concat(feed.entries.filter((e) => !isOurs(e))).slice(0, CAP_FEED_MAX_FOLLOW);
    for (const e of todo) {
      const links = e.hrefs.map((h) => { try { return new URL(h, feedUrl); } catch { return null; } }).filter(Boolean);
      const capUrl = links.find((u) => CAP_LINK.test(u.pathname));
      if (!capUrl) {
        problems.push(`an entry links to ${e.hrefs.join(", ") || "nothing"} - not the public /cap/alerts/<id>.xml`);
        continue;
      }
      if (capUrl.origin !== origin) {
        problems.push(`an entry links to another host (${capUrl.href}; the feed is ${origin}) - not followed`);
        continue;
      }
      const id = decodeURIComponent(capUrl.pathname.match(/\/cap\/alerts\/([^/]+)\.xml$/)[1]);
      const row = byId.get(id);
      if (row && row.status !== "alert_dispatched") {
        problems.push(`${capUrl.pathname} is ${row.node_id}'s ${row.status} reading - not a confirmed alert`);
      }
      let cap;
      try {
        cap = await this.io.request("GET", capUrl.href);
      } catch (err) {
        problems.push(`${capUrl.pathname} -> ${err.message}`);
        continue;
      }
      followed++;
      const capOk = cap.status === 200 && String(cap.text || "").includes(CAP_NS);
      const isExercise = /<status>\s*Exercise\s*<\/status>/.test(String(cap.text || ""));
      if (!capOk) problems.push(`${capUrl.pathname} -> HTTP ${cap.status}, NOT CAP 1.2`);
      else if (isOurs(e) && !isExercise) problems.push(`${capUrl.pathname} -> HTTP 200, CAP 1.2, status NOT Exercise`);
      else if (isOurs(e)) exercise++;
    }
    // The newest unconfirmed reading of this run (pending first)
    const newest = (status) => [...byId.values()].filter(status)
      .reduce((m, r) => (!m || Number(r.id) > Number(m.id) ? r : m), null);
    const unconfirmed = newest((r) => r.status === "pending_confirmation") ||
      newest((r) => r.status !== "alert_dispatched");
    let probe = "no unconfirmed reading of this run to probe";
    if (unconfirmed) {
      const path_ = `/cap/alerts/${encodeURIComponent(unconfirmed.id)}.xml`;
      let status;
      try { status = (await this.io.request("GET", `${this.server}${path_}`)).status; } catch (err) { status = err.message; }
      probe = `${unconfirmed.node_id}'s ${unconfirmed.status} reading ${path_} -> HTTP ${status}`;
      if (status === 200) problems.push(`${path_} serves ${unconfirmed.node_id}'s ${unconfirmed.status} reading - the public route is for confirmed alerts only`);
    }
    const weatherListed = feed.entries.some((e) => /heavy[ _-]?rain|high[ _-]?wind/i.test(e.text));
    const pass = typeOk && feed.isAtom && ours.length > 0 && exercise === ours.length && problems.length === 0;
    let detail = `HTTP 200 ${res.type || "(no content-type)"}${typeOk ? "" : " - not application/atom+xml"}, ` +
      `${feed.isAtom ? "Atom 1.0" : "NOT an Atom 1.0 feed"}, ${feed.entries.length} entr${feed.entries.length === 1 ? "y" : "ies"} ` +
      `(${ours.length} naming a demo node${weatherListed ? ", the weather advisory among them" : ""}); ` +
      `followed ${followed}/${feed.entries.length}${todo.length < feed.entries.length ? ` (first ${CAP_FEED_MAX_FOLLOW})` : ""}: ` +
      `${exercise} demo alert(s) CAP 1.2 with status Exercise; ${probe}`;
    if (!ours.length) detail += " - none of the demo's confirmed alerts is in the feed";
    if (problems.length) detail += ` - ${problems.slice(0, 4).join("; ")}${problems.length > 4 ? `; ${problems.length - 4} more` : ""}`;
    this.check("cap-feed", pass, detail);
  }

  // The public hazard list, or null when the server did not answer.
  async publicHazards() {
    const res = await this.io.request("GET", `${this.server}/api/hazards`);
    return res.status === 200 && res.data ? res.data.hazards || [] : null;
  }

  // A database view (io.sosRows / sirenRow / sensorRows), or null when the
  // database cannot be read here - with a warning when it failed.
  readDb(name, ...args) {
    const reader = this.io[name];
    if (!reader) return null;
    try {
      return reader(...args);
    } catch (e) {
      this.log(`   [warn] could not read the demo database (${e.message}) - checking the API only`);
      return null;
    }
  }

  // Cue 3: the SAME alert (NODE-07's flood) while it was one pending reading
  // and now that it is confirmed - so only the confirmation (and nothing
  // else about the node) can explain the change. Pending alerts are not in
  // any public API, so the pending score comes from the backend's reading
  // (if it stores the score) or the server's sensor_data row; the confirmed
  // one from /api/hazards, as the dashboard shows it. The label must go UP,
  // as the cue says - a higher number inside the same band is not shown.
  async checkConfidence(hazards) {
    const pendingEntry = this.sent.find((e) => e.node === UPSTREAM && e.action === "pending_confirmation");
    const upRows = await this.ourRows(UPSTREAM);
    let pending = confidenceOf(pendingEntry && upRows.find((r) => r.reading_uid === pendingEntry.uid));
    let pendingFrom = "backend reading";
    if (!pending) {
      // sensor_data has no reading_uid: the node's first pending row taken
      // during the live story (history ends >= 11 min before it).
      const rows = this.readDb("sensorRows", UPSTREAM);
      const since = this.liveSince - 60000;
      const row = rows && rows.filter((r) => Date.parse(r.timestamp) >= since)
        .sort((a, b) => a.id - b.id).find((r) => r.status === "pending_confirmation");
      pending = confidenceOf(row);
      pendingFrom = "server database";
    }
    const upHazard = hazards && hazards.find((h) => h.node_id === UPSTREAM && RIVER_HAZARDS.has(h.hazard_type));
    const confirmed = confidenceOf(upHazard);
    const river = confidenceOf(hazards && hazards.find((h) => h.node_id === RIVER && RIVER_HAZARDS.has(h.hazard_type)));
    const pass = !!pending && !!confirmed && confirmed.value > pending.value &&
      CONFIDENCE_RANK[confirmed.label] > CONFIDENCE_RANK[pending.label];
    let detail = `${UPSTREAM} pending: ${pending ? `${showConfidence(pending)} [${pendingFrom}]` : "no confidence score found" +
      (this.io.sensorRows ? "" : " (the server database is not readable here - use --fresh)")}; ` +
      `confirmed: ${confirmed ? showConfidence(confirmed) : `no confidence on its /api/hazards entry${upHazard ? "" : " (not listed)"}`}`;
    if (river) detail += `; ${RIVER}: ${showConfidence(river)}`;
    if (pending && confirmed && !pass) detail += " - the label did not go up";
    this.check("confidence", pass, detail);
  }

  // Cue 4. Evidence, in the order it happens: the command came with the
  // answer to a CONFIRMED CRITICAL reading (and none before - the confirmed
  // HIGH readings of cue 3 sounded nothing), and the node's next reading
  // reports siren_on. When the database is readable it must also say the
  // server wanted it on by the AUTO rule - not an officer who pressed the
  // button on the officer map meanwhile.
  async checkVillageSiren() {
    const idx = this.sent.findIndex((e) => e.node === SIREN_NODE && e.command && e.command.siren === "on");
    const cmd = idx >= 0 ? this.sent[idx] : null;
    const rows = await this.ourRows(SIREN_NODE);
    const trigger = cmd && rows.find((r) => r.reading_uid === cmd.uid);
    const critical = !!trigger && trigger.severity === "CRITICAL" && trigger.status === "alert_dispatched";
    const triggerAt = trigger ? rows.indexOf(trigger) : rows.length;
    const highBefore = rows.slice(0, triggerAt).filter((r) => r.status === "alert_dispatched" && r.severity === "HIGH").length;
    const reported = cmd && this.sent.slice(idx + 1).find((e) => e.node === SIREN_NODE && e.sirenOn);
    const row = this.readDb("sirenRow", SIREN_NODE);
    const byAuto = sirenOnByAuto(row, this.liveSince);
    const pass = critical && !!reported && reported.sirenReason === "command" && byAuto !== false;
    let detail;
    if (!cmd) {
      const peak = rows.filter((r) => r.status === "alert_dispatched").map((r) => r.severity);
      detail = `no siren command for ${SIREN_NODE} - its confirmed readings were ${[...new Set(peak)].join(", ") || "none"}` +
        (peak.includes("CRITICAL") ? " (CRITICAL was reached: is the server's siren rule on? SIREN_AUTO_SEVERITY)"
          : " (never CRITICAL - see DOWNPOUR_MM: forecast rain can lower the flood score)");
    } else {
      detail = `${highBefore} confirmed HIGH reading(s) sounded nothing; the command (siren ${cmd.command.siren}` +
        `${cmd.command.for_s ? ` for ${cmd.command.for_s}s` : ""}) came with the answer to a reading that was ` +
        (trigger ? `${trigger.severity}, ${trigger.status} (${trigger.confirmation})` : "not stored by the backend") +
        (critical ? "" : " - NOT a confirmed CRITICAL one") +
        `; ${SIREN_NODE} then reports ${reported ? `siren_on (${reported.sirenReason})` : "NO siren_on"}` +
        (row == null ? "; siren state not read (no database access)"
          : `; server: desired ${row.desired || "none"} by ${row.desired_by || "-"}` +
            (row.last_on_actor !== undefined ? `, last switched on by ${row.last_on_actor || "nobody"}` : "") +
            (byAuto ? "" : " - NOT the auto rule"));
    }
    this.check("village-siren", pass, detail);
  }

  // Cue 12. Passes when the heat node's readings of this cue include a
  // CONFIRMED CRITICAL extreme-heat reading AND no siren came on there:
  // no 'on' command in any reply, no reading reporting siren_on, and no new
  // 'on' in the server's siren state - and the server must have the node's
  // siren on record (else silence proves nothing: it only commands nodes it
  // knows have one). That takes the database: no public API says which
  // nodes have a siren, so without a database view the check FAILS as
  // inconclusive (it used to pass on the silence alone).
  // It covers the server's auto rule only: the node's offline fallback
  // (firmware sj_siren.h) is not simulated.
  // `before` is the heat node's siren row from just before the cue.
  async checkHeatNoSiren(before) {
    const entries = this.sent.filter((e) => e.cue === "12-heat" && e.node === HEAT_NODE);
    const uids = new Set(entries.map((e) => e.uid));
    const rows = (await this.ourRows(HEAT_NODE)).filter((r) => uids.has(r.reading_uid));
    const heat = rows.filter((r) => normHazard(r.hazard_type) === HEAT_HAZARD);
    const critical = heat.find((r) => r.severity === "CRITICAL" && r.status === "alert_dispatched");
    const seen = rows.map((r) => `${r.hazard_type || "-"} ${r.severity}/${r.status}`).join(", ");
    const commanded = entries.filter((e) => e.command && e.command.siren === "on");
    const sounding = entries.filter((e) => e.sirenOn);
    const row = this.readDb("sirenRow", HEAT_NODE);
    let freshOn = false;
    if (row) {
      freshOn = row.last_on_actor !== undefined
        ? !!row.last_on_at && row.last_on_at !== (before ? before.last_on_at : null)
        : row.desired === "on" && (!before || before.desired !== "on" || row.desired_at !== before.desired_at);
    }
    const fitted = row === null ? null : !!(row && row.fitted); // null: no database view
    const silent = !commanded.length && !sounding.length && !freshOn;
    const pass = !!critical && silent && fitted === true;
    let detail = `${HEAT_NODE} readings: ${seen || "none stored"}`;
    if (critical) {
      detail = `${HEAT_NODE} ${critical.hazard_type} CRITICAL, confirmed (${critical.confirmation}) - ` + detail;
    } else {
      detail += " - no CONFIRMED CRITICAL extreme heat, so the rule was not shown (is the node's heat_region " +
        "plains? registry heat_region / SANJEEVNI_HEAT_REGION - --fresh pins plains)";
    }
    if (silent) {
      detail += `; siren silent: no 'on' command, ${HEAT_NODE} never reported siren_on`;
    } else {
      const why = [commanded.length && `an 'on' command (${commanded.length})`, sounding.length && "siren_on reported",
        freshOn && `the server switched it on (${row.last_on_actor || row.desired_by || "?"})`].filter(Boolean);
      detail += `; the siren SOUNDED for heat: ${why.join(", ")} - the automatic siren must be for evacuation ` +
        "hazards only (SIREN_AUTO_HAZARDS in server/siren.js - an older server, or a list with extreme heat?)";
    }
    if (fitted === null) {
      detail += "; INCONCLUSIVE: siren state not read (no database access) - the server only commands nodes it has " +
        `a siren on record for, so silence alone proves nothing: use --fresh, or run on the server's machine`;
    }
    else if (!fitted) detail += `; the server has no siren on record for ${HEAT_NODE} (siren_fitted not seen) - silence proves nothing`;
    else detail += `; server: desired ${row.desired || "none"}, last switched on by ${row.last_on_actor ?? row.desired_by ?? "nobody"}`;
    detail += " (server rule; the node's offline fallback is not simulated)";
    this.check("heat-no-siren", pass, detail);
  }

  // Cue 6: the backend's hazard type for the node's smoke readings. One
  // confirmed (by repeat) "smoke" reading passes; the detail lists what each
  // reading was called, so a smoke read as "air pollution" shows up.
  async checkSmoke() {
    const uids = new Set(this.sent.filter((e) => e.node === SMOKE_NODE && e.cue === "6-smoke").map((e) => e.uid));
    const rows = (await this.ourRows(SMOKE_NODE)).filter((r) => uids.has(r.reading_uid));
    const confirmed = rows.find((r) => r.hazard_type === "smoke" && r.status === "alert_dispatched");
    const seen = rows.map((r) => `${r.hazard_type || "-"}/${r.status}`).join(", ");
    this.check("smoke", !!confirmed,
      confirmed ? `${SMOKE_NODE} smoke ${confirmed.severity}, confirmed (${confirmed.confirmation}) - readings: ${seen}`
        : `${SMOKE_NODE} readings: ${seen || "none stored"} - no confirmed 'smoke'`);
  }

  async sendSos() {
    const zones = await this.io.request("GET", `${this.server}/api/hazard-zones`);
    const zone = zones.status === 200 && (zones.data.zones || []).find((z) => z.node_id === RIVER);
    if (!zone) {
      this.check("sos-in-zone", false, `no public ${RIVER} zone to place the SOS in`);
      return;
    }
    const spot = pointInZone(zone, 0.4, this.rand());
    const deviceId = `dev-judgedemo-${this.runId}`;
    // ONE request per run: the public endpoint allows 30 per network per
    // 10 min and 5 per device per hour, and a demo must never trip them.
    const res = await this.io.request("POST", `${this.server}/api/sos`, {
      body: {
        device_id: deviceId, ...spot,
        note: "[SIMULATED - judge demo, not a real emergency] Water entering the house, two elderly people.",
      },
    });
    const distance = Math.round(haversineM(zone.latitude, zone.longitude, spot.latitude, spot.longitude));
    if (res.status === 429) {
      this.check("sos-in-zone", false, "SOS rate limit hit (30 per network per 10 min) - wait 10 minutes or use --fresh");
      return;
    }
    this.log(`   ${this.stamp()} SOS from ${deviceId} at ${spot.latitude}, ${spot.longitude} -> HTTP ${res.status}` +
      (res.data && res.data.hospital ? ` (nearest hospital: ${res.data.hospital}, ${res.data.distance_km} km)` : ""));
    const lookup = await this.io.request("GET", `${this.server}/api/sos/device/${encodeURIComponent(deviceId)}`);
    this.check("sos-in-zone", res.status === 201 && distance < zone.radius_m && lookup.data && lookup.data.active === true,
      `HTTP ${res.status}, ${distance} m from ${RIVER} (zone radius ${zone.radius_m} m), open: ${!!(lookup.data && lookup.data.active)}`);
  }

  // The press is one flag on the node's next reading (sos_button: true, as
  // the firmware sends it) and server.js opens the SOS itself, even when the
  // AI backend refuses the reading - so the AI action is reported, not judged.
  // The citizen SOS is checked through the public open-SOS lookup, but
  // server.js hides "node:" IDs from it (like "whatsapp:"), the ingest
  // response does not mention the SOS, and the officer feed needs a login.
  // So the check reads the server's database (io.sosRows, read-only), which
  // also shows what the lookup could not: ONE new row, location_source
  // 'node', at the node's registered position. The lookup stays as a
  // fallback for when the database cannot be read.
  async pressNodeSos() {
    const lookup = async () => {
      const res = await this.io.request("GET", `${this.server}/api/sos/device/${encodeURIComponent(BUTTON_SOS_DEVICE)}`);
      return res.status === 200 && res.data ? res.data : { active: false };
    };
    const dbRows = () => {
      if (!this.io.sosRows) return null;
      try {
        return this.io.sosRows(BUTTON_SOS_DEVICE, BUTTON_NODE);
      } catch (e) {
        this.log(`   [warn] could not read the demo database (${e.message}) - checking the public lookup only`);
        return null;
      }
    };
    const before = await lookup();
    const rowsBefore = dbRows();
    const openBefore = before.active === true || !!(rowsBefore && rowsBefore.some((r) => r.status === "open"));
    sim.state[BUTTON_NODE].sosPress = true;
    const sent = (await this.round(NODES))[BUTTON_NODE];
    const after = await lookup();
    const rowsAfter = dbRows();
    const carried = !!(sent && sent.sos);
    const head = `${BUTTON_NODE} reading with sos_button: ${carried ? "sent" : "NOT sent"} (-> ${sent && sent.action})`;
    // A FAIL read from the database names it: a server started with another
    // SANJEEVNI_VAR_DIR is otherwise indistinguishable from a broken one.
    const source = this.io.sosRows && this.io.sosRows.source;
    const readFrom = source ? ` [read ${source} - is that the database of ${this.server}?]` : "";
    if (openBefore) {
      // A node has one open SOS at a time (the 409 path): a leftover from an
      // earlier run would look like a PASS while nothing new happened.
      this.check("node-sos", false, `${head}; ${BUTTON_SOS_DEVICE} already had an open SOS before the press - ` +
        "resolve it on the officer map (or use --fresh) and run again" + (before.active === true ? "" : readFrom));
      return;
    }
    if (!rowsAfter) {
      this.check("node-sos", carried && after.active === true,
        `${head}; ${BUTTON_SOS_DEVICE} open: ${after.active === true}` +
          (after.sos_id ? ` (SOS #${after.sos_id}, nearest hospital ${after.hospital})`
            : " - the server hides node SOS from the public lookup, so this check needs its database: " +
              "use --fresh, or run on the server's machine (then look for the pin on the officer map)"));
      return;
    }
    const seen = new Set((rowsBefore || []).map((r) => r.id));
    const added = rowsAfter.filter((r) => !seen.has(r.id));
    const row = added[0];
    const atNode = !!row && row.node_latitude != null && row.node_longitude != null &&
      Math.abs(row.latitude - row.node_latitude) < 1e-6 && Math.abs(row.longitude - row.node_longitude) < 1e-6;
    const pass = carried && added.length === 1 && row.status === "open" && row.location_source === "node" && atNode;
    this.check("node-sos", pass,
      `${head}; ${added.length} new ${BUTTON_SOS_DEVICE} SOS row(s)` +
        (row ? ` - #${row.id} ${row.status}, source ${row.location_source}, ` +
          `${atNode ? "at" : "NOT at"} the node's registered position (${row.latitude}, ${row.longitude})` : "") +
        `; public lookup open: ${after.active === true}` + (pass ? "" : readFrom));
  }

  // Cue 9: what the gateway forwards from the offline Wi-Fi page (contract
  // body for POST /api/ingest/sos, device key, same node scoping as ingest).
  // Sent TWICE with the same sos_uid, as a gateway does when the answer to
  // its first try is lost: the second must be a "duplicate" of the same SOS,
  // never a second one. No typed coordinates: the page has no GPS (plain
  // http), so the server places it at the node. client_id is per run, so a
  // run never collides with an open request of an earlier one.
  hotspotPayload() {
    return {
      node_id: HOTSPOT_NODE,
      sos_uid: `demo${this.runId}-hs1`,
      client_id: `demo${this.runId}`,
      people: 3,
      needs: ["trapped", "medical"],
      note: "[SIMULATED - judge demo, not a real emergency] 3 of us on the roof of the blue house by the temple. " +
        "Grandmother needs her medicine.",
      latitude: null,
      longitude: null,
      age_seconds: 0,
      simulated: true, // the server forces it for a simulator key anyway
    };
  }

  async sendHotspotSos() {
    const body = this.hotspotPayload();
    const deviceId = `hotspot:${HOTSPOT_NODE}:${body.client_id}`;
    const before = this.readDb("sosRows", deviceId, HOTSPOT_NODE);
    const first = await this.post("/api/ingest/sos", body);
    const sosId = first.data && first.data.sos_id;
    this.log(`   ${this.stamp()} Wi-Fi SOS from the SANJEEVNI-SOS page of ${HOTSPOT_NODE}: ${body.people} people, ` +
      `${body.needs.join(" + ")} -> HTTP ${first.status} ${(first.data && first.data.status) || first.text.slice(0, 80)}` +
      (sosId != null ? ` (SOS #${sosId})` : ""));
    // The gateway's retry (its first answer was lost on the way back)
    const again = await this.post("/api/ingest/sos", { ...body, age_seconds: 5 });
    const accepted = first.status === 200 && first.data && first.data.status === "ok" && sosId != null;
    const deduped = again.status === 200 && again.data && again.data.status === "duplicate" && again.data.sos_id === sosId;
    const head = `HTTP ${first.status} ${(first.data && first.data.status) || "-"}` + (sosId != null ? ` (SOS #${sosId})` : "") +
      `, retry: ${(again.data && again.data.status) || `HTTP ${again.status}`}` +
      (again.data && again.data.sos_id != null && again.data.sos_id !== sosId ? ` (SOS #${again.data.sos_id})` : "");
    if (first.status === 404) {
      this.check("hotspot-sos", false, `${head} - this server has no /api/ingest/sos (older server.js?)`);
      return;
    }
    const after = this.readDb("sosRows", deviceId, HOTSPOT_NODE);
    if (!after) {
      this.check("hotspot-sos", accepted && deduped,
        `${head}; position not checked (the server database is not readable here - use --fresh)`);
      return;
    }
    const seen = new Set((before || []).map((r) => r.id));
    const added = after.filter((r) => !seen.has(r.id));
    const row = added[0];
    const atNode = !!row && row.node_latitude != null && row.node_longitude != null &&
      Math.abs(row.latitude - row.node_latitude) < 1e-6 && Math.abs(row.longitude - row.node_longitude) < 1e-6;
    const pass = accepted && deduped && added.length === 1 && row.id === sosId && row.status === "open" &&
      row.location_source === "hotspot" && Number(row.location_accuracy_m) === HOTSPOT_ACCURACY_M && atNode;
    const people = row && row.people != null ? `, ${row.people} people` : "";
    const needs = row && row.needs ? `, needs ${row.needs}` : "";
    this.check("hotspot-sos", pass,
      `${head}; ${added.length} new ${deviceId} SOS row(s)` +
        (row ? ` - #${row.id} ${row.status}, source ${row.location_source}, ` +
          `${atNode ? "at" : "NOT at"} the node's registered position (~${row.location_accuracy_m ?? "?"} m)${people}${needs}` : ""));
  }

  outcome() {
    return this.checks.map((c) => `${c.id}=${c.pass ? "PASS" : "FAIL"}`).join(" ");
  }

  summary() {
    const passed = this.checks.filter((c) => c.pass).length;
    this.log(`\n${"=".repeat(72)}\n CHECKPOINTS: ${passed}/${this.checks.length} passed (seed ${this.opts.seed})`);
    this.log(` OUTCOME ${this.outcome()}`);
    this.log(`${"=".repeat(72)}`);
    return passed === this.checks.length;
  }
}

// ---------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------
async function preflight(demo, { varDir, env = process.env }) {
  const { io } = demo;
  const problems = [];
  const warn = (msg) => io.log(`   [warn] ${msg}`);
  const ok = (msg) => io.log(`   [ ok ] ${msg}`);
  io.log("\nPreflight");
  const reach = async (method, url, opts) => {
    try { return await io.request(method, url, opts); } catch (e) { return { status: 0, error: e.cause?.code || e.message }; }
  };

  const status = await reach("GET", `${demo.server}/api/status`);
  if (status.status === 200) ok(`web server ${demo.server}`);
  else problems.push(`web server ${demo.server} not reachable (${status.error || `HTTP ${status.status}`}) - start: node server/server.js`);

  const health = await reach("GET", `${demo.backend}/api/health`);
  if (health.status === 200 && health.data && health.data.models_loaded) ok(`AI backend ${demo.backend}, models loaded`);
  else if (health.status === 200) problems.push("AI backend is up but has no flood model - run: venv\\Scripts\\python.exe ml\\train_models.py");
  else problems.push(`AI backend ${demo.backend} not reachable (${health.error || `HTTP ${health.status}`})`);

  const modelsDir = path.join(varDir, "models");
  const missing = MODEL_FILES.filter((f) => !fs.existsSync(path.join(modelsDir, f)));
  if (missing.length) problems.push(`missing in ${modelsDir}: ${missing.join(", ")} - run ml\\train_models.py`);
  else ok(`models in ${modelsDir}`);
  if (!fs.existsSync(path.join(modelsDir, FORECAST_MODEL))) {
    warn(`no ${FORECAST_MODEL} - the forecast checkpoint will fail (ml\\train_river_forecast.py)`);
  }
  if (!fs.existsSync(path.join(ROOT, "frontend", "dist", "index.html"))) {
    warn("frontend/dist is not built - the classic pages are served (npm run build --prefix frontend)");
  }

  if (!demo.key) {
    problems.push("no device key - use --fresh (makes its own), or --key / SANJEEVNI_INGEST_KEY " +
      "(node server/device_keys.js add simulator --kind simulator)");
  } else if (status.status === 200) {
    // An empty batch: checks the key without sending a reading.
    const probe = await reach("POST", `${demo.server}/api/ingest/batch`, {
      body: { readings: [] }, headers: { "X-Device-Key": demo.key },
    });
    if (probe.status === 200) ok("device key accepted");
    else problems.push(`device key refused (HTTP ${probe.status || probe.error}) - create one: node server/device_keys.js add simulator --kind simulator`);
  }

  if (health.status === 200) {
    const nodes = (await demo.backendGet("/api/nodes")) || [];
    const known = new Set(nodes.map((n) => n.node_id));
    const absent = NODES.filter((n) => !known.has(n));
    if (absent.length) problems.push(`node registry lacks ${absent.join(", ")} (admin page or backend defaults)`);
    else ok(`nodes ${NODES.join(", ")} registered`);
    // Without --fresh, recent elevated readings (still inside the
    // confirmation window) could confirm the upstream jump at once.
    const recent = (await demo.backendGet("/api/readings?limit=200")) || [];
    const cutoff = io.now() - CONFIRM_WINDOW_MINUTES * 60000;
    if (recent.some((r) => ELEVATED.has(r.status) && Date.parse(r.timestamp) > cutoff)) {
      warn(`elevated readings in the last ${CONFIRM_WINDOW_MINUTES} min - the 'pending' step may confirm at once. ` +
        "Use --fresh, or wait.");
    }
    if (recent.some((r) => Date.parse(r.timestamp) > io.now() - 60000)) {
      warn("other readings arrived in the last minute - stop server/simulation.js / hardware for a clean story");
    }
    // backfill() skips the storm history when a node already has readings in
    // that period, and the siren step depends on that history's rain. Say so
    // before the run (a rehearsal on the same stack an hour earlier does it).
    if (demo.opts.backfillMinutes > 0) {
      const since = io.now() - demo.opts.backfillMinutes * 60000;
      for (const node of NODES) {
        const [latest] = (await demo.backendGet(`/api/readings?node_id=${node}&limit=1`)) || [];
        if (latest && latest.timestamp && Date.parse(latest.timestamp) > since) {
          warn(`${node} has readings from the last ${demo.opts.backfillMinutes} min - the storm back-fill will be ` +
            "skipped and the siren step will likely fail; use --fresh");
          break;
        }
      }
    }
  }

  if (status.status === 200) {
    // A node has one open SOS at a time: a leftover from an earlier run would
    // swallow cue 8's press (see Demo.pressNodeSos for why the database).
    let openId = null;
    let foundIn = "";
    try {
      const open = io.sosRows && io.sosRows(BUTTON_SOS_DEVICE, BUTTON_NODE).find((r) => r.status === "open");
      if (open) {
        openId = open.id;
        // Named, so a database that is not the server's explains itself
        if (io.sosRows.source) foundIn = ` [in ${io.sosRows.source} - is that the database of ${demo.server}?]`;
      }
    } catch { /* unreadable: the lookup below, and the checkpoint says more */ }
    if (openId === null) {
      const res = await reach("GET", `${demo.server}/api/sos/device/${encodeURIComponent(BUTTON_SOS_DEVICE)}`);
      if (res.status === 200 && res.data && res.data.active) openId = res.data.sos_id;
    }
    if (openId !== null) {
      warn(`${BUTTON_SOS_DEVICE} already has an open SOS (#${openId}) - resolve it on the officer map, ` +
        `or the node SOS step will fail; or use --fresh${foundIn}`);
    }

    // The village siren cue (see the header): a REAL node's reported siren
    // state is never overwritten by simulated readings, and the auto rule
    // can be switched off. Both only matter without --fresh.
    let siren;
    try { siren = io.sirenRow ? io.sirenRow(SIREN_NODE) : undefined; } catch { /* no siren table: an older server */ }
    if (siren && !siren.reported_simulated && siren.reported_at) {
      warn(`a REAL ${SIREN_NODE} has reported its own siren - the demo's simulated readings cannot change that ` +
        "siren's state, so the village siren step will fail; use --fresh");
    }
    if (!demo.opts.fresh && String(env.SIREN_AUTO_SEVERITY || "").trim().toLowerCase() === "off") {
      warn("SIREN_AUTO_SEVERITY=off in this environment - if the server uses it, the village siren never sounds " +
        "by itself and that step fails; use --fresh (it runs with the default, CRITICAL)");
    }
    const autoHazards = String(env.SIREN_AUTO_HAZARDS || "").split(",").map(normHazard).filter(Boolean);
    if (!demo.opts.fresh && autoHazards.includes(HEAT_HAZARD)) {
      warn(`SIREN_AUTO_HAZARDS in this environment lists extreme heat - if the server uses it, ${HEAT_NODE}'s siren ` +
        "sounds in the heat cue and that step fails; use --fresh (it runs with the evacuation-hazard default)");
    }
  }

  try {
    const tile = await io.request("GET", "https://a.tile.openstreetmap.org/0/0/0.png", {
      headers: { "User-Agent": "SANJEEVNI-demo-preflight" }, timeoutMs: 5000,
    });
    if (tile.status === 200) ok("map tiles reachable (OpenStreetMap)");
    else warn(`map tiles answered HTTP ${tile.status} - the map background may be blank`);
  } catch {
    warn("map tiles not reachable (no internet?) - the map background will be blank; markers still work");
  }

  io.log("\n   >>> Open the dashboard and officer map now and CLICK EACH PAGE ONCE to enable the alarm sound. <<<");
  return problems;
}

// ---------------------------------------------------------------------
// --fresh: a temporary copy of var/ with its own servers
// ---------------------------------------------------------------------
function makeFreshVar(sourceVarDir, { tmpRoot = os.tmpdir(), keyName } = {}) {
  const { DatabaseSync } = require("node:sqlite");
  const { createDeviceKey, initDeviceKeyTable } = require(path.join(ROOT, "server", "device_auth"));
  const dir = fs.mkdtempSync(path.join(tmpRoot, "sanjeevni-demo-"));
  const source = path.join(sourceVarDir, "sanjeevni.db");
  const copy = path.join(dir, "sanjeevni.db");
  if (fs.existsSync(source)) {
    // VACUUM INTO from a READ-ONLY connection: a consistent copy even while
    // the normal server is running, and the real database cannot be written.
    const src = new DatabaseSync(source, { readOnly: true });
    try { src.prepare("VACUUM INTO ?").run(copy); } finally { src.close(); }
  }
  const db = new DatabaseSync(copy);
  let key;
  try {
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    for (const t of tables) {
      if (FRESH_CLEARED_TABLES.includes(t) || FRESH_CLEARED_TABLE_PATTERN.test(t)) db.exec(`DELETE FROM "${t.replace(/"/g, "\"\"")}"`);
    }
    if (tables.has("users")) {
      for (const { name, notnull } of db.prepare("PRAGMA table_info(users)").all()) {
        if (FRESH_BLANKED_USER_COLUMNS.test(name)) db.exec(`UPDATE users SET "${name.replace(/"/g, "\"\"")}" = ${notnull ? "''" : "NULL"}`);
      }
    }
    initDeviceKeyTable(db);
    key = createDeviceKey(db, { name: keyName || `judge-demo-${crypto.randomBytes(3).toString("hex")}`,
      kind: "simulator", nodes: NODES.join(",") });
  } finally {
    db.close();
  }
  for (const sub of ["models", "chroma_db"]) {
    const from = path.join(sourceVarDir, sub);
    if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
  }
  return { dir, key };
}

// Read-only queries on the server's database: the demo never writes the
// database its server is using; the server's WAL mode lets a read-only
// connection see every committed row.
function readDb(varDir, query) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(varDir, "sanjeevni.db"), { readOnly: true });
  try {
    return query(db);
  } finally {
    db.close();
  }
}

// A device's SOS rows (every column the server has - people, needs and
// location_accuracy_m only exist on newer servers), with the node's
// registered position (see Demo.pressNodeSos / sendHotspotSos).
function readSosRows(varDir, deviceId, nodeId) {
  return readDb(varDir, (db) => db.prepare(
    `SELECT s.*, n.latitude AS node_latitude, n.longitude AS node_longitude
       FROM sos_requests s LEFT JOIN nodes n ON n.node_id = ?
      WHERE s.device_id = ? ORDER BY s.id`,
  ).all(nodeId, deviceId));
}

// The node's siren row (server/siren.js), undefined when it has none.
// Throws "no such table" on a server from before the village siren.
// With last_on_actor / last_on_at: who last switched it ON, from siren_audit
// (null when nobody has; left out when the server has no audit table). The
// row's desired_reason is not enough: siren.js clears it once the on-time
// has run out and the node reports silent, but the audit row stays.
function readSirenRow(varDir, nodeId) {
  return readDb(varDir, (db) => {
    const row = db.prepare("SELECT * FROM node_sirens WHERE node_id = ?").get(nodeId);
    if (!row) return row;
    let on;
    try {
      on = db.prepare("SELECT actor, at FROM siren_audit WHERE node_id = ? AND action = 'on' ORDER BY id DESC LIMIT 1")
        .get(nodeId);
    } catch {
      return row; // no siren_audit table
    }
    return { ...row, last_on_actor: on ? on.actor : null, last_on_at: on ? on.at : null };
  });
}

// Did the server's AUTO rule switch the siren on during this run (since
// `sinceMs`)? From the audit when the row has it: the latest "on" must be
// the auto rule's and from this run - an officer who pressed "on" after it
// fails the check, as does an "on" left over from an earlier run. Else from
// the open request's desired_reason. null = no database row to judge by.
function sirenOnByAuto(row, sinceMs) {
  if (row == null) return null;
  if (row.last_on_actor !== undefined) {
    const at = row.last_on_at == null ? NaN : Date.parse(row.last_on_at);
    // a minute's slack, as for the confidence check's sensor_data rows
    return row.last_on_actor === "auto" && at >= sinceMs - 60000;
  }
  return row.desired_reason === "auto";
}

// The node's newest dashboard rows (sensor_data: what /api/hazards and the
// officer views are built from, with the confidence columns), newest first.
function readSensorRows(varDir, nodeId, limit = 500) {
  return readDb(varDir, (db) => db.prepare("SELECT * FROM sensor_data WHERE node_id = ? ORDER BY id DESC LIMIT ?")
    .all(nodeId, limit));
}

// The io.sosRows / sirenRow / sensorRows readers for main(), or null. The
// server's database is only readable when the demo shares its machine:
// --fresh (the demo's own copy) or a --server on this host. For any other
// server (--server http://<pi>:3000) a local var/ is an unrelated database,
// and reading it would turn a working server into a "0 new rows" FAIL - so
// the checkpoints keep to the APIs, and say to use --fresh or run on the
// server's machine. .source names the file, for the messages that depend on it.
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function dbReaders(serverUrl, varDir, { fresh = false } = {}) {
  let host = "";
  try { host = new URL(serverUrl).hostname.toLowerCase(); } catch { /* not a URL: not this machine */ }
  const dbFile = path.join(varDir, "sanjeevni.db");
  if ((!fresh && !LOCAL_HOSTS.has(host)) || !fs.existsSync(dbFile)) return null;
  const named = (fn) => Object.assign(fn, { source: dbFile });
  return {
    sosRows: named((deviceId, nodeId) => readSosRows(varDir, deviceId, nodeId)),
    sirenRow: named((nodeId) => readSirenRow(varDir, nodeId)),
    sensorRows: named((nodeId) => readSensorRows(varDir, nodeId)),
  };
}
function sosRowsReader(serverUrl, varDir, opts) {
  const readers = dbReaders(serverUrl, varDir, opts);
  return readers && readers.sosRows;
}

function defaultPython() {
  return path.join(ROOT, "venv", process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
}

// What --fresh adds to the web server's environment (on top of
// process.env; a variable set here wins over .env, which paths.js loads
// without override):
//  - The siren cue shows the real rule: a SIREN_AUTO_SEVERITY=off in .env
//    (someone testing without sirens) must not silently fail it here. A
//    short SIREN_ON_SECONDS there would end the siren mid-cue, so the
//    on-time is pinned to siren.js's default (180 s) too, and the hazard
//    list to the decision's default (cue 12: a heat wave never sounds it).
//  - WhatsApp is forced to a dry run (server.js WHATSAPP_DRY_RUN=1: log, do
//    not send) and simulated readings never alert anyone: the demo's alerts
//    can never reach a real officer or citizen, whatever .env holds and
//    whatever the officer-phone schema is called (the blanking in
//    makeFreshVar is defence in depth on top of this).
function freshWebEnv(webPort, backendUrl) {
  return {
    SANJEEVNI_PORT: String(webPort), SANJEEVNI_BACKEND_URL: backendUrl,
    SIREN_AUTO_SEVERITY: "CRITICAL", SIREN_ON_SECONDS: "180", SIREN_AUTO_HAZARDS: DEMO_SIREN_AUTO_HAZARDS,
    WHATSAPP_DRY_RUN: "1", WHATSAPP_ALERTS_FOR_SIMULATED: "0",
  };
}

// onStack(stack) is called as soon as there is something to clean up, so
// Ctrl+C during the (slow) backend start still stops it and deletes the copy.
async function startFreshStack(opts, io, onStack = () => {}) {
  const python = opts.python || defaultPython();
  if (!fs.existsSync(python)) throw new UsageError(`Python not found at ${python} - pass --python`);
  // 127.0.0.1, not localhost: cookies are shared across PORTS of one host
  // name, so logging in to the demo at localhost:3100 would replace the
  // session cookie of a normal localhost:3000 tab (and the reverse).
  const webUrl = `http://127.0.0.1:${opts.webPort}`;
  const backendUrl = `http://127.0.0.1:${opts.backendPort}`;
  for (const url of [`${webUrl}/api/status`, `${backendUrl}/api/health`]) {
    let busy = false;
    try { await io.request("GET", url, { timeoutMs: 2000 }); busy = true; } catch { /* free */ }
    if (busy) throw new UsageError(`${url} already answers - something is on that port. Pick --web-port / --backend-port.`);
  }
  io.log(`--fresh: copying ${paths.VAR_DIR} (users, device keys, nodes, models) to a temporary folder...`);
  const { dir, key } = makeFreshVar(paths.VAR_DIR);
  io.log(`   temporary var: ${dir}`);
  // OMP_NUM_THREADS=1: the flood model (HistGradientBoosting) starts its
  // OpenMP thread pool for every single-row prediction; on a 16-thread
  // laptop that made one reading take 0.5-4 s instead of ~0.3 s, and the
  // back-fill took minutes. One reading at a time gains nothing from threads.
  // The forecast: SIMULATED and calm until cue 11 (see weatherMock). In the
  // temporary folder, so it goes with it.
  const weatherFile = path.join(dir, "weather_mock.json");
  const env ={ OMP_NUM_THREADS: "1", ...process.env, SANJEEVNI_VAR_DIR: dir };
  const children = [];
  const launch = (name, cmd, args, extraEnv) => {
    const logFile = path.join(dir, `${name}.log`);
    const fd = fs.openSync(logFile, "a");
    const child = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
    child.logFile = logFile;
    child.exitedEarly = null;
    child.on("exit", (code) => { child.exitedEarly = code ?? "signal"; });
    children.push(child);
    return child;
  };
  const stack = {
    dir, key, webUrl, backendUrl, children, weatherFile,
    async stop({ keepVar }) {
      if (this.stopped) return; // a failed start stops it, then main's shutdown tries again
      this.stopped = true;
      for (const c of children) {
        if (c.exitCode === null && c.signalCode === null) {
          const gone = new Promise((resolve) => c.once("exit", resolve));
          c.kill();
          await Promise.race([gone, io.sleep(5000)]);
        }
      }
      if (keepVar) {
        io.log(`   kept the temporary var: ${dir}`);
        return;
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (e) {
        io.log(`   could not delete ${dir} (${e.code}) - delete it by hand`);
      }
    },
  };
  onStack(stack);
  const tail = (child) => {
    try { return fs.readFileSync(child.logFile, "utf8").split(/\r?\n/).slice(-15).join("\n"); } catch { return ""; }
  };
  const waitFor = async (child, url, label, seconds) => {
    for (let i = 0; i < seconds; i++) {
      if (child.exitedEarly !== null) throw new Error(`${label} exited (code ${child.exitedEarly}):\n${tail(child)}`);
      try {
        const res = await io.request("GET", url, { timeoutMs: 2000 });
        if (res.status === 200) return;
      } catch { /* not up yet */ }
      await io.sleep(1000);
    }
    throw new Error(`${label} did not start within ${seconds}s:\n${tail(child)}`);
  };
  try {
    writeWeatherMock(weatherFile, "calm", io.now());
    io.log("   forecast: SIMULATED, calm until cue 11 - the backend reads it from SANJEEVNI_WEATHER_MOCK, not the internet");
    io.log(`   starting the AI backend on :${opts.backendPort} (loading models takes a while)...`);
    const backend = launch("backend", python,
      ["-m", "uvicorn", "backend_server:app", "--app-dir", "backend", "--host", "127.0.0.1", "--port", String(opts.backendPort)],
      // plains = the backend's default heat region (IMD's 45 / 47 C criteria
      // apply there): cue 12 must not depend on a SANJEEVNI_HEAT_REGION in .env
      { SANJEEVNI_WEATHER_MOCK: weatherFile, SANJEEVNI_HEAT_REGION: "plains" });
    await waitFor(backend, `${backendUrl}/api/health`, "AI backend", 300);
    io.log(`   starting the web server on :${opts.webPort}...`);
    const web = launch("server", process.execPath, [path.join(ROOT, "server", "server.js")],
      freshWebEnv(opts.webPort, backendUrl));
    await waitFor(web, `${webUrl}/api/status`, "web server", 60);
  } catch (e) {
    await stack.stop({ keepVar: opts.keepVar });
    throw e;
  }
  return stack;
}

// ---------------------------------------------------------------------
async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
    return;
  }
  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/?\s?\*\s?/gm, "").replace(/^#!.*\n/, ""));
    return;
  }
  const io = { ...realIo };
  let stack = null;
  let stopping = false;
  const shutdown = async (code) => {
    if (stopping) return;
    stopping = true;
    if (stack) await stack.stop({ keepVar: opts.keepVar });
    process.exit(code);
  };
  process.on("SIGINT", () => {
    console.log("\nStopping...");
    shutdown(process.exitCode || 0);
  });

  console.log("SANJEEVNI judge demo - SIMULATED data (simulated: true on every reading)");
  try {
    if (opts.fresh) {
      await startFreshStack(opts, io, (s) => { stack = s; });
      opts.server = stack.webUrl;
      opts.backend = stack.backendUrl;
      opts.key = stack.key;
    }
    // The node SOS, siren, confidence and Wi-Fi SOS checkpoints read the
    // server's database (see dbReaders). Without --fresh that assumes a
    // server on this host uses this machine's var/ - as the model check in
    // preflight already does.
    const varDir = stack ? stack.dir : paths.VAR_DIR;
    Object.assign(io, dbReaders(opts.server, varDir, { fresh: !!stack }) || {});
    // Cue 11: only the --fresh backend reads the demo's forecast file
    if (stack) io.setWeather = (kind) => writeWeatherMock(stack.weatherFile, kind, io.now());
    if (!io.sosRows && !stack) {
      console.log(`   [note] ${opts.server} is not on this machine (or ${varDir} has no database): the node SOS, ` +
        "siren, confidence and Wi-Fi SOS checkpoints cannot read its database - use --fresh, or run the demo " +
        "on the server's machine");
    }
    if (opts.waitEnter && process.stdin.isTTY) {
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin });
      let waiting = [];
      rl.on("line", () => { const w = waiting; waiting = []; w.forEach((resolve) => resolve()); });
      io.enterPressed = () => new Promise((resolve) => waiting.push(resolve));
    }
    const demo = new Demo(opts, io);
    const problems = await preflight(demo, { varDir });
    if (problems.length) {
      console.log("\nPreflight failed:");
      for (const p of problems) console.log(`   - ${p}`);
      return shutdown(1);
    }
    console.log(`\n   Dashboard:   ${opts.server}/            (log in as an officer - only officers hear the browser alarm)`);
    console.log(`   Officer map: ${opts.server}/officer.html`);
    console.log(`   CAP feed:    ${opts.server}/cap/feed.atom   (public; cue 13)`);
    console.log(`   Seed ${opts.seed}, a round of readings every ${opts.interval}s, each cue held ${opts.waitEnter ? "until Enter" : `${opts.pace}s`}.`);

    console.log("\nBack-filling quiet history (so the forecast has its 2-hour window)...");
    await demo.backfill();
    await demo.story();
    const allPassed = demo.summary();
    process.exitCode = allPassed ? 0 : 1;
    if (!opts.exit) {
      console.log("\nThe scene stays live (nodes keep reporting the final state). Ctrl+C to stop" +
        (opts.fresh ? " - this also stops the demo servers and deletes the temporary copy." : "."));
      demo.cue = "hold";
      while (!stopping) await demo.round(NODES);
      return;
    }
    return shutdown(process.exitCode);
  } catch (e) {
    console.error(`\n${e instanceof UsageError ? "" : "Demo stopped: "}${e.message}`);
    return shutdown(1);
  }
}

if (require.main === module) main();

module.exports = {
  main, parseArgs, Demo, preflight, makeFreshVar, startFreshStack, realIo, UsageError, readSosRows, readSirenRow, readSensorRows, dbReaders,
  sirenOnByAuto, weatherMock, writeWeatherMock, parseAtomFeed, WEATHER_STORM_FILE, WEATHER_NOW_INDEX,
  FRESH_CLEARED_TABLE_PATTERN, FRESH_BLANKED_USER_COLUMNS, freshWebEnv, CAP_FEED_MAX_FOLLOW,
  sosRowsReader, pointInZone, haversineM, backfillTimes, confidenceOf, mulberry32, NODES, RIVER, UPSTREAM, FAULT_NODE,
  BUTTON_NODE, BUTTON_SOS_DEVICE, SIREN_NODE, HOTSPOT_NODE, SMOKE_NODE, HOTSPOT_ACCURACY_M, BACKFILL_GAP_MINUTES,
  CONFIRM_WINDOW_MINUTES, FRESH_CLEARED_TABLES, UPSTREAM_JUMP_M, RIVER_RISE_M, FAULT_LEVEL_M, DOWNPOUR_MM,
  HEAT_NODE, HEAT_RAMP_C, DEMO_SIREN_AUTO_HAZARDS,
};
