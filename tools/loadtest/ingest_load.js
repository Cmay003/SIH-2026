#!/usr/bin/env node
/*
 * SANJEEVNI - ingestion load test (problem statement part 7, "scalable").
 * =====================================================================
 * Simulates a fleet of sensor nodes reporting to server.js and measures
 * what the web server (and, with --backend real, the Python AI backend
 * behind it) can take. All readings are SIMULATED (sent with a simulator
 * device key, so simulated: true) and NORMAL (every value in the usual
 * range, so the AI answers LOW) - this measures the everyday ingest path,
 * not the alert path (cross-node confirmation, RAG text, WhatsApp).
 *
 *   node tools/loadtest/ingest_load.js                         200 nodes, fake AI backend
 *   node tools/loadtest/ingest_load.js --nodes 1000
 *   node tools/loadtest/ingest_load.js --backend real          real backend_server.py (venv)
 *   node tools/loadtest/ingest_load.js --server http://host:3000 --key <simulator key>
 *
 * The fleet (realistic for this design, numbers are demo choices):
 *  - every node reports once per --interval (60 s), start times spread
 *    evenly over the first interval. 60 s is the NORMAL-TIME rate of a
 *    fleet where every node has a siren (user decision 2026-10-09: siren
 *    nodes send their normal-time summary every 1 min, nodes without one
 *    every 5 min) - --interval 300 is a fleet without sirens. It is NOT
 *    the peak: during a hazard (WATCH / URGENT, a fast rise) a node sends
 *    every sample at once, every 5 s (firmware SAMPLE_INTERVAL_MS), so an
 *    area-wide event offers up to 12x the 60 s rate from every affected
 *    node (on LoRa also limited by airtime and the gateway). To model a
 *    flood burst, run e.g. --nodes 50 --interval 5 (the readings here are
 *    still NORMAL, so the alert path's extra cost is not included);
 *  - --direct-share (25 %) are Wi-Fi nodes: one POST /api/ingest each,
 *    with a timestamp (they have NTP);
 *  - the rest sit behind LoRa gateways of --gateway-size (20) nodes: one
 *    POST /api/ingest/batch per gateway per interval, one reading per node,
 *    age_seconds 0-3 s (clockless LoRa nodes);
 *  - with probability --backlog-chance (2 %) a gateway upload also carries
 *    a backlog: 1-4 older readings per node from a short outage (age
 *    = whole intervals), like the flash-queue drain after an uplink loss.
 *
 * Without --server it starts EVERYTHING itself on spare ports, with a
 * temporary SANJEEVNI_VAR_DIR (temp database: node registry of N load-test
 * nodes + a simulator key) - your var/ folder and servers on 3000/8000 are
 * never touched - and stops it all at the end:
 *  - fake backend: an in-process stand-in that answers like
 *    backend_server.py (status logged, LOW) after --fake-delay-ms (0);
 *    it measures server.js alone.
 *  - real backend: backend_server.py under uvicorn from the venv, with the
 *    models and RAG store copied into the temp folder, a calm SIMULATED
 *    weather file (SANJEEVNI_WEATHER_MOCK) and the Open-Meteo ELEVATION
 *    lookup blocked by an unreachable proxy, so the run does not send one
 *    request per node to a free public API (the backend then uses the
 *    hand-typed curve number, as it does offline). OMP_NUM_THREADS=1 as in
 *    the judge demo.
 * With --server it only sends (you need a simulator device key from
 * node server/device_keys.js add <name> --kind simulator, and the node ids
 * LT-0001.. registered on that backend). It WRITES readings into that
 * server's database - never point it at a real deployment.
 *
 * Measures: accepted readings/s vs offered, HTTP latency p50/p95/p99/max
 * (single and batch separately; timed-out requests are counted as censored
 * at the timeout, never dropped), success rate per request kind, errors (HTTP status, network, timeouts,
 * per-reading rejected/error), CPU % (of ONE core) and memory of server.js
 * (read inside the process by probe.js, plus event-loop utilisation) and,
 * for the real backend, of the Python process (sampled with ps/PowerShell
 * every 10 s). Prints a summary and writes JSON to var/loadtest/.
 * Everything runs on ONE machine (load generator included), so the numbers
 * describe this computer, not a production server.
 */
"use strict";
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn, execFile } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const LOADTEST_OUT = path.join(ROOT, "var", "loadtest");
const OK_ACTIONS = new Set(["logged", "alert_dispatched", "pending_confirmation", "suppressed", "duplicate", "untimed"]);
const BAD_ACTIONS = new Set(["rejected", "error"]);
const MAX_BATCH = 200; // backend_server.py MAX_BATCH_SIZE
const OFFICER_KEY = "loadtest-officer-key-not-secret";

