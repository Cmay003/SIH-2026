// =====================================================================
// SANJEEVNI - device keys for sensor ingestion (/api/ingest, /batch).
//
// Ingestion used to be open to anyone with the URL - and an ingested
// reading can confirm a hazard, put it on the public map and send
// WhatsApp alerts, so anyone could fake a flood (review finding R1).
//
// Every ESP32 node, gateway and simulator now sends `X-Device-Key`.
//  - Keys are random 32-byte secrets shown ONCE by `node server/device_keys.js add`.
//    Only their SHA-256 is stored (a high-entropy random key doesn't need
//    a slow password hash).
//  - Each key lists the node IDs it may report for ("*" = any), so a key
//    pulled out of one node's flash can't fake readings for the others.
//  - kind "simulator": every reading it sends is forced to simulated=true,
//    whatever the request says - simulated data can never pass as real or
//    alert real people.
//  - ALLOW_UNAUTHENTICATED_INGEST=1 turns the check off (old firmware,
//    quick lab tests) with a loud warning. Never in a real deployment.
// =====================================================================
const crypto = require("crypto");

const KINDS = ["device", "simulator"];
const sha256 = (text) => crypto.createHash("sha256").update(text).digest("hex");

function initDeviceKeyTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS device_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      key_hash TEXT UNIQUE NOT NULL,
      kind TEXT NOT NULL DEFAULT 'device',
      nodes TEXT NOT NULL DEFAULT '*',   -- '*' or comma-separated node IDs
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    )
  `);
}

function createDeviceKey(db, { name, kind = "device", nodes = "*" }) {
  initDeviceKeyTable(db);
  const key = `sjk_${crypto.randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO device_keys (name, key_hash, kind, nodes, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(name, sha256(key), kind, nodes, new Date().toISOString());
  return key;
}

function parseNodes(nodes) {
  return nodes === "*" ? null : new Set(nodes.split(",").map((n) => n.trim()).filter(Boolean));
}

function setupDeviceAuth(db) {
  initDeviceKeyTable(db);
  const allowUnauthenticated = process.env.ALLOW_UNAUTHENTICATED_INGEST === "1";
  if (allowUnauthenticated) {
    console.warn(
      "\n[SECURITY WARNING] ALLOW_UNAUTHENTICATED_INGEST=1 - anyone who can reach this server can submit\n" +
        "sensor readings, fake hazards and trigger alerts. Use only for lab tests with old firmware.\n",
    );
  }
  const byHash = db.prepare("SELECT * FROM device_keys WHERE key_hash = ? AND active = 1");
  const touch = db.prepare("UPDATE device_keys SET last_used_at = ? WHERE id = ?");
  const lastTouched = new Map(); // id -> ms, so a 5 s reporter doesn't write on every reading

  // Sets req.device = { name, kind, nodes:Set|null } or responds 401.
  function requireDeviceKey(req, res, next) {
    const key = req.headers["x-device-key"];
    if (!key) {
      if (allowUnauthenticated) {
        req.device = { name: "unauthenticated", kind: "device", nodes: null };
        return next();
      }
      return res.status(401).json({ error: "X-Device-Key header required - create one with: node server/device_keys.js add <name>" });
    }
    const row = typeof key === "string" ? byHash.get(sha256(key)) : null;
    if (!row) return res.status(401).json({ error: "Invalid or revoked device key" });
    const now = Date.now();
    if (now - (lastTouched.get(row.id) || 0) > 60000) {
      lastTouched.set(row.id, now);
      touch.run(new Date(now).toISOString(), row.id);
    }
    req.device = { name: row.name, kind: row.kind, nodes: parseNodes(row.nodes) };
    next();
  }

  const nodeAllowed = (device, nodeId) => device.nodes === null || device.nodes.has(nodeId);

  // Applies the key's policy to one reading body (returns a new object).
  function applyKeyPolicy(device, reading) {
    return device.kind === "simulator" ? { ...reading, simulated: true } : reading;
  }

  return { requireDeviceKey, nodeAllowed, applyKeyPolicy };
}

module.exports = { setupDeviceAuth, createDeviceKey, initDeviceKeyTable, KINDS };
