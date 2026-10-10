// Tests for the village siren on sensor nodes (siren.js + server.js routes).
// Run: node --test server/siren.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { startTestServer, OFFICER_KEY } = require("./test_server");
const {
  parseAutoSeverity, parseAutoHazards, newestPerNode, setupSirens, EPISODE_CLEAR_READINGS, DEFAULT_AUTO_HAZARDS,
} = require("./siren");

const POS = [29.4002, 79.461];
let srv;

test.before(async () => {
  srv = await startTestServer({
    nodes: ["SIREN-01", "SIREN-02", "SIREN-03", "SIREN-04", "SIREN-05", "SIREN-06", "SIREN-07", "PLAIN-01"]
      .map((id) => [id, `Site ${id}`, ...POS]),
    keys: {
      gateway: { nodes: "*" },
      node04only: { nodes: "SIREN-04" },
      simulator: { kind: "simulator", nodes: "*" },
    },
    users: { officer1: "officer", viewer1: "viewer" },
  });
});
test.after(async () => srv && srv.stop());

const officer = { "X-API-Key": OFFICER_KEY };
const batch = (readings, key = srv.keys.gateway) =>
  srv.call("POST", "/api/ingest/batch", { readings }, { "X-Device-Key": key });
const single = (reading, key = srv.keys.gateway) => srv.call("POST", "/api/ingest", reading, { "X-Device-Key": key });
const sirenOf = async (nodeId) => (await srv.call("GET", "/api/sirens", undefined, officer)).data.sirens.find((s) => s.node_id === nodeId);
const setSiren = (nodeId, body, headers = officer) => srv.call("POST", `/api/nodes/${nodeId}/siren`, body, headers);
let uid = 0;
// age_seconds: 0 = a live reading (a batch reading without it is an untimed backlog one)
const r = (nodeId, extra = {}) =>
  ({ node_id: nodeId, reading_uid: `u${++uid}`, river_level_m: 1.0, siren_fitted: true, age_seconds: 0, ...extra });
const critical = (nodeId, extra = {}) => r(nodeId, { test_severity: "CRITICAL", test_status: "alert_dispatched", ...extra });

test("a siren-fitted node is listed with its reported state; a node without one is not", async () => {
  const res = await batch([r("SIREN-01"), { node_id: "PLAIN-01", reading_uid: "p1", river_level_m: 1 }]);
  assert.equal(res.status, 200);
  assert.equal(res.data.commands, undefined, "no command while nothing is wanted");
  const list = (await srv.call("GET", "/api/sirens", undefined, officer)).data;
  assert.equal(list.auto_severity, "CRITICAL");
  assert.equal(list.default_on_seconds, 180);
  assert.ok(!list.sirens.some((s) => s.node_id === "PLAIN-01"));
  assert.deepEqual(
    { ...(await sirenOf("SIREN-01")), reported_at: null },
    { node_id: "SIREN-01", fitted: true, sounding: false, desired: null, reason: null, desired_reason: null,
      desired_by: null, until: null, reported_reason: null, reported_at: null, simulated: false, desired_simulated: false },
  );
  // node health (officer page) carries the same block
  const health = (await srv.call("GET", "/api/node-health", undefined, officer)).data;
  assert.equal(health.nodes.find((n) => n.node_id === "SIREN-01").siren.fitted, true);
  assert.equal(health.nodes.find((n) => n.node_id === "PLAIN-01").siren, null);
});

test("officer ON: commanded in BOTH ingest answers until the node reports it sounding", async () => {
  const on = await setSiren("SIREN-01", { action: "on" });
  assert.equal(on.status, 200);
  assert.equal(on.data.siren.desired, "on");
  assert.equal(on.data.siren.reason, "officer");
  assert.equal(on.data.siren.desired_by, "api-key");

  const b = await batch([r("SIREN-01")]);
  assert.equal(b.data.commands.length, 1);
  assert.equal(b.data.commands[0].node_id, "SIREN-01");
  assert.equal(b.data.commands[0].siren, "on");
  assert.ok(b.data.commands[0].for_s > 170 && b.data.commands[0].for_s <= 180);
  // not delivered yet (lost ACK): sent again, also on the single-reading route
  const s = await single(r("SIREN-01"));
  assert.equal(s.data.ai_action, "logged");
  assert.equal(s.data.commands[0].siren, "on");

  // the node obeys and says so: nothing more to send
  const done = await batch([r("SIREN-01", { siren_on: true, siren_reason: "command" })]);
  assert.equal(done.data.commands, undefined);
  const st = await sirenOf("SIREN-01");
  assert.equal(st.sounding, true);
  assert.equal(st.reported_reason, "command");
  assert.ok(Date.parse(st.until) > Date.now());
});

