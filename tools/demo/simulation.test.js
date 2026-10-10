// Tests for the sensor simulator's reading generator (server/simulation.js).
// Run: node --test tools/demo/simulation.test.js
//
// Requiring the simulator does not start it (no server needed): it only
// builds readings, so these tests drive makeReading() with explicit
// timestamps instead of waiting on real time.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");

const sim = require(path.join(__dirname, "..", "..", "server", "simulation.js"));

const T0 = Date.UTC(2026, 9, 1, 0, 0, 0);
const HOUR_MS = 3600 * 1000;
const GAUGE_STEP = 0.001; // reporting resolution (mm)

// One virtual node, with the run's interval/node count set like the CLI would.
function setup({ node = "NODE-04", nodes = 3, interval = 3, kit } = {}) {
  sim.opts.interval = interval;
  sim.opts.nodes = Array.from({ length: nodes }, (_, i) => (i === 0 ? node : `PAD-${i}`));
  if (kit) sim.NODE_PROFILES[node] = kit;
  sim.state[node] = sim.initialState(T0);
  return interval * nodes * 1000; // ms between this node's readings
}

// Rain from `count` readings, one per period, starting one period after T0.
function rainSeries(node, periodMs, count) {
  const out = [];
  for (let i = 1; i <= count; i++) {
    const { reading } = sim.makeReading(node, T0 + i * periodMs);
    out.push(reading.rainfall_mm_since_last);
  }
  return out;
}
const sum = (xs) => xs.reduce((a, b) => a + b, 0);

test("drizzle is a rate per hour: a day of drizzle stays light for any interval / node count (B66)", () => {
  const maxPerDay = sim.DRIZZLE_MM_PER_HR[1] * 24; // 9.6 mm
  // [nodes, interval s]: default run, single-node run, single node at 1 s.
  // Before the fix these gave ~48, ~144 and ~432 mm/day of "drizzle".
  for (const [nodes, interval] of [[3, 3], [1, 3], [1, 1]]) {
    const periodMs = setup({ nodes, interval });
    const perDay = Math.round((24 * HOUR_MS) / periodMs);
    const rain = rainSeries("NODE-04", periodMs, perDay);
    const total = sum(rain);
    assert.ok(total <= maxPerDay + GAUGE_STEP, `${nodes} node(s) @ ${interval}s: ${total} mm/day`);
    // The carried remainder keeps short-interval drizzle from rounding to
    // nothing: mean rate 0.2 mm/h -> ~4.8 mm/day.
    assert.ok(total > 2, `${nodes} node(s) @ ${interval}s: drizzle lost to rounding (${total} mm/day)`);
    // ... and the backend's 1-hour intensity never looks like real rain
    const perHour = Math.round(HOUR_MS / periodMs);
    for (let h = 0; h + perHour <= rain.length; h += perHour) {
      const hour = sum(rain.slice(h, h + perHour));
      assert.ok(hour <= sim.DRIZZLE_MM_PER_HR[1] + GAUGE_STEP, `hour ${h / perHour}: ${hour} mm`);
    }
  }
});

test("flood rain matches 60-100 mm/h at any interval", () => {
  for (const [nodes, interval] of [[3, 3], [1, 1]]) {
    const periodMs = setup({ nodes, interval });
    const s = sim.state["NODE-04"];
    const n = sim.EVENTS.flood.readings;
    s.event = { type: "flood", step: 0, delay: 0 };
    const rain = rainSeries("NODE-04", periodMs, n);
    const mmPerHr = sum(rain) / ((n * periodMs) / HOUR_MS);
    const [lo, hi] = sim.FLOOD_RAIN_MM_PER_HR;
    // +- one gauge step of carry over the whole event
    const slack = GAUGE_STEP / ((n * periodMs) / HOUR_MS);
    assert.ok(mmPerHr >= lo - slack && mmPerHr <= hi + slack, `${nodes}@${interval}s: ${mmPerHr} mm/h`);
    // the default run keeps its old per-reading amount (~0.15-0.25 mm)
    if (nodes === 3) rain.forEach((mm) => assert.ok(mm >= 0.149 && mm <= 0.251, `${mm} mm`));
  }
});

test("flood events send no rain from a node without a rain gauge (B67)", () => {
  for (const [node, kit] of [["NODE-INDB", undefined], ["NODE-07", ["water", "battery"]]]) {
    const periodMs = setup({ node, kit });
    assert.ok(!sim.NODE_PROFILES[node].includes("rain"));
    sim.state[node].event = { type: "flood", step: 0, delay: 0 };
    const levels = [];
    for (let i = 1; i <= sim.EVENTS.flood.readings; i++) {
      const { reading, label } = sim.makeReading(node, T0 + i * periodMs);
      assert.equal(label, "flood");
      assert.equal(reading.rainfall_mm_since_last, 0, `${node} reported rain`);
      levels.push(reading.river_level_m);
    }
    assert.ok(Math.max(...levels) >= 2.4, "the river still rises during the event");
  }
  sim.NODE_PROFILES["NODE-07"] = ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "battery"];
});

test("a sensor-fault spike carries no rain", () => {
  const periodMs = setup();
  sim.state["NODE-04"].event = { type: "sensor_fault", step: 0, delay: 0 };
  const { reading, label } = sim.makeReading("NODE-04", T0 + periodMs);
  assert.equal(label, "sensor_fault");
  assert.equal(reading.rainfall_mm_since_last, 0);
});

test("rain is counted once per elapsed time, at reading time", () => {
  const periodMs = setup();
  rainSeries("NODE-04", periodMs, 1);
  // A second reading at the same instant (no time has passed) adds no rain:
  // a reading queued in a lora backlog already holds its own share.
  const { reading } = sim.makeReading("NODE-04", T0 + periodMs);
  assert.equal(reading.rainfall_mm_since_last, 0);
  // A clock that steps backwards adds none either.
  assert.equal(sim.makeReading("NODE-04", T0).reading.rainfall_mm_since_last, 0);
});

test("a paused simulator does not dump hours of flood rain into one reading", () => {
  const periodMs = setup(); // 9 s per node, so at most 18 s of rain per reading
  sim.state["NODE-04"].event = { type: "flood", step: 0, delay: 0 };
  const { reading } = sim.makeReading("NODE-04", T0 + 2 * HOUR_MS);
  const maxMm = (sim.FLOOD_RAIN_MM_PER_HR[1] * 2 * periodMs) / HOUR_MS;
  assert.ok(reading.rainfall_mm_since_last <= maxMm + GAUGE_STEP, `${reading.rainfall_mm_since_last} mm`);
});

test("a slow backend (skipped loop ticks) does not lose flood rain", () => {
  // One node at 1 s, but each send takes ~2.5 s: the loop's `running` guard
  // skips ticks, so readings come 2.5 s apart against a nominal 1 s period.
  // The cap used to be 2 s (2 x interval x nodes) and dropped ~20-50 % of the
  // rain. The ticks that fired meanwhile are noted, as main() does.
  setup({ nodes: 1, interval: 1 });
  sim.state["NODE-04"].event = { type: "flood", step: 0, delay: 0 };
  const n = sim.EVENTS.flood.readings;
  const gapMs = 2500;
  const rain = [];
  for (let i = 1; i <= n; i++) {
    for (let k = 0; k < (i % 2 ? 2 : 3); k++) sim.noteClockTick(); // 2 or 3 ticks per 2.5 s
    rain.push(sim.makeReading("NODE-04", T0 + i * gapMs).reading.rainfall_mm_since_last);
  }
  const hours = (n * gapMs) / HOUR_MS;
  const mmPerHr = sum(rain) / hours;
  const [lo, hi] = sim.FLOOD_RAIN_MM_PER_HR;
  const slack = GAUGE_STEP / hours;
  assert.ok(mmPerHr >= lo - slack && mmPerHr <= hi + slack, `${mmPerHr} mm/h`);

  // A real pause (laptop asleep) fires no ticks in between: still capped
  // at 2 x interval x nodes worth of rain.
  setup({ nodes: 1, interval: 1 });
  sim.state["NODE-04"].event = { type: "flood", step: 0, delay: 0 };
  sim.noteClockTick(); // the one tick that fires on resume
  const { reading } = sim.makeReading("NODE-04", T0 + 600 * 1000);
  const maxMm = (hi * 2 * 1000) / HOUR_MS;
  assert.ok(reading.rainfall_mm_since_last <= maxMm + GAUGE_STEP, `${reading.rainfall_mm_since_last} mm after a 600 s pause`);
});

