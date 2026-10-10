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
 *                               flood, flashflood, gas_leak, fire, smoke, heat, landslide,
 *                               air, water, sensor_fault
 *                               flashflood: the river rises fast with little local rain
 *                                 (cloudburst upstream); rising readings carry fast_rise and
 *                                 rise_rate_cm_per_min, as the node computes them
 *                               smoke: PM2.5 and gas rise together, no flame (needs pm + gas)
 *                               sensor_fault: a 14.2 m level spike the node's own anomaly
 *                                 check flags (edge_anomaly: ["spike:river_level_m"])
 *   --event-every 36            seconds between new hazard events
 *   --silent NODE-INDB@120      node stops reporting after 120 s (missing-node alert demo)
 *   --sos-button NODE-07@90     someone holds the node's SOS push-button 90 s after the
 *                               start: that node's next reading carries sos_button: true
 *                               and the server opens an SOS at the node's registered
 *                               position (people with no phone). One press per item;
 *                               comma-separate for more (NODE-07@90,NODE-04@300)
 *   --hotspot-sos NODE-07@120 "2 people on the school roof" [--people 2] [--needs trapped,injured]
 *                               someone sends the offline Wi-Fi SOS page ("SANJEEVNI-SOS")
 *                               of NODE-07 (or of a gateway id) 120 s after the start: posted
 *                               to /api/ingest/sos with this key, kept and retried while the
 *                               uplink is down. --people / --needs belong to the
 *                               --hotspot-sos before them. Needs: trapped injured medical fire.
 *                               Note at most 160 characters. Repeat for more requests.
 *   --kit NODE-07=tilt,rain,battery
 *                               give a node a different sensor kit (modular-node demo;
 *                               repeat for more nodes). Modules: water dht gas flame
 *                               rain soil tilt pm ph turbidity battery, plus siren (an
 *                               output, not a sensor): the node reports siren_fitted and
 *                               obeys siren commands in the server's ingest response
 *                               (siren_on / siren_reason "command" for for_s seconds)
 *   --summary                   smart sending: a node in a NORMAL state sends one summary
 *                               report (min/max/mean of its samples) every
 *                               --summary-samples readings (default 4, and at least every
 *                               60 s); anything elevated, a fast rise, an SOS press, a
 *                               siren change or an anomaly goes out at once
 *   --no-siren-summary-s 300    smart sending per node kind (implies --summary; decision
 *                               2026-10-09): a node WITHOUT a siren sends its routine
 *                               summary once every N seconds (300 = 5 min), by time - the
 *                               --summary-samples count does not apply to it; a node WITH
 *                               a siren keeps the rule above (at least every 60 s - its
 *                               commands only arrive in the reply to a report). Elevated
 *                               (WATCH/URGENT), fast rise, a new anomaly and SOS still go
 *                               out at once. Off by default, so short runs keep their pace.
 *   --edge-lite                 nodes without the full edge model's four sensors (water,
 *                               dht, gas, flame) - a tilt-only slope node, a deep-sleep node
 *                               with no MQ135 - send an edge_risk_level from a
 *                               SIMULATED rule-based stand-in (liteEdgeLevel: the lite
 *                               model's training rule, label_lite()). OFF by default so
 *                               the demo's pacing and confidence figures stay as they
 *                               were (real reduced-kit nodes now run the lite model).
 *                               --no-edge-lite: the default.
 *   --server http://localhost:3000
 *   --key <device key>          or SANJEEVNI_INGEST_KEY in the environment / .env
 *                               (create: node server/device_keys.js add simulator --kind simulator)
 *   --seed 42                   repeatable runs
 *   --scenario judges           the scripted judge demo instead (tools/demo/run_demo.js):
 *                               preflight, 2 h history back-fill, then cued steps
 *                               (pending -> confirmed + confidence -> CRITICAL +
 *                               village siren -> fault -> smoke -> SOS -> node SOS
 *                               button -> offline Wi-Fi SOS -> outage -> heavy rain /
 *                               high wind forecast advisory (--fresh) -> CRITICAL severe
 *                               heat wave with NO siren -> hotspots, trends & reports,
 *                               public CAP feed).
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
const MODULES = ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "pm", "ph", "turbidity", "battery", "siren"];
// rain and battery alone are not a measurement (the backend rejects such a
// reading), and a siren is an output, not a sensor
const MEASURING_MODULES = MODULES.filter((m) => !["rain", "battery", "siren"].includes(m));

