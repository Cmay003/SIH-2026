// =====================================================================
// SANJEEVNI - village siren on sensor nodes (server side).
//
// A node with a siren output says so in every reading (siren_fitted: true)
// and reports whether it is sounding (siren_on, siren_reason). The server
// keeps a DESIRED state per node and answers ingest requests with
// "commands" until the node reports the matching state - desired-state
// reconciliation, so a lost LoRa ACK or a gateway restart only delays a
// command, never loses it, and a repeated command does no harm.
//
// Who decides the desired state:
//  - AUTO: a CONFIRMED (alert_dispatched) reading at SIREN_AUTO_SEVERITY
//    (CRITICAL - the only level allowed; team decision 2026-10-09: never
//    automatically on HIGH) of an EVACUATION hazard (SIREN_AUTO_HAZARDS,
//    below - user decision 2026-10-09) sounds the node's own siren once per
//    hazard episode. A siren tells people to LEAVE: heat / severe heat
//    wave, air pollution and smoke ask them to stay in or take care, and a
//    weather forecast measured nothing here - none of those sound it by
//    themselves (an officer still can, for anything). An evacuation
//    hazard the backend measured at CRITICAL but did not pick as the
//    reading's primary (e.g. a gas leak on a Severe-AQI day, primary "air
//    pollution") also sounds it, once the same node has measured it on an
//    earlier reading too - see HIDDEN_CONFIRM_WINDOW_SECONDS.
//    An episode is one hazard FAMILY at one node (flood and
//    flash_flood are one physical event, so are fire and smoke) from its
//    first confirmed reading until EPISODE_CLEAR_READINGS consecutive
//    positive all-clear readings (LOW, a real hazard type), or until it has
//    had no confirmed reading for EPISODE_GAP_SECONDS. A sensor-fault /
//    suppressed result says nothing about the hazard and never ends one -
//    otherwise one anomalous reading mid-flood would make the next CRITICAL
//    a "new episode" and overrule an officer who silenced the siren.
//    Inside an episode the siren re-triggers only on escalation (a
//    confirmed severity above anything the episode had before), so an
//    officer who silenced it is not overruled every few seconds by the
//    same flood.
//  - OFFICER: POST /api/nodes/:id/siren on/off (HIGH = officer decision).
// The node itself may also sound it with no server at all (siren_reason
// "auto_offline", firmware sj_siren.h sjSirenLocalUrgent: water level or gas
// ppm over its limit, not on a value its own checks doubt - the same
// evacuation-only idea) - the server only reports that.
//
// Simulated readings (simulator key, judge demo) never put a REAL node's
// siren on: an auto-on caused by one is marked simulated and is only
// commanded back to senders of simulated readings.
// =====================================================================

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const ACTIVE_SEVERITIES = new Set(["MEDIUM", "HIGH", "CRITICAL"]);
const ACTIVE_STATUSES = new Set(["alert_dispatched", "pending_confirmation"]);
const REPORTED_REASONS = new Set(["auto_offline", "command"]);

// Configurable demo defaults (not from a standard): how long one trigger
// sounds, the range an officer may ask for, and how old a reading may be
// and still sound a siren NOW (a store-and-forward backlog delivered hours
// late must not wake a village for a danger that has passed - same rule as
// MAX_ALERT_DELAY_SECONDS for WhatsApp alerts in server.js).
const DEFAULT_ON_SECONDS = 180;
const MIN_ON_SECONDS = 10;
const MAX_ON_SECONDS = 900;
const MAX_AUTO_DELAY_SECONDS = 15 * 60;
// An "on" with less than this left is not worth a command: the node would
// barely switch on before the officer's/auto request ends.
const MIN_COMMAND_SECONDS = 5;
// Episode bookkeeping, also configurable demo defaults: one all-clear
// reading between two flood peaks (a gust, a wave) must not start a "new"
// episode, and a node that went quiet mid-event and comes back hours later
// in a new event must not stay "inside" the old one forever.
const EPISODE_CLEAR_READINGS = 3;
const EPISODE_GAP_SECONDS = 6 * 3600;
// Hazard types that are one physical event at one node (see the backend's
// hazard_classification.py: flash_flood is a fast-rising flood, smoke an
// early fire). Anything not listed is its own family.
const EPISODE_FAMILY = { flash_flood: "flood", smoke: "fire" };
// Results that are not a statement about a hazard at all
const NOT_A_HAZARD = new Set(["sensor_fault", "none"]);
const familyOf = (hazardType) => EPISODE_FAMILY[hazardType] || hazardType;

