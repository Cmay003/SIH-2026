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
// rule (repeat on the node, or a neighbour, within 10 minutes, per hazard).
// Options - each feature can be switched off to play an older or broken server:
//   nodeSos: false     a server from before the node SOS button (ignores sos_button)
//   siren: "CRITICAL"  the auto rule (server/siren.js); "HIGH" = a server that
//                      wrongly sounds it on HIGH; false = no siren support
//   hotspot: false     no POST /api/ingest/sos (404)
//   confidence: false  no confidence anywhere; backendConfidence: true = the
//                      backend's own reading rows carry it too
//   smoke: false       a backend without the smoke classifier
//   weather: false     a backend without forecast weather hazards (or one that
//                      ignores SANJEEVNI_WEATHER_MOCK); weatherSeverity: the
//                      severity it gives them ("CRITICAL" = the cap is broken);
//                      weatherReason: false = no forecast confidence reason
//   analytics: false   no /api/analytics/trends|summary; simulatedNote: false =
//                      their data_note does not say the data is simulated
//   capFeed: false     no /cap/feed.atom; feedLink: "backend" = entries link to
//                      the loopback backend; feedType: the feed's content-type;
//                      capStatus: the CAP <status> of /cap/alerts/<id>.xml;
//                      feedLink: "other-host" = absolute links to another
//                      server; feedIncludesPending: true = the feed also lists
//                      pending (unconfirmed) readings; capServesPending: true =
//                      /cap/alerts/<id>.xml answers for a pending reading too
//   sirenHazards: the hazard types the auto rule sounds for (siren.js
//                      SIREN_AUTO_HAZARDS, default the evacuation hazards);
//                      null = an older server that sounds it for any type
//   heatMax: the highest severity the backend gives extreme heat ("MEDIUM" =
//                      a node whose heat_region is hilly / coastal, no normal)
//   stormFloodSiren: true  the storm forecast lifts NODE-04's flood into a NEW
//                      episode, so its CRITICAL flood sounds the siren again
//                      during the weather cue (a flood-typed reading)
// Feed entries name the LOCATION, not the node id - like the real backend
// (analytics.build_atom_feed), so the demo must find its own entries by
// their CAP link id (integration 2026-10-09).
// The flood is CRITICAL with >= 50 mm of rain in the node's last 24 h, like
// the real model's dependence on 24 h rain (see DOWNPOUR_MM in run_demo.js).
// The forecast (st.weather) is "calm" until the demo calls io.setWeather.
function fakeStack(t0 = Date.UTC(2026, 9, 8, 6, 0, 0), opts = {}) {
  const { nodeSos = true, siren = "CRITICAL", hotspot = true, confidence = true, backendConfidence = false, smoke = true,
    weather = true, weatherSeverity = "HIGH", weatherReason = true, analytics = true, simulatedNote = true,
    capFeed = true, feedLink = "public", feedType = "application/atom+xml; charset=utf-8", capStatus = "Exercise",
    feedIncludesPending = false, capServesPending = false, stormFloodSiren = false,
    sirenHazards = ["flood", "flash_flood", "landslide", "fire", "gas_leak"], heatMax = "CRITICAL" } = opts;
  const st = { now: t0, rows: [], posts: [], sos: [], lines: [], sosUids: new Set(), sirens: {}, hotspotUids: new Map(),
    weather: "calm", weatherChanges: [] };
  const RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
  const RISK = { LOW: 0.2, MEDIUM: 0.5, HIGH: 0.8, CRITICAL: 0.95, "N/A": 0 };
  // server.js's node-button rule: an SOS at the node's registered position,
  // one per (node, reading_uid), and none while that node's SOS is open.
  const buttonSos = (r) => {
    if (!nodeSos || r.sos_button !== true) return;
    const key = `${r.node_id}/${r.reading_uid}`;
    const device_id = `node:${r.node_id}`;
    if (st.sosUids.has(key) || st.sos.some((s) => s.device_id === device_id && s.status === "open")) return;
    st.sosUids.add(key);
    st.sos.push({ id: st.sos.length + 1, device_id, ...NODE_POS[r.node_id], location_source: "node", status: "open",
      note: `SOS button pressed on sensor node ${r.node_id}` });
  };
  // siren.js recordReported: what the node says about its siren
  const sirenReported = (r) => {
    if (!siren || r.siren_fitted !== true) return;
    const s = (st.sirens[r.node_id] ||= { fitted: true, sounding: false, desired: null, reason: null, until: 0, peak: -1 });
    s.sounding = r.siren_on === true;
  };
  // siren.js onAiResult: once per episode, again only on escalation
  const sirenAuto = (r, a) => {
    const s = st.sirens[r.node_id];
    if (!siren || !s) return;
    if (stormFloodSiren && st.weather === "storm" && !st.stormEpisode) {
      st.stormEpisode = true;
      s.peak = -1; // the forecast-driven flood counts as a new episode
    }
    if (!a.elevated) { s.peak = -1; return; }
    // not an evacuation hazard: never sounds by itself, does not touch the episode
    if (sirenHazards && !sirenHazards.includes(String(a.hazard_type).toLowerCase().replace(/[\s-]+/g, "_"))) return;
    if (a.status !== "alert_dispatched") return;
    const rank = RANK[a.severity];
    const previous = s.peak;
    s.peak = Math.max(s.peak, rank);
    if (rank >= RANK[siren] && rank > previous) {
      Object.assign(s, { desired: "on", reason: "auto", until: st.now + 180000, lastOn: { actor: "auto", at: st.now } });
    }
  };
  const commandsFor = (readings) => {
    const out = [];
    for (const r of readings) {
      const s = st.sirens[r.node_id];
      if (!siren || !s || r.siren_fitted !== true || out.some((c) => c.node_id === r.node_id)) continue;
      if (s.desired === "on" && !s.sounding && s.until > st.now) {
        out.push({ node_id: r.node_id, siren: "on", for_s: Math.ceil((s.until - st.now) / 1000) });
      }
    }
    return out.length ? { commands: out } : {};
  };
  const rain24 = (node, takenAt) => st.rows.filter((x) => x.node_id === node && takenAt - x.takenAt < 24 * 60 * MIN)
    .reduce((a, x) => a + x.rain, 0);
  const assess = (r, takenAt) => {
    if (r.river_level_m > 10) return { status: "suppressed", severity: "N/A", hazard_type: null };
    let hazard_type = null;
    let severity = "LOW";
    let forecastOnly = false;
    if (smoke && r.pm25_ugm3 >= 80 && r.gas_ppm >= 450) {
      hazard_type = "smoke";
      severity = "HIGH";
    } else if (r.river_level_m >= 2.5) {
      hazard_type = "flood";
      severity = rain24(r.node_id, takenAt) + (r.rainfall_mm_since_last || 0) >= 50 ? "CRITICAL" : "HIGH";
    } else if (r.temp_c >= 40) {
      // IMD plains: 40 C considered, 45 C heat wave, 47 C severe heat wave
      hazard_type = "extreme heat";
      severity = r.temp_c >= 47 ? "CRITICAL" : r.temp_c >= 45 ? "HIGH" : "MEDIUM";
      if (RANK[severity] > RANK[heatMax]) severity = heatMax;
    } else if (weather && st.weather === "storm") {
      // the forecast applies to every node; it is the primary hazard only
      // where nothing measured is worse
      hazard_type = "heavy_rain";
      severity = weatherSeverity;
      forecastOnly = true;
    } else {
      return { status: "logged", severity, hazard_type };
    }
    const recent = (node) => st.rows.some((x) => x.node_id === node && x.elevated && x.hazard_type === hazard_type &&
      takenAt - x.takenAt <= 10 * MIN);
    let confirmation = "unconfirmed";
    if (recent(r.node_id)) confirmation = "persistent";
    else {
      const n = NEIGHBOURS[r.node_id].find(recent);
      if (n) confirmation = `neighbour:${n}`;
    }
    const confirmed = confirmation !== "unconfirmed";
    const conf = !confidence ? {} : confirmed
      ? { confidence: 0.82, confidence_label: "High", confidence_reasons: [`confirmed (${confirmation})`, "edge AI agrees"] }
      : { confidence: 0.42, confidence_label: "Low", confidence_reasons: ["one reading, not confirmed yet"] };
    if (forecastOnly && confidence && weatherReason) {
      conf.confidence_reasons = ["forecast-based (Open-Meteo), not measured on site", ...conf.confidence_reasons];
    }
    return { status: confirmed ? "alert_dispatched" : "pending_confirmation", severity, hazard_type, confirmation,
      elevated: true, ...conf };
  };
  const ingest = (r) => {
    buttonSos(r); // in server.js, before (and regardless of) the AI backend
    sirenReported(r);
    const takenAt = st.now - (r.age_seconds || 0) * 1000;
    const a = assess(r, takenAt);
    const row = { id: st.rows.length + 1, node_id: r.node_id, reading_uid: r.reading_uid, takenAt, rain: r.rainfall_mm_since_last || 0,
      level: r.river_level_m, simulated: r.simulated === true,
      timestamp: new Date(takenAt).toISOString(), delay_seconds: (st.now - takenAt) / 1000, ...a };
    st.rows.push(row);
    sirenAuto(r, a);
    return row.status;
  };
  const latestAlerts = () => {
    const latest = {};
    for (const r of st.rows) latest[r.node_id] = r;
    return Object.values(latest).filter((r) => r.status === "alert_dispatched");
  };
  const confidenceFields = (r) => (confidence
    ? { confidence: r.confidence, confidence_label: r.confidence_label, confidence_reasons: r.confidence_reasons } : {});
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
        if (u.pathname === "/api/ingest") return ok({ status: "success", ai_action: ingest(body), ...commandsFor([body]) });
        if (u.pathname === "/api/ingest/batch") {
          const results = body.readings.map((r) => ({ node_id: r.node_id, ai_action: ingest(r) }));
          return ok({ status: "success", results, ...commandsFor(body.readings) });
        }
        if (u.pathname === "/api/ingest/sos" && hotspot) {
          const key = `${body.node_id}/${body.sos_uid}`;
          if (st.hotspotUids.has(key)) return ok({ status: "duplicate", sos_id: st.hotspotUids.get(key) });
          const id = st.sos.length + 1;
          st.sos.push({ id, device_id: `hotspot:${body.node_id}:${body.client_id}`, ...NODE_POS[body.node_id],
            location_source: "hotspot", location_accuracy_m: 150, people: body.people, needs: body.needs.join(","),
            status: "open", note: body.note });
          st.hotspotUids.set(key, id);
          return ok({ status: "ok", sos_id: id });
        }
        return ok({ error: "not found" }, 404);
      }
      if (u.pathname === "/api/readings") {
        const node = u.searchParams.get("node_id");
        const rows = st.rows.filter((r) => !node || r.node_id === node).slice().reverse()
          .map(({ confidence: c, confidence_label: l, confidence_reasons: why, ...r }) =>
            (backendConfidence ? { ...r, confidence: c, confidence_label: l, confidence_reasons: why } : r));
        return ok(rows.slice(0, Number(u.searchParams.get("limit") || 50)));
      }
      if (u.pathname.startsWith("/api/forecast/")) return ok({ available: true, current_level_m: 1.65 });
      if (u.pathname === "/api/hazards") {
        return ok({ hazards: latestAlerts().map((r) => ({ node_id: r.node_id, hazard_type: r.hazard_type, severity: r.severity,
          stale: false, ...confidenceFields(r) })) });
      }
      if (u.pathname === "/api/hazard-zones") {
        return ok({ zones: latestAlerts().map((r) => ({ node_id: r.node_id, ...NODE_POS[r.node_id], radius_m: 1000 })) });
      }
      if (method === "POST" && u.pathname === "/api/sos") {
        st.sos.push({ id: st.sos.length + 1, ...body, location_source: body.location_source || "gps", status: "open" });
        return ok({ status: "received", sos_id: st.sos.length, hospital: "H", distance_km: 1 }, 201);
      }
      if (u.pathname.startsWith("/api/sos/device/")) {
        const id = decodeURIComponent(u.pathname.split("/").pop());
        if (/^(whatsapp|node|hotspot):/i.test(id)) return ok({ active: false }); // reserved, as in server.js
        const open = st.sos.find((s) => s.device_id === id && s.status === "open");
        return ok(open ? { active: true, sos_id: open.id, hospital: "H", distance_km: 1 } : { active: false });
      }
      if (u.pathname === "/api/analytics/trends" && analytics) {
        const node = u.searchParams.get("node_id");
        const buckets = new Map();
        for (const r of st.rows.filter((x) => x.node_id === node)) {
          const t = Math.floor(r.takenAt / (60 * MIN)) * 60 * MIN;
          const b = buckets.get(t) || { levels: [], risks: [] };
          if (Number.isFinite(r.level)) b.levels.push(r.level);
          b.risks.push(RISK[r.severity] ?? 0);
          buckets.set(t, b);
        }
        const series = [...buckets].sort((a, b) => a[0] - b[0]).map(([t, b]) => ({
          t: new Date(t).toISOString(), risk_score_max: Math.max(...b.risks), severity_max: null,
          river_level_m: b.levels.length
            ? { min: Math.min(...b.levels), max: Math.max(...b.levels), mean: b.levels.reduce((a, x) => a + x, 0) / b.levels.length }
            : null,
        }));
        return ok({ node_id: node, range: u.searchParams.get("range"), bucket_s: 3600, generated_at: new Date(st.now).toISOString(),
          data_note: simulatedNote ? "Includes SIMULATED readings (demo data)" : "", series });
      }
      if (u.pathname === "/api/analytics/summary" && analytics) {
        const alerts_by_hazard = {};
        for (const r of st.rows.filter((x) => x.status === "alert_dispatched")) {
          const h = (alerts_by_hazard[r.hazard_type] ||= { count: 0, confirmed: 0, max_severity: "LOW" });
          h.count++;
          h.confirmed++;
          if (RANK[r.severity] > RANK[h.max_severity]) h.max_severity = r.severity;
        }
        return ok({ range: u.searchParams.get("range"), generated_at: new Date(st.now).toISOString(),
          data_note: simulatedNote ? "Simulated data - not real measurements" : "", alerts_by_hazard, alerts_by_node: {},
          exceedance_hours: { pm25_poor_or_worse: 0, pm10_poor_or_worse: 0, heat_wave: 0 },
          top_hotspots: [{ node_id: "NODE-04", location: "Riverside", score: 0.9, dominant_hazard: "flood" }], node_uptime_pct: {} });
      }
      if (u.pathname === "/cap/feed.atom" && capFeed) {
        const listed = latestAlerts().concat(feedIncludesPending ? st.rows.filter((r) => r.status === "pending_confirmation") : []);
        const entries = listed.map((r) => {
          const href = feedLink === "public" ? `/cap/alerts/${r.id}.xml`
            : feedLink === "other-host" ? `http://127.0.0.1:3000/cap/alerts/${r.id}.xml`
              : `http://127.0.0.1:8100/api/alerts/${r.id}/cap`;
          return `<entry><id>urn:sanjeevni:alert:${r.id}</id><title>[EXERCISE] ${r.hazard_type} ${r.severity}: ${r.location || "Riverside"}</title>` +
            `<link rel="alternate" type="application/cap+xml" href="${href}"/><updated>${r.timestamp}</updated></entry>`;
        });
        const text = `<?xml version="1.0" encoding="utf-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">` +
          `<title>SANJEEVNI CAP alerts</title>${entries.join("")}</feed>`;
        return { status: 200, data: null, text, type: feedType };
      }
      const capMatch = u.pathname.match(/^\/cap\/alerts\/(\d+)\.xml$/);
      if (capMatch && capFeed) {
        const row = st.rows.find((r) => r.id === Number(capMatch[1]) &&
          (r.status === "alert_dispatched" || (capServesPending && r.status === "pending_confirmation")));
        if (!row) return { status: 404, data: null, text: "not found", type: "text/plain" };
        const text = `<?xml version="1.0"?><alert xmlns="urn:oasis:names:tc:emergency:cap:1.2">` +
          `<identifier>SANJEEVNI-${row.id}</identifier><status>${capStatus}</status></alert>`;
        return { status: 200, data: null, text, type: "application/xml" };
      }
      if (u.pathname.startsWith("/api/analytics/") || u.pathname.startsWith("/cap/")) {
        return { status: 404, data: { detail: "Not Found" }, text: "{\"detail\":\"Not Found\"}", type: "application/json" };
      }
      throw new Error(`fake stack: no route for ${method} ${u.pathname}`);
    },
  };
  return { st, io };
}

