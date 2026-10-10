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
// Citizen report photos arrive as base64 JSON (see /api/citizen-reports),
// so that ONE public route gets a larger body limit - enough for a 2 MB
// photo once base64 adds a third. It used to be 10 MB for EVERY route,
// which let anyone push 10 MB bodies at any endpoint. Registered first:
// body-parser skips a body that is already parsed.
const CITIZEN_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
app.use("/api/citizen-reports", express.json({ limit: "3mb" }));
app.use(express.json({
  // Biggest normal body: a 200-reading store-and-forward batch (the
  // backend's MAX_BATCH_SIZE) at well under 1 KB per reading.
  limit: "1mb",
  // Keep the exact bytes of WhatsApp webhooks: Meta's signature is computed
  // over the raw body, not the re-serialised JSON (see verifyMetaSignature).
  verify: (req, res, buf) => {
    if (req.originalUrl.startsWith("/api/whatsapp/webhook")) req.rawBody = buf;
  },
}));
// Body-parser errors (too large, broken JSON) as short JSON. Express's
// default answer is an HTML page with a stack trace (NODE_ENV is not set
// to production here), which the public didn't need to see.
app.use((err, req, res, next) => {
  if (err && err.type === "entity.too.large") return res.status(413).json({ error: "Request body too large" });
  if (err && err.type === "entity.parse.failed") return res.status(400).json({ error: "Request body is not valid JSON" });
  next(err);
});
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
// Village siren on nodes: desired/reported state + the auto rule - see siren.js
const siren = require("./siren");
const sirens = siren.setupSirens(db);
const { setupOfficerAlerts } = require("./officer_alerts");
// Confidence score per alert (worked out by the AI backend, cleaned here) - see confidence.js
const { confidenceColumns, confidenceFromRow, confidenceSummary } = require("./confidence");

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
  // risk trends, district summary report, CAP/PDF/timeline per alert (step W2) - React only
  ["trends.html", { file: "trends.html", roles: auth.OFFICER_ROLES }],
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
  // The folder may have been deleted while the server runs - recreate it
  // rather than failing every backup from then on.
  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
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

// An exception thrown inside a timer callback is uncaught and EXITS Node -
// a full disk or a locked database must cost one backup, not take SOS
// intake and ingestion down with it (B48).
setInterval(() => {
  try {
    backupDatabase();
  } catch (e) {
    console.error("[backup] scheduled backup failed:", e.message);
  }
}, BACKUP_INTERVAL_MS);

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
// How sure the AI backend is about each alert (0..1, its High/Medium/Low
// label and the short reasons behind it, as a JSON array) - see
// confidence.js. Added after the table existed, so an older sanjeevni.db
// gets the columns here; its old rows stay NULL ("no confidence given").
{
  const existingCols = db.prepare("PRAGMA table_info(sensor_data)").all().map((r) => r.name);
  if (!existingCols.includes("confidence")) db.exec("ALTER TABLE sensor_data ADD COLUMN confidence REAL");
  if (!existingCols.includes("confidence_label")) db.exec("ALTER TABLE sensor_data ADD COLUMN confidence_label TEXT");
  if (!existingCols.includes("confidence_reasons")) db.exec("ALTER TABLE sensor_data ADD COLUMN confidence_reasons TEXT");
  // 1 = the alert's severity came from the WEATHER FORECAST, not from this
  // node's sensors (siren.js isForecastResult). The officer alarm groups
  // those into one area-wide item per hazard type (frontend lib/alarm.ts).
  // Older rows stay NULL = measured.
  if (!existingCols.includes("forecast_based")) db.exec("ALTER TABLE sensor_data ADD COLUMN forecast_based INTEGER");
}

const insertReading = db.prepare(`
  INSERT INTO sensor_data
  (node_id, location, hazard_type, severity, risk_score, river_level_m, temp_c,
   humidity_pct, gas_ppm, status, message, eta_minutes, predicted_time,
   latitude, longitude, timestamp, confidence, confidence_label, confidence_reasons, forecast_based)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
// Only nodes still in the registry count (B69): a deleted node can never
// send the reading that would clear its last hazard, so it used to stay on
// the public map forever. The readings themselves are kept (history).
const ACTIVE_HAZARD_SQL = (statuses, onlyRegistered) => `
  SELECT sd.node_id, sd.location, sd.hazard_type, sd.severity, sd.risk_score,
         sd.eta_minutes, sd.predicted_time, sd.latitude, sd.longitude, sd.status,
         sd.timestamp, sd.confidence, sd.confidence_label, sd.confidence_reasons, sd.forecast_based
  FROM sensor_data sd
  INNER JOIN (
    SELECT node_id, MAX(id) as max_id FROM sensor_data GROUP BY node_id
  ) latest ON sd.node_id = latest.node_id AND sd.id = latest.max_id
  WHERE sd.severity IN ('MEDIUM','HIGH','CRITICAL')
    AND sd.status IN (${statuses})
    ${onlyRegistered ? "AND EXISTS (SELECT 1 FROM nodes n WHERE n.node_id = sd.node_id)" : ""}
  ORDER BY sd.risk_score DESC
`;
// The `nodes` table belongs to backend_server.py and doesn't exist until it
// has started once, so the filtered query is prepared lazily (like
// nodeInfo below). Until then the unfiltered query is used - there is no
// registry yet, so nothing can have been deleted from it.
function hazardQuery(statuses) {
  const unfiltered = db.prepare(ACTIVE_HAZARD_SQL(statuses, false));
  let filtered = null;
  return {
    all() {
      if (!filtered) {
        try {
          filtered = db.prepare(ACTIVE_HAZARD_SQL(statuses, true));
        } catch {
          return unfiltered.all(); // "no such table: nodes" - try again next time
        }
      }
      return filtered.all();
    },
  };
}
const selectActiveHazards = hazardQuery("'alert_dispatched'");

// A hazard whose node has not reported for this long is "stale": it stays
// listed (the node may have gone silent BECAUSE of the hazard) but is
// labelled as last-known state and does not set off the staff alarm.
const STALE_HAZARD_MS = (parseInt(process.env.STALE_HAZARD_MINUTES || "30", 10) || 30) * 60000;
// A missing/unparseable timestamp counts as NOT stale (fail safe: keep alarming).
function hazardAge(ts) {
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return { last_reading_at: ts || null, stale: false };
  return { last_reading_at: ts, stale: Date.now() - t > STALE_HAZARD_MS };
}
const selectActiveAndPendingHazards = hazardQuery("'alert_dispatched','pending_confirmation'");

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
  // Where the coordinates came from: 'gps' (the phone's location), 'manual'
  // (the person tapped a point on the SOS page map because location was
  // denied, unavailable or too slow - approximate, officers must be told),
  // 'whatsapp' or 'node' (the SOS button on a sensor node - the node's
  // registered position). Rows from before this column existed stay NULL.
  if (!existingCols.includes("location_source")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN location_source TEXT");
  }
  // How far off a device fix may be (the browser's coords.accuracy, metres).
  // A phone or laptop without GPS still answers with a Wi-Fi / cell / IP
  // position that can be kilometres off - officers must see that, not a pin
  // that looks exact. NULL = unknown (manual point, WhatsApp, sensor node,
  // an older page, or an SOS from before this column).
  if (!existingCols.includes("location_accuracy_m")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN location_accuracy_m REAL");
  }
  // 1 = filed from a simulated reading (simulation.js / the judge demo, see
  // createNodeButtonSos). A test node SOS and a real press share the device
  // id "node:<NODE>", so a real press must be able to tell that the open SOS
  // it would otherwise join is only a test. NULL/0 = real.
  if (!existingCols.includes("simulated")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN simulated INTEGER");
  }
  // Offline SOS Wi-Fi page (location_source 'hotspot'): how many people and
  // what they need ("trapped,injured" from a fixed list). NULL for every
  // other channel - they have no such fields.
  if (!existingCols.includes("people")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN people INTEGER");
  }
  if (!existingCols.includes("needs")) {
    db.exec("ALTER TABLE sos_requests ADD COLUMN needs TEXT");
  }
}

const insertSos = db.prepare(
  `INSERT INTO sos_requests (device_id, latitude, longitude, note, status, timestamp, location_source, location_accuracy_m, simulated)
   VALUES (?, ?, ?, ?, 'open', ?, ?, ?, ?)`,
);
// A device fix less exact than this is "approximate": the SOS page tells the
// person and offers the map, the officer views warn. Same value in
// frontend/src/lib/sos.ts and the classic pages.
const APPROX_LOCATION_M = 500;

// One row per SOS-button press a sensor node reported (see
// createNodeButtonSos). A press arrives as an ordinary reading, so a
// store-and-forward retry, a gateway replay or a 502 answer (backend down -
// the node keeps the reading queued and sends it again) repeats it. Keyed on
// (node_id, reading_uid) and kept even when the press was folded into an
// already-open SOS: a column on sos_requests could not remember those, and a
// replay after the officer resolved that SOS would open a second one.
db.exec(`
  CREATE TABLE IF NOT EXISTS node_sos_presses (
    node_id TEXT NOT NULL,
    reading_uid TEXT NOT NULL,
    sos_id INTEGER,
    received_at TEXT NOT NULL,
    PRIMARY KEY (node_id, reading_uid)
  )
`);
const selectNodeSosPress = db.prepare("SELECT sos_id FROM node_sos_presses WHERE node_id=? AND reading_uid=?");
const insertNodeSosPress = db.prepare(
  "INSERT OR IGNORE INTO node_sos_presses (node_id, reading_uid, sos_id, received_at) VALUES (?, ?, ?, ?)",
);
// One row per offline-hotspot SOS (POST /api/ingest/sos), for the same
// reason as node_sos_presses: the gateway keeps a request queued until it
// gets a 2xx, so a lost answer brings the same request again. Keyed on
// (node_id, sos_uid) - the uid is made on the gateway/node per request.
db.exec(`
  CREATE TABLE IF NOT EXISTS hotspot_sos (
    node_id TEXT NOT NULL,
    sos_uid TEXT NOT NULL,
    sos_id INTEGER,
    client_id TEXT,
    received_at TEXT NOT NULL,
    PRIMARY KEY (node_id, sos_uid)
  )
`);
const selectHotspotSos = db.prepare("SELECT sos_id FROM hotspot_sos WHERE node_id=? AND sos_uid=?");
const insertHotspotSos = db.prepare(
  "INSERT OR IGNORE INTO hotspot_sos (node_id, sos_uid, sos_id, client_id, received_at) VALUES (?, ?, ?, ?, ?)",
);
const updateSosDetails = db.prepare("UPDATE sos_requests SET people=?, needs=? WHERE id=?");
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
// Uploaded files come from anonymous citizens. Even with the type check in
// POST /api/citizen-reports (B38), anything already on disk - e.g. an .html
// or .svg saved before that check existed - must never run script on this
// origin: the sandbox CSP gives the response an opaque origin with no
// scripts, nosniff (basicSecurityHeaders) stops type guessing, and any
// file that isn't a photo is offered as a download, never rendered.
const CITIZEN_PHOTO_FILE = /\.(jpg|png|webp)$/i;
app.use("/citizen_uploads", express.static(CITIZEN_UPLOADS_DIR, {
  index: false,
  setHeaders: (res, filePath) => {
    res.set("Content-Security-Policy", "default-src 'none'; sandbox");
    if (!CITIZEN_PHOTO_FILE.test(filePath)) res.set("Content-Disposition", "attachment");
  },
}));

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

// Confirmed HIGH/CRITICAL hazard areas (same circles as the public map).
// Stale ones count too: a node may have gone silent BECAUSE of the hazard,
// and the map still shows them as last-known state.
function severeHazardZones() {
  return selectActiveHazards.all()
    .filter((r) => (r.severity === "HIGH" || r.severity === "CRITICAL") && r.latitude != null && r.longitude != null)
    .map((r) => ({
      hazard_type: r.hazard_type,
      severity: r.severity,
      latitude: r.latitude,
      longitude: r.longitude,
      radius_m: HAZARD_RADIUS_M[r.severity] || 500,
    }));
}

// The most severe zone that (lat, lon) lies inside, or null.
function zoneContaining(lat, lon, zones) {
  let found = null;
  for (const z of zones) {
    if (haversineKm(lat, lon, z.latitude, z.longitude) * 1000 > z.radius_m) continue;
    if (!found || SEVERITY_RANK[z.severity] > SEVERITY_RANK[found.severity]) found = z;
  }
  return found;
}

// Nearest hospital by STRAIGHT-LINE distance (not a road route), skipping
// hospitals inside an active HIGH/CRITICAL zone: sending someone into a
// flood or gas-leak area to reach care is worse than a longer trip. The
// nearer hospital that was skipped is returned too, so the page can say
// why a farther one is shown. If EVERY hospital is inside a zone, the
// nearest one is still returned (flagged) - no hospital at all helps nobody.
function nearestHospital(lat, lon, zones = []) {
  let best = null;
  let bestDist = Infinity;
  let any = null; // nearest regardless of zones (fallback)
  let anyDist = Infinity;
  let skipped = null; // nearest hospital passed over because of a zone
  let skippedDist = Infinity;
  for (const h of hospitals) {
    const d = haversineKm(lat, lon, h.latitude, h.longitude);
    if (!(d < Infinity)) continue; // NaN coordinates: no hospital (B47)
    if (d < anyDist) {
      anyDist = d;
      any = h;
    }
    const zone = zoneContaining(h.latitude, h.longitude, zones);
    if (zone) {
      if (d < skippedDist) {
        skippedDist = d;
        skipped = { hospital: h, zone };
      }
    } else if (d < bestDist) {
      bestDist = d;
      best = h;
    }
  }
  if (!best && any) {
    return { hospital: any, distance_km: +anyDist.toFixed(2), inZone: zoneContaining(any.latitude, any.longitude, zones), skipped: null };
  }
  return {
    hospital: best,
    distance_km: +bestDist.toFixed(2),
    inZone: null,
    // only worth mentioning when it really was closer than the one shown
    skipped: best && skipped && skippedDist < bestDist ? { ...skipped, distance_km: +skippedDist.toFixed(2) } : null,
  };
}

function mapsLink(oLat, oLon, dLat, dLon) {
  return `https://www.google.com/maps/dir/?api=1&origin=${oLat},${oLon}&destination=${dLat},${dLon}&travelmode=driving`;
}

