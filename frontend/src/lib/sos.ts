// Decision logic for the citizen SOS page - pure functions so they can be
// unit-tested. Behaviour matches the classic sos.html exactly.
import type { HazardZone, Severity } from "../api/types";
import { haversineMeters } from "./geo";
import { SEVERITY_RANK } from "./severity";

export interface Coords {
  latitude: number;
  longitude: number;
}

export interface AreaRisk {
  severity: Severity;
  score: number; // 0-100
  zone: HazardZone | null;
}

/** The most severe hazard zone the user is inside (LOW if none). */
export function evaluateArea(coords: Coords | null, zones: HazardZone[]): AreaRisk {
  if (!coords) return { severity: "LOW", score: 0, zone: null };
  let best: HazardZone | null = null;
  for (const z of zones) {
    const inside = haversineMeters(coords.latitude, coords.longitude, z.latitude, z.longitude) <= z.radius_m;
    if (inside && (!best || SEVERITY_RANK[z.severity] > SEVERITY_RANK[best.severity])) best = z;
  }
  return best
    ? { severity: best.severity, score: Math.round(best.risk_score * 100), zone: best }
    : { severity: "LOW", score: 0, zone: null };
}

export type SosHint = "sending" | "active" | "locating" | "needLocation" | "highRisk" | "available";

/**
 * Whether the SOS button is enabled, and which hint to show.
 * RULE (team decision 2026-10-06): once the person's location is known,
 * SOS is ALWAYS available - an emergency doesn't have to be one a sensor
 * detected (house fire, medical, collapse). Being inside a HIGH/CRITICAL
 * zone only changes the hint. Still locked while sending, while this
 * device already has an unresolved SOS, and until a location is known
 * (responders need to know where to go).
 * (Previously SOS unlocked ONLY inside a HIGH/CRITICAL sensor zone.)
 */
export function sosGate(state: {
  sending: boolean;
  deviceActive: boolean;
  hasLocation: boolean;
  /** true once getting the location failed (denied / unavailable) */
  locationFailed?: boolean;
  severity: Severity;
}): { enabled: boolean; hint: SosHint } {
  if (state.sending) return { enabled: false, hint: "sending" };
  if (state.deviceActive) return { enabled: false, hint: "active" };
  if (!state.hasLocation) return { enabled: false, hint: state.locationFailed ? "needLocation" : "locating" };
  const high = state.severity === "HIGH" || state.severity === "CRITICAL";
  return { enabled: true, hint: high ? "highRisk" : "available" };
}

/**
 * A device fix less exact than this (metres) is "approximate". Devices
 * without GPS (most laptops, some phones, GPS off) still answer with a
 * Wi-Fi / cell / IP position that can be kilometres off. Same value as
 * APPROX_LOCATION_M in server.js and the classic pages.
 */
export const APPROX_LOCATION_M = 500;

/** The browser's coords.accuracy as a usable number of metres, or null. */
export function accuracyOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** true when a device fix may be off by more than APPROX_LOCATION_M (unknown = not flagged). */
export function isApproximateFix(accuracyM: number | null | undefined): boolean {
  return accuracyM != null && accuracyM > APPROX_LOCATION_M;
}

/** "±35 m", "±2.3 km", "±12 km" */
export function formatAccuracy(accuracyM: number): string {
  if (accuracyM < 1000) return `±${Math.round(accuracyM)} m`;
  const km = accuracyM / 1000;
  return `±${km < 10 ? km.toFixed(1) : Math.round(km)} km`;
}

/** One id per browser, so a device can't queue a second SOS. */
export function newDeviceId(): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(36).padStart(2, "0")).join("");
  return `dev-${Date.now().toString(36)}-${random}`;
}
