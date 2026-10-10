// "Confidence: High (82%)" plus the reasons behind it, for one alert. Used
// on dashboard hazard cards, the top-hazard callout, the officer zone list
// and map popups, and the emergency alarm pop-up - the same wording
// everywhere. Shown NEXT TO the severity, never instead of it: lists stay
// in severity / risk order, so an uncertain CRITICAL is still on top.
// Renders nothing for an alert without a score (stored before it existed).
import type { ConfidenceFields } from "../api/types";
import { confidenceLevel, confidenceReasons, confidenceText, joinReasons } from "../lib/hazards";
import styles from "./Confidence.module.css";

// A shape for each level as well as the word, so the level never depends on
// colour alone (three filled bars = High).
const BARS = { High: "▮▮▮", Medium: "▮▮▯", Low: "▮▯▯" } as const;

export function Confidence({
  value,
  maxReasons = Infinity,
  className,
}: {
  value: ConfidenceFields | null | undefined;
  /** cards show a few reasons; popups show them all */
  maxReasons?: number;
  className?: string;
}) {
  const text = confidenceText(value);
  if (!text) return null;
  const level = confidenceLevel(value);
  const reasons = confidenceReasons(value, maxReasons);
  return (
    <div className={`${styles.confidence} ${level ? styles[`level_${level}`] ?? "" : ""} ${className ?? ""}`}
         data-confidence={level ?? "unlabelled"}>
      <span className={styles.text}>
        {level && <span className={styles.bars} aria-hidden="true">{BARS[level]}</span>}
        {text}
      </span>
      {reasons.length > 0 && <span className={styles.reasons}>{joinReasons(reasons)}</span>}
    </div>
  );
}
