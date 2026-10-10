// "What the public is told" for a hazard, on the STAFF pages (dashboard,
// officer map, emergency alarm). The citizen SOS page bundles the advice
// table (lib/advice.ts); the staff pages fetch it from the server
// (/hazard-advice.json = data/hazard_advice.json) only when an officer
// opens the section, so the ~27 kB table stays out of their bundles.
// Officers see the English text the citizen page and the WhatsApp alerts
// use, so what they say on the phone matches what people were sent.
import { apiGet } from "../api/client";
import type { Severity } from "../api/types";

interface RawEntry {
  name?: { en?: unknown };
  whatsapp?: { en?: unknown };
  actions?: { MEDIUM?: { en?: unknown }; HIGH?: { en?: unknown } };
}
export interface AdviceTableJson {
  hazards?: Record<string, RawEntry>;
  default?: RawEntry;
}

export interface PublicAdvice {
  /** "Heavy rain"; the generic name for a type the table does not know */
  name: string;
  /** the one line the WhatsApp alert carries */
  whatsapp: string | null;
  /** 2-3 actions for this severity (MEDIUM paragraph, or HIGH for HIGH/CRITICAL) */
  actions: string[];
  /** false when the table has no entry for this type and the default was used */
  specific: boolean;
}

export const ADVICE_URL = "/hazard-advice.json";
export const fetchAdviceTable = (): Promise<AdviceTableJson> => apiGet<AdviceTableJson>(ADVICE_URL);

let cached: Promise<AdviceTableJson> | null = null;
/** The table, fetched once per page; a failed fetch is forgotten so re-opening tries again. */
export function loadAdviceTable(): Promise<AdviceTableJson> {
  if (!cached) {
    cached = fetchAdviceTable().catch((e: unknown) => {
      cached = null;
      throw e;
    });
  }
  return cached;
}
/** Tests only: forget the cached table. */
export const resetAdviceCache = (): void => {
  cached = null;
};

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const lines = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === "string" && s.trim() !== "") : [];

/** The advice for one hazard + severity, or null when the table is unusable. LOW = no actions. */
export function publicAdviceFor(
  table: AdviceTableJson | null | undefined, hazardType: string | null | undefined, severity: Severity | string,
): PublicAdvice | null {
  if (!table || typeof table !== "object") return null;
  const hazards = table.hazards && typeof table.hazards === "object" ? table.hazards : {};
  // hasOwn: a hazard_type such as "constructor" must not reach Object.prototype
  const specific = !!hazardType && Object.hasOwn(hazards, hazardType);
  const entry = specific ? hazards[hazardType!] : table.default;
  if (!entry) return null;
  const level = severity === "MEDIUM" ? "MEDIUM" : severity === "HIGH" || severity === "CRITICAL" ? "HIGH" : null;
  return {
    name: text(entry.name?.en) ?? (hazardType ? hazardType.replace(/_/g, " ") : "Hazard"),
    whatsapp: text(entry.whatsapp?.en),
    actions: level ? lines(entry.actions?.[level]?.en) : [],
    specific,
  };
}