// Nearest hospital + route from (lat, lon), with nulls instead of a crash
// when there is none. Non-numeric coordinates make every distance NaN, so
// nearestHospital() finds no hospital; reading hospital.name then threw,
// and ONE bad SOS row turned the whole officer SOS feed into a 500 (B47).
// `zones` = severeHazardZones(); pass it in when looking up many points
// (officer feed) so the hazard query runs once, not once per SOS.
// distance_km is straight-line; maps_url gives the real road route.
function hospitalFor(lat, lon, zones = severeHazardZones()) {
  const { hospital, distance_km, inZone, skipped } = nearestHospital(lat, lon, zones);
  if (!hospital) {
    return { hospital: null, distance_km: null, maps_url: null, skipped_hospital: null, hospital_in_hazard_zone: null };
  }
  return {
    hospital: hospital.name,
    distance_km,
    maps_url: mapsLink(lat, lon, hospital.latitude, hospital.longitude),
    // a nearer hospital left out because it lies inside an active zone
    skipped_hospital: skipped
      ? {
          hospital: skipped.hospital.name,
          distance_km: skipped.distance_km,
          hazard_type: skipped.zone.hazard_type,
          severity: skipped.zone.severity,
        }
      : null,
    // set only when every hospital is inside a zone and this one was the nearest
    hospital_in_hazard_zone: inZone ? { hazard_type: inZone.hazard_type, severity: inZone.severity } : null,
  };
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

// SANJEEVNI_BACKEND_URL / SANJEEVNI_PORT (bottom of file) only exist so a
// test copy can run beside the real servers; leave them unset normally.
const PYTHON_BACKEND_URL = process.env.SANJEEVNI_BACKEND_URL || "http://127.0.0.1:8000";

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
    ...confidenceColumns(aiResult),
    siren.isForecastResult(aiResult) ? 1 : 0,
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

  // Village siren auto rule (confirmed CRITICAL evacuation hazards only,
  // SIREN_AUTO_HAZARDS - see siren.js). A
  // siren bug must never cost the reading or the alerts above.
  let sirenFired = null;
  try {
    sirenFired = sirens.onAiResult(sensorData, aiResult) || null;
  } catch (e) {
    console.error(`[siren] auto rule failed for ${sensorData.node_id}: ${e.message}`);
  }

  // Officers' phones (officer_alerts.js): confirmed HIGH/CRITICAL once per
  // hazard episode, and automatic sirens. Sending is queued, never awaited.
  try {
    officerAlerts.onAiResult(sensorData, aiResult, { siren: sirenFired });
  } catch (e) {
    console.error(`[officer-alert] failed for ${sensorData.node_id}: ${e.message}`);
  }
}

// Siren bookkeeping around ingestion. Never throws: a siren problem must
// not stop readings (or an SOS) from being stored.
// single: the /api/ingest route, where a reading without timestamp /
// age_seconds is live; in a batch it is an untimed backlog reading, as the
// backend treats it.
function recordSirenReports(readings, single = false) {
  try {
    sirens.recordReported(readings, Date.now(), { untimedIsNow: single });
  } catch (e) {
    console.error(`[siren] could not store reported siren state: ${e.message}`);
  }
}
// Adds "commands" (desired siren state for the siren-fitted nodes in this
// request whose reported state differs) to an ingest answer. Left out when
// there is nothing to send, so the answer is unchanged for older gateways.
function withSirenCommands(body, readings) {
  try {
    const commands = sirens.commandsFor(readings);
    if (commands.length) return { ...body, commands };
  } catch (e) {
    console.error(`[siren] could not work out siren commands: ${e.message}`);
  }
  return body;
}

// Passes the Python backend's own status code through (e.g. 400 for an
// unknown node_id) instead of turning everything into 500. Nodes rely on
// this: 4xx = drop the reading from the local queue (resending won't
// help), 5xx / no response = keep it queued and retry later.
// Exception: the backend's own 401/403 (it rejected OFFICER_API_KEY) is a
// server-to-server config problem, not the caller's. Passed through, a 401
// sent the browser to the login page in an endless loop (B53), and a 4xx
// tells a node to DROP readings that a fixed config would accept - so it
// becomes 502 ("retry later").
function upstreamAuthRejected(error) {
  const status = error.response && error.response.status;
  if (status !== 401 && status !== 403) return false;
  console.error(`[backend] AI backend answered HTTP ${status} - OFFICER_API_KEY differs between the two servers?`);
  return true;
}
const UPSTREAM_AUTH_MESSAGE =
  "The AI backend rejected this server's OFFICER_API_KEY. Set the same key for both servers in .env and restart both.";

// `readings`: the request's allowed readings, if any. Siren commands ride
// on error answers too, so an officer can still silence a siren while the
// AI backend is down (a gateway may read them whatever the HTTP status).
function sendPipelineError(res, error, readings = []) {
  if (upstreamAuthRejected(error)) {
    return res.status(502).json(withSirenCommands({ status: "error", detail: UPSTREAM_AUTH_MESSAGE }, readings));
  }
  const status = error.response ? error.response.status : 502;
  const detail = error.response ? error.response.data : error.message;
  console.error("Pipeline error:", status, error.message);
  res.status(status).json(withSirenCommands({ status: "error", detail }, readings));
}

// 1. Ingestion endpoint - ESP32 / simulator sends raw readings here.
// Requires a device key (device_auth.js) allowed to report for this node.
app.post("/api/ingest", device.requireDeviceKey, async (req, res) => {
  let sensorData = null;
  try {
    if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
      return res.status(400).json({ error: "body must be one reading object" });
    }
    if (!device.nodeAllowed(req.device, req.body.node_id)) {
      return res.status(403).json({ error: `Device key '${req.device.name}' may not report for ${req.body.node_id}` });
    }
    sensorData = device.applyKeyPolicy(req.device, req.body);
    // Before forwarding: the SOS must not depend on the AI backend being up
    // or accepting the reading (it may reject it for an unrelated value).
    // The same goes for the siren state the node reports.
    nodeSosFromReadings([sensorData]);
    recordSirenReports([sensorData], true);
    const pythonResponse = await axios.post(
      `${PYTHON_BACKEND_URL}/api/ingest`,
      sensorData,
    );
    const aiResult = pythonResponse.data;
    storeDashboardRow(sensorData, aiResult);
    res.status(200).json(withSirenCommands({ status: "success", ai_action: aiResult.status }, [sensorData]));
  } catch (error) {
    sendPipelineError(res, error, sensorData ? [sensorData] : []);
  }
});

// 1b. Store-and-forward upload - a node or LoRa gateway sends readings it
// queued while offline, in one request ({ readings: [...] }). The response
// lists one status per reading, in the same order, so the sender knows
// which queue entries it can delete.
app.post("/api/ingest/batch", device.requireDeviceKey, async (req, res) => {
  let readings = [];
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
    // NOTHING in the request is allowed: answer 403 like /api/ingest does
    // (B56). With 200 the node/gateway deleted these readings from its
    // flash queue, so a key/--nodes mistake silently lost every reading;
    // 403 keeps them queued (sjUploadAction -> RETRY) until the key is
    // fixed. A MIXED batch still gets 200: a 403 there would block the
    // allowed nodes' newer readings behind it forever (FIFO queue), so the
    // rejected ones are only logged above - every node a gateway hears must
    // be in its key's --nodes list.
    if (submitted.length > 0 && allowedIdx.length === 0) {
      const nodes = [...new Set(submitted.map((r) => String(r.node_id)))].join(", ");
      return res.status(403).json({ error: `Device key '${req.device.name}' may not report for ${nodes}` });
    }
    readings = allowedIdx.map((i) => device.applyKeyPolicy(req.device, submitted[i]));
    // Only readings this key may send (a stolen key for one node can't raise
    // SOS for another, or get its siren commands), and before forwarding -
    // see /api/ingest.
    nodeSosFromReadings(readings);
    recordSirenReports(readings);
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
    res.status(200).json(withSirenCommands({
      status: "success",
      results: results.map((r) => ({
        node_id: r.node_id,
        reading_uid: r.reading_uid ?? null,
        ai_action: r.status,
      })),
    }, readings));
  } catch (error) {
    sendPipelineError(res, error, readings);
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
    ...confidenceFromRow(r),
  }));

  res.json({ success: true, count: rows.length, data });
});

// 3. Raw history (unshaped)
app.get("/api/history", auth.requireLogin, (req, res) => {
  // confidence_reasons is stored as JSON text - hand it out as the array
  res.json(selectHistory.all().map((r) => ({ ...r, ...confidenceFromRow(r) })));
});

// 4. Nearest hospital + directions link for a given sensor node
app.get("/api/route/:node_id", auth.requireLogin, (req, res) => {
  const coords = nodeInfo(req.params.node_id);
  if (!coords) {
    return res.status(404).json({ error: "unknown node_id" });
  }
  res.json({ node_id: req.params.node_id, ...hospitalFor(coords.latitude, coords.longitude) });
});

// 4b. Nearest hospital + route for ANY coordinates (not just a sensor
// node) - used by the citizen portal to show every visitor their nearest
// hospital and route proactively, without requiring them to press SOS
// first. This does NOT write anything to the database - it's a pure
// lookup, safe to call as often as the portal needs.
app.get("/api/nearest-hospital", (req, res) => {
  // parseCoordinates (defined below) also refuses "Infinity" and
  // out-of-range values, which parseFloat let through to a 500.
  const coords = parseCoordinates(req.query.latitude, req.query.longitude);
  if (!coords) {
    return res
      .status(400)
      .json({ error: "latitude and longitude query params are required" });
  }
  res.json(hospitalFor(coords.latitude, coords.longitude));
});