test("scripted conditions (judge demo): exact river level, set rain rate, label", () => {
  const periodMs = setup();
  const s = sim.state["NODE-04"];
  s.script = { label: "flood", level: 3.4, rainMmPerHr: 80 };
  const { reading, label } = sim.makeReading("NODE-04", T0 + periodMs);
  assert.equal(label, "flood");
  assert.ok(Math.abs(reading.river_level_m - 3.4) <= 0.0101, `${reading.river_level_m} m`); // +-1 cm sensor noise
  const expected = (80 * periodMs) / HOUR_MS;
  assert.ok(Math.abs(reading.rainfall_mm_since_last - expected) <= GAUGE_STEP, `${reading.rainfall_mm_since_last} mm`);
  // the full edge model's training rule: 2.75 m WATCH, 3.5 m URGENT (ml/make_edge_dataset.py)
  assert.equal(reading.edge_risk_level, "WATCH");
  assert.equal(reading.simulated, true);
  s.script = { label: "flood", level: 3.6, rainMmPerHr: 80 };
  assert.equal(sim.makeReading("NODE-04", T0 + 1.5 * periodMs).reading.edge_risk_level, "URGENT");
  // level null: the river keeps drifting near its base level, only the rain is scripted
  s.script = { label: "normal", level: null, rainMmPerHr: 10 };
  s.level = null; // back at the base level (a river just down from 3.6 m still reads high - and the model says so)
  const calm = sim.makeReading("NODE-04", T0 + 2 * periodMs);
  assert.equal(calm.label, "normal");
  assert.equal(calm.reading.edge_risk_level, "NORMAL");
  // a running event wins over the script (the fault spike in the demo)
  s.event = { type: "sensor_fault", step: 0, delay: 0 };
  assert.equal(sim.makeReading("NODE-04", T0 + 3 * periodMs).reading.river_level_m, 14.2);
  s.script = null;
});

test("SOS button: one press flags exactly one reading; the field is absent otherwise", () => {
  const periodMs = setup({ node: "NODE-07" });
  const s = sim.state["NODE-07"];
  assert.equal(s.sosPress, false);
  const plain = sim.makeReading("NODE-07", T0 + periodMs).reading;
  assert.ok(!("sos_button" in plain), "omitted when not pressed, like the firmware");
  s.sosPress = true;
  const pressed = sim.makeReading("NODE-07", T0 + 2 * periodMs).reading;
  assert.equal(pressed.sos_button, true);
  assert.equal(pressed.simulated, true);
  assert.ok(pressed.river_level_m != null, "still a normal sensor reading");
  assert.equal(s.sosPress, false);
  assert.ok(!("sos_button" in sim.makeReading("NODE-07", T0 + 3 * periodMs).reading), "one press, one flagged reading");
});

test("--sos-button NODE@SECONDS: parsed, and armed once its time has come", () => {
  const o = sim.parseArgs(["--sos-button", "NODE-07@90,NODE-04@0"]);
  assert.deepEqual(o.sosButton, [{ node: "NODE-07", at: 90, armed: false }, { node: "NODE-04", at: 0, armed: false }]);

  const saved = sim.opts.sosButton;
  sim.opts.sosButton = o.sosButton;
  const log = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    for (const node of ["NODE-04", "NODE-07"]) sim.state[node] = sim.initialState(T0);
    sim.armSosPresses(10);
    assert.equal(sim.state["NODE-04"].sosPress, true);
    assert.equal(sim.state["NODE-07"].sosPress, false, "not before 90 s");
    sim.state["NODE-04"].sosPress = false; // its reading went out
    sim.armSosPresses(95);
    assert.equal(sim.state["NODE-07"].sosPress, true);
    assert.equal(sim.state["NODE-04"].sosPress, false, "a press is armed once, not on every tick");
    assert.ok(lines.some((l) => /SOS button held on NODE-07/.test(l)), lines.join("\n"));
  } finally {
    console.log = log;
    sim.opts.sosButton = saved;
    sim.state["NODE-07"].sosPress = false;
  }
});

test("--sos-button refuses what would silently do nothing, and is in --help", () => {
  const { spawnSync } = require("child_process");
  const script = path.join(__dirname, "..", "..", "server", "simulation.js");
  const run = (...args) => spawnSync(process.execPath, [script, "--key", "x", ...args], { encoding: "utf8", timeout: 10000 });
  for (const [args, message] of [
    [["--sos-button", "NODE-07"], /needs NODE@SECONDS/],
    [["--sos-button", "NODE-07@"], /needs NODE@SECONDS/],
    [["--sos-button", "NODE-07@-5"], /needs NODE@SECONDS/],
    [["--sos-button", "NODE-99@30"], /NODE-99 is not a simulated node/],
    [["--skip", "NODE-07", "--sos-button", "NODE-07@30"], /NODE-07 is not a simulated node/],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, message);
  }
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--sos-button NODE-07@90/);
});

test("reseed makes the generator repeat itself", () => {
  const series = () => {
    sim.reseed(42);
    const periodMs = setup();
    return [1, 2, 3].map((i) => sim.makeReading("NODE-04", T0 + i * periodMs).reading);
  };
  assert.deepEqual(series(), series());
});

