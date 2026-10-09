#!/usr/bin/env node
/*
 * SANJEEVNI - scripted judge demo
 * =====================================================================
 * One command, the same 5-minute story every time:
 *
 *   1. all quiet - 2 h of normal history is back-filled first, so the
 *      river forecast popup has data (it needs 2 h of readings)
 *   2. the upstream node NODE-07 jumps        -> PENDING (officers only)
 *   3. the flood wave reaches NODE-04         -> CONFIRMED by the neighbour, siren
 *   4. NODE-INDB reports a 14.2 m river       -> suppressed as a sensor fault
 *   5. a citizen SOS lands inside the NODE-04 flood zone
 *   6. the hillside LoRa gateway loses its uplink, then uploads the backlog
 *
 * with a CUE block (what to say, what to show) before each step and a
 * PASS/FAIL checkpoint after it. Everything it sends is SIMULATED data
 * (simulated: true on every reading) - say so when presenting.
 *
 *   node server/simulation.js --scenario judges --fresh      (recommended)
 *   node tools/demo/run_demo.js --fresh                      (same thing)
 *
 * --fresh never touches var/: it copies the database (users, device keys,
 * node registry - NOT readings, SOS requests, sessions or WhatsApp
 * subscribers), the models and the RAG store into a temporary
 * SANJEEVNI_VAR_DIR, makes a demo-only simulator key in that copy, and
 * starts its own AI backend + web server on spare ports. Open the printed
 * URL and log in with your usual account.
 * Without --fresh it runs against an already running stack (--server,
 * --backend) and needs a simulator device key; it then adds readings and
 * one SOS to THAT database.
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
const FRESH_CLEARED_TABLES = [
  "readings", "sensor_data", "sos_requests", "citizen_reports", "sessions", "whatsapp_subscribers", "whatsapp_alert_log",
];

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
  return { status: res.status, data, text };
}

const realIo = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
  request: httpRequest,
  log: (line) => console.log(line),
  enterPressed: null, // set by main() when --wait-enter is on a terminal
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
      return [res.status === 200 ? res.data.ai_action : `HTTP ${res.status}`];
    }
    const readings = items.map((it) => ({
      ...it.reading,
      link: it.link || "lora",
      signal_strength_dbm: Math.round(-118 + this.rand() * 20),
      age_seconds: Math.max(0, Math.round((now - it.takenAt) / 1000) + (it.extraAge || 0)),
    }));
    const res = await this.post("/api/ingest/batch", { readings });
    if (res.status !== 200) return items.map(() => `HTTP ${res.status}`);
    return res.data.results.map((r) => r.ai_action);
  }

  record(item, action) {
    const node = item.reading.node_id;
    const entry = {
      node, label: item.label, level: item.reading.river_level_m, action, uid: item.reading.reading_uid, cue: this.cue,
      late: item.late || 0,
    };
    this.sent.push(entry);
    if (this.opts.verbose || this.lastAction[node] !== action || item.late) {
      const level = entry.level == null ? "" : `${entry.level.toFixed(2)} m`;
      const late = item.late ? `  (delivered ${item.late}s late)` : "";
      this.log(`   ${this.stamp()} ${node.padEnd(9)} ${String(item.label).padEnd(12)} ${level.padStart(8)}  -> ${action}${late}`);
    }
    this.lastAction[node] = action;
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
    // hour the siren cue needs - more so the slower the back-fill. For this
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
        // the top) to rate the riverside flood HIGH, so the siren checkpoint
        // and probably the forecast will fail. Say so here - it used to be a
        // PASS, which hid the cause of the later failures.
        // (No creditGap: lastAt is still the start of the would-be history,
        // and crediting it would dump 2 h of rain into one reading.)
        this.check("backfill", false, `skipped - ${node} already has readings from the last ${minutes} min, ` +
          `so there is no ${RAIN_STARTED_MINUTES}-min storm history: ${RIVER} will likely stay MEDIUM ` +
          "(no siren) and the forecast may be unavailable. Use --fresh, or wait until the stack has been quiet " +
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
    const T = 6;
    const pace = this.opts.pace;

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
    await this.hold(NODES, pace - this.opts.interval);

    this.cue = "2-upstream";
    this.showCue(2, T, `Upstream river jumps at ${UPSTREAM} (hillside)`, [
      "One reading from one node is never enough for a public alert.",
      "The AI rates it as a flood risk but holds it as PENDING until something independent agrees.",
    ], [
      `Officer map: amber PENDING marker at ${UPSTREAM}. Public dashboard: still no hazard.`,
    ]);
    this.setScript(UPSTREAM, UPSTREAM_JUMP_M);
    const jump = await this.round(NODES);
    this.check("upstream-pending", jump[UPSTREAM] && jump[UPSTREAM].action === "pending_confirmation",
      `${UPSTREAM} at ${UPSTREAM_JUMP_M} m -> ${jump[UPSTREAM] && jump[UPSTREAM].action}`);
    // NODE-07 is a battery LoRa node: its next report is not due during this
    // cue (it would confirm itself). The other two keep reporting.
    await this.hold([RIVER, FAULT_NODE], pace - this.opts.interval);

    this.cue = "3-confirm";
    this.showCue(3, T, `Flood wave reaches ${RIVER} - confirmed by the neighbour, siren`, [
      `Minutes later the riverside node downstream rises too. Two independent nodes agree,`,
      "so the alert is CONFIRMED and goes public - and the control-room alarm sounds.",
    ], [
      "Dashboard / officer map: full-screen alarm with siren -> press Acknowledge.",
      `Hazard list: ${RIVER} flood with its expected time to the critical level.`,
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
    const hazards = await this.io.request("GET", `${this.server}/api/hazards`);
    const riverHazard = hazards.status === 200 &&
      (hazards.data.hazards || []).find((h) => h.node_id === RIVER && h.hazard_type === "flood");
    this.check("siren", riverHazard && ["HIGH", "CRITICAL"].includes(riverHazard.severity) && !riverHazard.stale,
      riverHazard ? `public hazard ${RIVER} flood ${riverHazard.severity} - the alarm sounds on open pages`
        : `no confirmed ${RIVER} flood in /api/hazards`);
    await this.hold(NODES, pace);

    this.cue = "4-fault";
    this.showCue(4, T, `Sensor fault: ${FAULT_NODE} reports a ${FAULT_LEVEL_M} m river`, [
      `A glitching sensor reports ${FAULT_LEVEL_M} m - impossible for this site.`,
      "It is suppressed as a sensor fault: no alert, no siren; maintainers can see the faulty channel.",
    ], [
      `No new alarm. ${FAULT_NODE} stays calm on the map.`,
    ]);
    sim.state[FAULT_NODE].event = { type: "sensor_fault", step: 0, delay: 0 };
    const fault = await this.round(NODES);
    const faultRow = fault[FAULT_NODE];
    const hz = await this.io.request("GET", `${this.server}/api/hazards`);
    const faultListed = hz.status === 200 && (hz.data.hazards || []).some((h) => h.node_id === FAULT_NODE);
    this.check("fault-suppressed", faultRow && faultRow.level === FAULT_LEVEL_M && faultRow.action === "suppressed" &&
      !faultListed, `${FAULT_NODE} ${faultRow && faultRow.level} m -> ${faultRow && faultRow.action}` +
        (faultListed ? ` - but ${FAULT_NODE} IS in the public hazard list` : ", not in the public hazard list"));
    await this.hold(NODES, pace - this.opts.interval);

    this.cue = "5-sos";
    this.showCue(5, T, `A citizen inside the ${RIVER} flood zone presses SOS`, [
      "Someone inside the flood zone presses SOS on the public page.",
      "Officers see it at once, with a route to them and to the nearest hospital.",
    ], [
      `Officer map: a new SOS pin inside the ${RIVER} circle -> open it, then Resolve.`,
    ]);
    await this.sendSos();
    await this.hold(NODES, pace);

    this.cue = "6-outage";
    this.showCue(6, T, `LoRa uplink outage at the hillside gateway (${this.opts.outage}s)`, [
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
async function preflight(demo, { varDir }) {
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
    for (const t of FRESH_CLEARED_TABLES) if (tables.has(t)) db.exec(`DELETE FROM "${t}"`);
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

function defaultPython() {
  return path.join(ROOT, "venv", process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
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
  const env = { OMP_NUM_THREADS: "1", ...process.env, SANJEEVNI_VAR_DIR: dir };
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
    dir, key, webUrl, backendUrl, children,
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
    io.log(`   starting the AI backend on :${opts.backendPort} (loading models takes a while)...`);
    const backend = launch("backend", python,
      ["-m", "uvicorn", "backend_server:app", "--app-dir", "backend", "--host", "127.0.0.1", "--port", String(opts.backendPort)]);
    await waitFor(backend, `${backendUrl}/api/health`, "AI backend", 300);
    io.log(`   starting the web server on :${opts.webPort}...`);
    const web = launch("server", process.execPath, [path.join(ROOT, "server", "server.js")],
      { SANJEEVNI_PORT: String(opts.webPort), SANJEEVNI_BACKEND_URL: backendUrl });
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
    if (opts.waitEnter && process.stdin.isTTY) {
      const readline = require("readline");
      const rl = readline.createInterface({ input: process.stdin });
      let waiting = [];
      rl.on("line", () => { const w = waiting; waiting = []; w.forEach((resolve) => resolve()); });
      io.enterPressed = () => new Promise((resolve) => waiting.push(resolve));
    }
    const demo = new Demo(opts, io);
    const problems = await preflight(demo, { varDir: stack ? stack.dir : paths.VAR_DIR });
    if (problems.length) {
      console.log("\nPreflight failed:");
      for (const p of problems) console.log(`   - ${p}`);
      return shutdown(1);
    }
    console.log(`\n   Dashboard:   ${opts.server}/            (log in with your usual account)`);
    console.log(`   Officer map: ${opts.server}/officer.html`);
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
  main, parseArgs, Demo, preflight, makeFreshVar, startFreshStack, pointInZone, haversineM, backfillTimes, mulberry32,
  NODES, RIVER, UPSTREAM, FAULT_NODE, BACKFILL_GAP_MINUTES, CONFIRM_WINDOW_MINUTES, FRESH_CLEARED_TABLES,
  UPSTREAM_JUMP_M, RIVER_RISE_M, FAULT_LEVEL_M,
};
