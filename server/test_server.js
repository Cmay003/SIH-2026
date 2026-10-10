// Test helper (not a test itself): starts a REAL server.js on a spare port
// with its own temporary var/ folder (SANJEEVNI_VAR_DIR) and a tiny fake AI
// backend, so nothing touches the real database and the user's own servers
// on 3000 / 8000 are never contacted. Used by siren.test.js, confidence.test.js and
// hotspot_sos.test.js (sos.test.js predates it and keeps its own copy).
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { DatabaseSync } = require("node:sqlite");
const { createDeviceKey } = require("./device_auth");
const { hashPassword, initAuthTables } = require("./auth");

const OFFICER_KEY = "test-officer-key-not-secret";
const TEST_PASSWORD = "correct-horse-battery";

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

// Stand-in for backend_server.py. Each reading may steer its own AI result
// with test-only fields: test_severity, test_status, test_hazard,
// test_delay (delay_seconds), and test_extra (an object merged into the result
// as-is, e.g. confidence fields or coordinates). `down` drops the connection,
// like a stopped backend.
// `routes`: extra stubbed GET paths (query string ignored) ->
// { status?, type?, body, hang? } - hang never answers (timeout tests).
// Every request URL (with its query) and X-API-Key is logged in `requests`.
function fakeBackend() {
  const state = { down: false, received: [], routes: {}, requests: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (state.down) return req.socket.destroy();
      state.requests.push({ url: req.url, apiKey: req.headers["x-api-key"] ?? null });
      const route = state.routes[req.url.split("?")[0]];
      if (route) {
        if (route.hang) return; // never answers
        res.statusCode = route.status ?? 200;
        res.setHeader("Content-Type", route.type ?? "application/json");
        return res.end(typeof route.body === "string" || Buffer.isBuffer(route.body) ? route.body : JSON.stringify(route.body));
      }
      if (req.url === "/api/node-health") {
        res.setHeader("Content-Type", "application/json");
        return res.end(JSON.stringify({ generated_at: "", summary: { online: 1, offline: 0, never_seen: 0 },
          nodes_with_issues: 0, nodes: [{ node_id: "SIREN-01", issues: [] }, { node_id: "PLAIN-01", issues: [] }] }));
      }
      const parsed = body ? JSON.parse(body) : {};
      const readings = req.url === "/api/ingest/batch" ? parsed.readings : [parsed];
      state.received.push(...readings);
      const results = readings.map((r) => ({
        status: r.test_status ?? "logged",
        node_id: r.node_id,
        reading_uid: r.reading_uid ?? null,
        severity: r.test_severity ?? "LOW",
        hazard_type: r.test_hazard ?? "flood",
        risk_score: 0.5,
        delay_seconds: r.test_delay ?? 0,
        timestamp: new Date(Date.now() - (r.age_seconds ?? 0) * 1000).toISOString(),
        ...(r.test_extra || {}),
      }));
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(req.url === "/api/ingest/batch" ? { results } : results[0]));
    });
  });
  return { state, server };
}

/**
 * nodes: [[node_id, location, lat, lon], ...] for the registry.
 * keys: { name: { kind?, nodes } } -> returned as { name: secret }.
 * users: { username: role } (password TEST_PASSWORD).
 * seed: optional (db) => void, run on the empty database before server.js
 *   opens it - e.g. to create a table as an OLDER server.js left it.
 */
async function startTestServer({ nodes = [], keys = {}, users = {}, env = {}, seed = null } = {}) {
  const varDir = fs.mkdtempSync(path.join(os.tmpdir(), "sanjeevni-test-"));
  const db = new DatabaseSync(path.join(varDir, "sanjeevni.db"));
  // The node registry belongs to backend_server.py; a minimal copy is enough here.
  db.exec("CREATE TABLE nodes (node_id TEXT PRIMARY KEY, location TEXT, latitude REAL, longitude REAL)");
  const addNode = db.prepare("INSERT INTO nodes VALUES (?, ?, ?, ?)");
  for (const n of nodes) addNode.run(...n);
  const secrets = {};
  for (const [name, k] of Object.entries(keys)) secrets[name] = createDeviceKey(db, { name, kind: k.kind || "device", nodes: k.nodes || "*" });
  initAuthTables(db);
  const addUser = db.prepare("INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?)");
  for (const [username, role] of Object.entries(users)) addUser.run(username, hashPassword(TEST_PASSWORD), role, new Date().toISOString());
  if (seed) seed(db);
  db.close();

  const backend = fakeBackend();
  await new Promise((r) => backend.server.listen(0, "127.0.0.1", r));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const web = spawn(process.execPath, [path.join(__dirname, "server.js")], {
    env: {
      ...process.env,
      SANJEEVNI_VAR_DIR: varDir,
      SANJEEVNI_PORT: String(port),
      SANJEEVNI_BACKEND_URL: `http://127.0.0.1:${backend.server.address().port}`,
      OFFICER_API_KEY: OFFICER_KEY,
      ALLOW_UNAUTHENTICATED_INGEST: "0",
      // set (empty) so the project .env can't fill them in: no real WhatsApp calls from a test
      WHATSAPP_ACCESS_TOKEN: "",
      WHATSAPP_PHONE_NUMBER_ID: "",
      FRONTEND: "classic",
      SIREN_AUTO_SEVERITY: "",
      SIREN_ON_SECONDS: "",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  web.output = "";
  web.stdout.on("data", (d) => (web.output += d));
  web.stderr.on("data", (d) => (web.output += d));

  async function call(method, url, body, headers = {}) {
    const res = await fetch(base + url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }

  /** Signs in and returns the Cookie header value. */
  async function login(username) {
    const res = await fetch(`${base}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password: TEST_PASSWORD }),
    });
    if (!res.ok) throw new Error(`login ${username} failed: HTTP ${res.status}`);
    return res.headers.get("set-cookie").split(";")[0];
  }

  async function stop() {
    if (web.exitCode === null) {
      const gone = new Promise((r) => web.once("exit", r));
      web.kill();
      await gone;
    }
    backend.server.closeAllConnections?.(); // a stubbed "hang" route keeps one open
    await new Promise((r) => backend.server.close(r));
    fs.rmSync(varDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // Up to 30 s: on a busy machine server.js has taken over 10 s to start.
  for (let i = 0; i < 300; i++) {
    try {
      if ((await fetch(`${base}/api/status`)).ok) {
        return { base, web, backend, keys: secrets, varDir, call, login, stop, OFFICER_KEY };
      }
    } catch { /* not up yet */ }
    if (web.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const output = web.output;
  await stop();
  throw new Error(`server.js did not start:\n${output}`);
}

module.exports = { startTestServer, OFFICER_KEY, TEST_PASSWORD };
