// Tests for WhatsApp alerts to officers' phones (officer_alerts.js, step W3),
// the phone number helpers (auth.js) and create_user.js --phone / set-phone.
// Run: node --test server/officer_alerts.test.js
//
// Unit tests use an in-memory database and a fake send function; the
// end-to-end tests start a REAL server.js on a spare port with a temporary
// var/ folder and a fake AI backend (test_server.js) - no WhatsApp API is
// ever contacted (credentials are blanked, so the server is in dry run).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { initAuthTables, normalizePhone, maskPhone } = require("./auth");
const { setupOfficerAlerts, parseMinSeverity, EPISODE_CLEAR_READINGS, MAX_FAILED_PER_EPISODE, FORECAST_AREA } = require("./officer_alerts");
const { startTestServer } = require("./test_server");

const PHONES = { officer: "+919876543210", admin: "+919812345678", viewer: "+919800000001" };
const quiet = { log() {}, warn() {}, error() {} };

/** In-memory db with: officer + admin with phones, a viewer WITH a phone (put in directly), an officer without one, a disabled officer. */
function makeDb() {
  const db = new DatabaseSync(":memory:");
  initAuthTables(db);
  const add = db.prepare("INSERT INTO users (username, password_hash, role, created_at, phone, active) VALUES (?, 'x', ?, '', ?, ?)");
  add.run("off1", "officer", PHONES.officer, 1);
  add.run("adm1", "admin", PHONES.admin, 1);
  add.run("view1", "viewer", PHONES.viewer, 1); // must NEVER be messaged
  add.run("off2", "officer", null, 1);
  add.run("off3", "officer", "+919811111111", 0); // disabled
  return db;
}

function setup(opts = {}) {
  const db = makeDb();
  const sent = [];
  const send = opts.send || (async (phone, template, lang, params) => { sent.push({ phone, template, lang, params }); });
  const alerts = setupOfficerAlerts(db, { send, dryRun: false, log: quiet, nodeLocation: () => "Sector 4, Riverside",
    confidenceSummary: (r) => (r.confidence_label ? `${r.confidence_label} (${Math.round(r.confidence * 100)}%)` : null), ...opts });
  return { db, alerts, sent };
}

let clock = Date.parse("2026-10-09T06:00:00Z");
const at = () => new Date((clock += 60_000)).toISOString();
const confirmed = (severity, hazard = "flood", extra = {}) =>
  ({ status: "alert_dispatched", severity, hazard_type: hazard, timestamp: at(), delay_seconds: 0, ...extra });
const allClear = () => ({ status: "logged", severity: "LOW", hazard_type: "flood", timestamp: at() });
const node = (id = "NODE-04", extra = {}) => ({ node_id: id, ...extra });

// ------------------------------------------------------------ phone helpers