test("--scenario hands the command line to the judge demo", () => {
  const { spawnSync } = require("child_process");
  const script = path.join(__dirname, "..", "..", "server", "simulation.js");
  const help = spawnSync(process.execPath, [script, "--scenario", "judges", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /scripted judge demo/);
  const bad = spawnSync(process.execPath, [script, "--scenario", "storm"], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /only scenario is 'judges'/);
});

// ---------------------------------------------------------------------
// Siren, flash flood, smoke, edge anomaly, smart sending, Wi-Fi SOS
// ---------------------------------------------------------------------
const HILLSIDE_KIT = ["water", "dht", "gas", "flame", "rain", "soil", "tilt", "battery"];

test("flashflood: rising readings carry fast_rise + the node's rate; the crest and other events do not", () => {
  const periodMs = setup();
  sim.state["NODE-04"].event = { type: "flashflood", step: 0, delay: 0 };
  const readings = [];
  for (let i = 1; i <= sim.EVENTS.flashflood.readings; i++) {
    const { reading, label } = sim.makeReading("NODE-04", T0 + i * periodMs);
    assert.equal(label, "flashflood");
    readings.push(reading);
  }
  const flagged = readings.filter((r) => r.fast_rise);
  assert.equal(flagged.length, 4, "the rising part only");
  const [lo, hi] = sim.FLASH_RISE_CM_PER_MIN;
  for (const r of flagged) assert.ok(r.rise_rate_cm_per_min >= lo && r.rise_rate_cm_per_min <= hi, `${r.rise_rate_cm_per_min}`);
  for (const r of readings.slice(4)) assert.ok(!("fast_rise" in r) && !("rise_rate_cm_per_min" in r), "omitted when false");
  const levels = readings.map((r) => r.river_level_m);
  for (let i = 1; i < 4; i++) assert.ok(levels[i] > levels[i - 1] + 0.3, `rises fast: ${levels}`);
  assert.ok(Math.max(...levels) >= 4.2, `${levels}`);
  // little LOCAL rain: no more than the background drizzle
  const rain = sum(readings.map((r) => r.rainfall_mm_since_last));
  assert.ok(rain <= (sim.DRIZZLE_MM_PER_HR[1] * readings.length * periodMs) / HOUR_MS + GAUGE_STEP, `${rain} mm`);
  // the full model's rule on the level: WATCH at the first rising reading (~2.8 m), URGENT from 3.5 m
  assert.equal(readings[0].edge_risk_level, "WATCH");
  assert.ok(readings.every((r) => r.edge_risk_level === (r.river_level_m >= 3.5 ? "URGENT" : r.river_level_m >= 2.75 ? "WATCH" : "NORMAL")));
  assert.ok(readings.some((r) => r.edge_risk_level === "URGENT"));

  // the ordinary flood event and a calm river never claim a fast rise
  setup();
  sim.state["NODE-04"].event = { type: "flood", step: 0, delay: 0 };
  for (let i = 1; i <= sim.EVENTS.flood.readings + 2; i++) {
    assert.ok(!("fast_rise" in sim.makeReading("NODE-04", T0 + i * periodMs).reading));
  }
});

test("a scripted rise rate (judge demo) flags the reading as a fast rise", () => {
  const periodMs = setup();
  const s = sim.state["NODE-04"];
  s.script = { label: "flashflood", level: 3.9, rainMmPerHr: 0, riseCmPerMin: 12.34 };
  const { reading } = sim.makeReading("NODE-04", T0 + periodMs);
  assert.equal(reading.fast_rise, true);
  assert.equal(reading.rise_rate_cm_per_min, 12.3);
  s.script = { label: "flood", level: 3.4, rainMmPerHr: 80 };
  assert.ok(!("fast_rise" in sim.makeReading("NODE-04", T0 + 2 * periodMs).reading), "no rate, no flag");
  s.script = null;
});

test("smoke: PM2.5 and gas rise together below the gas-leak threshold, no flame; needs pm + gas", () => {
  assert.deepEqual(sim.EVENTS.smoke.needs, ["pm", "gas"]);
  const periodMs = setup({ node: "NODE-INDB" });
  sim.state["NODE-INDB"].event = { type: "smoke", step: 0, delay: 0 };
  const rs = [];
  for (let i = 1; i <= sim.EVENTS.smoke.readings; i++) {
    const { reading, label } = sim.makeReading("NODE-INDB", T0 + i * periodMs);
    assert.equal(label, "smoke");
    rs.push(reading);
  }
  for (let i = 1; i < rs.length; i++) {
    assert.ok(rs[i].pm25_ugm3 > rs[i - 1].pm25_ugm3, "PM2.5 rising");
    assert.ok(rs[i].gas_ppm > rs[i - 1].gas_ppm, "gas rising with it");
  }
  for (const r of rs) {
    assert.ok(r.gas_ppm < 800, `gas ${r.gas_ppm} would read as a gas leak (backend GAS_LEAK_THRESHOLD_PPM)`);
    assert.ok(r.flame_reading < 0.1, "no flame");
    assert.ok(r.pm10_ugm3 >= r.pm25_ugm3, "PM10 includes PM2.5");
    // Above these band tops (backend PM25_BAND_TOPS / PM10_BAND_TOPS) air
    // pollution rates CRITICAL and outranks smoke (capped at HIGH)
    assert.ok(r.pm25_ugm3 <= 250, `PM2.5 ${r.pm25_ugm3} would read as CRITICAL air pollution, not smoke`);
    assert.ok(r.pm10_ugm3 <= 430, `PM10 ${r.pm10_ugm3} would read as CRITICAL air pollution, not smoke`);
  }
  assert.ok(rs[0].gas_ppm > 420, "above the normal gas band from the start");
});

test("the 14.2 m fault spike carries the node's anomaly flag; normal readings carry none", () => {
  const periodMs = setup();
  assert.ok(!("edge_anomaly" in sim.makeReading("NODE-04", T0 + periodMs).reading));
  sim.state["NODE-04"].event = { type: "sensor_fault", step: 0, delay: 0 };
  const { reading } = sim.makeReading("NODE-04", T0 + 2 * periodMs);
  assert.equal(reading.river_level_m, 14.2);
  assert.deepEqual(reading.edge_anomaly, ["spike:river_level_m"]);
  assert.equal(reading.edge_risk_level, "NORMAL", "the edge model itself is not alarmed by a fault");
});

test("siren kit: fitted flag, server commands on (for_s / default / cap) and off, on-time runs out", () => {
  const periodMs = setup({ node: "NODE-07", kit: ["water", "dht", "gas", "flame", "rain", "siren"] });
  const log = console.log;
  console.log = () => {};
  try {
    let t = T0 + periodMs;
    let out = sim.makeReading("NODE-07", t);
    assert.equal(out.reading.siren_fitted, true);
    assert.ok(!("siren_on" in out.reading) && !("siren_reason" in out.reading), "omitted while silent");
    assert.equal(out.sirenChanged, false);

    sim.applySirenCommands([{ node_id: "NODE-07", siren: "on", for_s: 30 }], t);
    out = sim.makeReading("NODE-07", (t += 10000));
    assert.equal(out.reading.siren_on, true);
    assert.equal(out.reading.siren_reason, "command");
    assert.equal(out.sirenChanged, true, "a change is reported at once");
    assert.equal(sim.makeReading("NODE-07", (t += 10000)).sirenChanged, false);
    // 30 s after the command the on-time has run out
    out = sim.makeReading("NODE-07", (t += 10000));
    assert.ok(!("siren_on" in out.reading));
    assert.equal(out.sirenChanged, true);

    // no for_s -> the 180 s default; a huge for_s is capped
    sim.applySirenCommands([{ node_id: "NODE-07", siren: "on" }], t);
    assert.equal(sim.state["NODE-07"].siren.until - t, sim.SIREN_DEFAULT_ON_S * 1000);
    sim.applySirenCommands([{ node_id: "NODE-07", siren: "on", for_s: 99999 }], t);
    assert.equal(sim.state["NODE-07"].siren.until - t, sim.SIREN_MAX_ON_S * 1000);
    assert.equal(sim.makeReading("NODE-07", (t += 1000)).reading.siren_on, true);
    // "off" stops it
    sim.applySirenCommands([{ node_id: "NODE-07", siren: "off" }], t);
    assert.ok(!("siren_on" in sim.makeReading("NODE-07", (t += 1000)).reading));

    // a node without a siren, an unknown node and junk are ignored
    sim.state["NODE-04"] = sim.initialState(T0);
    sim.applySirenCommands([{ node_id: "NODE-04", siren: "on" }, { node_id: "NODE-99", siren: "on" }, null, { siren: "on" },
      { node_id: "NODE-07", siren: "loud" }], t);
    sim.applySirenCommands(undefined, t);
    assert.equal(sim.state["NODE-04"].siren.on, false);
    assert.equal(sim.state["NODE-07"].siren.on, false);
    assert.ok(!("siren_fitted" in sim.makeReading("NODE-04", t).reading), "only fitted nodes say so");
  } finally {
    console.log = log;
    sim.NODE_PROFILES["NODE-07"] = HILLSIDE_KIT;
  }
});

test("siren commands can log through the caller (the judge demo's own log format)", () => {
  const periodMs = setup({ node: "NODE-07", kit: ["water", "rain", "siren"] });
  const lines = [];
  const log = console.log;
  console.log = (line) => { throw new Error(`printed to the console: ${line}`); };
  try {
    const t = T0 + periodMs;
    sim.applySirenCommands([{ node_id: "NODE-07", siren: "on", for_s: 60 }], t, (l) => lines.push(l));
    sim.applySirenCommands([{ node_id: "NODE-99", siren: "on" }], t, (l) => lines.push(l));
    sim.applySirenCommands([{ node_id: "NODE-07", siren: "off" }], t, (l) => lines.push(l));
  } finally {
    console.log = log;
    sim.NODE_PROFILES["NODE-07"] = HILLSIDE_KIT;
  }
  assert.equal(lines.length, 3);
  assert.match(lines[0], /siren ON at NODE-07 for 60s/);
  assert.match(lines[1], /NODE-99 ignored/);
  assert.match(lines[2], /siren OFF at NODE-07/);
});

test("a rain burst (judge demo downpour) lands in the next reading only; soil never reads over 100 %", () => {
  const periodMs = setup();
  const s = sim.state["NODE-04"];
  s.script = { label: "flood", level: 4.0, rainMmPerHr: 80 };
  s.soil = 70;
  s.rainBurstMm = 28;
  const rate = (80 * periodMs) / HOUR_MS;
  const burst = sim.makeReading("NODE-04", T0 + periodMs).reading;
  assert.ok(Math.abs(burst.rainfall_mm_since_last - (28 + rate)) <= GAUGE_STEP, `${burst.rainfall_mm_since_last} mm`);
  assert.equal(s.rainBurstMm, 0, "one reading only");
  assert.equal(burst.soil_moisture_pct, 100, "70 % + 2 % per mm, capped");
  const next = sim.makeReading("NODE-04", T0 + 2 * periodMs).reading;
  assert.ok(Math.abs(next.rainfall_mm_since_last - rate) <= GAUGE_STEP, `${next.rainfall_mm_since_last} mm`);
  assert.ok(next.soil_moisture_pct <= 100);
  // a node without a rain gauge reports none, burst or not (B67)
  setup({ node: "NODE-INDB" });
  sim.state["NODE-INDB"].rainBurstMm = 28;
  assert.equal(sim.makeReading("NODE-INDB", T0 + periodMs).reading.rainfall_mm_since_last, 0);
  s.script = null;
});

test("--summary: routine samples become one summary report; anything urgent goes out at once, after the window", () => {
  const periodMs = setup();
  const saved = { summary: sim.opts.summary, summarySamples: sim.opts.summarySamples };
  sim.opts.summary = true;
  sim.opts.summarySamples = 3;
  try {
    let t = T0;
    const samples = [];
    const next = () => {
      t += periodMs;
      const sample = sim.makeReading("NODE-04", t);
      samples.push(sample.reading);
      return sim.nodeReports("NODE-04", sample, t);
    };
    // the first sample goes out on its own
    let reports = next();
    assert.equal(reports.length, 1);
    assert.equal(reports[0].reading.summary.samples, 1);
    // then three samples per report
    assert.deepEqual(next(), []);
    assert.deepEqual(next(), []);
    reports = next();
    assert.equal(reports.length, 1);
    const { reading } = reports[0];
    const windowSamples = samples.slice(1, 4);
    assert.equal(reading.summary.samples, 3);
    assert.equal(reading.summary.window_s, Math.round((3 * periodMs) / 1000), "since the previous report");
    assert.equal(reading.summary.max_edge_risk_level, "NORMAL");
    assert.equal(reports[0].takenAt, t);
    // top level = the latest sample, rain = the sum over the window
    assert.equal(reading.river_level_m, windowSamples[2].river_level_m);
    assert.equal(reading.temp_c, windowSamples[2].temp_c);
    const windowRain = sum(windowSamples.map((r) => r.rainfall_mm_since_last));
    assert.ok(Math.abs(reading.rainfall_mm_since_last - windowRain) <= GAUGE_STEP / 2, "no rain lost to summarising");
    const levels = windowSamples.map((r) => r.river_level_m);
    assert.equal(reading.summary.river_level_m.min, Math.min(...levels));
    assert.equal(reading.summary.river_level_m.max, Math.max(...levels));
    assert.ok(Math.abs(reading.summary.river_level_m.mean - sum(levels) / 3) < 0.001);
    for (const f of ["temp_c", "humidity_pct", "gas_ppm"]) assert.ok(reading.summary[f], f);
    assert.ok(!("pm25_ugm3" in reading.summary) && !("tilt_angle_deg" in reading.summary), "only fitted sensors");

    // an urgent sample: the pending window goes first as a summary, then the raw reading
    assert.deepEqual(next(), []);
    sim.state["NODE-04"].sosPress = true;
    reports = next();
    assert.equal(reports.length, 2);
    assert.equal(reports[0].reading.summary.samples, 1);
    assert.equal(reports[1].reading.sos_button, true);
    assert.ok(!("summary" in reports[1].reading), "urgent readings are sent raw");
    assert.ok(reports[0].takenAt < reports[1].takenAt, "time order kept");

    // a fault spike is urgent too (nothing pending before it now)
    sim.state["NODE-04"].event = { type: "sensor_fault", step: 0, delay: 0 };
    reports = next();
    assert.equal(reports.length, 1);
    assert.deepEqual(reports[0].reading.edge_anomaly, ["spike:river_level_m"]);

    // never quieter than SUMMARY_MAX_GAP_S, however many samples are asked for
    sim.opts.summarySamples = 1000;
    let gapMs = periodMs;
    while (!next().length) gapMs += periodMs;
    assert.ok(gapMs >= sim.SUMMARY_MAX_GAP_S * 1000 && gapMs < sim.SUMMARY_MAX_GAP_S * 1000 + periodMs, `${gapMs} ms`);

    // without --summary every sample is its own raw report
    sim.opts.summary = false;
    reports = next();
    assert.equal(reports.length, 1);
    assert.ok(!("summary" in reports[0].reading));
  } finally {
    Object.assign(sim.opts, saved);
  }
});

test("summarizeWindow: max edge verdict, nodes without an edge model, a sensor that dropped out", () => {
  const w = [
    { reading: { node_id: "N", temp_c: 30, rainfall_mm_since_last: 0.1, edge_risk_level: "NORMAL" }, takenAt: 1000 },
    { reading: { node_id: "N", temp_c: 32, rainfall_mm_since_last: 0.2, edge_risk_level: "WATCH" }, takenAt: 11000 },
    { reading: { node_id: "N", rainfall_mm_since_last: 0, edge_risk_level: "NORMAL" }, takenAt: 21000 },
  ];
  const out = sim.summarizeWindow(w, 0);
  assert.deepEqual(out.summary, { samples: 3, window_s: 21, max_edge_risk_level: "WATCH", temp_c: { min: 30, max: 32, mean: 31 } });
  assert.equal(out.rainfall_mm_since_last, 0.3);
  assert.ok(!("temp_c" in out), "the top level is the latest sample, even when a sensor dropped out of it");
  const noEdge = sim.summarizeWindow([{ reading: { node_id: "N", tilt_angle_deg: 1.5 }, takenAt: 5 }]);
  assert.deepEqual(noEdge.summary, { samples: 1, window_s: 0, tilt_angle_deg: { min: 1.5, max: 1.5, mean: 1.5 } });
});

test("lora backlog: SOS, fast rise, anomaly, elevated and siren readings jump the queue", () => {
  assert.equal(sim.isPriority({ edge_risk_level: "NORMAL" }), false);
  assert.equal(sim.isPriority({}), false);
  for (const r of [{ sos_button: true }, { fast_rise: true }, { edge_anomaly: ["stuck:temp_c"] }, { siren_on: true },
    { edge_risk_level: "WATCH" }, { edge_risk_level: "URGENT" }]) {
    assert.equal(sim.isPriority(r), true, JSON.stringify(r));
  }
});

test("--hotspot-sos: parsed with its note, --people and --needs; payload matches the contract", () => {
  const o = sim.parseArgs(["--hotspot-sos", "NODE-07@120", "on the school roof", "--people", "3", "--needs", "trapped,injured,trapped",
    "--hotspot-sos", "GW-01@5", "--needs", "medical", "--summary", "--summary-samples", "6"]);
  assert.equal(o.hotspotSos.length, 2);
  assert.deepEqual(
    o.hotspotSos.map(({ node, at, note, people, needs }) => ({ node, at, note, people, needs })),
    [{ node: "NODE-07", at: 120, note: "on the school roof", people: 3, needs: ["trapped", "injured"] },
      { node: "GW-01", at: 5, note: "", people: null, needs: ["medical"] }],
    "a gateway id is allowed; the note is optional",
  );
  assert.equal(o.summary, true);
  assert.equal(o.summarySamples, 6);

  const saved = sim.opts.hotspotSos;
  sim.opts.hotspotSos = o.hotspotSos;
  const log = console.log;
  console.log = () => {};
  try {
    sim.queueHotspotSos(10, T0);
    assert.equal(o.hotspotSos[0].queuedAt, null, "not before 120 s");
    assert.equal(o.hotspotSos[1].queuedAt, T0);
    const p = sim.hotspotSosPayload(o.hotspotSos[1], T0 + 42000);
    assert.deepEqual(Object.keys(p).sort(),
      ["age_seconds", "client_id", "latitude", "longitude", "needs", "node_id", "note", "people", "simulated", "sos_uid"]);
    // whatever kind of key it is sent with, it must never pass as a real emergency
    assert.equal(p.simulated, true);
    assert.equal(p.note, "[SIMULATED] ", "marked even without a description");
    assert.equal(p.node_id, "GW-01");
    assert.equal(p.age_seconds, 42, "time spent waiting for the uplink");
    assert.equal(p.latitude, null);
    assert.equal(p.longitude, null);
    sim.queueHotspotSos(130, T0 + 1000);
    const p0 = sim.hotspotSosPayload(o.hotspotSos[0], T0 + 1000);
    assert.equal(p0.people, 3);
    assert.deepEqual(p0.needs, ["trapped", "injured"]);
    assert.equal(p0.note, "[SIMULATED] on the school roof");
    const long = { ...o.hotspotSos[0], note: "x".repeat(sim.HOTSPOT_NOTE_MAX) };
    assert.equal(sim.hotspotSosPayload(long, T0).note.length, sim.HOTSPOT_NOTE_MAX, "the tag keeps the note cap");
    assert.notEqual(p0.sos_uid, p.sos_uid, "unique per request");
    assert.notEqual(p0.client_id, p.client_id);
    assert.ok(p0.client_id.length <= 16 && p0.sos_uid.length <= 32, "short ids");
    assert.equal(sim.hotspotSosPayload(o.hotspotSos[0], T0 + 5000).sos_uid, p0.sos_uid, "a retry keeps its uid (server dedups)");
  } finally {
    console.log = log;
    sim.opts.hotspotSos = saved;
  }
});

test("--hotspot-sos / --people / --needs / --summary-samples / siren kit: bad input refused, all in --help", () => {
  const { spawnSync } = require("child_process");
  const script = path.join(__dirname, "..", "..", "server", "simulation.js");
  const run = (...args) => spawnSync(process.execPath, [script, "--key", "x", ...args], { encoding: "utf8", timeout: 10000 });
  for (const [args, message] of [
    [["--hotspot-sos", "NODE-07"], /needs NODE@SECONDS/],
    [["--hotspot-sos", "NODE-07@"], /needs NODE@SECONDS/],
    [["--hotspot-sos", "NODE-07@10", "x".repeat(161)], /at most 160/],
    [["--people", "2"], /belongs to a --hotspot-sos/],
    [["--hotspot-sos", "NODE-07@10", "--people", "0"], /--people needs a whole number/],
    [["--hotspot-sos", "NODE-07@10", "--people", "2.5"], /--people needs a whole number/],
    [["--hotspot-sos", "NODE-07@10", "--needs", "pizza"], /--needs: choose from/],
    [["--summary-samples", "0"], /--summary-samples needs/],
    [["--kit", "NODE-07=siren,battery"], /needs at least one measuring sensor/],
  ]) {
    const r = run(...args);
    assert.equal(r.status, 1, `${args.join(" ")}: ${r.stdout}`);
    assert.match(r.stderr, message);
  }
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  for (const re of [/--hotspot-sos NODE-07@120/, /--summary/, /flashflood/, /smoke/, /siren/, /edge_anomaly/]) assert.match(help.stdout, re);
});

test("end to end against a stub server: siren command round trip and one Wi-Fi SOS post", async () => {
  const http = require("http");
  const { spawn } = require("child_process");
  const script = path.join(__dirname, "..", "..", "server", "simulation.js");
  const got = { readings: [], sos: [] };
  let sirenWanted = "on";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/ingest/sos") {
        got.sos.push({ key: req.headers["x-device-key"], data });
        res.end(JSON.stringify({ status: "ok", sos_id: 7 }));
        return;
      }
      got.readings.push(data);
      // desired-state reconciliation like the server: repeat while the report differs
      const commands = data.siren_fitted && !!data.siren_on !== (sirenWanted === "on")
        ? [{ node_id: data.node_id, siren: sirenWanted, ...(sirenWanted === "on" ? { for_s: 60 } : {}) }]
        : [];
      res.end(JSON.stringify({ ai_action: "ok", commands }));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  // A port of our own and a child we started: both are stopped in finally.
  const child = spawn(process.execPath, [script, "--key", "stub-key", "--server", url, "--nodes", "NODE-04",
    "--kit", "NODE-04=water,dht,siren", "--interval", "0.05", "--event-every", "100000",
    "--hotspot-sos", "NODE-04@0", "two on the roof", "--people", "2", "--needs", "trapped"], { stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (out += c));
  const until = async (cond, what) => {
    for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 25));
    assert.ok(cond(), `${what}\n${out}`);
  };
  try {
    await until(() => got.readings.some((r) => r.siren_on), "the siren never came on");
    const on = got.readings.find((r) => r.siren_on);
    assert.equal(on.siren_reason, "command");
    assert.equal(on.siren_fitted, true);
    sirenWanted = "off";
    const count = got.readings.length;
    await until(() => got.readings.slice(count).some((r) => r.siren_fitted && !r.siren_on), "the siren never went off");
    await until(() => got.sos.length >= 1 && /SOS #7/.test(out), "no Wi-Fi SOS posted");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(got.sos.length, 1, "sent once");
    assert.equal(got.sos[0].key, "stub-key");
    assert.deepEqual({ ...got.sos[0].data, sos_uid: undefined, client_id: undefined, age_seconds: undefined }, {
      node_id: "NODE-04", sos_uid: undefined, client_id: undefined, people: 2, needs: ["trapped"],
      note: "[SIMULATED] two on the roof", latitude: null, longitude: null, age_seconds: undefined, simulated: true,
    });
  } finally {
    child.kill();
    server.close();
  }
});