// Hazard types the AUTOMATIC siren may sound for (SIREN_AUTO_HAZARDS, a
// comma list). User decision 2026-10-09: evacuation hazards only. Names are
// compared normalised (lower case, spaces / hyphens -> "_"), because the
// backend writes some with a space: integration_pipeline.py emits "gas leak"
// (the only chemical-leak type it has - MQ gas sensor, gas_ppm threshold).
// NOT in the default, on purpose: "extreme heat" (incl. IMD severe heat
// wave), "air pollution", "smoke" (an early-fire sign - the "fire" result
// itself does sound), "water quality degradation", and the forecast types
// heavy_rain / high_wind (forecast-only results never sound one whatever
// this list says - isForecastResult below).
const DEFAULT_AUTO_HAZARDS = Object.freeze(["flood", "flash_flood", "landslide", "fire", "gas_leak"]);
// Every hazard_type the backend can emit (hazard_classification.py,
// integration_pipeline.py; "forest fire" only in rag_alert_pipeline.py's
// examples) - a name outside this list is accepted but warned about, since
// a typo would silently stop a hazard from sounding the siren.
const KNOWN_HAZARDS = new Set([...DEFAULT_AUTO_HAZARDS, "forest_fire", "smoke", "extreme_heat", "air_pollution",
  "water_quality_degradation", "heavy_rain", "high_wind"]);