// What dbReaders returns for the fake stack (the database checks)
const fakeSosRows = (st) => (deviceId, nodeId) => st.sos.filter((s) => s.device_id === deviceId)
  .map(({ id, status, latitude, longitude, location_source, location_accuracy_m = null, people = null, needs = null }) => ({
    id, status, latitude, longitude, location_source, location_accuracy_m, people, needs,
    node_latitude: NODE_POS[nodeId].latitude, node_longitude: NODE_POS[nodeId].longitude,
  }));
const fakeSirenRow = (st) => (nodeId) => {
  const s = st.sirens[nodeId];
  return s && { node_id: nodeId, fitted: 1, sounding: s.sounding ? 1 : 0, desired: s.desired, desired_reason: s.reason,
    desired_by: s.reason, reported_simulated: 1, reported_at: new Date(st.now).toISOString(),
    // readSirenRow's siren_audit fields
    last_on_actor: s.lastOn ? s.lastOn.actor : null, last_on_at: s.lastOn ? new Date(s.lastOn.at).toISOString() : null };
};
// sensor_data as server.js stores it: no reading_uid, confidence_reasons as JSON
const fakeSensorRows = (st) => (nodeId) => st.rows.filter((r) => r.node_id === nodeId).slice().reverse()
  .map((r) => ({ id: r.id, node_id: r.node_id, hazard_type: r.hazard_type, severity: r.severity, status: r.status,
    timestamp: r.timestamp, confidence: r.confidence ?? null, confidence_label: r.confidence_label ?? null,
    confidence_reasons: r.confidence_reasons ? JSON.stringify(r.confidence_reasons) : null }));
// ... and what main() adds for --fresh: control of the backend's forecast
const fakeDb = (st, io) => Object.assign(io, { sosRows: fakeSosRows(st), sirenRow: fakeSirenRow(st), sensorRows: fakeSensorRows(st),
  setWeather: (kind) => { st.weather = kind; st.weatherChanges.push({ kind, at: st.now, rows: st.rows.length }); } });

const FAST = ["--interval", "4", "--pace", "20", "--outage", "20", "--key", "k", "--exit"];