// ---------------------------------------------------------------------
// Transport, in-process against a stub server: the rules that decide
// whether a reading or an SOS is lost or sent twice.
// ---------------------------------------------------------------------
// answer(req) -> [status, body]; every POST is recorded.
async function stubServer(answer) {
  const http = require("http");
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      posts.push({ url: req.url, data });
      const [status, out] = answer({ url: req.url, data });
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise((r) => server.close(r)) };
}

// Point the simulator's transport at `url` (lora mode, uplink up), quietly;
// restores everything afterwards.
async function withTransport(url, fn) {
  const keys = ["server", "key", "mode", "outage", "outageEvery", "hotspotSos", "interval"];
  const saved = Object.fromEntries(keys.map((k) => [k, sim.opts[k]]));
  const log = console.log;
  Object.assign(sim.opts, { server: url, key: "k", mode: "lora", outage: 0, outageEvery: 300, hotspotSos: [], interval: 3 });
  console.log = () => {};
  try {
    await fn();
  } finally {
    console.log = log;
    Object.assign(sim.opts, saved);
    sim.backlog.length = 0;
  }
}

const batchOk = ({ data }) => [200, { status: "success", results: data.readings.map((r) => ({ node_id: r.node_id, ai_action: "logged" })) }];

test("lora backlog: a priority reading behind 25 routine ones goes in the first batch; a failed upload loses nothing", async () => {
  let fail = true;
  const stub = await stubServer((req) => (fail ? [503, { error: "backend down" }] : batchOk(req)));
  try {
    await withTransport(stub.url, async () => {
      const now = Date.now();
      for (let i = 0; i < 25; i++) {
        sim.backlog.push({ reading: { node_id: "NODE-04", reading_uid: `n${i}` }, label: "normal", takenAt: now + i });
      }
      sim.backlog.push({ reading: { node_id: "NODE-07", reading_uid: "sos", sos_button: true }, label: "normal", takenAt: now + 25 });
      const first = sim.nextBatch();
      assert.equal(first.length, 20, "the batch cap");
      assert.deepEqual(first.map((it) => it.reading.reading_uid),
        ["sos", ...Array.from({ length: 19 }, (_, i) => `n${i}`)], "priority first, then the oldest");

      await sim.flushBacklog(); // 503: kept for retry
      assert.equal(stub.posts.length, 1);
      assert.equal(sim.backlog.length, 26, "nothing dropped on a 5xx");

      fail = false;
      await sim.flushBacklog();
      const batches = stub.posts.slice(1).map((p) => p.data.readings.map((r) => r.reading_uid));
      assert.deepEqual(batches.map((b) => b.length), [20, 6]);
      assert.equal(batches[0][0], "sos");
      const all = batches.flat();
      assert.equal(new Set(all).size, 26, "each reading once");
      assert.deepEqual([...all].sort(), ["sos", ...Array.from({ length: 25 }, (_, i) => `n${i}`)].sort());
      assert.equal(sim.backlog.length, 0);
    });
  } finally {
    await stub.close();
  }
});