test("officer OFF (silence): commanded until the node reports silent, then the request is cleared", async () => {
  assert.equal((await setSiren("SIREN-01", { action: "off" })).data.siren.desired, "off");
  const b = await batch([r("SIREN-01", { siren_on: true, siren_reason: "command" })]);
  assert.deepEqual(b.data.commands, [{ node_id: "SIREN-01", siren: "off" }]);
  const quiet = await batch([r("SIREN-01")]);
  assert.equal(quiet.data.commands, undefined);
  const st = await sirenOf("SIREN-01");
  assert.equal(st.sounding, false);
  assert.equal(st.desired, null, "reconciled - nothing left to send");
  // audited, newest first
  const h = (await srv.call("GET", "/api/nodes/SIREN-01/siren", undefined, officer)).data.history;
  assert.deepEqual(h.slice(0, 2).map((e) => [e.action, e.actor]), [["off", "api-key"], ["on", "api-key"]]);
  assert.match(srv.web.output, /\[siren\] SIREN-01: OFF by api-key/);
});

test("a node sounding on its own (offline fallback) is reported, and not switched off unasked", async () => {
  const b = await batch([r("SIREN-02", { siren_on: true, siren_reason: "auto_offline" })]);
  assert.equal(b.data.commands, undefined);
  const st = await sirenOf("SIREN-02");
  assert.equal(st.sounding, true);
  assert.equal(st.reason, "auto_offline");
  assert.equal(st.desired, null);
});

test("an older backlog reading never overwrites the newer reported state", async () => {
  await batch([r("SIREN-02", { siren_on: true, siren_reason: "auto_offline" }), r("SIREN-02", { age_seconds: 3600 })]);
  assert.equal((await sirenOf("SIREN-02")).sounding, true);
  await batch([r("SIREN-02", { age_seconds: 3600 })]); // a later request carrying only old data
  assert.equal((await sirenOf("SIREN-02")).sounding, true);
});

test("AUTO: confirmed CRITICAL sounds the siren once per episode; HIGH and pending never do", async () => {
  // HIGH confirmed and CRITICAL pending: no siren (HIGH is the officer's call)
  let b = await batch([r("SIREN-03", { test_severity: "HIGH", test_status: "alert_dispatched" })]);
  assert.equal(b.data.commands, undefined);
  b = await batch([r("SIREN-03", { test_severity: "CRITICAL", test_status: "pending_confirmation" })]);
  assert.equal(b.data.commands, undefined);
  // confirmed CRITICAL (an escalation from HIGH): commanded in the same answer
  b = await batch([critical("SIREN-03")]);
  assert.equal(b.data.commands[0].siren, "on");
  assert.equal(b.data.commands[0].for_s, 180);
  let st = await sirenOf("SIREN-03");
  assert.equal(st.desired, "on");
  assert.equal(st.reason, "auto");
  assert.match(srv.web.output, /SIREN-03: ON by auto - confirmed CRITICAL flood \(escalation\)/);

  // officer silences it; the same flood staying CRITICAL does not overrule that
  await batch([critical("SIREN-03", { siren_on: true, siren_reason: "command" })]);
  await setSiren("SIREN-03", { action: "off" });
  await batch([critical("SIREN-03")]); // node reports silent
  for (let i = 0; i < 3; i++) {
    b = await batch([critical("SIREN-03")]);
    assert.equal(b.data.commands, undefined, "no re-trigger inside the episode");
  }
  // dropping to HIGH and back to CRITICAL is still the same episode
  await batch([r("SIREN-03", { test_severity: "HIGH", test_status: "alert_dispatched" })]);
  b = await batch([critical("SIREN-03")]);
  assert.equal(b.data.commands, undefined);

  // a different hazard type at CRITICAL is a new episode
  b = await batch([critical("SIREN-03", { test_hazard: "fire" })]);
  assert.equal(b.data.commands[0].siren, "on");
  await setSiren("SIREN-03", { action: "off" });
  // LOW readings: hazard over (after EPISODE_CLEAR_READINGS in a row), node silent
  for (let i = 0; i < EPISODE_CLEAR_READINGS; i++) await batch([r("SIREN-03")]);

  // hazard over -> the next CRITICAL is a new episode
  st = await sirenOf("SIREN-03");
  assert.equal(st.desired, null);
  b = await batch([critical("SIREN-03")]);
  assert.equal(b.data.commands[0].siren, "on");
  assert.match(srv.web.output, /SIREN-03: ON by auto - confirmed CRITICAL flood \(new episode\)/);
});

test("AUTO skips a CRITICAL reading delivered from an old backlog", async () => {
  const b = await batch([critical("SIREN-05", { test_delay: 3600, age_seconds: 3600 })]);
  assert.equal(b.data.commands, undefined);
  assert.equal((await sirenOf("SIREN-05")).desired, null);
});

