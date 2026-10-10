// Emergency alarm: which HIGH/CRITICAL hazards should pop up (and sound)
// right now. The decision logic is pure functions so it can be tested
// without React or audio; the small storage-backed stores at the bottom
// hold the acknowledgements (per tab) and the sound preference.
import type { ConfidenceFields, Hazard, HazardZone, Role } from "../api/types";
import { readStored, writeStored } from "./storage";

export type AlarmSeverity = "HIGH" | "CRITICAL";

export interface AlarmItem {
  key: string;
  severity: AlarmSeverity;
  title: string;
  /** the backend's hazard_type ("heavy_rain") - for the icon and the public advice */
  hazardType: string;
  location: string;
  nodeId: string;
  riskScore: number | null;
  detail: string | null;
  /** the AI backend's confidence in this alert - shown, never used to order or filter the alarm */
  confidence?: ConfidenceFields;
  /**
   * Set on an AREA-WIDE forecast item (see groupForecastItems): every node
   * the forecast alert was raised at, most severe first. nodeId is then the
   * first of them (where "Show" goes).
   */
  forecastNodeIds?: string[];
  /** per-node keys (alarmKey) of the members of an area-wide forecast item, most severe first */
  memberKeys?: string[];
}

/** One acknowledgement: the severity it was acknowledged at, and when the hazard was last seen active. */
export interface AckEntry {
  severity: AlarmSeverity;
  lastSeen: number;
  /** when the hazard was first seen active BELOW the acknowledged severity (cleared when it returns to it) */
  lowerSince?: number;
}

/** key -> acknowledgement */
export type AckMap = Record<string, AckEntry>;

/**
 * An acknowledged hazard must have been gone this long before its return
 * alarms again. Readings near a threshold flicker HIGH -> MEDIUM -> HIGH
 * (the server reports only the latest reading per node and the backend has
 * no hysteresis); without a hold-off every flicker would re-sound the siren.
 * Matches the backend's 10-minute confirmation window.
 */
export const ACK_HOLD_MS = 10 * 60_000;
/** lastSeen is rewritten at most this often, so refreshAcks rarely creates a new object. */
const LAST_SEEN_THROTTLE_MS = 15_000;

export const ACK_STORAGE_KEY = "sanjeevni.alarm.ack";
export const SOUND_STORAGE_KEY = "sanjeevni.alarm.sound";
export const ALERT_TITLE_PREFIX = "(!) ALERT - ";

const RANK: Record<AlarmSeverity, number> = { HIGH: 0, CRITICAL: 1 };

function isAlarmSeverity(value: unknown): value is AlarmSeverity {
  return value === "HIGH" || value === "CRITICAL";
}

export const alarmKey = (nodeId: string, hazardType: string): string => `${nodeId}|${hazardType}`;
/** Key of the one area-wide item for forecast-based alerts of a hazard type ("|" never occurs in a node id). */
export const forecastAlarmKey = (hazardType: string): string => `forecast|${hazardType}`;
/** The key of the card / zone that "Show" should go to: the most severe member of a forecast group. */
export const showKeyOf = (item: AlarmItem): string => item.memberKeys?.[0] ?? item.key;

/**
 * The pop-up + siren is for the people who respond: officers only. Viewers
 * and admins still see every hazard on the page, just without the alarm.
 * (To give admins the alarm too, add "admin" here.)
 */
const ALARM_ROLES: readonly Role[] = ["officer"];
export const receivesAlarm = (role: Role | undefined): boolean => role !== undefined && ALARM_ROLES.includes(role);