// Hazard events last several readings - the backend only makes an alert
// public once a repeat reading or a neighbour confirms it.
// sensor_fault is a single spike: it should be suppressed or stay pending.
// `needs`: the module(s) the event shows on; a node without all of them
// never gets it.
const EVENTS = {
  flood: { needs: "water", readings: 8 },
  flashflood: { needs: "water", readings: 6 },
  gas_leak: { needs: "gas", readings: 5 },
  fire: { needs: "flame", readings: 5 },
  // Smoke is told apart from slow urban pollution by PM2.5 AND gas rising
  // together, so it needs both sensors.
  smoke: { needs: ["pm", "gas"], readings: 6 },
  heat: { needs: "dht", readings: 6 },
  landslide: { needs: "tilt", readings: 6 },
  air: { needs: "pm", readings: 6 },
  water: { needs: "ph", readings: 6 },
  sensor_fault: { needs: "water", readings: 1 },
};
const eventFits = (node, type) => [].concat(EVENTS[type].needs).every((m) => NODE_PROFILES[node].includes(m));

// Flash flood: the river climbs over the first FLASH_RISE_STEPS readings,
// then holds near the crest. The simulator compresses time (a reading every
// few seconds), so a rate worked out from its wall-clock level changes would
// be meaningless - every scripted level jump in the judge demo would look
// like a flash flood. The rising readings instead carry the rate the node
// would compute on a real reporting interval, drawn from this range.
// Configurable demo defaults, not a hydrological standard.
const FLASH_RISE_STEPS = 4;
const FLASH_RISE_CM_PER_MIN = [8, 15];

// Siren (kit option "siren"). The server sends the DESIRED state in the
// ingest response; "on" without for_s means its default of 180 s. The cap
// is the firmware's SIREN_MAX_ON_S (= server/siren.js MAX_ON_SECONDS), so
// a simulated node obeys a long officer "on" the way real hardware does.
const SIREN_DEFAULT_ON_S = 180;
const SIREN_MAX_ON_S = 900;

// Smart sending (--summary): routine samples per summary report, and the
// longest a node may stay quiet - the server's siren commands ride on the
// ingest response, so an always-on node keeps reporting at least this often.
const SUMMARY_SAMPLES_DEFAULT = 4;
const SUMMARY_MAX_GAP_S = 60;
// --no-siren-summary-s: user decision 2026-10-09 - a node WITHOUT a siren
// sends its routine summary every 5 min (nothing needs to reach it quickly),
// a siren node stays at SUMMARY_MAX_GAP_S. The suggested value; the option
// takes any number of seconds.
const NO_SIREN_SUMMARY_S = 300;
const SUMMARY_FIELDS = ["river_level_m", "temp_c", "humidity_pct", "gas_ppm", "pm25_ugm3", "tilt_angle_deg"];
const EDGE_LEVELS = ["NORMAL", "WATCH", "URGENT"];