test("a SIMULATED CRITICAL never commands a real node's siren", async () => {
  const sim = await batch([critical("SIREN-06")], srv.keys.simulator);
  assert.equal(sim.data.commands[0].siren, "on", "the simulator itself is told (demo)");
  assert.equal((await sirenOf("SIREN-06")).desired_simulated, true);
  const real = await batch([r("SIREN-06")]);
  assert.equal(real.data.commands, undefined, "the real node never gets a simulated trigger");
  assert.match(srv.web.output, /SIREN-06: ON by auto - .*SIMULATED reading/);
  // a real officer request reaches the real node
  await setSiren("SIREN-06", { action: "on", for_s: 60 });
  const after = await batch([r("SIREN-06")]);
  assert.equal(after.data.commands[0].siren, "on");
  assert.ok(after.data.commands[0].for_s <= 60);
});

test("commands only reach nodes the device key may report for", async () => {
  await batch([r("SIREN-04")]);
  await setSiren("SIREN-04", { action: "on" });
  await setSiren("SIREN-02", { action: "off" }); // SIREN-02 is sounding: it has a command waiting too
  const mixed = await batch([r("SIREN-02", { siren_on: true }), r("SIREN-04")], srv.keys.node04only);
  assert.equal(mixed.status, 200);
  assert.deepEqual(mixed.data.commands.map((c) => c.node_id), ["SIREN-04"]);
  const denied = await batch([r("SIREN-04", { node_id: "SIREN-03" })], srv.keys.node04only);
  assert.equal(denied.status, 403);
  assert.equal(denied.data.commands, undefined);
});

test("siren commands still go out while the AI backend is down", async () => {
  srv.backend.state.down = true;
  try {
    const b = await batch([r("SIREN-04")]);
    assert.ok(b.status >= 500);
    assert.equal(b.data.commands[0].node_id, "SIREN-04");
    const s = await single(r("SIREN-04"));
    assert.ok(s.status >= 500);
    assert.equal(s.data.commands[0].siren, "on");
  } finally {
    srv.backend.state.down = false;
  }
});

test("officer siren API: validation, roles, cross-site block", async () => {
  assert.equal((await setSiren("SIREN-01", { action: "loud" })).status, 400);
  assert.equal((await setSiren("SIREN-01", { action: "on", for_s: 5 })).status, 400);
  assert.equal((await setSiren("SIREN-01", { action: "on", for_s: "60" })).status, 400);
  assert.equal((await setSiren("SIREN-01", { action: "off", for_s: 60 })).status, 400);
  assert.equal((await setSiren("NO-SUCH-NODE", { action: "on" })).status, 404);
  assert.equal((await setSiren("PLAIN-01", { action: "on" })).status, 404, "never reported a siren");
  assert.equal((await setSiren("SIREN-01", { action: "on" }, {})).status, 401);
  assert.equal((await srv.call("GET", "/api/sirens")).status, 401);

  const viewer = await srv.login("viewer1");
  assert.equal((await setSiren("SIREN-01", { action: "on" }, { Cookie: viewer })).status, 403);
  const cookie = await srv.login("officer1");
  const crossSite = await setSiren("SIREN-01", { action: "on" }, { Cookie: cookie, Origin: "http://evil.example" });
  assert.equal(crossSite.status, 403);
  assert.equal((await sirenOf("SIREN-01")).desired, null, "the blocked request changed nothing");
  const ok = await setSiren("SIREN-01", { action: "on" }, { Cookie: cookie });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.siren.desired_by, "officer1");
  const h = (await srv.call("GET", "/api/nodes/SIREN-01/siren", undefined, { Cookie: cookie })).data.history;
  assert.deepEqual([h[0].action, h[0].actor, h[0].detail], ["on", "officer1", "for 180 s"]);
});

test("a node that stops reporting a siren can no longer be switched on", async () => {
  await batch([{ node_id: "SIREN-05", reading_uid: "nofit", river_level_m: 1, age_seconds: 0 }]);
  const res = await setSiren("SIREN-05", { action: "on" });
  assert.equal(res.status, 409);
  assert.equal((await setSiren("SIREN-05", { action: "off" })).status, 200, "silencing is always allowed");
});

// ---- unit level -----------------------------------------------------------
test("SIREN_AUTO_SEVERITY: CRITICAL (default) or off - never anything lower", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.equal(parseAutoSeverity(undefined, warn), 3);
  assert.equal(parseAutoSeverity("", warn), 3);
  assert.equal(parseAutoSeverity("critical", warn), 3);
  assert.equal(parseAutoSeverity("off", warn), null);
  assert.equal(warnings.length, 0);
  assert.equal(parseAutoSeverity("HIGH", warn), 3, "HIGH is refused (team decision) - falls back to CRITICAL");
  assert.equal(warnings.length, 1);
});