// ------------------------------------------------------------------ options

const DEFAULTS = {
  nodes: 200, interval: 60, duration: 180, backend: "fake", server: null, key: null,
  gatewaySize: 20, directShare: 0.25, backlogChance: 0.02, fakeDelayMs: 0, seed: 7,
  // 15 s = the gateway firmware's HTTP timeout (sanjeevni_lora_gateway.ino:
  // http.setTimeout(15000)); an answer later than that is lost to the node.
  python: null, timeoutMs: 15000, label: null, out: LOADTEST_OUT, quiet: false, keepVar: false,
};

class UsageError extends Error {}

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  const num = (flag, v, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} must be a number ${min}-${max}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    switch (a) {
      case "--nodes": o.nodes = Math.round(num(a, v, 1, 20000)); i++; break;
      case "--interval": o.interval = num(a, v, 0.5, 3600); i++; break;
      case "--duration": o.duration = num(a, v, 1, 24 * 3600); i++; break;
      case "--backend": if (!["fake", "real"].includes(v)) throw new UsageError("--backend fake|real"); o.backend = v; i++; break;
      case "--server": o.server = String(v).replace(/\/+$/, ""); i++; break;
      case "--key": o.key = v; i++; break;
      case "--gateway-size": o.gatewaySize = Math.round(num(a, v, 1, MAX_BATCH)); i++; break;
      case "--direct-share": o.directShare = num(a, v, 0, 1); i++; break;
      case "--backlog-chance": o.backlogChance = num(a, v, 0, 1); i++; break;
      case "--fake-delay-ms": o.fakeDelayMs = num(a, v, 0, 60000); i++; break;
      case "--seed": o.seed = Math.round(num(a, v, 0, 2 ** 31)); i++; break;
      case "--python": o.python = v; i++; break;
      case "--timeout-ms": o.timeoutMs = num(a, v, 100, 600000); i++; break;
      case "--label": o.label = String(v).replace(/[^A-Za-z0-9_.-]/g, "_"); i++; break;
      case "--out": o.out = path.resolve(v); i++; break;
      case "--quiet": o.quiet = true; break;
      case "--keep-var": o.keepVar = true; break;
      case "-h": case "--help": throw new UsageError("help");
      default: throw new UsageError(`unknown option ${a}`);
    }
  }
  if (o.server && !o.key) throw new UsageError("--server needs --key <simulator device key>");
  return o;
}

// ------------------------------------------------------------------ fleet

/** Small seeded PRNG (mulberry32) so two runs send the same fleet. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const nodeId = (i) => `LT-${String(i + 1).padStart(4, "0")}`;

/**
 * The senders: Wi-Fi nodes (one reading per request) and gateways (one
 * batch per request). Every sender gets a start offset in [0, interval).
 */
function planFleet({ nodes, gatewaySize, directShare, interval }) {
  const direct = Math.round(nodes * directShare);
  const senders = [];
  for (let i = 0; i < direct; i++) senders.push({ kind: "direct", nodes: [nodeId(i)] });
  for (let i = direct; i < nodes; i += gatewaySize) {
    const ids = [];
    for (let k = i; k < Math.min(nodes, i + gatewaySize); k++) ids.push(nodeId(k));
    senders.push({ kind: "gateway", id: `GW-${senders.length}`, nodes: ids });
  }
  senders.forEach((s, i) => (s.offsetMs = (i / senders.length) * interval * 1000));
  return senders;
}

const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;

/** One NORMAL reading (values in the simulator's normal ranges, server/simulation.js). */
function makeReading(id, seq, rand, extra = {}) {
  const n = Number(id.slice(3));
  const r = {
    node_id: id,
    simulated: true,
    reading_uid: `${id}-lt-${seq}`,
    // ~2 mm of noise: a calm river over 60 s. (With +-1 cm between 60 s
    // readings the backend's flash-flood rule fired MEDIUM on pure noise in
    // a trial run - a finding for the backend, but not "normal" load.)
    river_level_m: round(1.2 + (n % 7) * 0.1 + (rand() - 0.5) * 0.004, 3),
    temp_c: round(25 + rand() * 8),
    humidity_pct: round(45 + rand() * 30),
    gas_ppm: round(380 + rand() * 40, 1),
    flame_reading: round(rand() * 0.05, 3),
    rainfall_mm_since_last: 0,
    battery_pct: round(60 + (n % 35), 1),
  };
  if (n % 4 === 0) { r.pm25_ugm3 = Math.round(25 + rand() * 30); r.pm10_ugm3 = Math.round(50 + rand() * 40); }
  if (n % 3 === 0) r.soil_moisture_pct = round(30 + rand() * 20, 1);
  return { ...r, ...extra };
}

