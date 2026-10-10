// Tests for SOS requests from the offline "SANJEEVNI-SOS" Wi-Fi page,
// forwarded by a gateway to POST /api/ingest/sos (server.js createHotspotSos).
// Run: node --test server/hotspot_sos.test.js
// A REAL server.js on a spare port with a temporary database and a fake AI
// backend (test_server.js) - the user's servers on 3000 / 8000 are untouched.
const test = require("node:test");
const assert = require("node:assert/strict");
const { startTestServer, OFFICER_KEY } = require("./test_server");

const NODE_07 = ["NODE-07", "Upstream footbridge", 29.4002, 79.461];
let srv;

test.before(async () => {
  srv = await startTestServer({
    nodes: [NODE_07, ["NODE-08", "School", 29.41, 79.47], ["NODE-NOPOS", "Unsurveyed hut", null, null],
      ["NODE-RATE", "Market", 29.42, 79.48]],
    keys: { gateway: { nodes: "*" }, node08only: { nodes: "NODE-08" }, simulator: { kind: "simulator", nodes: "*" } },
  });
});
test.after(async () => srv && srv.stop());

let uid = 0;
const hotspot = (body, key = srv.keys.gateway) =>
  srv.call("POST", "/api/ingest/sos", { sos_uid: `s${++uid}`, client_id: `c${uid}`, people: null, needs: [],
    note: "", latitude: null, longitude: null, age_seconds: null, ...body }, key ? { "X-Device-Key": key } : {});
const feed = async (all = false) =>
  (await srv.call("GET", `/api/sos${all ? "?status=all" : ""}`, undefined, { "X-API-Key": OFFICER_KEY })).data;
const row = async (id) => (await feed(true)).data.find((s) => s.id === id);

test("a request at a registered node: stored at its position, within ~150 m, with people and needs", async () => {
  const res = await hotspot({ node_id: "NODE-07", client_id: "ph1", people: 3, needs: ["trapped", "injured"],
    note: "Roof of the blue house, water rising" });
  assert.equal(res.status, 200);
  assert.equal(res.data.status, "ok");
  const s = await row(res.data.sos_id);
  assert.equal(s.location_source, "hotspot");
  assert.equal(s.node_id, "NODE-07");
  assert.equal(s.latitude, NODE_07[2]);
  assert.equal(s.longitude, NODE_07[3]);
  assert.equal(s.location_accuracy_m, 150);
  assert.equal(s.people, 3);
  assert.deepEqual(s.needs, ["trapped", "injured"]);
  assert.equal(s.note, "Offline SOS Wi-Fi at NODE-07 (Upstream footbridge): \"Roof of the blue house, water rising\"");
  assert.ok(!("device_id" in s), "the phone's id is not shown");
});

test("a retry of the same sos_uid is a duplicate - also after the officer resolved it", async () => {
  const body = { node_id: "NODE-07", sos_uid: "retry-1", client_id: "ph2" };
  const first = await srv.call("POST", "/api/ingest/sos", body, { "X-Device-Key": srv.keys.gateway });
  const again = await srv.call("POST", "/api/ingest/sos", body, { "X-Device-Key": srv.keys.gateway });
  assert.deepEqual(again.data, { status: "duplicate", sos_id: first.data.sos_id });
  await srv.call("POST", `/api/sos/${first.data.sos_id}/resolve`, undefined, { "X-API-Key": OFFICER_KEY });
  const late = await srv.call("POST", "/api/ingest/sos", body, { "X-Device-Key": srv.keys.gateway });
  assert.equal(late.data.status, "duplicate");
  assert.equal((await feed(true)).data.filter((s) => s.id === first.data.sos_id).length, 1);
});