test("siren commands on an error answer are obeyed; the readings follow the keep-or-drop rule", async () => {
  setup({ node: "NODE-07", kit: ["water", "rain", "siren"] });
  const cmd = [{ node_id: "NODE-07", siren: "on", for_s: 30 }];
  // server.js answers a backend outage with 502 + commands (withSirenCommands)
  let answer = [502, { status: "error", commands: cmd }];
  const stub = await stubServer(() => answer);
  try {
    await withTransport(stub.url, async () => {
      sim.backlog.push({ reading: { node_id: "NODE-07", reading_uid: "a", siren_fitted: true }, label: "normal", takenAt: Date.now() });
      await sim.flushBacklog();
      assert.equal(sim.state["NODE-07"].siren.on, true, "lora batch: siren on despite the 502");
      assert.equal(sim.backlog.length, 1, "the reading is kept for retry");

      sim.state["NODE-07"].siren = { on: false, until: 0, reason: null };
      answer = [422, { detail: "bad reading", commands: cmd }];
      await sim.flushBacklog();
      assert.equal(sim.state["NODE-07"].siren.on, true, "lora batch: siren on with a 422");
      assert.equal(sim.backlog.length, 0, "an invalid reading is dropped");

      // direct (Wi-Fi) mode: the same
      sim.state["NODE-07"].siren = { on: false, until: 0, reason: null };
      answer = [502, { status: "error", commands: cmd }];
      await assert.rejects(sim.sendDirect({ reading: { node_id: "NODE-07", siren_fitted: true }, label: "normal", takenAt: Date.now() }),
        /HTTP 502/);
      assert.equal(sim.state["NODE-07"].siren.on, true, "direct: siren on despite the 502");
    });
  } finally {
    await stub.close();
  }
});

