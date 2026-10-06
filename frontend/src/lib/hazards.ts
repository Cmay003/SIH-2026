import type { Severity } from "../api/types";

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
