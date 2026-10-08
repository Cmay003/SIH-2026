// Every file location, and .env loading (from the project root - this
// file lives in server/). Missing .env = whatever is in the real
// environment is used, as before.
const paths = require("./paths");

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({
  limit: "10mb", // raised for base64 photo uploads (citizen hazard reports)
  // Keep the exact bytes of WhatsApp webhooks: Meta's signature is computed
  // over the raw body, not the re-serialised JSON (see verifyMetaSignature).
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/api/whatsapp/webhook")) req.rawBody = buf;
  },
}));
app.use(cors());
// nosniff, referrer policy, no framing, permissions - on every response
const { basicSecurityHeaders, setReactPageCsp } = require("./security_headers");
app.use(basicSecurityHeaders);
// Behind ngrok/a reverse proxy on the same machine: trust its
// X-Forwarded-Proto/-For so req.secure (Secure cookies) and req.ip (login
// rate limiting) reflect the real client.
app.set("trust proxy", "loopback");

// --- Authentication ----------------------------------------------------
// Dashboard (index.html) and officer page (officer.html) need a login -
// see auth.js; accounts via `node server/create_user.js add <name> <role>`.
// Citizen-facing endpoints (SOS, public hazard map, ESP32 ingestion) stay
// open by design: a person in danger can't be asked to log in.
//
// OFFICER_API_KEY (X-API-Key header) still works for scripts and admin
// tools. It is DISABLED when not set - the old fallback demo key was
// published in the repo, so anyone could have used it to skip the login.
const OFFICER_API_KEY = process.env.OFFICER_API_KEY || null;
if (!OFFICER_API_KEY) {
  console.warn("[auth] OFFICER_API_KEY not set - X-API-Key access disabled; officers log in instead.");
}

const db = new DatabaseSync(paths.DB_PATH);
// Two processes (this and backend_server.py) write the same SQLite file.
// WAL lets readers and a writer work at the same time, and busy_timeout
// makes a writer wait instead of failing with "database is locked" (B23).
db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");

const { setupAuth } = require("./auth");
const auth = setupAuth(app, db, { officerApiKey: OFFICER_API_KEY });
const requireOfficerAuth = auth.requireOfficer;
// Sensor ingestion needs a device key (review R1) - see device_auth.js
const device = require("./device_auth").setupDeviceAuth(db);

// --- Pages -------------------------------------------------------------
// The React build (frontend/dist - `npm run build` in frontend/) is served
// by DEFAULT. FRONTEND=classic switches back to the old public/ pages.
// A page missing from the build (or no build at all) falls back to the
// classic page automatically, so the site keeps working either way.
const PUBLIC_DIR = paths.PUBLIC_DIR;
const REACT_DIR = paths.REACT_DIR;
const USE_REACT = process.env.FRONTEND !== "classic";
if (USE_REACT && !fs.existsSync(path.join(REACT_DIR, "index.html"))) {
  console.warn("[frontend] frontend/dist not built - serving classic pages. Build it: cd frontend; npm install; npm run build");
}
console.log(`[frontend] ${USE_REACT ? "React pages (FRONTEND=classic for the old ones)" : "classic pages (FRONTEND=classic)"}`);

function sendPage(res, name) {
  const reactFile = path.join(REACT_DIR, name);
  if (USE_REACT && fs.existsSync(reactFile)) {
    setReactPageCsp(res); // strict CSP: React pages have no inline script/style
    return res.sendFile(reactFile);
  }
  return res.sendFile(path.join(PUBLIC_DIR, name));
}

// Protected pages are matched on the DECODED file name, before any static
// folder. Matching the raw URL let "/officer%2Ehtml" or "/%69ndex.html"
// skip the login check, because express.static decodes the path itself and
// then served the page. Lower-cased + trailing dots/spaces stripped because
// Windows file lookups ignore both.
const PROTECTED_PAGES = new Map([
  ["", { file: "index.html", roles: null }], // "/"
  ["index.html", { file: "index.html", roles: null }],
  ["officer.html", { file: "officer.html", roles: auth.OFFICER_ROLES }],
  ["admin.html", { file: "admin.html", roles: auth.ADMIN_ROLES, denied: "admin" }], // React only
]);
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  let decoded;
  try {
    decoded = decodeURIComponent(req.path);
  } catch {
    return res.status(400).send("Bad request");
  }
  const name = path.posix.basename(decoded.replace(/\\/g, "/")).replace(/[. ]+$/, "").toLowerCase();
  const page = PROTECTED_PAGES.get(decoded === "/" ? "" : name);
  if (!page) return next();
  auth.requirePage(page.roles, page.denied)(req, res, () => sendPage(res, page.file));
});
app.get("/login.html", (req, res) => sendPage(res, "login.html")); // auth.js already redirected signed-in users

// Static files: ONLY the frontend folders. Serving __dirname exposed
// sanjeevni.db, backups/*.db (citizen SOS locations), models and source.
if (USE_REACT) {
  app.use(express.static(REACT_DIR, {
    index: false,
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) setReactPageCsp(res); // e.g. sos.html
    },
  }));
}
app.use(express.static(PUBLIC_DIR, { index: false }));

// Public health check for the citizen page ("can I reach the server?") -
// reveals nothing, unlike the full sensor feed it used to call.
app.get("/api/status", (req, res) => res.json({ ok: true }));

// --- UPGRADE: redundant database (lightweight backup routine) ----------
// Full geographic/multi-host redundancy needs real infrastructure (a
// second server, cloud storage) beyond what application code alone can
// provide - that's a hosting decision, not a code problem. What THIS
// does, for real: periodically copies the live SQLite file to a
// backups/ folder with a timestamped name, and prunes old ones so disk
// usage doesn't grow unbounded. Protects against DB corruption or an
// accidental delete - not a datacenter outage.
const BACKUPS_DIR = paths.BACKUPS_DIR;
const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const BACKUP_RETENTION_COUNT = 10;
const DB_FILE_PATH = paths.DB_PATH;

if (!fs.existsSync(BACKUPS_DIR)) {
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
}

function backupDatabase() {
  if (!fs.existsSync(DB_FILE_PATH)) {
    console.log("[backup] sanjeevni.db does not exist yet - skipping backup");
    return null;
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(BACKUPS_DIR, `sanjeevni_backup_${timestamp}.db`);
  // VACUUM INTO writes a consistent snapshot through SQLite itself; copying
  // the file could catch a half-written page, and in WAL mode would miss
  // changes still in the -wal file (B23).
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);

  // Prune old backups beyond the retention count, oldest first
  const existingBackups = fs
    .readdirSync(BACKUPS_DIR)
    .filter((f) => f.startsWith("sanjeevni_backup_"))
    .sort();
  while (existingBackups.length > BACKUP_RETENTION_COUNT) {
    const oldest = existingBackups.shift();
    fs.unlinkSync(path.join(BACKUPS_DIR, oldest));
  }
  console.log(`[backup] Database backed up to ${backupPath}`);
  return backupPath;
}

setInterval(backupDatabase, BACKUP_INTERVAL_MS);

db.exec(`
  CREATE TABLE IF NOT EXISTS sensor_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    location TEXT,
    hazard_type TEXT,
    severity TEXT,
    risk_score REAL,
    river_level_m REAL,
    temp_c REAL,
    humidity_pct REAL,
    gas_ppm REAL,
    status TEXT,
    message TEXT,
    eta_minutes REAL,
    predicted_time TEXT,
    latitude REAL,
    longitude REAL,
    timestamp TEXT
  )
`);

