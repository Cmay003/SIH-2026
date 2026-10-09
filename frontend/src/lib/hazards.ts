import type { Severity, SosRequest } from "../api/types";

// Same icon per hazard type on every page (dashboard, officer map, SOS).
const HAZARD_ICONS: Record<string, string> = {
  flood: "🌊",
  "gas leak": "☣️",
  fire: "🔥",
  "extreme heat": "🌡️",
  landslide: "⛰️",
  "air pollution": "😷",
  "water quality degradation": "💧",
};

export function hazardIcon(hazardType: string | null | undefined): string {
  return (hazardType && HAZARD_ICONS[hazardType]) || "⚠️";
}

/**
 * Why the SOS's hospital is not the nearest one (server.js skips hospitals
 * inside an active HIGH/CRITICAL zone), or null when it simply is.
 */
export function hospitalZoneNote(sos: Pick<SosRequest, "hospital_skipped" | "hospital_in_hazard_zone">): string | null {
  const s = sos.hospital_skipped;
  if (s) return `nearer ${s.hospital} (${s.distance_km} km) skipped: inside a ${s.hazard_type} zone (${s.severity})`;
  const z = sos.hospital_in_hazard_zone;
  if (z) return `every hospital is in a hazard zone; this one is in a ${z.hazard_type} zone (${z.severity})`;
  return null;
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