// prepare(st, io) runs before the demo: a leftover SOS, another database reader...
// The database readers are there by default, as main() sets them up.
async function runStory(seed = 42, { stack = {}, prepare = () => {} } = {}) {
  const { st, io } = fakeStack(undefined, stack);
  fakeDb(st, io);
  prepare(st, io);
  const d = new Demo({ ...parseArgs([...FAST, "--seed", String(seed)], {}), runId: "test" }, io);
  await d.backfill();
  await d.story();
  return { st, d };
}

// The readings as the sensors produced them (what a judge would see),
// without per-run ids and send-time fields. (Not the Wi-Fi SOS: no reading.)
const payloads = (st) => st.posts.filter((p) => p.path !== "/api/ingest/sos").flatMap((p) => (p.body.readings || [p.body]))
  .map(({ reading_uid, age_seconds, ...rest }) => rest);
const failedIds = (d) => d.checks.filter((c) => !c.pass).map((c) => c.id);
const checkOf = (d, id) => d.checks.find((c) => c.id === id);

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

test("the story: pending -> confirmed -> CRITICAL siren -> fault -> smoke -> SOS x3 -> backlog", async () => {
  const { st, d } = await runStory();
  const failed = d.checks.filter((c) => !c.pass);
  assert.deepEqual(failed, [], st.lines.join("\n"));
  assert.deepEqual(d.checks.map((c) => c.id),
    ["backfill", "forecast", "upstream-pending", "river-confirmed", "alarm", "confidence", "village-siren",
      "fault-suppressed", "smoke", "sos-in-zone", "node-sos", "hotspot-sos", "outage-backlog",
      "weather-advisory", "heat-no-siren", "trends", "cap-feed"]);
  for (let n = 1; n <= 13; n++) assert.ok(st.lines.some((l) => l.includes(`\n CUE ${n}/13 `)), `cue ${n} announced`);

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

  // exactly one web SOS (rate limits), marked as simulated, inside the NODE-04 zone
  const web = st.sos.filter((s) => s.location_source === "gps");
  assert.equal(web.length, 1);
  assert.match(web[0].note, /SIMULATED/);
  assert.ok(haversineM(29.3919, 79.4542, web[0].latitude, web[0].longitude) < 1000);

  // the SOS button: ONE flagged reading, from NODE-07, after the citizen SOS and
  // before the outage; the flag is absent (not false) on every other reading
  const pressed = all.filter((r) => "sos_button" in r);
  assert.equal(pressed.length, 1);
  assert.equal(pressed[0].sos_button, true);
  assert.equal(pressed[0].node_id, "NODE-07");
  assert.equal(pressed[0].link, "lora");
  assert.equal(d.sent.find((e) => e.sos).cue, "8-node-sos");
  const nodeSos = st.sos.filter((s) => s.location_source === "node");
  assert.equal(nodeSos.length, 1);
  assert.equal(nodeSos[0].device_id, "node:NODE-07");
  assert.ok(st.sos.indexOf(nodeSos[0]) > st.sos.indexOf(web[0]), "after the citizen SOS");
  assert.ok(st.lines.some((l) => /CUE 8\/13 .*SOS button on NODE-07/.test(l)), "cue 8 is announced");
  assert.ok(st.lines.some((l) => /NODE-07 .*\[SOS button\]/.test(l)), "the flagged reading is logged");

  // the outage: NODE-07 readings arrive in ONE batch, late, oldest first
  const backlog = st.posts.filter((p) => p.path === "/api/ingest/batch" && p.body.readings.length > 1 &&
    p.body.readings.every((r) => r.node_id === "NODE-07" && r.link === "lora"));
  assert.equal(backlog.length, 1);
  const ages = backlog[0].body.readings.map((r) => r.age_seconds);
  assert.equal(ages.length, 20 / 4);
  assert.ok(ages[0] >= 16 && ages.every((a, i) => a > 0 && (i === 0 || a < ages[i - 1])), `ages ${ages}`);
});