test("one open request per phone: a second one while the first is open joins it, adding what is new", async () => {
  const a = await hotspot({ node_id: "NODE-08", client_id: "ph3", people: 2, needs: ["trapped"], note: "On the roof" });
  const b = await hotspot({ node_id: "NODE-08", client_id: "ph3", people: 5, needs: ["injured", "trapped"],
    note: "Now 5 people, one injured" });
  assert.equal(b.status, 200);
  assert.deepEqual(b.data, { status: "already_active", sos_id: a.data.sos_id });
  let s = await row(a.data.sos_id);
  assert.equal(s.people, 5, "the larger count wins");
  assert.deepEqual(s.needs, ["trapped", "injured"]);
  assert.match(s.note, /: "On the roof" \| update: "Now 5 people, one injured"$/);
  assert.match(srv.web.output, new RegExp(`follow-up from client ph3 -> SOS #${a.data.sos_id} updated`));
  // a smaller count or no text never takes anything away
  await hotspot({ node_id: "NODE-08", client_id: "ph3", people: 1 });
  s = await row(a.data.sos_id);
  assert.equal(s.people, 5);
  assert.match(s.note, /update: "Now 5 people, one injured"$/);
  // a TEST request never edits a real person's SOS
  await hotspot({ node_id: "NODE-08", client_id: "ph3", people: 50, note: "test" }, srv.keys.simulator);
  assert.equal((await row(a.data.sos_id)).people, 5);
  // another phone at the same hotspot is another person
  const c = await hotspot({ node_id: "NODE-08", client_id: "ph4" });
  assert.equal(c.data.status, "ok");
  assert.notEqual(c.data.sos_id, a.data.sos_id);
});

test("typed coordinates are used as given, without an accuracy figure, and labelled", async () => {
  const res = await hotspot({ node_id: "NODE-07", client_id: "ph5", latitude: 29.395, longitude: 79.455 });
  const s = await row(res.data.sos_id);
  assert.equal(s.latitude, 29.395);
  assert.equal(s.longitude, 79.455);
  assert.equal(s.location_accuracy_m, null);
  assert.match(s.note, /no description given - location typed by the person$/);
  // far from the hotspot (typo, swapped lat/lon): the node position is kept, the typed pair only noted
  const far = await hotspot({ node_id: "NODE-07", client_id: "ph5b", latitude: 79.461, longitude: 29.4002 });
  const f = await row(far.data.sos_id);
  assert.equal(f.latitude, NODE_07[2]);
  assert.equal(f.longitude, NODE_07[3]);
  assert.equal(f.location_accuracy_m, 150);
  assert.match(f.note, /typed location 79\.461,29\.4002 is \d+\.\d km from the hotspot \(unverified, NOT used for the pin\)$/);
  assert.doesNotMatch(f.note, /location typed by the person/);
  // nonsense coordinates fall back to the node's position
  const bad = await hotspot({ node_id: "NODE-07", client_id: "ph6", latitude: 123, longitude: "x" });
  const b = await row(bad.data.sos_id);
  assert.equal(b.latitude, NODE_07[2]);
  assert.equal(b.location_accuracy_m, 150);
});

test("a hotspot with no registered position: stored, listed as unlocated with people and needs", async () => {
  const res = await hotspot({ node_id: "NODE-NOPOS", client_id: "ph7", people: 4, needs: ["medical"] });
  const gw = await hotspot({ node_id: "GW-01", client_id: "ph8" }); // a gateway that is not in the registry
  assert.equal(res.data.status, "ok");
  assert.equal(gw.data.status, "ok");
  const f = await feed();
  assert.ok(!f.data.some((s) => s.id === res.data.sos_id), "no pin without a position");
  const u = f.unlocated_node_sos.find((s) => s.id === res.data.sos_id);
  assert.equal(u.node_id, "NODE-NOPOS");
  assert.equal(u.location_source, "hotspot");
  assert.equal(u.people, 4);
  assert.deepEqual(u.needs, ["medical"]);
  assert.match(u.note, /Offline SOS Wi-Fi at NODE-NOPOS \(Unsurveyed hut\)/);
  assert.ok(f.unlocated_node_sos.some((s) => s.id === gw.data.sos_id && s.node_id === "GW-01"));
  assert.match(srv.web.output, /offline SOS Wi-Fi request at GW-01, which has NO registered position/);
  // the same phone again: still one open request
  const again = await hotspot({ node_id: "NODE-NOPOS", client_id: "ph7" });
  assert.deepEqual(again.data, { status: "already_active", sos_id: res.data.sos_id });
});

