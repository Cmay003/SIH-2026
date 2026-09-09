const express = require("express");
const axios = require("axios");
const cors = require("cors");
const { DatabaseSync } = require("node:sqlite");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static(__dirname));

const db = new DatabaseSync(path.join(__dirname, "sanjeevni.db"));
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
    latitude REAL,
    longitude REAL,
    note TEXT,
    status TEXT DEFAULT 'open',
    timestamp TEXT
  )
`);

const insertSos = db.prepare(
  `INSERT INTO sos_requests (latitude, longitude, note, status, timestamp)
   VALUES (?, ?, ?, 'open', ?)`,
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
      sensorData.river_level_m ?? null,
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
app.post("/api/sos", (req, res) => {
  const { latitude, longitude, note } = req.body;
  if (latitude == null || longitude == null) {
    return res
      .status(400)
      .json({ error: "latitude and longitude are required" });
  }
  const timestamp = new Date().toISOString();
  insertSos.run(latitude, longitude, note || null, timestamp);

  const { hospital, distance_km } = nearestHospital(latitude, longitude);
  res.status(201).json({
    status: "received",
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

// 6. Officer dashboard feed - open SOS requests, each enriched with the
// route from the responder base to the person, and the person's nearest hospital.
app.get("/api/sos", (req, res) => {
  const rows =
    req.query.status === "all"
      ? selectAllSos.all(parseInt(req.query.limit || "200", 10))
      : selectOpenSos.all();

  const data = rows.map((r) => {
    const { hospital, distance_km } = nearestHospital(r.latitude, r.longitude);
    return {
      id: r.id,
      latitude: r.latitude,
      longitude: r.longitude,
      note: r.note,
      status: r.status,
      timestamp: r.timestamp,
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

  res.json({ success: true, count: data.length, data });
});

// 7. Officer marks an SOS as handled
app.post("/api/sos/:id/resolve", (req, res) => {
  updateSosStatus.run("resolved", req.params.id);
  res.json({ status: "ok" });
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

app.listen(3000, () => {
  console.log("Node.js Orchestrator running on http://localhost:3000");
});
