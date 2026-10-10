// Tests for SOS location accuracy and the sensor-node SOS button (server.js).
// Run: node --test server/sos.test.js
//
// Starts a REAL server.js on a spare port with its own temporary var/
// folder (SANJEEVNI_VAR_DIR), and a tiny fake AI backend - so nothing
// touches the real database, and the "backend down" case can be forced.
// The user's own servers on 3000 / 8000 are never contacted.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { createDeviceKey } = require("./device_auth");

const OFFICER_KEY = "test-officer-key-not-secret";
const NODE_07 = { node_id: "NODE-07", location: "Upstream footbridge", latitude: 29.4002, longitude: 79.461 };

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

// Stand-in for backend_server.py: logs every reading it is sent. `down`
// drops the connection without an answer, like a stopped backend.
function fakeBackend() {
  const state = { down: false, received: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (state.down) return req.socket.destroy();
      const parsed = body ? JSON.parse(body) : {};
      const readings = req.url === "/api/ingest/batch" ? parsed.readings : [parsed];
      state.received.push(...readings);
      const results = readings.map((r) => ({ status: "logged", node_id: r.node_id, reading_uid: r.reading_uid ?? null,
        severity: "LOW", timestamp: new Date().toISOString() }));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/api/ingest/batch" ? { results } : results[0]));
    });
  });
  return { state, server };
}

let web;
let base;
let backend;
let varDir;
let keyAll;
let keyNode04;
let keySim;