const insertReading = db.prepare(`
  INSERT INTO sensor_data
  (node_id, location, hazard_type, severity, risk_score, river_level_m, temp_c,
   humidity_pct, gas_ppm, status, message, eta_minutes, predicted_time,
   latitude, longitude, timestamp)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const selectSensors = db.prepare(
  "SELECT * FROM sensor_data ORDER BY id DESC LIMIT ?",
);
const selectHistory = db.prepare(
  "SELECT * FROM sensor_data ORDER BY id DESC LIMIT 50",
);

// Latest reading per node that currently has an active (MEDIUM+) hazard -
// used for both the map overlay and the numbered hazard list.
// Public views only show CONFIRMED alerts (status 'alert_dispatched'):
// an alert waiting for multi-node / repeat confirmation
// ('pending_confirmation', see hazard_confirmation.py) is visible to
// officers only, so one glitching sensor can't put a hazard on the
// citizen map.
const ACTIVE_HAZARD_SQL = (statuses) => `
  SELECT sd.node_id, sd.location, sd.hazard_type, sd.severity, sd.risk_score,
         sd.eta_minutes, sd.predicted_time, sd.latitude, sd.longitude, sd.status
  FROM sensor_data sd
  INNER JOIN (
    SELECT node_id, MAX(id) as max_id FROM sensor_data GROUP BY node_id
  ) latest ON sd.node_id = latest.node_id AND sd.id = latest.max_id
  WHERE sd.severity IN ('MEDIUM','HIGH','CRITICAL')
    AND sd.status IN (${statuses})
  ORDER BY sd.risk_score DESC
`;
const selectActiveHazards = db.prepare(ACTIVE_HAZARD_SQL("'alert_dispatched'"));
const selectActiveAndPendingHazards = db.prepare(
  ACTIVE_HAZARD_SQL("'alert_dispatched','pending_confirmation'"),
);

db.exec(`
  CREATE TABLE IF NOT EXISTS sos_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT,
    latitude REAL,
    longitude REAL,
    note TEXT,
    status TEXT DEFAULT 'open',
    timestamp TEXT
  )
`);
// NOTE: "CREATE TABLE IF NOT EXISTS" does NOT add columns to a table that
// already exists from before this change. Add device_id explicitly so an
// existing sanjeevni.db picks it up without losing prior SOS history.
{
  const existingCols = db
    .prepare("PRAGMA table_info(sos_requests)")
    .all()
    .map((r) => r.name);
  if (!existingCols.includes("device_id")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN device_id TEXT");
  }
}

const insertSos = db.prepare(
  `INSERT INTO sos_requests (device_id, latitude, longitude, note, status, timestamp)
   VALUES (?, ?, ?, ?, 'open', ?)`,
);
// One-open-SOS-per-device check - a device can't file a second SOS while
// an earlier one from the same device is still unresolved.
const selectOpenSosByDevice = db.prepare(
  "SELECT * FROM sos_requests WHERE device_id=? AND status='open' ORDER BY id DESC LIMIT 1",
);
const selectOpenSos = db.prepare(
  "SELECT * FROM sos_requests WHERE status='open' ORDER BY id DESC",
);
const selectAllSos = db.prepare(
  "SELECT * FROM sos_requests ORDER BY id DESC LIMIT ?",
);
const updateSosStatus = db.prepare(
  "UPDATE sos_requests SET status=? WHERE id=?",
);

// --- UPGRADE: crowdsourced hazard reports from citizens (with photo) ---
// Fills gaps between fixed sensor nodes and doubles as labeled training
// data once officers review/confirm reports.
db.exec(`
  CREATE TABLE IF NOT EXISTS citizen_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    latitude REAL,
    longitude REAL,
    description TEXT,
    photo_path TEXT,
    reviewed INTEGER DEFAULT 0,
    confirmed_hazard TEXT,
    timestamp TEXT
  )
`);
const insertCitizenReport = db.prepare(
  `INSERT INTO citizen_reports (latitude, longitude, description, photo_path, timestamp)
   VALUES (?, ?, ?, ?, ?)`,
);
const selectCitizenReports = db.prepare(
  "SELECT * FROM citizen_reports ORDER BY id DESC LIMIT ?",
);
const updateCitizenReportReview = db.prepare(
  "UPDATE citizen_reports SET reviewed=1, confirmed_hazard=? WHERE id=?",
);

const CITIZEN_UPLOADS_DIR = paths.CITIZEN_UPLOADS_DIR;
if (!fs.existsSync(CITIZEN_UPLOADS_DIR)) {
  fs.mkdirSync(CITIZEN_UPLOADS_DIR, { recursive: true });
}
app.use("/citizen_uploads", express.static(CITIZEN_UPLOADS_DIR));

// Node locations come from the `nodes` table that backend_server.py owns
// (admin API). A hard-coded copy here meant nodes added through the admin
// API got 404 on /api/route and no map position fallback (B14).
let selectNodeInfo = null;
function nodeInfo(nodeId) {
  try {
    selectNodeInfo ??= db.prepare("SELECT location, latitude, longitude FROM nodes WHERE node_id = ?");
    return selectNodeInfo.get(nodeId) || null;
  } catch {
    return null; // backend not started yet -> table doesn't exist yet
  }
}

// Responder / control room base - where rescue teams are dispatched from.
// Replace with your actual station coordinates.
const RESPONDER_BASE = {
  name: "SANJEEVNI Response HQ",
  latitude: 29.3919,
  longitude: 79.4542,
};

const HAZARD_RADIUS_M = { MEDIUM: 500, HIGH: 1000, CRITICAL: 2000 };

const hospitals = JSON.parse(
  fs.readFileSync(paths.HOSPITALS_FILE, "utf-8"),
);

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function nearestHospital(lat, lon) {
  let best = null;
  let bestDist = Infinity;
  for (const h of hospitals) {
    const d = haversineKm(lat, lon, h.latitude, h.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  return { hospital: best, distance_km: +bestDist.toFixed(2) };
}

function mapsLink(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${oLat},${oLon}&destination=${dLat},${dLon}&travelmode=driving`;
}

// Turns the eta_minutes/predicted_time computed by the Python AI backend
// (see backend_server.py: estimate_eta_minutes) into a plain-language line.
function etaText(hazard_type, severity, eta_minutes, predicted_time) {
  if (eta_minutes === null || eta_minutes === undefined) {
    return "Stable at current readings - no imminent escalation predicted";
  }
  if (eta_minutes === 0) {
    return "Already at critical threshold - immediate response required";
  }
  const when = new Date(predicted_time).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
  const hours = Math.floor(eta_minutes / 60);
  const mins = eta_minutes % 60;
  const duration = hours > 0 ? `${hours}h ${mins}m` : `${mins} min`;
  return `Expected to reach critical level in ~${duration} (around ${when})`;
}

const PYTHON_BACKEND_URL = "http://127.0.0.1:8000";

