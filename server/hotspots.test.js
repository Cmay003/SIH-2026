// Tests for the officer hotspot map counts (server.js /api/officer/heatmap)
// read from the shared readings table: forecast-only and unconfirmed
// alerts never make a node a hotspot (review 2026-10-09).
// Run: node --test server/hotspots.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, OFFICER_KEY } = require("./test_server");

let srv;
const officer = { "X-API-Key": OFFICER_KEY };
const iso = (secondsAgo) => new Date(Date.now() - secondsAgo * 1000).toISOString();

// A readings table with the columns backend_server.py has added since
// 2026-10-09 (severity_source, confirmation) - so the server counts itself.
function seedReadings(db) {
  db.exec(`CREATE TABLE readings (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, timestamp TEXT, status TEXT,
    severity TEXT, hazard_type TEXT, risk_score REAL, simulated INTEGER, severity_source TEXT, confirmation TEXT)`);
  const add = db.prepare(`INSERT INTO readings (node_id, timestamp, status, severity, hazard_type, risk_score, simulated,
    severity_source, confirmation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  // One regional rain forecast: every node gets forecast-only HIGH heavy_rain alerts
  for (const node of ["NODE-A", "NODE-B", "NODE-C"]) {
    for (let i = 0; i < 4; i++) {
      add.run(node, iso(600 + i * 60), "alert_dispatched", "HIGH", "heavy_rain", 0.7, 1, "weather_forecast", "forecast");
    }
    add.run(node, iso(300), "logged", "LOW", "flood", 0.1, 1, "ml_model", null);
  }
  // NODE-A also MEASURED a confirmed CRITICAL flood (2 readings)
  add.run("NODE-A", iso(120), "alert_dispatched", "CRITICAL", "flood", 0.95, 1, "ml_model", "persistent");
  add.run("NODE-A", iso(60), "alert_dispatched", "CRITICAL", "flood", 0.93, 1, "ml_model", "persistent");
  // NODE-B: an UNCONFIRMED (pending) HIGH, a suppressed sensor-fault row and
  // an untimed backlog row - none of them elevated, the last two not readings
  add.run("NODE-B", iso(90), "pending_confirmation", "HIGH", "flood", 0.8, 1, "ml_model", "unconfirmed");
  add.run("NODE-B", iso(80), "suppressed", "CRITICAL", "flood", 0.99, 1, "ml_model", null);
  add.run("NODE-B", iso(0), "untimed", "CRITICAL", "flood", 0.99, 1, "ml_model", null);
  // outside the 7-day window
  add.run("NODE-C", iso(20 * 86400), "alert_dispatched", "CRITICAL", "flood", 0.9, 1, "ml_model", "persistent");
}

test.before(async () => {
  srv = await startTestServer({
    nodes: [["NODE-A", "Riverside", 29.4, 79.46], ["NODE-B", "Bridge", 29.41, 79.47], ["NODE-C", "Market", 29.42, 79.48]],
    users: { officer1: "officer" },
    seed: seedReadings,
  });
});
test.after(async () => srv && srv.stop());

test("hotspots: forecast-only and unconfirmed alerts never make a node a hotspot", async () => {
  const before = srv.backend.state.requests.length;
  const r = await srv.call("GET", "/api/officer/heatmap?range=7d", undefined, officer);
  assert.equal(r.status, 200);
  assert.equal(r.data.source, "readings");
  assert.match(r.data.basis, /forecast alerts .* not counted/);
  // the stable hotspot definition, in words (server.js HOTSPOT_DEFINITION)
  assert.match(r.data.definition, /^A hotspot is a node where hazards keep coming back\. Intensity = \(confirmed HIGH or CRITICAL/);
  assert.equal(srv.backend.state.requests.length, before, "counted from the shared database, no backend call");
  const by = Object.fromEntries(r.data.hotspots.map((h) => [h.node_id, h]));

  // NODE-A: 4 forecast + 1 LOW + 2 measured CRITICAL = 7 readings, 2 elevated
  assert.equal(by["NODE-A"].reading_count, 7);
  assert.equal(by["NODE-A"].high_count, 2);
  assert.equal(by["NODE-A"].max_risk_score, 0.95);
  assert.equal(by["NODE-A"].location, "Riverside");
  assert.equal(by["NODE-A"].latitude, 29.4);
  assert.equal(by["NODE-A"].level, "moderate"); // 2/7 = 0.286

  // NODE-B: the forecast and the pending HIGH count as readings, not as elevated;
  // suppressed + untimed rows are not counted at all
  assert.equal(by["NODE-B"].reading_count, 6);
  assert.equal(by["NODE-B"].high_count, 0);
  assert.equal(by["NODE-B"].level, "low");
  assert.equal(by["NODE-B"].max_risk_score, 0.8, "the forecast's 0.7 and the suppressed 0.99 are not the node's risk");

  // NODE-C: forecast only (its old CRITICAL is outside the window)
  assert.equal(by["NODE-C"].high_count, 0);
  assert.equal(by["NODE-C"].level, "low");
  assert.equal(r.data.hotspots[0].node_id, "NODE-A");
  const dayRow = r.data.heatmap_data.find((d) => d.node_id === "NODE-C");
  assert.equal(dayRow.forecast_alert_count, 4);
});