test.before(async () => {
  varDir = fs.mkdtempSync(path.join(os.tmpdir(), "sanjeevni-sos-test-"));
  // The node registry belongs to backend_server.py; a minimal copy is enough here.
  const db = new DatabaseSync(path.join(varDir, "sanjeevni.db"));
  db.exec("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, location TEXT, latitude REAL, longitude REAL)");
  const addNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?)");
  for (const id of ["NODE-07", "NODE-08", "NODE-09", "NODE-04", "NODE-10"]) {
    addNode.run(id, id === "NODE-07" ? NODE_07.location : `Test site ${id}`, NODE_07.latitude, NODE_07.longitude);
  }
  addNode.run("NODE-NOPOS", "Unsurveyed hut", null, null); // registered without a position
  keyAll = createDeviceKey(db, { name: "test-gateway", nodes: "*" });
  keyNode04 = createDeviceKey(db, { name: "test-node-04", nodes: "NODE-04" });
  keySim = createDeviceKey(db, { name: "test-simulator", kind: "simulator", nodes: "*" }); // forces simulated=true
  db.close();

  backend = fakeBackend();
  await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      SANJEEVNI_VAR_DIR: varDir,
      SANJEEVNI_PORT: String(port),
      SANJEEVNI_BACKEND_URL: `http://127.0.0.1:${backend.server.address().port}`,
      OFFICER_API_KEY: OFFICER_KEY,
      ALLOW_UNAUTHENTICATED_INGEST: "0",
      // set (empty) so the project .env can't fill them in: no real WhatsApp calls from a test
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      FRONTEND: "classic",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  web.output = "";
  web.stdout.on("data", (d) => (web.output += d));
  web.stderr.on("data", (d) => (web.output += d));
  // Up to 30 s: on a busy machine (other test suites or a firmware compile
  // running) server.js has taken over 10 s to print anything at all.
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) return;
    } catch { /* not up yet */ }
    if (web.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server.js did not start:\n${web.output}`);
});

test.after(async () => {
  if (web && web.exitCode === null) {
    const gone = new Promise((r) => web.once("exit", r));
    web.kill();
    await gone;
  }
  await new Promise((r) => backend.server.close(r));
  fs.rmSync(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function call(method, url, body, headers = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}
const officerSos = async (all = false) =>
  (await call("GET", `/api/sos${all ? "?status=all" : ""}`, undefined, { "X-API-Key": OFFICER_KEY })).data;
const nodeSosRows = async (nodeId) =>
  (await officerSos(true)).data.filter((s) => s.location_source === "node" && s.note.includes(`node ${nodeId}`));
const webSos = (deviceId, extra) =>
  call("POST", "/api/sos", { latitude: 29.39, longitude: 79.45, device_id: deviceId, ...extra });
const batch = (key, readings) => call("POST", "/api/ingest/batch", { readings }, { "X-Device-Key": key });

// ---- (1) location accuracy -------------------------------------------------
test("location_accuracy_m is stored and returned on the officer feed", async () => {
  const res = await webSos("dev-acc-ok", { location_source: "gps", location_accuracy_m: 2300 });
  assert.equal(res.status, 201);
  const row = (await officerSos()).data.find((s) => s.id === res.data.sos_id);
  assert.equal(row.location_accuracy_m, 2300);
  assert.equal(row.location_source, "gps");
  assert.equal(row.node_id, null);
});

test("an invalid accuracy is stored as unknown - the SOS is never refused for it", async () => {
  for (const [i, bad] of ["35", -5, 5e6, true, { m: 1 }].entries()) {
    const res = await webSos(`dev-acc-bad-${i}`, { location_accuracy_m: bad });
    assert.equal(res.status, 201, `accuracy ${JSON.stringify(bad)} must not block the SOS`);
    const row = (await officerSos()).data.find((s) => s.id === res.data.sos_id);
    assert.equal(row.location_accuracy_m, null);
  }
});

test("no accuracy (older page) and manual points are stored as unknown; every row carries the field", async () => {
  const old = await webSos("dev-acc-none");
  const manual = await webSos("dev-acc-manual", { location_source: "manual", location_accuracy_m: 12 });
  assert.equal(old.status, 201);
  assert.equal(manual.status, 201);
  const feed = await officerSos();
  assert.equal(feed.data.find((s) => s.id === old.data.sos_id).location_accuracy_m, null);
  assert.equal(feed.data.find((s) => s.id === manual.data.sos_id).location_accuracy_m, null);
  assert.ok(feed.data.every((s) => "location_accuracy_m" in s));
  // stored as unknown WITH a console warning (contract), the manual point without one
  assert.match(web.output, /device-location SOS without location_accuracy_m/);
});

test("the web endpoint still only accepts gps / manual, and never a node: device id", async () => {
  assert.equal((await webSos("dev-src-node", { location_source: "node" })).status, 400);
  assert.equal((await webSos("node:NODE-07")).status, 400); // would block that node's real button SOS
  assert.deepEqual((await call("GET", "/api/sos/device/node%3ANODE-07")).data, { active: false });
});

// ---- (2) SOS button on a sensor node ---------------------------------------
test("a batch reading with sos_button files an SOS at the node's position", async () => {
  const res = await batch(keyAll, [
    { node_id: "NODE-04", reading_uid: "n04-1", river_level_m: 1.2 },
    { node_id: "NODE-07", reading_uid: "n07-press-1", river_level_m: 1.3, sos_button: true, age_seconds: 600 },
  ]);
  assert.equal(res.status, 200);
  const rows = await nodeSosRows("NODE-07");
  assert.equal(rows.length, 1);
  const sos = rows[0];
  assert.equal(sos.status, "open");
  assert.equal(sos.latitude, NODE_07.latitude);
  assert.equal(sos.longitude, NODE_07.longitude);
  assert.equal(sos.location_accuracy_m, null);
  assert.equal(sos.node_id, "NODE-07");
  assert.equal(sos.note, "SOS button pressed on sensor node NODE-07 (Upstream footbridge) - pressed about 10 min ago");
  // the reading itself still reaches the AI backend, flag included
  assert.ok(backend.state.received.some((r) => r.reading_uid === "n07-press-1" && r.sos_button === true));
});

test("the same reading_uid again (retry / replay) never files a second SOS - not even after resolve", async () => {
  await batch(keyAll, [{ node_id: "NODE-07", reading_uid: "n07-press-1", sos_button: true }]);
  await batch(keyAll, [{ node_id: "NODE-07", reading_uid: "n07-press-1", sos_button: true }]);
  let rows = await nodeSosRows("NODE-07");
  assert.equal(rows.length, 1);
  // a second, different press while the first is open: the existing 409 path
  await batch(keyAll, [{ node_id: "NODE-07", reading_uid: "n07-press-2", sos_button: true }]);
  assert.equal((await nodeSosRows("NODE-07")).length, 1);

  await call("POST", `/api/sos/${rows[0].id}/resolve`, undefined, { "X-API-Key": OFFICER_KEY });
  for (const uid of ["n07-press-1", "n07-press-2"]) {
    await batch(keyAll, [{ node_id: "NODE-07", reading_uid: uid, sos_button: true }]);
  }
  rows = await nodeSosRows("NODE-07");
  assert.equal(rows.length, 1, "a replay after resolve must not reopen");
  // a genuinely new press after the officer resolved it is a new SOS
  await batch(keyAll, [{ node_id: "NODE-07", reading_uid: "n07-press-3", sos_button: true }]);
  rows = await nodeSosRows("NODE-07");
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((s) => s.status === "open").length, 1);
});

test("a key not allowed for the node files no SOS", async () => {
  const denied = await batch(keyNode04, [{ node_id: "NODE-09", reading_uid: "n09-x", sos_button: true }]);
  assert.equal(denied.status, 403);
  const mixed = await batch(keyNode04, [
    { node_id: "NODE-04", reading_uid: "n04-2" },
    { node_id: "NODE-09", reading_uid: "n09-y", sos_button: true },
  ]);
  assert.equal(mixed.status, 200);
  const single = await call("POST", "/api/ingest", { node_id: "NODE-09", reading_uid: "n09-z", sos_button: true },
    { "X-Device-Key": keyNode04 });
  assert.equal(single.status, 403);
  assert.equal((await nodeSosRows("NODE-09")).length, 0);
  // sos_button must be exactly true
  await batch(keyAll, [{ node_id: "NODE-09", reading_uid: "n09-str", sos_button: "true" }]);
  assert.equal((await nodeSosRows("NODE-09")).length, 0);
});

test("a node without a registered position: stored, kept off the map, listed as unlocated", async () => {
  await batch(keyAll, [
    { node_id: "NODE-NOPOS", reading_uid: "np-1", sos_button: true },
    { node_id: "NODE-GHOST", reading_uid: "gh-1", sos_button: true }, // not in the registry at all
  ]);
  await batch(keyAll, [{ node_id: "NODE-NOPOS", reading_uid: "np-2", sos_button: true }]); // second press
  const feed = await officerSos();
  assert.ok(!feed.data.some((s) => s.note && s.note.includes("NODE-NOPOS")), "no pin without a position");
  const unlocated = feed.unlocated_node_sos.filter((s) => s.node_id === "NODE-NOPOS");
  assert.equal(unlocated.length, 1, "one open SOS per node, also without a position");
  assert.match(unlocated[0].note, /SOS button pressed on sensor node NODE-NOPOS \(Unsurveyed hut\)/);
  assert.ok(feed.unlocated_node_sos.some((s) => s.node_id === "NODE-GHOST"));
  assert.ok(feed.invalid_location_count >= 2);
  assert.match(web.output, /NODE-NOPOS, which has NO registered position/);
});

test("a resolved unlocated node SOS is history: no banner, and not logged as 'invalid coordinates'", async () => {
  const [open] = (await officerSos()).unlocated_node_sos.filter((s) => s.node_id === "NODE-NOPOS");
  await call("POST", `/api/sos/${open.id}/resolve`, undefined, { "X-API-Key": OFFICER_KEY });
  const all = await officerSos(true);
  assert.ok(!all.unlocated_node_sos.some((s) => s.id === open.id));
  assert.doesNotMatch(web.output, new RegExp(`SOS #${open.id} has invalid coordinates`));
});

