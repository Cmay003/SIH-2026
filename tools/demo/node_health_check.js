#!/usr/bin/env node
/*
 * SANJEEVNI - node-health check for 5-minute nodes (user decision 2026-10-09)
 * =====================================================================
 * Nodes WITHOUT a siren send their normal-time summary every 5 min; node
 * health must follow each node's own interval, with no false "offline"
 * between two reports. This runs that end to end, on SIMULATED nodes:
 *
 *   1. a temporary stack (the judge demo's --fresh: a copy of var/ without
 *      readings, its own AI backend + web server on spare ports)
 *   2. server/simulation.js --no-siren-summary-s 300, all quiet (no events):
 *        NODE-04, NODE-07   no siren -> one summary every 300 s
 *        NODE-INDB          WITH a siren (control) -> at least every 60 s
 *   3. the backend's /api/node-health every --poll seconds for --minutes
 *
 * PASS: no watched node is ever "offline" after its first report, and the
 * run lasted past one full 5-min gap of every no-siren node (otherwise the
 * gap between two reports was never tested - FAIL as inconclusive).
 * The backend starts with NO stored readings for these nodes - the case of
 * a new node, or a backend with no history for it.
 *
 *   node tools/demo/node_health_check.js            (~7 min + the backend's start)
 *
 * Options:
 *   --minutes 7              how long to watch (at least --summary-s + 60 s)
 *   --summary-s 300          the no-siren nodes' summary interval
 *   --poll 10                seconds between /api/node-health reads
 *   --interval 5             simulator seconds between readings (round-robin)
 *   --web-port 3300          temporary web server port
 *   --backend-port 8300      temporary AI backend port
 *   --python <path>          Python for the backend (default venv\Scripts\python.exe)
 *   --keep-var               keep the temporary copy of var/ (path is printed)
 *   --help
 * Exit code 0 = PASS, 1 = FAIL, 2 = could not run.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const demo = require("./run_demo.js");

const NO_SIREN_NODES = ["NODE-04", "NODE-07"];
const SIREN_NODE = "NODE-INDB";
const SIREN_KIT = "water,dht,gas,flame,pm,battery,siren";

function parseArgs(argv) {
  const opts = { minutes: 7, summaryS: 300, poll: 10, interval: 5, webPort: 3300, backendPort: 8300, python: null, keepVar: false };
  const num = (flag, val, min) => {
    const n = Number(val);
    if (!Number.isFinite(n) || n < min) throw new demo.UsageError(`${flag} needs a number >= ${min}, got "${val ?? ""}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const [key, val] = [argv[i], argv[i + 1]];
    switch (key) {
      case "--minutes": opts.minutes = num(key, val, 1); i++; break;
      case "--summary-s": opts.summaryS = num(key, val, 10); i++; break;
      case "--poll": opts.poll = num(key, val, 1); i++; break;
      case "--interval": opts.interval = num(key, val, 1); i++; break;
      case "--web-port": opts.webPort = num(key, val, 1); i++; break;
      case "--backend-port": opts.backendPort = num(key, val, 1); i++; break;
      case "--python": opts.python = val; i++; break;
      case "--keep-var": opts.keepVar = true; break;
      case "--help": case "-h": opts.help = true; break;
      default: throw new demo.UsageError(`Unknown option ${key} - see --help`);
    }
  }
  if (opts.minutes * 60 < opts.summaryS + 60) {
    throw new demo.UsageError(`--minutes ${opts.minutes} is shorter than one --summary-s gap (${opts.summaryS} s) plus 60 s`);
  }
  return opts;
}

/**
 * The verdict from the /api/node-health reads.
 * samples: [{ atS (seconds since the simulator started), nodes: [{ node_id, status, seconds_since_seen, issues }] }]
 * watch: { node_id: expected seconds between its routine reports }
 * Returns { pass, lines } - one line per node.
 */
