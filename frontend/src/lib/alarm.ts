// Emergency alarm: which HIGH/CRITICAL hazards should pop up (and sound)
// right now. The decision logic is pure functions so it can be tested
// without React or audio; the small storage-backed stores at the bottom
// hold the acknowledgements (per tab) and the sound preference.
import type { Hazard, HazardZone } from "../api/types";
import { readStored, writeStored } from "./storage";

export type AlarmSeverity = "HIGH" | "CRITICAL";

export interface AlarmItem {
  key: string;
  severity: AlarmSeverity;
  title: string;
  location: string;
  nodeId: string;
  riskScore: number | null;
  detail: string | null;
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

/** "gas_leak" / "gas leak" -> "Gas leak" */
export function hazardTitle(hazardType: string): string {
  const words = hazardType.replace(/[_-]+/g, " ").trim().replace(/\s+/g, " ");
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Hazard";
}

const score = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

/** One item per key - if the API repeats a key, keep the more severe / riskier one. */
function dedupe(items: AlarmItem[]): AlarmItem[] {
  const byKey = new Map<string, AlarmItem>();
  for (const item of items) {
    const prev = byKey.get(item.key);
    if (!prev || compareAlarmItems(item, prev) < 0) byKey.set(item.key, item);
  }
  return [...byKey.values()];
}

/**
 * Dashboard: /api/hazards already lists confirmed hazards only. Stale ones
 * (the node has stopped reporting) stay visible on the page but never alarm.
 */
export function alarmItemsFromHazards(hazards: Hazard[]): AlarmItem[] {
  return dedupe(
    hazards
      .filter((h) => isAlarmSeverity(h.severity) && h.stale !== true)
      .map((h) => ({
        key: alarmKey(h.node_id, h.hazard_type),
        severity: h.severity as AlarmSeverity,
        title: hazardTitle(h.hazard_type),
        location: h.location || h.node_id,
        nodeId: h.node_id,
        riskScore: score(h.risk_score),
        detail: h.prediction_text || null,
      })),
  );
}

/** Officer map: zones can include pending (unconfirmed) ones - those never alarm, nor do stale ones. */
export function alarmItemsFromZones(zones: HazardZone[]): AlarmItem[] {
  return dedupe(
    zones
      .filter((z) => z.confirmed === true && isAlarmSeverity(z.severity) && z.stale !== true)
      .map((z) => ({
        key: alarmKey(z.node_id, z.hazard_type),
        severity: z.severity as AlarmSeverity,
        title: hazardTitle(z.hazard_type),
        location: z.node_id, // zones carry no location text
        nodeId: z.node_id,
        riskScore: score(z.risk_score),
        detail: null,
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