/** p in [0,100] of a NUMERIC array (nearest-rank); null when empty. */
function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

/**
 * Latency percentiles over EVERY request that got an answer or timed out.
 * `list` = times (ms) of the requests that were answered; `timedOut` =
 * requests aborted at `timeoutMs`. A timed-out request took AT LEAST
 * timeoutMs, so it is counted as censored at timeoutMs - leaving it out
 * (as this tool did before review 2026-10-09) reports only the survivors
 * and makes an overloaded backend look fast. A percentile that lands on a
 * censored request is reported as timeoutMs with `<p>_censored: true`
 * ("at least"). The mean is over answered requests only (mean_answered_ms).
 * Network errors (no answer, no time) are not in the percentiles; they are
 * in the success rate (requestOutcomes).
 */
function latencyStats(list, { timedOut = 0, timeoutMs = null } = {}) {
  const censored = timeoutMs != null ? timedOut : 0;
  const count = list.length + censored;
  if (!count) return { count: 0 };
  const values = [...list, ...Array(censored).fill(Infinity)];
  const out = { count, answered: list.length, timed_out: censored };
  for (const p of [50, 95, 99]) {
    const v = percentile(values, p);
    out[`p${p}_ms`] = v === Infinity ? timeoutMs : round(v, 1);
    if (v === Infinity) out[`p${p}_censored`] = true;
  }
  out.max_ms = censored ? timeoutMs : round(Math.max(...list), 1);
  if (censored) out.max_censored = true;
  out.mean_answered_ms = list.length ? round(list.reduce((a, b) => a + b, 0) / list.length, 1) : null;
  return out;
}

/** Per request kind: how many got HTTP 200 within the timeout (the success rate). */
function requestOutcomes(o) {
  const total = o.ok + o.http_error + o.timeout + o.network;
  return { ...o, total, success_rate_pct: total ? round((100 * o.ok) / total, 1) : null };
}

// ------------------------------------------------------------------ helpers

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-process stand-in for backend_server.py's /api/ingest(/batch) - LOW / logged for everything. */
function startFakeBackend(delayMs) {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      if (delayMs) await sleep(delayMs);
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/node-health") return res.end(JSON.stringify({ nodes: [], summary: {} }));
      let parsed = {};
      try { parsed = body ? JSON.parse(body) : {}; } catch { res.statusCode = 400; return res.end("{}"); }
      const one = (r) => ({ status: "logged", node_id: r.node_id, reading_uid: r.reading_uid ?? null, severity: "LOW",
        hazard_type: "flood", risk_score: 0.1, delay_seconds: r.age_seconds ?? 0,
        timestamp: new Date(Date.now() - (r.age_seconds ?? 0) * 1000).toISOString() });
      if (req.url === "/api/ingest/batch") return res.end(JSON.stringify({ results: (parsed.readings || []).map(one) }));
      return res.end(JSON.stringify(one(parsed)));
    });
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

function defaultPython() {
  return path.join(ROOT, "venv", process.platform === "win32" ? path.join("Scripts", "python.exe") : path.join("bin", "python"));
}

/** A calm SIMULATED Open-Meteo-shaped forecast (0 mm rain, light wind), 48 h from the current UTC hour. */
function calmWeather() {
  const start = new Date();
  start.setUTCMinutes(0, 0, 0);
  const time = [];
  for (let h = 0; h < 48; h++) time.push(new Date(start.getTime() + h * 3600e3).toISOString().slice(0, 13) + ":00");
  return {
    _note: "SANJEEVNI load test - a SIMULATED calm forecast, NOT real weather.",
    hourly_units: { precipitation: "mm", wind_speed_10m: "km/h", wind_gusts_10m: "km/h" },
    hourly: { time, precipitation: time.map(() => 0), wind_speed_10m: time.map(() => 8), wind_gusts_10m: time.map(() => 15) },
  };
}

/**
 * Temporary var/ folder: the node registry (N load-test nodes, in the
 * backend's own column layout so it does not seed its demo nodes) and a
 * simulator device key. Real backend: models + RAG store copied in.
 */