function evaluate(samples, watch) {
  const lines = [];
  let pass = true;
  for (const [node, gapS] of Object.entries(watch)) {
    const seen = samples.map((s) => ({ atS: s.atS, n: (s.nodes || []).find((x) => x.node_id === node) }))
      .filter((x) => x.n && x.n.status !== "never_seen");
    if (!seen.length) {
      pass = false;
      lines.push(`${node}: never reported - nothing was tested`);
      continue;
    }
    const firstS = seen[0].atS;
    const offline = seen.filter((x) => x.n.status === "offline");
    const watchedS = seen[seen.length - 1].atS - firstS;
    const maxQuiet = Math.max(...seen.map((x) => Number(x.n.seconds_since_seen) || 0));
    const head = `${node} (every ${gapS} s): watched ${Math.round(watchedS)} s after its first report, ` +
      `longest quiet ${Math.round(maxQuiet)} s`;
    if (offline.length) {
      pass = false;
      const first = offline[0];
      const why = ((first.n.issues || []).find((i) => i.type === "missing") || {}).message || "offline";
      lines.push(`${head} - FALSE OFFLINE in ${offline.length} of ${seen.length} reads, first at +${Math.round(first.atS)} s ` +
        `(${Math.round(first.n.seconds_since_seen)} s after a report): "${why}"`);
    } else if (watchedS < gapS + 15) {
      pass = false;
      lines.push(`${head} - INCONCLUSIVE: the run ended before one full ${gapS} s gap was watched`);
    } else {
      lines.push(`${head} - online throughout`);
    }
  }
  return { pass, lines };
}

async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  if (opts.help) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/?\s?\*\s?/gm, "").replace(/^#!.*\n/, ""));
    return 0;
  }
  const io = { ...demo.realIo };
  let stack = null;
  let sim = null;
  const stop = async () => {
    if (sim && sim.exitCode === null) sim.kill();
    if (stack) await stack.stop({ keepVar: opts.keepVar });
  };
  process.on("SIGINT", () => { stop().finally(() => process.exit(130)); });
  console.log("SANJEEVNI node-health check - SIMULATED nodes, temporary stack");
  try {
    stack = await demo.startFreshStack(opts, io);
  } catch (e) {
    console.error(e.message);
    await stop();
    return 2;
  }
  try {
    const args = [path.join(ROOT, "server", "simulation.js"), "--server", stack.webUrl, "--key", stack.key,
      "--nodes", [...NO_SIREN_NODES, SIREN_NODE].join(","), "--kit", `${SIREN_NODE}=${SIREN_KIT}`,
      "--no-siren-summary-s", String(opts.summaryS), "--events", "", "--interval", String(opts.interval), "--seed", "42"];
    const simLog = path.join(stack.dir, "simulation.log");
    const fd = fs.openSync(simLog, "a");
    sim = spawn(process.execPath, args, { cwd: ROOT, stdio: ["ignore", fd, fd], windowsHide: true });
    fs.closeSync(fd);
    const startedAt = io.now();
    console.log(`   simulator: ${NO_SIREN_NODES.join(", ")} every ${opts.summaryS} s (no siren), ${SIREN_NODE} with a siren ` +
      `(at least every 60 s); watching ${stack.backendUrl}/api/node-health for ${opts.minutes} min`);
    const samples = [];
    const last = {};
    while (io.now() - startedAt < opts.minutes * 60000) {
      await io.sleep(opts.poll * 1000);
      if (sim.exitCode !== null) throw new Error(`the simulator exited (code ${sim.exitCode}) - see ${simLog}`);
      let res;
      try {
        res = await io.request("GET", `${stack.backendUrl}/api/node-health`, { timeoutMs: 15000 });
      } catch (e) {
        console.log(`   [warn] /api/node-health: ${e.message}`);
        continue;
      }
      if (res.status !== 200 || !res.data) continue;
      const atS = (io.now() - startedAt) / 1000;
      const nodes = Array.isArray(res.data.nodes) ? res.data.nodes : [];
      samples.push({ atS, nodes });
      for (const n of nodes) {
        if (![...NO_SIREN_NODES, SIREN_NODE].includes(n.node_id) || last[n.node_id] === n.status) continue;
        last[n.node_id] = n.status;
        console.log(`   +${String(Math.round(atS)).padStart(4)} s  ${n.node_id.padEnd(9)} ${n.status}` +
          (n.seconds_since_seen != null ? ` (last report ${Math.round(n.seconds_since_seen)} s ago)` : ""));
      }
    }
    const watch = Object.fromEntries([...NO_SIREN_NODES.map((n) => [n, opts.summaryS]), [SIREN_NODE, 60]]);
    const { pass, lines } = evaluate(samples, watch);
    for (const line of lines) console.log(`   ${line}`);
    console.log(`${pass ? "PASS" : "FAIL"} node-health: ${samples.length} reads over ${opts.minutes} min`);
    return pass ? 0 : 1;
  } catch (e) {
    console.error(e.message);
    return 2;
  } finally {
    await stop();
  }
}

if (require.main === module) main().then((code) => { process.exitCode = code; });

module.exports = { parseArgs, evaluate, main, NO_SIREN_NODES, SIREN_NODE };