// 5. Citizen presses SOS -> stored, and they immediately get the route to
// the nearest hospital back in the response.
// Shared SOS-creation logic, used by BOTH the citizen portal's POST
// /api/sos AND the new WhatsApp webhook below - one source of truth
// for "what happens when someone reports an SOS", regardless of which
// channel it came in through.
// locationSource: "gps" | "manual" | "whatsapp" | "node" (see the
// sos_requests location_source column). accuracyM: the device fix's
// accuracy in metres, or null when unknown / not a device fix.
function createSosRequest(deviceId, latitude, longitude, note, locationSource, accuracyM = null, simulated = false) {
  const existing = selectOpenSosByDevice.get(deviceId);
  // An open row without real coordinates (only possible from before B47) is
  // never shown to officers and can't be routed to, so it must not block
  // this person's REAL SOS with a 409 "help is on the way" that nobody
  // acts on. Close it as 'invalid' and store the new one.
  if (existing && !parseCoordinates(existing.latitude, existing.longitude)) {
    console.warn(`[sos] SOS #${existing.id} had invalid coordinates (${existing.latitude}, ${existing.longitude}) - closed as 'invalid', new SOS stored`);
    updateSosStatus.run("invalid", existing.id);
  } else if (existing) {
    return {
      httpStatus: 409,
      body: {
        status: "already_active",
        error:
          "This device already has an active SOS request awaiting response.",
        sos_id: existing.id,
        ...hospitalFor(existing.latitude, existing.longitude),
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
    locationSource,
    accuracyM,
    simulated ? 1 : 0,
  );
  return {
    httpStatus: 201,
    body: {
      status: "received",
      sos_id: result.lastInsertRowid,
      ...hospitalFor(latitude, longitude),
    },
  };
}

// --- SOS push-button on a LoRa sensor node --------------------------------
// For people with no phone at all: holding the button on a node makes its
// next reading carry sos_button: true (firmware SJ_SOS_PRESSED). The SOS is
// filed HERE, not by the AI backend, so it goes through even when the
// backend is down or rejects the reading for another reason.
// Location = the node's registered position (the person is at the node).
const NODE_SOS_PREFIX = "node:";
const NODE_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

// Files the SOS for every reading with sos_button === true. Callers pass
// only readings the device key is allowed to send. Never throws: a failed
// SOS is logged, and ingestion of the readings themselves carries on.
function nodeSosFromReadings(readings) {
  for (const reading of readings) {
    if (reading.sos_button !== true) continue;
    try {
      createNodeButtonSos(reading);
    } catch (e) {
      console.error(`[sos] !!! SOS button on node ${reading.node_id} could NOT be stored: ${e.message}`);
    }
  }
}

function createNodeButtonSos(reading) {
  const nodeId = reading.node_id;
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    console.error(`[sos] !!! SOS button reading with an unusable node_id (${JSON.stringify(nodeId)}) - no SOS filed`);
    return null;
  }
  const simulated = reading.simulated === true;
  // One press = one SOS. Without a reading_uid a replay can't be told from
  // a new press; the one-open-SOS-per-device rule still stops duplicates
  // while the first SOS is open. Simulated presses are remembered under
  // their own key ("sim:<uid>"), so a test uid can never swallow a real
  // press that happens to carry the same uid.
  const rawUid = reading.reading_uid == null ? null : String(reading.reading_uid).slice(0, 200);
  const uid = rawUid !== null && simulated ? `sim:${rawUid}` : rawUid;
  if (uid !== null) {
    const seen = selectNodeSosPress.get(nodeId, uid);
    if (seen) return { status: "duplicate", sos_id: seen.sos_id };
  }

  const info = nodeInfo(nodeId);
  const coords = info ? parseCoordinates(info.latitude, info.longitude) : null;
  const deviceId = NODE_SOS_PREFIX + nodeId;
  const where = info && info.location ? ` (${info.location})` : coords ? "" : " (NO REGISTERED POSITION)";
  let note = `SOS button pressed on sensor node ${nodeId}${where}`;
  const age = Number(reading.age_seconds);
  if (Number.isFinite(age) && age > 120) note += ` - pressed about ${Math.round(age / 60)} min ago`;
  // simulation.js / the judge demo: officers must be able to tell a test press from a real one
  if (simulated) note += " - SIMULATED (test/demo reading)";

  // A real press must never be folded into a TEST SOS (same device id): the
  // officer would resolve that row as a test, and the press - recorded
  // against it - would then count as already handled, so no SOS would ever
  // open for the real person. The test SOS is closed as 'superseded' and the
  // real press files its own. (The reverse - a test press while a real SOS
  // is open - joins the real one, which is harmless.) The device id stays
  // "node:<NODE>" for both, as the officer views and the judge demo expect.
  if (!simulated) supersedeSimulatedSos(deviceId, `on node ${nodeId}`, "a REAL SOS button press arrived");

  let sosId;
  let status;
  if (coords) {
    const { httpStatus, body } = createSosRequest(deviceId, coords.latitude, coords.longitude, note, "node", null, simulated);
    sosId = body.sos_id;
    status = httpStatus === 201 ? "received" : "already_active";
  } else {
    // A node missing from the registry (or registered without a position)
    // has nowhere to put a pin - but a press is someone asking for help and
    // must not vanish. Stored with NULL coordinates; GET /api/sos lists
    // these separately (unlocated_node_sos) so the officer views show a
    // banner, and the next press after the node gets a position replaces it
    // with a mapped SOS (createSosRequest closes the unmapped one).
    console.error(`[sos] !!! SOS button pressed on node ${nodeId}, which has NO registered position - ` +
      "stored without a map pin and shown to officers as an unlocated SOS. Register the node's position (admin page).");
    ({ status, sos_id: sosId } = storeUnlocatedSos(deviceId, note, "node", simulated));
  }
  if (uid !== null) insertNodeSosPress.run(nodeId, uid, sosId, new Date().toISOString());
  console.warn(`[sos] SOS button on node ${nodeId} (reading ${uid ?? "without uid"}${simulated ? ", simulated" : ""}) -> SOS #${sosId} ${status}`);
  return { status, sos_id: sosId };
}

// Closes an open SIMULATED SOS under deviceId so a real request files its
// own (see createNodeButtonSos for why a real one must never join a test).
function supersedeSimulatedSos(deviceId, where, why) {
  const open = selectOpenSosByDevice.get(deviceId);
  if (open && open.simulated === 1) {
    updateSosStatus.run("superseded", open.id);
    console.warn(`[sos] simulated SOS #${open.id} ${where} closed as 'superseded' - ${why}`);
  }
}

// Stores an SOS that has no usable position (node/gateway not registered,
// or registered without coordinates): one open row per device id, NULL
// coordinates, listed to officers as "unlocated" (GET /api/sos). Returns
// { status: "received" | "already_active", sos_id }.
function storeUnlocatedSos(deviceId, note, locationSource, simulated) {
  const existing = selectOpenSosByDevice.get(deviceId);
  if (existing) return { status: "already_active", sos_id: existing.id };
  const sosId = insertSos.run(deviceId, null, null, note, new Date().toISOString(), locationSource, null, simulated ? 1 : 0)
    .lastInsertRowid;
  return { status: "received", sos_id: sosId };
}

// --- Offline SOS Wi-Fi ("SANJEEVNI-SOS" hotspot) ---------------------------
// A gateway (and optionally a mains/solar node) runs an open Wi-Fi with a
// tiny SOS page for people whose phone has no mobile data. Browsers do not
// give a plain-http page the phone's location, so the position is the
// node's registered one (the person is within Wi-Fi range of it) unless
// they typed coordinates. The gateway forwards each request here with its
// device key and retries until it gets a 2xx.
const HOTSPOT_SOS_PREFIX = "hotspot:";
const HOTSPOT_NEEDS = new Set(["trapped", "injured", "medical", "fire"]);
const HOTSPOT_NOTE_MAX = 160; // the page's own cap (contract)
const HOTSPOT_PEOPLE_MAX = 999; // sanity cap, not a known limit
// Rough Wi-Fi range of an ESP32 SoftAP in the open - a configurable demo
// figure for the officer label ("within ~150 m"), not a measured one.
const HOTSPOT_POSITION_ACCURACY_M = 150;
// Typed coordinates further than this from the hotspot's registered
// position are not used for the pin (see createHotspotSos). A configurable
// demo default: Wi-Fi range plus room for a node relaying from a little
// further away - not a measured figure.
const HOTSPOT_TYPED_MAX_M = Number(process.env.HOTSPOT_TYPED_MAX_M) > 0 ? Number(process.env.HOTSPOT_TYPED_MAX_M) : 2000;
const HOTSPOT_UID_PATTERN = /^[\x21-\x7e]{1,64}$/; // printable ASCII, no spaces
const HOTSPOT_CLIENT_PATTERN = /[^A-Za-z0-9_-]/g;

// The phone's short id -> safe part of the device id. A missing or odd id
// must never lose the SOS (a 4xx would make the gateway drop it), and must
// not lump different people into one device id either - so it falls back
// to the request's own uid.
function hotspotClientId(clientId, sosUid) {
  const cleaned = typeof clientId === "string" ? clientId.replace(HOTSPOT_CLIENT_PATTERN, "").slice(0, 32) : "";
  return cleaned || `uid-${sosUid.replace(HOTSPOT_CLIENT_PATTERN, "").slice(0, 32) || "unknown"}`;
}

// Free text from a stranger's phone: control characters out, length capped.
// (Every officer view escapes it again when it is shown.)
const cleanHotspotText = (text) =>
  typeof text === "string" ? text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, HOTSPOT_NOTE_MAX) : "";

// A second request from the same phone while its SOS is open is a
// follow-up ("now 5 people, one injured"): it joins the open SOS, and what
// it adds must reach officers - the larger people count, the union of the
// needs, and its description appended to the note. A test request never
// edits a real person's SOS. The note is capped so a phone resending over
// and over cannot grow it without end.
const HOTSPOT_NOTE_TOTAL_MAX = 1500;
const selectSosDetails = db.prepare("SELECT note, people, needs, simulated FROM sos_requests WHERE id=?");
const updateSosFollowUp = db.prepare("UPDATE sos_requests SET note=?, people=?, needs=? WHERE id=?");
function mergeHotspotFollowUp(sosId, { people, needs, text, simulated, client }) {
  const open = selectSosDetails.get(sosId);
  if (!open || (simulated && open.simulated !== 1)) return;
  const oldNeeds = open.needs ? String(open.needs).split(",").filter(Boolean) : [];
  const mergedNeeds = [...new Set([...oldNeeds, ...needs])];
  const mergedPeople = people != null && (open.people == null || people > open.people) ? people : open.people;
  let note = open.note || "";
  if (text && note.length < HOTSPOT_NOTE_TOTAL_MAX) {
    note = `${note} | update: "${text}"`.slice(0, HOTSPOT_NOTE_TOTAL_MAX);
  }
  const changed = note !== (open.note || "") || mergedPeople !== open.people || mergedNeeds.length !== oldNeeds.length;
  if (!changed) return;
  updateSosFollowUp.run(note || null, mergedPeople, mergedNeeds.length ? mergedNeeds.join(",") : null, sosId);
  console.warn(`[sos] offline SOS Wi-Fi follow-up from client ${client} -> SOS #${sosId} updated ` +
    `(people ${mergedPeople ?? "?"}, needs ${mergedNeeds.join(",") || "none"}${text ? ", new description" : ""})`);
}

function createHotspotSos(data, nodeId, sosUid) {
  const simulated = data.simulated === true;
  // Simulated requests are remembered under their own key, as for node presses
  const key = simulated ? `sim:${sosUid}` : sosUid;
  const seen = selectHotspotSos.get(nodeId, key);
  if (seen) return { status: "duplicate", sos_id: seen.sos_id };

  const client = hotspotClientId(data.client_id, sosUid);
  const deviceId = `${HOTSPOT_SOS_PREFIX}${nodeId}:${client}`;
  const people = Number.isInteger(data.people) && data.people >= 1 && data.people <= HOTSPOT_PEOPLE_MAX ? data.people : null;
  const needs = Array.isArray(data.needs) ? [...new Set(data.needs.filter((n) => HOTSPOT_NEEDS.has(n)))] : [];
  const text = cleanHotspotText(data.note);

  // Coordinates the person typed (read off another app, a signboard) win:
  // they say where the person IS. Otherwise the node's registered position,
  // good to about the Wi-Fi range. Typed ones are unverified, so they get no
  // accuracy figure and the officer views say they were typed.
  // But the person is within Wi-Fi range of the hotspot (or of the node that
  // relayed it): typed coordinates far from it are a typo, swapped lat/lon
  // or abuse, and a pin there would send rescuers to the wrong place. Then
  // the known node position is kept and the typed pair only goes in the note.
  const typedRaw = data.latitude != null && data.longitude != null ? parseCoordinates(data.latitude, data.longitude) : null;
  const info = nodeInfo(nodeId);
  const nodeCoords = info ? parseCoordinates(info.latitude, info.longitude) : null;
  const typedKm = typedRaw && nodeCoords
    ? haversineKm(typedRaw.latitude, typedRaw.longitude, nodeCoords.latitude, nodeCoords.longitude)
    : null;
  const typedFar = typedKm !== null && typedKm * 1000 > HOTSPOT_TYPED_MAX_M;
  const typed = typedFar ? null : typedRaw;
  const coords = typed || nodeCoords;
  const accuracyM = typed ? null : nodeCoords ? HOTSPOT_POSITION_ACCURACY_M : null;

  const where = info && info.location ? ` (${info.location})` : coords ? "" : " (NO REGISTERED POSITION)";
  let note = `Offline SOS Wi-Fi at ${nodeId}${where}`;
  note += text ? `: "${text}"` : " - no description given";
  if (typed) note += " - location typed by the person";
  if (typedFar) {
    note += ` - typed location ${typedRaw.latitude},${typedRaw.longitude} is ${typedKm.toFixed(1)} km from the hotspot ` +
      "(unverified, NOT used for the pin)";
    console.warn(`[sos] offline SOS Wi-Fi at ${nodeId}: typed location is ${typedKm.toFixed(1)} km away - ` +
      "kept the hotspot's position for the pin");
  }
  const age = Number(data.age_seconds);
  if (Number.isFinite(age) && age > 120) note += ` - sent about ${Math.round(age / 60)} min ago`;
  if (simulated) note += " - SIMULATED (test/demo request)";

  if (!simulated) supersedeSimulatedSos(deviceId, `from ${deviceId}`, "a REAL hotspot SOS arrived");
  let result;
  if (coords) {
    const { httpStatus, body } = createSosRequest(deviceId, coords.latitude, coords.longitude, note, "hotspot", accuracyM, simulated);
    result = { status: httpStatus === 201 ? "ok" : "already_active", sos_id: body.sos_id };
  } else {
    console.error(`[sos] !!! offline SOS Wi-Fi request at ${nodeId}, which has NO registered position - ` +
      "stored without a map pin and shown to officers as an unlocated SOS. Register its position (admin page).");
    const stored = storeUnlocatedSos(deviceId, note, "hotspot", simulated);
    result = { status: stored.status === "received" ? "ok" : "already_active", sos_id: stored.sos_id };
  }
  if (result.status === "ok") updateSosDetails.run(people, needs.length ? needs.join(",") : null, result.sos_id);
  else mergeHotspotFollowUp(result.sos_id, { people, needs, text, simulated, client });
  insertHotspotSos.run(nodeId, key, result.sos_id, client, new Date().toISOString());
  console.warn(`[sos] offline SOS Wi-Fi at ${nodeId} (client ${client}, uid ${sosUid}${simulated ? ", simulated" : ""}) ` +
    `-> SOS #${result.sos_id} ${result.status}`);
  return result;
}