const quietLog = { warn() {}, log() {} };
const memSirens = (opts = {}) => setupSirens(new DatabaseSync(":memory:"), { log: quietLog, ...opts });
const fit = (extra = {}) => ({ node_id: "N1", siren_fitted: true, age_seconds: 0, ...extra });
const confirmedAt = (severity, hazard, atMs, extra = {}) => ({
  status: "alert_dispatched", severity, hazard_type: hazard, timestamp: new Date(atMs).toISOString(), ...extra,
});
const clearAt = (atMs) => ({ status: "logged", severity: "LOW", hazard_type: "flood", timestamp: new Date(atMs).toISOString() });

test("SIREN_AUTO_SEVERITY=off: a confirmed CRITICAL leaves the siren alone", () => {
  const s = memSirens({ autoSeverity: "off" });
  s.recordReported([fit()]);
  s.onAiResult({ node_id: "N1" }, { status: "alert_dispatched", severity: "CRITICAL", hazard_type: "flood" });
  assert.equal(s.status("N1").desired, null);
  assert.deepEqual(s.commandsFor([fit()]), []);
  assert.equal(s.autoSeverity, "off");
});

test("a FORECAST-based confirmed CRITICAL never sounds the siren and does not use up the episode", () => {
  const warnings = [];
  // heavy_rain is not an automatic-siren hazard by default; listed here so
  // the test shows the forecast guard holds even when an operator adds it
  const s = memSirens({ autoHazards: "heavy_rain,flood", log: { log() {}, warn: (m) => warnings.push(m) } });
  s.recordReported([fit()]);
  const t0 = Date.parse("2026-10-09T06:00:00Z");
  // even if the backend's HIGH cap on forecast alerts ever regressed
  for (const extra of [{ forecast_based: true }, { severity_source: "weather_forecast" }, { confirmation: "forecast" }]) {
    assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "heavy_rain", t0, extra), t0), undefined);
    assert.equal(s.status("N1").desired, null);
  }
  assert.deepEqual(s.commandsFor([fit()]), []);
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /forecast-based CRITICAL heavy_rain ignored/);
  // a later MEASURED confirmed CRITICAL of the same family still sounds it
  const fired = s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "heavy_rain", t0 + 60_000), t0 + 60_000);
  assert.equal(fired.why, "new episode");
  assert.equal(s.status("N1", t0 + 60_000).desired, "on");
});

test("an expired ON is not re-sent; the node is told off only if it still sounds", () => {
  const s = memSirens();
  const t0 = Date.now();
  s.recordReported([fit()], t0);
  s.officerAction("N1", "on", 30, "o", t0);
  assert.deepEqual(s.commandsFor([fit()], t0 + 1000), [{ node_id: "N1", siren: "on", for_s: 29 }]);
  // 2 s left: not worth switching on
  assert.deepEqual(s.commandsFor([fit()], t0 + 28_000), []);
  s.recordReported([fit({ siren_on: true, siren_reason: "command" })], t0 + 29_000);
  assert.deepEqual(s.commandsFor([fit()], t0 + 40_000), [{ node_id: "N1", siren: "off" }]);
  s.recordReported([fit()], t0 + 41_000);
  assert.equal(s.status("N1", t0 + 41_000).desired, null);
});

test("an expired ON never silences a node that now sounds by its OWN offline fallback", () => {
  const s = memSirens();
  const t0 = Date.now();
  s.recordReported([fit()], t0);
  s.officerAction("N1", "on", 60, "o", t0);
  s.recordReported([fit({ siren_on: true, siren_reason: "command" })], t0 + 1000);
  // the link drops before the node reports silent; 30 min later it is back,
  // sounding because its own edge check saw danger with no gateway
  // (server.js stores the reported state before it works out commands)
  const later = t0 + 30 * 60_000;
  s.recordReported([fit({ siren_on: true, siren_reason: "auto_offline" })], later);
  assert.deepEqual(s.commandsFor([fit({ siren_on: true, siren_reason: "auto_offline" })], later), []);
  const st = s.status("N1", later);
  assert.equal(st.sounding, true);
  assert.equal(st.desired, null, "the run-out request is dropped, not turned into 'off'");
  assert.equal(st.reason, "auto_offline");
  // an officer's explicit silence still reaches it
  s.officerAction("N1", "off", null, "o", later + 1000);
  assert.deepEqual(s.commandsFor([fit({ siren_on: true, siren_reason: "auto_offline" })], later + 2000),
    [{ node_id: "N1", siren: "off" }]);
});