// Stores one AI result in the dashboard table. Duplicates (a store-and-
// forward retry of a reading the backend already has) and rejected
// readings are skipped so they can't appear twice on the dashboard.
function storeDashboardRow(sensorData, aiResult) {
  // Not shown on the dashboard: duplicates, rejected/errored readings, and
  // "untimed" backlog readings (time unknown - stored, but not live data)
  if (!aiResult || ["duplicate", "rejected", "error", "untimed"].includes(aiResult.status)) {
    return;
  }
  const info = nodeInfo(sensorData.node_id) || {};

  insertReading.run(
    sensorData.node_id,
    aiResult.location || info.location || null,
    aiResult.hazard_type || null,
    aiResult.severity || null,
    aiResult.risk_score ?? null,
    // CHANGED: previously used sensorData.river_level_m - the RAW value
    // straight from the ESP32's POST body (uninverted ultrasonic
    // distance). The Python backend computes and returns the CORRECTED
    // water level in aiResult.river_level_m (see backend_server.py's
    // convert_ultrasonic_distance_to_water_level_m()) - but this
    // dashboard-facing table was still storing the raw, backwards
    // value, so the "Water Level" column kept showing distance
    // decreasing as water/your hand got closer, even though the AI's
    // actual severity scoring was already using the corrected value
    // internally. Falls back to the raw value only if the backend
    // response is somehow missing it entirely.
    aiResult.river_level_m ?? sensorData.river_level_m ?? null,
    sensorData.temp_c ?? null,
    sensorData.humidity_pct ?? null,
    sensorData.gas_ppm ?? null,
    aiResult.status,
    aiResult.message || null,
    aiResult.eta_minutes ?? null,
    aiResult.predicted_time || null,
    aiResult.latitude ?? info.latitude ?? null,
    aiResult.longitude ?? info.longitude ?? null,
    aiResult.timestamp || new Date().toISOString(),
  );

  // Confirmed alerts -> opted-in WhatsApp subscribers nearby. Not awaited:
  // a slow/failed WhatsApp call must never delay or fail ingestion.
  // Never for simulated readings (review R3: a simulator demo used to send
  // real alerts to real subscribers) unless explicitly enabled for a demo
  // to the team's own phones.
  const simulated = sensorData.simulated === true;
  if (aiResult.status === "alert_dispatched" && (!simulated || WHATSAPP_ALERTS_FOR_SIMULATED)) {
    queueSubscriberAlert({ ...aiResult, node_id: aiResult.node_id || sensorData.node_id });
  }
}

// Passes the Python backend's own status code through (e.g. 400 for an
// unknown node_id) instead of turning everything into 500. Nodes rely on
// this: 4xx = drop the reading from the local queue (resending won't
// help), 5xx / no response = keep it queued and retry later.
function sendPipelineError(res, error) {
  const status = error.response ? error.response.status : 502;
  const detail = error.response ? error.response.data : error.message;
  console.error("Pipeline error:", status, error.message);
  res.status(status).json({ status: "error", detail });
}

