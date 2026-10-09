// Model card helpers (admin page). The card itself comes from
// ml/evaluate_models.py; this file only decides how its numbers are worded,
// so a reader can't mistake a synthetic-data score for field accuracy.
import type { DataProvenance, ModelCard, ModelHeadlineMetric } from "../api/types";

/** Throws when the reply isn't a card the page can render honestly. */
export function parseModelCard(data: unknown): ModelCard {
  const card = data as Partial<ModelCard> | null;
  // The banner is what keeps the numbers honest, so a card without one is
  // refused rather than shown bare.
  if (!card || typeof card !== "object" || !Array.isArray(card.models) || typeof card.banner !== "string") {
    throw new Error("The server sent something that is not a model card.");
  }
  return card as ModelCard;
}

/** Plain words for where data came from - never just the code word. */
export function provenanceText(p: DataProvenance | ModelCard["provenance"] | null): string {
  switch (p) {
    case "SYNTHETIC": return "SYNTHETIC - computer-generated, not real sensor or river data";
    case "REAL": return "Real field data";
    case "MIXED": return "MIXED - some models use computer-generated (synthetic) data";
    case "NONE": return "No model has been evaluated yet";
    default: return "Not recorded - treat as unverified";
  }
}

type MetricKind = "metres" | "score" | "rate";

// Keys follow the card's naming: *_m are metres (LSTM error), AUC / F1 /
// Brier are unitless scores, everything else is a rate (fraction 0..1).
function metricKind(key: string): MetricKind {
  if (key.endsWith("_m")) return "metres";
  if (/(^|_)(roc_auc|auc|f1|macro_f1|brier)($|_)/.test(key)) return "score";
  return "rate";
}

/** A fraction 0..1 as a percentage; small rates keep 2 dp so 0.07% isn't shown as 0.1% or 0%. */
export function formatRate(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  const pct = v * 100;
  if (pct === 0) return "0%";
  return `${Math.abs(pct) < 1 ? pct.toFixed(2) : pct.toFixed(1)}%`;
}

export function formatMetric(key: string, v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  const kind = metricKind(key);
  if (kind === "metres") return `${v.toFixed(3)} m`;
  if (kind === "score") return v.toFixed(3);
  return formatRate(v);
}

export type Comparison = "better" | "worse" | "same" | "none";

/** Per row, so a model that "beats the baseline" overall still shows where it is worse. */
export function compareToBaseline(m: ModelHeadlineMetric): Comparison {
  if (m.value === null || m.baseline === null) return "none";
  if (m.value === m.baseline) return "same";
  return (m.higher_is_better ? m.value > m.baseline : m.value < m.baseline) ? "better" : "worse";
}

export const COMPARISON_TEXT: Record<Comparison, string> = {
  better: "Better",
  worse: "Worse",
  same: "Same",
  none: "No baseline",
};

/** "2026-10-08T10:12:05Z" -> "2026-10-08 10:12 UTC"; anything else as given. */
export function formatUtc(iso: string | null): string {
  if (!iso) return "unknown";
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(:\d{2})?(\.\d+)?Z$/.exec(iso);
  return m ? `${m[1]} ${m[2]} UTC` : iso;
}

export function formatCount(n: number | null): string {
  return n === null ? "-" : n.toLocaleString("en-IN");
}
