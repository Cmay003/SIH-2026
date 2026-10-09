/*
 * SANJEEVNI - sensor network simulator
 * =====================================================================
 * Simulates sensor NODES (and optionally the LoRa gateway) for every
 * module you don't have wired yet: water level, DHT22, MQ135, IR flame,
 * rain gauge, soil moisture, MPU6050 tilt/vibration, PMS5003, pH,
 * turbidity, battery.
 *
 * It simulates whole VIRTUAL nodes - it never injects values into a real
 * node's readings. Fake values mixed into real hardware data would end up
 * in training exports and could mislead anyone reviewing the system.
 * Every simulated reading carries simulated: true.
 *
 * Run alongside a real ESP32: skip the node ID the hardware uses, e.g.
 *   node server/simulation.js --skip NODE-04
 *
 * To try it without touching the normal stack's database, run a second
 * stack on a COPY of var/ and spare ports (see README, "Testing beside a
 * running copy"):
 *   set SANJEEVNI_VAR_DIR=C:\tmp\var_copy                     (both windows)
 *   venv\Scripts\python.exe -m uvicorn backend_server:app --app-dir backend --host 127.0.0.1 --port 8765
 *   set SANJEEVNI_PORT=3765& set SANJEEVNI_BACKEND_URL=http://127.0.0.1:8765& node server/server.js
 *   node server/simulation.js --server http://localhost:3765 --key <key from the copy's DB>
 *
 * Options (all optional):
 *   --nodes NODE-04,NODE-07     simulate only these nodes (default: all in NODE_PROFILES)
 *   --skip NODE-04              ...or all except these (your real hardware)
 *   --interval 3                seconds between readings (round-robin over nodes)
 *   --mode direct|lora          direct = each reading to /api/ingest over "WiFi";
 *                               lora   = via a simulated gateway: /api/ingest/batch with
 *                                        reading_uid, age_seconds, LoRa RSSI (default: direct)
 *   --outage 60                 lora mode: gateway loses its uplink for N s every
 *                               --outage-every s (default 300), queues readings and
 *                               uploads the backlog afterwards (store-and-forward)
 *   --events flood,fire,...     hazard events to generate (default: all):
 *                               flood, gas_leak, fire, heat, landslide, air, water, sensor_fault
 *   --event-every 36            seconds between new hazard events
 *   --silent NODE-INDB@120      node stops reporting after 120 s (missing-node alert demo)
 *   --kit NODE-07=tilt,rain,battery
 *                               give a node a different sensor kit (modular-node demo;
 *                               repeat for more nodes). Modules: water dht gas flame
 *                               rain soil tilt pm ph turbidity battery
 *   --server http://localhost:3000
 *   --key <device key>          or SANJEEVNI_INGEST_KEY in the environment / .env
 *                               (create: node server/device_keys.js add simulator --kind simulator)
 *   --seed 42                   repeatable runs
 *   --scenario judges           the scripted judge demo instead (tools/demo/run_demo.js):
 *                               preflight, 2 h history back-fill, then cued steps
 *                               (pending -> confirmed -> siren -> fault -> SOS -> outage).
 *                               Its options: node tools/demo/run_demo.js --help
 *   --help
 */

require("./paths"); // loads SANJEEVNI_INGEST_KEY from the project-root .env

// ---------------------------------------------------------------------
// Which modules each virtual node "has". Edit to match the kit you plan
// to deploy, or override per run with --kit. A hazard event only runs on
// nodes with the sensor it needs. Every module is optional (modular
// nodes): readings only carry the sensors the node has.
// Modules: water dht gas flame rain soil tilt pm ph turbidity battery
// ---------------------------------------------------------------------
const NODE_PROFILES = {
  "NODE-04": ["water", "dht", "gas", "flame", "rain", "soil", "ph", "turbidity", "battery"], // riverside
  "NODE-07": ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "battery"], // hillside (upstream of NODE-04)
  "NODE-INDB": ["water", "dht", "gas", "flame", "pm", "battery"], // industrial zone
};
const DOWNSTREAM_OF = { "NODE-07": "NODE-04" }; // a flood upstream reaches this node later
const MODULES = ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "pm", "ph", "turbidity", "battery"];
// rain and battery alone are not a measurement (the backend rejects such a reading)
const MEASURING_MODULES = MODULES.filter((m) => m !== "rain" && m !== "battery");

