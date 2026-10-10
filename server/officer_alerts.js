// =====================================================================
// SANJEEVNI - WhatsApp alerts to OFFICERS' phones (step W3, 2026-10-09).
//
// Problem statement part 5: "mobile alerts for local authorities". The
// officer map and its siren only help while a page is open; this pushes a
// WhatsApp message to every on-duty officer/admin account that has a phone
// number (node server/create_user.js add <name> officer --phone +91...,
// or set-phone). Viewer accounts are NEVER messaged, whatever is stored.
//
// When:
//  - a CONFIRMED (alert_dispatched) reading at OFFICER_ALERT_MIN_SEVERITY
//    (HIGH by default; CRITICAL is the other allowed value) - once per
//    officer per hazard EPISODE, plus once more if the episode escalates
//    (HIGH -> CRITICAL). Pending (unconfirmed) alerts never go out.
//    A forecast-only alert's text starts "FORECAST:" and says it was not
//    measured by the node.
//  - the village siren switching on AUTOMATICALLY (siren.js): the same
//    message says so; if that officer already had the CRITICAL message for
//    this episode they get a short "siren ON" message instead.
// An episode works like the siren's (siren.js): one hazard FAMILY at one
// node (flood + flash_flood, fire + smoke) from its first confirmed
// reading until EPISODE_CLEAR_READINGS positive all-clear readings in a
// row, or EPISODE_GAP_SECONDS without a confirmed reading. Sensor-fault /
// suppressed results neither feed nor end an episode.
// FORECAST-only alerts (heavy_rain / high_wind whose severity came from the
// weather forecast) are raised at EVERY node in the forecast area, so they
// are one AREA-wide episode per hazard family (episode key FORECAST_AREA,
// not the node): one district-wide forecast = one message per officer, not
// one per node (review 2026-10-09). The area is the whole deployment this
// server runs (one district); such an episode ends only after
// EPISODE_GAP_SECONDS with no forecast alert anywhere - one node's all-clear
// says nothing about the rest of the area. A forecast never sounds a siren
// (siren.js).
//
// Dry run: exactly like the citizen alerts - with no WhatsApp credentials
// (or WHATSAPP_DRY_RUN=1) nothing is sent; the message is logged (phone
// masked) and stored in officer_alert_log with status 'dry_run'.
// Simulated readings (simulator key, judge demo): dry run only, unless
// WHATSAPP_ALERTS_FOR_SIMULATED=1; the message then starts "[SIMULATED]".
// Old store-and-forward backlog (> MAX_ALERT_DELAY_SECONDS late) is never
// pushed: it is on the map, but a phone alert would be about the past.
//
// Every planned message is written to officer_alert_log BEFORE it is sent
// (status 'queued' -> 'sent' / 'dry_run' / 'failed'), so the readings of
// one batch cannot each send their own copy (the citizen path's R4 bug),
// and admins can audit who was told what (GET /api/admin/officer-alerts).
// A failed send is retried by the next confirmed reading of the episode,
// at most MAX_FAILED_PER_EPISODE times per officer.
//
// Meta only lets a business start a conversation with a pre-approved
// TEMPLATE. Create one (category: Utility) with 4 body variables, e.g.
//   "SANJEEVNI officer alert: {{1}} at {{2}}. {{3}}. Officer map: {{4}}"
// and set OFFICER_WHATSAPP_TEMPLATE / OFFICER_WHATSAPP_TEMPLATE_LANG.
// The officer messages are English only (no new Hindi text).
// =====================================================================
const { maskPhone, PHONE_ROLES } = require("./auth");
const { isForecastResult } = require("./siren");

const SEVERITY_RANK = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };
const ACTIVE_SEVERITIES = new Set(["MEDIUM", "HIGH", "CRITICAL"]);
const ACTIVE_STATUSES = new Set(["alert_dispatched", "pending_confirmation"]);
const NOT_A_HAZARD = new Set(["sensor_fault", "none"]);
const EPISODE_FAMILY = { flash_flood: "flood", smoke: "fire" }; // same as siren.js
const familyOf = (hazardType) => EPISODE_FAMILY[hazardType] || hazardType;
// Episode / log node_id of an area-wide forecast episode (no real node id
// can look like this: node ids are letters, digits, - and _ only, 1-12).
const FORECAST_AREA = "forecast:area";

// Demo defaults (not from a standard), the same values as siren.js and the
// citizen alerts so the three channels agree about what "one event" is.
const EPISODE_CLEAR_READINGS = 3;
const EPISODE_GAP_SECONDS = 6 * 3600;
const MAX_ALERT_DELAY_SECONDS = 15 * 60;
const MAX_FAILED_PER_EPISODE = 3;
const MAX_PARAM_LENGTH = 200;
const ALLOWED_MIN = new Set(["HIGH", "CRITICAL"]);