test("Wi-Fi SOS: kept and retried with the same sos_uid until a 200; dropped on 400; held while the uplink is down", async () => {
  const replies = [[503, {}], [404, {}], [401, {}], [403, {}], [429, {}], [200, { status: "ok", sos_id: 9 }]];
  let refuse = false;
  const stub = await stubServer(() => (refuse ? [400, { error: "bad" }] : replies.shift() || [200, { status: "duplicate", sos_id: 9 }]));
  try {
    await withTransport(stub.url, async () => {
      const [item] = sim.parseArgs(["--hotspot-sos", "NODE-07@0", "on the roof"]).hotspotSos;
      item.queuedAt = Date.now();
      sim.opts.hotspotSos = [item];
      for (let i = 0; i < 5; i++) {
        await sim.flushHotspotSos();
        assert.ok(!item.done, `kept after HTTP ${[503, 404, 401, 403, 429][i]}`);
      }
      await sim.flushHotspotSos(); // 200
      assert.equal(item.done, true);
      await sim.flushHotspotSos();
      const sos = stub.posts.filter((p) => p.url === "/api/ingest/sos");
      assert.equal(sos.length, 6, "no post after the 200");
      assert.equal(new Set(sos.map((p) => p.data.sos_uid)).size, 1, "every retry is the same request (server dedups)");
      assert.ok(sos.every((p) => p.data.simulated === true));

      // 400/422: the server refused the request itself - retrying never helps
      refuse = true;
      const [bad] = sim.parseArgs(["--hotspot-sos", "NODE-07@0", "x"]).hotspotSos;
      bad.queuedAt = Date.now();
      sim.opts.hotspotSos = [bad];
      await sim.flushHotspotSos();
      assert.equal(bad.done, true);
      await sim.flushHotspotSos();
      assert.equal(stub.posts.length, 7, "not retried");

      // uplink down (lora outage the whole cycle): nothing is posted, nothing is lost
      refuse = false;
      const [held] = sim.parseArgs(["--hotspot-sos", "NODE-07@0", "y"]).hotspotSos;
      held.queuedAt = Date.now();
      sim.opts.hotspotSos = [held];
      Object.assign(sim.opts, { outage: 10, outageEvery: 10 });
      await sim.flushHotspotSos();
      assert.equal(stub.posts.length, 7);
      assert.ok(!held.done);
      Object.assign(sim.opts, { outage: 0, outageEvery: 300 });

      // network error (server gone): kept
      await stub.close();
      await sim.flushHotspotSos();
      assert.ok(!held.done, "kept on a network error");
    });
  } finally {
    await stub.close().catch(() => {});
  }
});

// ---------------------------------------------------------------------
// Round 4 (user decisions 2026-10-09)
// ---------------------------------------------------------------------
// A throw-away virtual node with its own kit, removed afterwards.
function withKitNode(kit, fn) {
  const node = "NODE-T4";
  sim.NODE_PROFILES[node] = kit;
  try {
    return fn(node, setup({ node }));
  } finally {
    delete sim.NODE_PROFILES[node];
    delete sim.state[node];
  }
}

