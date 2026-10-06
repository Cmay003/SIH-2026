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
 *   node simulation.js --skip NODE-04
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
 *   --server http://localhost:3000
 *   --key <device key>          or SANJEEVNI_INGEST_KEY in the environment / .env
 *                               (create: node device_keys.js add simulator --kind simulator)
 *   --seed 42                   repeatable runs
 *   --help
 */

require("dotenv").config({ quiet: true }); // SANJEEVNI_INGEST_KEY from .env

// ---------------------------------------------------------------------
// Which modules each virtual node "has". Edit to match the kit you plan
// to deploy. A hazard event only runs on nodes with the sensor it needs.
// water/dht/gas/flame are required by the backend on every reading.
// ---------------------------------------------------------------------
const NODE_PROFILES = {
  "NODE-04": ["water", "dht", "gas", "flame", "rain", "soil", "ph", "turbidity", "battery"], // riverside
  "NODE-07": ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "battery"], // hillside (upstream of NODE-04)
  "NODE-INDB": ["water", "dht", "gas", "flame", "pm", "battery"], // industrial zone
};
const DOWNSTREAM_OF = { "NODE-07": "NODE-04" }; // a flood upstream reaches this node later

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
  "device key missing/invalid/not allowed. Create one: node device_keys.js add simulator --kind simulator, " +
  "then set SANJEEVNI_INGEST_KEY (env or .env) or pass --key";
const opts = parseArgs(process.argv.slice(2));
if (!opts.key) {
  console.warn(`No device key set - the server will refuse readings.
  ${keyProblemHint}
`);
}

// Seedable PRNG (mulberry32) so a demo run can be repeated exactly.
let rngState = (opts.seed ?? Date.now()) >>> 0;
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
const state = {};
for (const node of opts.nodes) {
  state[node] = {
    seq: 0,
    battery: between(65, 95),
    soil: between(30, 45),
    // River level as a slowly drifting state (B33): it used to be a fresh
    // random value in 1.5-2.1 m every reading - a river jumping +-30 cm
    // every 9 s - which looked like a fast rise and caused false alerts.
    baseLevel: between(1.6, 2.0),
    level: null,
    tiltBase: between(0.2, 0.6),
    event: null, // { type, step, delay }
  };
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

function makeReading(node) {
  const s = state[node];
  const has = (module) => NODE_PROFILES[node].includes(module);
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
    // rain SINCE THE PREVIOUS READING (each node reports every
    // interval x nodes seconds): light drizzle by default
    rainfall_mm_since_last: has("rain") ? round(between(0, 0.01), 3) : 0,
  };
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
        r.rainfall_mm_since_last = round(between(0.15, 0.25), 3); // ~60-100 mm/hr
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
        r.rainfall_mm_since_last = 0;
        break;
    }
    ev.step++;
    if (ev.step >= EVENTS[ev.type].readings) s.event = null;
  }
  // soil dries slowly between rain events
  if (has("soil")) {
    s.soil = round(Math.max(20, s.soil - 0.05 + r.rainfall_mm_since_last * 2), 1);
    r.soil_moisture_pct = s.soil;
  }
  // What the node's on-device model would plausibly say (simulated)
  r.edge_risk_level = label === "normal" || label === "sensor_fault" ? "NORMAL" : "URGENT";
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

console.log(
  `SANJEEVNI simulator: nodes ${opts.nodes.join(", ")} | mode ${opts.mode}` +
    (opts.outage ? ` | ${opts.outage}s uplink outage every ${opts.outageEvery}s` : "") +
    ` | every ${opts.interval}s | events: ${opts.events.join(", ")}` +
    (opts.seed != null ? ` | seed ${opts.seed}` : ""),
);
for (const node of opts.nodes) console.log(`  ${node}: ${NODE_PROFILES[node].join(", ")}`);

let running = false;
setInterval(async () => {
  if (running) return; // a slow server must not cause overlapping sends
  running = true;
  try {
    await step();
  } finally {
    running = false;
  }
}, opts.interval * 1000);