// The accuracy a web client reports for its device fix, in metres, or null.
// Never a reason to refuse an SOS: a bad value is logged and dropped.
// Only called for device fixes (manual points have no accuracy). A missing
// value is logged too - one line per SOS, and it tells the operator that
// an older cached page is still in use, whose pins officers can't judge.
const MAX_LOCATION_ACCURACY_M = 1e6;
function parseLocationAccuracy(value) {
  if (value == null) {
    console.warn("[sos] device-location SOS without location_accuracy_m (older page?) - accuracy stored as unknown");
    return null;
  }
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= MAX_LOCATION_ACCURACY_M) {
    return value;
  }
  console.warn(`[sos] ignoring invalid location_accuracy_m (${String(JSON.stringify(value)).slice(0, 60)}) - stored as unknown`);
  return null;
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
// "whatsapp:<phone>" is the device ID of SOS requests filed through the
// WhatsApp webhook, which calls createSosRequest() directly. The public web
// endpoints must never accept it (B39): anyone could open a fake SOS for a
// victim's number, so the victim's REAL location later got "already
// active" (409) and was never stored - and GET /api/sos/device/... handed
// out the location of any WhatsApp user's open SOS. Web IDs are "dev-...".
// "node:<NODE>" (SOS button on a sensor node) is reserved for the same
// reason: a web SOS under that id would make a villager's real button press
// "already active" and never stored.
// "hotspot:<NODE>:<client>" (offline SOS Wi-Fi) likewise.
const RESERVED_DEVICE_PREFIX = /^(whatsapp|node|hotspot):/i;
// What a web client may say about its coordinates. Missing = "gps": the
// classic sos.html and older cached pages only ever send the phone's
// location. "whatsapp" is only set by the webhook itself.
const WEB_LOCATION_SOURCES = new Set(["gps", "manual"]);
const webDeviceIdOk = (id) =>
  typeof id === "string" && DEVICE_ID_PATTERN.test(id) && !RESERVED_DEVICE_PREFIX.test(id);