// Hazard events last several readings - the backend only makes an alert
// public once a repeat reading or a neighbour confirms it.
// sensor_fault is a single spike: it should be suppressed or stay pending.
const EVENTS = {
  flood: { needs: "water", readings: 8 },
  gas_leak: { needs: "gas", readings: 5 },
  fire: { needs: "flame", readings: 5 },
  heat: { needs: "dht", readings: 6 },
  landslide: { needs: "tilt", readings: 6 },
  air: { needs: "pm", readings: 6 },
  water: { needs: "ph", readings: 6 },
  sensor_fault: { needs: "water", readings: 1 },
};

// Rain is simulated as a RATE (mm per hour) times the real time since the
// node's previous reading. It used to be a fixed amount per reading, and the
// backend sums readings over real time (rain in the last 1 h / 24 h), so the
// rain rate grew with fewer nodes or a shorter --interval: one node at 3 s
// made "drizzle" ~6 mm/h (144 mm/day, IMD "very heavy rain") and the flood
// model scored a calm river MEDIUM (B66).
const DRIZZLE_MM_PER_HR = [0, 0.4]; // background drizzle: at most ~10 mm/day
const FLOOD_RAIN_MM_PER_HR = [60, 100]; // cloudburst-level rain during a flood event

// ---------------------------------------------------------------------
function parseArgs(argv) {
  const opts = {
    nodes: Object.keys(NODE_PROFILES), skip: [], interval: 3, mode: "direct", outage: 0, outageEvery: 300,
    events: Object.keys(EVENTS), eventEvery: 36, silent: {}, server: "http://localhost:3000", seed: null,
    key: process.env.SANJEEVNI_INGEST_KEY || "",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const val = argv[i + 1];
    const list = () => String(val).split(",").map((s) => s.trim()).filter(Boolean);
    switch (key) {
      case "--nodes": opts.nodes = list(); i++; break;
      case "--skip": opts.skip = list(); i++; break;
      case "--interval": opts.interval = Number(val); i++; break;
      case "--mode": opts.mode = val; i++; break;
      case "--outage": opts.outage = Number(val); i++; break;
      case "--outage-every": opts.outageEvery = Number(val); i++; break;
      case "--events": opts.events = list(); i++; break;
      case "--event-every": opts.eventEvery = Number(val); i++; break;
      case "--silent":
        for (const item of list()) {
          const [node, after] = item.split("@");
          opts.silent[node] = Number(after || 0);
        }
        i++;
        break;
      case "--kit": {
        const [node, modules] = String(val).split("=");
        const kit = String(modules || "").split(",").map((s) => s.trim()).filter(Boolean);
        const unknown = kit.filter((m) => !MODULES.includes(m));
        if (!node || !kit.length) fail("--kit needs NODE=module,module (e.g. --kit NODE-07=tilt,rain,battery)");
        if (unknown.length) fail(`Unknown module(s) ${unknown} - choose from ${MODULES.join(" ")}`);
        if (!kit.some((m) => MEASURING_MODULES.includes(m))) {
          fail(`--kit ${node}: needs at least one measuring sensor (${MEASURING_MODULES.join(" ")})`);
        }
        NODE_PROFILES[node] = kit;
        i++;
        break;
      }
      case "--server": opts.server = val.replace(/\/$/, ""); i++; break;
      case "--seed": opts.seed = Number(val); i++; break;
      case "--key": opts.key = val; i++; break;
      case "--help": case "-h":
        console.log(require("fs").readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/?\s?\*\s?/gm, ""));
        process.exit(0);
        break;
      default:
        console.error(`Unknown option ${key} - see --help`);
        process.exit(1);
    }
  }
  opts.nodes = opts.nodes.filter((n) => !opts.skip.includes(n));
  const unknownNodes = opts.nodes.filter((n) => !NODE_PROFILES[n]);
  const unknownEvents = opts.events.filter((e) => !EVENTS[e]);
  if (unknownNodes.length) fail(`No sensor profile for ${unknownNodes} - add it to NODE_PROFILES`);
  if (unknownEvents.length) fail(`Unknown event(s) ${unknownEvents} - choose from ${Object.keys(EVENTS)}`);
  if (!opts.nodes.length) fail("No nodes left to simulate");
  if (!["direct", "lora"].includes(opts.mode)) fail("--mode must be direct or lora");
  if (!(opts.interval > 0)) fail("--interval must be > 0");
  if (opts.outage && !(opts.outage < opts.outageEvery)) fail("--outage must be shorter than --outage-every");
  return opts;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const keyProblemHint =
  "device key missing/invalid/not allowed. Create one: node server/device_keys.js add simulator --kind simulator, " +
  "then set SANJEEVNI_INGEST_KEY (env or .env) or pass --key";