/** OFFICER_ALERT_MIN_SEVERITY -> rank. HIGH (default) or CRITICAL; anything else falls back to HIGH. */
function parseMinSeverity(value, warn = console.warn) {
  const v = String(value ?? "").trim().toUpperCase() || "HIGH";
  if (!ALLOWED_MIN.has(v)) {
    warn(`[officer-alert] OFFICER_ALERT_MIN_SEVERITY=${value} is not HIGH or CRITICAL - using HIGH`);
    return SEVERITY_RANK.HIGH;
  }
  return SEVERITY_RANK[v];
}

// Meta rejects template parameters with newlines, tabs or 4+ spaces in a
// row (same rule as the citizen template in server.js).
const cleanParam = (p) => {
  const text = String(p ?? "").replace(/[\r\n\t]+/g, " ").replace(/ {4,}/g, " ").trim();
  return text.length > MAX_PARAM_LENGTH ? `${text.slice(0, MAX_PARAM_LENGTH - 3)}...` : text || "-";
};

const hazardText = (t) => String(t || "hazard").replace(/_/g, " ");

function setupOfficerAlerts(db, {
  send,                       // async (phoneE164, template, lang, params[4]) - the real WhatsApp send
  dryRun = true,
  allowSimulated = false,     // WHATSAPP_ALERTS_FOR_SIMULATED
  template = "sanjeevni_officer_alert",
  templateLang = "en",
  minSeverity = process.env.OFFICER_ALERT_MIN_SEVERITY,
  publicBaseUrl = "",         // SANJEEVNI_PUBLIC_BASE_URL, for the map link
  nodeLocation = () => null,  // node_id -> "Sector 4, Riverside" | null
  confidenceSummary = () => null,
  episodeClearReadings = EPISODE_CLEAR_READINGS,
  episodeGapSeconds = EPISODE_GAP_SECONDS,
  log = console,
} = {}) {
  const minRank = parseMinSeverity(minSeverity, log.warn);
  const minName = Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === minRank);

  db.exec(`
    CREATE TABLE IF NOT EXISTS officer_alert_episodes (
      node_id TEXT NOT NULL,
      family TEXT NOT NULL,
      simulated INTEGER NOT NULL,
      started_at TEXT NOT NULL,      -- reading time of the first confirmed reading
      peak INTEGER NOT NULL,         -- highest confirmed severity rank so far
      at INTEGER NOT NULL,           -- reading time (ms) of the newest confirmed reading
      clear INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (node_id, family, simulated)
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS officer_alert_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      username TEXT NOT NULL,
      phone TEXT NOT NULL,
      kind TEXT NOT NULL,            -- 'hazard' | 'hazard+siren' | 'siren'
      node_id TEXT NOT NULL,
      hazard_type TEXT,
      family TEXT NOT NULL,
      severity TEXT,
      rank INTEGER NOT NULL,
      episode_started_at TEXT NOT NULL,
      simulated INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,          -- 'queued' | 'sent' | 'dry_run' | 'failed'
      detail TEXT
    )
  `);
  db.exec("CREATE INDEX IF NOT EXISTS officer_alert_log_episode ON officer_alert_log (user_id, node_id, family, episode_started_at)");

  const q = {
    recipients: db.prepare(`
      SELECT id, username, role, phone FROM users
      WHERE active = 1 AND phone IS NOT NULL AND phone <> '' AND role IN (${[...PHONE_ROLES].map(() => "?").join(",")})
      ORDER BY id
    `),
    expire: db.prepare("DELETE FROM officer_alert_episodes WHERE node_id = ? AND simulated = ? AND at < ?"),
    clearUp: db.prepare("UPDATE officer_alert_episodes SET clear = clear + 1 WHERE node_id = ? AND simulated = ? AND at <= ?"),
    clearDone: db.prepare("DELETE FROM officer_alert_episodes WHERE node_id = ? AND simulated = ? AND clear >= ?"),
    clearReset: db.prepare("UPDATE officer_alert_episodes SET clear = 0 WHERE node_id = ? AND family = ? AND simulated = ?"),
    get: db.prepare("SELECT * FROM officer_alert_episodes WHERE node_id = ? AND family = ? AND simulated = ?"),
    insert: db.prepare(`INSERT INTO officer_alert_episodes (node_id, family, simulated, started_at, peak, at, clear)
      VALUES (?, ?, ?, ?, ?, ?, 0)`),
    update: db.prepare("UPDATE officer_alert_episodes SET peak = ?, at = ?, clear = 0 WHERE node_id = ? AND family = ? AND simulated = ?"),
    notifiedRank: db.prepare(`
      SELECT MAX(rank) AS rank FROM officer_alert_log
      WHERE user_id = ? AND node_id = ? AND family = ? AND episode_started_at = ? AND simulated = ?
        AND kind IN ('hazard', 'hazard+siren') AND status IN ('queued', 'sent', 'dry_run')
    `),
    failures: db.prepare(`
      SELECT COUNT(*) AS n FROM officer_alert_log
      WHERE user_id = ? AND node_id = ? AND family = ? AND episode_started_at = ? AND simulated = ? AND status = 'failed'
    `),
    logInsert: db.prepare(`
      INSERT INTO officer_alert_log (at, user_id, username, phone, kind, node_id, hazard_type, family, severity, rank,
        episode_started_at, simulated, status, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)
    `),
    logStatus: db.prepare("UPDATE officer_alert_log SET status = ?, detail = ? WHERE id = ?"),
    recent: db.prepare(`SELECT id, at, username, phone, kind, node_id, hazard_type, severity, simulated, status, detail
      FROM officer_alert_log ORDER BY id DESC LIMIT ?`),
  };

  const mapLink = (nodeId) => {
    const pathPart = `/officer.html?focus=${encodeURIComponent(nodeId)}`;
    const base = String(publicBaseUrl || "").replace(/\/+$/, "");
    return base ? base + pathPart : `${pathPart} on the SANJEEVNI server`;
  };

  let chain = Promise.resolve();

  async function deliver(job) {
    const who = `${job.username} ${maskPhone(job.phone)}`;
    if (dryRun) {
      log.log(`[officer-alert dry-run] ${job.kind} to ${who}: template '${template}' ${JSON.stringify(job.params)}`);
      q.logStatus.run("dry_run", JSON.stringify(job.params), job.logId);
      return;
    }
    try {
      await send(job.phone, template, templateLang, job.params);
      q.logStatus.run("sent", JSON.stringify(job.params), job.logId);
      log.log(`[officer-alert] ${job.kind} sent to ${who} (${job.nodeId} ${job.severity})`);
    } catch (e) {
      const why = e && e.response && e.response.data ? JSON.stringify(e.response.data) : String(e && e.message);
      q.logStatus.run("failed", why.slice(0, 500), job.logId);
      log.error(`[officer-alert] send to ${who} failed: ${why}`);
    }
  }

  function enqueue(jobs) {
    for (const job of jobs) {
      chain = chain.then(() => deliver(job)).catch((e) => log.error(`[officer-alert] ${e.message}`));
    }
  }

  /**
   * Called with every AI result the dashboard stores (reading-time order),
   * after the siren rule. `siren` = what sirens.onAiResult() returned
   * (set only when it just switched a siren on). Returns the planned
   * messages (already logged as 'queued' and handed to the send queue).
   */
  function onAiResult(sensorData, aiResult, { siren = null } = {}, nowMs = Date.now()) {
    if (!aiResult || !sensorData || typeof sensorData.node_id !== "string") return [];
    const nodeId = sensorData.node_id;
    const simulated = sensorData.simulated === true ? 1 : 0;
    const parsedAt = Date.parse(aiResult.timestamp);
    const readingAt = Number.isFinite(parsedAt) ? parsedAt : nowMs;
    q.expire.run(nodeId, simulated, readingAt - episodeGapSeconds * 1000);
    q.expire.run(FORECAST_AREA, simulated, readingAt - episodeGapSeconds * 1000);

    const hazard = String(aiResult.hazard_type || "unknown");
    if (aiResult.status === "logged" && aiResult.severity === "LOW" && !NOT_A_HAZARD.has(hazard)) {
      q.clearUp.run(nodeId, simulated, readingAt);
      q.clearDone.run(nodeId, simulated, episodeClearReadings);
      return [];
    }
    if (!(ACTIVE_SEVERITIES.has(aiResult.severity) && ACTIVE_STATUSES.has(aiResult.status))) return [];
    const family = familyOf(hazard);
    const forecast = isForecastResult(aiResult);
    // a forecast says nothing about what this node measured: it does not
    // break the node's own all-clear run
    if (!forecast) q.clearReset.run(nodeId, family, simulated);
    if (aiResult.status !== "alert_dispatched") return [];

    const rank = SEVERITY_RANK[aiResult.severity];
    const episodeKey = forecast ? FORECAST_AREA : nodeId;
    let episode = q.get.get(episodeKey, family, simulated);
    if (!episode) {
      q.insert.run(episodeKey, family, simulated, new Date(readingAt).toISOString(), rank, readingAt);
    } else {
      q.update.run(Math.max(episode.peak, rank), Math.max(episode.at, readingAt), episodeKey, family, simulated);
    }
    episode = q.get.get(episodeKey, family, simulated);

    const late = (aiResult.delay_seconds ?? 0) > MAX_ALERT_DELAY_SECONDS;
    const wantHazard = rank >= minRank && !late;
    if (!wantHazard && !siren) return [];
    if (simulated && !dryRun && !allowSimulated) {
      log.log(`[officer-alert] not sending: ${hazard} at ${nodeId} is a SIMULATED reading (WHATSAPP_ALERTS_FOR_SIMULATED is off)`);
      return [];
    }

    const sim = simulated ? "[SIMULATED] " : "";
    const location = aiResult.location || nodeLocation(nodeId);
    const place = location ? `${location} (${nodeId})` : nodeId;
    const confidence = confidenceSummary(aiResult);
    // The siren may have been sounded by an evacuation hazard measured
    // behind this reading's primary (siren.js, e.g. a gas leak on a
    // Severe-AQI day): name it, or the message reads "air pollution ->
    // siren ON".
    const sirenFor = siren && siren.hazard_type && siren.hazard_type !== hazard
      ? ` for ${siren.severity} ${hazardText(siren.hazard_type)} (also measured)` : "";
    const sirenText = siren ? `village siren at ${nodeId} switched ON automatically${sirenFor}` : null;
    const nowIso = new Date(nowMs).toISOString();
    const jobs = [];

    for (const user of q.recipients.all(...PHONE_ROLES)) {
      if (!PHONE_ROLES.has(user.role)) continue; // belt and braces: never a viewer
      const args = [user.id, episodeKey, family, episode.started_at, simulated];
      if (q.failures.get(...args).n >= MAX_FAILED_PER_EPISODE) continue;
      const before = q.notifiedRank.get(...args).rank;
      let kind = null;
      let params = null;
      if (wantHazard && (before == null || rank > before)) {
        kind = siren ? "hazard+siren" : "hazard";
        const escalated = before != null
          ? ` (escalated from ${Object.keys(SEVERITY_RANK).find((k) => SEVERITY_RANK[k] === before)})` : "";
        const details = [
          confidence ? `Confidence ${confidence}` : null,
          forecast ? "based on the weather forecast, not measured by the node; one message for the whole area, " +
            "not one per node" : null,
          sirenText,
        ].filter(Boolean);
        params = [
          // A forecast alert is "confirmed" only by its external source (the
          // weather forecast), never by a sensor: it leads with FORECAST so
          // nobody reads it as a measured hazard.
          forecast
            ? `${sim}FORECAST: ${aiResult.severity} ${hazardText(hazard)} forecast for the area${escalated}`
            : `${sim}CONFIRMED ${aiResult.severity} ${hazardText(hazard)}${escalated}`,
          forecast ? `Area-wide forecast, first raised at ${place}` : place,
          details.length ? details.join("; ") : "Check the officer map",
          mapLink(nodeId),
        ];
      } else if (siren) {
        kind = "siren";
        params = [
          `${sim}Village siren ON at ${nodeId}`,
          place,
          `Automatic: confirmed ${siren.severity} ${hazardText(siren.hazard_type)} (${siren.why})`,
          mapLink(nodeId),
        ];
      }
      if (!kind) continue;
      params = params.map(cleanParam);
      const { lastInsertRowid } = q.logInsert.run(nowIso, user.id, user.username, user.phone, kind, episodeKey, hazard,
        family, aiResult.severity, kind === "siren" ? -1 : rank, episode.started_at, simulated, null);
      jobs.push({ logId: Number(lastInsertRowid), username: user.username, phone: user.phone, kind, params,
        nodeId, severity: aiResult.severity });
    }
    enqueue(jobs);
    return jobs.map(({ username, kind, params }) => ({ username, kind, params }));
  }

  /** The newest log rows for the admin audit view (phones masked). */
  function recent(limit = 50) {
    return q.recent.all(limit).map((r) => ({ ...r, phone: maskPhone(r.phone), simulated: Boolean(r.simulated) }));
  }

  log.log(`[officer-alert] WhatsApp alerts to officers: confirmed ${minName}+ and automatic sirens` +
    `${dryRun ? " (DRY RUN - logged, not sent)" : ""}; ${q.recipients.all(...PHONE_ROLES).length} officer phone(s) on file`);

  return { onAiResult, recent, idle: () => chain, minSeverity: minName };
}

module.exports = { setupOfficerAlerts, parseMinSeverity, EPISODE_CLEAR_READINGS, MAX_FAILED_PER_EPISODE, FORECAST_AREA };