app.post("/api/sos", (req, res) => {
  const { note, device_id } = req.body;
  if (webDeviceIdOk(device_id) && (sosPerDevice(device_id) || sosPerNetwork(req.ip))) {
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
  if (!webDeviceIdOk(device_id)) {
    return res.status(400).json({ error: "device_id is required (3-100 letters, digits or : . _ -)" });
  }
  if (note != null && typeof note !== "string") {
    return res.status(400).json({ error: "note must be a string" });
  }
  // Refused rather than guessed: storing an unknown value as "gps" would
  // show a hand-placed (approximate) point to officers as a precise fix.
  const locationSource = req.body.location_source ?? "gps";
  if (!WEB_LOCATION_SOURCES.has(locationSource)) {
    return res.status(400).json({ error: "location_source must be \"gps\" or \"manual\"" });
  }
  // Only a device fix has an accuracy; a point set by hand has none (the
  // officer views already mark it as approximate).
  const accuracyM = locationSource === "gps" ? parseLocationAccuracy(req.body.location_accuracy_m) : null;
  const { httpStatus, body } = createSosRequest(
    device_id,
    coords.latitude,
    coords.longitude,
    note ? note.slice(0, MAX_NOTE_LENGTH) : note,
    locationSource,
    accuracyM,
  );
  res.status(httpStatus).json(body);
});

// 5b. Lookup whether a given device currently has an open (unresolved)
// SOS - used by the citizen portal on page load/refresh so it can restore
// the "your SOS is active" state and keep the button locked until an
// officer marks it resolved, instead of allowing a second SOS to be sent.
app.get("/api/sos/device/:device_id", (req, res) => {
  // WhatsApp IDs are phone numbers - never look them up for the public
  // (B39); the WhatsApp user gets their status in the chat instead.
  if (RESERVED_DEVICE_PREFIX.test(req.params.device_id)) {
    return res.json({ active: false });
  }
  const existing = selectOpenSosByDevice.get(req.params.device_id);
  // A legacy row with junk coordinates (pre-B47) is invisible to officers
  // and is closed by the next SOS from this device (createSosRequest), so
  // it must not keep the citizen's SOS button locked as "active".
  if (!existing || !parseCoordinates(existing.latitude, existing.longitude)) {
    return res.json({ active: false });
  }
  res.json({
    active: true,
    sos_id: existing.id,
    ...hospitalFor(existing.latitude, existing.longitude),
  });
});

// 5c. Offline SOS Wi-Fi request forwarded by a gateway (see createHotspotSos).
// Same device key and node scoping as ingestion. Status codes tell the
// gateway what to do with its queued copy: 2xx = delete it (ok / duplicate /
// already_active), 400 = delete it (it can never be accepted), 401/403/429/
// 5xx = keep it and retry later.
// Generous: a whole village may use one hotspot at once. It only stops a
// flood from one compromised gateway; the hotspot has its own per-AP limit.
const hotspotSosPerNode = makeRateLimiter(10 * 60 * 1000, 60);
// key name + node id -> when the "not in the key's node list" line was last
// logged. Emptied when it grows large: a key holder sending made-up node ids
// must not grow it without end (worst case: a few extra log lines).
const sosScopeLogged = new Map();
const SOS_SCOPE_LOG_MAX = 1000;
app.post("/api/ingest/sos", device.requireDeviceKey, (req, res) => {
  const body = req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return res.status(400).json({ error: "body must be one SOS object" });
  }
  const nodeId = body.node_id;
  if (typeof nodeId !== "string" || !NODE_ID_PATTERN.test(nodeId)) {
    return res.status(400).json({ error: "node_id is required (1-64 letters, digits, . _ -)" });
  }
  if (!device.nodeAllowed(req.device, nodeId)) {
    // 403 = the gateway keeps the SOS queued and retries, so a key whose
    // --nodes list lacks the hotspot's id (typically the GATEWAY's own id,
    // which ingestion never needed) silently holds back every SOS from it.
    // Say so loudly, once per key+node per 10 minutes.
    const logKey = `${req.device.name}|${nodeId}`;
    if (!sosScopeLogged.has(logKey) || Date.now() - sosScopeLogged.get(logKey) > 10 * 60 * 1000) {
      if (sosScopeLogged.size >= SOS_SCOPE_LOG_MAX) sosScopeLogged.clear();
      sosScopeLogged.set(logKey, Date.now());
      console.error(`[sos] !!! offline SOS Wi-Fi request from ${nodeId} REFUSED: device key '${req.device.name}' ` +
        `may not report for ${nodeId}. The gateway keeps it queued and retries. Add ${nodeId} to the key's node ` +
        "list (node server/device_keys.js add <name> --nodes ...,<GATEWAY_ID>) - a gateway's key must list its own id " +
        "when its SOS hotspot is on.");
    }
    return res.status(403).json({
      error: `Device key '${req.device.name}' may not report for ${nodeId} - add ${nodeId} to the key's node list`,
    });
  }
  const sosUid = typeof body.sos_uid === "number" && Number.isSafeInteger(body.sos_uid) ? String(body.sos_uid) : body.sos_uid;
  if (typeof sosUid !== "string" || !HOTSPOT_UID_PATTERN.test(sosUid)) {
    return res.status(400).json({ error: "sos_uid is required (1-64 printable characters, no spaces)" });
  }
  const data = device.applyKeyPolicy(req.device, body);
  // A retry of a request already stored is answered without counting
  // against the limit - otherwise a flaky link could lock a hotspot out.
  const key = data.simulated === true ? `sim:${sosUid}` : sosUid;
  const seen = selectHotspotSos.get(nodeId, key);
  if (seen) return res.json({ status: "duplicate", sos_id: seen.sos_id });
  if (hotspotSosPerNode(nodeId)) {
    console.warn(`[sos] offline SOS Wi-Fi at ${nodeId}: rate limit reached - gateway told to retry later`);
    return res.status(429).json({ error: "Too many SOS requests from this hotspot - keep it queued and retry later" });
  }
  try {
    res.json(createHotspotSos(data, nodeId, sosUid));
  } catch (e) {
    console.error(`[sos] !!! offline SOS Wi-Fi request at ${nodeId} could NOT be stored: ${e.message}`);
    res.status(500).json({ error: "SOS could not be stored - keep it queued and retry" });
  }
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

// The node behind a node-button ("node:<NODE>") or offline SOS Wi-Fi
// ("hotspot:<NODE>:<client>") SOS; null for every other channel. Node ids
// never contain ":" (NODE_ID_PATTERN), so the split is unambiguous.
function sosNodeId(r) {
  const id = String(r.device_id || "");
  if (r.location_source === "node") return id.slice(NODE_SOS_PREFIX.length);
  if (r.location_source === "hotspot") return id.slice(HOTSPOT_SOS_PREFIX.length).split(":")[0] || null;
  return null;
}
const sosNeeds = (r) => (r.needs ? String(r.needs).split(",").filter((n) => HOTSPOT_NEEDS.has(n)) : []);

const loggedInvalidSos = new Set();
app.get("/api/sos", requireOfficerAuth, (req, res) => {
  const rows =
    req.query.status === "all"
      ? selectAllSos.all(parseInt(req.query.limit || "200", 10))
      : selectOpenSos.all();

  // A row without real coordinates (only possible from before B47 was
  // fixed - every channel now validates) can't be shown on the map or
  // routed to. It is left out and logged instead of breaking the feed:
  // one bad row used to hide EVERY SOS from the officers.
  const valid = rows.filter((r) => parseCoordinates(r.latitude, r.longitude));
  // Exception: an SOS button press on a node with no registered position
  // (createNodeButtonSos) has no coordinates either, but it is a real
  // person asking for help - listed separately so the officer views show it
  // as a banner instead of a pin.
  // Only OPEN ones are banners; a resolved one (?status=all) is history.
  // The same goes for an offline SOS Wi-Fi request at a gateway/node with no position.
  const isUnlocatedNode = (r) =>
    (r.location_source === "node" || r.location_source === "hotspot") && r.latitude == null && r.longitude == null;
  const unlocatedNodeSos = rows.filter((r) => isUnlocatedNode(r) && r.status === "open");
  for (const r of rows) {
    // An unlocated node SOS, open or resolved, is not "invalid coordinates":
    // it was stored without a position on purpose (createNodeButtonSos).
    if (valid.includes(r) || isUnlocatedNode(r) || loggedInvalidSos.has(r.id)) continue;
    loggedInvalidSos.add(r.id); // once per row, not on every 5 s poll
    console.warn(`[sos] SOS #${r.id} has invalid coordinates (${r.latitude}, ${r.longitude}) - not shown to officers; closed as 'invalid' when that device next files an SOS`);
  }

  const zones = severeHazardZones(); // once per request, not per SOS
  const data = valid.map((r) => {
    const route = hospitalFor(r.latitude, r.longitude, zones);
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
      // "manual" = a point the person placed by hand on a map (approximate);
      // the officer map and queue mark it. "node" = the SOS button on a
      // sensor node (the point is the node's position). null = an SOS from
      // before this was recorded.
      location_source: r.location_source ?? null,
      // metres; above APPROX_LOCATION_M the officer views warn. null = unknown
      location_accuracy_m: r.location_accuracy_m ?? null,
      // which node's SOS button (location_source "node") or whose offline SOS
      // Wi-Fi ("hotspot"); other device ids stay private
      node_id: sosNodeId(r),
      // offline SOS Wi-Fi only (else null / []): people count and needs
      people: r.people ?? null,
      needs: sosNeeds(r),
      escalated,
      minutes_open,
      nearest_hospital: route.hospital,
      hospital_distance_km: route.distance_km,
      hospital_route_url: route.maps_url,
      // why a farther hospital was chosen (nearer one is inside a hazard zone)
      hospital_skipped: route.skipped_hospital,
      hospital_in_hazard_zone: route.hospital_in_hazard_zone,
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
    // rows left out of `data` (no usable coordinates), unlocated node SOS included
    invalid_location_count: rows.length - valid.length,
    unlocated_node_sos: unlocatedNodeSos.map((r) => ({
      id: r.id,
      node_id: sosNodeId(r),
      location_source: r.location_source,
      people: r.people ?? null,
      needs: sosNeeds(r),
      note: r.note,
      status: r.status,
      timestamp: r.timestamp,
      minutes_open: computeEscalation(r.status, r.timestamp).minutes_open,
    })),
    data,
  });
});

// 7. Officer marks an SOS as handled
app.post("/api/sos/:id/resolve", requireOfficerAuth, (req, res) => {
  updateSosStatus.run("resolved", req.params.id);
  res.json({ status: "ok" });
});

// 7b. Bulk-resolve the open SOS requests the officer is looking at - for
// when everything on the board has been handled and they want to clear it
// in one action, rather than clicking "Resolve" on each one individually.
//
// The body MUST list the ids the officer saw ({ ids: [12, 13] }). It used to
// resolve every open row, so an SOS that arrived while the confirm dialog
// was open (it blocks polling) or in the 5 s poll gap was closed unseen and
// the citizen's page said "marked resolved" (B42). A request
// without ids is refused, so an old page (the classic public/officer.html
// still sends no body) cannot clear unseen requests either.
const MAX_RESOLVE_ALL_IDS = 1000; // far above any real board; bounds the loop
const resolveOpenSos = db.prepare(
  "UPDATE sos_requests SET status='resolved' WHERE id=? AND status='open'",
);
app.post("/api/sos/resolve-all", requireOfficerAuth, (req, res) => {
  const ids = req.body?.ids;
  if (
    !Array.isArray(ids) || ids.length === 0 || ids.length > MAX_RESOLVE_ALL_IDS ||
    !ids.every((id) => Number.isSafeInteger(id) && id > 0)
  ) {
    return res.status(400).json({
      error: `ids must be a list of 1-${MAX_RESOLVE_ALL_IDS} SOS ids (the requests shown to the officer)`,
    });
  }
  // One transaction: all or nothing, and only rows that are still open
  // count (a duplicate id or one another officer just resolved adds 0).
  let resolved = 0;
  db.exec("BEGIN");
  try {
    for (const id of new Set(ids)) resolved += Number(resolveOpenSos.run(id).changes);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ status: "ok", resolved_count: resolved });
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
      // severity from the weather forecast (area-wide), not this node's sensors
      forecast_based: r.forecast_based === 1,
      // readings.id of the confirmed alert (CAP XML / PDF / timeline); null while pending
      alert_id: r.status === "alert_dispatched" ? confirmedAlertId(r.node_id, r.hazard_type) : null,
      ...hazardAge(r.timestamp),
      ...confidenceFromRow(r),
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
// Each node also gets its village-siren block (null = no siren reported),
// which this server - not the backend - keeps.
app.get("/api/node-health", requireOfficerAuth, async (req, res) => {
  try {
    const pythonResponse = await axios.get(`${PYTHON_BACKEND_URL}/api/node-health`);
    const health = pythonResponse.data;
    if (health && Array.isArray(health.nodes)) {
      for (const n of health.nodes) {
        if (n && typeof n === "object") n.siren = n.node_id ? sirens.status(String(n.node_id)) : null;
      }
    }
    res.json(health);
  } catch (error) {
    sendPipelineError(res, error);
  }
});

// --- Village siren (officer) ----------------------------------------------
// Officers (and admins) see every node that reported a siren and can sound
// or silence it. The answer is the DESIRED state: the node gets it in its
// next ingest answer ("commands") and the views show "sounding" only once
// the node itself reports it. Every action is audited (siren_audit table +
// log). Works while the AI backend is down - nothing here needs it.
app.get("/api/sirens", requireOfficerAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json({
    auto_severity: sirens.autoSeverity, // "CRITICAL" | "off"
    auto_hazards: sirens.autoHazards, // SIREN_AUTO_HAZARDS (normalised: "gas_leak", "flash_flood", ...)
    default_on_seconds: sirens.defaultOnSeconds,
    sirens: sirens.list(),
  });
});

app.get("/api/nodes/:node_id/siren", requireOfficerAuth, (req, res) => {
  const status = sirens.status(req.params.node_id);
  if (!status) return res.status(404).json({ error: `${req.params.node_id} has never reported a siren` });
  res.set("Cache-Control", "no-store");
  res.json({ siren: status, history: sirens.history(req.params.node_id) });
});

app.post("/api/nodes/:node_id/siren", requireOfficerAuth, (req, res) => {
  const nodeId = req.params.node_id;
  if (!NODE_ID_PATTERN.test(nodeId)) return res.status(400).json({ error: "invalid node id" });
  const action = req.body?.action;
  if (action !== "on" && action !== "off") {
    return res.status(400).json({ error: "action must be \"on\" or \"off\"" });
  }
  const forS = req.body?.for_s;
  if (forS != null && (action !== "on" || !Number.isInteger(forS) || forS < siren.MIN_ON_SECONDS || forS > siren.MAX_ON_SECONDS)) {
    return res.status(400).json({
      error: `for_s (only with "on") must be ${siren.MIN_ON_SECONDS}-${siren.MAX_ON_SECONDS} whole seconds`,
    });
  }
  const { status, body } = sirens.officerAction(nodeId, action, forS ?? null, req.user.username);
  res.status(status).json(body);
});

// Node registry (admin page). Admin role only: a node's coordinates, land
// use and upstream link change what the flood model and the public map
// trust. The Python admin API only accepts OFFICER_API_KEY, which is added
// HERE on the server - it never reaches the browser.
const ADMIN_NODE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/; // same rule as backend_server.check_node_id

function adminBackendHeaders(res, feature = "Node management") {
  if (OFFICER_API_KEY) return { "X-API-Key": OFFICER_API_KEY };
  res.status(503).json({
    error: `${feature} is switched off: set OFFICER_API_KEY in .env and restart both servers.`,
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
  // A 401 here is about the SERVER's key, not the admin's session - passed
  // through, it bounced the admin between /admin.html and /login.html
  // forever (B53).
  if (upstreamAuthRejected(error)) {
    return res.status(502).json({ error: UPSTREAM_AUTH_MESSAGE });
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

// Model card (admin page): the honest evaluation report that
// ml/evaluate_models.py writes and the Python backend serves with the same
// OFFICER_API_KEY as the node registry. Admin-only for the same reason the
// backend gives: it is an engineering report on SYNTHETIC data, and a
// number lifted out of it without the card's own banner reads like field
// accuracy. Passed through unchanged - the page renders the banner and
// provenance next to every figure.
app.get("/api/admin/model-card", auth.requireAdmin, async (req, res) => {
  const headers = adminBackendHeaders(res, "The model card");
  if (!headers) return;
  try {
    const pythonResponse = await axios.get(`${PYTHON_BACKEND_URL}/api/model-card`, { headers });
    const card = pythonResponse.data;
    // A proxy or an old backend answering 200 with something else must not
    // render as an empty card that looks like "no models".
    if (!card || typeof card !== "object" || !Array.isArray(card.models)) {
      return res.status(502).json({ error: "The AI backend sent something that is not a model card - restart backend_server.py." });
    }
    res.set("Cache-Control", "no-store");
    res.json(card);
  } catch (error) {
    // FastAPI's own "Not Found" means a backend from before the model card
    // existed; the card's 404 instead says how to generate it. Telling the
    // two apart saves the admin re-running the script for nothing.
    const detail = error.response && error.response.data && error.response.data.detail;
    if (error.response && error.response.status === 404 && detail === "Not Found") {
      return res.status(502).json({
        error: "This AI backend has no model card endpoint - update and restart backend_server.py.",
      });
    }
    sendAdminError(res, error);
  }
});

// --- Officer analytics, reports and risk-map data (step W1) --------------
// Officer/admin-only proxies to the AI backend's analytics and report
// endpoints. Same rules as the proxies above: OFFICER_API_KEY is added here
// (never in the browser), a backend that is down answers 502 JSON, one that
// hangs answers 504 after ANALYTICS_TIMEOUT_MS, and the backend's own
// 401/403 (a key mismatch between the two servers) becomes 502, never a 401
// that would bounce the officer to the login page (B53).
const ANALYTICS_TIMEOUT_MS =
  Math.max(100, parseInt(process.env.SANJEEVNI_ANALYTICS_TIMEOUT_MS || "15000", 10) || 15000);
const TREND_RANGES = new Set(["24h", "7d", "30d"]);
const SUMMARY_RANGES = new Set(["7d", "30d"]);
const HOTSPOT_RANGE_DAYS = { "7d": 7, "30d": 30 };
const ALERT_ID_PATTERN = /^[1-9][0-9]{0,11}$/; // a readings.id

function backendGet(urlPath, { params, responseType = "json" } = {}) {
  return axios.get(`${PYTHON_BACKEND_URL}${urlPath}`, {
    params,
    responseType,
    timeout: ANALYTICS_TIMEOUT_MS,
    maxRedirects: 0, // the backend is on loopback; never follow it anywhere else
    headers: OFFICER_API_KEY ? { "X-API-Key": OFFICER_API_KEY } : undefined,
  });
}

/** One query value from a fixed set; `fallback` when absent; null when invalid. */
function queryChoice(value, allowed, fallback) {
  if (value === undefined) return fallback;
  return typeof value === "string" && allowed.has(value) ? value : null;
}

// The FastAPI error text, also from a text/binary (XML, PDF) response.
function upstreamDetail(error) {
  let data = error.response && error.response.data;
  if (data instanceof ArrayBuffer || Buffer.isBuffer(data)) data = Buffer.from(data).toString("utf8");
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return data.slice(0, 300) || null;
    }
  }
  const detail = data && data.detail;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((d) => d && d.msg).filter(Boolean).join("; ") || null;
  return null;
}

function sendProxyError(res, error, what) {
  if (!error.response) {
    const timedOut = error.code === "ECONNABORTED" || error.code === "ETIMEDOUT" || /timeout/i.test(error.message || "");
    console.error(`[proxy] ${what}: AI backend ${timedOut ? "timed out" : "unreachable"} - ${error.message}`);
    return timedOut
      ? res.status(504).json({ error: `The AI backend took too long to answer (${what}) - try again.`, code: "backend_timeout" })
      : res.status(502).json({
          error: `Can't reach the AI backend for ${what} - start backend_server.py, then try again.`,
          code: "backend_unreachable",
        });
  }
  if (upstreamAuthRejected(error)) return res.status(502).json({ error: UPSTREAM_AUTH_MESSAGE, code: "backend_auth" });
  const status = error.response.status;
  const detail = upstreamDetail(error);
  // FastAPI's bare "Not Found" = a backend from before this endpoint existed
  if (status === 404 && detail === "Not Found") {
    return res.status(502).json({
      error: `This AI backend has no endpoint for ${what} yet - update and restart backend_server.py.`,
      code: "backend_outdated",
    });
  }
  if (status >= 400 && status < 500) return res.status(status).json({ error: detail || `Request failed (HTTP ${status})` });
  console.error(`[proxy] ${what}: AI backend answered HTTP ${status}${detail ? ` - ${detail}` : ""}`);
  res.status(502).json({ error: `The AI backend failed on ${what} (HTTP ${status}).`, code: "backend_error" });
}

// Hotspots = where hazards keep coming back, as per-node, per-day counts.
//   intensity = (elevated readings + half the MEDIUM ones) / readings
// Elevated = a CONFIRMED (alert_dispatched) HIGH/CRITICAL alert assessed
// from the node's OWN sensors. Review 2026-10-09: the backend's
// /api/analytics/heatmap counts every row's severity - pending (unconfirmed)
// rows and FORECAST-only heavy_rain / high_wind alerts too, which the
// backend raises at EVERY node in the forecast area, so one regional rain
// forecast made every node a hotspot (and disagreed with the district
// summary's top_hotspots, analytics.py HOTSPOT_BASIS). So the counts are
// read here from the shared readings table (as latestNodeValues does),
// with the same exclusions as analytics.py: forecast-only rows
// (severity_source 'weather_forecast' or confirmation 'forecast') are never
// "elevated", and suppressed (sensor fault, raw values) / untimed (time
// unknown) / rejected rows are not counted as readings. Only when that
// query cannot run (a database from before those columns) does it fall
// back to the backend's endpoint, and the note says what that counts.
// The 0.1 / 0.3 class edges are a project choice for the demo (no official
// standard exists for this) - tune them with real deployment data.
//
// THE HOTSPOT DEFINITION (kept stable on purpose - 2026-10-09): the
// backend's district summary (analytics.py, summary.top_hotspots) is being
// aligned to THIS map definition, so changing any of it needs the same
// change there and in the frontend text (components/RiskLayers.tsx):
//   per node over the last `days` UTC calendar days (7 or 30)
//   readings  = every stored reading except suppressed / untimed /
//               rejected / duplicate / error rows (simulated ones included)
//   elevated  = status 'alert_dispatched' (confirmed), severity HIGH or
//               CRITICAL, and NOT forecast-only (severity_source
//               'weather_forecast' / confirmation 'forecast')
//   medium    = the same, at severity MEDIUM
//   intensity = min(1, (elevated + 0.5 * medium) / readings)
//   level     = high >= 0.3, moderate >= 0.1, else low (HOTSPOT_LEVEL_EDGES)
//   order     = intensity, then elevated count, then node id
// The answer carries it in words as `definition` (+ `basis`).
const HOTSPOT_LEVEL_EDGES = { moderate: 0.1, high: 0.3 };
const HOTSPOT_DEFINITION =
  "A hotspot is a node where hazards keep coming back. Intensity = (confirmed HIGH or CRITICAL alert readings " +
  "+ half the confirmed MEDIUM ones) / all readings the node sent in the window; High from 30 %, Moderate from 10 % " +
  "(project thresholds, not an official standard).";
const HOTSPOT_BASIS =
  "Elevated = a confirmed HIGH or CRITICAL alert from the node's own sensors; MEDIUM counts half. " +
  "Area-wide weather-forecast alerts (heavy rain, high wind) and unconfirmed alerts are not counted.";
const HOTSPOT_DATA_NOTE =
  "Counts every stored reading in the window, simulated (demo) readings included. Nodes report more often " +
  "while a hazard is elevated, so the share of elevated readings overstates the share of time spent " +
  "elevated. Use it to compare places, not as a probability.";
const HOTSPOT_FALLBACK_BASIS =
  "Elevated = any HIGH or CRITICAL reading (MEDIUM counts half), unconfirmed alerts included, and area-wide " +
  "weather-forecast alerts too - they are raised at every node in the forecast area and inflate every node.";
const HOTSPOT_FALLBACK_NOTE =
  "Counted by the AI backend from every stored reading, simulated (demo) readings included: this database " +
  "has no forecast / confirmation columns yet (restart backend_server.py to add them). " + HOTSPOT_FALLBACK_BASIS;
const FORECAST_ROW_SQL =
  "(COALESCE(severity_source, '') = 'weather_forecast' OR COALESCE(confirmation, '') = 'forecast')";
const NOT_A_READING_SQL = "COALESCE(status, '') IN ('suppressed', 'untimed', 'rejected', 'duplicate', 'error')";
let selectHotspotDays = null;

/** Per-node, per-day hotspot counts from the shared readings table; throws if the table / columns are missing. */
function hotspotDayRows(fromDay) {
  selectHotspotDays ??= db.prepare(`
    SELECT node_id, substr(timestamp, 1, 10) AS day, COUNT(*) AS reading_count,
      SUM(CASE WHEN status = 'alert_dispatched' AND NOT ${FORECAST_ROW_SQL}
               AND severity IN ('HIGH', 'CRITICAL') THEN 1 ELSE 0 END) AS high_count,
      SUM(CASE WHEN status = 'alert_dispatched' AND NOT ${FORECAST_ROW_SQL}
               AND severity = 'MEDIUM' THEN 1 ELSE 0 END) AS medium_count,
      SUM(CASE WHEN ${FORECAST_ROW_SQL} AND status IN ('alert_dispatched', 'pending_confirmation')
               THEN 1 ELSE 0 END) AS forecast_alert_count,
      SUM(CASE WHEN COALESCE(simulated, 0) = 1 THEN 1 ELSE 0 END) AS simulated_count,
      MAX(CASE WHEN NOT ${FORECAST_ROW_SQL} THEN risk_score END) AS max_risk_score
    FROM readings
    WHERE timestamp >= ? AND NOT ${NOT_A_READING_SQL}
    GROUP BY node_id, day`);
  // "timestamp >= 'YYYY-MM-DD'" can use the backend's timestamp index; the
  // exact day cut is aggregateHotspots' (the same substr day as the backend)
  return selectHotspotDays.all(fromDay).map((r) => {
    const info = nodeInfo(r.node_id);
    return { ...r, location: info?.location ?? r.node_id, latitude: info?.latitude ?? null, longitude: info?.longitude ?? null };
  });
}

function hotspotWindowStart(days, now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)))
    .toISOString().slice(0, 10);
}

function aggregateHotspots(rows, days, now = new Date()) {
  const from = hotspotWindowStart(days, now);
  const kept = rows.filter((r) => r && typeof r.day === "string" && r.day >= from && typeof r.node_id === "string");
  const byNode = new Map();
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  for (const r of kept) {
    let h = byNode.get(r.node_id);
    if (!h) {
      h = { node_id: r.node_id, location: r.location ?? r.node_id, latitude: null, longitude: null,
            reading_count: 0, high_count: 0, medium_count: 0, max_risk_score: null, days_reported: 0, days_with_high: 0 };
      byNode.set(r.node_id, h);
    }
    // the registry position the backend attached (latest row wins - same node)
    if (typeof r.latitude === "number" && typeof r.longitude === "number") {
      h.latitude = r.latitude;
      h.longitude = r.longitude;
    }
    h.reading_count += num(r.reading_count);
    h.high_count += num(r.high_count);
    h.medium_count += num(r.medium_count);
    h.days_reported += 1;
    if (num(r.high_count) > 0) h.days_with_high += 1;
    if (typeof r.max_risk_score === "number" && Number.isFinite(r.max_risk_score)) {
      h.max_risk_score = h.max_risk_score == null ? r.max_risk_score : Math.max(h.max_risk_score, r.max_risk_score);
    }
  }
  const hotspots = [...byNode.values()].map((h) => {
    const intensity = h.reading_count > 0 ? Math.min(1, (h.high_count + 0.5 * h.medium_count) / h.reading_count) : 0;
    const level = intensity >= HOTSPOT_LEVEL_EDGES.high ? "high" : intensity >= HOTSPOT_LEVEL_EDGES.moderate ? "moderate" : "low";
    return { ...h, intensity: Math.round(intensity * 1000) / 1000, level };
  });
  hotspots.sort((a, b) => b.intensity - a.intensity || b.high_count - a.high_count || a.node_id.localeCompare(b.node_id));
  return { from_day: from, rows: kept, hotspots };
}

app.get("/api/officer/heatmap", requireOfficerAuth, async (req, res) => {
  const range = queryChoice(req.query.range, new Set(Object.keys(HOTSPOT_RANGE_DAYS)), "30d");
  if (!range) return res.status(400).json({ error: "range must be 7d or 30d" });
  try {
    let rows;
    let source = "readings";
    try {
      rows = hotspotDayRows(hotspotWindowStart(HOTSPOT_RANGE_DAYS[range]));
    } catch (e) {
      // no readings table yet, or one without the forecast / confirmation
      // columns: the backend's own (unfiltered) counts, labelled as such
      console.warn(`[hotspots] shared readings table not usable (${e.message}) - using the AI backend's heatmap`);
      source = "backend";
      const upstream = await backendGet("/api/analytics/heatmap");
      rows = upstream.data && upstream.data.heatmap_data;
    }
    if (!Array.isArray(rows)) {
      return res.status(502).json({ error: "The AI backend sent something that is not heatmap data.", code: "backend_error" });
    }
    const { from_day, rows: kept, hotspots } = aggregateHotspots(rows, HOTSPOT_RANGE_DAYS[range]);
    res.set("Cache-Control", "no-store");
    res.json({
      range,
      days: HOTSPOT_RANGE_DAYS[range],
      from_day, // UTC calendar day the window starts on
      generated_at: new Date().toISOString(),
      source, // "readings": measured + confirmed only | "backend": fallback, every row counted
      definition: HOTSPOT_DEFINITION, // the stable definition above, in words
      basis: source === "readings" ? HOTSPOT_BASIS : HOTSPOT_FALLBACK_BASIS,
      data_note: source === "readings" ? HOTSPOT_DATA_NOTE : HOTSPOT_FALLBACK_NOTE,
      level_edges: HOTSPOT_LEVEL_EDGES,
      hotspots,
      heatmap_data: kept, // the per-node, per-day rows inside the window
    });
  } catch (error) {
    sendProxyError(res, error, "the hotspot map");
  }
});

app.get("/api/officer/trends", requireOfficerAuth, async (req, res) => {
  const nodeId = req.query.node_id;
  if (typeof nodeId !== "string" || !ADMIN_NODE_ID.test(nodeId)) {
    return res.status(400).json({ error: "node_id is required (1-12 letters, digits, - or _)" });
  }
  const range = queryChoice(req.query.range, TREND_RANGES, "24h");
  if (!range) return res.status(400).json({ error: "range must be 24h, 7d or 30d" });
  try {
    const upstream = await backendGet("/api/analytics/trends", { params: { node_id: nodeId, range } });
    res.set("Cache-Control", "no-store");
    res.json(upstream.data);
  } catch (error) {
    sendProxyError(res, error, "trends");
  }
});

app.get("/api/officer/summary", requireOfficerAuth, async (req, res) => {
  const range = queryChoice(req.query.range, SUMMARY_RANGES, "7d");
  if (!range) return res.status(400).json({ error: "range must be 7d or 30d" });
  try {
    const upstream = await backendGet("/api/analytics/summary", { params: { range } });
    res.set("Cache-Control", "no-store");
    res.json(upstream.data);
  } catch (error) {
    sendProxyError(res, error, "the analytics summary");
  }
});

app.get("/api/officer/alerts/:id/cap", requireOfficerAuth, async (req, res) => {
  if (!ALERT_ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: "alert id must be a positive whole number" });
  try {
    const upstream = await backendGet(`/api/alerts/${req.params.id}/cap`, { responseType: "text" });
    res.set("Cache-Control", "no-store");
    res.type("application/xml").send(upstream.data);
  } catch (error) {
    sendProxyError(res, error, "the CAP export");
  }
});