function makeVarDir(o) {
  const { DatabaseSync } = require("node:sqlite");
  const { createDeviceKey } = require(path.join(ROOT, "server", "device_auth"));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sanjeevni-loadtest-"));
  const db = new DatabaseSync(path.join(dir, "sanjeevni.db"));
  db.exec(`CREATE TABLE nodes (node_id TEXT PRIMARY KEY, location TEXT, land_use TEXT, curve_number REAL,
    latitude REAL, longitude REAL, upstream_node TEXT)`);
  const add = db.prepare("INSERT INTO nodes VALUES (?, ?, 'urban_low', 78, ?, ?, NULL)");
  db.exec("BEGIN");
  for (let i = 0; i < o.nodes; i++) {
    // a grid around the demo district (29.39 N, 79.45 E), ~200 m apart
    add.run(nodeId(i), `Load-test site ${i + 1}`, 29.30 + Math.floor(i / 50) * 0.002, 79.40 + (i % 50) * 0.002);
  }
  db.exec("COMMIT");
  const key = createDeviceKey(db, { name: "loadtest-simulator", kind: "simulator", nodes: "*" });
  db.close();
  if (o.backend === "real") {
    for (const sub of ["models", "chroma_db"]) {
      const from = path.join(ROOT, "var", sub);
      if (fs.existsSync(from)) fs.cpSync(from, path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, "weather_mock.json"), JSON.stringify(calmWeather()));
  }
  return { dir, key };
}

function launch(cmd, args, env, logFile, ipc = false) {
  const fd = fs.openSync(logFile, "a");
  const child = spawn(cmd, args, { cwd: ROOT, env, stdio: ["ignore", fd, fd, ...(ipc ? ["ipc"] : [])], windowsHide: true });
  fs.closeSync(fd);
  child.exited = null;
  child.on("exit", (code) => (child.exited = code ?? "signal"));
  return child;
}

async function waitFor(url, child, seconds, what) {
  for (let i = 0; i < seconds * 5; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch { /* not up yet */ }
    if (child && child.exited !== null) throw new Error(`${what} exited (code ${child.exited}) while starting`);
    await sleep(200);
  }
  throw new Error(`${what} did not answer ${url} within ${seconds} s`);
}

async function stopChild(child) {
  if (!child || child.exited !== null) return;
  const gone = new Promise((r) => child.once("exit", r));
  if (process.platform === "win32") {
    // the venv python.exe is a launcher: kill the whole tree
    await new Promise((r) => execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => r()));
  } else {
    child.kill();
  }
  await Promise.race([gone, sleep(5000)]);
}

/** CPU time (ms) + RSS (bytes) of a process and its direct children, via ps / PowerShell. */
function makeOsSampler(pid) {
  let pids = [pid];
  const run = (cmd, args) => new Promise((resolve) =>
    execFile(cmd, args, { windowsHide: true, timeout: 15000 }, (err, out) => resolve(err ? "" : String(out))));
  async function discover() {
    if (process.platform === "win32") {
      const out = await run("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}" | ForEach-Object { $_.ProcessId }`]);
      pids = [pid, ...out.split(/\s+/).filter(Boolean).map(Number)];
    } else {
      const out = await run("ps", ["-o", "pid=", "--ppid", String(pid)]);
      pids = [pid, ...out.split(/\s+/).filter(Boolean).map(Number)];
    }
  }
  async function sample() {
    let cpuMs = 0;
    let rss = 0;
    if (process.platform === "win32") {
      const out = await run("powershell", ["-NoProfile", "-Command",
        `Get-Process -Id ${pids.join(",")} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.TotalProcessorTime.TotalMilliseconds) $($_.WorkingSet64)" }`]);
      for (const line of out.trim().split(/\r?\n/).filter(Boolean)) {
        const [c, m] = line.trim().split(/\s+/).map(Number);
        cpuMs += c || 0;
        rss += m || 0;
      }
    } else {
      const out = await run("ps", ["-o", "cputimes=,rss=", "-p", pids.join(",")]);
      for (const line of out.trim().split(/\n/).filter(Boolean)) {
        const [c, kb] = line.trim().split(/\s+/).map(Number);
        cpuMs += (c || 0) * 1000;
        rss += (kb || 0) * 1024;
      }
    }
    return { t: Date.now(), cpuMs, rss };
  }
  return { discover, sample, pids: () => pids };
}

function summariseSamples(samples) {
  if (samples.length < 2) return null;
  const a = samples[0];
  const z = samples[samples.length - 1];
  const cpuPct = [];
  for (let i = 1; i < samples.length; i++) {
    const dt = samples[i].t - samples[i - 1].t;
    if (dt > 0) cpuPct.push((100 * (samples[i].cpuMs - samples[i - 1].cpuMs)) / dt);
  }
  return {
    cpu_pct_of_one_core_mean: round((100 * (z.cpuMs - a.cpuMs)) / Math.max(1, z.t - a.t), 1),
    cpu_pct_of_one_core_max_interval: round(Math.max(...cpuPct), 1),
    rss_mb_start: round(a.rss / 2 ** 20, 1),
    rss_mb_end: round(z.rss / 2 ** 20, 1),
    rss_mb_max: round(Math.max(...samples.map((s) => s.rss)) / 2 ** 20, 1),
    samples: samples.length,
  };
}

// ------------------------------------------------------------------ the run