test("--no-siren-summary-s: a node without a siren summarises by time (5 min), a siren node keeps 60 s", () => {
  const saved = { summary: sim.opts.summary, summarySamples: sim.opts.summarySamples, noSirenSummaryS: sim.opts.noSirenSummaryS,
    edgeLite: sim.opts.edgeLite };
  const o = sim.parseArgs(["--no-siren-summary-s", String(sim.NO_SIREN_SUMMARY_S)]);
  assert.equal(o.noSirenSummaryS, 300);
  assert.equal(o.summary, true, "implies --summary");
  assert.equal(sim.parseArgs([]).noSirenSummaryS, null, "off by default");
  // edgeLite: the reduced-kit node below needs a verdict for its WATCH step (--edge-lite)
  Object.assign(sim.opts, { summary: true, summarySamples: 4, noSirenSummaryS: 300, edgeLite: true });
  try {
    // when each report went out while everything is routine
    const reportsOver = (node, periodMs, count) => {
      let t = T0;
      const at = [];
      for (let i = 0; i < count; i++) {
        t += periodMs;
        const reports = sim.nodeReports(node, sim.makeReading(node, t), t);
        if (reports.length) at.push({ t, samples: reports[0].reading.summary.samples });
      }
      return at;
    };
    withKitNode(["water", "dht", "rain", "battery"], (node, periodMs) => {
      assert.deepEqual(sim.summaryGap(node), { gapS: 300, byTime: true });
      const at = reportsOver(node, periodMs, Math.ceil((3 * 300 * 1000) / periodMs) + 1);
      assert.equal(at[0].samples, 1, "the first sample goes out on its own");
      const steps = at.slice(1).map((x, i) => x.t - at[i].t);
      assert.ok(steps.length >= 2, `${steps.length} summaries in 15 min`);
      // every 300 s (to the next sample), never by the 4-sample count
      assert.ok(steps.every((ms) => ms >= 300000 && ms < 300000 + periodMs), `gaps ${steps}`);
      assert.ok(at.slice(1).every((x) => x.samples > 4), "the --summary-samples count does not apply");
      // urgent still goes out at once: an SOS press on the next sample
      const last = at[at.length - 1].t;
      sim.state[node].sosPress = true;
      const reports = sim.nodeReports(node, sim.makeReading(node, last + periodMs), last + periodMs);
      assert.equal(reports[reports.length - 1].reading.sos_button, true);
      // ... and so does an elevated (lite edge WATCH) reading
      sim.state[node].script = { label: "flood", level: 3.0, rainMmPerHr: 0 };
      const watch = sim.nodeReports(node, sim.makeReading(node, last + 2 * periodMs), last + 2 * periodMs);
      assert.equal(watch.length, 1);
      assert.equal(watch[0].reading.edge_risk_level, "WATCH");
      assert.ok(!("summary" in watch[0].reading));
    });
    withKitNode(["water", "dht", "rain", "battery", "siren"], (node, periodMs) => {
      assert.deepEqual(sim.summaryGap(node), { gapS: sim.SUMMARY_MAX_GAP_S, byTime: false });
      const at = reportsOver(node, periodMs, 40);
      assert.ok(at.length > 5 && at.slice(1).every((x) => x.samples === 4), "the siren node: every 4 samples, as before");
    });
    // without the option every node keeps the old rule
    sim.opts.noSirenSummaryS = null;
    withKitNode(["water", "dht"], (node) => assert.deepEqual(sim.summaryGap(node), { gapS: 60, byTime: false }));
  } finally {
    Object.assign(sim.opts, saved);
  }
});

test("lite edge stand-in (--edge-lite): reduced-kit nodes get the lite model's training rule; no siren by itself", () => {
  const L = sim.liteEdgeLevel;
  const saved = sim.opts.edgeLite;
  // OFF by default (demo pacing / confidence figures unchanged)
  assert.equal(sim.parseArgs([]).edgeLite, false);
  assert.equal(sim.parseArgs(["--edge-lite"]).edgeLite, true);
  assert.equal(sim.parseArgs(["--edge-lite", "--no-edge-lite"]).edgeLite, false);
  sim.opts.edgeLite = true;
  try {
  // thresholds (backend values - see LITE_EDGE in simulation.js)
  assert.equal(L({ river_level_m: 1.8 }), "NORMAL");
  assert.equal(L({ river_level_m: 2.75 }), "WATCH");
  assert.equal(L({ river_level_m: 3.5 }), "URGENT");
  assert.equal(L({ gas_ppm: 600 }), "WATCH");
  assert.equal(L({ gas_ppm: 800 }), "URGENT");
  assert.equal(L({ flame_reading: 1 }), "URGENT");
  assert.equal(L({ tilt_angle_deg: 0.5, vibration_magnitude: 0.03 }), "NORMAL");
  assert.equal(L({ tilt_angle_deg: 9, vibration_magnitude: 0.2 }), "WATCH"); // 0.42 + 0.03
  assert.equal(L({ tilt_angle_deg: 14, vibration_magnitude: 1.5 }), "URGENT"); // 0.653 + 0.225
  // heat: label_lite() (IMD plains 45 / 47 C); the offline siren ignores the edge verdict (sj_siren.h)
  assert.equal(L({ temp_c: 44.9 }), "NORMAL");
  assert.equal(L({ temp_c: 45 }), "WATCH");
  assert.equal(L({ temp_c: 48.5 }), "URGENT");
  // the lite model has no PM input: PM alone gives no verdict
  assert.equal(L({ pm25_ugm3: 300, pm10_ugm3: 500 }), null);
  // a flagged field is ignored (like the full model for the fault spike); no usable sensor -> no verdict
  assert.equal(L({ river_level_m: 14.2, edge_anomaly: ["spike:river_level_m"] }), null);
  assert.equal(L({ river_level_m: 14.2, temp_c: 30, edge_anomaly: ["spike:river_level_m"] }), "NORMAL");
  assert.equal(L({ water_ph: 5, turbidity_ntu: 30 }), null);

  // through makeReading: a tilt-only slope node during a landslide
  withKitNode(["tilt", "rain", "battery"], (node, periodMs) => {
    assert.equal(sim.makeReading(node, T0 + periodMs).reading.edge_risk_level, "NORMAL");
    sim.state[node].event = { type: "landslide", step: 0, delay: 0 };
    const levels = [];
    for (let i = 2; i < 2 + sim.EVENTS.landslide.readings; i++) {
      levels.push(sim.makeReading(node, T0 + i * periodMs).reading.edge_risk_level);
    }
    assert.equal(levels[levels.length - 1], "URGENT");
    assert.ok(levels.includes("WATCH"), `${levels}`);
  });
  // a deep-sleep-style node (no MQ135) with a siren, in a heat event: the lite rule, no siren by itself
  withKitNode(["water", "dht", "flame", "battery", "siren"], (node, periodMs) => {
    sim.state[node].event = { type: "heat", step: 0, delay: 0 };
    for (let i = 1; i <= sim.EVENTS.heat.readings; i++) {
      const { reading, label } = sim.makeReading(node, T0 + i * periodMs);
      assert.equal(label, "heat");
      const want = reading.temp_c >= 47 ? "URGENT" : reading.temp_c >= 45 ? "WATCH" : "NORMAL";
      assert.equal(reading.edge_risk_level, want, `${reading.temp_c} C`);
      assert.equal(reading.siren_fitted, true);
      assert.ok(!("siren_on" in reading), "the simulator never sounds a siren on its own");
    }
  });
  } finally {
    sim.opts.edgeLite = saved;
  }
  // the default (no --edge-lite): reduced-kit nodes send no verdict; full-kit nodes keep theirs
  sim.opts.edgeLite = false;
  try {
    withKitNode(["tilt", "rain"], (node, periodMs) => {
      assert.ok(!("edge_risk_level" in sim.makeReading(node, T0 + periodMs).reading));
    });
    const periodMs = setup();
    assert.equal(sim.makeReading("NODE-04", T0 + periodMs).reading.edge_risk_level, "NORMAL");
  } finally {
    sim.opts.edgeLite = saved;
  }
});

