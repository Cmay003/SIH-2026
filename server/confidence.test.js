// Tests for the per-alert confidence score (confidence.js + server.js):
// cleaning what the AI backend sends, storing it in sensor_data, returning
// it on /api/hazards, /api/hazard-zones and the dashboard feed, old rows
// staying null, and the label in the WhatsApp alert text.
// Run: node --test server/confidence.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, OFFICER_KEY } = require("./test_server");
const { cleanConfidence, confidenceColumns, confidenceFromRow, confidenceSummary } = require("./confidence");

const POS = [29.4002, 79.461];
const SUBSCRIBER = "+910000000001"; // never a real number: WhatsApp runs in dry-run in tests

// ---------------------------------------------------------------- pure helpers

test("cleanConfidence keeps a contract-shaped result as it is", () => {
  assert.deepEqual(
    cleanConfidence({ confidence: 0.82, confidence_label: "High", confidence_reasons: ["confirmed by neighbour node", "edge verdict agrees"] }),
    { confidence: 0.82, confidence_label: "High", confidence_reasons: ["confirmed by neighbour node", "edge verdict agrees"] },
  );
});

test("cleanConfidence drops what does not match the contract instead of guessing", () => {
  assert.deepEqual(cleanConfidence({}), { confidence: null, confidence_label: null, confidence_reasons: null });
  assert.deepEqual(cleanConfidence(null), { confidence: null, confidence_label: null, confidence_reasons: null });
  // out of range is a bug, not "very sure" / "very unsure"
  for (const bad of [1.7, -0.1, 82, NaN, Infinity, "0.8", true]) {
    assert.equal(cleanConfidence({ confidence: bad }).confidence, null, String(bad));
  }
  assert.equal(cleanConfidence({ confidence: 0 }).confidence, 0);
  assert.equal(cleanConfidence({ confidence: 1 }).confidence, 1);
  assert.equal(cleanConfidence({ confidence: 0.123456 }).confidence, 0.123);
  assert.equal(cleanConfidence({ confidence_label: "medium" }).confidence_label, "Medium");
  assert.equal(cleanConfidence({ confidence_label: " LOW " }).confidence_label, "Low");
  assert.equal(cleanConfidence({ confidence_label: "Certain" }).confidence_label, null);
  assert.equal(cleanConfidence({ confidence_label: "constructor" }).confidence_label, null);
});

test("reasons become short single-line strings, at most 8", () => {
  const { confidence_reasons: r } = cleanConfidence({
    confidence_reasons: ["a\nb\tc", "", "   ", 7, null, "x".repeat(300), ...Array.from({ length: 20 }, (_, i) => `r${i}`)],
  });
  assert.equal(r.length, 8);
  assert.equal(r[0], "a b c");
  assert.equal(r[1].length, 120);
  assert.ok(r[1].endsWith("..."));
  assert.equal(r[2], "r0");
  // a single string is one reason; an empty list stays an empty list
  assert.deepEqual(cleanConfidence({ confidence_reasons: "pending confirmation" }).confidence_reasons, ["pending confirmation"]);
  assert.deepEqual(cleanConfidence({ confidence_reasons: [] }).confidence_reasons, []);
});

test("columns round-trip through a stored row; old rows and broken JSON give nulls", () => {
  const ai = { confidence: 0.4, confidence_label: "Low", confidence_reasons: ["pending confirmation"] };
  const [score, label, reasons] = confidenceColumns(ai);
  assert.deepEqual([score, label, reasons], [0.4, "Low", '["pending confirmation"]']);
  assert.deepEqual(confidenceFromRow({ confidence: score, confidence_label: label, confidence_reasons: reasons }), cleanConfidence(ai));
  assert.deepEqual(confidenceFromRow({}), { confidence: null, confidence_label: null, confidence_reasons: null });
  assert.equal(confidenceFromRow({ confidence_reasons: "{not json" }).confidence_reasons, null);
  assert.equal(confidenceFromRow({ confidence_reasons: '{"a":1}' }).confidence_reasons, null);
  assert.deepEqual(confidenceColumns({}), [null, null, null]);
});

