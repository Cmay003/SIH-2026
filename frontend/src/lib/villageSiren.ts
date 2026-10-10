// Officer-facing wording for the village siren on sensor nodes
// (server/siren.js). Pure functions so they can be unit-tested.
// Not the browser alarm sound - that is lib/siren.ts.
import type { Role, SirenStatus } from "../api/types";
import { hazardTitle } from "./alarm";

/** Officers and admins may sound / silence (POST /api/nodes/:id/siren allows both). */
export const canControlSiren = (role: Role | undefined): boolean => role === "officer" || role === "admin";

const clock = (iso: string | null) => {
  const t = iso ? new Date(iso) : null;
  return t && Number.isFinite(t.getTime()) ? t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : null;
};

/** "Sounding" / "Silent" plus who decided - the node's REPORTED state. */
export function sirenStateText(s: SirenStatus): string {
  if (!s.sounding) return "Silent";
  if (s.reported_reason === "auto_offline") return "Sounding - the node decided itself (no gateway contact)";
  if (s.desired === "on" && s.desired_reason === "auto") return "Sounding - automatic (confirmed CRITICAL hazard)";
  if (s.desired === "on" && s.desired_reason === "officer") return `Sounding - sounded by ${s.desired_by ?? "an officer"}`;
  return "Sounding";
}

/**
 * What the server is still waiting for the node to do, or null when the
 * node already does what was asked (or nothing is asked).
 */
export function sirenPendingText(s: SirenStatus): string | null {
  if (s.desired === "on" && !s.sounding) {
    const who = s.desired_reason === "auto" ? "automatic (confirmed CRITICAL hazard)" : `by ${s.desired_by ?? "an officer"}`;
    return `Sound requested ${who} - waiting for the node to report it`;
  }
  if (s.desired === "off" && s.sounding) return "Silence requested - waiting for the node to report it";
  return null;
}

/** "until 14:05" for a running request, else null. */
export function sirenUntilText(s: SirenStatus): string | null {
  const at = s.desired === "on" ? clock(s.until) : null;
  return at ? `until ${at}` : null;
}

/** Whether the button offered is "Sound" (false) or "Silence" (true). */
export const offersSilence = (s: SirenStatus): boolean => s.sounding || s.desired === "on";

export function sirenConfirmText(s: SirenStatus, onSeconds: number): string {
  if (offersSilence(s)) {
    return `Silence the village siren at ${s.node_id}? It stops when the node next reports (normally within a minute).`;
  }
  const minutes = Math.max(1, Math.round(onSeconds / 60));
  return `Sound the village siren at ${s.node_id} for about ${minutes} min? Everyone near the node will hear it. ` +
    "It starts when the node next reports (normally within a minute).";
}

// The server's default SIREN_AUTO_HAZARDS (server/siren.js) - shown when an
// older server does not send the list.
const DEFAULT_AUTO_HAZARDS = ["flood", "flash_flood", "landslide", "fire", "gas_leak"];

/** What the automatic siren sounds for, in words (user decision 2026-10-09: evacuation hazards only). */
export function autoSirenHint(autoHazards: string[] | undefined): string {
  const hazards = autoHazards && autoHazards.length ? autoHazards : DEFAULT_AUTO_HAZARDS;
  const list = hazards.map((h) => hazardTitle(h).toLowerCase()).join(", ");
  // the usual non-evacuation hazards, unless the server was set to include one
  const never = [["extreme_heat", "heat"], ["air_pollution", "air pollution"], ["smoke", "smoke"]]
    .filter(([type]) => !hazards.includes(type)).map(([, words]) => words);
  // a weather forecast never sounds it, whatever the list says (server/siren.js)
  return `Sounds by itself only for a confirmed CRITICAL evacuation hazard at that node (${list}), once per hazard. ` +
    `${never.length ? `${never.join(", ")} and weather forecasts` : "Weather forecasts"}`.replace(/^./, (c) => c.toUpperCase()) +
    " never sound it by themselves. " +
    "HIGH - or any other hazard - is your decision: you can sound it for anything.";
}
