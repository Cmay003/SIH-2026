// Tests for the scripted judge demo (tools/demo/run_demo.js).
// Run: node --test tools/demo/run_demo.test.js
//
// The story runs against a FAKE server and a fake clock (no network, no
// sleeping): it checks what the script sends and in which order, not the
// AI backend itself - that end-to-end check is a real run on spare ports
// (see the header of run_demo.js).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const demo = require(path.join(__dirname, "run_demo.js"));
const { Demo, parseArgs, backfillTimes, pointInZone, haversineM, makeFreshVar, preflight } = demo;

const MIN = 60000;
const NODE_POS = {
  "NODE-04": { latitude: 29.3919, longitude: 79.4542 },
  "NODE-07": { latitude: 29.4002, longitude: 79.461 },
  "NODE-INDB": { latitude: 29.385, longitude: 79.448 },
};
const NEIGHBOURS = { "NODE-04": ["NODE-07", "NODE-INDB"], "NODE-07": ["NODE-04"], "NODE-INDB": ["NODE-04"] };

// A stand-in for server.js + backend_server.py with the same confirmation
// rule (repeat on the node, or a neighbour, within 10 minutes).
function fakeStack(t0 = Date.UTC(2026, 9, 8, 6, 0, 0)) {
  const st = { now: t0, rows: [], posts: [], sos: [], lines: [] };
  const assess = (r, takenAt) => {
    if (r.river_level_m > 10) return { status: "suppressed", severity: "N/A" };
    if (!(r.river_level_m >= 2.5)) return { status: "logged", severity: "LOW" };
    const recent = (node) => st.rows.some((x) => x.node_id === node && x.elevated && takenAt - x.takenAt <= 10 * MIN);
    let confirmation = "unconfirmed";
    if (recent(r.node_id)) confirmation = "persistent";
    else {
      const n = NEIGHBOURS[r.node_id].find(recent);
      if (n) confirmation = `neighbour:${n}`;
    }
    return { status: confirmation === "unconfirmed" ? "pending_confirmation" : "alert_dispatched", severity: "HIGH",
      confirmation, elevated: true };
  };
  const ingest = (r) => {
    const takenAt = st.now - (r.age_seconds || 0) * 1000;
    const a = assess(r, takenAt);
    const row = { id: st.rows.length + 1, node_id: r.node_id, reading_uid: r.reading_uid, takenAt,
      timestamp: new Date(takenAt).toISOString(), delay_seconds: (st.now - takenAt) / 1000, ...a };
    st.rows.push(row);
    return row.status;
  };
  const latestAlerts = () => {
    const latest = {};
    for (const r of st.rows) latest[r.node_id] = r;
    return Object.values(latest).filter((r) => r.status === "alert_dispatched");
  };
  const ok = (data, status = 200) => ({ status, data, text: JSON.stringify(data) });
  const io = {
    now: () => st.now,
    sleep: async (ms) => { if (ms > 0) st.now += ms; },
    log: (line) => st.lines.push(line),
    async request(method, url, { body, headers } = {}) {
      const u = new URL(url);
      st.now += 5; // every request takes a moment
      if (method === "POST" && u.pathname.startsWith("/api/ingest")) {
        if (headers["X-Device-Key"] !== "k") return ok({ error: "bad key" }, 401);
        st.posts.push({ path: u.pathname, body: JSON.parse(JSON.stringify(body)), at: st.now });
        if (u.pathname === "/api/ingest") return ok({ status: "success", ai_action: ingest(body) });
        return ok({ status: "success", results: body.readings.map((r) => ({ node_id: r.node_id, ai_action: ingest(r) })) });
      }
      if (u.pathname === "/api/readings") {
        const node = u.searchParams.get("node_id");
        const rows = st.rows.filter((r) => !node || r.node_id === node).slice().reverse();
        return ok(rows.slice(0, Number(u.searchParams.get("limit") || 50)));
      }
      if (u.pathname.startsWith("/api/forecast/")) return ok({ available: true, current_level_m: 1.65 });
      if (u.pathname === "/api/hazards") {
        return ok({ hazards: latestAlerts().map((r) => ({ node_id: r.node_id, hazard_type: "flood", severity: r.severity, stale: false })) });
      }
      if (u.pathname === "/api/hazard-zones") {
        return ok({ zones: latestAlerts().map((r) => ({ node_id: r.node_id, ...NODE_POS[r.node_id], radius_m: 1000 })) });
      }
      if (method === "POST" && u.pathname === "/api/sos") {
        st.sos.push(body);
        return ok({ status: "received", sos_id: st.sos.length, hospital: "H", distance_km: 1 }, 201);
      }
      if (u.pathname.startsWith("/api/sos/device/")) {
        return ok({ active: st.sos.some((s) => s.device_id === decodeURIComponent(u.pathname.split("/").pop())) });
      }
      throw new Error(`fake stack: no route for ${method} ${u.pathname}`);
    },
  };
  return { st, io };
}

