// Tests for step W2: the officer trends/reports page guard, the confirmed
// alert list (GET /api/officer/alerts), the alert_id that hazard cards and
// zones now carry (for their CAP XML / PDF report / timeline buttons) and
// the public CAP routes' caching.
// Run: node --test server/trends_reports.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const fs = require("fs");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, OFFICER_KEY } = require("./test_server");

let srv;
const officer = { "X-API-Key": OFFICER_KEY };
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();
const DAY = 86400;

// readings (backend_server.py's table, only the columns used) + the
// dashboard's sensor_data rows for the same alerts.
function seed(db) {
  db.exec(`CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, timestamp TEXT, status TEXT,
    severity TEXT, hazard_type TEXT, risk_score REAL, simulated INTEGER, message TEXT)`);
  const add = db.prepare(`INSERT INTO readings (id, node_id, timestamp, status, severity, hazard_type, risk_score, simulated, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'secret free text')`);
  add.run(1, "NODE-A", iso(40 * DAY), "alert_dispatched", "HIGH", "flood", 0.8, 0); // older than 30 days
  add.run(2, "NODE-A", iso(3 * DAY), "alert_dispatched", "HIGH", "flood", 0.81, 1); // inside 7d
  add.run(3, "NODE-A", iso(600), "alert_dispatched", "CRITICAL", "flood", 0.95, 1); // newest flood alert for A
  add.run(4, "NODE-B", iso(300), "pending_confirmation", "HIGH", "flood", 0.7, 0);
  add.run(5, "NODE-B", iso(20 * DAY), "alert_dispatched", "MEDIUM", "air pollution", 0.5, 0);
  add.run(6, "NODE-A", iso(60), "logged", "LOW", "flood", 0.1, 1);
  add.run(7, "NODE-A", "not a time", "alert_dispatched", "HIGH", "fire", 0.9, 0); // unparseable: never listed
  // A store-and-forward backlog row: higher id, older reading time
  add.run(8, "NODE-B", iso(2 * DAY), "alert_dispatched", "HIGH", "fire", 0.9, 0);

  db.exec(`CREATE TABLE sensor_data (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, location TEXT, hazard_type TEXT,
    severity TEXT, risk_score REAL, river_level_m REAL, temp_c REAL, humidity_pct REAL, gas_ppm REAL, status TEXT,
    message TEXT, eta_minutes REAL, predicted_time TEXT, latitude REAL, longitude REAL, timestamp TEXT)`);
  const dash = db.prepare(`INSERT INTO sensor_data (node_id, location, hazard_type, severity, risk_score, status,
    latitude, longitude, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  dash.run("NODE-A", "Riverside", "flood", "CRITICAL", 0.95, "alert_dispatched", 29.4, 79.46, iso(600));
  dash.run("NODE-B", "Bridge", "flood", "HIGH", 0.7, "pending_confirmation", 29.41, 79.47, iso(300));
}

test.before(async () => {
  srv = await startTestServer({
    nodes: [["NODE-A", "Riverside", 29.4, 79.46], ["NODE-B", "Bridge", 29.41, 79.47]],
    users: { officer1: "officer", admin1: "admin", viewer1: "viewer" },
    // CAP answers uncached here: this file swaps the fake backend's answers
    // between requests (the cache is tested in analytics_proxy.test.js)
    env: { SANJEEVNI_ANALYTICS_TIMEOUT_MS: "800", SANJEEVNI_CAP_CACHE_MS: "0" },
    seed,
  });
});
test.after(async () => srv && srv.stop());

const get = (url, headers = officer) => srv.call("GET", url, undefined, headers);

test("confirmed alert list: officers/admins only, never touches the backend", async () => {
  const before = srv.backend.state.requests.length;
  assert.equal((await get("/api/officer/alerts", {})).status, 401);
  const viewer = await get("/api/officer/alerts", { Cookie: await srv.login("viewer1") });
  assert.equal(viewer.status, 403);
  const admin = await get("/api/officer/alerts", { Cookie: await srv.login("admin1") });
  assert.equal(admin.status, 200);
  assert.equal(srv.backend.state.requests.length, before, "read from the shared database");
});

test("confirmed alert list: range + node filter, newest reading time first, whitelisted fields", async () => {
  const week = await get("/api/officer/alerts"); // default 7d
  assert.equal(week.status, 200);
  assert.equal(week.headers.get("cache-control"), "no-store");
  assert.equal(week.data.range, "7d");
  // 8 (2 days old) arrived after 3 (10 min old) but is older: time order, not id order
  assert.deepEqual(week.data.alerts.map((a) => a.id), [3, 8, 2]);
  const a3 = week.data.alerts[0];
  assert.deepEqual(a3, {
    id: 3, node_id: "NODE-A", location: "Riverside", timestamp: a3.timestamp, hazard_type: "flood",
    severity: "CRITICAL", risk_score: 0.95, simulated: true,
  });
  assert.equal(a3.message, undefined, "no free text / raw row leaves the server");

  const month = await get("/api/officer/alerts?range=30d");
  assert.deepEqual(month.data.alerts.map((a) => a.id), [3, 8, 2, 5]);
  const day = await get("/api/officer/alerts?range=24h&node_id=NODE-A");
  assert.deepEqual(day.data.alerts.map((a) => a.id), [3]);
  assert.equal(day.data.node_id, "NODE-A");
  const nodeB = await get("/api/officer/alerts?range=30d&node_id=NODE-B&limit=1");
  assert.deepEqual(nodeB.data.alerts.map((a) => a.id), [8]);
  assert.equal(nodeB.data.count, 1);

  for (const bad of ["range=1y", "node_id=../x", "limit=0", "limit=201", "limit=abc", "range=7d&range=30d"]) {
    assert.equal((await get(`/api/officer/alerts?${bad}`)).status, 400, bad);
  }
});

test("hazard cards and zones carry the confirmed alert's readings id (null while pending)", async () => {
  const hazards = await get("/api/hazards");
  assert.equal(hazards.status, 200);
  const a = hazards.data.hazards.find((h) => h.node_id === "NODE-A");
  assert.equal(a.alert_id, 3, "newest confirmed flood row for NODE-A");
  assert.ok(!hazards.data.hazards.some((h) => h.node_id === "NODE-B"), "pending is not a public hazard");

  const zones = await get("/api/hazard-zones?include_pending=1");
  const byNode = Object.fromEntries(zones.data.zones.map((z) => [z.node_id, z]));
  assert.equal(byNode["NODE-A"].alert_id, 3);
  assert.equal(byNode["NODE-B"].confirmed, false);
  assert.equal(byNode["NODE-B"].alert_id, null);
  // public zones (no login): confirmed only, same id - the public CAP link needs it
  const pub = await get("/api/hazard-zones", {});
  assert.deepEqual(pub.data.zones.map((z) => [z.node_id, z.alert_id]), [["NODE-A", 3]]);
});

test("trends page: login required, officer/admin only", async () => {
  const anon = await fetch(`${srv.base}/trends.html`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.match(anon.headers.get("location"), /^\/login\.html\?next=%2Ftrends\.html/);
  const viewer = await fetch(`${srv.base}/trends.html`, { redirect: "manual", headers: { Cookie: await srv.login("viewer1") } });
  assert.equal(viewer.status, 302);
  assert.equal(viewer.headers.get("location"), "/?denied=officer");
  // the encoded-name trick (B-series) is matched too
  const sneaky = await fetch(`${srv.base}/trends%2Ehtml`, { redirect: "manual" });
  assert.equal(sneaky.status, 302);
});

test("trends page: served with the strict CSP when the React build has it", async (t) => {
  if (!fs.existsSync(path.join(__dirname, "..", "frontend", "dist", "trends.html"))) {
    t.skip("frontend/dist not built - run npm run build in frontend/");
    return;
  }
  const react = await startTestServer({ users: { officer1: "officer" }, env: { FRONTEND: "" } });
  try {
    const res = await fetch(`${react.base}/trends.html`, { redirect: "manual", headers: { Cookie: await react.login("officer1") } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy"), /script-src 'self'/);
    assert.equal(res.headers.get("cache-control"), "no-store");
    assert.match(await res.text(), /<div id="root">/);
  } finally {
    await react.stop();
  }
});

test("public CAP: no login, 60 s public cache, confirmed only; feed errors stay JSON", async () => {
  const routes = srv.backend.state.routes;
  routes["/api/alerts/3/cap"] = { type: "application/xml", body: "<alert xmlns=\"urn:oasis:names:tc:emergency:cap:1.2\"/>" };
  const cap = await get("/cap/alerts/3.xml", {});
  assert.equal(cap.status, 200);
  assert.equal(cap.headers.get("cache-control"), "public, max-age=60");
  assert.equal((await get("/cap/alerts/4.xml", {})).status, 404, "pending");
  assert.equal((await get("/cap/alerts/6.xml", {})).status, 404, "logged");

  routes["/api/cap/feed.atom"] = { type: "application/atom+xml", body: "<feed xmlns=\"http://www.w3.org/2005/Atom\"/>" };
  const feed = await get("/cap/feed.atom", {});
  assert.equal(feed.status, 200);
  assert.equal(feed.headers.get("cache-control"), "public, max-age=60");
  routes["/api/cap/feed.atom"] = { status: 404, body: { detail: "Not Found" } };
  const old = await get("/cap/feed.atom", {});
  assert.equal(old.status, 502);
  assert.equal(old.data.code, "backend_outdated");
});

// Keep LAST in this file: it uses up this network's CAP miss allowance.
test("public CAP: requests that reach the AI backend are rate limited per network", async () => {
  const routes = srv.backend.state.routes;
  routes["/api/cap/feed.atom"] = { type: "application/atom+xml", body: "<feed xmlns=\"http://www.w3.org/2005/Atom\"/>" };
  const statuses = [];
  for (let i = 0; i < 32; i++) statuses.push((await get("/cap/feed.atom", {})).status); // cache off in this file
  assert.ok(statuses.slice(0, 25).every((s) => s === 200), statuses.join(","));
  const limited = await get("/cap/feed.atom", {});
  assert.equal(limited.status, 429);
  assert.equal(limited.data.code, "rate_limited");
  assert.equal(limited.headers.get("retry-after"), "60");
});