/** "gas_leak" / "gas leak" -> "Gas leak" */
export function hazardTitle(hazardType: string): string {
  const words = hazardType.replace(/[_-]+/g, " ").trim().replace(/\s+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Hazard";
}

const score = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** The confidence fields of a hazard/zone, or nothing at all when it has none (older readings). */
function confidenceOf(c: ConfidenceFields): { confidence?: ConfidenceFields } {
  if (c.confidence == null && c.confidence_label == null && c.confidence_reasons == null) return {};
  return {
    confidence: {
      confidence: c.confidence ?? null,
      confidence_label: c.confidence_label ?? null,
      confidence_reasons: c.confidence_reasons ?? null,
    },
  };
}

/** One item per key - if the API repeats a key, keep the more severe / riskier one. */
function dedupe(items: AlarmItem[]): AlarmItem[] {
  const byKey = new Map<string, AlarmItem>();
  for (const item of items) {
    const prev = byKey.get(item.key);
    if (!prev || compareAlarmItems(item, prev) < 0) byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** How many node ids a forecast item's text names before "and N more". */
const FORECAST_NODES_NAMED = 5;

/** "NODE-01, NODE-02 and 3 more" */
export function nodeListText(nodeIds: string[], named: number = FORECAST_NODES_NAMED): string {
  if (nodeIds.length <= named) return nodeIds.join(", ");
  return `${nodeIds.slice(0, named).join(", ")} and ${nodeIds.length - named} more`;
}

/**
 * A FORECAST-based alert (severity from the weather forecast, server field
 * forecast_based) is raised at EVERY node in the forecast area - one
 * regional heavy-rain forecast used to open one pop-up item per node. Those
 * are grouped into ONE area-wide item per hazard type ("Heavy rain forecast
 * - 3 nodes"), at the most severe member's severity, risk score and
 * confidence. Its key does not depend on which nodes are in it, so a node
 * joining an acknowledged forecast does not re-alarm; an escalation still
 * does (alarmingItems). Measured alerts are left exactly as they were - one
 * item per node and hazard type (the same rule as the officer WhatsApp
 * alerts, server/officer_alerts.js).
 */
export function groupForecastItems(items: Array<AlarmItem & { forecastBased: boolean }>): AlarmItem[] {
  const measured: AlarmItem[] = [];
  const groups = new Map<string, AlarmItem[]>();
  for (const { forecastBased, ...item } of items) {
    if (!forecastBased) {
      measured.push(item);
      continue;
    }
    const key = forecastAlarmKey(item.hazardType);
    const members = groups.get(key);
    if (members) members.push(item);
    else groups.set(key, [item]);
  }
  const grouped = [...groups.entries()].map(([key, members]): AlarmItem => {
    const sorted = dedupe(members).sort(compareAlarmItems);
    const top = sorted[0];
    const nodeIds = [...new Set(sorted.map((m) => m.nodeId))];
    return {
      ...top,
      key,
      title: `${hazardTitle(top.hazardType)} forecast - ${plural(nodeIds.length, "node")}`,
      location: "Forecast area",
      detail: `Based on the weather forecast for the area, not measured by the nodes. Raised at ${nodeListText(nodeIds)}.`,
      forecastNodeIds: nodeIds,
      memberKeys: sorted.map((m) => m.key),
    };
  });
  return [...dedupe(measured), ...grouped];
}

/**
 * Dashboard: /api/hazards already lists confirmed hazards only. Stale ones
 * (the node has stopped reporting) stay visible on the page but never alarm.
 * Forecast-based ones become one area-wide item per hazard type.
 */
export function alarmItemsFromHazards(hazards: Hazard[]): AlarmItem[] {
  return groupForecastItems(
    hazards
      .filter((h) => isAlarmSeverity(h.severity) && h.stale !== true)
      .map((h) => ({
        key: alarmKey(h.node_id, h.hazard_type),
        severity: h.severity as AlarmSeverity,
        title: hazardTitle(h.hazard_type),
        hazardType: h.hazard_type,
        location: h.location || h.node_id,
        nodeId: h.node_id,
        riskScore: score(h.risk_score),
        detail: h.prediction_text || null,
        ...confidenceOf(h),
        forecastBased: h.forecast_based === true,
      })),
  );
}

/**
 * Officer map: zones can include pending (unconfirmed) ones - those never
 * alarm, nor do stale ones. Forecast-based ones are grouped as above.
 */
export function alarmItemsFromZones(zones: HazardZone[]): AlarmItem[] {
  return groupForecastItems(
    zones
      .filter((z) => z.confirmed === true && isAlarmSeverity(z.severity) && z.stale !== true)
      .map((z) => ({
        key: alarmKey(z.node_id, z.hazard_type),
        severity: z.severity as AlarmSeverity,
        title: hazardTitle(z.hazard_type),
        hazardType: z.hazard_type,
        location: z.node_id, // zones carry no location text
        nodeId: z.node_id,
        riskScore: score(z.risk_score),
        detail: null,
        ...confidenceOf(z),
        forecastBased: z.forecast_based === true,
      })),
  );
}

/** Most severe first: CRITICAL before HIGH, then higher risk score, then key (stable). */
export function compareAlarmItems(a: AlarmItem, b: AlarmItem): number {
  const bySeverity = RANK[b.severity] - RANK[a.severity];
  if (bySeverity !== 0) return bySeverity;
  const byScore = (b.riskScore ?? -1) - (a.riskScore ?? -1);
  if (byScore !== 0) return byScore;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/**
 * Items that must alarm: never acknowledged, or more severe now than when
 * they were acknowledged (HIGH -> CRITICAL escalation alarms again).
 * Returned most severe first.
 */
export function alarmingItems(items: AlarmItem[], acks: AckMap): AlarmItem[] {
  return items
    .filter((item) => {
      const acked = acks[item.key]?.severity;
      return !acked || RANK[item.severity] > RANK[acked];
    })
    .sort(compareAlarmItems);
}

/** Record that these items were seen at their current severity (never lowers a stored severity). */
export function acknowledgeItems(acks: AckMap, items: AlarmItem[], now: number = Date.now()): AckMap {
  const next: AckMap = { ...acks };
  for (const item of items) {
    const prev = next[item.key];
    // keep lowerSince only when the (higher) stored severity is kept
    const keep = prev && RANK[prev.severity] > RANK[item.severity];
    next[item.key] = keep ? { ...prev, lastSeen: now } : { severity: item.severity, lastSeen: now };
  }
  return next;
}

/**
 * Keep acknowledgements in step with the feed:
 *  - a hazard that is still active refreshes its lastSeen (throttled);
 *  - a hazard that is missing keeps its acknowledgement for holdMs, so a
 *    brief dip below HIGH does not set the siren off again;
 *  - after holdMs without being seen the acknowledgement is dropped, so a
 *    hazard that really ended and later comes back alarms again;
 *  - a hazard acknowledged at CRITICAL that stays active at HIGH for holdMs
 *    has its acknowledgement lowered to HIGH, so a later CRITICAL alarms again
 *    (a shorter CRITICAL -> HIGH -> CRITICAL flicker stays acknowledged);
 *  - a lastSeen in the future (the clock went backwards) is re-stamped to now,
 *    so the entry neither sticks forever nor skips the hold-off.
 * Returns the SAME object when nothing changed (cheap equality for React state).
 */
export function refreshAcks(acks: AckMap, items: AlarmItem[], now: number = Date.now(), holdMs: number = ACK_HOLD_MS): AckMap {
  const current = new Map(items.map((i) => [i.key, i.severity] as const));
  let next: AckMap | null = null;
  const edit = (): AckMap => (next ??= { ...acks });
  for (const [key, entry] of Object.entries(acks)) {
    if (now < entry.lastSeen || (entry.lowerSince !== undefined && now < entry.lowerSince)) {
      // clock went backwards: treat as seen now and restart the hold-off
      edit()[key] = { severity: entry.severity, lastSeen: now };
      continue;
    }
    const age = now - entry.lastSeen;
    if (age > holdMs) {
      delete edit()[key]; // gone too long (or back after a long gap): alarm again next time
      continue;
    }
    const sev = current.get(key);
    if (sev === undefined) continue; // missing: keep the acknowledgement during the hold-off
    let updated: AckEntry = entry;
    if (RANK[sev] < RANK[entry.severity]) {
      // active, but below the acknowledged level (CRITICAL acknowledged, now HIGH)
      if (entry.lowerSince === undefined) updated = { ...entry, lowerSince: now };
      else if (now - entry.lowerSince >= holdMs) updated = { severity: sev, lastSeen: now }; // settled lower
    } else if (entry.lowerSince !== undefined) {
      // back at the acknowledged level: the flicker ended
      updated = { severity: entry.severity, lastSeen: entry.lastSeen };
    }
    if (age >= LAST_SEEN_THROTTLE_MS && updated.lastSeen !== now) updated = { ...updated, lastSeen: now };
    if (updated !== entry) edit()[key] = updated;
  }
  return next ?? acks;
}

// ---- acknowledgements: sessionStorage (this tab only; storage may be unavailable) ----

export function readAcks(): AckMap {
  try {
    const raw = window.sessionStorage.getItem(ACK_STORAGE_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const acks: AckMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (isAlarmSeverity(v)) {
        acks[k] = { severity: v, lastSeen: Date.now() }; // older format: severity only
      } else if (v && typeof v === "object") {
        const { severity, lastSeen, lowerSince } = v as Record<string, unknown>;
        if (isAlarmSeverity(severity) && typeof lastSeen === "number" && Number.isFinite(lastSeen)) {
          const now = Date.now();
          // a timestamp in the future (clock moved back) is clamped to now
          const entry: AckEntry = { severity, lastSeen: Math.min(lastSeen, now) };
          if (typeof lowerSince === "number" && Number.isFinite(lowerSince)) entry.lowerSince = Math.min(lowerSince, now);
          acks[k] = entry;
        }
      }
    }
    return acks;
  } catch {
    return {};
  }
}

export function writeAcks(acks: AckMap): void {
  try {
    if (Object.keys(acks).length === 0) window.sessionStorage.removeItem(ACK_STORAGE_KEY);
    else window.sessionStorage.setItem(ACK_STORAGE_KEY, JSON.stringify(acks));
  } catch {
    /* not persisted - acknowledgements still hold until the page reloads */
  }
}

// ---- sound preference: localStorage "on"/"off" (default on), shared by the
// alarm and every AlarmSoundToggle on the page. Kept in memory too, so muting
// still works when storage is blocked. ----

let soundOn: boolean | null = null;
const soundListeners = new Set<() => void>();

export const alarmSoundPref = {
  get(): boolean {
    if (soundOn === null) soundOn = readStored(SOUND_STORAGE_KEY) !== "off";
    return soundOn;
  },
  set(on: boolean): void {
    soundOn = on;
    writeStored(SOUND_STORAGE_KEY, on ? "on" : "off");
    soundListeners.forEach((l) => l());
  },
  subscribe(listener: () => void): () => void {
    soundListeners.add(listener);
    // Another tab muted/unmuted: follow it
    const onStorage = (e: StorageEvent) => {
      if (e.key !== SOUND_STORAGE_KEY) return;
      soundOn = e.newValue !== "off";
      listener();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      soundListeners.delete(listener);
      window.removeEventListener("storage", onStorage);
    };
  },
  /** tests only: forget the cached value so the next get() re-reads storage */
  reset(): void {
    soundOn = null;
  },
};