const FAST = ["--interval", "4", "--pace", "20", "--outage", "20", "--key", "k", "--exit"];

async function runStory(seed = 42) {
  const { st, io } = fakeStack();
  const d = new Demo({ ...parseArgs([...FAST, "--seed", String(seed)], {}), runId: "test" }, io);
  await d.backfill();
  await d.story();
  return { st, d };
}

// The readings as the sensors produced them (what a judge would see),
// without per-run ids and send-time fields.
const payloads = (st) => st.posts.flatMap((p) => (p.body.readings || [p.body]))
  .map(({ reading_uid, age_seconds, ...rest }) => rest);

test("parseArgs: defaults and refusals", () => {
  const o = parseArgs([], { SANJEEVNI_INGEST_KEY: "abc" });
  assert.equal(o.seed, 42);
  assert.equal(o.key, "abc");
  assert.equal(o.fresh, false);
  assert.throws(() => parseArgs(["--fresh", "--web-port", "3000"], {}), /other than 3000/);
  assert.throws(() => parseArgs(["--fresh", "--backend-port", "8000"], {}), /other than 3000\/8000/);
  assert.throws(() => parseArgs(["--pace", "2", "--interval", "4"], {}), /--pace/);
  assert.throws(() => parseArgs(["--outage", "1"], {}), /--outage/);
  assert.throws(() => parseArgs(["--bogus"], {}), /Unknown option/);
  assert.throws(() => parseArgs(["--seed"], {}), /needs a number/);
});

test("back-filled history covers the forecast window and ends outside the confirmation window", () => {
  const now = Date.UTC(2026, 9, 8, 12, 0, 0);
  const times = backfillTimes(now, 130);
  assert.equal(times[0], now - 130 * MIN);
  const last = times[times.length - 1];
  // older than CONFIRM_WINDOW: a history reading can never corroborate a live alert
  assert.ok(now - last > demo.CONFIRM_WINDOW_MINUTES * MIN, `last history reading ${(now - last) / MIN} min old`);
  assert.ok(now - last <= (demo.BACKFILL_GAP_MINUTES + 3) * MIN, "gap small enough for the forecast's empty-step limit");
  // every 5-min forecast step gets readings
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] <= 5 * MIN);
  assert.ok(times.every((t, i) => i === 0 || t > times[i - 1]), "oldest first");
});

test("pointInZone stays inside the circle at any bearing", () => {
  const zone = { latitude: 29.3919, longitude: 79.4542, radius_m: 500 };
  for (let u = 0; u < 1; u += 0.05) {
    const p = pointInZone(zone, 0.4, u);
    const d = haversineM(zone.latitude, zone.longitude, p.latitude, p.longitude);
    assert.ok(Math.abs(d - 200) < 2, `bearing ${u}: ${d} m`);
  }
});