test("normalizePhone accepts E.164 with separators and refuses anything else", () => {
  assert.equal(normalizePhone("+91 98765 43210"), "+919876543210");
  assert.equal(normalizePhone("+91-98765-43210"), "+919876543210");
  assert.equal(normalizePhone("+1 (650) 555-1234"), "+16505551234");
  for (const bad of ["9876543210", "+0919876543210", "+91", "+91abc", "", null, 919876543210, "+1234567890123456"]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
  assert.equal(maskPhone("+919876543210"), "+91******3210");
});

test("parseMinSeverity allows HIGH or CRITICAL only", () => {
  assert.equal(parseMinSeverity(undefined, () => {}), 2);
  assert.equal(parseMinSeverity("critical", () => {}), 3);
  let warned = false;
  assert.equal(parseMinSeverity("MEDIUM", () => (warned = true)), 2);
  assert.ok(warned);
});

// ------------------------------------------------------------ the rules

test("a confirmed HIGH goes to every active officer/admin with a phone - never a viewer", async () => {
  const { alerts, sent } = setup();
  const planned = alerts.onAiResult(node(), confirmed("HIGH", "flood", { confidence: 0.82, confidence_label: "High" }));
  await alerts.idle();
  assert.deepEqual(planned.map((p) => p.username).sort(), ["adm1", "off1"]);
  assert.deepEqual(sent.map((s) => s.phone).sort(), [PHONES.officer, PHONES.admin].sort()); // with the "+"
  assert.ok(!sent.some((s) => s.phone === PHONES.viewer));
  const p = sent[0].params;
  assert.equal(p.length, 4);
  assert.equal(p[0], "CONFIRMED HIGH flood");
  assert.equal(p[1], "Sector 4, Riverside (NODE-04)");
  assert.match(p[2], /Confidence High \(82%\)/);
  assert.match(p[3], /\/officer\.html\?focus=NODE-04/);
  assert.equal(sent[0].template, "sanjeevni_officer_alert");
});

test("one message per episode; escalation to CRITICAL sends once more", async () => {
  const { alerts, sent } = setup();
  alerts.onAiResult(node(), confirmed("HIGH"));
  alerts.onAiResult(node(), confirmed("HIGH"));
  alerts.onAiResult(node(), confirmed("HIGH", "flash_flood")); // same family as flood
  await alerts.idle();
  assert.equal(sent.length, 2);
  alerts.onAiResult(node(), confirmed("CRITICAL"));
  alerts.onAiResult(node(), confirmed("CRITICAL"));
  alerts.onAiResult(node(), confirmed("HIGH")); // going back down: nothing
  await alerts.idle();
  assert.equal(sent.length, 4);
  assert.match(sent[3].params[0], /^CONFIRMED CRITICAL flood \(escalated from HIGH\)$/);
});

test("pending, MEDIUM, sensor-fault and old backlog results never message officers", async () => {
  const { alerts, sent } = setup();
  alerts.onAiResult(node(), { ...confirmed("CRITICAL"), status: "pending_confirmation" });
  alerts.onAiResult(node(), confirmed("MEDIUM"));
  alerts.onAiResult(node(), { status: "suppressed", severity: "N/A", hazard_type: "sensor_fault", timestamp: at() });
  alerts.onAiResult(node(), confirmed("CRITICAL", "fire", { delay_seconds: 3600 }));
  await alerts.idle();
  assert.equal(sent.length, 0);
});

test("the episode ends after consecutive all-clear readings (a fault does not end it)", async () => {
  const { alerts, sent } = setup();
  alerts.onAiResult(node(), confirmed("HIGH"));
  for (let i = 0; i < EPISODE_CLEAR_READINGS - 1; i++) alerts.onAiResult(node(), allClear());
  alerts.onAiResult(node(), { status: "suppressed", severity: "N/A", hazard_type: "sensor_fault", timestamp: at() });
  alerts.onAiResult(node(), confirmed("HIGH")); // run broken: still the same episode
  await alerts.idle();
  assert.equal(sent.length, 2);
  for (let i = 0; i < EPISODE_CLEAR_READINGS; i++) alerts.onAiResult(node(), allClear());
  alerts.onAiResult(node(), confirmed("HIGH")); // new episode
  await alerts.idle();
  assert.equal(sent.length, 4);
});

test("episodes are per node and per hazard family", async () => {
  const { alerts, sent } = setup();
  alerts.onAiResult(node("NODE-04"), confirmed("HIGH"));
  alerts.onAiResult(node("NODE-07"), confirmed("HIGH"));
  alerts.onAiResult(node("NODE-04"), confirmed("HIGH", "gas leak"));
  alerts.onAiResult(node("NODE-04"), confirmed("HIGH", "fire"));
  alerts.onAiResult(node("NODE-04"), confirmed("HIGH", "smoke")); // fire family
  await alerts.idle();
  assert.equal(sent.length, 8);
});

test("a batch of confirmed readings sends ONE message per officer (logged before sending)", async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  const sent = [];
  const { alerts, db } = setup({ send: async (phone, t, l, params) => { await gate; sent.push(params); } });
  for (let i = 0; i < 5; i++) alerts.onAiResult(node(), confirmed("CRITICAL"));
  release();
  await alerts.idle();
  assert.equal(sent.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM officer_alert_log WHERE status = 'sent'").get().n, 2);
});

test("dry run logs (phone masked) and stores 'dry_run' without calling send", async () => {
  const lines = [];
  const { alerts, sent, db } = setup({ dryRun: true, log: { ...quiet, log: (l) => lines.push(l) } });
  alerts.onAiResult(node(), confirmed("CRITICAL"));
  await alerts.idle();
  assert.equal(sent.length, 0);
  const rows = db.prepare("SELECT status FROM officer_alert_log").all();
  assert.deepEqual(rows.map((r) => r.status), ["dry_run", "dry_run"]);
  const out = lines.join("\n");
  assert.match(out, /officer-alert dry-run/);
  assert.match(out, /\+91\*+3210/);
  assert.ok(!out.includes(PHONES.officer), "full phone number must not be logged");
});

test("simulated readings: dry run only (marked), live only with WHATSAPP_ALERTS_FOR_SIMULATED", async () => {
  const live = setup();
  live.alerts.onAiResult(node("NODE-04", { simulated: true }), confirmed("CRITICAL"));
  await live.alerts.idle();
  assert.equal(live.sent.length, 0);

  const allowed = setup({ allowSimulated: true });
  allowed.alerts.onAiResult(node("NODE-04", { simulated: true }), confirmed("CRITICAL"));
  await allowed.alerts.idle();
  assert.equal(allowed.sent.length, 2);
  assert.match(allowed.sent[0].params[0], /^\[SIMULATED\] CONFIRMED CRITICAL/);

  const dry = setup({ dryRun: true });
  const planned = dry.alerts.onAiResult(node("NODE-04", { simulated: true }), confirmed("CRITICAL"));
  assert.equal(planned.length, 2);
  assert.match(planned[0].params[0], /^\[SIMULATED\]/);
  // a simulated episode never blocks a real one (and the other way round)
  const real = dry.alerts.onAiResult(node("NODE-04"), confirmed("CRITICAL"));
  assert.equal(real.length, 2);
  await dry.alerts.idle();
});

test("a failed send is retried by the next confirmed reading, at most MAX_FAILED_PER_EPISODE times", async () => {
  let calls = 0;
  const { alerts, db } = setup({ send: async () => { calls++; throw new Error("network down"); } });
  for (let i = 0; i < MAX_FAILED_PER_EPISODE + 3; i++) {
    alerts.onAiResult(node(), confirmed("HIGH"));
    await alerts.idle();
  }
  assert.equal(calls, 2 * MAX_FAILED_PER_EPISODE);
  const failed = db.prepare("SELECT detail FROM officer_alert_log WHERE status = 'failed'").all();
  assert.equal(failed.length, 2 * MAX_FAILED_PER_EPISODE);
  assert.match(failed[0].detail, /network down/);
});

test("automatic siren: mentioned in the hazard message, or its own message when CRITICAL was already sent", async () => {
  const { alerts, sent } = setup();
  const siren = { node_id: "NODE-04", severity: "CRITICAL", hazard_type: "flood", why: "new episode", simulated: false };
  alerts.onAiResult(node(), confirmed("CRITICAL"), { siren });
  await alerts.idle();
  assert.equal(sent.length, 2);
  assert.match(sent[0].params[2], /village siren at NODE-04 switched ON automatically/);
  alerts.onAiResult(node(), confirmed("CRITICAL"), { siren: { ...siren, why: "escalation" } });
  await alerts.idle();
  assert.equal(sent.length, 4);
  assert.equal(sent[2].params[0], "Village siren ON at NODE-04");
  assert.match(sent[2].params[2], /Automatic: confirmed CRITICAL flood \(escalation\)/);
});

test("automatic siren sounded by a gas leak hidden behind an air-pollution primary: the message names the gas leak", async () => {
  const { alerts, sent } = setup();
  const siren = { node_id: "NODE-04", severity: "CRITICAL", hazard_type: "gas leak", why: "new episode",
    simulated: false, primary_hazard_type: "air pollution" };
  alerts.onAiResult(node(), confirmed("CRITICAL", "air pollution"), { siren });
  await alerts.idle();
  assert.match(sent[0].params[0], /CONFIRMED CRITICAL air pollution/);
  assert.match(sent[0].params[2], /switched ON automatically for CRITICAL gas leak \(also measured\)/);
});

test("forecast-only alerts say so; parameters are one line; CRITICAL-only setting", async () => {
  const { alerts, sent } = setup();
  alerts.onAiResult(node(), confirmed("HIGH", "heavy_rain", { forecast_based: true, severity_source: "weather_forecast",
    location: "Line one\nline two\t\tend" }));
  await alerts.idle();
  assert.equal(sent[0].params[0], "FORECAST: HIGH heavy rain forecast for the area");
  assert.equal(sent[0].params[1], "Area-wide forecast, first raised at Line one line two end (NODE-04)");
  assert.match(sent[0].params[2], /based on the weather forecast, not measured/);
  for (const p of sent[0].params) assert.doesNotMatch(p, /[\n\t]| {4,}/);

  const crit = setup({ minSeverity: "CRITICAL" });
  crit.alerts.onAiResult(node(), confirmed("HIGH"));
  await crit.alerts.idle();
  assert.equal(crit.sent.length, 0);
  crit.alerts.onAiResult(node(), confirmed("CRITICAL"));
  await crit.alerts.idle();
  assert.equal(crit.sent.length, 2);
});

test("an area-wide forecast at 5 nodes is ONE message per officer, not one per node", async () => {
  const { alerts, sent, db } = setup();
  const fc = (hazard = "heavy_rain") => confirmed("HIGH", hazard, { forecast_based: true, severity_source: "weather_forecast" });
  for (const id of ["NODE-01", "NODE-02", "NODE-03", "NODE-04", "NODE-05"]) alerts.onAiResult(node(id), fc());
  // the same forecast keeps arriving on the next readings: still nothing new
  for (const id of ["NODE-01", "NODE-03"]) alerts.onAiResult(node(id), fc());
  await alerts.idle();
  assert.equal(sent.length, 2); // off1 + adm1, once each
  assert.match(sent[0].params[1], /^Area-wide forecast, first raised at .*NODE-01/);
  assert.deepEqual(db.prepare("SELECT DISTINCT node_id FROM officer_alert_log").all().map((r) => r.node_id), [FORECAST_AREA]);
  // one node's all-clear does not end the area-wide episode
  for (let i = 0; i < EPISODE_CLEAR_READINGS; i++) alerts.onAiResult(node("NODE-02"), allClear());
  alerts.onAiResult(node("NODE-02"), fc());
  await alerts.idle();
  assert.equal(sent.length, 2);
  // another family (high wind) is its own area episode; a MEASURED heavy_rain stays per node
  alerts.onAiResult(node("NODE-01"), fc("high_wind"));
  alerts.onAiResult(node("NODE-02"), fc("high_wind"));
  alerts.onAiResult(node("NODE-03"), confirmed("HIGH", "heavy_rain"));
  await alerts.idle();
  assert.equal(sent.length, 6);
  assert.equal(sent[4].params[0], "CONFIRMED HIGH heavy rain");
  // EPISODE_GAP_SECONDS without any forecast alert: the next forecast is a new episode
  clock += 7 * 3600 * 1000;
  alerts.onAiResult(node("NODE-05"), fc());
  await alerts.idle();
  assert.equal(sent.length, 8);
});

test("a phone added mid-episode gets the next confirmed reading; recent() masks phones", async () => {
  const { alerts, sent, db } = setup();
  alerts.onAiResult(node(), confirmed("HIGH"));
  db.prepare("UPDATE users SET phone = '+919899999999' WHERE username = 'off2'").run();
  alerts.onAiResult(node(), confirmed("HIGH"));
  await alerts.idle();
  assert.deepEqual(sent.map((s) => s.phone).slice(2), ["+919899999999"]);
  const rows = alerts.recent(10);
  assert.equal(rows.length, 3);
  for (const r of rows) assert.match(r.phone, /^\+9\d\*+\d{4}$/);
});

// ------------------------------------------------------------ end to end

test("server.js: confirmed CRITICAL batch -> dry-run officer alert, admin audit endpoint", async (t) => {
  const srv = await startTestServer({
    nodes: [["NODE-04", "Sector 4, Riverside", 29.3919, 79.4542], ["SIREN-01", "Village square", 29.39, 79.45]],
    keys: { gw: { nodes: "*" } },
    users: { off1: "officer", adm1: "admin", view1: "viewer" },
    seed: (db) => {
      db.prepare("UPDATE users SET phone = ? WHERE username = 'off1'").run(PHONES.officer);
      db.prepare("UPDATE users SET phone = ? WHERE username = 'view1'").run(PHONES.viewer);
    },
  });
  t.after(() => srv.stop());
  const key = { "X-Device-Key": srv.keys.gw };
  const readings = [0, 1, 2].map((i) => ({ node_id: "NODE-04", reading_uid: `b-${i}`, age_seconds: 30 - i * 10,
    test_status: "alert_dispatched", test_severity: "CRITICAL", test_hazard: "flood" }));
  const res = await srv.call("POST", "/api/ingest/batch", { readings }, key);
  assert.equal(res.status, 200);

  const admin = await srv.login("adm1");
  let audit;
  for (let i = 0; i < 50; i++) {
    audit = await srv.call("GET", "/api/admin/officer-alerts", undefined, { Cookie: admin });
    if (audit.data.alerts?.some((a) => a.status === "dry_run")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.equal(audit.status, 200);
  assert.equal(audit.data.dry_run, true);
  assert.equal(audit.data.alerts.length, 1, "one message for the officer with a phone, none for the viewer");
  assert.equal(audit.data.alerts[0].username, "off1");
  assert.equal(audit.data.alerts[0].phone, "+91******3210");
  assert.equal(audit.data.alerts[0].kind, "hazard");
  assert.match(srv.web.output, /\[officer-alert dry-run\] hazard to off1 \+91\*+3210/);
  assert.ok(!srv.web.output.includes(PHONES.officer), "the full number is never logged");
  assert.ok(!srv.web.output.includes("view1 +91"), "viewer never messaged");

  // A siren-fitted node: the automatic siren rides in the same message
  const sirenReading = { node_id: "SIREN-01", reading_uid: "s-1", age_seconds: 5, siren_fitted: true, siren_on: false,
    test_status: "alert_dispatched", test_severity: "CRITICAL", test_hazard: "flood" };
  assert.equal((await srv.call("POST", "/api/ingest/batch", { readings: [sirenReading] }, key)).status, 200);
  for (let i = 0; i < 50; i++) {
    audit = await srv.call("GET", "/api/admin/officer-alerts", undefined, { Cookie: admin });
    if (audit.data.alerts.some((a) => a.node_id === "SIREN-01" && a.status === "dry_run")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const sirenAlert = audit.data.alerts.find((a) => a.node_id === "SIREN-01");
  assert.equal(sirenAlert.kind, "hazard+siren");
  assert.match(sirenAlert.detail, /village siren at SIREN-01 switched ON automatically/);

  // the public advice table the classic SOS page and the staff pages fetch
  const advice = await srv.call("GET", "/hazard-advice.json");
  assert.equal(advice.status, 200);
  assert.ok(advice.data.hazards.heavy_rain && advice.data.hazards.high_wind);

  const officer = await srv.login("off1");
  assert.equal((await srv.call("GET", "/api/admin/officer-alerts", undefined, { Cookie: officer })).status, 403);
  assert.equal((await srv.call("GET", "/api/admin/officer-alerts?limit=0", undefined, { Cookie: admin })).status, 400);
});

// ------------------------------------------------------------ CLI

test("create_user.js: add --phone, set-phone, viewer refused, list masks the number", () => {
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "sanjeevni-cu-test-"));
  const run = (args, input = "") => spawnSync(process.execPath, [path.join(__dirname, "create_user.js"), ...args], {
    env: { ...process.env, SANJEEVNI_VAR_DIR: varDir }, input, encoding: "utf8", windowsHide: true,
  });
  try {
    const pw = "long-enough-password\nlong-enough-password\n";
    let r = run(["add", "off1", "officer", "--phone", "+91 98765 43210"], pw);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\+91\*+3210/);
    r = run(["add", "view1", "viewer", "--phone", "+919876543211"], pw);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /viewer cannot have a phone/);
    r = run(["add", "view2", "viewer"], pw);
    assert.equal(r.status, 0, r.stderr);
    r = run(["set-phone", "view2", "+919876543211"]);
    assert.equal(r.status, 1);
    r = run(["set-phone", "off1", "98765"]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /E\.164/);
    r = run(["set-phone", "off1", "+44", "20", "7946", "0958"]);
    assert.equal(r.status, 0, r.stderr);
    r = run(["list"]);
    assert.match(r.stdout, /off1 .* phone: \+44\*+0958/);
    assert.ok(!r.stdout.includes("+442079460958"));
    const db = new DatabaseSync(path.join(varDir, "sanjeevni.db"));
    assert.equal(db.prepare("SELECT phone FROM users WHERE username = 'off1'").get().phone, "+442079460958");
    assert.equal(db.prepare("SELECT phone FROM users WHERE username = 'view2'").get().phone, null);
    db.close();
    r = run(["set-phone", "off1", "none"]);
    assert.equal(r.status, 0);
    assert.doesNotMatch(run(["list"]).stdout, /phone:/);
  } finally {
    fs.rmSync(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
