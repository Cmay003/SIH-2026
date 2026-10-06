import type { Severity } from "../api/types";

export const SEVERITY_RANK: Record<Severity, number> = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 };

/** Map colours (same as the classic officer page). */
export function severityMapColor(severity: string): string {
  if (severity === "HIGH" || severity === "CRITICAL") return "red";
  if (severity === "MEDIUM") return "orange";
  return "yellow";
}
