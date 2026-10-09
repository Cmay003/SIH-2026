// What a citizen should do, per hazard - read from the SAME table the
// server uses for WhatsApp alerts (data/hazard_advice.json, worded from
// data/sample_sops/). Bundled at build time, so the advice shows the moment
// the hazard zone does, with no extra request that could fail.
// HUMAN REVIEW: safety-critical citizen advice. Every Hindi string in the
// table still needs a native-speaker check (the file says so in _hi_status).
import table from "../../../data/hazard_advice.json";
import type { Severity } from "../api/types";
import type { Lang } from "./i18n";

type ByLang<T> = Record<Lang, T>;
export interface HazardAdviceEntry {
  source: string;
  name: ByLang<string>;
  whatsapp: ByLang<string>;
  actions: { MEDIUM: ByLang<string[]>; HIGH: ByLang<string[]> };
}
interface AdviceTable {
  hazards: Record<string, HazardAdviceEntry>;
  default: HazardAdviceEntry;
}

export const ADVICE = table as AdviceTable;

function entryFor(hazardType: string | null | undefined): HazardAdviceEntry {
  // hasOwn: a hazard_type such as "constructor" must not reach Object.prototype
  return hazardType && Object.hasOwn(ADVICE.hazards, hazardType) ? ADVICE.hazards[hazardType] : ADVICE.default;
}

/** "Flood" / "बाढ़"; generic "Hazard" for a type the table doesn't know. */
export function hazardName(hazardType: string | null | undefined, lang: Lang): string {
  return entryFor(hazardType).name[lang];
}

/**
 * 2-3 things to do now. MEDIUM follows the SOP's MEDIUM paragraph; HIGH and
 * CRITICAL the HIGH one (the SOPs have no separate CRITICAL step). LOW = no
 * zone, so no actions.
 */
export function hazardActions(hazardType: string | null | undefined, severity: Severity, lang: Lang): string[] {
  if (severity === "LOW") return [];
  const level = severity === "MEDIUM" ? "MEDIUM" : "HIGH";
  return entryFor(hazardType).actions[level][lang];
}