test("node SOS is checked in the database: ONE new row, source 'node', at the node's position", async () => {
  const { st, d } = await runStory();
  const check = d.checks.find((c) => c.id === "node-sos");
  assert.equal(check.pass, true, st.lines.join("\n"));
  assert.match(check.detail, /1 new node:NODE-07 SOS row\(s\) - #\d+ open, source node, at the node's registered position/);

  // without the database only the public lookup is left - and it hides node SOS: FAIL, saying why
  const blind = await runStory(42, { prepare: (st, io) => { io.sosRows = null; } });
  const lookupOnly = blind.d.checks.find((c) => c.id === "node-sos");
  assert.equal(lookupOnly.pass, false);
  assert.match(lookupOnly.detail, /hides node SOS from the public lookup.*--fresh/);
  // ... and an unreadable database falls back to it with a warning
  const broken = await runStory(42, { prepare: (st, io) => { io.sosRows = () => { throw new Error("SQLITE_BUSY"); }; } });
  assert.ok(broken.st.lines.some((l) => /\[warn\] could not read the demo database \(SQLITE_BUSY\)/.test(l)));
  assert.equal(broken.d.checks.find((c) => c.id === "node-sos").pass, false);

  // ... and it fails when the row is not where the node is registered
  const moved = await runStory(42, { prepare: (st, io) => {
    io.sosRows = (dev, node) => fakeSosRows(st)(dev, node).map((r) => ({ ...r, node_latitude: r.node_latitude + 0.01 }));
  } });
  const bad = moved.d.checks.find((c) => c.id === "node-sos");
  assert.equal(bad.pass, false);
  assert.match(bad.detail, /NOT at the node's registered position/);
});

test("a server that ignores sos_button fails the node-sos checkpoint (and only it)", async () => {
  const { st, d } = await runStory(42, { stack: { nodeSos: false } });
  assert.deepEqual(d.checks.filter((c) => !c.pass).map((c) => c.id), ["node-sos"], st.lines.join("\n"));
  assert.match(d.checks.find((c) => c.id === "node-sos").detail, /sos_button: sent .*0 new node:NODE-07 SOS row\(s\)/);
});

test("a leftover open node SOS is a FAIL that says why, and preflight warns about it", async () => {
  const leftover = (st) => st.sos.push({ id: 1, device_id: "node:NODE-07", ...NODE_POS["NODE-07"], location_source: "node",
    status: "open" });
  const { st, d } = await runStory(42, { prepare: leftover });
  const check = d.checks.find((c) => c.id === "node-sos");
  assert.equal(check.pass, false);
  assert.match(check.detail, /already had an open SOS before the press - resolve it on the officer map \(or use --fresh\)/);
  assert.equal(st.sos.filter((s) => s.device_id === "node:NODE-07").length, 1, "the press adds no second SOS");

  const { st: st2, io } = fakeStack();
  leftover(st2);
  io.sosRows = Object.assign(fakeSosRows(st2), { source: "/x/var/sanjeevni.db" }); // the public lookup hides it
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sj-preflight-"));
  try {
    await preflight(new Demo({ ...parseArgs(FAST, {}), runId: "p" }, io), { varDir: tmp });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const leftoverWarn = /\[warn\] node:NODE-07 already has an open SOS \(#1\).*--fresh \[in \/x\/var\/sanjeevni\.db - is that/;
  assert.ok(st2.lines.some((l) => leftoverWarn.test(l)), st2.lines.join("\n"));
});

test("the node SOS database is read only for a server on this machine (or --fresh), and a FAIL names it", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sj-reader-"));
  try {
    const dbFile = path.join(dir, "sanjeevni.db");
    assert.equal(demo.sosRowsReader("http://localhost:3000", dir), null, "no database file");
    fs.writeFileSync(dbFile, "");
    for (const url of ["http://localhost:3000", "http://127.0.0.1:3100", "http://[::1]:3000", "http://LOCALHOST:3000"]) {
      assert.equal(demo.sosRowsReader(url, dir).source, dbFile, url);
    }
    // another machine's server: a local var/ is not its database
    for (const url of ["http://192.168.1.20:3000", "http://pi.local:3000", "not a url"]) {
      assert.equal(demo.sosRowsReader(url, dir), null, url);
    }
    assert.equal(demo.sosRowsReader("http://192.168.1.20:3000", dir, { fresh: true }).source, dbFile);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const named = (st) => Object.assign(fakeSosRows(st), { source: "/elsewhere/var/sanjeevni.db" });
  // a server that writes another database: the FAIL says which one was read
  const wrong = await runStory(42, { stack: { nodeSos: false }, prepare: (st, io) => { io.sosRows = named(st); } });
  assert.match(wrong.d.checks.find((c) => c.id === "node-sos").detail,
    /0 new node:NODE-07 SOS row\(s\).*\[read \/elsewhere\/var\/sanjeevni\.db - is that the database of http:\/\/localhost:3000\?\]/);
  // ... and a PASS does not carry the question
  const ok = await runStory(42, { prepare: (st, io) => { io.sosRows = named(st); } });
  const check = ok.d.checks.find((c) => c.id === "node-sos");
  assert.equal(check.pass, true);
  assert.doesNotMatch(check.detail, /is that the database/);
});

test("readSosRows reads a live (WAL, open writer) database read-only, with the node's position", () => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sj-sosrows-"));
  const dbFile = path.join(dir, "sanjeevni.db");
  const writer = new DatabaseSync(dbFile);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE nodes (node_id TEXT PRIMARY KEY, location TEXT, latitude REAL, longitude REAL);
      CREATE TABLE sos_requests (id INTEGER PRIMARY KEY, device_id TEXT, latitude REAL, longitude REAL, note TEXT,
        status TEXT, timestamp TEXT, location_source TEXT);
      INSERT INTO nodes VALUES ('NODE-07', 'Hillside', 29.4002, 79.461);
      INSERT INTO sos_requests (device_id, latitude, longitude, status, location_source)
        VALUES ('node:NODE-07', 29.4002, 79.461, 'resolved', 'node'), ('dev-other', 1, 2, 'open', 'gps'),
               ('node:NODE-07', 29.4002, 79.461, 'open', 'node');
    `);
    const before = crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex");
    const rows = demo.readSosRows(dir, "node:NODE-07", "NODE-07");
    assert.deepEqual(rows.map((r) => [r.id, r.status, r.location_source]), [[1, "resolved", "node"], [3, "open", "node"]]);
    assert.deepEqual([rows[1].node_latitude, rows[1].node_longitude], [29.4002, 79.461]);
    assert.equal(crypto.createHash("sha256").update(fs.readFileSync(dbFile)).digest("hex"), before, "database changed");
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a slow back-fill does not lose the storm rain: ~10 mm in the hour before the cue-3 alarm", async () => {
  const sim = require(path.join(__dirname, "..", "..", "server", "simulation.js")); // run_demo's instance
  const { st, io } = fakeStack();
  fakeDb(st, io);
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

test("--fresh copies var/ without readings, SOS, siren state, sessions or subscribers - and never writes the source", () => {
  const { DatabaseSync } = require("node:sqlite");
  const src = fs.mkdtempSync(path.join(os.tmpdir(), "sj-src-var-"));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sj-fresh-"));
  try {
    const dbFile = path.join(src, "sanjeevni.db");
    const db = new DatabaseSync(dbFile);
    db.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, username TEXT, phone TEXT, whatsapp_number TEXT NOT NULL DEFAULT '');
      CREATE TABLE officer_whatsapp_log (id INTEGER PRIMARY KEY, user_id INTEGER, node_id TEXT, hazard_type TEXT);
      INSERT INTO officer_whatsapp_log (user_id, node_id, hazard_type) VALUES (1, 'NODE-04', 'flood');
      CREATE TABLE officer_alert_episodes (node_id TEXT, hazard_type TEXT, sent_at TEXT);
      INSERT INTO officer_alert_episodes VALUES ('NODE-04', 'flood', '2026-10-01T00:00:00Z');
      CREATE TABLE nodes (node_id TEXT PRIMARY KEY);
      CREATE TABLE readings (id INTEGER PRIMARY KEY, node_id TEXT);
      CREATE TABLE sensor_data (id INTEGER PRIMARY KEY, node_id TEXT);
      CREATE TABLE sos_requests (id INTEGER PRIMARY KEY, device_id TEXT);
      CREATE TABLE sessions (id TEXT PRIMARY KEY);
      CREATE TABLE whatsapp_subscribers (phone TEXT);
      CREATE TABLE node_sos_presses (node_id TEXT, reading_uid TEXT, sos_id INTEGER, received_at TEXT,
        PRIMARY KEY (node_id, reading_uid));
      INSERT INTO node_sos_presses VALUES ('NODE-07', 'uid-real-press', 1, '2026-10-01T00:00:00Z');
      CREATE TABLE hotspot_sos (node_id TEXT, sos_uid TEXT, sos_id INTEGER, client_id TEXT, received_at TEXT,
        PRIMARY KEY (node_id, sos_uid));
      INSERT INTO hotspot_sos VALUES ('NODE-04', 'real-uid', 1, 'phone1', '2026-10-01T00:00:00Z');
      CREATE TABLE node_sirens (node_id TEXT PRIMARY KEY, fitted INTEGER, sounding INTEGER, reported_simulated INTEGER,
        reported_at TEXT, desired TEXT);
      INSERT INTO node_sirens VALUES ('NODE-04', 1, 0, 0, '2026-10-01T00:00:00Z', NULL);
      CREATE TABLE siren_audit (id INTEGER PRIMARY KEY, node_id TEXT, action TEXT, actor TEXT, at TEXT);
      INSERT INTO siren_audit (node_id, action, actor, at) VALUES ('NODE-04', 'on', 'officer1', '2026-10-01T00:00:00Z');
      INSERT INTO users (username, phone, whatsapp_number) VALUES ('officer1', '+919800000001', '+919800000001'), ('admin1', NULL, '');
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
    for (const t of ["readings", "sensor_data", "sos_requests", "node_sos_presses", "hotspot_sos", "node_sirens", "siren_audit",
      "sessions", "whatsapp_subscribers", "officer_whatsapp_log", "officer_alert_episodes"]) {
      assert.equal(count(t), 0, t);
    }
    // the logins stay, the officers' numbers do not: a demo alert can never reach a real phone
    assert.deepEqual(copy.prepare("SELECT username, phone, whatsapp_number FROM users ORDER BY id").all().map((r) => ({ ...r })),
      [{ username: "officer1", phone: null, whatsapp_number: "" }, { username: "admin1", phone: null, whatsapp_number: "" }]);
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

test("village siren: silent on the confirmed HIGH flood, sounds after the downpour makes it CRITICAL", async () => {
  const { st, d } = await runStory();
  assert.equal(checkOf(d, "village-siren").pass, true, st.lines.join("\n"));
  assert.match(checkOf(d, "village-siren").detail, new RegExp(
    "\\d+ confirmed HIGH reading\\(s\\) sounded nothing; the command \\(siren on for \\d+s\\) came with the answer to " +
    "a reading that was CRITICAL, alert_dispatched \\(persistent\\); NODE-04 then reports siren_on \\(command\\); " +
    "server: desired on by auto"));
  const all = payloads(st);
  const river = all.filter((r) => r.node_id === "NODE-04");
  // the riverside node has a siren (and the industrial one, for cue 12); each
  // says so on every reading (history too); the hillside node has none
  assert.ok(river.every((r) => r.siren_fitted === true));
  assert.ok(all.filter((r) => r.node_id === "NODE-INDB").every((r) => r.siren_fitted === true));
  assert.ok(all.filter((r) => r.node_id === "NODE-07").every((r) => !("siren_fitted" in r)));
  // siren_on only after the command, always with reason "command", never before cue 4
  const cmd = d.sent.find((e) => e.command);
  assert.equal(cmd.node, "NODE-04");
  assert.equal(cmd.cue, "4-village-siren");
  const sounding = d.sent.filter((e) => e.sirenOn);
  assert.ok(sounding.length > 0 && sounding.every((e) => e.node === "NODE-04" && e.sirenReason === "command"));
  assert.ok(d.sent.indexOf(sounding[0]) > d.sent.indexOf(cmd));
  assert.ok(st.lines.some((l) => /siren ON at NODE-04 for \d+s \(server command\)/.test(l)));
  assert.ok(st.lines.some((l) => /NODE-04 .*\[siren ON - command\]/.test(l)), "the first sounding reading is logged");
  // the downpour: two NODE-04 readings, each under the backend's 50 mm short-gap gauge cap
  const wet = river.filter((r) => r.rainfall_mm_since_last >= demo.DOWNPOUR_MM[0]);
  assert.equal(wet.length, demo.DOWNPOUR_MM.length);
  assert.ok(wet.every((r) => r.rainfall_mm_since_last < 50 && r.soil_moisture_pct <= 100));
  assert.ok(st.lines.some((l) => /CUE 4\/13 .*CRITICAL - the village siren sounds by itself/.test(l)));
});

test("village siren FAILS on a server that sounds it on HIGH, has no siren rule, or where an officer pressed it", async () => {
  const onHigh = await runStory(42, { stack: { siren: "HIGH" } });
  assert.deepEqual(failedIds(onHigh.d), ["village-siren"], onHigh.st.lines.join("\n"));
  assert.match(checkOf(onHigh.d, "village-siren").detail,
    /0 confirmed HIGH reading\(s\).*HIGH, alert_dispatched .*NOT a confirmed CRITICAL one/);
  assert.equal(onHigh.d.sent.find((e) => e.command).cue, "3-confirm");

  // (a server with no siren support never records NODE-INDB's siren either:
  // the heat cue's silence then proves nothing, and says so)
  const none = await runStory(42, { stack: { siren: false } });
  assert.deepEqual(failedIds(none.d), ["village-siren", "heat-no-siren"]);
  assert.match(checkOf(none.d, "heat-no-siren").detail, /no siren on record for NODE-INDB .*silence proves nothing/);
  assert.match(checkOf(none.d, "village-siren").detail,
    /no siren command for NODE-04 .*CRITICAL was reached: is the server's siren rule on\?/);
  assert.ok(!payloads(none.st).some((r) => r.siren_on), "no command, no siren");

  // an officer pressed "on" after the auto rule: the latest audited "on" is
  // theirs (a second after the auto "on" - one fixed audit row, so the
  // weather cue sees no NEW "on")
  const officer = await runStory(42, { prepare: (st, io) => {
    io.sirenRow = (node) => {
      const row = fakeSirenRow(st)(node);
      const s = st.sirens[node];
      return row && { ...row, desired_reason: "officer", desired_by: "officer1", last_on_actor: "officer1",
        last_on_at: s.lastOn ? new Date(s.lastOn.at + 1000).toISOString() : null };
    };
  } });
  assert.deepEqual(failedIds(officer.d), ["village-siren"]);
  assert.match(checkOf(officer.d, "village-siren").detail,
    /desired on by officer1, last switched on by officer1 - NOT the auto rule/);

  // an older server without siren_audit: the open request's desired_reason decides
  const noAudit = await runStory(42, { prepare: (st, io) => {
    io.sirenRow = (node) => {
      const { last_on_actor: _a, last_on_at: _b, ...row } = fakeSirenRow(st)(node);
      return { ...row, desired_reason: "officer", desired_by: "officer1" };
    };
  } });
  assert.deepEqual(failedIds(noAudit.d), ["village-siren"]);
  assert.match(checkOf(noAudit.d, "village-siren").detail, /desired on by officer1 - NOT the auto rule/);

  // no database here: the protocol evidence alone, and the detail says what was not read
  const blind = await runStory(42, { prepare: (st, io) => { io.sirenRow = null; } });
  assert.equal(checkOf(blind.d, "village-siren").pass, true);
  assert.match(checkOf(blind.d, "village-siren").detail, /siren state not read \(no database access\)/);
});

test("village siren passes when its on-time ran out before the check (siren.js cleared desired_reason)", async () => {
  // A long cue 4 (--wait-enter, a big --pace) or a short SIREN_ON_SECONDS:
  // the request expired, the node reported silent, clearDesired NULLed it.
  const expired = await runStory(42, { prepare: (st, io) => {
    io.sirenRow = (node) => ({ ...fakeSirenRow(st)(node), desired: null, desired_reason: null, desired_by: null });
  } });
  assert.equal(checkOf(expired.d, "village-siren").pass, true, checkOf(expired.d, "village-siren").detail);
  assert.match(checkOf(expired.d, "village-siren").detail, /desired none by -, last switched on by auto/);
});

test("sirenOnByAuto: the latest audited 'on' of this run, else the open request's reason", () => {
  const since = Date.UTC(2026, 9, 9, 6, 0, 0);
  const iso = (ms) => new Date(ms).toISOString();
  const { sirenOnByAuto } = demo;
  assert.equal(sirenOnByAuto(undefined, since), null, "no row: not judged");
  assert.equal(sirenOnByAuto(null, since), null);
  assert.equal(sirenOnByAuto({ desired_reason: null, last_on_actor: "auto", last_on_at: iso(since + 5000) }, since), true);
  assert.equal(sirenOnByAuto({ desired_reason: "auto", last_on_actor: "officer1", last_on_at: iso(since + 5000) }, since), false,
    "an officer's later 'on' wins over a stale reason");
  assert.equal(sirenOnByAuto({ desired_reason: null, last_on_actor: "auto", last_on_at: iso(since - 3600000) }, since), false,
    "an 'on' from an earlier run");
  assert.equal(sirenOnByAuto({ desired_reason: null, last_on_actor: null, last_on_at: null }, since), false, "never switched on");
  assert.equal(sirenOnByAuto({ desired_reason: "auto" }, since), true, "no audit table: the reason");
  assert.equal(sirenOnByAuto({ desired_reason: null }, since), false);
});

test("confidence: the same NODE-07 alert goes from a pending score to a higher confirmed label", async () => {
  // pending score from the server database (sensor_data), confirmed from /api/hazards
  const { st, d } = await runStory();
  assert.match(checkOf(d, "confidence").detail,
    /NODE-07 pending: Low 0\.42 \(one reading, not confirmed yet\) \[server database\]; confirmed: High 0\.82 .*NODE-04: High/);
  assert.match(st.lines.join("\n"), /CUE 2\/13 [^]*?SHOW: .*LOW confidence[^]*?CUE 3\/13/, "cue 2 says where to look");
  // ... or from the backend's own reading row when it stores the score
  const backend = await runStory(42, { stack: { backendConfidence: true }, prepare: (st, io) => { io.sensorRows = null; } });
  assert.equal(checkOf(backend.d, "confidence").pass, true);
  assert.match(checkOf(backend.d, "confidence").detail, /\[backend reading\]/);

  // no scores at all (older server/backend): FAIL - and the weather advisory,
  // which must say in its confidence reasons that it is forecast-based
  const old = await runStory(42, { stack: { confidence: false } });
  assert.deepEqual(failedIds(old.d), ["confidence", "weather-advisory"]);
  assert.match(checkOf(old.d, "weather-advisory").detail, /NODE-INDB heavy_rain HIGH \(no confidence\)/);
  assert.match(checkOf(old.d, "confidence").detail, /no confidence score found.*no confidence on its \/api\/hazards entry/);
  // no database and a backend without the score: says to use --fresh
  const blind = await runStory(42, { prepare: (st, io) => { io.sensorRows = null; } });
  assert.match(checkOf(blind.d, "confidence").detail, /not readable here - use --fresh/);
  // a higher number in the same band is not what the cue promises
  const flat = await runStory(42, { prepare: (st, io) => {
    io.sensorRows = (node) => fakeSensorRows(st)(node).map((r) => (r.status === "pending_confirmation"
      ? { ...r, confidence: 0.7, confidence_label: "High" } : r));
  } });
  assert.equal(checkOf(flat.d, "confidence").pass, false);
  assert.match(checkOf(flat.d, "confidence").detail, /the label did not go up/);
});

test("confidenceOf: API arrays, database JSON, and anything malformed is 'no score'", () => {
  const { confidenceOf } = demo;
  assert.deepEqual(confidenceOf({ confidence: 0.8, confidence_label: "High", confidence_reasons: ["a", "b"] }),
    { value: 0.8, label: "High", reasons: ["a", "b"] });
  assert.deepEqual(confidenceOf({ confidence: "0.3", confidence_label: "Low", confidence_reasons: '["x"]' }).reasons, ["x"]);
  assert.deepEqual(confidenceOf({ confidence: 0.3, confidence_label: "Low", confidence_reasons: "not json" }).reasons,
    ["not json"]);
  for (const bad of [null, {}, { confidence: null, confidence_label: "High" }, { confidence: 1.5, confidence_label: "High" },
    { confidence: 0.5, confidence_label: "PENDING" }, { confidence: 0.5 }]) {
    assert.equal(confidenceOf(bad), null, JSON.stringify(bad));
  }
});

test("smoke: NODE-INDB's smoke is confirmed by its next reading; a backend without smoke fails only that step", async () => {
  const { st, d } = await runStory();
  assert.match(checkOf(d, "smoke").detail,
    /NODE-INDB smoke HIGH, confirmed \(persistent\) - readings: smoke\/pending_confirmation, smoke\/alert_dispatched/);
  const smoke = payloads(st).filter((r) => r.node_id === "NODE-INDB" && r.pm25_ugm3 >= 80);
  assert.ok(smoke.length >= 5, `${smoke.length} smoke readings`);
  for (let i = 1; i < smoke.length; i++) {
    assert.ok(smoke[i].pm25_ugm3 > smoke[i - 1].pm25_ugm3 && smoke[i].gas_ppm > smoke[i - 1].gas_ppm, "rising together");
  }
  // below the backend's gas-leak (800 ppm) and flame (0.3) thresholds
  assert.ok(smoke.every((r) => r.gas_ppm < 800 && r.flame_reading < 0.3), "not a gas leak, no flame");

  const old = await runStory(42, { stack: { smoke: false } });
  assert.deepEqual(failedIds(old.d), ["smoke"]);
  assert.match(checkOf(old.d, "smoke").detail, /NODE-INDB readings: -\/logged.* - no confirmed 'smoke'/);
});

test("offline Wi-Fi SOS: the contract body, sent twice (gateway retry) -> ONE SOS at the node, ~150 m", async () => {
  const { st, d } = await runStory();
  assert.match(checkOf(d, "hotspot-sos").detail, new RegExp(
    "HTTP 200 ok \\(SOS #\\d+\\), retry: duplicate; 1 new hotspot:NODE-04:demotest SOS row\\(s\\) - #\\d+ open, " +
    "source hotspot, at the node's registered position \\(~150 m\\), 3 people, needs trapped,medical"));
  const posts = st.posts.filter((p) => p.path === "/api/ingest/sos");
  assert.equal(posts.length, 2);
  const [first, retry] = posts.map((p) => p.body);
  assert.deepEqual(Object.keys(first).sort(),
    ["age_seconds", "client_id", "latitude", "longitude", "needs", "node_id", "note", "people", "simulated", "sos_uid"]);
  assert.equal(first.node_id, "NODE-04");
  assert.equal(retry.sos_uid, first.sos_uid);
  assert.equal(first.latitude, null);
  assert.equal(first.longitude, null);
  assert.ok(first.note.length <= 160 && /SIMULATED/.test(first.note));
  assert.ok(first.needs.every((n) => ["trapped", "injured", "medical", "fire"].includes(n)));
  assert.equal(first.simulated, true);
  const hs = st.sos.filter((s) => s.location_source === "hotspot");
  assert.equal(hs.length, 1);
  assert.deepEqual([hs[0].latitude, hs[0].longitude], [NODE_POS["NODE-04"].latitude, NODE_POS["NODE-04"].longitude]);
  // after the node button SOS, before the outage
  const nodeSos = st.sos.find((s) => s.location_source === "node");
  assert.ok(st.sos.indexOf(hs[0]) > st.sos.indexOf(nodeSos));

  // a server without the endpoint: FAIL that says so, nothing else fails
  const old = await runStory(42, { stack: { hotspot: false } });
  assert.deepEqual(failedIds(old.d), ["hotspot-sos"]);
  assert.match(checkOf(old.d, "hotspot-sos").detail, /HTTP 404 .*no \/api\/ingest\/sos/);
  // a server that stores the retry as a second SOS
  const twice = await runStory(42, { prepare: (st) => { st.hotspotUids.has = () => false; } });
  assert.deepEqual(failedIds(twice.d), ["hotspot-sos"]);
  assert.match(checkOf(twice.d, "hotspot-sos").detail, /retry: ok \(SOS #\d+\); 2 new/);
  // no database here: the server's answers alone
  const blind = await runStory(42, { prepare: (st, io) => { io.sosRows = null; } });
  assert.equal(checkOf(blind.d, "hotspot-sos").pass, true);
  assert.match(checkOf(blind.d, "hotspot-sos").detail, /position not checked/);
});

test("preflight warns about a REAL NODE-04 siren and about SIREN_AUTO_SEVERITY=off", async () => {
  const { st, io } = fakeStack();
  fakeDb(st, io);
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sj-preflight-"));
  const realSiren = /\[warn\] a REAL NODE-04 has reported its own siren.*--fresh/;
  const off = /\[warn\] SIREN_AUTO_SEVERITY=off.*--fresh/;
  try {
    const d = new Demo({ ...parseArgs(FAST, {}), runId: "p" }, io);
    await preflight(d, { varDir: tmp, env: {} });
    assert.ok(!st.lines.some((l) => realSiren.test(l) || off.test(l)), "quiet when there is nothing to say");
    io.sirenRow = () => ({ node_id: "NODE-04", reported_simulated: 0, reported_at: "2026-10-09T00:00:00Z" });
    await preflight(d, { varDir: tmp, env: { SIREN_AUTO_SEVERITY: " OFF " } });
    assert.ok(st.lines.some((l) => realSiren.test(l)), st.lines.join("\n"));
    assert.ok(st.lines.some((l) => off.test(l)), st.lines.join("\n"));
    // an older server (no siren table) is not an error
    io.sirenRow = () => { throw new Error("no such table: node_sirens"); };
    await preflight(d, { varDir: tmp, env: {} });

    // cue 12: an auto-hazard list with extreme heat (any spelling) would sound NODE-INDB's siren
    const heat = /\[warn\] SIREN_AUTO_HAZARDS in this environment lists extreme heat.*--fresh/;
    st.lines.length = 0;
    await preflight(d, { varDir: tmp, env: { SIREN_AUTO_HAZARDS: "flood,flash_flood,landslide,fire,gas_leak" } });
    assert.ok(!st.lines.some((l) => heat.test(l)), "the decision's default list is fine");
    await preflight(d, { varDir: tmp, env: { SIREN_AUTO_HAZARDS: "flood, Extreme Heat" } });
    assert.ok(st.lines.some((l) => heat.test(l)), st.lines.join("\n"));
    // --fresh pins the list itself, so it does not warn
    st.lines.length = 0;
    const fresh = new Demo({ ...parseArgs(FAST, {}), fresh: true, runId: "p" }, io);
    await preflight(fresh, { varDir: tmp, env: { SIREN_AUTO_HAZARDS: "extreme_heat" } });
    assert.ok(!st.lines.some((l) => heat.test(l)));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Cue 12: a CONFIRMED CRITICAL severe heat wave on a node WITH a siren -
// the siren stays silent (user decision 2026-10-09: the automatic siren is
// for evacuation hazards only, server/siren.js SIREN_AUTO_HAZARDS)
// ---------------------------------------------------------------------
test("heat: NODE-INDB reaches a confirmed CRITICAL severe heat wave and its siren stays silent", async () => {
  const { st, d } = await runStory();
  const check = checkOf(d, "heat-no-siren");
  assert.equal(check.pass, true, st.lines.join("\n"));
  assert.match(check.detail, new RegExp(
    "^NODE-INDB extreme heat CRITICAL, confirmed \\(persistent\\) - NODE-INDB readings: extreme heat HIGH/pending_confirmation, " +
    "extreme heat CRITICAL/alert_dispatched.*; siren silent: no 'on' command, NODE-INDB never reported siren_on; " +
    "server: desired none, last switched on by nobody \\(server rule; the node's offline fallback is not simulated\\)$"));
  assert.ok(st.lines.some((l) => /CUE 12\/13 .*Severe heat wave at NODE-INDB: CRITICAL - and the siren stays silent/.test(l)));
  assert.match(st.lines.join("\n"), /CUE 12\/13 [^]*?SAY : .*SIMULATED[^]*?SAY : .*evacuation hazards only[^]*?SHOW: .*'Silent'/);
  // the cue claims no more than the simulation shows: the node's offline fallback is not simulated
  assert.match(st.lines.join("\n"),
    /CUE 12\/13 [^]*?SAY : .*offline fallback[^]*?SAY : .*not part of this simulation.*water level and gas only/);
  // the readings: a heat-wave one (45-47 C), then severe ones (>= 47.4 C:
  // the ramp's +-0.1 C noise never dips under IMD's 47 C), dry air; no other node heats up
  const cue = d.sent.filter((e) => e.cue === "12-heat");
  const sent = st.posts.filter((p) => p.path !== "/api/ingest/sos").flatMap((p) => p.body.readings || [p.body]);
  const byUid = (set) => sent.filter((r) => set.has(r.reading_uid));
  const uids = new Set(cue.filter((e) => e.node === "NODE-INDB").map((e) => e.uid));
  const temps = byUid(uids).map((r) => r.temp_c);
  assert.ok(temps.length >= 4, `${temps.length} heat readings`);
  assert.ok(temps[0] >= 45 && temps[0] < 47, `first ${temps[0]}`);
  assert.ok(temps.slice(1).every((t) => t >= 47.4 && t <= 48.2), `severe ${temps}`);
  const others = new Set(cue.filter((e) => e.node !== "NODE-INDB").map((e) => e.uid));
  assert.ok(others.size > 0 && byUid(others).every((r) => r.temp_c < 40));
  // nothing commanded NODE-INDB's siren - in this cue or anywhere in the story
  assert.ok(!d.sent.some((e) => e.node === "NODE-INDB" && (e.command || e.sirenOn)));
  // the heat cue comes after the weather check and before the control room
  const order = d.checks.map((c) => c.id);
  assert.equal(order.indexOf("heat-no-siren"), order.indexOf("weather-advisory") + 1);
});

test("heat FAILS on a server that sounds the siren for any hazard, or when the heat never reaches CRITICAL", async () => {
  // an older server.js: every confirmed CRITICAL sounds the node's siren
  const old = await runStory(42, { stack: { sirenHazards: null } });
  assert.deepEqual(failedIds(old.d), ["heat-no-siren"], old.st.lines.join("\n"));
  assert.match(checkOf(old.d, "heat-no-siren").detail,
    /the siren SOUNDED for heat: an 'on' command \(1\), siren_on reported, the server switched it on \(auto\) - .*SIREN_AUTO_HAZARDS/);
  assert.ok(old.st.lines.some((l) => /siren ON at NODE-INDB for \d+s \(server command\)/.test(l)));

  // a hilly / coastal heat region (no normal): heat stops at MEDIUM, the rule is never shown
  const hilly = await runStory(42, { stack: { heatMax: "MEDIUM" } });
  assert.deepEqual(failedIds(hilly.d), ["heat-no-siren"]);
  assert.match(checkOf(hilly.d, "heat-no-siren").detail,
    /no CONFIRMED CRITICAL extreme heat, so the rule was not shown \(is the node's heat_region plains\?/);

  // no database view: silence alone proves nothing (the server only commands
  // nodes it has a siren on record for) - FAILS as inconclusive, and says why
  const blind = await runStory(42, { prepare: (st, io) => { io.sirenRow = null; } });
  assert.deepEqual(failedIds(blind.d), ["heat-no-siren"], blind.st.lines.join("\n"));
  assert.match(checkOf(blind.d, "heat-no-siren").detail,
    /siren silent: .*; INCONCLUSIVE: siren state not read \(no database access\) - .*silence alone proves nothing: use --fresh/);
});

test("--fresh pins the backend's heat region to plains (IMD's 45 / 47 C apply there)", () => {
  const src = fs.readFileSync(path.join(__dirname, "run_demo.js"), "utf8");
  assert.match(src, /\{ SANJEEVNI_WEATHER_MOCK: weatherFile, SANJEEVNI_HEAT_REGION: "plains" \}\);/);
  assert.equal(demo.DEMO_SIREN_AUTO_HAZARDS, "flood,flash_flood,landslide,fire,gas_leak");
  assert.ok(demo.HEAT_RAMP_C.slice(1).every((t) => t - 0.1 >= 47), "every severe step clears 47 C with its noise");
});

test("dbReaders: siren and sensor_data rows read-only, only for a server on this machine (or --fresh)", () => {
  const { DatabaseSync } = require("node:sqlite");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sj-readers-"));
  const dbFile = path.join(dir, "sanjeevni.db");
  const writer = new DatabaseSync(dbFile);
  try {
    writer.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE sensor_data (id INTEGER PRIMARY KEY, node_id TEXT, status TEXT, confidence REAL, confidence_label TEXT,
        confidence_reasons TEXT, timestamp TEXT);
      INSERT INTO sensor_data (node_id, status, confidence, confidence_label, confidence_reasons, timestamp) VALUES
        ('NODE-07', 'pending_confirmation', 0.4, 'Low', '["one reading"]', '2026-10-09T06:00:00+00:00'),
        ('NODE-04', 'logged', NULL, NULL, NULL, '2026-10-09T06:00:01+00:00'),
        ('NODE-07', 'alert_dispatched', 0.8, 'High', '["neighbour agrees"]', '2026-10-09T06:00:02+00:00');
    `);
    const readers = demo.dbReaders("http://127.0.0.1:3100", dir);
    assert.equal(readers.sensorRows.source, dbFile);
    const rows = readers.sensorRows("NODE-07");
    assert.deepEqual(rows.map((r) => r.status), ["alert_dispatched", "pending_confirmation"], "newest first");
    assert.deepEqual(demo.confidenceOf(rows[1]), { value: 0.4, label: "Low", reasons: ["one reading"] });
    // a server from before the village siren: the reader throws, the demo copes (Demo.readDb)
    assert.throws(() => readers.sirenRow("NODE-04"), /no such table/);
    writer.exec(`CREATE TABLE node_sirens (node_id TEXT PRIMARY KEY, desired TEXT, desired_reason TEXT);
      INSERT INTO node_sirens VALUES ('NODE-04', 'on', 'auto');`);
    assert.equal(readers.sirenRow("NODE-04").desired_reason, "auto");
    assert.ok(!("last_on_actor" in readers.sirenRow("NODE-04")), "no siren_audit table: no audit fields");
    assert.equal(readers.sirenRow("NODE-07"), undefined);
    // siren_audit outlives desired_reason (cleared once the on-time ran out)
    writer.exec(`CREATE TABLE siren_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, node_id TEXT, action TEXT, actor TEXT,
        detail TEXT, at TEXT);
      UPDATE node_sirens SET desired = NULL, desired_reason = NULL;`);
    assert.equal(readers.sirenRow("NODE-04").last_on_actor, null, "never switched on");
    writer.exec(`INSERT INTO siren_audit (node_id, action, actor, at) VALUES
        ('NODE-04', 'on', 'auto', '2026-10-09T06:00:00.000Z'),
        ('NODE-04', 'off', 'officer1', '2026-10-09T06:01:00.000Z'),
        ('NODE-07', 'on', 'officer2', '2026-10-09T06:02:00.000Z');`);
    const sirenRow = readers.sirenRow("NODE-04");
    assert.equal(sirenRow.desired_reason, null);
    assert.equal(sirenRow.last_on_actor, "auto", "the latest ON of this node, not its later OFF or another node's");
    assert.equal(sirenRow.last_on_at, "2026-10-09T06:00:00.000Z");
    assert.equal(demo.dbReaders("http://192.168.1.20:3000", dir), null, "another machine's server");
    assert.equal(demo.dbReaders("http://192.168.1.20:3000", dir, { fresh: true }).sirenRow.source, dbFile);
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------
// Cue 11 (extreme weather) and cue 12 (hotspots, trends, CAP feed)
// ---------------------------------------------------------------------
test("weather mock: Open-Meteo shape, rebased so 'now' is in it; storm = IMD very heavy rain, calm = none", () => {
  const { weatherMock, WEATHER_NOW_INDEX } = demo;
  const template = JSON.parse(fs.readFileSync(demo.WEATHER_STORM_FILE, "utf8"));
  const copy = JSON.stringify(template);
  const now = Date.UTC(2026, 9, 9, 23, 41, 7);
  const storm = weatherMock("storm", now, template);
  assert.equal(JSON.stringify(template), copy, "the template is not changed");
  const h = storm.hourly;
  assert.equal(h.time.length, 48);
  for (const f of ["precipitation", "wind_speed_10m", "wind_gusts_10m"]) assert.equal(h[f].length, 48, f);
  // the backend looks the current UTC hour up by this key (backend_server.fetch_forecast_rainfall_mm)
  assert.equal(h.time[WEATHER_NOW_INDEX], "2026-10-09T23:00");
  assert.equal(h.time[WEATHER_NOW_INDEX + 1], "2026-10-10T00:00", "across midnight");
  assert.equal(storm.current.time, "2026-10-09T23:00");
  assert.equal(storm.timezone, "UTC");
  assert.equal(storm.hourly_units.wind_gusts_10m, "km/h");
  const sum = (a, from, n) => a.slice(from, from + n).reduce((s, x) => s + x, 0);
  // IMD "very heavy rain" 115.6-204.4 mm in 24 h - also an hour later (the window moves during a run)
  for (const start of [WEATHER_NOW_INDEX, WEATHER_NOW_INDEX + 1]) {
    const day = sum(h.precipitation, start, 24);
    assert.ok(day >= 115.6 && day <= 204.4, `24 h from index ${start}: ${day} mm`);
  }
  assert.equal(sum(h.precipitation, WEATHER_NOW_INDEX, 6), 79);
  assert.equal(Math.max(...h.wind_gusts_10m), 95);
  assert.ok(h.wind_gusts_10m.every((g, i) => g >= h.wind_speed_10m[i]), "a gust is never below the mean wind");

  const calm = weatherMock("calm", now, template);
  assert.deepEqual(calm.hourly.time, h.time);
  assert.ok(calm.hourly.precipitation.every((p) => p === 0));
  assert.ok(calm.hourly.wind_gusts_10m.every((g) => g === 15));
  assert.equal(calm.current.precipitation, 0);
  assert.match(calm._note.join(" "), /SIMULATED calm/);
  assert.throws(() => weatherMock("cyclone", now, template), /unknown weather/);
});

test("writeWeatherMock replaces the file in one step and leaves no temporary file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sj-weather-"));
  try {
    const file = path.join(dir, "weather_mock.json");
    const now = Date.UTC(2026, 9, 9, 6, 5, 0);
    demo.writeWeatherMock(file, "calm", now);
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).hourly.precipitation[demo.WEATHER_NOW_INDEX], 0);
    demo.writeWeatherMock(file, "storm", now);
    const storm = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(storm.hourly.precipitation[demo.WEATHER_NOW_INDEX], 12);
    assert.equal(storm.hourly.time[demo.WEATHER_NOW_INDEX], "2026-10-09T06:00");
    assert.deepEqual(fs.readdirSync(dir), ["weather_mock.json"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("extreme weather: the storm forecast comes at cue 11 only -> a forecast-based HIGH advisory, no siren", async () => {
  const { st, d } = await runStory();
  const check = checkOf(d, "weather-advisory");
  assert.equal(check.pass, true, st.lines.join("\n"));
  assert.match(check.detail, /NODE-INDB heavy_rain HIGH \(forecast-based: High 0\.82 \(forecast-based \(Open-Meteo\)/);
  // one switch, to the storm, after the outage cue - so nothing before it could be a weather alert
  assert.deepEqual(st.weatherChanges.map((c) => c.kind), ["storm"]);
  const before = st.rows.slice(0, st.weatherChanges[0].rows);
  assert.ok(before.length > 150 && before.every((r) => r.hazard_type !== "heavy_rain"));
  assert.ok(d.sent.findIndex((e) => e.cue === "11-weather") > d.sent.findIndex((e) => e.cue === "10-outage"));
  assert.ok(d.sent.filter((e) => e.cue === "11-weather").length >= 3 * 3, "at least 3 rounds");
  assert.ok(st.lines.some((l) => /CUE 11\/13 .*advisory, never a siren/.test(l)));
  assert.match(st.lines.join("\n"), /CUE 11\/13 [^]*?SAY : .*SIMULATED[^]*?SHOW: .*forecast/);
  assert.ok(st.lines.some((l) => />>> forecast: SIMULATED very heavy rain/.test(l)));
});

test("extreme weather FAILS without --fresh, on a backend without it, over HIGH, or without a forecast reason", async () => {
  // not --fresh: the demo cannot change another backend's forecast
  const blind = await runStory(42, { prepare: (st, io) => { io.setWeather = null; } });
  assert.deepEqual(failedIds(blind.d), ["weather-advisory"], blind.st.lines.join("\n"));
  assert.match(checkOf(blind.d, "weather-advisory").detail, /run with --fresh/);
  // the file cannot be written
  const broken = await runStory(42, { prepare: (st, io) => { io.setWeather = () => { throw new Error("EPERM"); }; } });
  assert.deepEqual(failedIds(broken.d), ["weather-advisory"]);
  assert.ok(broken.st.lines.some((l) => /\[warn\] could not write the simulated forecast \(EPERM\)/.test(l)));
  // a backend that ignores the mock (or caches the calm forecast)
  const none = await runStory(42, { stack: { weather: false } });
  assert.deepEqual(failedIds(none.d), ["weather-advisory"]);
  assert.match(checkOf(none.d, "weather-advisory").detail,
    /no heavy_rain \/ high_wind in \/api\/hazards; this cue's readings: .*NODE-INDB -\/logged.*SANJEEVNI_WEATHER_MOCK/);
  // a forecast-only alert must stop at HIGH
  const critical = await runStory(42, { stack: { weatherSeverity: "CRITICAL" } });
  assert.deepEqual(failedIds(critical.d), ["weather-advisory"]);
  assert.match(checkOf(critical.d, "weather-advisory").detail, /CRITICAL weather alert\(s\): NODE-INDB.*must stop at HIGH/);
  // ... and say it is forecast-based
  const silent = await runStory(42, { stack: { weatherReason: false } });
  assert.deepEqual(failedIds(silent.d), ["weather-advisory"]);
  assert.match(checkOf(silent.d, "weather-advisory").detail, /NO forecast reason/);
});

test("extreme weather FAILS when the forecast sounds a siren through a FLOOD reading (any hazard type counts)", async () => {
  // the passing run: no siren in cue 11, and the flood across the switch is logged
  const ok = await runStory();
  assert.ok(!ok.d.sent.some((e) => e.cue === "11-weather" && e.command && e.command.siren === "on"));
  assert.match(checkOf(ok.d, "weather-advisory").detail, /; flood across the switch: NODE-04 CRITICAL -> CRITICAL, NODE-07 HIGH -> HIGH$/);
  assert.ok(ok.st.lines.some((l) => /flood across the forecast switch: NODE-04 CRITICAL -> CRITICAL/.test(l)));

  // the storm lifts NODE-04's flood into a new episode: its CRITICAL flood
  // sounds the siren during the weather cue - flood-typed, but the forecast did it
  // (NODE-04 still sounds from cue 4 then, so no 'on' command goes out in
  // this cue - only the server's siren state shows the new request)
  const run = await runStory(42, { stack: { stormFloodSiren: true } });
  const switchAt = run.st.weatherChanges[0].at;
  const lastOn = run.st.sirens["NODE-04"].lastOn;
  assert.ok(lastOn.at > switchAt, "the variant really requests the siren after the switch");
  const trigger = run.st.rows.filter((r) => r.node_id === "NODE-04" && r.takenAt >= switchAt)[0];
  assert.equal(trigger.hazard_type, "flood");
  assert.equal(trigger.severity, "CRITICAL");
  assert.deepEqual(failedIds(run.d), ["weather-advisory"], run.st.lines.join("\n"));
  assert.match(checkOf(run.d, "weather-advisory").detail,
    /a siren came on during the forecast cue \(the forecast must never sound one\): NODE-04 switched on by auto \(server siren state\)$/);

  // a still-running request from before the switch is not a new siren: an
  // 'on' command for it in cue 11 passes (siren row: desired 'on' before)
  const replay = await runStory(42, { prepare: (st, io) => {
    const request = io.request;
    io.request = async (method, url, o) => {
      const res = await request.call(io, method, url, o);
      // the node missed its on-time: the server repeats the running request
      if (st.weather === "storm" && o && o.body && /\/api\/ingest/.test(url) && st.sirens["NODE-04"]) {
        const s = st.sirens["NODE-04"];
        if (s.desired === "on" && res.data && !res.data.commands) {
          res.data.commands = [{ node_id: "NODE-04", siren: "on", for_s: 30 }];
        }
      }
      return res;
    };
  } });
  assert.ok(replay.d.sent.some((e) => e.cue === "11-weather" && e.command && e.command.siren === "on"));
  assert.equal(checkOf(replay.d, "weather-advisory").pass, true, checkOf(replay.d, "weather-advisory").detail);
});

test("--fresh web server: WhatsApp forced to a dry run, no alerts for simulated readings, siren rule pinned", () => {
  const env = demo.freshWebEnv(3100, "http://127.0.0.1:8100");
  assert.deepEqual(env, {
    SANJEEVNI_PORT: "3100", SANJEEVNI_BACKEND_URL: "http://127.0.0.1:8100",
    SIREN_AUTO_SEVERITY: "CRITICAL", SIREN_ON_SECONDS: "180",
    SIREN_AUTO_HAZARDS: "flood,flash_flood,landslide,fire,gas_leak",
    WHATSAPP_DRY_RUN: "1", WHATSAPP_ALERTS_FOR_SIMULATED: "0",
  });
  // startFreshStack really launches the web server with it
  const src = fs.readFileSync(path.join(__dirname, "run_demo.js"), "utf8");
  assert.match(src, /launch\("server", process\.execPath, \[path\.join\(ROOT, "server", "server\.js"\)\],\s*freshWebEnv\(opts\.webPort, backendUrl\)\)/);
});

test("trends: the NODE-04 flood shows in the 24 h trend and the 7-day summary, both labelled simulated", async () => {
  const { st, d } = await runStory();
  const check = checkOf(d, "trends");
  assert.equal(check.pass, true, st.lines.join("\n"));
  assert.match(check.detail, /trends NODE-04 24h: \d+ bucket\(s\) of 3600s, peak river 4\.1\d? m, peak risk 0\.95; summary 7d: \d+ flood alert\(s\), top hotspot NODE-04 \(flood\); data_note: "Simulated data/);
  assert.match(st.lines.join("\n"), /CUE 13\/13 [^]*?SHOW: .*Hotspots[^]*?SHOW: .*SIMULATED-data banner[^]*?SHOW: .*\/cap\/feed\.atom/);

  const missing = await runStory(42, { stack: { analytics: false } });
  assert.deepEqual(failedIds(missing.d), ["trends"]);
  assert.match(checkOf(missing.d, "trends").detail, /trends did not answer; backend \/api\/analytics\/summary did not answer/);
  const unlabelled = await runStory(42, { stack: { simulatedNote: false } });
  assert.deepEqual(failedIds(unlabelled.d), ["trends"]);
  assert.match(checkOf(unlabelled.d, "trends").detail, /data_note does not say SIMULATED/);
});

test("CAP feed: public Atom feed -> every entry's /cap/alerts/<id>.xml is CAP 1.2, status Exercise; pending is 404", async () => {
  const urls = [];
  const { st, d } = await runStory(42, { prepare: (st, io) => {
    const request = io.request;
    io.request = (method, url, o) => { urls.push(url); return request.call(io, method, url, o); };
  } });
  const check = checkOf(d, "cap-feed");
  assert.equal(check.pass, true, st.lines.join("\n"));
  assert.match(check.detail,
    /HTTP 200 application\/atom\+xml; charset=utf-8, Atom 1\.0, 3 entries \(3 naming a demo node\); followed 3\/3: 3 demo alert\(s\) CAP 1\.2 with status Exercise; NODE-\w+'s pending_confirmation reading \/cap\/alerts\/\d+\.xml -> HTTP 404$/);
  // every entry followed, then one known-pending id probed
  const capGets = urls.filter((u) => /\/cap\/alerts\/\d+\.xml$/.test(u));
  assert.equal(capGets.length, 4);
  const probed = Number(capGets[3].match(/(\d+)\.xml$/)[1]);
  assert.equal(st.rows.find((r) => r.id === probed).status, "pending_confirmation");

  const cases = [
    [{ capFeed: false }, /GET \/cap\/feed\.atom -> HTTP 404 \(no feed route/],
    [{ feedLink: "backend" }, /links to http:\/\/127\.0\.0\.1:8100\/api\/alerts\/\d+\/cap - not the public/],
    [{ feedType: "text/xml" }, /text\/xml - not application\/atom\+xml/],
    [{ capStatus: "Actual" }, /CAP 1\.2, status NOT Exercise/],
    // confirmed alerts only: a pending reading listed in the feed...
    [{ feedIncludesPending: true }, /\/cap\/alerts\/\d+\.xml is NODE-\w+'s pending_confirmation reading - not a confirmed alert/],
    // ... or answered by the public route
    [{ capServesPending: true },
      /\/cap\/alerts\/\d+\.xml serves NODE-\w+'s pending_confirmation reading - the public route is for confirmed alerts only/],
    // absolute links to another server are reported, never fetched
    [{ feedLink: "other-host" },
      /an entry links to another host \(http:\/\/127\.0\.0\.1:3000\/cap\/alerts\/\d+\.xml; the feed is http:\/\/localhost:3000\) - not followed/],
  ];
  for (const [stack, why] of cases) {
    const run = await runStory(42, { stack });
    assert.deepEqual(failedIds(run.d), ["cap-feed"], JSON.stringify(stack));
    assert.match(checkOf(run.d, "cap-feed").detail, why);
  }
  // the other host is never asked
  const asked = [];
  await runStory(42, { stack: { feedLink: "other-host" }, prepare: (st, io) => {
    const request = io.request;
    io.request = (method, url, o) => { asked.push(url); return request.call(io, method, url, o); };
  } });
  assert.ok(!asked.some((u) => u.startsWith("http://127.0.0.1:3000/")));
});

test("parseAtomFeed: Atom namespace, entries and their decoded link hrefs", () => {
  const { parseAtomFeed } = demo;
  const feed = parseAtomFeed(`<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><title>x</title>
    <entry><title>Flood HIGH</title><link href="https://x.example/cap/alerts/7.xml?a=1&amp;b=2"/>
      <link rel='related' href='/report/7'/></entry>
    <entry><title>none</title></entry></feed>`);
  assert.equal(feed.isAtom, true);
  assert.equal(feed.entries.length, 2);
  assert.deepEqual(feed.entries[0].hrefs, ["https://x.example/cap/alerts/7.xml?a=1&b=2", "/report/7"]);
  assert.deepEqual(feed.entries[1].hrefs, []);
  assert.equal(parseAtomFeed("<rss><channel/></rss>").isAtom, false);
  assert.equal(parseAtomFeed("<feed xmlns=\"http://purl.org/atom/ns#\"></feed>").isAtom, false, "Atom 0.3 is not 1.0");
  assert.deepEqual(parseAtomFeed(null), { isAtom: false, entries: [] });
});