async function runLoad(o, target, log) {
  const rand = rng(o.seed);
  const senders = planFleet(o);
  const stats = {
    requests: { direct: [], gateway: [] }, // answer times (ms) of ANSWERED requests
    outcomes: {
      direct: { ok: 0, http_error: 0, timeout: 0, network: 0 },
      gateway: { ok: 0, http_error: 0, timeout: 0, network: 0 },
    },
    readingsSent: 0, readingsAccepted: 0, readingsBad: 0, actions: {},
    httpErrors: {}, networkErrors: 0, timeouts: 0, firstSend: null, lastDone: null, maxInFlight: 0,
  };
  let inFlight = 0;
  let seq = 0;
  const headers = { "Content-Type": "application/json", "X-Device-Key": target.key };
  const t0 = Date.now() + 500;
  const endAt = t0 + o.duration * 1000;
  const pending = new Set();

  function countActions(list) {
    for (const r of list) {
      const a = r && r.ai_action;
      stats.actions[a] = (stats.actions[a] || 0) + 1;
      if (OK_ACTIONS.has(a)) stats.readingsAccepted++;
      else stats.readingsBad++;
    }
  }

  async function send(sender) {
    const now = Date.now();
    let url;
    let body;
    let n;
    if (sender.kind === "direct") {
      url = `${target.base}/api/ingest`;
      body = makeReading(sender.nodes[0], ++seq, rand, { timestamp: new Date(now).toISOString(), link: "wifi",
        signal_strength_dbm: -55 - Math.round(rand() * 20) });
      n = 1;
    } else {
      const readings = [];
      const backlog = rand() < o.backlogChance ? 1 + Math.floor(rand() * 4) : 0;
      for (const id of sender.nodes) {
        for (let b = backlog; b >= 1; b--) {
          readings.push(makeReading(id, ++seq, rand, { age_seconds: Math.round(b * o.interval + rand() * 3), link: "lora",
            signal_strength_dbm: -90 - Math.round(rand() * 25) }));
        }
        readings.push(makeReading(id, ++seq, rand, { age_seconds: Math.round(rand() * 3), link: "lora",
          signal_strength_dbm: -90 - Math.round(rand() * 25) }));
      }
      body = { readings: readings.slice(0, MAX_BATCH) };
      url = `${target.base}/api/ingest/batch`;
      n = body.readings.length;
    }
    stats.readingsSent += n;
    if (stats.firstSend === null) stats.firstSend = now;
    inFlight++;
    stats.maxInFlight = Math.max(stats.maxInFlight, inFlight);
    const started = performance.now();
    try {
      const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(o.timeoutMs) });
      const text = await res.text();
      const ms = performance.now() - started;
      stats.requests[sender.kind].push(ms);
      if (res.status !== 200) {
        stats.httpErrors[res.status] = (stats.httpErrors[res.status] || 0) + 1;
        stats.outcomes[sender.kind].http_error++;
        stats.readingsBad += n;
      } else {
        stats.outcomes[sender.kind].ok++;
        const data = JSON.parse(text);
        countActions(sender.kind === "direct" ? [data] : data.results || []);
      }
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        stats.timeouts++;
        stats.outcomes[sender.kind].timeout++;
      } else {
        stats.networkErrors++;
        stats.outcomes[sender.kind].network++;
      }
      stats.readingsBad += n;
    } finally {
      inFlight--;
      stats.lastDone = Date.now();
    }
  }

  // One timer chain per sender, on a fixed schedule (no drift; a slow
  // answer never delays the next report - real nodes don't wait either).
  await new Promise((resolveAll) => {
    let active = senders.length;
    for (const s of senders) {
      let k = 0;
      const tick = () => {
        const due = t0 + s.offsetMs + k * o.interval * 1000;
        if (due >= endAt) {
          if (--active === 0) resolveAll();
          return;
        }
        setTimeout(() => {
          const p = send(s);
          pending.add(p);
          p.finally(() => pending.delete(p));
          k++;
          tick();
        }, Math.max(0, due - Date.now()));
      };
      tick();
    }
  });
  const progress = setInterval(() => log(`   ... waiting for ${pending.size} request(s) still in flight`), 5000);
  await Promise.allSettled([...pending]);
  clearInterval(progress);
  return { stats, senders, t0, endAt };
}

function countRows(varDir) {
  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(path.join(varDir, "sanjeevni.db"), { readOnly: true });
  const one = (sql) => { try { return db.prepare(sql).get().n; } catch { return null; } };
  const out = {
    dashboard_rows_sensor_data: one("SELECT COUNT(*) AS n FROM sensor_data"),
    backend_rows_readings: one("SELECT COUNT(*) AS n FROM readings"),
  };
  db.close();
  return out;
}

