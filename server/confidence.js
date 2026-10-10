// Confidence score per alert (round 2026-10-09, item D).
//
// The Python backend works the score out (an explainable formula over
// confirmation status, agreement with the node's own edge verdict, data
// quality and model calibration - see backend_server.py) and returns
//   confidence: 0..1, confidence_label: "High"|"Medium"|"Low",
//   confidence_reasons: ["short", "strings"]
// with each AI result. This file only CLEANS those fields before they are
// stored in sensor_data and shown to officers and the public: they come
// over HTTP and end up in HTML pages and WhatsApp messages, so anything
// that does not match the contract is dropped rather than guessed at. A
// missing or malformed score is shown as "no confidence given", never as
// a made-up one.

const LABELS = { high: "High", medium: "Medium", low: "Low" };
// Reasons are one-line explanations ("confirmed by neighbour node"); the
// caps only stop a broken backend from filling the dashboard.
const MAX_REASONS = 8;
const MAX_REASON_LENGTH = 120;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g;

/** 0..1 rounded to 3 places, or null. Out-of-range values are dropped, not clamped: 1.7 is a bug, not "very sure". */
function cleanScore(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) return null;
  return Math.round(value * 1000) / 1000;
}

/** "High" | "Medium" | "Low" (any letter case accepted), else null. */
function cleanLabel(value) {
  if (typeof value !== "string") return null;
  const key = value.trim().toLowerCase();
  // hasOwn: "constructor" must not find Object.prototype's
  return Object.hasOwn(LABELS, key) ? LABELS[key] : null;
}

/** Array of short single-line strings, or null when none were sent. */
function cleanReasons(value) {
  if (value == null) return null;
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    let text = item.replace(CONTROL_CHARS, " ").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > MAX_REASON_LENGTH) text = `${text.slice(0, MAX_REASON_LENGTH - 3).trimEnd()}...`;
    out.push(text);
    if (out.length === MAX_REASONS) break;
  }
  return out;
}

/** The three confidence fields of one AI result, cleaned (each may be null). */
function cleanConfidence(aiResult) {
  const r = aiResult || {};
  return {
    confidence: cleanScore(r.confidence),
    confidence_label: cleanLabel(r.confidence_label),
    confidence_reasons: cleanReasons(r.confidence_reasons),
  };
}

/** Values for the sensor_data columns (confidence, confidence_label, confidence_reasons as JSON text). */
function confidenceColumns(aiResult) {
  const c = cleanConfidence(aiResult);
  return [c.confidence, c.confidence_label, c.confidence_reasons ? JSON.stringify(c.confidence_reasons) : null];
}

/**
 * The confidence fields of a stored sensor_data row, for an API answer.
 * Rows from before the columns existed (or an unreadable reasons column)
 * give nulls. Cleaned again on the way out: the column is plain text that
 * anything with database access could have written.
 */
function confidenceFromRow(row) {
  let reasons = null;
  if (row && typeof row.confidence_reasons === "string") {
    try {
      reasons = JSON.parse(row.confidence_reasons);
    } catch {
      reasons = null;
    }
  }
  return {
    confidence: cleanScore(row?.confidence),
    confidence_label: cleanLabel(row?.confidence_label),
    confidence_reasons: Array.isArray(reasons) ? cleanReasons(reasons) : null,
  };
}

/**
 * "High (82%)", "High", "82%" or null - the short form used in the WhatsApp
 * alert and in log lines. Same wording as the web pages ("Confidence: ...").
 */
function confidenceSummary(aiResult) {
  const c = cleanConfidence(aiResult);
  const pct = c.confidence == null ? null : `${Math.round(c.confidence * 100)}%`;
  if (c.confidence_label && pct) return `${c.confidence_label} (${pct})`;
  return c.confidence_label || pct;
}

module.exports = { cleanConfidence, confidenceColumns, confidenceFromRow, confidenceSummary };