test("an UNTIMED backlog reading never beats a live one, and never clears a pending silence", () => {
  const s = memSirens();
  const t0 = Date.now();
  s.recordReported([fit()], t0);
  s.officerAction("N1", "on", 300, "o", t0);
  s.recordReported([fit({ siren_on: true, siren_reason: "command" })], t0 + 1000);
  s.officerAction("N1", "off", null, "o", t0 + 2000);
  // live reading (sounding) + a backlog reading whose age was lost in a reboot (silent)
  const req = [fit({ age_seconds: 2, siren_on: true, siren_reason: "command" }), { node_id: "N1", siren_fitted: true }];
  s.recordReported(req, t0 + 3000);
  let st = s.status("N1", t0 + 3000);
  assert.equal(st.sounding, true, "the live reading is the current state");
  assert.equal(st.desired, "off", "the officer's silence is still pending");
  assert.deepEqual(s.commandsFor(req, t0 + 3000), [{ node_id: "N1", siren: "off" }]);
  // a request carrying ONLY untimed backlog readings changes nothing either
  const backlog = [{ node_id: "N1", siren_fitted: true }, { node_id: "N1", siren_fitted: true }];
  s.recordReported(backlog, t0 + 4000);
  st = s.status("N1", t0 + 4000);
  assert.equal(st.sounding, true);
  assert.equal(st.desired, "off");
  assert.deepEqual(s.commandsFor(backlog, t0 + 4000), [{ node_id: "N1", siren: "off" }], "the command still rides along");
  // the single-reading route: no age = live
  s.recordReported([{ node_id: "N1", siren_fitted: true }], t0 + 5000, { untimedIsNow: true });
  st = s.status("N1", t0 + 5000);
  assert.equal(st.sounding, false);
  assert.equal(st.desired, null, "reconciled by a live reading");
});

test("an untimed reading only fills in a node nothing is known about yet", () => {
  const s = memSirens();
  s.recordReported([{ node_id: "N2", siren_fitted: true, siren_on: true, siren_reason: "auto_offline" }]);
  const st = s.status("N2");
  assert.equal(st.fitted, true);
  assert.equal(st.sounding, true);
  assert.equal(st.reported_at, null, "time unknown - any timed reading replaces it");
  s.recordReported([{ node_id: "N2", siren_fitted: true, age_seconds: 7200 }]);
  assert.equal(s.status("N2").sounding, false);
});

test("a suppressed / sensor_fault result never ends an episode (no re-sound over an officer's silence)", () => {
  const s = memSirens();
  const t0 = Date.now();
  s.recordReported([fit()], t0);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", t0), t0);
  assert.equal(s.status("N1", t0).desired, "on");
  s.recordReported([fit({ siren_on: true, siren_reason: "command" })], t0 + 1000);
  s.officerAction("N1", "off", null, "o", t0 + 2000);
  s.recordReported([fit()], t0 + 3000);
  assert.equal(s.status("N1", t0 + 3000).desired, null);
  // anomalous data mid-flood, then the flood again
  s.onAiResult({ node_id: "N1" }, { status: "suppressed", severity: "N/A", hazard_type: "sensor_fault",
    timestamp: new Date(t0 + 4000).toISOString() }, t0 + 4000);
  s.onAiResult({ node_id: "N1" }, { status: "logged", severity: "LOW", hazard_type: "none",
    timestamp: new Date(t0 + 4500).toISOString() }, t0 + 4500);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", t0 + 5000), t0 + 5000);
  assert.equal(s.status("N1", t0 + 5000).desired, null, "same episode - stays silenced");
  assert.deepEqual(s.commandsFor([fit()], t0 + 5000), []);
});

test("an episode ends only after EPISODE_CLEAR_READINGS all-clear readings in a row", () => {
  const s = memSirens();
  const t0 = Date.now();
  s.recordReported([fit()], t0);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", t0), t0);
  s.officerAction("N1", "off", null, "o", t0 + 1);
  s.recordReported([fit()], t0 + 2);
  let t = t0 + 1000;
  // fewer clears than needed, then CRITICAL again: same episode
  for (let i = 0; i < EPISODE_CLEAR_READINGS - 1; i++) s.onAiResult({ node_id: "N1" }, clearAt((t += 1000)), t);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", (t += 1000)), t);
  assert.equal(s.status("N1", t).desired, null);
  // a HIGH in between breaks the run of clears too
  for (let i = 0; i < EPISODE_CLEAR_READINGS - 1; i++) s.onAiResult({ node_id: "N1" }, clearAt((t += 1000)), t);
  s.onAiResult({ node_id: "N1" }, confirmedAt("HIGH", "flood", (t += 1000)), t);
  s.onAiResult({ node_id: "N1" }, clearAt((t += 1000)), t);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", (t += 1000)), t);
  assert.equal(s.status("N1", t).desired, null);
  // enough clears: over - the next CRITICAL is a new episode
  for (let i = 0; i < EPISODE_CLEAR_READINGS; i++) s.onAiResult({ node_id: "N1" }, clearAt((t += 1000)), t);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", (t += 1000)), t);
  assert.equal(s.status("N1", t).desired, "on");
});

