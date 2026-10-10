import type { ConfidenceFields, ConfidenceLabel, Severity, SosRequest } from "../api/types";
import { formatAccuracy, isApproximateFix } from "./sos";

// Same icon per hazard type on every page (dashboard, officer map, SOS).
// Keys use spaces: hazardIcon() also accepts "flash_flood" and the alarm's
// "Flash flood" title. Flash flood and smoke get their own icons so an
// officer can tell them from a slow flood / a fire / smog at a glance.
const HAZARD_ICONS: Record<string, string> = {
  flood: "🌊",
  "flash flood": "⏫",
  "gas leak": "☣️",
  fire: "🔥",
  smoke: "💨",
  "extreme heat": "🌡️",
  landslide: "⛰️",
  "air pollution": "😷",
  "water quality degradation": "💧",
  // forecast / rain-gauge alerts (backend contract 2026-10-09; never above HIGH from a forecast alone)
  "heavy rain": "🌧️",
  "high wind": "🌬️",
};

export function hazardIcon(hazardType: string | null | undefined): string {
  const key = hazardType ? hazardType.replace(/[_-]+/g, " ").trim().toLowerCase() : "";
  // hasOwn: a hazard_type such as "constructor" must not reach Object.prototype
  return (key && Object.hasOwn(HAZARD_ICONS, key) && HAZARD_ICONS[key]) || "⚠️";
}

/** "flash_flood" -> "flash flood" for lists and popups (the other types already use spaces). */
export const hazardTypeText = (hazardType: string): string => hazardType.replace(/_/g, " ");

// ---------------------------------------------------------------- confidence

const CONFIDENCE_LABELS: readonly ConfidenceLabel[] = ["High", "Medium", "Low"];
/** How many of the backend's reasons a card shows (the officer popup shows them all). */
export const CARD_REASONS = 3;

const validScore = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const validLabel = (v: unknown): v is ConfidenceLabel => CONFIDENCE_LABELS.includes(v as ConfidenceLabel);

/**
 * "Confidence: High (82%)" / "Confidence: High" / "Confidence: 82%", or
 * null when the alert has no confidence (stored before the score existed):
 * the pages then show nothing rather than a made-up value.
 */
export function confidenceText(c: ConfidenceFields | null | undefined): string | null {
  const label = validLabel(c?.confidence_label) ? c!.confidence_label : null;
  const pct = validScore(c?.confidence) ? `${Math.round(c!.confidence * 100)}%` : null;
  if (label && pct) return `Confidence: ${label} (${pct})`;
  if (label || pct) return `Confidence: ${label || pct}`;
  return null;
}

/** The label, for styling (null = none given). */
export const confidenceLevel = (c: ConfidenceFields | null | undefined): ConfidenceLabel | null =>
  validLabel(c?.confidence_label) ? c!.confidence_label! : null;

/** Non-empty reasons, at most `max`. */
export function confidenceReasons(c: ConfidenceFields | null | undefined, max = Infinity): string[] {
  const list = Array.isArray(c?.confidence_reasons) ? c!.confidence_reasons! : [];
  return list.filter((r): r is string => typeof r === "string" && r.trim() !== "").slice(0, max);
}

/**
 * The reasons as one line: "Confirmed: the same node measured it again;
 * node's own check also flags it (URGENT)". The backend writes each reason
 * as its own sentence ("Node's own check ..."), so a reason after the first
 * starts lower case - unless its first word is an ID or acronym ("NODE-07",
 * "IMD"), which keeps its capitals.
 */
export function joinReasons(reasons: readonly string[]): string {
  return reasons
    .map((r, i) => (i > 0 && /^[A-Z][a-z]/.test(r) ? r[0].toLowerCase() + r.slice(1) : r))
    .join("; ");
}

/** true when the alert carries any confidence information at all. */
export const hasConfidence = (c: ConfidenceFields | null | undefined): boolean => confidenceText(c) !== null;

/**
 * Why the SOS's hospital is not the nearest one (server.js skips hospitals
 * inside an active HIGH/CRITICAL zone), or null when it simply is.
 */
export function hospitalZoneNote(sos: Pick<SosRequest, "hospital_skipped" | "hospital_in_hazard_zone">): string | null {
  const s = sos.hospital_skipped;
  if (s) return `nearer ${s.hospital} (${s.distance_km} km) skipped: inside ${zoneArticle(s.hazard_type)} zone (${s.severity})`;
  const z = sos.hospital_in_hazard_zone;
  if (z) return `every hospital is in a hazard zone; this one is in ${zoneArticle(z.hazard_type)} zone (${z.severity})`;
  return null;
}

/** "a flood", "an extreme heat", "a flash flood" (was "a extreme heat", "a flash_flood"). */
function zoneArticle(hazardType: string): string {
  const text = hazardTypeText(hazardType);
  return `${/^[aeiou]/i.test(text) ? "an" : "a"} ${text}`;
}