// Run as a script: parse the command line and start sending. Required (by
// tools/demo/simulation.test.js): default options, nothing is sent, so the
// reading generator can be tested without a server.
const isMain = require.main === module;
// --scenario hands the whole command line to the scripted demo, which has
// its own options. It runs at the END of this file, once module.exports is
// complete: run_demo.js requires this file, and while this file is still
// executing that require would return a half-built exports object.
const scenarioArgs = isMain ? scenarioHandoff(process.argv.slice(2)) : null;
function scenarioHandoff(argv) {
  const i = argv.indexOf("--scenario");
  if (i < 0) return null;
  if (argv[i + 1] !== "judges") fail("--scenario: the only scenario is 'judges' (node tools/demo/run_demo.js --help)");
  return [...argv.slice(0, i), ...argv.slice(i + 2)];
}
const opts = parseArgs(isMain && !scenarioArgs ? process.argv.slice(2) : []);
if (isMain && !scenarioArgs && !opts.key) {
  console.warn(`No device key set - the server will refuse readings.
  ${keyProblemHint}
`);
}

// Seedable PRNG (mulberry32) so a demo run can be repeated exactly.
let rngState = (opts.seed ?? Date.now()) >>> 0;
// The scripted demo sets its --seed after requiring this file.
function reseed(seed) {
  rngState = seed >>> 0;
}
function random() {
  rngState = (rngState + 0x6d2b79f5) >>> 0;
  let t = rngState;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo, hi) => lo + random() * (hi - lo);
const pick = (items) => items[Math.floor(random() * items.length)];
const round = (v, digits) => +v.toFixed(digits);
const lerp = (a, b, f) => a + (b - a) * f;

// ---------------------------------------------------------------------
// Per-node state: slow-moving values (battery, soil, tilt baseline) are
// carried between readings so they behave like real sensors, not noise.
// ---------------------------------------------------------------------
const startedAt = Date.now();
// Random per run: "epoch % 65536" could repeat across runs, and the backend
// then dropped the new run's readings as duplicates (review R27).
const session = require("crypto").randomBytes(4).toString("hex");
// Every setInterval firing in main(), INCLUDING the ones skipped because a
// slow send was still running. Declared before the state below is built
// (initialState reads it). Tests and run_demo.js never call noteClockTick,
// so for them it stays 0 and the rain cap is the plain 2 x interval x nodes.
let clockTicks = 0;
function noteClockTick() {
  clockTicks++;
}
const state = {};
function initialState(now = Date.now()) {
  return {
    seq: 0,
    lastAt: now, // when this node last took a reading (rain is a rate x elapsed time)
    // clockTicks at this node's last reading: ticks that fired since then are
    // real time that passed, even if a slow backend made the loop skip them.
    // (clockTicks, not 0: a node set up later must not inherit earlier ticks.)
    lastClock: clockTicks,
    rainCarry: 0, // rain below the reporting resolution, kept for the next reading
    battery: between(65, 95),
    soil: between(30, 45),
    // River level as a slowly drifting state (B33): it used to be a fresh
    // random value in 1.5-2.1 m every reading - a river jumping +-30 cm
    // every 9 s - which looked like a fast rise and caused false alerts.
    baseLevel: between(1.6, 2.0),
    level: null,
    tiltBase: between(0.2, 0.6),
    event: null, // { type, step, delay }
    // Scripted conditions (tools/demo/run_demo.js): { label, level, rainMmPerHr }.
    // While set, the river sits at `level` (plus sensor noise) and rain falls
    // at that rate - the judge demo needs exact levels on cue, not a random event.
    script: null,
  };
}
for (const node of opts.nodes) state[node] = initialState();

// Hours of rain one reading may cover. Readings normally come every
// interval x nodes seconds; a much longer gap means the simulator itself was
// paused (laptop asleep, debugger), and a flood rate over that gap would
// dump hundreds of mm into one reading.
// But a slow (healthy) backend also stretches the gap: the loop in main()
// skips ticks while a send is running, so one node's readings can come
// several ticks apart. A cap on the NOMINAL gap then silently dropped up to
// half the rain (a flood read ~30-50 mm/h instead of 60-100). Skipped ticks
// still fired, so they count as elapsed time; a pause fires no ticks at all
// (Node does not replay missed setInterval ticks), so it stays capped.
const maxRainGapHr = (s) => (2 * opts.interval * Math.max(opts.nodes.length, clockTicks - s.lastClock)) / 3600;