// Offline Wi-Fi SOS page (--hotspot-sos): the same caps the page enforces.
const HOTSPOT_NEEDS = ["trapped", "injured", "medical", "fire"];
const HOTSPOT_NOTE_MAX = 160;
const HOTSPOT_PEOPLE_MAX = 999; // demo sanity cap, not a contract limit

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
    events: Object.keys(EVENTS), eventEvery: 36, silent: {}, sosButton: [], server: "http://localhost:3000", seed: null,
    key: process.env.SANJEEVNI_INGEST_KEY || "",
    hotspotSos: [], summary: false, summarySamples: SUMMARY_SAMPLES_DEFAULT, noSirenSummaryS: null, edgeLite: false,
  };
  const lastHotspot = (flag) => {
    const item = opts.hotspotSos[opts.hotspotSos.length - 1];
    if (!item) fail(`${flag} belongs to a --hotspot-sos given before it`);
    return item;
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
      case "--sos-button":
        for (const item of list()) {
          const [node, at] = item.split("@");
          // Number("") is 0: "NODE-07@" must not quietly mean "at the start"
          const seconds = at === undefined || at.trim() === "" ? NaN : Number(at);
          if (!node || !(seconds >= 0)) fail(`--sos-button needs NODE@SECONDS (e.g. --sos-button NODE-07@90), got "${item}"`);
          opts.sosButton.push({ node, at: seconds, armed: false });
        }
        i++;
        break;
      case "--hotspot-sos": {
        const [node, at] = String(val ?? "").split("@");
        const seconds = at === undefined || at.trim() === "" ? NaN : Number(at);
        if (!node || !(seconds >= 0)) {
          fail(`--hotspot-sos needs NODE@SECONDS "note" (e.g. --hotspot-sos NODE-07@120 "on the school roof"), got "${val ?? ""}"`);
        }
        // The note is optional (the page allows an empty one), so the next
        // word is only taken when it is not another option.
        const next = argv[i + 2];
        const note = next !== undefined && !next.startsWith("--") ? next : "";
        if (note.length > HOTSPOT_NOTE_MAX) fail(`--hotspot-sos note is ${note.length} characters - at most ${HOTSPOT_NOTE_MAX}`);
        opts.hotspotSos.push({ node, at: seconds, note, people: null, needs: [] });
        i += note || next === "" ? 2 : 1;
        break;
      }
      case "--people": {
        const people = Number(val);
        if (!Number.isInteger(people) || people < 1 || people > HOTSPOT_PEOPLE_MAX) {
          fail(`--people needs a whole number 1-${HOTSPOT_PEOPLE_MAX}, got "${val ?? ""}"`);
        }
        lastHotspot("--people").people = people;
        i++;
        break;
      }
      case "--needs": {
        const needs = [...new Set(list())];
        const unknown = needs.filter((n) => !HOTSPOT_NEEDS.includes(n));
        if (!needs.length || unknown.length) fail(`--needs: choose from ${HOTSPOT_NEEDS.join(",")}, got "${val ?? ""}"`);
        lastHotspot("--needs").needs = needs;
        i++;
        break;
      }
      case "--summary": opts.summary = true; break;
      case "--summary-samples": {
        const n = Number(val);
        if (!Number.isInteger(n) || n < 1) fail(`--summary-samples needs a whole number >= 1, got "${val ?? ""}"`);
        opts.summarySamples = n;
        i++;
        break;
      }
      case "--no-siren-summary-s": {
        const n = Number(val);
        if (!(n > 0) || !Number.isFinite(n)) fail(`--no-siren-summary-s needs seconds > 0 (e.g. ${NO_SIREN_SUMMARY_S}), got "${val ?? ""}"`);
        opts.noSirenSummaryS = n;
        opts.summary = true;
        i++;
        break;
      }
      case "--edge-lite": opts.edgeLite = true; break;
      case "--no-edge-lite": opts.edgeLite = false; break;
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
  // A press on a node this run does not simulate would silently do nothing
  // (and a skipped node is the real hardware - press its real button).
  const unknownSos = opts.sosButton.filter((p) => !opts.nodes.includes(p.node)).map((p) => p.node);
  if (unknownSos.length) fail(`--sos-button: ${unknownSos} is not a simulated node (simulating ${opts.nodes})`);
  // --hotspot-sos may name a gateway id (the gateway runs the hotspot too),
  // so it is not limited to the simulated nodes; the server decides whether
  // the id is registered (an unregistered one lands in the unlocated list).
  opts.hotspotSos.forEach((h, i) => Object.assign(h, { index: i + 1, queuedAt: null, done: false }));
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
    // The SOS push-button was held (--sos-button, or run_demo.js): the next
    // reading carries sos_button: true, then it is cleared - one press, one
    // flagged reading, like the firmware's SJ_SOS_PRESSED flag.
    sosPress: false,
    // Rain (mm) the gauge adds to its next reading only, then 0 - the judge
    // demo's heavy downpour (run_demo.js). The demo compresses time, so a
    // rate would put only ~0.1 mm into a 4 s reading.
    rainBurstMm: 0,
    // Siren (kit "siren"): what the last server command asked for. `until`
    // is when the on-time runs out (ms, same clock as makeReading's `now`).
    siren: { on: false, until: 0, reason: null },
    sirenWasOn: false, // siren_on of the previous sample: a change is reported at once
    // --summary: routine samples not yet sent, and when this node last sent a report
    window: [],
    lastReportAt: null,
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

// --sos-button: arm each press once its time has come; the node's next
// reading carries it. Checked for every node on every tick (not just the
// one reporting now), so the log shows when the button was held.
function armSosPresses(elapsedS = (Date.now() - startedAt) / 1000) {
  for (const press of opts.sosButton) {
    if (press.armed || elapsedS < press.at) continue;
    press.armed = true;
    state[press.node].sosPress = true;
    console.log(isSilent(press.node)
      ? `
>>> SOS button held on ${press.node}, but that node has gone silent (--silent) - the press never arrives`
      : `
>>> SOS button held on ${press.node} - its next reading carries sos_button: true ` +
        "(officer map: an SOS at the node's position)");
  }
}

const isSilent = (node) => node in opts.silent && (Date.now() - startedAt) / 1000 >= opts.silent[node];

function maybeStartEvent() {
  const everyTicks = Math.max(1, Math.round(opts.eventEvery / opts.interval));
  if (tick === 0 || tick % everyTicks !== 0) return;
  const choices = [];
  for (const type of opts.events) {
    for (const node of opts.nodes) {
      if (state[node].event || !eventFits(node, type)) continue;
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
      case "flashflood": {
        // Little LOCAL rain (the background drizzle): the cloudburst is
        // upstream, which is what makes a flash flood dangerous - nothing
        // at the node warns of it before the water arrives.
        const rising = ev.step < FLASH_RISE_STEPS;
        s.level = Math.max(s.level, lerp(2.3, 4.3, Math.min(1, (ev.step + 1) / FLASH_RISE_STEPS)));
        r.river_level_m = round(s.level + between(-0.01, 0.01), 3);
        if (rising) {
          r.fast_rise = true;
          r.rise_rate_cm_per_min = round(between(...FLASH_RISE_CM_PER_MIN), 1);
        }
        break;
      }
      case "smoke":
        // PM and gas climb TOGETHER (combustion), warmer and drier air as
        // support, and no flame in the sensor's view. Gas stays below the
        // backend's 800 ppm gas-leak threshold so this is not a gas leak.
        // PM2.5 tops out below 250 ug/m3 (CPCB's Severe band top, the
        // backend's PM25_BAND_TOPS): above it air pollution rates CRITICAL,
        // smoke is capped at HIGH (SMOKE_MAX_RISK), and the backend ranks
        // severity first - the reading would come back as "air pollution".
        // PM10 likewise stays under its 430 band top.
        r.pm25_ugm3 = Math.round(lerp(80, 230, f));
        r.pm10_ugm3 = Math.round(lerp(130, 400, f));
        r.gas_ppm = round(lerp(480, 720, f), 1);
        r.temp_c = round(r.temp_c + lerp(1, 4, f), 2);
        r.humidity_pct = round(lerp(42, 30, f), 2);
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
        // Plains criteria in backend/hazard_classification.py (IMD, cited
        // there): 40 C MEDIUM, 45 C heat wave (HIGH), 47 C severe (CRITICAL).
        // Ends at 47.5 C so the event still reaches CRITICAL (was 46.5 C,
        // written for the old "45 C = severe" rule; integration 2026-10-09).
        // A CRITICAL heat wave must NOT sound a village siren by itself (user
        // decision 2026-10-09: the automatic siren is for evacuation hazards
        // only - server/siren.js SIREN_AUTO_HAZARDS); this simulator never
        // sounds one on its own, it only obeys server commands.
        r.temp_c = round(lerp(41, 47.5, f), 2);
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
        // The node's own check sees it too: far off its rolling mean
        r.edge_anomaly = ["spike:river_level_m"];
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
    // A scripted flash flood (run_demo.js) states the node's rise rate,
    // for the same time-compression reason as the flashflood event.
    if (s.script.riseCmPerMin != null) {
      r.fast_rise = true;
      r.rise_rate_cm_per_min = round(s.script.riseCmPerMin, 1);
    }
    // A scripted air temperature (the judge demo's severe heat wave): that
    // value plus ~0.1 C sensor noise, in dry air
    if (s.script.tempC != null) {
      r.temp_c = round(s.script.tempC + between(-0.1, 0.1), 2);
      r.humidity_pct = round(between(15, 25), 2);
    }
  }
  // Rain SINCE THE PREVIOUS READING - only from a node with a rain gauge.
  // A flood event used to send rain from gauge-less nodes (NODE-INDB), which
  // the backend logged as real rain and fed into its soil proxy (B67).
  r.rainfall_mm_since_last = has("rain") ? gaugeReading(s, rainMmPerHr * dtHr + s.rainBurstMm) : 0;
  s.rainBurstMm = 0;
  // soil dries slowly between rain events; a sensor never reads over 100 %
  // (a burst of rain used to push it past that)
  if (has("soil")) {
    s.soil = round(Math.min(100, Math.max(20, s.soil - 0.05 + r.rainfall_mm_since_last * 2)), 1);
    r.soil_moisture_pct = s.soil;
  }
  // Only when pressed: the firmware omits the field otherwise (sjAppendJson)
  if (s.sosPress) {
    r.sos_button = true;
    s.sosPress = false;
  }
  // Siren: fitted nodes say so on every reading (the server only commands
  // nodes that report siren_fitted); siren_on/siren_reason only while it
  // sounds, omitted otherwise like the other flags.
  if (has("siren")) {
    r.siren_fitted = true;
    if (s.siren.on && now >= s.siren.until) s.siren.on = false; // on-time ran out
    if (s.siren.on) {
      r.siren_on = true;
      r.siren_reason = s.siren.reason;
    }
  }
  const sirenChanged = !!r.siren_on !== s.sirenWasOn;
  s.sirenWasOn = !!r.siren_on;
  // Modular nodes: leave out what this node has no sensor for, like the firmware
  if (!has("water")) delete r.river_level_m;
  if (!has("dht")) { delete r.temp_c; delete r.humidity_pct; }
  if (!has("gas")) delete r.gas_ppm;
  if (!has("flame")) delete r.flame_reading;
  // What the node's on-device model would plausibly say (simulated). The
  // real edge model needs all four core sensors, so only those nodes have one.
  if (["water", "dht", "gas", "flame"].every(has)) {
    r.edge_risk_level = fullEdgeLevel(r);
  } else if (opts.edgeLite) {
    const level = liteEdgeLevel(r);
    if (level) r.edge_risk_level = level;
  }
  return { reading: r, label, sirenChanged };
}

// ---------------------------------------------------------------------
// SIMULATED STAND-IN for the full edge model's verdict (nodes with water,
// dht, gas and flame). It applies the rule the model is TRAINED on -
// label() in ml/make_edge_dataset.py, on the model's own inputs (river
// level, temperature, gas, flame) - not the model itself. It used to say
// URGENT for every hazard label, also for PM / pH / tilt hazards the model
// cannot see. simulation.test.js checks these numbers against label().
// Heat follows the retrained model (ml lane 2026-10-09, IMD plains):
// WATCH from 45 C (heat wave), URGENT from 47 C (severe heat wave). A heat
// wave is not an evacuation hazard (user decision 2026-10-09); the node's
// OFFLINE siren fallback ignores the edge verdict and acts on water level
// and gas only (firmware sj_siren.h sjSirenLocalUrgent), which this
// simulator does not model.
// A field the node's anomaly check flagged is ignored, as before (the
// 14.2 m fault spike stays NORMAL). The real firmware runs the model on
// the raw value; that difference is not simulated.
const FULL_EDGE = {
  urgent: { river_level_m: 3.5, temp_c: 47, gas_ppm: 800, flame_reading: 0.5 },
  watch: { river_level_m: 2.75, temp_c: 45, gas_ppm: 600 },
};
function fullEdgeLevel(r) {
  const flagged = new Set((r.edge_anomaly || []).map((a) => String(a).split(":").pop()));
  const over = (limits) => Object.entries(limits).some(([field, limit]) =>
    !flagged.has(field) && Number.isFinite(r[field]) && r[field] >= limit);
  if (over(FULL_EDGE.urgent)) return "URGENT";
  if (over(FULL_EDGE.watch)) return "WATCH";
  return "NORMAL";
}

// ---------------------------------------------------------------------
// SIMULATED STAND-IN for the LITE edge model of a node that lacks the
// full edge model's four sensors (a tilt-only slope node, a deep-sleep
// battery node with no MQ135). The real lite model exists since 2026-10-09
// (firmware edge_lite_model_data.h, EDGE_MODEL_AUTO); this applies its
// TRAINING RULE (label_lite() in ml/make_edge_dataset.py), not the network.
// Only with --edge-lite (off by default, so the demo's pacing and the
// backend's confidence figures stay as they were).
// Thresholds (label_lite(), the backend's own values):
//  - river level: URGENT >= 3.5 m (backend FLOOD_CRITICAL_LEVEL_M), WATCH
//    >= 2.75 m (make_edge_dataset.py label())
//  - gas: URGENT >= 800 ppm, WATCH >= 600 ppm; flame: URGENT >= 0.5
//  - tilt: the backend's tilt score (hazard_classification.py
//    classify_landslide: 0.7 x |tilt|/15 deg + 0.3 x vibration/2 g, each
//    capped at 1), URGENT above 0.7 (HIGH), WATCH above 0.4 (MEDIUM)
//  - heat: WATCH from 45 C, URGENT from 47 C (IMD plains heat wave /
//    severe heat wave). Not a siren trigger: the node's offline siren
//    ignores the edge verdict (sj_siren.h).
//  - no PM input (the lite model has none; PM "send now" is the node's own
//    LOCAL_PM limits) and no rise-rate input (not simulated here).
// A field the node's anomaly check flagged (edge_anomaly "spike:<field>")
// is ignored, as the full model's verdict is for the 14.2 m fault spike.
// Returns null for a node with none of these sensors (pH / turbidity /
// soil only): it has no edge check to report.
const LITE_EDGE = {
  levelUrgentM: 3.5, levelWatchM: 2.75, gasUrgentPpm: 800, gasWatchPpm: 600, flame: 0.5,
  tiltUrgent: 0.7, tiltWatch: 0.4, heatWatchC: 45, heatUrgentC: 47,
};
function liteEdgeLevel(r) {
  const flagged = new Set((r.edge_anomaly || []).map((a) => String(a).split(":").pop()));
  const val = (field) => (flagged.has(field) || !Number.isFinite(r[field]) ? null : r[field]);
  const level = val("river_level_m");
  const gas = val("gas_ppm");
  const flame = val("flame_reading");
  const tilt = val("tilt_angle_deg");
  const temp = val("temp_c");
  if ([level, gas, flame, tilt, temp].every((v) => v === null)) return null;
  const tiltScore = tilt === null ? null
    : 0.7 * Math.min(1, Math.abs(tilt) / 15) + 0.3 * Math.min(1, (val("vibration_magnitude") || 0) / 2);
  const L = LITE_EDGE;
  if ((level !== null && level >= L.levelUrgentM) || (gas !== null && gas >= L.gasUrgentPpm) ||
      (flame !== null && flame >= L.flame) || (tiltScore !== null && tiltScore > L.tiltUrgent) ||
      (temp !== null && temp >= L.heatUrgentC)) return "URGENT";
  if ((level !== null && level >= L.levelWatchM) || (gas !== null && gas >= L.gasWatchPpm) ||
      (tiltScore !== null && tiltScore > L.tiltWatch) || (temp !== null && temp >= L.heatWatchC)) return "WATCH";
  return "NORMAL";
}

// ---------------------------------------------------------------------
// Siren commands (desired state, in the ingest response's "commands")
// ---------------------------------------------------------------------
// The server repeats a command until the node reports the matching
// siren_on, so applying one twice is harmless. Commands for a node this run
// does not simulate, or one without a siren, are ignored (logged).
// `log`: run_demo.js prints these lines in its own format.
function applySirenCommands(commands, now = Date.now(), log = console.log) {
  if (!Array.isArray(commands)) return;
  for (const cmd of commands) {
    if (!cmd || typeof cmd.node_id !== "string" || !["on", "off"].includes(cmd.siren)) continue;
    const s = state[cmd.node_id];
    if (!s || !NODE_PROFILES[cmd.node_id]?.includes("siren")) {
      log(`    siren command for ${cmd.node_id} ignored - not a simulated node with a siren`);
      continue;
    }
    if (cmd.siren === "off") {
      if (s.siren.on) log(`\n>>> siren OFF at ${cmd.node_id} (server command)`);
      s.siren = { on: false, until: 0, reason: null };
      continue;
    }
    const asked = Number(cmd.for_s);
    const forS = Math.min(SIREN_MAX_ON_S, asked > 0 ? asked : SIREN_DEFAULT_ON_S);
    if (!s.siren.on) log(`\n>>> siren ON at ${cmd.node_id} for ${forS}s (server command)`);
    s.siren = { on: true, until: now + forS * 1000, reason: "command" };
  }
}

// ---------------------------------------------------------------------
// Smart sending (--summary)
// ---------------------------------------------------------------------
// Routine = nothing the server should hear about at once.
function isRoutine(reading, label, sirenChanged) {
  return label === "normal" && !sirenChanged && !reading.sos_button && !reading.fast_rise &&
    !reading.edge_anomaly && (reading.edge_risk_level ?? "NORMAL") === "NORMAL";
}

// The longest a node stays quiet in a NORMAL state, and whether its
// routine reports go by time only. A siren node: SUMMARY_MAX_GAP_S (its
// commands ride on the replies). A node without one: --no-siren-summary-s
// when given (decision 2026-10-09: 5 min), else the same as a siren node.
function summaryGap(node) {
  const siren = (NODE_PROFILES[node] || []).includes("siren");
  if (!siren && opts.noSirenSummaryS != null) return { gapS: opts.noSirenSummaryS, byTime: true };
  return { gapS: SUMMARY_MAX_GAP_S, byTime: false };
}

// One report for a window of routine samples ({ reading, takenAt }, oldest
// first). The top-level values are the LATEST sample, so the backend's
// pipeline works unchanged; rain is the SUM over the window (it is "rain
// since the previous report" - the latest sample alone would lose the rest).
// window_s runs from the node's previous report (or its first sample).
function summarizeWindow(samples, previousReportAt = null) {
  const latest = samples[samples.length - 1];
  const out = { ...latest.reading };
  out.rainfall_mm_since_last = round(samples.reduce((a, x) => a + (x.reading.rainfall_mm_since_last || 0), 0), 3);
  const from = previousReportAt ?? samples[0].takenAt;
  const summary = { samples: samples.length, window_s: Math.max(0, Math.round((latest.takenAt - from) / 1000)) };
  const edges = samples.map((x) => x.reading.edge_risk_level).filter((e) => EDGE_LEVELS.includes(e));
  // Only nodes with an edge model have a verdict to summarise
  if (edges.length) summary.max_edge_risk_level = edges.reduce((a, b) => (EDGE_LEVELS.indexOf(b) > EDGE_LEVELS.indexOf(a) ? b : a));
  for (const field of SUMMARY_FIELDS) {
    const vals = samples.map((x) => x.reading[field]).filter(Number.isFinite);
    if (!vals.length) continue;
    summary[field] = {
      min: Math.min(...vals),
      max: Math.max(...vals),
      mean: round(vals.reduce((a, b) => a + b, 0) / vals.length, 3),
    };
  }
  out.summary = summary;
  return out;
}

// What a node sends for one new sample: [] while a routine window fills,
// otherwise the report(s) to queue, oldest first. An urgent sample flushes
// the pending window as a summary BEFORE itself, so nothing is lost. (The
// lora backlog may then upload the urgent one first - nextBatch - but both
// carry age_seconds and the backend processes a batch in reading-time order.)
function nodeReports(node, sample, now = Date.now()) {
  const s = state[node];
  const reports = [];
  const flushWindow = () => {
    if (!s.window.length) return;
    const latest = s.window[s.window.length - 1];
    reports.push({ reading: summarizeWindow(s.window, s.lastReportAt), label: `summary(${s.window.length})`, takenAt: latest.takenAt });
    s.lastReportAt = latest.takenAt;
    s.window = [];
  };
  if (!opts.summary) {
    reports.push({ reading: sample.reading, label: sample.label, takenAt: now });
  } else if (isRoutine(sample.reading, sample.label, sample.sirenChanged)) {
    s.window.push({ reading: sample.reading, takenAt: now });
    const since = s.lastReportAt ?? s.window[0].takenAt;
    const { gapS, byTime } = summaryGap(node);
    // The first sample goes out on its own (nothing to wait for yet); after
    // that every --summary-samples (not for a node summarised by time), and
    // never more than its gap apart.
    if (s.lastReportAt == null || (!byTime && s.window.length >= opts.summarySamples) || now - since >= gapS * 1000) flushWindow();
  } else {
    flushWindow();
    reports.push({ reading: sample.reading, label: sample.label, takenAt: now });
  }
  if (reports.length) s.lastReportAt = reports[reports.length - 1].takenAt;
  return reports;
}

// ---------------------------------------------------------------------
// Offline Wi-Fi SOS (--hotspot-sos)
// ---------------------------------------------------------------------
// The body the gateway forwards to /api/ingest/sos. sos_uid is unique per
// request (the server dedups a retry by node + sos_uid); client_id stands
// in for the phone's short id. Location: none typed - the server uses the
// node's registered position.
// simulated: true like every reading (makeReading): the server only forces
// it for a key of kind "simulator", and --key / SANJEEVNI_INGEST_KEY take
// any device key - without the flag this would be filed as a REAL
// emergency at the node. The note says so too, for a server that ignores
// the flag; the note cap still holds (the server cuts at the same length).
const HOTSPOT_SIM_TAG = "[SIMULATED] ";
function hotspotSosPayload(item, now = Date.now()) {
  return {
    node_id: item.node,
    sos_uid: `hs${session}-${item.index}`,
    client_id: `sim${session.slice(0, 4)}${item.index}`,
    people: item.people ?? null,
    needs: [...item.needs],
    note: `${HOTSPOT_SIM_TAG}${item.note}`.slice(0, HOTSPOT_NOTE_MAX),
    latitude: null,
    longitude: null,
    age_seconds: item.queuedAt == null ? 0 : Math.max(0, Math.round((now - item.queuedAt) / 1000)),
    simulated: true,
  };
}

// Queue each request once its time has come (like armSosPresses).
function queueHotspotSos(elapsedS = (Date.now() - startedAt) / 1000, now = Date.now()) {
  for (const item of opts.hotspotSos) {
    if (item.queuedAt != null || elapsedS < item.at) continue;
    item.queuedAt = now;
    console.log(`\n>>> Wi-Fi SOS sent from the SANJEEVNI-SOS page of ${item.node}: "${item.note}"` +
      (item.people ? `, ${item.people} people` : "") + (item.needs.length ? `, needs ${item.needs.join("+")}` : ""));
  }
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
  // Before the status check: server.js puts siren commands on its error
  // answers too (withSirenCommands), so an officer's or the auto rule's
  // command still reaches the node while the AI backend is down. The
  // readings themselves still follow the keep-or-drop rule below.
  applySirenCommands(data?.commands);
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
  // The gateway passes these on in each node's next ACK window - from an
  // error answer too (see sendDirect)
  applySirenCommands(data?.commands);
  checkUploadStatus(status, text);
  if (status !== 200) return items.map(() => `dropped as invalid (HTTP ${status}): ${text.slice(0, 120)}`);
  return data.results.map((r) => r.ai_action);
}

// What must not wait behind an outage's backlog (like the firmware's
// queue): an SOS press, a fast rise, an elevated edge verdict, a node
// anomaly or a siren reading. Their age_seconds keeps their real time.
const isPriority = (r) => !!(r.sos_button || r.fast_rise || r.edge_anomaly || r.siren_on ||
  (r.edge_risk_level && r.edge_risk_level !== "NORMAL"));

// The next upload: in lora mode up to 20, priority readings first and
// then the oldest; direct mode sends the oldest one.
function nextBatch() {
  if (opts.mode !== "lora") return backlog.slice(0, 1);
  const urgent = backlog.filter((it) => isPriority(it.reading));
  return [...urgent, ...backlog.filter((it) => !isPriority(it.reading))].slice(0, 20);
}

async function flushBacklog() {
  while (backlog.length && !uplinkDown()) {
    const batch = nextBatch();
    let actions;
    try {
      actions = opts.mode === "lora" ? await sendBatch(batch) : await sendDirect(batch[0]);
    } catch (e) {
      console.log(`    uplink failed (${e.cause?.code || e.message}) - ${backlog.length} reading(s) kept for retry`);
      return;
    }
    for (const it of batch) backlog.splice(backlog.indexOf(it), 1);
    batch.forEach((it, i) => {
      const age = Math.round((Date.now() - it.takenAt) / 1000);
      const late = age > 2 * opts.interval ? ` (delivered ${age}s late)` : "";
      const r = it.reading;
      const flags = [
        r.sos_button && "SOS button",
        r.fast_rise && `fast rise ${r.rise_rate_cm_per_min} cm/min`,
        r.edge_anomaly && `anomaly ${r.edge_anomaly.join(",")}`,
        r.siren_on && "siren on",
      ].filter(Boolean);
      console.log(`[${new Date(it.takenAt).toLocaleTimeString()}] ${r.node_id.padEnd(9)} ${it.label.padEnd(12)} -> ${actions[i]}${late}` +
        (flags.length ? `  [${flags.join("; ")}]` : ""));
    });
  }
}

// Wi-Fi SOS requests waiting for the uplink: kept and retried like the
// gateway's stored SOS until the server answers. 400/422 = the server
// refused the request itself, so retrying would never succeed.
async function flushHotspotSos() {
  for (const item of opts.hotspotSos) {
    if (item.queuedAt == null || item.done || uplinkDown()) continue;
    let res;
    try {
      res = await postJson("/api/ingest/sos", hotspotSosPayload(item));
      checkUploadStatus(res.status, res.text);
    } catch (e) {
      console.log(`    Wi-Fi SOS from ${item.node}: uplink failed (${e.cause?.code || e.message}) - kept for retry`);
      return;
    }
    item.done = true;
    console.log(res.status === 200
      ? `    Wi-Fi SOS from ${item.node} -> ${res.data?.status ?? "ok"}${res.data?.sos_id != null ? ` (SOS #${res.data.sos_id})` : ""}`
      : `    Wi-Fi SOS from ${item.node} refused (HTTP ${res.status}): ${res.text.slice(0, 120)}`);
  }
}

// ---------------------------------------------------------------------
let wasDown = false;
async function step() {
  maybeStartEvent();
  armSosPresses();
  queueHotspotSos();
  const node = opts.nodes[tick % opts.nodes.length];
  tick++;
  if (isSilent(node)) {
    if (!state[node].announcedSilent) {
      console.log(`\n>>> ${node} has gone silent (simulated power/link failure) - watch the officer page's node panel`);
      state[node].announcedSilent = true;
    }
  } else {
    const now = Date.now();
    // --summary: a routine sample may only join the node's window (no report yet)
    for (const report of nodeReports(node, makeReading(node, now), now)) {
      state[node].seq++;
      report.reading.reading_uid = `sim${session}-${state[node].seq}`; // makes resends harmless (backend dedups)
      backlog.push(report);
      if (backlog.length > MAX_BACKLOG) backlog.shift();
    }
  }

  const down = uplinkDown();
  if (down && !wasDown) console.log(`\n>>> gateway uplink DOWN for ${opts.outage}s - queueing readings (store-and-forward)`);
  if (!down && wasDown) console.log(`\n>>> gateway uplink back - uploading ${backlog.length} queued reading(s)`);
  wasDown = down;
  if (!down) {
    await flushHotspotSos(); // an SOS goes before the reading backlog
    await flushBacklog();
  }
}

function main() {
  console.log(
    `SANJEEVNI simulator: nodes ${opts.nodes.join(", ")} | mode ${opts.mode}` +
      (opts.outage ? ` | ${opts.outage}s uplink outage every ${opts.outageEvery}s` : "") +
      ` | every ${opts.interval}s | events: ${opts.events.join(", ")}` +
      (opts.seed != null ? ` | seed ${opts.seed}` : "") +
      (opts.sosButton.length ? ` | SOS button: ${opts.sosButton.map((p) => `${p.node} at ${p.at}s`).join(", ")}` : "") +
      (opts.hotspotSos.length ? ` | Wi-Fi SOS: ${opts.hotspotSos.map((h) => `${h.node} at ${h.at}s`).join(", ")}` : "") +
      (opts.summary ? ` | summary mode (${opts.summarySamples} samples / report, at least every ${SUMMARY_MAX_GAP_S}s` +
        (opts.noSirenSummaryS != null ? `; nodes without a siren: one summary every ${opts.noSirenSummaryS}s` : "") + ")" : ""),
  );
  for (const node of opts.nodes) {
    const kit = NODE_PROFILES[node];
    const full = ["water", "dht", "gas", "flame"].every((m) => kit.includes(m));
    const edge = full ? "edge model (simulated verdict)"
      : opts.edgeLite ? "lite edge check (SIMULATED rule-based stand-in for the lite model's training rule)"
        : "no edge verdict";
    const gap = opts.summary ? `, routine summary ${summaryGap(node).byTime ? "every" : "at least every"} ${summaryGap(node).gapS}s` : "";
    console.log(`  ${node}: ${kit.join(", ")} - ${edge}${gap}`);
  }

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
  FLASH_RISE_CM_PER_MIN, SIREN_DEFAULT_ON_S, SIREN_MAX_ON_S, SUMMARY_MAX_GAP_S, NO_SIREN_SUMMARY_S, HOTSPOT_NOTE_MAX,
  LITE_EDGE, FULL_EDGE, fullEdgeLevel, initialState, makeReading, reseed, noteClockTick, parseArgs, armSosPresses,
  applySirenCommands, summarizeWindow, summaryGap, liteEdgeLevel, nodeReports, isPriority, hotspotSosPayload, queueHotspotSos,
  // transport (tests drive these against a stub server)
  backlog, nextBatch, flushBacklog, flushHotspotSos, sendBatch, sendDirect,
};

if (scenarioArgs) require("../tools/demo/run_demo.js").main(scenarioArgs);