test("the story: pending -> neighbour-confirmed -> fault suppressed -> SOS in zone -> backlog", async () => {
  const { st, d } = await runStory();
  const failed = d.checks.filter((c) => !c.pass);
  assert.deepEqual(failed, [], st.lines.join("\n"));
  assert.deepEqual(d.checks.map((c) => c.id),
    ["backfill", "forecast", "upstream-pending", "river-confirmed", "siren", "fault-suppressed", "sos-in-zone", "outage-backlog"]);

  // every reading the demo sends is simulated
  const all = payloads(st);
  assert.ok(all.length > 150);
  assert.ok(all.every((r) => r.simulated === true));

  // history: sent as a backlog, every reading older than the confirmation window, none elevated
  const live = st.rows.filter((r) => r.delay_seconds < 60);
  const history = st.rows.filter((r) => r.delay_seconds >= 60);
  assert.ok(history.length >= 3 * 45, `${history.length} history readings`);
  const firstLive = Math.min(...live.map((r) => r.takenAt));
  assert.ok(history.every((r) => firstLive - r.takenAt > demo.CONFIRM_WINDOW_MINUTES * MIN));
  assert.ok(history.every((r) => r.status === "logged"));

  // the upstream jump is ONE reading, and nothing confirms it before NODE-04 rises
  const up = st.rows.filter((r) => r.node_id === "NODE-07" && r.elevated);
  const river = st.rows.filter((r) => r.node_id === "NODE-04" && r.elevated);
  assert.equal(up[0].status, "pending_confirmation");
  assert.ok(river[0].takenAt < up[1].takenAt, "NODE-04 confirms before NODE-07 repeats itself");
  assert.equal(river[0].confirmation, "neighbour:NODE-07");

  // the fault spike: one 14.2 m reading at NODE-INDB
  const spikes = all.filter((r) => r.river_level_m === demo.FAULT_LEVEL_M);
  assert.equal(spikes.length, 1);
  assert.equal(spikes[0].node_id, "NODE-INDB");

  // exactly one SOS (rate limits), marked as simulated, inside the NODE-04 zone
  assert.equal(st.sos.length, 1);
  assert.match(st.sos[0].note, /SIMULATED/);
  assert.ok(haversineM(29.3919, 79.4542, st.sos[0].latitude, st.sos[0].longitude) < 1000);

  // the outage: NODE-07 readings arrive in ONE batch, late, oldest first
  const backlog = st.posts.filter((p) => p.path === "/api/ingest/batch" && p.body.readings.length > 1 &&
    p.body.readings.every((r) => r.node_id === "NODE-07" && r.link === "lora"));
  assert.equal(backlog.length, 1);
  const ages = backlog[0].body.readings.map((r) => r.age_seconds);
  assert.equal(ages.length, 20 / 4);
  assert.ok(ages[0] >= 16 && ages.every((a, i) => a > 0 && (i === 0 || a < ages[i - 1])), `ages ${ages}`);
});

test("a slow back-fill does not lose the storm rain: ~10 mm in the hour before the siren cue", async () => {
  const sim = require(path.join(__dirname, "..", "..", "server", "simulation.js")); // run_demo's instance
  const { st, io } = fakeStack();
  let d;
  // Every back-fill batch takes 50 s (6 batches -> 5 min), like a backend
  // scoring 0.5-4 s per reading. Live requests stay quick.
  const request = io.request;
  io.request = async (method, url, opts) => {
    const res = await request(method, url, opts);
    if (d && d.cue === "setup" && url.endsWith("/api/ingest/batch")) st.now += 50 * 1000;
    return res;
  };
  d = new Demo({ ...parseArgs([...FAST, "--seed", "42"], {}), runId: "slow" }, io);
  // what each sensor reading reported, at the sensors' own time
  const taken = [];
  const take = d.takeReading.bind(d);
  d.takeReading = (node, at) => {
    const item = take(node, at);
    taken.push({ node, at, cue: d.cue, mm: item.reading.rainfall_mm_since_last });
    return item;
  };
  const t0 = io.now();
  await d.backfill();
  assert.ok(io.now() - t0 >= 5 * MIN, "the fake back-fill should take >= 5 min");
  await d.story();
  assert.deepEqual(d.checks.filter((c) => !c.pass), [], st.lines.join("\n"));

  const river = taken.filter((r) => r.node === "NODE-04");
  const history = river.filter((r) => r.cue === "setup");
  const firstLive = river.find((r) => r.cue !== "setup");
  // the first live reading carries the rain of the whole gap (10 mm/h)
  const gapHr = (firstLive.at - history[history.length - 1].at) / (60 * MIN);
  assert.ok(gapHr > 17 / 60, `gap ${gapHr * 60} min`);
  assert.ok(Math.abs(firstLive.mm - 10 * gapHr) <= 0.002, `first live reading ${firstLive.mm} mm for ${gapHr * 60} min`);
  // the backend sums rain by taken time over the last hour: HIGH needs ~8 mm
  const cue3 = river.find((r) => r.cue === "3-confirm");
  const lastHour = river.filter((r) => r.at > cue3.at - 60 * MIN && r.at <= cue3.at);
  const mm = lastHour.reduce((a, r) => a + r.mm, 0);
  assert.ok(mm >= 9, `${mm.toFixed(2)} mm in the hour before ${"NODE-04"}'s first cue-3 reading`);

  // the raised cap was for that one round only: the paused-simulator guard is back
  assert.equal(d.creditGap, false);
  assert.equal(sim.opts.interval, Math.max(d.opts.interval, d.opts.pace));
  d.vclock += 2 * 60 * MIN; // a 2-hour stall
  taken.length = 0;
  await d.round(demo.NODES);
  const after = taken.find((r) => r.node === "NODE-04");
  const capMm = (80 * 2 * sim.opts.interval * demo.NODES.length) / 3600; // flood rain, capped gap
  assert.ok(after.mm <= capMm + 0.002, `${after.mm} mm after a 2 h stall (cap ${capMm.toFixed(3)})`);
});