// The full edge model's simulated verdict follows the rule the real model
// is trained on (label() in ml/make_edge_dataset.py) - read from that file,
// so a change there (e.g. heat capped at WATCH) fails here until the
// simulator follows it.
test("full edge stand-in: the training rule of ml/make_edge_dataset.py, on the model's own inputs only", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "ml", "make_edge_dataset.py"), "utf8").replace(/\r\n/g, "\n");
  const body = src.match(/def label\(level_m, temp_c, gas_ppm, flame\):\n([\s\S]*?)\n\n/);
  assert.ok(body, "label() not found in ml/make_edge_dataset.py");
  const FIELD = { level_m: "river_level_m", temp_c: "temp_c", gas_ppm: "gas_ppm", flame: "flame_reading" };
  const rules = {};
  for (const m of body[1].matchAll(/if ([^:]+):\s*\n\s*return (\d)/g)) {
    const limits = {};
    for (const c of m[1].split(/\s+or\s+/)) {
      const t = c.trim().match(/^(\w+) >= ([\d.]+)$/);
      assert.ok(t && FIELD[t[1]], `label() condition the simulator does not model: "${c.trim()}"`);
      limits[FIELD[t[1]]] = Number(t[2]);
    }
    rules[m[2]] = limits;
  }
  assert.deepEqual(rules, { 2: sim.FULL_EDGE.urgent, 1: sim.FULL_EDGE.watch }, "simulation.js FULL_EDGE vs label()");

  const F = sim.fullEdgeLevel;
  assert.equal(F({ river_level_m: 1.8, temp_c: 30, gas_ppm: 430, flame_reading: 0 }), "NORMAL");
  assert.equal(F({ temp_c: 44.9 }), "NORMAL", "40-45 C: backend MEDIUM, node NORMAL (IMD heat wave from 45 C)");
  assert.equal(F({ temp_c: 45 }), "WATCH");
  assert.equal(F({ temp_c: 47.5 }), "URGENT", "as the trained model does - not a siren trigger (sj_siren.h)");
  assert.equal(F({ river_level_m: 14.2, temp_c: 30, edge_anomaly: ["spike:river_level_m"] }), "NORMAL");
  // through makeReading on a full-kit node: hazards the model cannot see stay NORMAL
  const CORE = ["water", "dht", "gas", "flame"];
  for (const [type, extra] of [["air", ["pm"]], ["water", ["ph", "turbidity"]], ["landslide", ["tilt"]]]) {
    withKitNode([...CORE, ...extra], (node, periodMs) => {
      sim.state[node].event = { type, step: 0, delay: 0 };
      for (let i = 1; i <= sim.EVENTS[type].readings; i++) {
        const { reading, label } = sim.makeReading(node, T0 + i * periodMs);
        assert.equal(label, type);
        assert.equal(reading.edge_risk_level, "NORMAL", `${type}: the model reads no PM / pH / tilt`);
      }
    });
  }
  // smoke: the model sees only its gas and warmth - WATCH from 600 ppm, never URGENT below 800
  const smoke = withKitNode([...CORE, "pm"], (node, periodMs) => {
    sim.state[node].event = { type: "smoke", step: 0, delay: 0 };
    const out = [];
    for (let i = 1; i <= sim.EVENTS.smoke.readings; i++) out.push(sim.makeReading(node, T0 + i * periodMs).reading);
    return out;
  });
  for (const r of smoke) assert.equal(r.edge_risk_level, r.gas_ppm >= 600 || r.temp_c >= 40 ? "WATCH" : "NORMAL", `${r.gas_ppm} ppm`);
  assert.ok(smoke.some((r) => r.edge_risk_level === "WATCH") && smoke.every((r) => r.edge_risk_level !== "URGENT"));
});

test("scripted temperature (judge demo heat wave): the set value +-0.1 C in dry air", () => {
  const periodMs = setup();
  const s = sim.state["NODE-04"];
  s.script = { label: "heat", level: null, rainMmPerHr: 0, tempC: 47.6 };
  for (let i = 1; i <= 20; i++) {
    const { reading, label } = sim.makeReading("NODE-04", T0 + i * periodMs);
    assert.equal(label, "heat");
    assert.ok(Math.abs(reading.temp_c - 47.6) <= 0.1001, `${reading.temp_c}`);
    assert.ok(reading.humidity_pct >= 15 && reading.humidity_pct <= 25);
  }
  s.script = { label: "normal", level: null, rainMmPerHr: 0 };
  assert.ok(sim.makeReading("NODE-04", T0 + 21 * periodMs).reading.temp_c <= 33, "without tempC: the normal range");
  s.script = null;
});

test("--no-siren-summary-s / --no-edge-lite: bad input refused, both in --help", () => {
  const { spawnSync } = require("child_process");
  const script = path.join(__dirname, "..", "..", "server", "simulation.js");
  const run = (...args) => spawnSync(process.execPath, [script, "--key", "x", ...args], { encoding: "utf8", timeout: 10000 });
  for (const bad of ["0", "-5", "abc"]) {
    const r = run("--no-siren-summary-s", bad);
    assert.equal(r.status, 1, bad);
    assert.match(r.stderr, /--no-siren-summary-s needs seconds > 0/);
  }
  const help = run("--help");
  assert.equal(help.status, 0, help.stderr);
  for (const re of [/--no-siren-summary-s 300/, /--edge-lite /, /OFF by default/, /--no-edge-lite/,
    /SIMULATED rule-based stand-in/, /heat wave with NO siren/]) {
    assert.match(help.stdout, re);
  }
});

// ---------------------------------------------------------------------
// tools/demo/node_health_check.js (decision 2026-10-09: no false "offline"
// for a 5-min node) - the verdict and the options; the live run needs a
// stack: node tools/demo/node_health_check.js
// ---------------------------------------------------------------------
test("node_health_check: a 5-min node marked offline between reports FAILS; online across a full gap passes", () => {
  const nhc = require("./node_health_check.js");
  const read = (atS, status, since) => ({ atS, nodes: [{ node_id: "NODE-07", status, seconds_since_seen: since,
    issues: status === "offline" ? [{ type: "missing", message: "No report for 70s (expected every 5s)" }] : [] }] });
  const watch = { "NODE-07": 300 };
  // the bug the check is for: offline ~60 s after the first report
  const bad = nhc.evaluate([read(5, "never_seen", null), read(15, "online", 5), read(75, "offline", 70), read(330, "online", 10)], watch);
  assert.equal(bad.pass, false);
  assert.match(bad.lines[0], /FALSE OFFLINE in 1 of 3 reads, first at \+75 s \(70 s after a report\): "No report for 70s/);
  // online through a whole 300 s gap
  const good = nhc.evaluate([read(15, "online", 5), read(160, "online", 150), read(310, "online", 300), read(330, "online", 10)], watch);
  assert.equal(good.pass, true, good.lines.join("\n"));
  assert.match(good.lines[0], /watched 315 s after its first report, longest quiet 300 s - online throughout/);
  // too short a run proves nothing; a node that never reported neither
  assert.equal(nhc.evaluate([read(15, "online", 5), read(200, "online", 190)], watch).pass, false);
  assert.match(nhc.evaluate([read(15, "online", 5), read(200, "online", 190)], watch).lines[0], /INCONCLUSIVE/);
  assert.match(nhc.evaluate([read(15, "never_seen", null)], watch).lines[0], /never reported/);
  // options
  assert.deepEqual(nhc.parseArgs([]), { minutes: 7, summaryS: 300, poll: 10, interval: 5, webPort: 3300, backendPort: 8300,
    python: null, keepVar: false });
  assert.throws(() => nhc.parseArgs(["--minutes", "5"]), /shorter than one --summary-s gap/);
  assert.throws(() => nhc.parseArgs(["--bogus"]), /Unknown option/);
});