test("flood/flash_flood and fire/smoke are one episode; an episode quiet for EPISODE_GAP_SECONDS is over", () => {
  const s = memSirens({ episodeGapSeconds: 3600 });
  const t0 = Date.now() - 3 * 3600_000;
  s.recordReported([fit()], t0);
  const silence = (t) => {
    s.officerAction("N1", "off", null, "o", t);
    s.recordReported([fit()], t);
  };
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", t0), t0);
  silence(t0 + 1);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flash_flood", t0 + 1000), t0 + 1000);
  assert.equal(s.status("N1", t0 + 1000).desired, null, "flash_flood is the same flood");
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "fire", t0 + 2000), t0 + 2000);
  assert.equal(s.status("N1", t0 + 2000).desired, "on", "fire family: another hazard");
  silence(t0 + 2001);
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "smoke", t0 + 3000), t0 + 3000);
  assert.equal(s.status("N1", t0 + 3000).desired, null, "fire -> smoke is the same fire (and smoke never sounds it)");
  // node quiet for longer than the gap, then CRITICAL in a new event
  const back = t0 + 3000 + 3601_000;
  s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", back), back);
  assert.equal(s.status("N1", back).desired, "on");
});

test("a SIMULATED CRITICAL puts no request on a row a REAL node reported to", () => {
  const s = memSirens();
  s.recordReported([fit()]); // real node
  s.onAiResult({ node_id: "N1", simulated: true }, confirmedAt("CRITICAL", "flood", Date.now()));
  const st = s.status("N1");
  assert.equal(st.desired, null);
  assert.equal(st.desired_simulated, false);
  assert.deepEqual(s.commandsFor([fit()]), []);
  // a row the simulator made (demo node id) still gets the demo "on"
  s.recordReported([{ node_id: "SIM-1", siren_fitted: true, age_seconds: 0, simulated: true }]);
  s.onAiResult({ node_id: "SIM-1", simulated: true }, confirmedAt("CRITICAL", "flood", Date.now()));
  assert.equal(s.status("SIM-1").desired, "on");
});

test("newestPerNode: smallest age, the later one on a tie; untimed only when nothing is timed", () => {
  const m = newestPerNode([
    { node_id: "A", age_seconds: 10, k: 1 }, { node_id: "A", k: 2 }, { node_id: "A", age_seconds: 0, k: 3 },
    { node_id: "B", age_seconds: 600, k: 4 }, { node_id: "B", k: 5 },
    { node_id: "C", k: 6 }, { node_id: "C", k: 7 },
    { node_id: "D", timestamp: new Date(Date.now() - 60_000).toISOString(), k: 8 }, { node_id: "D", age_seconds: 120, k: 9 },
  ]);
  assert.equal(m.get("A").reading.k, 3);
  assert.equal(m.get("B").reading.k, 4, "an hours-old timed reading still beats an untimed one");
  assert.equal(m.get("C").reading.k, 7);
  assert.equal(m.get("C").timed, false);
  assert.equal(m.get("C").age, null);
  assert.equal(m.get("D").reading.k, 8, "an explicit timestamp counts as timed");
  // the single-reading route: no age = now
  assert.equal(newestPerNode([{ node_id: "A", age_seconds: 5, k: 1 }, { node_id: "A", k: 2 }], { untimedIsNow: true })
    .get("A").reading.k, 2);
});


// ---- SIREN_AUTO_HAZARDS: evacuation hazards only (user decision 2026-10-09) ----

test("SIREN_AUTO_HAZARDS: default = flood, flash_flood, landslide, fire, gas_leak; names are normalised", () => {
  const warnings = [];
  const warn = (m) => warnings.push(m);
  assert.deepEqual([...parseAutoHazards(undefined, warn)], ["flood", "flash_flood", "landslide", "fire", "gas_leak"]);
  assert.deepEqual([...parseAutoHazards("", warn)], [...DEFAULT_AUTO_HAZARDS]);
  assert.equal(warnings.length, 0);
  // the backend writes "gas leak" with a space; env values may use either
  assert.deepEqual([...parseAutoHazards(" Gas Leak , flash-flood,flood ", warn)], ["gas_leak", "flash_flood", "flood"]);
  assert.equal(warnings.length, 0);
  // a typo is kept but warned about; an empty list falls back to the default
  assert.deepEqual([...parseAutoHazards("flod", warn)], ["flod"]);
  assert.match(warnings[0], /flod is not a hazard type/);
  assert.deepEqual([...parseAutoHazards(" , ", warn)], [...DEFAULT_AUTO_HAZARDS]);
  assert.match(warnings[1], /names no hazard/);
});