app.get("/api/officer/alerts/:id/report.pdf", requireOfficerAuth, async (req, res) => {
  if (!ALERT_ID_PATTERN.test(req.params.id)) return res.status(400).json({ error: "alert id must be a positive whole number" });
  try {
    const upstream = await backendGet(`/api/reports/${req.params.id}/pdf`, { responseType: "arraybuffer" });
    res.set({
      "Cache-Control": "no-store",
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="sanjeevni_situation_report_${req.params.id}.pdf"`,
    });
    res.send(Buffer.from(upstream.data));
  } catch (error) {
    sendProxyError(res, error, "the situation report");
  }
});

app.get("/api/officer/timeline/:node_id", requireOfficerAuth, async (req, res) => {
  const nodeId = req.params.node_id;
  if (!ADMIN_NODE_ID.test(nodeId)) return res.status(400).json({ error: "invalid node id" });
  const params = {};
  if (req.query.around_id !== undefined) {
    if (typeof req.query.around_id !== "string" || !ALERT_ID_PATTERN.test(req.query.around_id)) {
      return res.status(400).json({ error: "around_id must be a positive whole number" });
    }
    params.around_id = req.query.around_id;
  }
  if (req.query.window !== undefined) {
    const w = Number(req.query.window);
    if (!Number.isInteger(w) || w < 1 || w > 500) return res.status(400).json({ error: "window must be 1-500" });
    params.window = w;
  }
  try {
    const upstream = await backendGet(`/api/events/${encodeURIComponent(nodeId)}/timeline`, { params });
    res.set("Cache-Control", "no-store");
    res.json(upstream.data);
  } catch (error) {
    sendProxyError(res, error, "the event timeline");
  }
});

// Latest value of every sensor a node has, for the officer map's node popup
// and side panel. Read straight from the readings table the AI backend
// writes (the same shared sanjeevni.db nodeInfo() reads), so it works while
// the backend is down. Only these fields leave the server - never the
// whole row. Per field:
//   ok            - in the newest reading
//   fault         - dropped as physically impossible (sensor_faults)
//   not_in_latest - missing now, but reported recently (last_value/last_at)
//   no_sensor     - not in any recent reading: no such sensor fitted
// "Newest" is by reading time, not row id: a store-and-forward backlog
// arrives after live readings. "untimed" backlog rows (time unknown) and
// rejected/duplicate ones are skipped.
const NODE_VALUE_FIELDS = [
  "river_level_m", "river_level_rate_m_per_hr", "temp_c", "humidity_pct", "gas_ppm", "flame_reading",
  "pm25_ugm3", "pm10_ugm3", "tilt_angle_deg", "vibration_magnitude", "soil_moisture_pct",
  "water_ph", "turbidity_ntu", "rainfall_24h_mm", "battery_pct", "signal_strength_dbm",
];
const RECENT_READINGS_FOR_VALUES = 20;
const SKIPPED_VALUE_STATUSES = new Set(["untimed", "rejected", "duplicate", "error"]);
let selectRecentReadings = null;

function latestNodeValues(nodeId) {
  let rows = [];
  try {
    // Newest by READING time in SQL (review 2026-10-09): picking the 20
    // newest ids first and sorting them afterwards showed an old reading as
    // "latest" when a backlog of 20+ old readings arrived after the live
    // one. julianday() compares instants (any UTC offset, fractional
    // seconds); an unparsable time sorts last.
    selectRecentReadings ??= db.prepare(
      "SELECT * FROM readings WHERE node_id = ? " +
      `AND COALESCE(status, '') NOT IN (${[...SKIPPED_VALUE_STATUSES].map((s) => `'${s}'`).join(", ")}) ` +
      "ORDER BY julianday(timestamp) DESC, id DESC LIMIT ?",
    );
    rows = selectRecentReadings.all(nodeId, RECENT_READINGS_FOR_VALUES);
  } catch {
    rows = []; // backend not started yet -> no readings table yet
  }
  const timeOf = (r) => {
    const t = Date.parse(r.timestamp);
    return Number.isFinite(t) ? t : -Infinity;
  };
  const usable = rows.filter((r) => !SKIPPED_VALUE_STATUSES.has(r.status)).sort((a, b) => timeOf(b) - timeOf(a) || b.id - a.id);
  const latest = usable[0];
  if (!latest) return null;
  const finite = (v) => typeof v === "number" && Number.isFinite(v);
  const faults = new Set(String(latest.sensor_faults || "").split(",").map((s) => s.trim()).filter(Boolean));
  const values = {};
  for (const field of NODE_VALUE_FIELDS) {
    if (finite(latest[field])) {
      values[field] = { value: latest[field], state: "ok" };
      continue;
    }
    const earlier = usable.find((r) => finite(r[field]));
    const last = earlier ? { last_value: earlier[field], last_at: earlier.timestamp } : {};
    values[field] = faults.has(field) ? { value: null, state: "fault", ...last }
      : earlier ? { value: null, state: "not_in_latest", ...last }
      : { value: null, state: "no_sensor" };
  }
  return {
    reading_id: latest.id,
    reading_at: latest.timestamp || null,
    simulated: latest.simulated === 1,
    link: latest.link || null,
    hazard_type: latest.hazard_type || null,
    severity: latest.severity || null,
    status: latest.status || null,
    sensor_faults: [...faults],
    edge_anomaly: String(latest.edge_anomaly || "").split(",").map((s) => s.trim()).filter(Boolean),
    values,
  };
}

app.get("/api/officer/nodes/:node_id/latest", requireOfficerAuth, (req, res) => {
  const nodeId = req.params.node_id;
  if (!ADMIN_NODE_ID.test(nodeId)) return res.status(400).json({ error: "invalid node id" });
  let siren = null;
  try {
    siren = sirens.status(nodeId);
  } catch (e) {
    console.error(`[siren] status for ${nodeId} failed: ${e.message}`);
  }
  const info = nodeInfo(nodeId);
  res.set("Cache-Control", "no-store");
  res.json({ node_id: nodeId, location: info ? info.location : null, latest: latestNodeValues(nodeId), siren });
});

// --- Public CAP (confirmed alerts only) -------------------------------------
// Anyone may fetch these, like a SACHET-style feed reader. Confirmed means
// the backend dispatched it (status "alert_dispatched"); this server checks
// that itself in the shared database before asking the backend, so a
// pending or logged reading id is a 404 even if the backend changes. A
// simulated alert comes out with CAP <status>Exercise</status> (cap_alert.py).
let selectAlertStatus = null;
function isConfirmedAlert(id) {
  try {
    selectAlertStatus ??= db.prepare("SELECT status FROM readings WHERE id = ?");
    const row = selectAlertStatus.get(Number(id));
    return !!row && row.status === "alert_dispatched";
  } catch {
    return false;
  }
}

// --- Confirmed alerts by id (step W2) ----------------------------------------
// The dashboard table (sensor_data) has no link to the backend's readings
// row, but CAP XML, the PDF situation report and the timeline are all keyed
// by readings.id. Both are written for the same AI result, so the newest
// CONFIRMED readings row for that node + hazard type is the alert behind a
// confirmed hazard card / zone. Read from the shared database (like
// latestNodeValues), so it costs no backend call; null when the backend
// has not created its table yet or the row is gone.
let selectLatestConfirmedAlert = null;
function confirmedAlertId(nodeId, hazardType) {
  if (!nodeId || !hazardType) return null;
  try {
    selectLatestConfirmedAlert ??= db.prepare(
      "SELECT id FROM readings WHERE node_id = ? AND hazard_type = ? AND status = 'alert_dispatched' " +
      "ORDER BY id DESC LIMIT 1",
    );
    const row = selectLatestConfirmedAlert.get(nodeId, hazardType);
    return row ? row.id : null;
  } catch {
    return null;
  }
}

// GET /api/officer/alerts?node_id=&range=24h|7d|30d&limit=1..200
// Confirmed (dispatched) alerts, newest first, for the trends page's alert
// list and its CAP / PDF / timeline buttons. Only these fields leave the
// server. The time filter runs here on the parsed timestamp (the backend's
// timestamp text format is not guaranteed to sort as a string).
const ALERT_LIST_RANGE_MS = { "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const ALERT_LIST_SCAN = 2000; // newest confirmed rows looked at per request
let selectConfirmedAlerts = null;
let selectConfirmedAlertsForNode = null;

app.get("/api/officer/alerts", requireOfficerAuth, (req, res) => {
  const nodeId = req.query.node_id;
  if (nodeId !== undefined && (typeof nodeId !== "string" || !ADMIN_NODE_ID.test(nodeId))) {
    return res.status(400).json({ error: "invalid node id" });
  }
  const range = queryChoice(req.query.range, TREND_RANGES, "7d");
  if (!range) return res.status(400).json({ error: "range must be 24h, 7d or 30d" });
  let limit = 50;
  if (req.query.limit !== undefined) {
    limit = Number(req.query.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return res.status(400).json({ error: "limit must be 1-200" });
  }
  let rows = [];
  try {
    const cols = "id, node_id, timestamp, hazard_type, severity, risk_score, simulated";
    if (nodeId) {
      selectConfirmedAlertsForNode ??= db.prepare(
        `SELECT ${cols} FROM readings WHERE status = 'alert_dispatched' AND node_id = ? ORDER BY id DESC LIMIT ?`);
      rows = selectConfirmedAlertsForNode.all(nodeId, ALERT_LIST_SCAN);
    } else {
      selectConfirmedAlerts ??= db.prepare(
        `SELECT ${cols} FROM readings WHERE status = 'alert_dispatched' ORDER BY id DESC LIMIT ?`);
      rows = selectConfirmedAlerts.all(ALERT_LIST_SCAN);
    }
  } catch {
    rows = []; // backend not started yet -> no readings table
  }
  const since = Date.now() - ALERT_LIST_RANGE_MS[range];
  const alerts = rows
    .map((r) => ({ ...r, t: Date.parse(r.timestamp) }))
    .filter((r) => Number.isFinite(r.t) && r.t >= since)
    .sort((a, b) => b.t - a.t || b.id - a.id)
    .slice(0, limit)
    .map((r) => {
      const info = nodeInfo(r.node_id);
      return {
        id: r.id,
        node_id: r.node_id,
        location: (info && info.location) || r.node_id,
        timestamp: r.timestamp,
        hazard_type: r.hazard_type,
        severity: r.severity,
        risk_score: typeof r.risk_score === "number" ? r.risk_score : null,
        simulated: r.simulated === 1,
      };
    });
  res.set("Cache-Control", "no-store");
  res.json({ range, node_id: nodeId ?? null, generated_at: new Date().toISOString(), count: alerts.length, alerts });
});

//
// These routes are public and unauthenticated, and the AI backend is the
// ingest bottleneck (tools/loadtest: a few readings/s on one core), so
// anonymous polling must not compete with alert ingestion for its CPU
// (review 2026-10-09):
//  - each answer is kept in memory for CAP_CACHE_MS (30 s default,
//    SANJEEVNI_CAP_CACHE_MS; 0 = off). A feed reader polling every minute
//    and a crowd opening the same alert cost ONE backend call per 30 s;
//    concurrent misses for the same URL share one backend request;
//  - a request that would reach the backend (a cache miss) is limited to
//    CAP_MISSES_PER_MIN per network (req.ip). Cache hits are never limited,
//    so many phones behind one mobile-carrier NAT still get the feed.
// Errors are never cached. Demo defaults, not from a standard.
const CAP_CACHE_MS = (() => {
  const v = Number(process.env.SANJEEVNI_CAP_CACHE_MS ?? 30_000);
  return Number.isFinite(v) && v >= 0 ? Math.min(v, 10 * 60_000) : 30_000;
})();
const CAP_MISSES_PER_MIN = 30;
const CAP_CACHE_MAX_ENTRIES = 500;
const capMissesPerNetwork = makeRateLimiter(60_000, CAP_MISSES_PER_MIN);
const capCache = new Map(); // backend path -> { at, body } | { pending: Promise }

async function cachedCapGet(req, res, backendPath, contentType, what) {
  const now = Date.now();
  const hit = capCache.get(backendPath);
  let body;
  if (hit && hit.body !== undefined && now - hit.at < CAP_CACHE_MS) {
    body = hit.body;
  } else {
    try {
      if (hit && hit.pending) {
        body = await hit.pending;
      } else {
        if (capMissesPerNetwork(req.ip)) {
          res.set("Retry-After", "60");
          return res.status(429).json({ error: "Too many CAP requests from this network - try again in a minute.",
            code: "rate_limited" });
        }
        const pending = backendGet(backendPath, { responseType: "text" }).then((r) => r.data);
        capCache.set(backendPath, { pending });
        try {
          body = await pending;
        } catch (error) {
          capCache.delete(backendPath); // never cache an error
          throw error;
        }
        if (CAP_CACHE_MS > 0) {
          if (capCache.size > CAP_CACHE_MAX_ENTRIES) {
            for (const [k, e] of capCache) if (e.body !== undefined && now - e.at >= CAP_CACHE_MS) capCache.delete(k);
            if (capCache.size > CAP_CACHE_MAX_ENTRIES) capCache.clear();
          }
          capCache.set(backendPath, { at: Date.now(), body });
        } else {
          capCache.delete(backendPath);
        }
      }
    } catch (error) {
      return sendProxyError(res, error, what);
    }
  }
  res.set("Cache-Control", "public, max-age=60");
  res.type(contentType).send(body);
}

app.get(/^\/cap\/alerts\/([1-9][0-9]{0,11})\.xml$/, (req, res) => {
  const id = req.params[0];
  if (!isConfirmedAlert(id)) return res.status(404).json({ error: "No confirmed alert with that id" });
  return cachedCapGet(req, res, `/api/alerts/${id}/cap`, "application/xml", "the CAP alert");
});

app.get("/cap/feed.atom", (req, res) =>
  cachedCapGet(req, res, "/api/cap/feed.atom", "application/atom+xml", "the CAP feed"));

// 9. Active hazards, numbered, for the dashboard list - location, AI risk
// score, and a plain-language prediction of when it may reach critical level,
// based on the eta_minutes/predicted_time the AI backend already computed.
app.get("/api/hazards", (req, res) => {
  const rows = selectActiveHazards.all();

  const hazards = rows.map((r, i) => {
    const age = hazardAge(r.timestamp);
    return {
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
      // severity from the weather forecast (area-wide), not this node's sensors
      forecast_based: r.forecast_based === 1,
      // readings.id of this confirmed alert: public CAP XML at /cap/alerts/<id>.xml
      alert_id: confirmedAlertId(r.node_id, r.hazard_type),
      ...age,
      prediction_text: age.stale
        ? "No recent reading from this node - last known state only"
        : etaText(r.hazard_type, r.severity, r.eta_minutes, r.predicted_time),
      // Shown next to the severity, never used to re-order the list: the
      // most severe hazard stays on top even when it is the least certain.
      ...confidenceFromRow(r),
    };
  });

  res.json({ success: true, count: hazards.length, hazards });
});

// --- UPGRADE: crowdsourced hazard reports (citizen-submitted, with photo) ---
// Public endpoint - any citizen can submit, no auth (same philosophy as
// SOS submission: reporting a hazard should never be gated behind a login).
// No page sends reports yet (API only); kept for the planned citizen
// report form, but locked down because it is public (B38):
//  - photos must BE a JPEG, PNG or WebP (checked on the decoded bytes, not
//    on what the client claims) - an .html/.svg/.js "photo" used to be
//    saved and served from this origin, i.e. stored XSS
//  - at most CITIZEN_PHOTO_MAX_BYTES per photo, and all photos together at
//    most CITIZEN_UPLOADS_MAX_MB (default 500) so the disk can't be filled
const MAX_REPORT_DESCRIPTION = 1000;
const CITIZEN_UPLOADS_QUOTA_BYTES =
  (parseInt(process.env.CITIZEN_UPLOADS_MAX_MB || "500", 10) || 500) * 1024 * 1024;
let citizenUploadsBytes = 0;
try {
  for (const f of fs.readdirSync(CITIZEN_UPLOADS_DIR)) {
    citizenUploadsBytes += fs.statSync(path.join(CITIZEN_UPLOADS_DIR, f)).size;
  }
} catch (e) {
  console.warn("[citizen-reports] could not measure citizen_uploads/:", e.message);
}

// Magic bytes of the three accepted formats -> file extension.
function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (bytes.length >= 12 && bytes.toString("latin1", 0, 4) === "RIFF" && bytes.toString("latin1", 8, 12) === "WEBP") return "webp";
  return null;
}
const DECLARED_IMAGE_EXT = { jpeg: "jpg", jpg: "jpg", png: "png", webp: "webp" };

// photo_base64: a data URL ("data:image/jpeg;base64,...") or raw base64.
// Returns { bytes, ext } or { status, error }.
function decodeCitizenPhoto(photoBase64) {
  const matches = photoBase64.match(/^data:image\/([A-Za-z0-9.+-]+);base64,(.+)$/s);
  const declared = matches ? DECLARED_IMAGE_EXT[matches[1].toLowerCase()] : null;
  if (matches && !declared) {
    return { status: 400, error: "photo must be a JPEG, PNG or WebP image" };
  }
  const bytes = Buffer.from(matches ? matches[2] : photoBase64, "base64");
  if (bytes.length > CITIZEN_PHOTO_MAX_BYTES) {
    return { status: 413, error: `photo is too large (max ${CITIZEN_PHOTO_MAX_BYTES >> 20} MB)` };
  }
  const ext = sniffImageType(bytes);
  if (!ext || (declared && declared !== ext)) {
    return { status: 400, error: "photo must be a JPEG, PNG or WebP image" };
  }
  return { bytes, ext };
}

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
  if (description != null && typeof description !== "string") {
    return res.status(400).json({ error: "description must be a string" });
  }
  if (photo_base64 != null && typeof photo_base64 !== "string") {
    return res.status(400).json({ error: "photo_base64 must be a string" });
  }

  let photo = null;
  if (photo_base64) {
    photo = decodeCitizenPhoto(photo_base64);
    if (photo.error) return res.status(photo.status).json({ error: photo.error });
  }

  let photoPath = null;
  if (photo) {
    if (citizenUploadsBytes + photo.bytes.length > CITIZEN_UPLOADS_QUOTA_BYTES) {
      // A full disk would break SQLite writes and backups for EVERYTHING
      // (SOS included), so photos stop at the quota; the report is kept.
      console.error(`[citizen-reports] upload quota (${CITIZEN_UPLOADS_QUOTA_BYTES >> 20} MB) reached - photo not saved`);
    } else {
      try {
        // Server-chosen name and extension: nothing from the client
        // reaches the file name any more (B38).
        const filename = `report_${Date.now()}_${crypto.randomBytes(4).toString("hex")}.${photo.ext}`;
        fs.writeFileSync(path.join(CITIZEN_UPLOADS_DIR, filename), photo.bytes);
        citizenUploadsBytes += photo.bytes.length;
        photoPath = `/citizen_uploads/${filename}`;
      } catch (e) {
        console.error("Failed to save citizen report photo:", e.message);
        // Continue without the photo rather than failing the whole report -
        // the location + description are still valuable without it.
      }
    }
  }

  const timestamp = new Date().toISOString();
  const result = insertCitizenReport.run(
    latitude,
    longitude,
    description ? description.slice(0, MAX_REPORT_DESCRIPTION) : null,
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
  let backupPath;
  try {
    backupPath = backupDatabase();
  } catch (e) {
    console.error("[backup] manual backup failed:", e.message);
    return res.status(500).json({ error: `Backup failed: ${e.message}` });
  }
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

// " Nearest hospital: X (d km straight-line)." for a WhatsApp reply, or ""
// when there is no hospital to name (hospitalFor() found none) - never
// "null (null km)". Says why when a nearer hospital was skipped because it
// is inside an active hazard zone (see nearestHospital).
// HUMAN REVIEW: citizen-facing safety text.
function hospitalLine(body) {
  if (!body.hospital) return "";
  let line = ` Nearest hospital: ${body.hospital} (${body.distance_km} km straight-line).`;
  const s = body.skipped_hospital;
  if (s) line += ` ${s.hospital} is closer but inside an active ${s.hazard_type} zone (${s.severity}).`;
  const z = body.hospital_in_hazard_zone;
  if (z) line += ` It is inside an active ${z.hazard_type} zone (${z.severity}) - call 112 before travelling.`;
  return line;
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

// One-line advice per hazard for the template's {{4}}, from the advice
// table the citizen SOS page also uses (data/hazard_advice.json, worded
// from sample_sops/) - so WhatsApp and the page can't drift apart.
// HUMAN REVIEW: safety-critical citizen advice; the Hindi lines (used when
// the template language is Hindi) still need a native-speaker check.
// A broken/missing file must not take the SOS server down with it: the
// generic line is used instead, and the error is logged.
const GENERIC_ADVICE = "Follow instructions from local authorities.";
const WHATSAPP_ADVICE_LANG = /^hi/i.test(WHATSAPP_ALERT_TEMPLATE_LANG) ? "hi" : "en";
function loadHazardAdvice() {
  try {
    const table = JSON.parse(fs.readFileSync(paths.HAZARD_ADVICE_FILE, "utf-8"));
    const advice = Object.create(null); // a hazard_type like "constructor" must not hit Object.prototype
    for (const [hazard, entry] of Object.entries(table.hazards || {})) {
      const line = entry?.whatsapp?.[WHATSAPP_ADVICE_LANG] || entry?.whatsapp?.en;
      if (typeof line === "string" && line.trim()) advice[hazard] = line;
    }
    const fallback = table.default?.whatsapp?.[WHATSAPP_ADVICE_LANG] || table.default?.whatsapp?.en || GENERIC_ADVICE;
    return { advice, fallback };
  } catch (e) {
    console.error(`[advice] could not read ${paths.HAZARD_ADVICE_FILE}: ${e.message} - WhatsApp alerts use generic advice`);
    return { advice: {}, fallback: GENERIC_ADVICE };
  }
}
const { advice: HAZARD_ADVICE, fallback: HAZARD_ADVICE_FALLBACK } = loadHazardAdvice();

// WhatsApp alerts to officers' own phones (users.phone, set with
// create_user.js --phone / set-phone) - see officer_alerts.js. Same dry-run
// and simulated-reading rules as the citizen alerts above.
const officerAlerts = setupOfficerAlerts(db, {
  send: sendWhatsAppTemplate,
  dryRun: WHATSAPP_DRY_RUN,
  allowSimulated: WHATSAPP_ALERTS_FOR_SIMULATED,
  template: process.env.OFFICER_WHATSAPP_TEMPLATE || "sanjeevni_officer_alert",
  templateLang: process.env.OFFICER_WHATSAPP_TEMPLATE_LANG || "en",
  minSeverity: process.env.OFFICER_ALERT_MIN_SEVERITY,
  publicBaseUrl: process.env.SANJEEVNI_PUBLIC_BASE_URL || "",
  nodeLocation: (nodeId) => nodeInfo(nodeId)?.location || null,
  confidenceSummary,
});

// The citizen advice table for the classic SOS page (public/sos.html; the
// React page bundles it at build time). Public, read-only, the same file
// the WhatsApp {{4}} lines above come from.
app.get("/hazard-advice.json", (req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.sendFile(paths.HAZARD_ADVICE_FILE, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "advice table not available" });
  });
});

// Admin audit: who was (or, in dry run, would have been) messaged, newest
// first. Phone numbers are masked.
app.get("/api/admin/officer-alerts", auth.requireAdmin, (req, res) => {
  const n = Number(req.query.limit ?? 50);
  if (!Number.isInteger(n) || n < 1 || n > 500) return res.status(400).json({ error: "limit must be 1-500" });
  res.json({ dry_run: WHATSAPP_DRY_RUN, min_severity: officerAlerts.minSeverity, alerts: officerAlerts.recent(n) });
});

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
  // The confidence label rides in the severity variable ({{2}}): the
  // approved template has exactly 4 variables, and adding a 5th would need
  // a new Meta template approval. With the example template it reads
  // "flood risk is CRITICAL, confidence High (82%) near ...".
  const confidence = confidenceSummary(alert);
  const params = [
    // "flash_flood" -> "flash flood" (the other types already use spaces)
    String(alert.hazard_type).replace(/_/g, " "),
    confidence ? `${alert.severity}, confidence ${confidence}` : alert.severity,
    alert.location || alert.node_id,
    HAZARD_ADVICE[alert.hazard_type] || HAZARD_ADVICE_FALLBACK,
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

  // B46: with no token configured, undefined === undefined passed this
  // check and hub.challenge was echoed back as text/html - a reflected XSS
  // link on our own origin. Now: a token must be configured and match
  // (constant time), Meta's challenge is a number, and it goes back as
  // plain text. Any one of the three stops the XSS.
  // Lengths compared in BYTES: a same-length string with non-ASCII
  // characters would make timingSafeEqual throw.
  const given = Buffer.from(typeof token === "string" ? token : "");
  const expected = Buffer.from(WHATSAPP_VERIFY_TOKEN || "");
  const ok =
    expected.length > 0 &&
    mode === "subscribe" &&
    given.length === expected.length &&
    crypto.timingSafeEqual(given, expected);
  if (ok && typeof challenge === "string" && /^\d{1,64}$/.test(challenge)) {
    return res.status(200).type("text/plain").send(challenge);
  }
  return res.status(403).type("text/plain").send("Verification failed");
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
    // Coordinates are checked like the web SOS's (B47): a webhook (unsigned
    // in dry-run mode) with latitude "x" used to be stored as an SOS, and
    // that one row then broke the officer SOS feed for everyone.
    let coords = null;
    if (parsed.type === "location") {
      coords = parseCoordinates(parsed.latitude, parsed.longitude);
      if (!coords) {
        console.warn(`[WhatsApp] location from ${parsed.fromPhone} has invalid coordinates - not stored`);
        // NEEDS HUMAN REVIEW (citizen-facing safety text)
        await sendWhatsAppText(
          parsed.fromPhone,
          "We could not read that location. Please share it again: tap the attachment icon -> Location -> Send your current location. In immediate danger, also call 112.",
        );
        return;
      }
    }

    if (parsed.type === "location" && isAwaitingAlertLocation(parsed.fromPhone)) {
      // Opt-in in progress (see "ALERTS ON" below): this location is for
      // alerts, not an SOS - and the reply says so, and how to turn it into
      // an SOS with one word, so nobody in danger is left without help.
      activateAlertSubscription(parsed.fromPhone, coords.latitude, coords.longitude);
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
      const subCoords = sub ? parseCoordinates(sub.latitude, sub.longitude) : null;
      if (subCoords) {
        const { httpStatus, body } = createSosRequest(deviceId, subCoords.latitude, subCoords.longitude,
          "Reported via WhatsApp text SOS - location from the person's alert subscription, may be outdated",
          "whatsapp");
        await sendWhatsAppText(
          parsed.fromPhone,
          (httpStatus === 409 ? "Your SOS is already active." : "SOS received. Responders have been notified.") +
            hospitalLine(body) + "\n" +
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
        coords.latitude,
        coords.longitude,
        "Reported via WhatsApp",
        "whatsapp",
      );
      if (httpStatus === 409) {
        await sendWhatsAppText(
          parsed.fromPhone,
          `Your SOS is already active.${hospitalLine(body)} Help is on the way.`,
        );
      } else {
        await sendWhatsAppText(
          parsed.fromPhone,
          `SOS received. Responders have been notified.\n${hospitalLine(body).trim()}` +
            (body.maps_url ? `\nDirections: ${body.maps_url}` : ""),
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

const PORT = parseInt(process.env.SANJEEVNI_PORT || "3000", 10) || 3000;
app.listen(PORT, () => {
  console.log(`Node.js Orchestrator running on http://localhost:${PORT}`);
});