// 1. Ingestion endpoint - ESP32 / simulator sends raw readings here.
// Requires a device key (device_auth.js) allowed to report for this node.
app.post("/api/ingest", device.requireDeviceKey, async (req, res) => {
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "body must be one reading object" });
    }
    if (!device.nodeAllowed(req.device, req.body.node_id)) {
      return res.status(403).json({ error: `Device key '${req.device.name}' may not report for ${req.body.node_id}` });
    }
    const sensorData = device.applyKeyPolicy(req.device, req.body);
    const pythonResponse = await axios.post(
      `${PYTHON_BACKEND_URL}/api/ingest`,
      sensorData,
    );
    const aiResult = pythonResponse.data;
    storeDashboardRow(sensorData, aiResult);
    res.status(200).json({ status: "success", ai_action: aiResult.status });
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// 1b. Store-and-forward upload - a node or LoRa gateway sends readings it
// queued while offline, in one request ({ readings: [...] }). The response
// lists one status per reading, in the same order, so the sender knows
// which queue entries it can delete.
app.post("/api/ingest/batch", device.requireDeviceKey, async (req, res) => {
  try {
    const submitted = Array.isArray(req.body?.readings) ? req.body.readings : null;
    if (!submitted || submitted.some((r) => !r || typeof r !== "object" || Array.isArray(r))) {
      return res.status(400).json({ error: "body must be { readings: [ {reading}, ... ] }" });
    }
    // Readings for nodes this key may not report for are rejected one by
    // one; the rest still go through (one misconfigured node must not
    // block every other node's live data).
    const results = new Array(submitted.length);
    const allowedIdx = [];
    submitted.forEach((r, i) => {
      if (device.nodeAllowed(req.device, r.node_id)) {
        allowedIdx.push(i);
      } else {
        results[i] = { status: "rejected", node_id: r.node_id, reading_uid: r.reading_uid ?? null,
          detail: `device key '${req.device.name}' may not report for ${r.node_id}` };
        console.warn(`[ingest] rejected reading for ${r.node_id}: key '${req.device.name}' is not allowed for it`);
      }
    });
    const readings = allowedIdx.map((i) => device.applyKeyPolicy(req.device, submitted[i]));
    if (readings.length) {
      const pythonResponse = await axios.post(
        `${PYTHON_BACKEND_URL}/api/ingest/batch`,
        { readings },
      );
      pythonResponse.data.results.forEach((r, k) => {
        results[allowedIdx[k]] = r;
      });
    }
    // Insert oldest-first so the dashboard's "latest per node" (MAX(id))
    // ends up as the newest reading, matching the backend's order.
    readings
      .map((sensorData, k) => ({ sensorData, aiResult: results[allowedIdx[k]] }))
      .sort((a, b) => String(a.aiResult?.timestamp ?? "").localeCompare(String(b.aiResult?.timestamp ?? "")))
      .forEach(({ sensorData, aiResult }) => storeDashboardRow(sensorData, aiResult));
    res.status(200).json({
      status: "success",
      results: results.map((r) => ({
        node_id: r.node_id,
        reading_uid: r.reading_uid ?? null,
        ai_action: r.status,
      })),
    });
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// 2. Dashboard feed - shaped for index.html
app.get("/api/sensors", auth.requireLogin, (req, res) => {
  const limit = parseInt(req.query.limit || "50", 10);
  const rows = selectSensors.all(limit);

  const data = rows.map((r) => ({
    id: r.id,
    device_id: r.node_id,
    hazard: r.hazard_type || "normal",
    water_level: r.river_level_m,
    temperature: r.temp_c,
    humidity: r.humidity_pct,
    risk: r.severity || "LOW",
    risk_score: r.risk_score,
    timestamp: r.timestamp,
  }));

  res.json({ success: true, count: rows.length, data });
});

// 3. Raw history (unshaped)
app.get("/api/history", auth.requireLogin, (req, res) => {
  res.json(selectHistory.all());
});

// 4. Nearest hospital + directions link for a given sensor node
app.get("/api/route/:node_id", auth.requireLogin, (req, res) => {
  const coords = nodeInfo(req.params.node_id);
  if (!coords) {
    return res.status(404).json({ error: "unknown node_id" });
  }
  const { hospital, distance_km } = nearestHospital(
    coords.latitude,
    coords.longitude,
  );
  res.json({
    node_id: req.params.node_id,
    hospital: hospital.name,
    distance_km,
    maps_url: mapsLink(
      coords.latitude,
      coords.longitude,
      hospital.latitude,
      hospital.longitude,
    ),
  });
});

// 4b. Nearest hospital + route for ANY coordinates (not just a sensor
// node) - used by the citizen portal to show every visitor their nearest
// hospital and route proactively, without requiring them to press SOS
// first. This does NOT write anything to the database - it's a pure
// lookup, safe to call as often as the portal needs.
app.get("/api/nearest-hospital", (req, res) => {
  const latitude = parseFloat(req.query.latitude);
  const longitude = parseFloat(req.query.longitude);
  if (Number.isNaN(latitude) || Number.isNaN(longitude)) {
    return res
      .status(400)
      .json({ error: "latitude and longitude query params are required" });
  }
  const { hospital, distance_km } = nearestHospital(latitude, longitude);
  res.json({
    hospital: hospital.name,
    distance_km,
    maps_url: mapsLink(
      latitude,
      longitude,
      hospital.latitude,
      hospital.longitude,
    ),
  });
});

// 5. Citizen presses SOS -> stored, and they immediately get the route to
// the nearest hospital back in the response.
// Shared SOS-creation logic, used by BOTH the citizen portal's POST
// /api/sos AND the new WhatsApp webhook below - one source of truth
// for "what happens when someone reports an SOS", regardless of which
// channel it came in through.
function createSosRequest(deviceId, latitude, longitude, note) {
  const existing = selectOpenSosByDevice.get(deviceId);
  if (existing) {
    const { hospital, distance_km } = nearestHospital(
      existing.latitude,
      existing.longitude,
    );
    return {
      httpStatus: 409,
      body: {
        status: "already_active",
        error:
          "This device already has an active SOS request awaiting response.",
        sos_id: existing.id,
        hospital: hospital.name,
        distance_km,
        maps_url: mapsLink(
          existing.latitude,
          existing.longitude,
          hospital.latitude,
          hospital.longitude,
        ),
      },
    };
  }

  const timestamp = new Date().toISOString();
  const result = insertSos.run(
    deviceId,
    latitude,
    longitude,
    note || null,
    timestamp,
  );
  const { hospital, distance_km } = nearestHospital(latitude, longitude);
  return {
    httpStatus: 201,
    body: {
      status: "received",
      sos_id: result.lastInsertRowid,
      hospital: hospital.name,
      distance_km,
      maps_url: mapsLink(
        latitude,
        longitude,
        hospital.latitude,
        hospital.longitude,
      ),
    },
  };
}

// Returns {latitude, longitude} as real numbers, or null if either is
// missing, non-numeric or out of range. SQLite's REAL column would
// otherwise happily store a string, which then lands inside HTML/URLs on
// the officer dashboard.
function parseCoordinates(latitude, longitude) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (
    latitude == null ||
    longitude == null ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  ) {
    return null;
  }
  return { latitude: lat, longitude: lon };
}

const MAX_NOTE_LENGTH = 500;

// Spam protection for the public endpoints (B20). Deliberately GENEROUS:
// on mobile networks many people share one IP (carrier-grade NAT), and a
// real SOS must never be blocked - these limits only stop floods.
function makeRateLimiter(windowMs, max) {
  const hits = new Map();
  return function limited(key) {
    const now = Date.now();
    if (hits.size > 10000) {
      for (const [k, e] of hits) if (now - e.start > windowMs) hits.delete(k);
    }
    const entry = hits.get(key);
    if (!entry || now - entry.start > windowMs) {
      hits.set(key, { start: now, count: 1 });
      return false;
    }
    entry.count++;
    return entry.count > max;
  };
}
const sosPerNetwork = makeRateLimiter(10 * 60 * 1000, 30);
const sosPerDevice = makeRateLimiter(60 * 60 * 1000, 5);
const reportsPerNetwork = makeRateLimiter(10 * 60 * 1000, 20);
const DEVICE_ID_PATTERN = /^[A-Za-z0-9:._-]{3,100}$/;

app.post("/api/sos", (req, res) => {
  const { note, device_id } = req.body;
  if (typeof device_id === "string" && DEVICE_ID_PATTERN.test(device_id) &&
      (sosPerDevice(device_id) || sosPerNetwork(req.ip))) {
    return res.status(429).json({
      error: "Too many SOS requests from this device or network. If you are in danger, call 112 now.",
    });
  }
  const coords = parseCoordinates(req.body.latitude, req.body.longitude);
  if (!coords) {
    return res
      .status(400)
      .json({ error: "valid numeric latitude and longitude are required" });
  }
  if (!device_id || typeof device_id !== "string" || !DEVICE_ID_PATTERN.test(device_id)) {
    return res.status(400).json({ error: "device_id is required (3-100 letters, digits or : . _ -)" });
  }
  if (note != null && typeof note !== "string") {
    return res.status(400).json({ error: "note must be a string" });
  }
  const { httpStatus, body } = createSosRequest(
    device_id,
    coords.latitude,
    coords.longitude,
    note ? note.slice(0, MAX_NOTE_LENGTH) : note,
  );
  res.status(httpStatus).json(body);
});

// 5b. Lookup whether a given device currently has an open (unresolved)
// SOS - used by the citizen portal on page load/refresh so it can restore
// the "your SOS is active" state and keep the button locked until an
// officer marks it resolved, instead of allowing a second SOS to be sent.
app.get("/api/sos/device/:device_id", (req, res) => {
  const existing = selectOpenSosByDevice.get(req.params.device_id);
  if (!existing) {
    return res.json({ active: false });
  }
  const { hospital, distance_km } = nearestHospital(
    existing.latitude,
    existing.longitude,
  );
  res.json({
    active: true,
    sos_id: existing.id,
    hospital: hospital.name,
    distance_km,
    maps_url: mapsLink(
      existing.latitude,
      existing.longitude,
      hospital.latitude,
      hospital.longitude,
    ),
  });
});

// 6. Officer dashboard feed - open SOS requests, each enriched with the
// route from the responder base to the person, and the person's nearest hospital.
// UPGRADE: SLA / escalation timers - flags an open SOS that's been
// waiting too long without resolution, so it doesn't silently sit there.
const SLA_MINUTES = 15;

function computeEscalation(status, timestamp) {
  if (status !== "open") {
    return { escalated: false, minutes_open: 0 };
  }
  const minutesOpen = (Date.now() - new Date(timestamp).getTime()) / 60000;
  return {
    escalated: minutesOpen > SLA_MINUTES,
    minutes_open: Math.round(minutesOpen),
  };
}

app.get("/api/sos", requireOfficerAuth, (req, res) => {
  const rows =
    req.query.status === "all"
      ? selectAllSos.all(parseInt(req.query.limit || "200", 10))
      : selectOpenSos.all();

  const data = rows.map((r) => {
    const { hospital, distance_km } = nearestHospital(r.latitude, r.longitude);
    const { escalated, minutes_open } = computeEscalation(
      r.status,
      r.timestamp,
    );
    return {
      id: r.id,
      latitude: r.latitude,
      longitude: r.longitude,
      note: r.note,
      status: r.status,
      timestamp: r.timestamp,
      escalated,
      minutes_open,
      nearest_hospital: hospital.name,
      hospital_distance_km: distance_km,
      hospital_route_url: mapsLink(
        r.latitude,
        r.longitude,
        hospital.latitude,
        hospital.longitude,
      ),
      responder_route_url: mapsLink(
        RESPONDER_BASE.latitude,
        RESPONDER_BASE.longitude,
        r.latitude,
        r.longitude,
      ),
    };
  });

  res.json({
    success: true,
    count: data.length,
    escalated_count: data.filter((d) => d.escalated).length,
    data,
  });
});

// 7. Officer marks an SOS as handled
app.post("/api/sos/:id/resolve", requireOfficerAuth, (req, res) => {
  updateSosStatus.run("resolved", req.params.id);
  res.json({ status: "ok" });
});

// 7b. Bulk-resolve every currently open SOS at once - for when an officer
// has finished handling everything and wants to clear the board in one
// action, rather than clicking "Resolve" on each one individually.
app.post("/api/sos/resolve-all", requireOfficerAuth, (req, res) => {
  const openOnes = selectOpenSos.all();
  for (const sos of openOnes) {
    updateSosStatus.run("resolved", sos.id);
  }
  res.json({ status: "ok", resolved_count: openOnes.length });
});

// 8. Hazard zones for the map - latest reading per node with MEDIUM+ severity
// ?include_pending=1 (officer map) also returns alerts still waiting for
// confirmation, marked confirmed: false - officers only, since an
// unconfirmed alert isn't reliable enough for the public yet.
const requireOfficerForPending = (req, res, next) =>
  req.query.include_pending === "1" ? requireOfficerAuth(req, res, next) : next();

app.get("/api/hazard-zones", requireOfficerForPending, (req, res) => {
  const includePending = req.query.include_pending === "1";
  const rows = (includePending ? selectActiveAndPendingHazards : selectActiveHazards).all();
  const zones = rows
    .filter((r) => r.latitude != null && r.longitude != null)
    .map((r) => ({
      node_id: r.node_id,
      hazard_type: r.hazard_type,
      severity: r.severity,
      risk_score: r.risk_score,
      latitude: r.latitude,
      longitude: r.longitude,
      radius_m: HAZARD_RADIUS_M[r.severity] || 500,
      confirmed: r.status === "alert_dispatched",
    }));
  res.json({ success: true, zones });
});

// River-level forecast for one node (+30/+60 min, LSTM vs linear) - see
// river_forecast.py. Indicative only: trained on synthetic hydrology.
app.get("/api/forecast/:node_id", auth.requireLogin, async (req, res) => {
  try {
    const pythonResponse = await axios.get(
      `${PYTHON_BACKEND_URL}/api/forecast/${encodeURIComponent(req.params.node_id)}`,
    );
    res.json(pythonResponse.data);
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// Sentinel-1 radar flood cross-check (officer-only; uses the team's
// Copernicus quota) - see satellite_check.py.
app.get("/api/satellite-check/:node_id", requireOfficerAuth, async (req, res) => {
  try {
    const pythonResponse = await axios.get(
      `${PYTHON_BACKEND_URL}/api/satellite-check/${encodeURIComponent(req.params.node_id)}`,
      { timeout: 90000 },
    );
    res.json(pythonResponse.data);
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// Node health / missing-node alerts (officer-only), computed by the
// Python backend from each node's last report, battery, signal and drift.
app.get("/api/node-health", requireOfficerAuth, async (req, res) => {
  try {
    const pythonResponse = await axios.get(`${PYTHON_BACKEND_URL}/api/node-health`);
    res.json(pythonResponse.data);
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// Node registry (admin page). Admin role only: a node's coordinates, land
// use and upstream link change what the flood model and the public map
// trust. The Python admin API only accepts OFFICER_API_KEY, which is added
// HERE on the server - it never reaches the browser.
const ADMIN_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/; // same rule as backend_server.check_node_id

function adminBackendHeaders(res) {
  if (OFFICER_API_KEY) return { "X-API-Key": OFFICER_API_KEY };
  res.status(503).json({
    error: "Node management is switched off: set OFFICER_API_KEY in .env and restart both servers.",
  });
  return null;
}

// FastAPI errors are {detail: "text"} or, for invalid fields, {detail: [{loc, msg}, ...]}.
function sendAdminError(res, error) {
  if (!error.response) {
    console.error("[admin] AI backend unreachable:", error.message);
    return res.status(502).json({
      error: "Can't reach the AI backend (backend_server.py on port 8000) - start it, then try again.",
    });
  }
  const detail = error.response.data && error.response.data.detail;
  let message = typeof detail === "string" ? detail : `Request failed (HTTP ${error.response.status})`;
  if (Array.isArray(detail)) {
    message = detail
      .map((d) => `${(d.loc || []).filter((p) => p !== "body").join(".") || "request"}: ${d.msg}`)
      .join("; ");
  }
  res.status(error.response.status).json({ error: message });
}

app.get("/api/admin/nodes", auth.requireAdmin, async (req, res) => {
  const headers = adminBackendHeaders(res);
  if (!headers) return;
  try {
    const pythonResponse = await axios.get(`${PYTHON_BACKEND_URL}/api/admin/nodes`, { headers });
    res.set("Cache-Control", "no-store");
    res.json({ nodes: pythonResponse.data });
  } catch (error) {
    sendAdminError(res, error);
  }
});

for (const [method, verb] of [["post", "created"], ["put", "updated"], ["delete", "deleted"]]) {
  app[method]("/api/admin/nodes/:node_id", auth.requireAdmin, async (req, res) => {
    const nodeId = req.params.node_id;
    if (!ADMIN_NODE_ID.test(nodeId)) {
      return res.status(400).json({ error: "Node ID must be 1-12 characters: letters, digits, - or _ (LoRa packets hold 12)" });
    }
    const headers = adminBackendHeaders(res);
    if (!headers) return;
    try {
      const pythonResponse = await axios({
        method,
        url: `${PYTHON_BACKEND_URL}/api/admin/nodes/${encodeURIComponent(nodeId)}`,
        data: method === "delete" ? undefined : req.body,
        headers,
      });
      console.log(`[admin] ${req.user.username} ${verb} node ${nodeId}`); // who changed the registry
      res.json(pythonResponse.data);
    } catch (error) {
      sendAdminError(res, error);
    }
  });
}

// 9. Active hazards, numbered, for the dashboard list - location, AI risk
// score, and a plain-language prediction of when it may reach critical level,
// based on the eta_minutes/predicted_time the AI backend already computed.
app.get("/api/hazards", (req, res) => {
  const rows = selectActiveHazards.all();

  const hazards = rows.map((r, i) => ({
    label: `Hazard ${i + 1}`,
    node_id: r.node_id,
    location: r.location || r.node_id,
    hazard_type: r.hazard_type,
    severity: r.severity,
    risk_score: r.risk_score,
    latitude: r.latitude,
    longitude: r.longitude,
    eta_minutes: r.eta_minutes,
    predicted_time: r.predicted_time,
    prediction_text: etaText(
      r.hazard_type,
      r.severity,
      r.eta_minutes,
      r.predicted_time,
    ),
  }));

  res.json({ success: true, count: hazards.length, hazards });
});

// --- UPGRADE: crowdsourced hazard reports (citizen-submitted, with photo) ---
// Public endpoint - any citizen can submit, no auth (same philosophy as
// SOS submission: reporting a hazard should never be gated behind a login).
app.post("/api/citizen-reports", (req, res) => {
  if (reportsPerNetwork(req.ip)) {
    return res.status(429).json({ error: "Too many reports from this network - please wait a few minutes. In danger? Call 112." });
  }
  const { description, photo_base64 } = req.body;
  const coords = parseCoordinates(req.body.latitude, req.body.longitude);
  if (!coords) {
    return res
      .status(400)
      .json({ error: "valid numeric latitude and longitude are required" });
  }
  const { latitude, longitude } = coords;

  let photoPath = null;
  if (photo_base64) {
    try {
      // Accepts a data URL ("data:image/jpeg;base64,...") or raw base64
      const matches = photo_base64.match(/^data:image\/(\w+);base64,(.+)$/);
      const ext = matches ? matches[1] : "jpg";
      const data = matches ? matches[2] : photo_base64;
      const filename = `report_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
      fs.writeFileSync(
        path.join(CITIZEN_UPLOADS_DIR, filename),
        Buffer.from(data, "base64"),
      );
      photoPath = `/citizen_uploads/${filename}`;
    } catch (e) {
      console.error("Failed to save citizen report photo:", e.message);
      // Continue without the photo rather than failing the whole report -
      // the location + description are still valuable without it.
    }
  }

  const timestamp = new Date().toISOString();
  const result = insertCitizenReport.run(
    latitude,
    longitude,
    description || null,
    photoPath,
    timestamp,
  );
  res
    .status(201)
    .json({
      status: "received",
      report_id: result.lastInsertRowid,
      photo_saved: !!photoPath,
    });
});

// Officer-only: view all citizen reports
app.get("/api/citizen-reports", requireOfficerAuth, (req, res) => {
  const rows = selectCitizenReports.all(parseInt(req.query.limit || "100", 10));
  res.json({ success: true, count: rows.length, data: rows });
});

// Officer-only: mark a report reviewed, optionally confirming it as a
// real hazard (this is what turns it into labeled training data later)
app.post("/api/citizen-reports/:id/review", requireOfficerAuth, (req, res) => {
  const { confirmed_hazard } = req.body; // e.g. "flood", "gas leak", or null if false alarm
  updateCitizenReportReview.run(confirmed_hazard || null, req.params.id);
  res.json({ status: "ok" });
});

// Officer-only: trigger an immediate backup rather than waiting for the
// next scheduled interval - useful right before a demo or a risky change.
app.post("/api/admin/backup-now", requireOfficerAuth, (req, res) => {
  const backupPath = backupDatabase();
  if (!backupPath) {
    return res
      .status(404)
      .json({ error: "No database file exists yet to back up" });
  }
  res.json({ status: "ok", backup_path: backupPath });
});

// =====================================================================
// UPGRADE: WhatsApp Business API SOS integration
// =====================================================================
// BLOCKED dependency, be upfront: this needs a real Meta Business
// account + WhatsApp Business API access (App Review approval for the
// "whatsapp_business_messaging" permission) - credentials I cannot
// create on your behalf. This code is REAL and correctly implements
// Meta's actual Cloud API webhook contract, but I have no live WhatsApp
// Business account to send/receive real messages against, so this is
// logic-verified against realistic mock payloads (see the test suite),
// NOT live-API-verified. Test against a real number before trusting it
// for a demo.
//
// SETUP YOU NEED TO DO (none of this is code - it's Meta's own process):
// 1. Create a Meta Business account + a WhatsApp Business App at
//    developers.facebook.com
// 2. Get a test phone number (free) or register your real business number
// 3. Get your WHATSAPP_ACCESS_TOKEN and WHATSAPP_PHONE_NUMBER_ID from
//    the App Dashboard
// 4. Pick your own WHATSAPP_VERIFY_TOKEN (any random string YOU choose)
// 5. In the App Dashboard's Webhooks config, set the callback URL to
//    https://your-domain/api/whatsapp/webhook and enter the SAME verify
//    token from step 4
// 6. Subscribe the webhook to the "messages" field
// 7. IMPORTANT LIMITATION: Meta only allows freeform text replies within
//    a 24-hour window after the citizen messages you first. A truly
//    PROACTIVE outbound alert (nobody messaged you first) requires a
//    pre-approved MESSAGE TEMPLATE, submitted for Meta review in advance -
//    you cannot send arbitrary free text as a cold outbound alert.
// All 3 env vars go in your .env file, loaded by the same dotenv setup
// already used for OFFICER_API_KEY.
const WHATSAPP_ACCESS_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN;
const WHATSAPP_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID;
const WHATSAPP_VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN;
const WHATSAPP_API_VERSION = "v21.0";

if (
  !WHATSAPP_ACCESS_TOKEN ||
  !WHATSAPP_PHONE_NUMBER_ID ||
  !WHATSAPP_VERIFY_TOKEN
) {
  console.warn(
    "\n[WhatsApp] Not configured - WHATSAPP_ACCESS_TOKEN / WHATSAPP_PHONE_NUMBER_ID / " +
      "WHATSAPP_VERIFY_TOKEN missing from .env. The webhook endpoints below will run " +
      "but any real message send will fail until these are set.\n",
  );
}

// Dry run: log WhatsApp messages instead of sending them. On automatically
// when the API isn't configured, so alerts can be demoed/tested without a
// Meta account; force it with WHATSAPP_DRY_RUN=1.
// Simulated readings never alert real people (review R3) unless this is
// set on purpose, e.g. to demo alerts to the team's own phones.
const WHATSAPP_ALERTS_FOR_SIMULATED = process.env.WHATSAPP_ALERTS_FOR_SIMULATED === "1";
const WHATSAPP_DRY_RUN =
  process.env.WHATSAPP_DRY_RUN === "1" || !WHATSAPP_ACCESS_TOKEN || !WHATSAPP_PHONE_NUMBER_ID;

// Sends a freeform WhatsApp text message. Only works within Meta's 24h
// customer-service window after the recipient messaged first (see the
// setup note above) - use sendWhatsAppTemplate() for anything proactive.
async function sendWhatsAppText(toPhone, body) {
  if (WHATSAPP_DRY_RUN) {
    console.log(`[WhatsApp dry-run] text to ${toPhone}: ${body}`);
    return { dryRun: true };
  }
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  return axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "text",
      text: { body },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}

// Sends a pre-approved TEMPLATE message - the only way to message
// someone who hasn't messaged you in the last 24h (i.e. a genuinely
// proactive hazard alert, not a reply). templateName must already be
// approved in your Meta App Dashboard before this will work.
async function sendWhatsAppTemplate(
  toPhone,
  templateName,
  languageCode,
  bodyParams,
) {
  if (WHATSAPP_DRY_RUN) {
    console.log(`[WhatsApp dry-run] template '${templateName}' to ${toPhone}: ${JSON.stringify(bodyParams)}`);
    return { dryRun: true };
  }
  const url = `https://graph.facebook.com/${WHATSAPP_API_VERSION}/${WHATSAPP_PHONE_NUMBER_ID}/messages`;
  return axios.post(
    url,
    {
      messaging_product: "whatsapp",
      to: toPhone,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        components: [
          {
            type: "body",
            parameters: bodyParams.map((p) => ({ type: "text", text: p })),
          },
        ],
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    },
  );
}

// Extracts the sender phone + parsed message content from Meta's actual
// webhook payload shape. Returns null if the payload isn't a real
// inbound message (Meta also sends status/delivery-receipt webhooks on
// the same endpoint, which this correctly ignores rather than crashing on).
function parseWhatsAppMessage(payload) {
  try {
    const value = payload.entry[0].changes[0].value;
    if (!value.messages || value.messages.length === 0) return null;
    const message = value.messages[0];
    const fromPhone = message.from;

    if (message.type === "location") {
      return {
        fromPhone,
        type: "location",
        latitude: message.location.latitude,
        longitude: message.location.longitude,
      };
    }
    if (message.type === "text") {
      return { fromPhone, type: "text", text: message.text.body };
    }
    return { fromPhone, type: message.type }; // e.g. image, audio - acknowledged but not actionable for SOS
  } catch (e) {
    return null; // malformed/unexpected payload shape - fail closed, not crash
  }
}

// =====================================================================
// Proactive hazard alerts to opted-in WhatsApp users (PPT slide 5)
// =====================================================================
// Opt-in only: a citizen sends ALERTS ON, then shares a location; STOP
// unsubscribes. Only CONFIRMED alerts (status 'alert_dispatched', never
// 'pending_confirmation') are sent, to subscribers inside the hazard
// radius + WHATSAPP_ALERT_BUFFER_M.
//
// Uses a pre-approved message TEMPLATE (Meta requires one for messages
// the user didn't just ask for). Create it in WhatsApp Manager with 4
// body variables, e.g. (category: Utility):
//   "SANJEEVNI alert: {{1}} risk is {{2}} near {{3}}. {{4}} Reply STOP to unsubscribe."
// and set WHATSAPP_ALERT_TEMPLATE / WHATSAPP_ALERT_TEMPLATE_LANG in .env.
//
// Stored: phone number + chosen location only, deleted on STOP. Mention
// this in your privacy notice (India's DPDP Act 2023 requires a clear
// purpose and consent - opt-in covers consent).
const WHATSAPP_ALERT_TEMPLATE = process.env.WHATSAPP_ALERT_TEMPLATE || "sanjeevni_hazard_alert";
const WHATSAPP_ALERT_TEMPLATE_LANG = process.env.WHATSAPP_ALERT_TEMPLATE_LANG || "en";
const WHATSAPP_ALERT_MIN_SEVERITY = process.env.WHATSAPP_ALERT_MIN_SEVERITY || "MEDIUM";
const WHATSAPP_ALERT_BUFFER_M = 1000;
const WHATSAPP_ALERT_REPEAT_MINUTES = 60; // same hazard, same person: at most once an hour unless it escalates
const ALERT_LOCATION_WAIT_MINUTES = 15; // after ALERTS ON, the next location within this time is for alerts
const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

const ALERT_OPT_IN_WORDS = new Set(["ALERTS ON", "ALERT ON", "JOIN", "SUBSCRIBE"]);
const ALERT_OPT_OUT_WORDS = new Set(["STOP", "ALERTS OFF", "ALERT OFF", "UNSUBSCRIBE"]);
const SOS_WORDS = new Set(["SOS", "HELP", "EMERGENCY"]);
const normalizeCommand = (text) => String(text || "").trim().toUpperCase().replace(/\s+/g, " ");

// One-line advice per hazard for the template's {{4}} - consistent with
// sample_sops/. Meta rejects template parameters with newlines/tabs.
const HAZARD_ADVICE = {
  flood: "Move to higher ground and avoid flooded roads and bridges.",
  "gas leak": "Leave the area, avoid flames and electrical switches.",
  fire: "Move away from the fire and follow official evacuation advice.",
  "extreme heat": "Drink water often, stay out of the sun 12-3 pm, call 112 for heatstroke.",
  landslide: "Move away from the slope and avoid hill roads nearby.",
  "air pollution": "Limit outdoor activity; wear an N95 mask outdoors.",
  "water quality degradation": "Do not drink untreated water from this source; boil water.",
};

db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_subscribers (
    phone TEXT PRIMARY KEY,
    latitude REAL,
    longitude REAL,
    status TEXT,          -- 'awaiting_location' | 'active'
    updated_at TEXT
  )
`);
// When the subscriber last sent ALERTS ON (their next location within
// ALERT_LOCATION_WAIT_MINUTES is for alerts). Kept separate from status so
// an ACTIVE subscriber who sends ALERTS ON again stays active (review R10:
// they used to drop to 'awaiting_location' forever and get no alerts).
if (!db.prepare("PRAGMA table_info(whatsapp_subscribers)").all().some((c) => c.name === "awaiting_since")) {
  db.exec("ALTER TABLE whatsapp_subscribers ADD COLUMN awaiting_since TEXT");
}
db.exec(`
  CREATE TABLE IF NOT EXISTS whatsapp_alert_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    phone TEXT,
    node_id TEXT,
    hazard_type TEXT,
    severity TEXT,
    sent_at TEXT,
    dry_run INTEGER
  )
`);
const selectSubscriber = db.prepare("SELECT * FROM whatsapp_subscribers WHERE phone=?");
const insertAwaitingSubscriber = db.prepare(`
  INSERT INTO whatsapp_subscribers (phone, status, updated_at, awaiting_since)
  VALUES (?, 'awaiting_location', ?, ?)
  ON CONFLICT(phone) DO UPDATE SET awaiting_since=excluded.awaiting_since, updated_at=excluded.updated_at
`); // existing subscribers keep their status and location
const activateSubscriber = db.prepare(`
  INSERT INTO whatsapp_subscribers (phone, latitude, longitude, status, updated_at, awaiting_since)
  VALUES (?, ?, ?, 'active', ?, NULL)
  ON CONFLICT(phone) DO UPDATE SET latitude=excluded.latitude, longitude=excluded.longitude,
    status='active', updated_at=excluded.updated_at, awaiting_since=NULL
`);
const deleteSubscriber = db.prepare("DELETE FROM whatsapp_subscribers WHERE phone=?");
const selectActiveSubscribers = db.prepare(
  "SELECT * FROM whatsapp_subscribers WHERE status='active' AND latitude IS NOT NULL",
);
const selectLastAlertSent = db.prepare(`
  SELECT severity, sent_at FROM whatsapp_alert_log
  WHERE phone=? AND node_id=? AND hazard_type=? ORDER BY id DESC LIMIT 1
`);
const insertAlertLog = db.prepare(`
  INSERT INTO whatsapp_alert_log (phone, node_id, hazard_type, severity, sent_at, dry_run)
  VALUES (?, ?, ?, ?, ?, ?)
`);

function startAlertSubscription(phone) {
  const now = new Date().toISOString();
  insertAwaitingSubscriber.run(phone, now, now);
}

function isAwaitingAlertLocation(phone) {
  const sub = selectSubscriber.get(phone);
  if (!sub || !sub.awaiting_since) return false;
  return Date.now() - new Date(sub.awaiting_since).getTime() < ALERT_LOCATION_WAIT_MINUTES * 60000;
}

function activateAlertSubscription(phone, latitude, longitude) {
  activateSubscriber.run(phone, latitude, longitude, new Date().toISOString());
}

function stopAlertSubscription(phone) {
  deleteSubscriber.run(phone); // data minimisation: nothing kept after STOP
}

// Alerts are sent ONE AT A TIME through this chain. A batch upload used to
// start all its notifications at once; each checked the "sent recently"
// log before any of them had written to it, so every subscriber got one
// message per reading in the batch (review R4).
let notifyChain = Promise.resolve();
function queueSubscriberAlert(alert) {
  notifyChain = notifyChain
    .then(() => notifySubscribersOfAlert(alert))
    .catch((e) => console.error("[WhatsApp] notify error:", e.message));
  return notifyChain;
}

// A store-and-forward backlog can deliver readings hours late. Alerting
// people now about a reading that old could send them away from a danger
// that has passed (review R5) - officers still see it on the map.
const MAX_ALERT_DELAY_SECONDS = 15 * 60;

// Sends one alert to every active subscriber inside the hazard area.
// Returns how many were notified (dry-run sends count too).
async function notifySubscribersOfAlert(alert) {
  if (alert.status !== "alert_dispatched") return 0;
  if ((alert.delay_seconds ?? 0) > MAX_ALERT_DELAY_SECONDS) {
    console.log(`[WhatsApp] not alerting about ${alert.hazard_type} at ${alert.node_id}: reading is ${Math.round(alert.delay_seconds / 60)} min old`);
    return 0;
  }
  if ((SEVERITY_RANK[alert.severity] ?? -1) < SEVERITY_RANK[WHATSAPP_ALERT_MIN_SEVERITY]) return 0;
  if (alert.latitude == null || alert.longitude == null) return 0;

  const reachKm = ((HAZARD_RADIUS_M[alert.severity] || 500) + WHATSAPP_ALERT_BUFFER_M) / 1000;
  const params = [
    alert.hazard_type,
    alert.severity,
    alert.location || alert.node_id,
    HAZARD_ADVICE[alert.hazard_type] || "Follow instructions from local authorities.",
  ].map((p) => String(p).replace(/[\n\t]+/g, " ").replace(/ {4,}/g, " "));

  let notified = 0;
  for (const sub of selectActiveSubscribers.all()) {
    if (haversineKm(sub.latitude, sub.longitude, alert.latitude, alert.longitude) > reachKm) continue;
    const last = selectLastAlertSent.get(sub.phone, alert.node_id, alert.hazard_type);
    const recent = last && Date.now() - new Date(last.sent_at).getTime() < WHATSAPP_ALERT_REPEAT_MINUTES * 60000;
    const escalated = last && SEVERITY_RANK[alert.severity] > (SEVERITY_RANK[last.severity] ?? -1);
    if (recent && !escalated) continue;
    try {
      await sendWhatsAppTemplate(sub.phone, WHATSAPP_ALERT_TEMPLATE, WHATSAPP_ALERT_TEMPLATE_LANG, params);
      insertAlertLog.run(sub.phone, alert.node_id, alert.hazard_type, alert.severity,
        new Date().toISOString(), WHATSAPP_DRY_RUN ? 1 : 0);
      notified++;
    } catch (e) {
      console.error("[WhatsApp] alert send failed:", e.response ? e.response.data : e.message);
    }
  }
  if (notified) console.log(`[WhatsApp] ${alert.hazard_type} ${alert.severity} alert for ${alert.node_id} -> ${notified} subscriber(s)`);
  return notified;
}

// Webhook verification - Meta calls this ONCE when you configure the
// webhook URL in the App Dashboard, to confirm you actually own this
// endpoint. Must echo back hub.challenge if the verify token matches.
app.get("/api/whatsapp/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === WHATSAPP_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Verification failed");
});

// Actual incoming-message webhook. A citizen messaging your WhatsApp
// number lands here. Flow: if they share their LOCATION, file an SOS
// immediately (reusing the exact same createSosRequest() as the web
// portal) and reply with the nearest hospital. If they send plain TEXT
// first, ask them to share location, since SOS fundamentally needs
// coordinates for hospital routing.
// Every real webhook from Meta carries X-Hub-Signature-256 = HMAC-SHA256
// of the raw body with your app secret. Without checking it, anyone could
// forge "ALERTS ON" (subscribe someone without consent) or "STOP"
// (silently unsubscribe people) for any phone number (review R9).
// WHATSAPP_APP_SECRET = Meta App Dashboard -> App settings -> Basic -> App secret.
const WHATSAPP_APP_SECRET = process.env.WHATSAPP_APP_SECRET || "";
if (!WHATSAPP_APP_SECRET && !WHATSAPP_DRY_RUN) {
  console.warn("[WhatsApp] WHATSAPP_APP_SECRET not set - incoming webhooks are REFUSED until it is.");
}

function verifyMetaSignature(req, res, next) {
  if (!WHATSAPP_APP_SECRET) {
    // Dry run (no real WhatsApp account): accept unsigned test messages.
    // Live WhatsApp without the secret: refuse - fail closed.
    return WHATSAPP_DRY_RUN ? next() : res.sendStatus(403);
  }
  const header = req.headers["x-hub-signature-256"];
  const expected = "sha256=" + crypto.createHmac("sha256", WHATSAPP_APP_SECRET).update(req.rawBody || "").digest("hex");
  const a = Buffer.from(String(header || ""));
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn("[WhatsApp] webhook with missing/invalid signature rejected");
    return res.sendStatus(403);
  }
  next();
}

app.post("/api/whatsapp/webhook", verifyMetaSignature, async (req, res) => {
  // Always 200 immediately - Meta retries aggressively on non-200/timeout,
  // and we don't want a slow downstream call to cause duplicate webhook
  // deliveries for the same message.
  res.sendStatus(200);

  const parsed = parseWhatsAppMessage(req.body);
  if (!parsed) return;

  const deviceId = `whatsapp:${parsed.fromPhone}`;

  try {
    if (parsed.type === "location" && isAwaitingAlertLocation(parsed.fromPhone)) {
      // Opt-in in progress (see "ALERTS ON" below): this location is for
      // alerts, not an SOS - and the reply says so, and how to turn it into
      // an SOS with one word, so nobody in danger is left without help.
      activateAlertSubscription(parsed.fromPhone, parsed.latitude, parsed.longitude);
      await sendWhatsAppText(
        parsed.fromPhone,
        "You will now get SANJEEVNI hazard alerts for this area. Reply STOP to unsubscribe.\n" +
          "This location was saved for alerts only - it was NOT sent as an SOS. If you need help now, reply SOS.",
      );
    } else if (parsed.type === "text" && SOS_WORDS.has(normalizeCommand(parsed.text))) {
      // Text SOS (review R11): use the location we already have for this
      // number; otherwise ask for it. A shared location is still better -
      // the person may have moved since.
      const sub = selectSubscriber.get(parsed.fromPhone);
      if (sub && sub.latitude != null && sub.longitude != null) {
        const { httpStatus, body } = createSosRequest(deviceId, sub.latitude, sub.longitude,
          "Reported via WhatsApp text SOS - location from the person's alert subscription, may be outdated");
        await sendWhatsAppText(
          parsed.fromPhone,
          (httpStatus === 409 ? "Your SOS is already active." : "SOS received. Responders have been notified.") +
            ` Nearest hospital: ${body.hospital} (${body.distance_km} km).\n` +
            "We used the location you shared for alerts. If you are somewhere else now, share your CURRENT location.",
        );
      } else {
        await sendWhatsAppText(
          parsed.fromPhone,
          "To send help we need your location: tap the attachment icon -> Location -> Send your current location. In immediate danger, also call 112.",
        );
      }
    } else if (parsed.type === "location") {
      const { httpStatus, body } = createSosRequest(
        deviceId,
        parsed.latitude,
        parsed.longitude,
        "Reported via WhatsApp",
      );
      if (httpStatus === 409) {
        await sendWhatsAppText(
          parsed.fromPhone,
          `Your SOS is already active. Nearest hospital: ${body.hospital} (${body.distance_km} km). Help is on the way.`,
        );
      } else {
        await sendWhatsAppText(
          parsed.fromPhone,
          `SOS received. Responders have been notified.\nNearest hospital: ${body.hospital} (${body.distance_km} km)\nDirections: ${body.maps_url}`,
        );
      }
    } else if (parsed.type === "text" && ALERT_OPT_IN_WORDS.has(normalizeCommand(parsed.text))) {
      startAlertSubscription(parsed.fromPhone);
      await sendWhatsAppText(
        parsed.fromPhone,
        "To get hazard alerts for your area, share your location now (attachment icon -> Location -> Send your current location). Reply STOP any time to unsubscribe.",
      );
    } else if (parsed.type === "text" && ALERT_OPT_OUT_WORDS.has(normalizeCommand(parsed.text))) {
      stopAlertSubscription(parsed.fromPhone);
      await sendWhatsAppText(parsed.fromPhone, "You will no longer receive SANJEEVNI hazard alerts.");
    } else if (parsed.type === "text") {
      await sendWhatsAppText(
        parsed.fromPhone,
        "This is SANJEEVNI emergency response. To send an SOS, please share your LIVE LOCATION (attachment icon -> Location -> Share Live Location) so we can find you and route help.\n" +
          "To get hazard alerts for your area instead, reply ALERTS ON.",
      );
    }
  } catch (e) {
    console.error(
      "[WhatsApp] Failed to send reply:",
      e.response ? e.response.data : e.message,
    );
  }
});

app.listen(3000, () => {
  console.log("Node.js Orchestrator running on http://localhost:3000");
});