test("a confirmed CRITICAL severe_heat_wave sends NO siren command; air pollution and smoke neither", () => {
  const s = memSirens();
  const t0 = Date.parse("2026-10-09T07:00:00Z");
  s.recordReported([fit()], t0);
  // what the backend sends for an IMD severe heat wave (hazard_classification.py)
  const heat = confirmedAt("CRITICAL", "extreme heat", t0, { imd_category: "severe_heat_wave", criterion: "actual" });
  assert.equal(s.onAiResult({ node_id: "N1" }, heat, t0), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "air pollution", t0 + 1000), t0 + 1000), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "smoke", t0 + 2000), t0 + 2000), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "water quality degradation", t0 + 3000), t0 + 3000),
    undefined);
  assert.equal(s.status("N1", t0 + 3000).desired, null);
  assert.deepEqual(s.commandsFor([fit()], t0 + 3000), []);
  // the officer can still sound it for the heat wave
  s.officerAction("N1", "on", 60, "officer1", t0 + 4000);
  assert.deepEqual(s.commandsFor([fit()], t0 + 4000), [{ node_id: "N1", siren: "on", for_s: 60 }]);
});

test("every evacuation hazard sounds it - incl. the backend's 'gas leak' spelling", () => {
  const t0 = Date.parse("2026-10-09T08:00:00Z");
  for (const hazard of ["flood", "flash_flood", "landslide", "fire", "gas leak"]) {
    const s = memSirens();
    s.recordReported([fit()], t0);
    const fired = s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", hazard, t0), t0);
    assert.equal(fired?.why, "new episode", hazard);
    assert.equal(s.status("N1", t0).desired, "on", hazard);
  }
});

// The backend caps smoke at HIGH (hazard_classification.py SMOKE_MAX_RISK),
// so this is the guarantee, not a field case: a non-evacuation hazard never
// raises the peak of an evacuation episode of the same family (it would if
// an operator's list or a future backend change let smoke reach CRITICAL).
test("a non-evacuation hazard never raises the fire episode's peak: the fire CRITICAL after it still sounds", () => {
  const s = memSirens();
  const t0 = Date.parse("2026-10-09T09:00:00Z");
  s.recordReported([fit()], t0);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "smoke", t0), t0), undefined);
  const fired = s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "fire", t0 + 60_000), t0 + 60_000);
  assert.equal(fired.why, "new episode");
});

// ---- an evacuation CRITICAL hidden behind a non-evacuation primary (review 2026-10-09) ----
// Values as the real backend produces them: PM2.5 400 -> air pollution
// CRITICAL 0.96; gas_ppm 950 -> gas leak CRITICAL (950-400)/600 = 0.9167;
// equal tie priority, so "air pollution" wins on risk_score.
const aqiWithGas = (atMs, gas = { risk_score: 0.9167, severity: "CRITICAL", severity_source: "threshold_classifier" },
  extra = {}) => confirmedAt("CRITICAL", "air pollution", atMs, {
  risk_score: 0.96,
  hazard_scores: { "air pollution": { risk_score: 0.96, severity: "CRITICAL" }, "gas leak": gas },
  ...extra,
});

test("a CRITICAL gas leak hidden behind a CRITICAL air-pollution primary sounds it once the node measured it twice", () => {
  const s = memSirens();
  const t0 = Date.parse("2026-10-09T11:00:00Z");
  s.recordReported([fit()], t0);
  // first sighting: the backend has not confirmed the gas leak itself -
  // the siren waits for one more reading (as hazard_confirmation.py would)
  assert.equal(s.onAiResult({ node_id: "N1" }, aqiWithGas(t0, undefined, { status: "pending_confirmation" }), t0), undefined);
  assert.equal(s.status("N1", t0).desired, null);
  const fired = s.onAiResult({ node_id: "N1" }, aqiWithGas(t0 + 60_000), t0 + 60_000);
  assert.deepEqual({ ...fired, until: undefined }, { node_id: "N1", severity: "CRITICAL", hazard_type: "gas leak",
    why: "new episode", simulated: false, until: undefined, primary_hazard_type: "air pollution" });
  assert.equal(s.status("N1", t0 + 60_000).desired, "on");
  assert.match(s.history("N1")[0].detail, /confirmed CRITICAL gas leak \(new episode, measured behind the primary air pollution\)/);
  // same episode: the next identical reading does not re-trigger
  s.officerAction("N1", "off", null, "officer1", t0 + 70_000);
  assert.equal(s.onAiResult({ node_id: "N1" }, aqiWithGas(t0 + 120_000), t0 + 120_000), undefined);
  assert.equal(s.status("N1", t0 + 120_000).desired, "off");
});