function buildReport(o, run, extra) {
  const { stats, senders } = run;
  const windowS = Math.max(1, ((stats.lastDone ?? run.endAt) - (stats.firstSend ?? run.t0)) / 1000);
  const offered = o.nodes / o.interval;
  const accepted = stats.readingsAccepted / windowS;
  const all = [...stats.requests.direct, ...stats.requests.gateway];
  const errors = Object.values(stats.httpErrors).reduce((a, b) => a + b, 0) + stats.networkErrors + stats.timeouts;
  // how long after the last scheduled report the last answer came back
  const drainS = Math.max(0, ((stats.lastDone ?? run.endAt) - run.endAt) / 1000);
  // Kept up = every reading accepted, no failed request, and the queue
  // drained within one report interval (otherwise the backlog would grow
  // without end in a longer run). Latency is reported separately.
  const gateways = senders.filter((s) => s.kind === "gateway");
  return {
    tool: "tools/loadtest/ingest_load.js",
    data_note: "SIMULATED load: synthetic normal readings from a simulator device key; load generator, web server and AI backend all ran on ONE machine.",
    started_at: new Date(run.t0).toISOString(),
    config: {
      nodes: o.nodes, interval_s: o.interval, duration_s: o.duration, backend: extra.backendLabel,
      direct_nodes: senders.filter((s) => s.kind === "direct").length, gateways: gateways.length,
      gateway_size: o.gatewaySize, backlog_chance: o.backlogChance, fake_delay_ms: o.backend === "fake" && !o.server ? o.fakeDelayMs : null,
      seed: o.seed, timeout_ms: o.timeoutMs,
    },
    machine: { platform: `${os.platform()} ${os.release()}`, cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model,
      total_mem_gb: round(os.totalmem() / 2 ** 30, 1), node: process.version },
    throughput: {
      offered_readings_per_s: round(offered, 2),
      accepted_readings_per_s: round(accepted, 2),
      kept_up: errors === 0 && stats.readingsBad === 0 && drainS < o.interval,
      drain_after_last_report_s: round(drainS, 1),
      readings_sent: stats.readingsSent,
      readings_accepted: stats.readingsAccepted,
      readings_not_accepted: stats.readingsBad,
      measured_window_s: round(windowS, 1),
      ai_actions: stats.actions,
      max_requests_in_flight: stats.maxInFlight,
    },
    latency_note: `Percentiles include timed-out requests, censored at the ${o.timeoutMs} ms timeout ` +
      "(*_censored: true = at least that long); mean_answered_ms is over answered requests only.",
    latency: {
      all: latencyStats(all, { timedOut: stats.timeouts, timeoutMs: o.timeoutMs }),
      direct_single: latencyStats(stats.requests.direct, { timedOut: stats.outcomes.direct.timeout, timeoutMs: o.timeoutMs }),
      gateway_batch: latencyStats(stats.requests.gateway, { timedOut: stats.outcomes.gateway.timeout, timeoutMs: o.timeoutMs }),
    },
    requests: { direct_single: requestOutcomes(stats.outcomes.direct), gateway_batch: requestOutcomes(stats.outcomes.gateway) },
    errors: { total_failed_requests: errors, http_status: stats.httpErrors, network: stats.networkErrors, timeouts: stats.timeouts },
    resources: extra.resources,
    stored: extra.stored,
  };
}

