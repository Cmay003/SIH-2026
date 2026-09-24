// Loads OFFICER_API_KEY (and any other future secrets) from a .env file
// in this folder, if one exists - falls back silently to whatever's
// already in the real environment if .env is missing, so this doesn't
// break anyone who's still setting the variable manually.
require("dotenv").config();

const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json({ limit: "10mb" })); // raised for base64 photo uploads (citizen hazard reports)
app.use(cors());
app.use(express.static(__dirname));

// --- UPGRADE: authentication on officer dashboard + SOS API ------------
// Simple API-key auth (X-API-Key header) for OFFICER-facing actions -
// viewing all SOS locations, resolving them. Citizen-facing endpoints
// (submitting an SOS, viewing hazards, ESP32 ingestion) stay open, since
// those need to work for anonymous citizens and unauthenticated field
// hardware by design.
//
// SECURITY NOTE: never hardcode a real secret. This falls back to a
// clearly-labeled DEMO key ONLY so the existing demo flow doesn't break
// if you haven't set OFFICER_API_KEY yet - replace it before any real
// deployment. Set a real one via: export OFFICER_API_KEY="your-real-key"
const OFFICER_API_KEY =
  process.env.OFFICER_API_KEY || "sanjeevni-demo-key-CHANGE-ME";
if (!process.env.OFFICER_API_KEY) {
  console.warn(
    "\n[SECURITY WARNING] OFFICER_API_KEY is not set - using an insecure " +
      "default demo key. Set a real one via environment variable before " +
      'any real deployment: export OFFICER_API_KEY="your-real-key"\n',
  );
}

function requireOfficerAuth(req, res, next) {
  const providedKey = req.headers["x-api-key"];
  if (providedKey !== OFFICER_API_KEY) {
    return res
      .status(401)
      .json({ error: "Unauthorized - valid X-API-Key header required" });
  }
  next();
}

const db = new DatabaseSync(path.join(__dirname, "sanjeevni.db"));

// --- UPGRADE: redundant database (lightweight backup routine) ----------
// Full geographic/multi-host redundancy needs real infrastructure (a
// second server, cloud storage) beyond what application code alone can
// provide - that's a hosting decision, not a code problem. What THIS
// does, for real: periodically copies the live SQLite file to a
// backups/ folder with a timestamped name, and prunes old ones so disk
// usage doesn't grow unbounded. Protects against DB corruption or an
// accidental delete - not a datacenter outage.
const BACKUPS_DIR = path.join(__dirname, "backups");
const BACKUP_INTERVAL_MS = 30 * 60 * 1000; // every 30 minutes
const BACKUP_RETENTION_COUNT = 10;
const DB_FILE_PATH = path.join(__dirname, "sanjeevni.db");

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
  fs.copyFileSync(DB_FILE_PATH, backupPath);

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
const selectActiveHazards = db.prepare(`
  SELECT sd.node_id, sd.location, sd.hazard_type, sd.severity, sd.risk_score,
         sd.eta_minutes, sd.predicted_time, sd.latitude, sd.longitude
  FROM sensor_data sd
  INNER JOIN (
    SELECT node_id, MAX(id) as max_id FROM sensor_data GROUP BY node_id
  ) latest ON sd.node_id = latest.node_id AND sd.id = latest.max_id
  WHERE sd.severity IN ('MEDIUM','HIGH','CRITICAL')
  ORDER BY sd.risk_score DESC
`);

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

const CITIZEN_UPLOADS_DIR = path.join(__dirname, "citizen_uploads");
if (!fs.existsSync(CITIZEN_UPLOADS_DIR)) {
  fs.mkdirSync(CITIZEN_UPLOADS_DIR, { recursive: true });
}
app.use("/citizen_uploads", express.static(CITIZEN_UPLOADS_DIR));

const NODE_INFO = {
  "NODE-04": {
    location: "Sector 4, Riverside",
    latitude: 29.3919,
    longitude: 79.4542,
  },
  "NODE-07": {
    location: "Sector 7, Hillside",
    latitude: 29.4002,
    longitude: 79.461,
  },
  "NODE-INDB": {
    location: "Industrial Zone B",
    latitude: 29.385,
    longitude: 79.448,
  },
};

// Responder / control room base - where rescue teams are dispatched from.
// Replace with your actual station coordinates.
const RESPONDER_BASE = {
  name: "SANJEEVNI Response HQ",
  latitude: 29.3919,
  longitude: 79.4542,
};

const HAZARD_RADIUS_M = { MEDIUM: 500, HIGH: 1000, CRITICAL: 2000 };

const hospitals = JSON.parse(
  fs.readFileSync(path.join(__dirname, "hospitals.json"), "utf-8"),
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

// 1. Ingestion endpoint - ESP32 / simulator sends raw readings here
app.post("/api/ingest", async (req, res) => {
  try {
    const sensorData = req.body;

    const pythonResponse = await axios.post(
      "http://127.0.0.1:8000/api/ingest",
      sensorData,
    );
    const aiResult = pythonResponse.data;

    const info = NODE_INFO[sensorData.node_id] || {};

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

    res.status(200).json({ status: "success", ai_action: aiResult.status });
  } catch (error) {
    console.error("Pipeline error:", error.message);
    res.status(500).json({ status: "error", detail: error.message });
  }
});

// 2. Dashboard feed - shaped for index.html
app.get("/api/sensors", (req, res) => {
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
app.get("/api/history", (req, res) => {
  res.json(selectHistory.all());
});

// 4. Nearest hospital + directions link for a given sensor node
app.get("/api/route/:node_id", (req, res) => {
  const coords = NODE_INFO[req.params.node_id];
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

app.post("/api/sos", (req, res) => {
  const { latitude, longitude, note, device_id } = req.body;
  if (latitude == null || longitude == null) {
    return res
      .status(400)
      .json({ error: "latitude and longitude are required" });
  }
  if (!device_id) {
    return res.status(400).json({ error: "device_id is required" });
  }
  const { httpStatus, body } = createSosRequest(
    device_id,
    latitude,
    longitude,
    note,
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
app.get("/api/hazard-zones", (req, res) => {
  const rows = selectActiveHazards.all();
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
    }));
  res.json({ success: true, zones });
});

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
  const { latitude, longitude, description, photo_base64 } = req.body;
  if (latitude == null || longitude == null) {
    return res
      .status(400)
      .json({ error: "latitude and longitude are required" });
  }

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

// Sends a freeform WhatsApp text message. Only works within Meta's 24h
// customer-service window after the recipient messaged first (see the
// setup note above) - use sendWhatsAppTemplate() for anything proactive.
async function sendWhatsAppText(toPhone, body) {
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
app.post("/api/whatsapp/webhook", async (req, res) => {
  // Always 200 immediately - Meta retries aggressively on non-200/timeout,
  // and we don't want a slow downstream call to cause duplicate webhook
  // deliveries for the same message.
  res.sendStatus(200);

  const parsed = parseWhatsAppMessage(req.body);
  if (!parsed) return;

  const deviceId = `whatsapp:${parsed.fromPhone}`;

  try {
    if (parsed.type === "location") {
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
    } else if (parsed.type === "text") {
      await sendWhatsAppText(
        parsed.fromPhone,
        "This is SANJEEVNI emergency response. To send an SOS, please share your LIVE LOCATION (attachment icon -> Location -> Share Live Location) so we can find you and route help.",
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