const normHazard = (t) => String(t ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

// An evacuation hazard HIDDEN behind another primary (review 2026-10-09):
// the backend picks ONE primary hazard_type per reading (most severe, then
// HAZARD_TIE_PRIORITY, then risk_score - integration_pipeline.py rank()),
// and gas leak / flood / landslide have the same tie priority as air
// pollution and extreme heat. So a CRITICAL gas leak (risk 0.92) on a
// Severe-AQI day (air pollution CRITICAL 0.96) arrives with hazard_type
// "air pollution" and the gas leak only in hazard_scores. Such a hidden
// result was never confirmed by the backend (hazard_confirmation.py
// confirms the PRIMARY), so the siren asks for the same evidence itself:
// the same node measured the same hazard at MEDIUM+ on an earlier reading
// within HIDDEN_CONFIRM_WINDOW_SECONDS (= hazard_confirmation.py
// CONFIRM_WINDOW_MINUTES, 10 min, persistence basis), and the sensor it
// reads is not flagged stuck by the node (a frozen value "persists" by
// definition - alert_confidence.py stuck_hazard_fields). Sightings are kept
// in memory, like the backend's confirmer: after a restart the first
// hidden reading waits for one more.
const HIDDEN_CONFIRM_WINDOW_SECONDS = 10 * 60;
// The sensors each evacuation hazard reads (normalised names) - the same
// as backend/alert_confidence.py HAZARD_FIELDS. A type not listed (an
// operator's own SIREN_AUTO_HAZARDS entry) has no stuck check.
const HAZARD_SENSOR_FIELDS = {
  flood: ["river_level_m"], flash_flood: ["river_level_m"], gas_leak: ["gas_ppm"],
  fire: ["flame_reading", "temp_c"], landslide: ["tilt_angle_deg", "vibration_magnitude"],
};
/** Fields the node's edge checks call stuck ("stuck:<field>", list or comma string). */
function stuckFields(edgeAnomaly) {
  const items = Array.isArray(edgeAnomaly) ? edgeAnomaly : String(edgeAnomaly ?? "").split(",");
  const out = new Set();
  for (const item of items) {
    const [check, field] = String(item).trim().split(":");
    if (check === "stuck" && field) out.add(field);
  }
  return out;
}

/** SIREN_AUTO_HAZARDS -> Set of normalised hazard types (unset / empty = the default list). */
function parseAutoHazards(value, warn = console.warn) {
  const names = String(value ?? "").split(",").map(normHazard).filter(Boolean);
  if (names.length === 0) {
    if (value != null && String(value).trim() !== "") {
      warn(`[siren] SIREN_AUTO_HAZARDS=${value} names no hazard - using the default (${DEFAULT_AUTO_HAZARDS.join(",")}); ` +
        "use SIREN_AUTO_SEVERITY=off to switch automatic sounding off");
    }
    return new Set(DEFAULT_AUTO_HAZARDS);
  }
  const unknown = names.filter((n) => !KNOWN_HAZARDS.has(n));
  if (unknown.length) {
    warn(`[siren] SIREN_AUTO_HAZARDS: ${unknown.join(", ")} is not a hazard type the backend reports - check the spelling`);
  }
  return new Set(names);
}

// A result whose severity came from the WEATHER FORECAST alone (backend
// hazard_classification.py: forecast_based true, severity_source
// "weather_forecast"; hazard_confirmation.py basis "forecast"). Shared with
// officer_alerts.js.
const isForecastResult = (r) => !!r && (r.forecast_based === true || r.severity_source === "weather_forecast" ||
  r.confirmation === "forecast");

/** SIREN_AUTO_SEVERITY -> severity rank, or null when automatic sounding is off. */
function parseAutoSeverity(value, warn = console.warn) {
  const v = String(value ?? "").trim().toUpperCase() || "CRITICAL"; // unset = the default
  if (v === "OFF" || v === "0" || v === "NONE") return null;
  if (v !== "CRITICAL") {
    // HIGH (or lower) would be against the team decision; a typo must not
    // switch the safety feature off either - fall back to CRITICAL.
    warn(`[siren] SIREN_AUTO_SEVERITY=${value} is not supported (CRITICAL or off) - using CRITICAL`);
  }
  return SEVERITY_RANK.CRITICAL;
}

function onSecondsFromEnv(value, warn = console.warn) {
  if (value == null || value === "") return DEFAULT_ON_SECONDS;
  const n = Number(value);
  if (Number.isInteger(n) && n >= MIN_ON_SECONDS && n <= MAX_ON_SECONDS) return n;
  warn(`[siren] SIREN_ON_SECONDS=${value} is not ${MIN_ON_SECONDS}-${MAX_ON_SECONDS} - using ${DEFAULT_ON_SECONDS}`);
  return DEFAULT_ON_SECONDS;
}

/**
 * How old a reading is, in seconds, or null when nobody knows. Mirrors the
 * backend (backend_server.py resolve_reading_time / ingest_batch): an
 * explicit timestamp, else age_seconds; with neither, a single reading is
 * "now" but a batch reading is UNTIMED - the gateway leaves age_seconds out
 * for backlog readings whose age was lost in a reboot (sj_packet.h
 * sjAppendJson), and those can be hours old.
 */
function readingAgeSeconds(r, nowMs, untimedIsNow) {
  if (typeof r.timestamp === "string" && r.timestamp) {
    const t = Date.parse(r.timestamp);
    // unparseable / future: the backend falls back to the receive time
    return Number.isFinite(t) ? Math.max(0, (nowMs - t) / 1000) : 0;
  }
  if (r.age_seconds != null && r.age_seconds !== "" && Number.isFinite(Number(r.age_seconds))) {
    return Math.max(0, Number(r.age_seconds));
  }
  return untimedIsNow ? 0 : null;
}

/**
 * The newest reading per node in one request. Batches are not in time
 * order (smart sending puts urgent readings first, a backlog follows), so
 * "newest" = smallest age; on a tie the later one in the request. An
 * untimed reading (age null, timed: false) is picked only when the request
 * has no timed reading for that node - it must never beat a live one.
 */
function newestPerNode(readings, { nowMs = Date.now(), untimedIsNow = false } = {}) {
  const newest = new Map();
  readings.forEach((r, i) => {
    if (!r || typeof r.node_id !== "string") return;
    const age = readingAgeSeconds(r, nowMs, untimedIsNow);
    const timed = age !== null;
    const best = newest.get(r.node_id);
    const better = !best || (timed ? !best.timed || age <= best.age : !best.timed);
    if (better) newest.set(r.node_id, { reading: r, age, timed, index: i });
  });
  return newest;
}

function setupSirens(db, {
  autoSeverity = process.env.SIREN_AUTO_SEVERITY,
  autoHazards = process.env.SIREN_AUTO_HAZARDS,
  onSeconds = process.env.SIREN_ON_SECONDS,
  episodeClearReadings = EPISODE_CLEAR_READINGS,
  episodeGapSeconds = EPISODE_GAP_SECONDS,
  log = console,
} = {}) {
  const autoRank = parseAutoSeverity(autoSeverity, log.warn);
  const autoHazardSet = parseAutoHazards(autoHazards, log.warn);
  const defaultOnSeconds = onSecondsFromEnv(onSeconds, log.warn);
  log.log(`[siren] automatic village siren: ${autoRank === null ? "OFF (SIREN_AUTO_SEVERITY=off)"
    : `confirmed CRITICAL ${[...autoHazardSet].join(" / ")} only (SIREN_AUTO_HAZARDS)`}; ` +
    `one trigger sounds ${defaultOnSeconds} s`);

  db.exec(`
    CREATE TABLE IF NOT EXISTS node_sirens (
      node_id TEXT PRIMARY KEY,
      fitted INTEGER NOT NULL DEFAULT 0,
      sounding INTEGER NOT NULL DEFAULT 0,
      reported_reason TEXT,        -- 'auto_offline' | 'command' (node's own words)
      reported_at TEXT,            -- time of the reading the reported state came from
      reported_simulated INTEGER NOT NULL DEFAULT 0,
      desired TEXT,                -- 'on' | 'off' | NULL = no opinion (send nothing)
      desired_reason TEXT,         -- 'auto' | 'officer'
      desired_by TEXT,             -- officer username, or 'auto'
      desired_at TEXT,
      desired_until TEXT,          -- end of an 'on'
      desired_simulated INTEGER NOT NULL DEFAULT 0,
      episodes TEXT                -- JSON {"<sim:>family": {"peak": rank, "at": ms, "clear": n}}
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS siren_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      node_id TEXT NOT NULL,
      action TEXT NOT NULL,        -- 'on' | 'off'
      actor TEXT NOT NULL,         -- officer username, 'api-key' or 'auto'
      detail TEXT,
      at TEXT NOT NULL
    )
  `);

  const q = {
    get: db.prepare("SELECT * FROM node_sirens WHERE node_id = ?"),
    listShown: db.prepare(
      "SELECT * FROM node_sirens WHERE fitted = 1 OR sounding = 1 OR desired IS NOT NULL ORDER BY node_id",
    ),
    insertReported: db.prepare(`
      INSERT INTO node_sirens (node_id, fitted, sounding, reported_reason, reported_at, reported_simulated)
      VALUES (?, ?, ?, ?, ?, ?)
    `),
    updateReported: db.prepare(`
      UPDATE node_sirens SET fitted = ?, sounding = ?, reported_reason = ?, reported_at = ?, reported_simulated = ?
      WHERE node_id = ?
    `),
    setDesired: db.prepare(`
      UPDATE node_sirens SET desired = ?, desired_reason = ?, desired_by = ?, desired_at = ?, desired_until = ?,
        desired_simulated = ? WHERE node_id = ?
    `),
    clearDesired: db.prepare(`
      UPDATE node_sirens SET desired = NULL, desired_reason = NULL, desired_by = NULL, desired_at = NULL,
        desired_until = NULL, desired_simulated = 0 WHERE node_id = ?
    `),
    setEpisodes: db.prepare("UPDATE node_sirens SET episodes = ? WHERE node_id = ?"),
    audit: db.prepare("INSERT INTO siren_audit (node_id, action, actor, detail, at) VALUES (?, ?, ?, ?, ?)"),
    auditFor: db.prepare("SELECT action, actor, detail, at FROM siren_audit WHERE node_id = ? ORDER BY id DESC LIMIT ?"),
  };

  // "<sim:>node|hazard" -> reading times (ms) of MEDIUM+ measured evacuation
  // results, for the hidden-hazard persistence check (in memory, a few per key)
  const sightings = new Map();

  function audit(nodeId, action, actor, detail, nowMs) {
    q.audit.run(nodeId, action, actor, detail || null, new Date(nowMs).toISOString());
    console.warn(`[siren] ${nodeId}: ${action.toUpperCase()} by ${actor}${detail ? ` - ${detail}` : ""}`);
  }

  const onExpired = (row, nowMs) => {
    const until = Date.parse(row.desired_until);
    return !(Number.isFinite(until) && until > nowMs);
  };

  /** 'on' (+ seconds left) / 'off' / null - what the node should be doing now. */
  function effectiveDesired(row, nowMs) {
    if (!row || !row.desired) return null;
    if (row.desired === "on") {
      if (!onExpired(row, nowMs)) {
        return { siren: "on", for_s: Math.ceil((Date.parse(row.desired_until) - nowMs) / 1000) };
      }
      // The request ran out: wanted silent until the node confirms - but
      // only OUR sounding. A node that lost the link after our "on" and now
      // sounds by its own offline fallback (local danger, no gateway) is
      // left alone; only an officer's explicit "off" stops that.
      if (row.sounding && row.reported_reason === "auto_offline") return null;
      return { siren: "off" };
    }
    return { siren: "off" };
  }

  /**
   * Stores what each siren-fitted node reported (newest reading per node in
   * the request). Callers pass only readings the device key may send.
   * Runs BEFORE the AI backend sees the readings: siren state and officer
   * commands must keep working while the backend is down.
   * untimedIsNow: true for the single-reading route, where a reading
   * without timestamp / age_seconds is live (see readingAgeSeconds).
   */
  function recordReported(readings, nowMs = Date.now(), { untimedIsNow = false } = {}) {
    for (const [nodeId, { reading, age, timed }] of newestPerNode(readings, { nowMs, untimedIsNow })) {
      const row = q.get.get(nodeId);
      const fitted = reading.siren_fitted === true || reading.siren_on === true;
      if (!row && !fitted) continue; // nodes without a siren get no row
      const simulated = reading.simulated === true;
      // A simulated reading never overwrites what a REAL node reported: the
      // judge demo uses real-looking node ids.
      if (row && simulated && !row.reported_simulated && row.reported_at) continue;
      const sounding = reading.siren_on === true;
      const reason = sounding && REPORTED_REASONS.has(reading.siren_reason) ? reading.siren_reason : null;
      if (!timed) {
        // Time unknown (a backlog reading that outlived a reboot - it may be
        // hours old): it only fills in a node we know nothing about yet
        // (reported_at stays NULL, so the next timed reading replaces it)
        // and never ends an officer's or the auto rule's request - a stale
        // "silent" must not cancel the silencing of a siren that sounds.
        if (!row) q.insertReported.run(nodeId, 1, sounding ? 1 : 0, reason, null, simulated ? 1 : 0);
        else if (!row.reported_at) {
          q.updateReported.run(fitted ? 1 : 0, sounding ? 1 : 0, reason, null, simulated ? 1 : 0, nodeId);
        }
        continue;
      }
      const readingAt = nowMs - age * 1000;
      // A backlog reading older than the stored state says nothing about now
      if (row && row.reported_at && readingAt < Date.parse(row.reported_at)) continue;
      const at = new Date(readingAt).toISOString();
      if (!row) q.insertReported.run(nodeId, 1, sounding ? 1 : 0, reason, at, simulated ? 1 : 0);
      else q.updateReported.run(fitted ? 1 : 0, sounding ? 1 : 0, reason, at, simulated ? 1 : 0, nodeId);
      if (row && Boolean(row.sounding) !== sounding) {
        console.warn(`[siren] ${nodeId} reports siren ${sounding ? `ON (${reason || "reason not given"})` : "OFF"}`);
      }
      const updated = q.get.get(nodeId);
      if (updated.desired === "on") {
        // A run-out "on" is finished once the node is silent, or sounds by
        // its own offline fallback (which an expired request never stops -
        // see effectiveDesired)
        if (onExpired(updated, nowMs) && (!sounding || updated.reported_reason === "auto_offline")) {
          q.clearDesired.run(nodeId);
        }
      } else if (updated.desired === "off" && !sounding) {
        q.clearDesired.run(nodeId); // reconciled: silent as wanted - nothing left to send
      }
    }
  }

  /**
   * The "commands" for one ingest response: desired state for every
   * siren-fitted node in the request whose reported state differs.
   */
  function commandsFor(readings, nowMs = Date.now()) {
    const commands = [];
    // Any reading of the node in this request saying it has a siren will do
    // (the newest may be an untimed backlog one from before it was fitted)
    const fittedNodes = new Set(readings.filter((r) => r && r.siren_fitted === true).map((r) => r.node_id));
    for (const [nodeId, { reading }] of newestPerNode(readings, { nowMs })) {
      if (!fittedNodes.has(nodeId)) continue;
      const row = q.get.get(nodeId);
      const want = effectiveDesired(row, nowMs);
      if (!want) continue;
      // An auto-on caused by a simulated reading is for the simulator only
      if (row.desired_simulated && reading.simulated !== true) continue;
      if (want.siren === "on" && !row.sounding && want.for_s >= MIN_COMMAND_SECONDS) {
        commands.push({ node_id: nodeId, siren: "on", for_s: want.for_s });
      } else if (want.siren === "off" && row.sounding) {
        commands.push({ node_id: nodeId, siren: "off" });
      }
    }
    return commands;
  }

  function readEpisodes(row) {
    try {
      const e = JSON.parse(row.episodes || "{}");
      return e && typeof e === "object" && !Array.isArray(e) ? e : {};
    } catch {
      return {};
    }
  }

  /**
   * The AUTO rule, called with every AI result the dashboard stores (in
   * reading-time order). Only for nodes that have reported a siren.
   * Returns { node_id, severity, hazard_type, why, simulated, until } when
   * it switched the siren on, else undefined.
   */
  function onAiResult(sensorData, aiResult, nowMs = Date.now()) {
    if (!aiResult || !sensorData || typeof sensorData.node_id !== "string") return;
    const nodeId = sensorData.node_id;
    const row = q.get.get(nodeId);
    if (!row || !row.fitted) return;
    const simulated = sensorData.simulated === true;
    const prefix = simulated ? "sim:" : "";
    const parsedAt = Date.parse(aiResult.timestamp);
    const readingAt = Number.isFinite(parsedAt) ? parsedAt : nowMs;
    const episodes = readEpisodes(row);
    const mine = (key) => key.startsWith("sim:") === simulated;
    let changed = false;
    const save = () => {
      if (changed) q.setEpisodes.run(JSON.stringify(episodes), nodeId);
    };

    // No confirmed reading for a long time: that event is over, whatever
    // happened while the node was quiet
    for (const [key, e] of Object.entries(episodes)) {
      if (mine(key) && readingAt - (e.at ?? 0) > episodeGapSeconds * 1000) {
        delete episodes[key];
        changed = true;
      }
    }

    const hazard = String(aiResult.hazard_type || "unknown");
    if (aiResult.status === "logged" && aiResult.severity === "LOW" && !NOT_A_HAZARD.has(hazard)) {
      // A POSITIVE all-clear (every classifier LOW). An episode ends after
      // episodeClearReadings of them in a row; only readings newer than the
      // episode's last update count (a late backlog reading from before the
      // flood must not end it).
      for (const [key, e] of Object.entries(episodes)) {
        if (!mine(key) || readingAt < (e.at ?? 0)) continue;
        e.clear = (e.clear ?? 0) + 1;
        if (e.clear >= episodeClearReadings) delete episodes[key];
        changed = true;
      }
      save();
      return;
    }
    // Suppressed / sensor_fault results (anomalous data) and the like say
    // nothing about whether the hazard is over: they neither end nor feed
    // an episode
    if (!(ACTIVE_SEVERITIES.has(aiResult.severity) && ACTIVE_STATUSES.has(aiResult.status))) {
      save();
      return;
    }
    // A FORECAST-only result (heavy_rain / high_wind whose severity came from
    // the weather forecast, raised at every node in the forecast area) says
    // nothing the node measured: it never sounds a siren and neither feeds
    // nor ends an episode (a forecast CRITICAL must not use up the episode a
    // later MEASURED CRITICAL needs). The backend caps forecast alerts at
    // HIGH (hazard_classification.py FORECAST_MAX_RISK); this guard keeps
    // the rule even if that cap ever regresses (review 2026-10-09).
    if (isForecastResult(aiResult)) {
      if (aiResult.severity === "CRITICAL") {
        log.warn(`[siren] ${nodeId}: forecast-based CRITICAL ${aiResult.hazard_type} ignored by the automatic siren ` +
          "(a weather forecast never sounds a village siren)");
      }
      save();
      return;
    }
    const breakClearRun = (family) => {
      const k = prefix + family;
      if (episodes[k] && episodes[k].clear) {
        episodes[k].clear = 0; // still (possibly) going: the all-clear run is broken
        changed = true;
      }
    };
    breakClearRun(familyOf(hazard));

    // The evacuation hazards in this result: the primary (confirmed by the
    // backend) and any MEASURED one hidden in hazard_scores (see
    // HIDDEN_CONFIRM_WINDOW_SECONDS). A non-evacuation primary never sounds
    // by itself and does not raise an evacuation episode's peak either (it
    // is not in this list), so it can never make a later evacuation
    // CRITICAL look like "no escalation".
    const primaryNorm = normHazard(hazard);
    const stuck = stuckFields(sensorData.edge_anomaly);
    const evacuation = [];
    if (autoHazardSet.has(primaryNorm)) {
      evacuation.push({ type: hazard, norm: primaryNorm, severity: aiResult.severity, primary: true });
    }
    const scores = aiResult.hazard_scores && typeof aiResult.hazard_scores === "object" ? aiResult.hazard_scores : {};
    for (const [type, c] of Object.entries(scores)) {
      const norm = normHazard(type);
      if (norm === primaryNorm || !autoHazardSet.has(norm) || !c || typeof c !== "object") continue;
      // MEDIUM+ (a hold by the node's river checks already makes it LOW),
      // measured, and not read from a sensor the node calls stuck
      if (!((SEVERITY_RANK[c.severity] ?? 0) >= SEVERITY_RANK.MEDIUM) || isForecastResult(c) || c.held_by_edge_anomaly) continue;
      if ((HAZARD_SENSOR_FIELDS[norm] || []).some((f) => stuck.has(f))) continue;
      evacuation.push({ type, norm, severity: c.severity, primary: false });
    }
    // Persistence for the hidden ones: an earlier sighting (primary or
    // hidden, any active status) of the same type at this node in the window
    const sightingKey = (norm) => `${prefix}${nodeId}|${norm}`;
    for (const e of evacuation) {
      const seen = (sightings.get(sightingKey(e.norm)) || [])
        .filter((t) => t > readingAt - HIDDEN_CONFIRM_WINDOW_SECONDS * 1000);
      e.persistent = seen.some((t) => t < readingAt);
      seen.push(readingAt);
      sightings.set(sightingKey(e.norm), seen.slice(-5));
    }
    const triggers = evacuation.filter((e) => e.primary || e.persistent);
    for (const e of triggers) breakClearRun(familyOf(e.type));

    if (triggers.length === 0) {
      if (aiResult.severity === "CRITICAL" && aiResult.status === "alert_dispatched" && autoRank !== null &&
          !autoHazardSet.has(primaryNorm)) {
        log.log(`[siren] ${nodeId}: confirmed CRITICAL ${hazard} - not an automatic-siren hazard ` +
          "(SIREN_AUTO_HAZARDS); an officer can still sound it");
      }
      save();
      return;
    }
    if (aiResult.status !== "alert_dispatched" || // pending: not confirmed yet
        (aiResult.delay_seconds ?? 0) > MAX_AUTO_DELAY_SECONDS) { // old backlog
      save();
      return;
    }

    // Most severe first (the primary first on a tie): one result switches
    // the siren on at most once
    triggers.sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || Number(b.primary) - Number(a.primary));
    let fire = null;
    for (const e of triggers) {
      const key = prefix + familyOf(e.type);
      const rank = SEVERITY_RANK[e.severity];
      const previousPeak = episodes[key]?.peak ?? -1;
      episodes[key] = { peak: Math.max(previousPeak, rank), at: Math.max(readingAt, episodes[key]?.at ?? 0), clear: 0 };
      if (!fire && autoRank !== null && rank >= autoRank && rank > previousPeak) {
        fire = { ...e, why: previousPeak < 0 ? "new episode" : "escalation" };
      }
    }
    q.setEpisodes.run(JSON.stringify(episodes), nodeId);

    if (!fire) return;
    // A simulated reading never overrides a real officer's/auto decision,
    // and never puts a request on a row a REAL node reported to (the officer
    // page would show a demo "on" for the real siren and offer only
    // "Silence"). Rows the simulator's own readings made still get it.
    if (simulated && (!row.reported_simulated || (row.desired && !row.desired_simulated))) return;
    const until = new Date(nowMs + defaultOnSeconds * 1000).toISOString();
    q.setDesired.run("on", "auto", "auto", new Date(nowMs).toISOString(), until, simulated ? 1 : 0, nodeId);
    const behind = fire.primary ? "" : `, measured behind the primary ${hazard}`;
    audit(nodeId, "on", "auto",
      `confirmed ${fire.severity} ${fire.type} (${fire.why}${behind})${simulated ? " - SIMULATED reading" : ""}`, nowMs);
    // What just happened, for the officer WhatsApp alert (officer_alerts.js);
    // undefined whenever the siren was NOT switched on by this result.
    // hazard_type = what sounded it (may differ from aiResult.hazard_type).
    return { node_id: nodeId, severity: fire.severity, hazard_type: fire.type, why: fire.why, simulated, until,
      primary_hazard_type: hazard };
  }

  /**
   * Officer on/off. Returns { status, body } for the HTTP answer.
   * actor = the officer's username (or 'api-key').
   */
  function officerAction(nodeId, action, forSeconds, actor, nowMs = Date.now()) {
    const row = q.get.get(nodeId);
    if (!row) return { status: 404, body: { error: `${nodeId} has never reported a siren` } };
    if (action === "on" && !row.fitted) {
      return { status: 409, body: { error: `${nodeId} does not report a siren fitted any more` } };
    }
    const seconds = forSeconds ?? defaultOnSeconds;
    if (action === "on") {
      q.setDesired.run("on", "officer", actor, new Date(nowMs).toISOString(),
        new Date(nowMs + seconds * 1000).toISOString(), 0, nodeId);
    } else {
      q.setDesired.run("off", "officer", actor, new Date(nowMs).toISOString(), null, 0, nodeId);
    }
    audit(nodeId, action, actor, action === "on" ? `for ${seconds} s` : "silenced", nowMs);
    return { status: 200, body: { status: "ok", siren: statusOf(q.get.get(nodeId), nowMs) } };
  }

  /** The siren block for one node, as the officer views show it. */
  function statusOf(row, nowMs = Date.now()) {
    if (!row) return null;
    const want = effectiveDesired(row, nowMs);
    const sounding = Boolean(row.sounding);
    return {
      node_id: row.node_id,
      fitted: Boolean(row.fitted),
      sounding,
      desired: want ? want.siren : null,
      // why it is wanted ('auto' | 'officer'), else why the node says it sounds
      reason: want ? row.desired_reason : sounding ? row.reported_reason : null,
      desired_reason: want ? row.desired_reason : null,
      desired_by: want ? row.desired_by : null,
      until: want && want.siren === "on" ? row.desired_until : null,
      reported_reason: sounding ? row.reported_reason : null,
      reported_at: row.reported_at,
      simulated: Boolean(row.reported_simulated),
      desired_simulated: want ? Boolean(row.desired_simulated) : false,
    };
  }

  const status = (nodeId, nowMs = Date.now()) => statusOf(q.get.get(nodeId), nowMs);
  const list = (nowMs = Date.now()) => q.listShown.all().map((r) => statusOf(r, nowMs));
  const history = (nodeId, limit = 20) => q.auditFor.all(nodeId, limit);

  return {
    recordReported, commandsFor, onAiResult, officerAction, status, list, history,
    autoSeverity: autoRank === null ? "off" : "CRITICAL",
    autoHazards: [...autoHazardSet],
    defaultOnSeconds,
  };
}

module.exports = {
  setupSirens, parseAutoSeverity, parseAutoHazards, newestPerNode, isForecastResult, DEFAULT_AUTO_HAZARDS,
  DEFAULT_ON_SECONDS, MIN_ON_SECONDS, MAX_ON_SECONDS, EPISODE_CLEAR_READINGS, EPISODE_GAP_SECONDS,
};