test("confidenceSummary: label and percent when both are there", () => {
  assert.equal(confidenceSummary({ confidence: 0.82, confidence_label: "High" }), "High (82%)");
  assert.equal(confidenceSummary({ confidence_label: "Medium" }), "Medium");
  assert.equal(confidenceSummary({ confidence: 0.5 }), "50%");
  assert.equal(confidenceSummary({}), null);
});

// ---------------------------------------------------------------- real server

let srv;
test.before(async () => {
  srv = await startTestServer({
    nodes: ["CONF-01", "CONF-02", "CONF-03", "OLD-01"].map((id) => [id, `Site ${id}`, ...POS]),
    keys: { gateway: { nodes: "*" } },
    users: { viewer1: "viewer" },
    seed(db) {
      // sensor_data as a server.js from before the confidence columns left it,
      // with one active confirmed hazard on it
      db.exec(`CREATE TABLE sensor_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, location TEXT, hazard_type TEXT,
        severity TEXT, risk_score REAL, river_level_m REAL, temp_c REAL, humidity_pct REAL,
        gas_ppm REAL, status TEXT, message TEXT, eta_minutes REAL, predicted_time TEXT,
        latitude REAL, longitude REAL, timestamp TEXT)`);
      db.prepare(`INSERT INTO sensor_data (node_id, location, hazard_type, severity, risk_score, status, latitude, longitude, timestamp)
                  VALUES ('OLD-01', 'Old site', 'fire', 'HIGH', 0.7, 'alert_dispatched', ?, ?, ?)`)
        .run(...POS, new Date().toISOString());
      // one opted-in WhatsApp subscriber right at the nodes
      db.exec(`CREATE TABLE whatsapp_subscribers (phone TEXT PRIMARY KEY, latitude REAL, longitude REAL, status TEXT, updated_at TEXT)`);
      db.prepare("INSERT INTO whatsapp_subscribers VALUES (?, ?, ?, 'active', ?)").run(SUBSCRIBER, ...POS, new Date().toISOString());
    },
  });
});
test.after(async () => srv && srv.stop());

const officer = { "X-API-Key": OFFICER_KEY };
let uid = 0;
const batch = (readings) => srv.call("POST", "/api/ingest/batch", { readings }, { "X-Device-Key": srv.keys.gateway });
const reading = (nodeId, severity, status, extra = {}) => ({
  node_id: nodeId, reading_uid: `c${++uid}`, river_level_m: 1.0,
  test_severity: severity, test_status: status, test_extra: { latitude: POS[0], longitude: POS[1], ...extra },
});
const HIGH_CONF = { confidence: 0.82, confidence_label: "High", confidence_reasons: ["confirmed by repeat reading", "node edge verdict agrees"] };

test("confidence is stored and returned on /api/hazards and /api/hazard-zones", async () => {
  const res = await batch([reading("CONF-01", "CRITICAL", "alert_dispatched", HIGH_CONF)]);
  assert.equal(res.status, 200);

  const hazards = (await srv.call("GET", "/api/hazards")).data.hazards;
  const h = hazards.find((x) => x.node_id === "CONF-01");
  assert.equal(h.confidence, 0.82);
  assert.equal(h.confidence_label, "High");
  assert.deepEqual(h.confidence_reasons, HIGH_CONF.confidence_reasons);

  const zones = (await srv.call("GET", "/api/hazard-zones")).data.zones;
  const z = zones.find((x) => x.node_id === "CONF-01");
  assert.equal(z.confidence_label, "High");
  assert.deepEqual(z.confidence_reasons, HIGH_CONF.confidence_reasons);
});

test("a pending alert carries its (lower) confidence to the officer map only", async () => {
  await batch([reading("CONF-02", "HIGH", "pending_confirmation", {
    confidence: 0.35, confidence_label: "Low", confidence_reasons: ["waiting for confirmation"],
  })]);
  const pub = (await srv.call("GET", "/api/hazard-zones")).data.zones;
  assert.ok(!pub.some((z) => z.node_id === "CONF-02"), "pending stays off the public map");
  const off = (await srv.call("GET", "/api/hazard-zones?include_pending=1", undefined, officer)).data.zones;
  const z = off.find((x) => x.node_id === "CONF-02");
  assert.equal(z.confirmed, false);
  assert.equal(z.confidence, 0.35);
  assert.equal(z.confidence_label, "Low");
});