test("a skipped back-fill (recent readings, no --fresh) is a FAIL that says why", async () => {
  const { st, io } = fakeStack();
  const at = st.now - 10 * MIN;
  st.rows.push({ id: 1, node_id: "NODE-07", reading_uid: "other-1", takenAt: at, timestamp: new Date(at).toISOString(),
    status: "logged" });
  const d = new Demo({ ...parseArgs(FAST, {}), runId: "skip" }, io);
  await d.backfill();
  const check = d.checks.find((c) => c.id === "backfill");
  assert.ok(check, "a backfill checkpoint is recorded");
  assert.equal(check.pass, false);
  assert.match(check.detail, /--fresh/);
  assert.match(check.detail, /siren|MEDIUM/);
  assert.equal(st.posts.length, 0, "no history was sent");
  assert.equal(d.creditGap, false, "no gap credit: it would dump 2 h of rain into one reading");
});

test("preflight warns when recent readings will make the back-fill skip", async () => {
  const { st, io } = fakeStack();
  const base = io.request;
  const json = (data) => ({ status: 200, data, text: JSON.stringify(data) });
  io.request = async (method, url, opts = {}) => {
    const u = new URL(url);
    if (u.pathname === "/api/status") return json({});
    if (u.pathname === "/api/health") return json({ models_loaded: true });
    if (u.pathname === "/api/nodes") return json(demo.NODES.map((node_id) => ({ node_id })));
    if (u.hostname.endsWith("openstreetmap.org")) return { status: 200, data: null, text: "" };
    return base(method, url, opts);
  };
  const d = new Demo({ ...parseArgs(FAST, {}), runId: "w" }, io);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sj-preflight-"));
  const warned = () => st.lines.some((l) => /\[warn\].*back-fill will be skipped.*--fresh/.test(l));
  try {
    await preflight(d, { varDir: tmp });
    assert.ok(!warned(), "no warning on a quiet stack");
    const at = st.now - 10 * MIN;
    st.rows.push({ id: 1, node_id: "NODE-INDB", reading_uid: "other-1", takenAt: at, timestamp: new Date(at).toISOString(),
      status: "logged" });
    await preflight(d, { varDir: tmp });
    assert.ok(warned(), st.lines.join("\n"));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("same seed, same readings; another seed, other readings", async () => {
  const a = payloads((await runStory(42)).st);
  const b = payloads((await runStory(42)).st);
  const c = payloads((await runStory(7)).st);
  assert.deepEqual(a, b);
  assert.notDeepEqual(a, c);
});

test("a refused device key stops the story with a hint", async () => {
  const { io } = fakeStack();
  const d = new Demo({ ...parseArgs([...FAST, "--key", "wrong"], {}), runId: "x" }, io);
  await assert.rejects(() => d.backfill(), /device key was refused.*--fresh/s);
});

test("preflight reports what is missing", async () => {
  const io = {
    now: () => 0, sleep: async () => {}, log: () => {},
    request: async () => { throw new Error("ECONNREFUSED"); },
  };
  const d = new Demo({ ...parseArgs([], {}), runId: "x" }, io);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sj-preflight-"));
  try {
    const problems = await preflight(d, { varDir: tmp });
    const text = problems.join("\n");
    assert.match(text, /web server .* not reachable/);
    assert.match(text, /AI backend .* not reachable/);
    assert.match(text, /missing in .*flood_model\.joblib/);
    assert.match(text, /no device key/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("--fresh copies var/ without readings, SOS, sessions or subscribers - and never writes the source", () => {
  const { DatabaseSync } = require("node:sqlite");
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "sj-src-var-"));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sj-fresh-"));
  try {
    const dbFile = path.join(src, "sanjeevni.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT);
      CREATE TABLE nodes (node_id TEXT PRIMARY KEY);
      CREATE TABLE readings (id INTEGER PRIMARY KEY, node_id TEXT);
      CREATE TABLE sensor_data (id INTEGER PRIMARY KEY, node_id TEXT);
      CREATE TABLE sos_requests (id INTEGER PRIMARY KEY, device_id TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_subscribers (phone TEXT);
      INSERT INTO users (username) VALUES ('officer1'), ('admin1');
      INSERT INTO nodes VALUES ('NODE-04'), ('NODE-07'), ('NODE-INDB');
      INSERT INTO readings (node_id) VALUES ('NODE-04'), ('NODE-07');
      INSERT INTO sensor_data (node_id) VALUES ('NODE-04');
      INSERT INTO sos_requests (device_id) VALUES ('dev-real-person');
      INSERT INTO sessions VALUES ('token');
      INSERT INTO whatsapp_subscribers VALUES ('+910000000000');
    `);
    require(path.join(__dirname, "..", "..", "server", "device_auth")).createDeviceKey(db, { name: "node-04", nodes: "NODE-04" });
    db.close();
    fs.mkdirSync(path.join(src, "models"));
    fs.writeFileSync(path.join(src, "models", "flood_model.joblib"), "model");
    const before = crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex");

    const { dir, key } = makeFreshVar(src, { tmpRoot, keyName: "judge-demo-test" });
    assert.ok(dir.startsWith(tmpRoot));
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex"), before, "source DB changed");
    assert.ok(fs.existsSync(path.join(dir, "models", "flood_model.joblib")));

    const copy = new DatabaseSync(path.join(dir, "sanjeevni.db"), { readOnly: true });
    const count = (t) => copy.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    assert.equal(count("users"), 2);
    assert.equal(count("nodes"), 3);
    for (const t of ["readings", "sensor_data", "sos_requests", "sessions", "whatsapp_subscribers"]) assert.equal(count(t), 0, t);
    const keys = copy.prepare("SELECT name, kind, nodes, key_hash FROM device_keys ORDER BY name").all();
    assert.deepEqual(keys.map((k) => k.name), ["judge-demo-test", "node-04"]); // the real key is kept
    const demoKey = keys.find((k) => k.name === "judge-demo-test");
    assert.equal(demoKey.kind, "simulator"); // the server forces simulated=true for it
    assert.equal(demoKey.nodes, "NODE-04,NODE-07,NODE-INDB");
    assert.equal(demoKey.key_hash, crypto.createHash("sha256").update(key).digest("hex"));
    copy.close();
  } finally {
    fs.rmSync(src, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("a stalled round (laptop asleep) is called out", async () => {
  const { st, io } = fakeStack();
  const d = new Demo({ ...parseArgs(FAST, {}), runId: "z" }, io);
  d.resetSensors(io.now());
  await d.round(demo.NODES);
  assert.ok(!st.lines.some((l) => /did the computer sleep/.test(l)));
  const sleep = io.sleep;
  io.sleep = async (ms) => { await sleep(ms); st.now += 42 * MIN; }; // Modern Standby during the wait
  await d.round(demo.NODES);
  assert.ok(st.lines.some((l) => /one round took \d+s - did the computer sleep/.test(l)), st.lines.join("\n"));
});