function printReport(r, log) {
  const t = r.throughput;
  const l = r.latency;
  const v = (s, k) => `${s[`${k}_censored`] ? ">=" : ""}${s[`${k}_ms`]} ms`;
  const fmt = (s) => (s.count ? `p50 ${v(s, "p50")}, p95 ${v(s, "p95")}, p99 ${v(s, "p99")}, max ${v(s, "max")} ` +
    `(${s.count} requests, ${s.timed_out ?? 0} timed out)` : "none");
  const ok = (q) => (q.total ? `${q.success_rate_pct}% answered OK (${q.ok}/${q.total})` : "none sent");
  log("");
  log("================ SANJEEVNI ingest load test (SIMULATED readings) ================");
  log(`fleet      : ${r.config.nodes} nodes every ${r.config.interval_s} s for ${r.config.duration_s} s - ` +
    `${r.config.direct_nodes} Wi-Fi nodes + ${r.config.gateways} LoRa gateways of <=${r.config.gateway_size}`);
  log(`backend    : ${r.config.backend}`);
  log(`machine    : ${r.machine.cpu_model} (${r.machine.cpus} threads), ${r.machine.total_mem_gb} GB, ${r.machine.platform}`);
  log(`throughput : offered ${t.offered_readings_per_s} readings/s, accepted ${t.accepted_readings_per_s} readings/s ` +
    `(${t.readings_accepted}/${t.readings_sent} readings over ${t.measured_window_s} s, drained ${t.drain_after_last_report_s} s after the last report) -> ${t.kept_up ? "KEPT UP" : "DID NOT KEEP UP"}`);
  log(`AI actions : ${JSON.stringify(t.ai_actions)}`);
  log(`latency    : all      ${fmt(l.all)}`);
  log(`             single   ${fmt(l.direct_single)}`);
  log(`             batch    ${fmt(l.gateway_batch)}`);
  log(`             (timed-out requests count as >= the ${r.config.timeout_ms} ms timeout)`);
  log(`success    : single   ${ok(r.requests.direct_single)}; gateway batch ${ok(r.requests.gateway_batch)}`);
  log(`errors     : ${r.errors.total_failed_requests} failed requests (HTTP ${JSON.stringify(r.errors.http_status)}, ` +
    `network ${r.errors.network}, timeouts ${r.errors.timeouts}); ${t.readings_not_accepted} readings not accepted`);
  const s = r.resources.server;
  if (s) {
    log(`server.js  : CPU ${s.cpu_pct_of_one_core_mean}% of one core (max ${s.cpu_pct_of_one_core_max_interval}% in a 1 s interval), ` +
      `RSS ${s.rss_mb_start} -> ${s.rss_mb_end} MB (max ${s.rss_mb_max}), event loop busy ${s.event_loop_utilisation_pct}%`);
  }
  const b = r.resources.backend;
  if (b) log(`AI backend : CPU ${b.cpu_pct_of_one_core_mean}% of one core (max ${b.cpu_pct_of_one_core_max_interval}% in a 10 s interval), RSS ${b.rss_mb_start} -> ${b.rss_mb_end} MB`);
  const g = r.resources.load_generator;
  log(`generator  : CPU ${g.cpu_pct_of_one_core_mean}% of one core (same machine - it competes with the servers)`);
  if (r.stored) log(`stored     : ${JSON.stringify(r.stored)}`);
  log("Numbers are for THIS machine with everything on it; not a capacity guarantee for a deployment.");
}