// What the rain gauge reports for mm that fell since the last reading.
// Reported in 0.001 mm steps (like the old 3-decimal rounding), but the
// remainder is carried to the next reading instead of thrown away: at a
// short interval the drizzle per reading is far below 0.001 mm and rounding
// would silently turn it into no rain at all.
function gaugeReading(s, mm) {
  const total = s.rainCarry + mm;
  const reported = Math.floor(total * 1000 + 1e-9) / 1000;
  s.rainCarry = total - reported;
  return round(reported, 3);
}

let tick = 0;

const isSilent = (node) => node in opts.silent && (Date.now() - startedAt) / 1000 >= opts.silent[node];

function maybeStartEvent() {
  const everyTicks = Math.max(1, Math.round(opts.eventEvery / opts.interval));
  if (tick === 0 || tick % everyTicks !== 0) return;
  const choices = [];
  for (const type of opts.events) {
    for (const node of opts.nodes) {
      if (state[node].event || !NODE_PROFILES[node].includes(EVENTS[type].needs)) continue;
      if (isSilent(node)) continue; // a node that stopped reporting can't show an event
      choices.push([type, node]);
    }
  }
  if (!choices.length) return;
  const [type, node] = pick(choices);
  state[node].event = { type, step: 0, delay: 0 };
  console.log(`\n>>> event: ${type} at ${node}`);
  const downstream = DOWNSTREAM_OF[node];
  if (type === "flood" && downstream && state[downstream] && !state[downstream].event) {
    state[downstream].event = { type: "flood", step: 0, delay: 3 }; // flood wave arrives later
    console.log(`>>> event: flood will reach ${downstream} in ~3 readings`);
  }
}

