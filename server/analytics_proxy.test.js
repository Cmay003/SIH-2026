// Tests for the officer analytics / report proxies, the node "latest
// values" endpoint and the public CAP routes (server.js, step W1).
// Run: node --test server/analytics_proxy.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, OFFICER_KEY } = require("./test_server");

let srv;
const officer = { "X-API-Key": OFFICER_KEY };
const day = (daysAgo) => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)).toISOString().slice(0, 10);
};
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

// A readings table shaped like backend_server.py's (only the columns used here).
function seedReadings(db) {
  db.exec(`CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, timestamp TEXT, status TEXT,
    severity TEXT, hazard_type TEXT, simulated INTEGER, link TEXT, sensor_faults TEXT, edge_anomaly TEXT,
    river_level_m REAL, river_level_rate_m_per_hr REAL, temp_c REAL, humidity_pct REAL, gas_ppm REAL, flame_reading REAL,
    pm25_ugm3 REAL, pm10_ugm3 REAL, tilt_angle_deg REAL, vibration_magnitude REAL, soil_moisture_pct REAL,
    water_ph REAL, turbidity_ntu REAL, rainfall_24h_mm REAL, battery_pct REAL, signal_strength_dbm REAL)`);
  const add = db.prepare(`INSERT INTO readings (id, node_id, timestamp, status, severity, hazard_type, simulated, link,
    sensor_faults, river_level_m, temp_c, pm25_ugm3, pm10_ugm3, soil_moisture_pct, battery_pct)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // NODE-A: id 2 is the newest by TIME (id 3 is an older backlog reading
  // that arrived later, id 4 an "untimed" one). Soil was in id 1 only; PM10
  // is a fault in the newest; tilt was never sent.
  add.run(1, "NODE-A", iso(600), "logged", "LOW", "flood", 1, "lora", null, 1.1, 24, 40, 80, 31, 90);
  add.run(2, "NODE-A", iso(10), "alert_dispatched", "HIGH", "air pollution", 1, "lora", "pm10_ugm3", 1.4, 25, 130, null, null, 88);
  add.run(3, "NODE-A", iso(3600), "logged", "LOW", "flood", 1, "lora", null, 0.9, 20, 10, 20, 30, 95);
  add.run(4, "NODE-A", iso(0), "untimed", null, null, 0, "lora", null, 9.9, 99, null, null, null, null);
  add.run(5, "NODE-B", iso(5), "pending_confirmation", "HIGH", "flood", 0, "wifi", null, 2.2, null, null, null, null, null);
  // NODE-D: a live reading (id 6), then a flash-queue backlog of 25 OLDER
  // readings that arrived after it (higher ids 7..31)
  add.run(6, "NODE-D", iso(30), "logged", "LOW", "flood", 0, "lora", null, 1.7, 26, null, null, null, 80);
  for (let i = 0; i < 25; i++) {
    add.run(7 + i, "NODE-D", iso(7200 + i * 60), "logged", "LOW", "flood", 0, "lora", null, 0.5, 18, null, null, null, 99);
  }
}

test.before(async () => {
  srv = await startTestServer({
    nodes: [["NODE-A", "Riverside", 29.4, 79.46], ["NODE-B", "Bridge", 29.41, 79.47]],
    users: { officer1: "officer", viewer1: "viewer" },
    env: { SANJEEVNI_ANALYTICS_TIMEOUT_MS: "800" },
    seed: seedReadings,
  });
});
test.after(async () => srv && srv.stop());

const get = (url, headers = officer) => srv.call("GET", url, undefined, headers);
const routes = () => srv.backend.state.routes;

const OFFICER_ROUTES = [
  "/api/officer/heatmap", "/api/officer/trends?node_id=NODE-A", "/api/officer/summary",
  "/api/officer/alerts/2/cap", "/api/officer/alerts/2/report.pdf", "/api/officer/timeline/NODE-A",
  "/api/officer/nodes/NODE-A/latest",
];

test("officer routes: 401 without a session, 403 for a viewer, never reach the backend", async () => {
  const before = srv.backend.state.requests.length;
  const viewer = { Cookie: await srv.login("viewer1") };
  for (const url of OFFICER_ROUTES) {
    assert.equal((await get(url, {})).status, 401, url);
    const v = await get(url, viewer);
    assert.equal(v.status, 403, url);
    assert.equal(v.data.error, "Officer role required");
  }
  assert.equal(srv.backend.state.requests.length, before);
});

test("heatmap: window cut per range, per-node hotspots ranked, key added server-side", async () => {
  routes()["/api/analytics/heatmap"] = { body: { count: 4, heatmap_data: [
    { node_id: "NODE-A", day: day(0), reading_count: 10, high_count: 4, medium_count: 2, max_risk_score: 0.8,
      location: "Riverside", latitude: 29.4, longitude: 79.46 },
    { node_id: "NODE-B", day: day(1), reading_count: 20, high_count: 0, medium_count: 4, max_risk_score: 0.5,
      location: "Bridge", latitude: 29.41, longitude: 79.47 },
    { node_id: "NODE-B", day: day(10), reading_count: 10, high_count: 10, medium_count: 0, max_risk_score: 0.95,
      location: "Bridge", latitude: 29.41, longitude: 79.47 },
    { node_id: "NODE-C", day: day(40), reading_count: 5, high_count: 5, medium_count: 0, max_risk_score: 1,
      location: "Old", latitude: null, longitude: null },
  ] } };
  const officerCookie = { Cookie: await srv.login("officer1") };
  const week = await get("/api/officer/heatmap?range=7d", officerCookie);
  assert.equal(week.status, 200);
  assert.equal(week.headers.get("cache-control"), "no-store");
  assert.equal(week.data.range, "7d");
  assert.equal(week.data.from_day, day(6));
  assert.match(week.data.data_note, /simulated/i);
  // this test database's readings table predates severity_source / confirmation:
  // the backend's unfiltered counts, and the note says forecasts inflate them
  assert.equal(week.data.source, "backend");
  assert.match(week.data.data_note, /forecast alerts .*inflate every node/);
  assert.deepEqual(week.data.hotspots.map((h) => [h.node_id, h.intensity, h.level]), [["NODE-A", 0.5, "high"], ["NODE-B", 0.1, "moderate"]]);
  assert.equal(week.data.heatmap_data.length, 2);
  // the browser never holds OFFICER_API_KEY; the server adds it upstream
  assert.equal(srv.backend.state.requests.at(-1).apiKey, OFFICER_KEY);

  const month = await get("/api/officer/heatmap"); // default 30d
  const b = month.data.hotspots.find((h) => h.node_id === "NODE-B");
  assert.deepEqual([b.reading_count, b.high_count, b.days_reported, b.days_with_high, b.max_risk_score], [30, 10, 2, 1, 0.95]);
  assert.equal(b.intensity, 0.4); // (10 + 0.5 * 4) / 30; NODE-A (0.5) stays first
  assert.equal(month.data.hotspots[0].node_id, "NODE-A");
  assert.ok(!month.data.hotspots.some((h) => h.node_id === "NODE-C"), "older than 30 days");

  assert.equal((await get("/api/officer/heatmap?range=1y")).status, 400);
  assert.equal((await get("/api/officer/heatmap?range=7d&range=30d")).status, 400);
  routes()["/api/analytics/heatmap"] = { body: { nope: true } };
  assert.equal((await get("/api/officer/heatmap")).status, 502);
});

test("trends / summary: validated, forwarded with their query, passed through", async () => {
  routes()["/api/analytics/trends"] = { body: { node_id: "NODE-A", range: "7d", series: [] } };
  routes()["/api/analytics/summary"] = { body: { range: "30d", alerts_by_hazard: {} } };
  const t = await get("/api/officer/trends?node_id=NODE-A&range=7d");
  assert.equal(t.status, 200);
  assert.equal(t.data.node_id, "NODE-A");
  assert.equal(srv.backend.state.requests.at(-1).url, "/api/analytics/trends?node_id=NODE-A&range=7d");
  assert.equal((await get("/api/officer/trends")).status, 400);
  assert.equal((await get("/api/officer/trends?node_id=../x")).status, 400);
  assert.equal((await get("/api/officer/trends?node_id=NODE-A&range=1y")).status, 400);
  const s = await get("/api/officer/summary?range=30d");
  assert.equal(s.data.range, "30d");
  assert.equal(srv.backend.state.requests.at(-1).url, "/api/analytics/summary?range=30d");
  assert.equal((await get("/api/officer/summary?range=24h")).status, 400);
});

test("CAP and PDF: right content types; ids validated; backend 404 detail passed on", async () => {
  routes()["/api/alerts/2/cap"] = { type: "application/xml", body: "<alert xmlns=\"urn:oasis:names:tc:emergency:cap:1.2\"/>" };
  const cap = await get("/api/officer/alerts/2/cap");
  assert.equal(cap.status, 200);
  assert.match(cap.headers.get("content-type"), /^application\/xml/);
  assert.match(cap.data, /cap:1\.2/);

  const pdfBytes = Buffer.from("%PDF-1.4 fake\n%%EOF");
  routes()["/api/reports/2/pdf"] = { type: "application/pdf", body: pdfBytes };
  const pdf = await fetch(`${srv.base}/api/officer/alerts/2/report.pdf`, { headers: officer });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get("content-type"), "application/pdf");
  assert.match(pdf.headers.get("content-disposition"), /attachment; filename="sanjeevni_situation_report_2\.pdf"/);
  assert.deepEqual(Buffer.from(await pdf.arrayBuffer()), pdfBytes);

  assert.equal((await get("/api/officer/alerts/0/cap")).status, 400);
  assert.equal((await get("/api/officer/alerts/abc/report.pdf")).status, 400);
  routes()["/api/alerts/9/cap"] = { status: 404, body: { detail: "Reading 9 is not an alert (status 'logged')" } };
  const missing = await get("/api/officer/alerts/9/cap");
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error, "Reading 9 is not an alert (status 'logged')");
});

test("timeline: node id / around_id / window validated and forwarded", async () => {
  routes()["/api/events/NODE-A/timeline"] = { body: { node_id: "NODE-A", count: 0, timeline: [] } };
  const ok = await get("/api/officer/timeline/NODE-A?around_id=2&window=40");
  assert.equal(ok.status, 200);
  assert.equal(srv.backend.state.requests.at(-1).url, "/api/events/NODE-A/timeline?around_id=2&window=40");
  assert.equal((await get("/api/officer/timeline/NODE-A?window=0")).status, 400);
  assert.equal((await get("/api/officer/timeline/NODE-A?around_id=-1")).status, 400);
  assert.equal((await get("/api/officer/timeline/WAY-TOO-LONG-NODE-ID")).status, 400);
});

test("backend problems: down -> 502, hang -> 504, key rejected -> 502 (never 401), old backend -> 502", async () => {
  routes()["/api/analytics/summary"] = { status: 401, body: { detail: "Invalid API key" } };
  const auth = await get("/api/officer/summary");
  assert.equal(auth.status, 502);
  assert.equal(auth.data.code, "backend_auth");

  routes()["/api/analytics/trends"] = { status: 404, body: { detail: "Not Found" } };
  const old = await get("/api/officer/trends?node_id=NODE-A");
  assert.equal(old.status, 502);
  assert.equal(old.data.code, "backend_outdated");

  routes()["/api/analytics/summary"] = { status: 500, body: "Internal Server Error", type: "text/plain" };
  assert.equal((await get("/api/officer/summary")).status, 502);

  routes()["/api/analytics/heatmap"] = { hang: true };
  const slow = await get("/api/officer/heatmap");
  assert.equal(slow.status, 504);
  assert.equal(slow.data.code, "backend_timeout");

  srv.backend.state.down = true;
  try {
    for (const url of OFFICER_ROUTES.filter((u) => !u.endsWith("/latest"))) {
      const r = await get(url);
      assert.equal(r.status, 502, url);
      assert.equal(r.data.code, "backend_unreachable", url);
    }
    // the latest values come from the shared database: still there
    assert.equal((await get("/api/officer/nodes/NODE-A/latest")).status, 200);
  } finally {
    srv.backend.state.down = false;
  }
});

test("latest node values: newest by reading time, per-field state, siren, no raw row", async () => {
  const r = await get("/api/officer/nodes/NODE-A/latest");
  assert.equal(r.status, 200);
  assert.equal(r.data.location, "Riverside");
  assert.equal(r.data.siren, null);
  const l = r.data.latest;
  assert.equal(l.reading_id, 2, "backlog row 3 is older; untimed row 4 is skipped");
  assert.equal(l.simulated, true);
  assert.equal(l.link, "lora");
  assert.deepEqual(l.sensor_faults, ["pm10_ugm3"]);
  assert.deepEqual(l.values.pm25_ugm3, { value: 130, state: "ok" });
  assert.equal(l.values.pm10_ugm3.state, "fault");
  assert.equal(l.values.pm10_ugm3.last_value, 80);
  assert.equal(l.values.soil_moisture_pct.state, "not_in_latest");
  assert.equal(l.values.soil_moisture_pct.last_value, 31, "the most recent earlier value, not the backlog one");
  assert.deepEqual(l.values.tilt_angle_deg, { value: null, state: "no_sensor" });
  assert.equal(l.values.river_level_m.value, 1.4);
  assert.equal(l.values.status, undefined);
  assert.equal(l.timestamp, undefined, "only whitelisted fields leave the server");

  // a backlog of 20+ older readings arriving after the live one never hides it
  const d = (await get("/api/officer/nodes/NODE-D/latest")).data.latest;
  assert.equal(d.reading_id, 6);
  assert.equal(d.values.river_level_m.value, 1.7);

  const none = await get("/api/officer/nodes/NODE-Z/latest");
  assert.equal(none.status, 200);
  assert.equal(none.data.latest, null);
  assert.equal((await get("/api/officer/nodes/bad%20id/latest")).status, 400);
});

test("public CAP: confirmed alerts only, no login; Atom feed passed through", async () => {
  const before = srv.backend.state.requests.length;
  routes()["/api/alerts/2/cap"] = { type: "application/xml", body: "<alert/>" };
  const ok = await get("/cap/alerts/2.xml", {});
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get("content-type"), /^application\/xml/);
  // pending (5), logged (1) and unknown ids: refused here, the backend is never asked
  const afterOk = srv.backend.state.requests.length;
  assert.equal(afterOk, before + 1);
  for (const id of [5, 1, 999]) assert.equal((await get(`/cap/alerts/${id}.xml`, {})).status, 404);
  assert.equal(srv.backend.state.requests.length, afterOk);
  assert.equal((await get("/cap/alerts/2.json", {})).status, 404);

  routes()["/api/cap/feed.atom"] = { type: "application/atom+xml", body: "<feed xmlns=\"http://www.w3.org/2005/Atom\"/>" };
  const feed = await get("/cap/feed.atom", {});
  assert.equal(feed.status, 200);
  assert.match(feed.headers.get("content-type"), /^application\/atom\+xml/);
  assert.match(feed.data, /2005\/Atom/);
});

test("public CAP: answers are cached in the server, so anonymous polling does not load the AI backend", async () => {
  routes()["/api/alerts/2/cap"] = { type: "application/xml", body: "<alert/>" };
  routes()["/api/cap/feed.atom"] = { type: "application/atom+xml", body: "<feed xmlns=\"http://www.w3.org/2005/Atom\"/>" };
  await get("/cap/feed.atom", {});
  await get("/cap/alerts/2.xml", {});
  const before = srv.backend.state.requests.length;
  const many = await Promise.all(Array.from({ length: 40 }, (_, i) => get(i % 2 ? "/cap/feed.atom" : "/cap/alerts/2.xml", {})));
  assert.ok(many.every((r) => r.status === 200), "cache hits are never rate limited");
  assert.equal(srv.backend.state.requests.length, before, "all 40 served from the cache");
  assert.match(many[1].data, /2005\/Atom/);
  assert.equal(many[1].headers.get("cache-control"), "public, max-age=60");
});