async function main(argv = process.argv.slice(2), log = console.log) {
  let o;
  try {
    o = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    const usage = fs.readFileSync(__filename, "utf8").split("\n").slice(2, 60).join("\n").replace(/^ ?\* ?/gm, "");
    console.error(e.message === "help" ? usage : `${e.message}\n(see --help)`);
    return 2;
  }
  const say = o.quiet ? () => {} : log;
  const children = [];
  let fake = null;
  let varDir = null;
  let target;
  let backendLabel;
  const serverSamples = [];
  let backendSampler = null;
  const backendSamples = [];
  let backendTimer = null;
  const genCpu0 = process.cpuUsage();
  const genT0 = Date.now();
  try {
    if (o.server) {
      target = { base: o.server, key: o.key };
      backendLabel = `external server ${o.server} (its own backend)`;
      say(`Target: ${o.server} - readings go into THAT server's database.`);
    } else {
      const made = makeVarDir(o);
      varDir = made.dir;
      say(`temporary var: ${varDir}`);
      let backendUrl;
      if (o.backend === "fake") {
        fake = await startFakeBackend(o.fakeDelayMs);
        backendUrl = `http://127.0.0.1:${fake.address().port}`;
        backendLabel = `fake in-process backend (answers LOW after ${o.fakeDelayMs} ms) - measures server.js alone`;
      } else {
        const python = o.python || defaultPython();
        if (!fs.existsSync(python)) throw new UsageError(`Python not found at ${python} - pass --python`);
        const port = await freePort();
        backendUrl = `http://127.0.0.1:${port}`;
        say(`starting backend_server.py on :${port} (loading models takes a while)...`);
        const env = {
          ...process.env, OMP_NUM_THREADS: "1", SANJEEVNI_VAR_DIR: varDir, OFFICER_API_KEY: OFFICER_KEY,
          SANJEEVNI_WEATHER_MOCK: path.join(varDir, "weather_mock.json"),
          // Elevation lookups would be one Open-Meteo request per node: send
          // them to a closed local port instead (fails at once -> backend's
          // 10 min back-off -> hand-typed curve number, as offline).
          HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9", NO_PROXY: "127.0.0.1,localhost",
          HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1",
          PYTHONIOENCODING: "utf-8",
        };
        const be = launch(python, ["-m", "uvicorn", "backend_server:app", "--app-dir", "backend", "--host", "127.0.0.1",
          "--port", String(port), "--log-level", "warning"], env, path.join(varDir, "backend.log"));
        be.label = "backend";
        children.push(be);
        await waitFor(`${backendUrl}/api/node-health`, be, 300, "backend_server.py").catch((e) => {
          throw new Error(`${e.message}\n--- backend.log ---\n${fs.readFileSync(path.join(varDir, "backend.log"), "utf8").slice(-3000)}`);
        });
        backendLabel = "real backend_server.py (uvicorn, OMP_NUM_THREADS=1, calm SIMULATED weather mock, elevation lookups blocked)";
        backendSampler = makeOsSampler(be.pid);
        await backendSampler.discover();
      }
      const port = await freePort();
      const env = {
        ...process.env, SANJEEVNI_VAR_DIR: varDir, SANJEEVNI_PORT: String(port), SANJEEVNI_BACKEND_URL: backendUrl,
        OFFICER_API_KEY: OFFICER_KEY, ALLOW_UNAUTHENTICATED_INGEST: "0",
        // set (empty) so the project .env cannot fill them in: no WhatsApp calls
        WHATSAPP_ACCESS_TOKEN: "", WHATSAPP_PHONE_NUMBER_ID: "", WHATSAPP_ALERTS_FOR_SIMULATED: "0",
        FRONTEND: "classic", SIREN_AUTO_SEVERITY: "", SIREN_ON_SECONDS: "",
      };
      const web = launch(process.execPath, ["-r", path.join(__dirname, "probe.js"), path.join(ROOT, "server", "server.js")],
        env, path.join(varDir, "server.log"), true);
      children.push(web);
      web.on("message", (m) => {
        if (m && m.probe) serverSamples.push(m);
      });
      await waitFor(`http://127.0.0.1:${port}/api/status`, web, 60, "server.js");
      target = { base: `http://127.0.0.1:${port}`, key: made.key };
    }

    const offered = o.nodes / o.interval;
    say(`sending: ${o.nodes} nodes, every ${o.interval} s, for ${o.duration} s (~${offered.toFixed(1)} readings/s offered)...`);
    if (backendSampler) {
      backendSamples.push(await backendSampler.sample());
      backendTimer = setInterval(async () => backendSamples.push(await backendSampler.sample()), 10000);
    }
    const serverStart = serverSamples.length;
    const run = await runLoad(o, target, say);
    if (backendTimer) clearInterval(backendTimer);
    if (backendSampler) backendSamples.push(await backendSampler.sample());
    await sleep(1100); // one more probe sample after the last answer

    const window = serverSamples.slice(Math.max(0, serverStart - 1));
    let server = null;
    if (window.length >= 2) {
      const toCpuMs = (s) => (s.cpu.user + s.cpu.system) / 1000;
      server = summariseSamples(window.map((s) => ({ t: s.t, cpuMs: toCpuMs(s), rss: s.rss })));
      const a = window[0].elu;
      const z = window[window.length - 1].elu;
      server.event_loop_utilisation_pct = round((100 * (z.active - a.active)) / Math.max(1, z.active - a.active + z.idle - a.idle), 1);
      server.heap_mb_end = round(window[window.length - 1].heapUsed / 2 ** 20, 1);
    }
    const genCpu = process.cpuUsage(genCpu0);
    const resources = {
      server,
      backend: backendSampler ? summariseSamples(backendSamples) : null,
      load_generator: { cpu_pct_of_one_core_mean: round((100 * (genCpu.user + genCpu.system) / 1000) / Math.max(1, Date.now() - genT0), 1) },
    };
    if (backendSampler && resources.backend) resources.backend.pids = backendSampler.pids();
    const stored = varDir ? countRows(varDir) : null;
    const report = buildReport(o, run, { backendLabel, resources, stored });
    printReport(report, log);
    fs.mkdirSync(o.out, { recursive: true });
    const stamp = report.started_at.replace(/[:.]/g, "-");
    const file = path.join(o.out, `ingest_${o.label || `${o.backend}_${o.nodes}n`}_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    log(`JSON report: ${file}`);
    return report.throughput.kept_up ? 0 : 1;
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(e.message);
      return 2;
    }
    console.error(`load test failed: ${e.message}`);
    if (varDir && fs.existsSync(path.join(varDir, "server.log"))) {
      console.error(`--- server.log (tail) ---\n${fs.readFileSync(path.join(varDir, "server.log"), "utf8").slice(-2000)}`);
    }
    return 3;
  } finally {
    if (backendTimer) clearInterval(backendTimer);
    for (const c of children.reverse()) await stopChild(c);
    if (fake) {
      fake.closeAllConnections?.();
      await new Promise((r) => fake.close(r));
    }
    if (varDir && !o.keepVar) fs.rmSync(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    else if (varDir) log(`kept temporary var: ${varDir}`);
  }
}

module.exports = { parseArgs, planFleet, makeReading, percentile, latencyStats, requestOutcomes, rng, calmWeather, main, UsageError };

if (require.main === module) {
  main().then((code) => process.exit(code));
}