test("input from the phone is capped and cleaned; unknown needs and bad counts are dropped", async () => {
  const res = await hotspot({ node_id: "NODE-07", client_id: "<b>ph9</b>", people: 1e6,
    needs: ["fire", "pizza", "fire", 7], note: `line1\nline2\u0000${"x".repeat(400)}` });
  const s = await row(res.data.sos_id);
  assert.equal(s.people, null);
  assert.deepEqual(s.needs, ["fire"]);
  const text = s.note.match(/: "(.*)"$/)[1];
  assert.equal(text.length, 160);
  assert.ok(text.startsWith("line1 line2 x"));
  // client id without usable characters: falls back to the request's uid - never merged with others
  const odd1 = await hotspot({ node_id: "NODE-08", client_id: "!!!" });
  const odd2 = await hotspot({ node_id: "NODE-08", client_id: "" });
  assert.equal(odd1.data.status, "ok");
  assert.equal(odd2.data.status, "ok");
  assert.notEqual(odd1.data.sos_id, odd2.data.sos_id);
  for (const people of [0, -2, 2.5, "3"]) {
    const r = await hotspot({ node_id: "NODE-07", people });
    assert.equal((await row(r.data.sos_id)).people, null, `people ${JSON.stringify(people)}`);
  }
});

test("device key and node scoping, and requests that can never be accepted", async () => {
  assert.equal((await hotspot({ node_id: "NODE-07" }, null)).status, 401);
  assert.equal((await hotspot({ node_id: "NODE-07" }, "sjk_not-a-real-key")).status, 401);
  const refused = await hotspot({ node_id: "NODE-07" }, srv.keys.node08only);
  assert.equal(refused.status, 403);
  assert.match(refused.data.error, /add NODE-07 to the key's node list/);
  assert.match(srv.web.output, /\[sos\] !!! offline SOS Wi-Fi request from NODE-07 REFUSED: device key 'node08only'/);
  const logged = srv.web.output.split("REFUSED: device key 'node08only'").length;
  await hotspot({ node_id: "NODE-07" }, srv.keys.node08only);
  assert.equal(srv.web.output.split("REFUSED: device key 'node08only'").length, logged, "logged once per key+node, not per retry");
  assert.equal((await hotspot({ node_id: "NODE-08" }, srv.keys.node08only)).status, 200);
  assert.equal((await hotspot({ node_id: "bad id!" })).status, 400);
  assert.equal((await hotspot({ node_id: "NODE-07", sos_uid: "" })).status, 400);
  assert.equal((await hotspot({ node_id: "NODE-07", sos_uid: "has space" })).status, 400);
  assert.equal((await srv.call("POST", "/api/ingest/sos", [], { "X-Device-Key": srv.keys.gateway })).status, 400);
});

test("the public web SOS can never use (or look up) a hotspot device id", async () => {
  const web = await srv.call("POST", "/api/sos", { latitude: 29.39, longitude: 79.45, device_id: "hotspot:NODE-07:ph1" });
  assert.equal(web.status, 400);
  assert.deepEqual((await srv.call("GET", "/api/sos/device/hotspot%3ANODE-07%3Aph1")).data, { active: false });
});

test("simulated requests are marked, and a real one never joins an open test SOS", async () => {
  const sim = await hotspot({ node_id: "NODE-08", sos_uid: "same", client_id: "phX" }, srv.keys.simulator);
  assert.match((await row(sim.data.sos_id)).note, /SIMULATED/);
  const real = await hotspot({ node_id: "NODE-08", sos_uid: "same", client_id: "phX" });
  assert.equal(real.data.status, "ok", "a test uid never swallows a real request");
  assert.notEqual(real.data.sos_id, sim.data.sos_id);
  assert.equal((await row(sim.data.sos_id)).status, "superseded");
  assert.doesNotMatch((await row(real.data.sos_id)).note, /SIMULATED/);
});

test("rate limit per hotspot answers 429 (retry later); retries of stored requests are not counted", async () => {
  const first = await hotspot({ node_id: "NODE-RATE", sos_uid: "rate-0", client_id: "r0" });
  let limited = null;
  for (let i = 1; i <= 70 && !limited; i++) {
    const res = await hotspot({ node_id: "NODE-RATE", client_id: `r${i}` });
    if (res.status === 429) limited = i;
  }
  assert.equal(limited, 60, "the 61st request in 10 minutes is refused");
  const retry = await srv.call("POST", "/api/ingest/sos", { node_id: "NODE-RATE", sos_uid: "rate-0", client_id: "r0" },
    { "X-Device-Key": srv.keys.gateway });
  assert.deepEqual(retry.data, { status: "duplicate", sos_id: first.data.sos_id });
});