test("severity order is unchanged by confidence: a CRITICAL with Low confidence still lists first", async () => {
  await batch([reading("CONF-03", "CRITICAL", "alert_dispatched", { confidence: 0.2, confidence_label: "Low", confidence_reasons: [] })]);
  // the list stays in the server's risk order; confidence is shown, never sorted on
  const hazards = (await srv.call("GET", "/api/hazards")).data.hazards;
  const scores = hazards.map((x) => x.risk_score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  const low = hazards.find((x) => x.node_id === "CONF-03");
  assert.equal(low.severity, "CRITICAL");
  assert.equal(low.confidence_label, "Low");
  assert.deepEqual(low.confidence_reasons, []);
});

test("a row from before the confidence columns comes back with nulls", async () => {
  const hazards = (await srv.call("GET", "/api/hazards")).data.hazards;
  const old = hazards.find((x) => x.node_id === "OLD-01");
  assert.ok(old, "the pre-existing hazard is still listed after the columns were added");
  assert.equal(old.confidence, null);
  assert.equal(old.confidence_label, null);
  assert.equal(old.confidence_reasons, null);
});

test("a result without confidence fields (older backend) is stored with nulls", async () => {
  await batch([reading("CONF-01", "CRITICAL", "alert_dispatched")]);
  const h = (await srv.call("GET", "/api/hazards")).data.hazards.find((x) => x.node_id === "CONF-01");
  assert.equal(h.confidence, null);
  assert.equal(h.confidence_label, null);
  assert.equal(h.confidence_reasons, null);
});

test("the dashboard feed and raw history carry the fields too (reasons as an array)", async () => {
  const cookie = await srv.login("viewer1");
  const feed = (await srv.call("GET", "/api/sensors?limit=50", undefined, { Cookie: cookie })).data.data;
  const row = feed.find((r) => r.device_id === "CONF-03");
  assert.equal(row.confidence_label, "Low");
  const history = (await srv.call("GET", "/api/history", undefined, { Cookie: cookie })).data;
  const hrow = history.find((r) => r.node_id === "CONF-02");
  assert.deepEqual(hrow.confidence_reasons, ["waiting for confirmation"]);
});

test("garbage confidence from the backend is not stored", async () => {
  await batch([reading("CONF-02", "HIGH", "alert_dispatched", {
    confidence: 5, confidence_label: "<b>sure</b>", confidence_reasons: [{ html: "<script>" }, "ok\u0000reason"],
  })]);
  const z = (await srv.call("GET", "/api/hazard-zones")).data.zones.find((x) => x.node_id === "CONF-02");
  assert.equal(z.confidence, null);
  assert.equal(z.confidence_label, null);
  assert.deepEqual(z.confidence_reasons, ["ok reason"]);
});

test("the WhatsApp alert text includes the confidence label", async () => {
  await batch([reading("CONF-01", "CRITICAL", "alert_dispatched", HIGH_CONF)]);
  // alerts are sent (here: logged, dry run) after the answer - wait for the log line
  let line;
  for (let i = 0; i < 50 && !line; i++) {
    line = srv.web.output.split("\n").find((l) => l.includes("[WhatsApp dry-run] template") && l.includes("confidence High (82%)"));
    if (!line) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(line, `no dry-run alert with the confidence label in:\n${srv.web.output}`);
  assert.match(line, /"CRITICAL, confidence High \(82%\)"/);
});

test("flash_flood reads as 'flash flood' in the WhatsApp alert", async () => {
  await batch([{ ...reading("CONF-03", "CRITICAL", "alert_dispatched", { hazard_type: "flash_flood" }) }]);
  let line;
  for (let i = 0; i < 50 && !line; i++) {
    line = srv.web.output.split("\n").find((l) => l.includes("[WhatsApp dry-run] template") && l.includes('"flash flood"'));
    if (!line) await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(line, `no flash flood alert in:\n${srv.web.output}`);
  assert.match(line, /"CRITICAL",/, "no confidence given -> severity alone");
});