function makeReading(node, now = Date.now()) {
  const s = state[node];
  const has = (module) => NODE_PROFILES[node].includes(module);
  // Rain is worked out here, when the reading is TAKEN - not when a lora
  // backlog is uploaded - so an outage does not count the same gap twice.
  const dtHr = Math.min(Math.max(0, now - s.lastAt) / 3.6e6, maxRainGapHr(s));
  s.lastAt = now;
  s.lastClock = clockTicks;
  let rainMmPerHr = between(...DRIZZLE_MM_PER_HR);
  s.battery = Math.max(0, s.battery - between(0.02, 0.08));
  if (s.level === null) s.level = s.baseLevel;
  // drift back toward the normal level (a flood recedes), plus slow wander
  s.level += (s.baseLevel - s.level) * 0.05 + between(-0.003, 0.003);

  const r = {
    node_id: node,
    simulated: true,
    river_level_m: round(s.level + between(-0.01, 0.01), 3), // ~1 cm sensor noise
    temp_c: round(between(25, 33), 2),
    humidity_pct: round(between(45, 75), 2),
    gas_ppm: round(between(380, 420), 1),
    flame_reading: round(between(0, 0.05), 3),
    // rainfall_mm_since_last is set after the event code (it is a rate x time)
  };
  // (core values are generated for every node so the event code below
  // stays simple; the ones this node has no sensor for are removed at the end)
  if (has("soil")) r.soil_moisture_pct = s.soil;
  if (has("tilt")) {
    r.tilt_angle_deg = round(s.tiltBase + between(-0.1, 0.1), 2);
    r.vibration_magnitude = round(between(0.01, 0.05), 3);
  }
  if (has("pm")) {
    r.pm25_ugm3 = Math.round(between(25, 55));
    r.pm10_ugm3 = Math.round(between(50, 90));
  }
  if (has("ph")) r.water_ph = round(between(7.0, 7.6), 2);
  if (has("turbidity")) r.turbidity_ntu = round(between(1, 4), 1);
  if (has("battery")) r.battery_pct = round(s.battery, 1);

  let label = "normal";
  const ev = s.event;
  if (ev && ev.delay > 0) {
    ev.delay--;
  } else if (ev) {
    const f = ev.step / Math.max(1, EVENTS[ev.type].readings - 1); // 0 -> 1 over the event
    label = ev.type;
    switch (ev.type) {
      case "flood":
        rainMmPerHr = between(...FLOOD_RAIN_MM_PER_HR);
        s.level = Math.max(s.level, lerp(2.4, 4.0, f)); // the river itself rises (then recedes)
        r.river_level_m = round(s.level + between(-0.01, 0.01), 3);
        if (has("soil")) s.soil = Math.min(95, s.soil + 6);
        break;
      case "gas_leak":
        r.gas_ppm = round(between(900, 1000), 1);
        break;
      case "fire":
        r.flame_reading = 1.0;
        r.temp_c = round(lerp(38, 49, f), 2);
        r.humidity_pct = round(lerp(35, 20, f), 2);
        break;
      case "heat":
        r.temp_c = round(lerp(41, 46.5, f), 2); // IMD heat wave 40 C / severe 45 C
        r.humidity_pct = round(between(20, 35), 2);
        break;
      case "landslide":
        r.tilt_angle_deg = round(s.tiltBase + lerp(2, 14, f), 2);
        r.vibration_magnitude = round(lerp(0.3, 1.5, f), 3);
        break;
      case "air":
        r.pm25_ugm3 = Math.round(lerp(90, 220, f));
        r.pm10_ugm3 = Math.round(lerp(150, 380, f));
        break;
      case "water":
        r.water_ph = round(lerp(6.2, 5.0, f), 2);
        if (has("turbidity")) r.turbidity_ntu = round(lerp(8, 25, f), 1);
        break;
      case "sensor_fault":
        r.river_level_m = 14.2; // implausible single spike
        rainMmPerHr = 0; // no rain to corroborate it
        break;
    }
    ev.step++;
    if (ev.step >= EVENTS[ev.type].readings) s.event = null;
  } else if (s.script) {
    label = s.script.label || "scripted";
    if (s.script.level != null) {
      s.level = s.script.level;
      r.river_level_m = round(s.level + between(-0.01, 0.01), 3);
    }
    if (s.script.rainMmPerHr != null) rainMmPerHr = s.script.rainMmPerHr;
  }
  // Rain SINCE THE PREVIOUS READING - only from a node with a rain gauge.
  // A flood event used to send rain from gauge-less nodes (NODE-INDB), which
  // the backend logged as real rain and fed into its soil proxy (B67).
  r.rainfall_mm_since_last = has("rain") ? gaugeReading(s, rainMmPerHr * dtHr) : 0;
  // soil dries slowly between rain events
  if (has("soil")) {
    s.soil = round(Math.max(20, s.soil - 0.05 + r.rainfall_mm_since_last * 2), 1);
    r.soil_moisture_pct = s.soil;
  }
  // Modular nodes: leave out what this node has no sensor for, like the firmware
  if (!has("water")) delete r.river_level_m;
  if (!has("dht")) { delete r.temp_c; delete r.humidity_pct; }
  if (!has("gas")) delete r.gas_ppm;
  if (!has("flame")) delete r.flame_reading;
  // What the node's on-device model would plausibly say (simulated). The
  // real edge model needs all four core sensors, so only those nodes have one.
  if (["water", "dht", "gas", "flame"].every(has)) {
    r.edge_risk_level = label === "normal" || label === "sensor_fault" ? "NORMAL" : "URGENT";
  }
  return { reading: r, label };
}

