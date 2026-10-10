// Node-registry form rules for the admin page. They mirror the server
// (backend_server.py NodeConfig / check_node_id / upstream_problem) so
// mistakes show up next to the field - the server still checks everything.
import type { LandUse, NodeConfig } from "../api/types";

/** LoRa packets carry the node id in 12 bytes (SJ_NODE_ID_LEN in sj_packet.h) */
export const NODE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,11}$/;
/**
 * A node with no pinned interval is timed automatically by the backend
 * (backend_server.py nominal_report_interval, user decision 2026-10-09): a
 * normal-time summary every 5 min, every 1 min on a node with a siren (it
 * says siren_fitted), or slower when its readings show a slower cadence
 * (deep sleep). Pinning 60 on a 5-min node would flag it offline after 6 min.
 */
export const NODE_REPORT_INTERVAL_SECONDS = 300;
export const SIREN_NODE_REPORT_INTERVAL_SECONDS = 60;

/** 300 -> "5 min", 90 -> "90 s" */
export function formatInterval(seconds: number): string {
  return seconds >= 60 && seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`;
}

/** What the admin table shows for a node with no pinned interval */
export function autoIntervalText(expectedSeconds?: number | null): string {
  return expectedSeconds && expectedSeconds > 0
    ? `auto (${formatInterval(expectedSeconds)})`
    : `auto (${formatInterval(NODE_REPORT_INTERVAL_SECONDS)}; ${formatInterval(SIREN_NODE_REPORT_INTERVAL_SECONDS)} with a siren)`;
}

/** Typical SCS-CN ranges - the ones the flood model was trained with (flood_risk_model.py) */
export const LAND_USES: { value: LandUse; label: string; cn: [number, number] }[] = [
  { value: "forest", label: "Forest", cn: [35, 55] },
  { value: "agricultural", label: "Agricultural", cn: [55, 75] },
  { value: "urban_low", label: "Urban - low density", cn: [75, 85] },
  { value: "urban_high", label: "Urban - high density", cn: [85, 96] },
];

export const landUseLabel = (value: string) => LAND_USES.find((l) => l.value === value)?.label ?? value;

/** What the form holds: text as typed, so a half-typed number isn't lost */
export interface NodeForm {
  node_id: string;
  location: string;
  land_use: LandUse;
  curve_number: string;
  latitude: string;
  longitude: string;
  upstream_node: string; // "" = none
  report_interval_seconds: string; // "" = default
}

export type NodeFormErrors = Partial<Record<keyof NodeForm, string>>;

export const emptyNodeForm = (): NodeForm => ({
  node_id: "", location: "", land_use: "urban_low", curve_number: "80", latitude: "", longitude: "",
  upstream_node: "", report_interval_seconds: "",
});

export function formFromNode(nodeId: string, n: NodeConfig): NodeForm {
  return {
    node_id: nodeId,
    location: n.location,
    land_use: n.land_use,
    curve_number: String(n.curve_number),
    latitude: String(n.latitude),
    longitude: String(n.longitude),
    upstream_node: n.upstream_node ?? "",
    report_interval_seconds: n.report_interval_seconds == null ? "" : String(n.report_interval_seconds),
  };
}

function numberIn(text: string, min: number, max: number, minInclusive = true): number | null {
  if (text.trim() === "") return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n > max || (minInclusive ? n < min : n <= min)) return null;
  return n;
}

/** Upstream chain from `upstream` would come back to `nodeId` */
function makesLoop(nodeId: string, upstream: string, nodes: Record<string, NodeConfig>): boolean {
  const seen = new Set([nodeId]);
  for (let current: string | null = upstream; current; current = nodes[current]?.upstream_node ?? null) {
    if (seen.has(current)) return true;
    seen.add(current);
  }
  return false;
}

/**
 * Checks the form. `isNew` = creating (the id must be valid and unused).
 * Returns the errors, and the config to send when there are none.
 */
export function validateNodeForm(
  form: NodeForm, nodes: Record<string, NodeConfig>, isNew: boolean,
): { errors: NodeFormErrors; config: NodeConfig | null } {
  const errors: NodeFormErrors = {};
  const id = form.node_id.trim();
  if (isNew) {
    if (!NODE_ID_PATTERN.test(id)) errors.node_id = "1-12 characters: letters, digits, - or _ (LoRa packets hold 12).";
    else if (nodes[id]) errors.node_id = `${id} already exists.`;
  }
  const location = form.location.trim();
  if (!location) errors.location = "Enter where the node is, e.g. \"Sector 4, Riverside\".";
  else if (location.length > 100) errors.location = "At most 100 characters.";

  const cn = numberIn(form.curve_number, 30, 100);
  if (cn === null) errors.curve_number = "A number from 30 to 100.";
  const lat = numberIn(form.latitude, -90, 90);
  if (lat === null) errors.latitude = "Latitude from -90 to 90 (or click the map).";
  const lon = numberIn(form.longitude, -180, 180);
  if (lon === null) errors.longitude = "Longitude from -180 to 180 (or click the map).";

  let interval: number | null = null;
  if (form.report_interval_seconds.trim() !== "") {
    interval = numberIn(form.report_interval_seconds, 0, 86400, false);
    if (interval === null) errors.report_interval_seconds = "Seconds, more than 0 and at most 86400 (1 day) - or leave empty.";
  }

  const upstream = form.upstream_node || null;
  if (upstream) {
    if (upstream === id) errors.upstream_node = "A node can't be its own upstream node.";
    else if (!nodes[upstream]) errors.upstream_node = `${upstream} no longer exists.`;
    else if (makesLoop(id, upstream, nodes)) errors.upstream_node = `${upstream} is already downstream of ${id} - that would make a loop.`;
  }

  if (Object.keys(errors).length) return { errors, config: null };
  return {
    errors,
    config: {
      location, land_use: form.land_use, curve_number: cn!, latitude: lat!, longitude: lon!,
      upstream_node: upstream, report_interval_seconds: interval,
    },
  };
}

/** Curve number outside the usual range for the chosen land use - a hint, not an error */
export function curveNumberHint(landUse: LandUse, curveNumber: string): string | null {
  const range = LAND_USES.find((l) => l.value === landUse)?.cn;
  const cn = Number(curveNumber);
  if (!range || curveNumber.trim() === "" || !Number.isFinite(cn)) return null;
  if (cn < range[0] || cn > range[1]) {
    return `Unusual for ${landUseLabel(landUse).toLowerCase()} (typically ${range[0]}-${range[1]}). Fine if you measured it.`;
  }
  return null;
}