test("a CRITICAL flood hidden behind a severe heat wave sounds it; an earlier PRIMARY flood counts as the first sighting", () => {
  const s = memSirens();
  const t0 = Date.parse("2026-10-09T12:00:00Z");
  s.recordReported([fit()], t0);
  // the flood was the primary (HIGH) a minute earlier
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("HIGH", "flood", t0), t0), undefined);
  const heat = confirmedAt("CRITICAL", "extreme heat", t0 + 60_000, {
    risk_score: 0.95, imd_category: "severe_heat_wave",
    hazard_scores: { "extreme heat": { risk_score: 0.95, severity: "CRITICAL" },
      flood: { risk_score: 0.93, severity: "CRITICAL", severity_source: "ml_model" } },
  });
  const fired = s.onAiResult({ node_id: "N1" }, heat, t0 + 60_000);
  assert.equal(fired.hazard_type, "flood");
  assert.equal(fired.why, "escalation", "HIGH -> CRITICAL in the same flood episode");
});

test("a hidden evacuation result never sounds it when forecast-based, held, stuck, too old, or seen only once", () => {
  const t0 = Date.parse("2026-10-09T13:00:00Z");
  const gas = { risk_score: 0.9167, severity: "CRITICAL" };
  const cases = {
    "forecast-based": [{ ...gas, forecast_based: true }, {}],
    "held by the node's river checks": [{ ...gas, held_by_edge_anomaly: ["stuck:river_level_m"] }, {}],
    "gas sensor flagged stuck": [gas, { edge_anomaly: ["stuck:gas_ppm"] }],
    "stuck flag as a comma string": [gas, { edge_anomaly: "dropout:pm25_ugm3,stuck:gas_ppm" }],
  };
  for (const [name, [entry, sensorExtra]] of Object.entries(cases)) {
    const s = memSirens();
    s.recordReported([fit()], t0);
    for (const dt of [0, 60_000, 120_000]) {
      assert.equal(s.onAiResult({ node_id: "N1", ...sensorExtra }, aqiWithGas(t0 + dt, entry), t0 + dt), undefined, name);
    }
    assert.equal(s.status("N1", t0 + 120_000).desired, null, name);
  }
  // a first sighting more than 10 min before does not count
  const s = memSirens();
  s.recordReported([fit()], t0);
  assert.equal(s.onAiResult({ node_id: "N1" }, aqiWithGas(t0), t0), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, aqiWithGas(t0 + 11 * 60_000), t0 + 11 * 60_000), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, aqiWithGas(t0 + 12 * 60_000), t0 + 12 * 60_000).hazard_type, "gas leak");
  // a hidden type not in SIREN_AUTO_HAZARDS is ignored
  const only = memSirens({ autoHazards: "flood" });
  only.recordReported([fit()], t0);
  only.onAiResult({ node_id: "N1" }, aqiWithGas(t0), t0);
  assert.equal(only.onAiResult({ node_id: "N1" }, aqiWithGas(t0 + 60_000), t0 + 60_000), undefined);
});

test("SIREN_AUTO_HAZARDS set by the operator: only the listed types sound", () => {
  const s = memSirens({ autoHazards: "landslide" });
  const t0 = Date.parse("2026-10-09T10:00:00Z");
  s.recordReported([fit()], t0);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "flood", t0), t0), undefined);
  assert.equal(s.onAiResult({ node_id: "N1" }, confirmedAt("CRITICAL", "landslide", t0 + 1), t0 + 1).why, "new episode");
  assert.deepEqual(s.autoHazards, ["landslide"]);
});

test("GET /api/sirens lists the automatic-siren hazards; a confirmed CRITICAL heat wave commands nothing", async () => {
  const list = (await srv.call("GET", "/api/sirens", undefined, officer)).data;
  assert.deepEqual(list.auto_hazards, [...DEFAULT_AUTO_HAZARDS]);
  const b = await batch([critical("SIREN-07", { test_hazard: "extreme heat", test_extra: { imd_category: "severe_heat_wave" } })]);
  assert.equal(b.data.commands, undefined);
  assert.equal((await sirenOf("SIREN-07")).desired, null);
});

test("/api/hazards and /api/hazard-zones say which alerts are forecast-based (for the area-wide alarm item)", async () => {
  await batch([
    r("SIREN-01", { test_severity: "HIGH", test_status: "alert_dispatched", test_hazard: "heavy_rain",
      test_extra: { forecast_based: true, severity_source: "weather_forecast" } }),
    r("SIREN-02", { test_severity: "HIGH", test_status: "alert_dispatched", test_hazard: "heavy_rain" }),
  ]);
  const hazards = (await srv.call("GET", "/api/hazards")).data.hazards;
  assert.equal(hazards.find((h) => h.node_id === "SIREN-01").forecast_based, true);
  assert.equal(hazards.find((h) => h.node_id === "SIREN-02").forecast_based, false);
  const zones = (await srv.call("GET", "/api/hazard-zones")).data.zones;
  assert.equal(zones.find((z) => z.node_id === "SIREN-01").forecast_based, true);
  assert.equal(zones.find((z) => z.node_id === "SIREN-02").forecast_based, false);
});