/**
 * Officer-facing label for an SOS whose point the person placed by hand on
 * a map (location denied/unavailable/slow): it can be off by a street or
 * more, so responders should confirm it - null for a device location.
 */
export function manualLocationNote(sos: Pick<SosRequest, "location_source">): string | null {
  return sos.location_source === "manual"
    ? "Location set by hand on a map by the caller - approximate, confirm it when you reach them"
    : null;
}

type SosLocationFields = Pick<SosRequest, "location_source" | "location_accuracy_m" | "node_id">;

/** "±35 m" / "±2.3 km" when the caller's device reported how exact its fix was, else null. */
export function sosAccuracyText(sos: Pick<SosRequest, "location_accuracy_m">): string | null {
  return sos.location_accuracy_m != null ? formatAccuracy(sos.location_accuracy_m) : null;
}

/** true for a device fix that may be off by more than APPROX_LOCATION_M (e.g. a device without GPS). */
export function isApproximateSos(sos: SosLocationFields): boolean {
  return sos.location_source !== "manual" && sos.location_source !== "node" && sos.location_source !== "hotspot" &&
    isApproximateFix(sos.location_accuracy_m);
}

/**
 * Officer warning for a device fix that may be far off: a phone or laptop
 * without GPS still reports a Wi-Fi / cell / IP position, sometimes
 * kilometres from the person - null when the fix is exact enough or unknown.
 */
export function approximateLocationNote(sos: SosLocationFields): string | null {
  return isApproximateSos(sos)
    ? `Approximate location (${formatAccuracy(sos.location_accuracy_m!)}) - confirm with the caller`
    : null;
}

/**
 * Label for an SOS from the push-button on a LoRa sensor node (someone with
 * no phone). The pin is the node's registered position, which is exact in
 * the sense that the person is at the node - no "approximate" wording.
 */
export function nodeButtonNote(sos: SosLocationFields): string | null {
  return sos.location_source === "node"
    ? `SOS button on node ${sos.node_id || "(unknown node)"} - location is the node's position`
    : null;
}

/**
 * Label for an SOS from the offline "SANJEEVNI-SOS" Wi-Fi page on a gateway
 * or node. Browsers give a plain-http page no location, so the pin is the
 * node's position (the person is within Wi-Fi range of it) - or coordinates
 * the person typed, which nobody has checked. null for other channels.
 */
export function hotspotNote(
  sos: Pick<SosRequest, "location_source" | "node_id"> & { location_accuracy_m?: number | null; latitude?: number | null },
): string | null {
  if (sos.location_source !== "hotspot") return null;
  const at = `via offline SOS Wi-Fi at ${sos.node_id || "(unknown node)"}`;
  if (sos.latitude == null) return `${at} - the hotspot has no registered position`;
  if (sos.location_accuracy_m != null) return `${at} - within ~${Math.round(sos.location_accuracy_m)} m`;
  return `${at} - location typed by the person (unverified)`;
}

/** "3 people · needs: trapped, injured" for an offline SOS Wi-Fi request; null when neither was given. */
export function peopleNeedsText(sos: { people?: number | null; needs?: readonly string[] | null }): string | null {
  const parts: string[] = [];
  if (sos.people != null) parts.push(sos.people === 1 ? "1 person" : `${sos.people} people`);
  if (sos.needs && sos.needs.length) parts.push(`needs: ${sos.needs.join(", ")}`);
  return parts.length ? parts.join(" · ") : null;
}

export function isSevere(severity: string | null | undefined): boolean {
  return severity === "HIGH" || severity === "CRITICAL";
}

export function severityClass(severity: string | null | undefined): Severity | "NONE" {
  return severity === "LOW" || severity === "MEDIUM" || severity === "HIGH" || severity === "CRITICAL"
    ? severity
    : "NONE";
}

export const percent = (score: number | null | undefined): string =>
  score == null ? "--" : `${Math.round(score * 100)}%`;

export const orDash = (value: number | string | null | undefined, unit = ""): string =>
  value == null || value === "" ? "--" : `${value}${unit}`;

/** "just now", "12 min ago", "3.4 h ago", "2 d ago" - null when the timestamp is missing or unparseable. */
export function relativeAge(ts: string | null | undefined, now: number = Date.now()): string | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  if (!Number.isFinite(t)) return null;
  const min = Math.max(0, (now - t) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${Math.round(min)} min ago`;
  const h = min / 60;
  if (h < 48) return `${Number(h.toFixed(1))} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Label for a hazard whose node has stopped reporting (server sets `stale`). */
export function staleText(lastReadingAt: string | null | undefined, now: number = Date.now()): string {
  const age = relativeAge(lastReadingAt, now);
  return `Stale - last reading ${age ?? "time unknown"}; node may be offline`;
}