test("a real press never joins an open SIMULATED SOS on the same node", async () => {
  // the judge demo / simulation.js leaves a test SOS open on a real-looking node
  await batch(keySim, [{ node_id: "NODE-10", reading_uid: "same-uid", sos_button: true }]);
  let rows = await nodeSosRows("NODE-10");
  assert.equal(rows.length, 1);
  assert.match(rows[0].note, /SIMULATED/);
  const simId = rows[0].id;

  // a real button press - even with the same uid as the test one - opens its own SOS
  await batch(keyAll, [{ node_id: "NODE-10", reading_uid: "same-uid", sos_button: true }]);
  rows = await nodeSosRows("NODE-10");
  assert.equal(rows.length, 2, "the real press is a new SOS, not folded into the test one");
  const real = rows.find((s) => s.id !== simId);
  assert.equal(real.status, "open");
  assert.doesNotMatch(real.note, /SIMULATED/);
  assert.equal(rows.find((s) => s.id === simId).status, "superseded");

  // a further test press while the real SOS is open joins it (harmless), and
  // resolving it does not swallow the real press's retries into a new SOS either
  await batch(keySim, [{ node_id: "NODE-10", reading_uid: "sim-2", sos_button: true }]);
  rows = await nodeSosRows("NODE-10");
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((s) => s.status === "open").length, 1);
  await batch(keyAll, [{ node_id: "NODE-10", reading_uid: "same-uid", sos_button: true }]); // real retry
  assert.equal((await nodeSosRows("NODE-10")).length, 2);
});

test("the AI backend down: the node SOS is still filed, and the retry does not duplicate it", async () => {
  backend.state.down = true;
  try {
    const reading = { node_id: "NODE-08", reading_uid: "n08-press", sos_button: true };
    const first = await call("POST", "/api/ingest", reading, { "X-Device-Key": keyAll });
    assert.ok(first.status >= 500, "the node is told to keep the reading queued");
    const retry = await batch(keyAll, [reading]);
    assert.ok(retry.status >= 500);
  } finally {
    backend.state.down = false;
  }
  const rows = await nodeSosRows("NODE-08");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].location_source, "node");
  // backend back up: the queued reading goes through, still one SOS
  const later = await batch(keyAll, [{ node_id: "NODE-08", reading_uid: "n08-press", sos_button: true }]);
  assert.equal(later.status, 200);
  assert.equal((await nodeSosRows("NODE-08")).length, 1);
});