// ---------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------
async function postJson(path, body) {
  const res = await fetch(`${opts.server}${path}`, {
    method: "POST",
    // The server refuses readings without a device key (review R1). Use a
    // key of kind "simulator": the server then forces simulated=true on
    // everything this script sends, so it can never pass as real data.
    headers: { "Content-Type": "application/json", "X-Device-Key": opts.key },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* non-JSON error page */ }
  return { status: res.status, data, text };
}

// Same keep-or-drop rule as the firmware (sjUploadAction in sj_packet.h):
// only "this reading is invalid" (400/422) drops readings. 404 (ngrok
// down), 401/403 (key), 429 and 5xx keep them queued for retry.
class RetryLater extends Error {}
function checkUploadStatus(status, text) {
  if (status === 401 || status === 403) {
    throw new RetryLater(`HTTP ${status} - ${keyProblemHint}`);
  }
  if (status !== 200 && status !== 400 && status !== 422) {
    throw new RetryLater(`HTTP ${status}${text ? `: ${text.slice(0, 100)}` : ""}`);
  }
}

// Readings waiting for the uplink (lora mode, or server unreachable).
// Capped like the firmware's flash queue: oldest dropped first.
const MAX_BACKLOG = 2000;
const backlog = []; // { reading, label, takenAt }

function uplinkDown() {
  if (opts.mode !== "lora" || !opts.outage) return false;
  const t = ((Date.now() - startedAt) / 1000) % opts.outageEvery;
  return t >= opts.outageEvery - opts.outage; // outage at the end of every cycle
}

async function sendDirect(item) {
  const { status, data, text } = await postJson("/api/ingest", { ...item.reading, link: "wifi",
    signal_strength_dbm: Math.round(between(-80, -40)),
    age_seconds: Math.round((Date.now() - item.takenAt) / 1000) }); // > 0 if it waited out an outage
  checkUploadStatus(status, text);
  return [status === 200 ? data.ai_action : `dropped as invalid (HTTP ${status}): ${(data && JSON.stringify(data.detail ?? data.error)) || text}`];
}

async function sendBatch(items) {
  const now = Date.now();
  const readings = items.map((it) => ({
    ...it.reading,
    link: "lora",
    signal_strength_dbm: Math.round(between(-118, -95)), // typical LoRa RSSI
    age_seconds: Math.round((now - it.takenAt) / 1000),
  }));
  const { status, data, text } = await postJson("/api/ingest/batch", { readings });
  checkUploadStatus(status, text);
  if (status !== 200) return items.map(() => `dropped as invalid (HTTP ${status}): ${text.slice(0, 120)}`);
  return data.results.map((r) => r.ai_action);
}

async function flushBacklog() {
  while (backlog.length && !uplinkDown()) {
    const batch = backlog.slice(0, opts.mode === "lora" ? 20 : 1);
    let actions;
    try {
      actions = opts.mode === "lora" ? await sendBatch(batch) : await sendDirect(batch[0]);
    } catch (e) {
      console.log(`    uplink failed (${e.cause?.code || e.message}) - ${backlog.length} reading(s) kept for retry`);
      return;
    }
    backlog.splice(0, batch.length);
    batch.forEach((it, i) => {
      const age = Math.round((Date.now() - it.takenAt) / 1000);
      const late = age > 2 * opts.interval ? ` (delivered ${age}s late)` : "";
      console.log(`[${new Date(it.takenAt).toLocaleTimeString()}] ${it.reading.node_id.padEnd(9)} ${it.label.padEnd(12)} -> ${actions[i]}${late}`);
    });
  }
}

// ---------------------------------------------------------------------
let wasDown = false;
async function step() {
  maybeStartEvent();
  const node = opts.nodes[tick % opts.nodes.length];
  tick++;
  if (isSilent(node)) {
    if (!state[node].announcedSilent) {
      console.log(`\n>>> ${node} has gone silent (simulated power/link failure) - watch the officer page's node panel`);
      state[node].announcedSilent = true;
    }
    return;
  }
  const { reading, label } = makeReading(node);
  state[node].seq++;
  reading.reading_uid = `sim${session}-${state[node].seq}`; // makes resends harmless (backend dedups)
  backlog.push({ reading, label, takenAt: Date.now() });
  if (backlog.length > MAX_BACKLOG) backlog.shift();

  const down = uplinkDown();
  if (down && !wasDown) console.log(`\n>>> gateway uplink DOWN for ${opts.outage}s - queueing readings (store-and-forward)`);
  if (!down && wasDown) console.log(`\n>>> gateway uplink back - uploading ${backlog.length} queued reading(s)`);
  wasDown = down;
  if (!down) await flushBacklog();
}

function main() {
  console.log(
    `SANJEEVNI simulator: nodes ${opts.nodes.join(", ")} | mode ${opts.mode}` +
      (opts.outage ? ` | ${opts.outage}s uplink outage every ${opts.outageEvery}s` : "") +
      ` | every ${opts.interval}s | events: ${opts.events.join(", ")}` +
      (opts.seed != null ? ` | seed ${opts.seed}` : ""),
  );
  for (const node of opts.nodes) console.log(`  ${node}: ${NODE_PROFILES[node].join(", ")}`);

  let running = false;
  setInterval(async () => {
    noteClockTick(); // counted even when skipped below: see maxRainGapHr
    if (running) return; // a slow server must not cause overlapping sends
    running = true;
    try {
      await step();
    } finally {
      running = false;
    }
  }, opts.interval * 1000);
}

if (isMain && !scenarioArgs) main();

// For tests (tools/demo/simulation.test.js) and the scripted judge demo
// (tools/demo/run_demo.js): the reading generator and its state.
module.exports = {
  NODE_PROFILES, EVENTS, DRIZZLE_MM_PER_HR, FLOOD_RAIN_MM_PER_HR, DOWNSTREAM_OF, opts, state, session,
  initialState, makeReading, reseed, noteClockTick,
};

if (scenarioArgs) require("../tools/demo/run_demo.js").main(scenarioArgs);
