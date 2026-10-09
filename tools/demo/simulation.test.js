// Tests for the sensor simulator's reading generator (server/simulation.js).
// Run: node --test tools/demo/simulation.test.js
//
// Requiring the simulator does not start it (no server needed): it only
// builds readings, so these tests drive makeReading() with explicit
// timestamps instead of waiting on real time.
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

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
  assert.equal(reading.edge_risk_level, "URGENT");
  assert.equal(reading.simulated, true);
  // level null: the river keeps drifting near its base level, only the rain is scripted
  s.script = { label: "normal", level: null, rainMmPerHr: 10 };
  const calm = sim.makeReading("NODE-04", T0 + 2 * periodMs);
  assert.equal(calm.label, "normal");
  assert.equal(calm.reading.edge_risk_level, "NORMAL");
  // a running event wins over the script (the fault spike in the demo)
  s.event = { type: "sensor_fault", step: 0, delay: 0 };
  assert.equal(sim.makeReading("NODE-04", T0 + 3 * periodMs).reading.river_level_m, 14.2);
  s.script = null;
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
