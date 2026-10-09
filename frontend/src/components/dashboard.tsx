// Dashboard building blocks. All server values are rendered as React text
// (auto-escaped) - no innerHTML anywhere, which is what closes the stored
// XSS hole the original pages had (B2).
import type { Hazard, HospitalRoute, SensorRow, Severity } from "../api/types";
import { alarmKey } from "../lib/alarm";
import { hazardIcon, isSevere, orDash, percent, severityClass, staleText } from "../lib/hazards";
import styles from "./Dashboard.module.css";

const officerLink = (nodeId: string) => `/officer.html?focus=${encodeURIComponent(nodeId)}`;

/**
 * Every officer-map link from the dashboard targets this one named tab, so a
 * second click re-uses (and re-focuses) the map tab instead of opening
 * another one. No rel="noopener" on these links: that puts each new tab in
 * its own browsing-context group, where the name is never found again.
 * Same-origin pages, so the opener link is harmless.
 */
export const OFFICER_MAP_TAB = "sanjeevni-officer-map";

/** Open (or re-use) the officer-map tab focused on a node - e.g. after Acknowledge. */
export function openOfficerMap(nodeId: string): void {
  window.open(officerLink(nodeId), OFFICER_MAP_TAB)?.focus();
}

/** Same key the emergency alarm uses (node_id + "|" + hazard_type). */
export const hazardKey = (h: Pick<Hazard, "node_id" | "hazard_type">) => alarmKey(h.node_id, h.hazard_type);

type Tone = Severity | "NONE";

// Severity is never shown by colour alone: every level also gets its own
// shape and its name in text.
const SEVERITY_ICON: Record<Tone, string> = {
  LOW: "✓",
  MEDIUM: "◆",
  HIGH: "▲",
  CRITICAL: "‼",
  NONE: "•",
};

/** Number with a fixed max precision, trailing zeros dropped (2.40 -> "2.4"). */
function fmt(value: number | null | undefined, digits: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";
  return String(Number(value.toFixed(digits)));
}

/** Clamp a 0..1 score to a 0..100 width for the meter bars. */
const meterWidth = (score: number) => `${Math.min(100, Math.max(0, Math.round(score * 100)))}%`;

export function SeverityBadge({ severity, srPrefix }: { severity: string | null | undefined; srPrefix?: string }) {
  const tone = severityClass(severity);
  return (
    <span className={`${styles.badge} ${styles[`tone_${tone}`] ?? ""}`}>
      <span aria-hidden="true">{SEVERITY_ICON[tone]}</span>
      {srPrefix && <span className="visually-hidden">{srPrefix} </span>}
      {tone === "NONE" ? orDash(severity) : tone}
    </span>
  );
}

function RiskMeter({ score }: { score: number | null | undefined }) {
  if (typeof score !== "number") return null;
  return (
    // Decorative: the number next to it carries the value for screen readers
    <span className={styles.meter} aria-hidden="true">
      <span className={styles.meterFill} style={{ width: meterWidth(score) }} />
    </span>
  );
}

// ---------------------------------------------------------------- live bar

export type LiveState = "live" | "stale" | "connecting";

const LIVE_TEXT: Record<LiveState, string> = {
  live: "Live",
  stale: "Connection lost - showing last received data",
  connecting: "Waiting for first data...",
};

export function LiveBar({
  state,
  updatedAt,
  hazardCount,
  severeCount,
}: {
  state: LiveState;
  /** ms epoch of the last successful readings fetch (0 = never) */
  updatedAt: number;
  /** null while the hazard list has not loaded yet */
  hazardCount: number | null;
  severeCount: number;
}) {
  // Deliberately NOT a live region: it changes every 2 s. The header's
  // connection status already announces connect / disconnect.
  return (
    <div className={`${styles.liveBar} ${styles[`live_${state}`] ?? ""}`}>
      <span className={styles.liveState}>
        <span className={styles.liveDot} aria-hidden="true" />
        {LIVE_TEXT[state]}
      </span>
      {updatedAt > 0 && (
        <span className={styles.liveMeta}>
          Last update{" "}
          <time dateTime={new Date(updatedAt).toISOString()}>{new Date(updatedAt).toLocaleTimeString()}</time>
        </span>
      )}
      {hazardCount != null && (
        <span className={styles.counts}>
          <span className={styles.countChip}>
            {hazardCount} active hazard{hazardCount === 1 ? "" : "s"}
          </span>
          <span className={`${styles.countChip} ${severeCount > 0 ? styles.countChipAlert : ""}`}>
            {severeCount > 0 && <span aria-hidden="true">▲ </span>}
            {severeCount} high / critical
          </span>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- KPI tiles

interface Tile {
  label: string;
  value: string;
  unit?: string;
  /** text values (ids, names) use a smaller font than numbers */
  text?: boolean;
  tone?: Tone;
  icon?: string;
  meter?: number | null;
}

export function KpiTiles({
  latest,
  count,
  loading = false,
}: {
  latest: SensorRow | undefined;
  count: number;
  loading?: boolean;
}) {
  const riskTone = latest ? severityClass(latest.risk) : undefined;
  const tiles: Tile[] = [
    { label: "Device", value: orDash(latest?.device_id), text: true },
    {
      label: "Hazard",
      value: latest?.hazard ? latest.hazard.toUpperCase() : "--",
      text: true,
      icon: latest?.hazard ? hazardIcon(latest.hazard) : undefined,
    },
    { label: "Water Level", value: fmt(latest?.water_level, 2), unit: "m" },
    {
      label: "Risk",
      value: orDash(latest?.risk),
      text: true,
      tone: riskTone,
      icon: riskTone ? SEVERITY_ICON[riskTone] : undefined,
    },
    {
      label: "Risk Score",
      value: latest?.risk_score == null ? "--" : String(Math.round(latest.risk_score * 100)),
      unit: "%",
      tone: riskTone,
      meter: latest?.risk_score,
    },
    { label: "Temperature", value: fmt(latest?.temperature, 1), unit: "°C" },
    { label: "Humidity", value: fmt(latest?.humidity, 1), unit: "%" },
    { label: "Data Received", value: String(count), unit: count === 1 ? "reading" : "readings" },
  ];
  return (
    // Label/value pairs, not headings: a description list keeps the page's
    // heading outline (h1 -> h2 sections) clean for screen-reader users.
    <dl className={styles.tiles} aria-label="Latest reading" aria-busy={loading || undefined}>
      {tiles.map((t) => (
        <div className={`${styles.tile} ${t.tone ? styles[`tileTone_${t.tone}`] ?? "" : ""}`} key={t.label}>
          <dt className={styles.tileLabel}>{t.label}</dt>
          <dd className={`${styles.tileValue} ${t.text ? styles.tileText : ""}`}>
            {loading ? (
              <>
                <span className={`${styles.skeleton} ${styles.skeletonText}`} aria-hidden="true" />
                <span className="visually-hidden">Loading</span>
              </>
            ) : (
              <>
                {t.icon && t.value !== "--" && <span className={styles.tileIcon} aria-hidden="true">{t.icon}</span>}
                {t.value}
                {t.unit && t.value !== "--" && <span className={styles.unit}> {t.unit}</span>}
                {t.meter != null && <RiskMeter score={t.meter} />}
              </>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

// ---------------------------------------------------------------- hospital

export function HospitalCard({ route }: { route: HospitalRoute }) {
  return (
    <div className={styles.hospital}>
      <span className={styles.hospitalIcon} aria-hidden="true">🏥</span>
      <div className={styles.hospitalText}>
        <span className={styles.hospitalLabel}>Nearest hospital to {route.node_id}</span>
        <span>
          <strong>{route.hospital}</strong> · {route.distance_km} km
        </span>
      </div>
      <a className={styles.directions} href={route.maps_url} target="_blank" rel="noopener noreferrer">
        Get directions<span className="visually-hidden"> (opens in a new tab)</span>
      </a>
    </div>
  );
}

// ---------------------------------------------------------------- hazards

function HazardTitle({ hazard }: { hazard: Hazard }) {
  return (
    <h3>
      <span aria-hidden="true">{hazardIcon(hazard.hazard_type)}</span> {hazard.label}: {hazard.hazard_type.toUpperCase()}
    </h3>
  );
}

export function CriticalHazard({
  hazard,
  more = 0,
  highlighted = false,
}: {
  hazard: Hazard | undefined;
  /** how many other active hazards are listed below */
  more?: number;
  highlighted?: boolean;
}) {
  if (!hazard) {
    return (
      <div className={styles.allClear}>
        <span aria-hidden="true">✅</span> No critical hazard right now - all nodes within safe range.
      </div>
    );
  }
  const tone = severityClass(hazard.severity);
  return (
    <a className={styles.cardLink} href={officerLink(hazard.node_id)} target={OFFICER_MAP_TAB}>
      <div className={`${styles.critical} ${styles[`critical_${tone}`] ?? ""} ${highlighted ? styles.highlighted : ""}`}>
        <div className={styles.criticalMain}>
          <div className={styles.criticalTop}>
            <SeverityBadge severity={hazard.severity} srPrefix="Severity" />
            {more > 0 && (
              <span className={styles.moreNote}>
                +{more} more below
              </span>
            )}
          </div>
          <HazardTitle hazard={hazard} />
          <div className={styles.location}>
            <span aria-hidden="true">📍</span> {hazard.location} ({hazard.node_id})
          </div>
          {/* when stale, StaleNote says it (the server's text would repeat it) */}
          {hazard.stale !== true && (
            <div className={styles.eta}>
              <span aria-hidden="true">⏱</span> {hazard.prediction_text}
            </div>
          )}
          <StaleNote hazard={hazard} />
          <span className={styles.hint}>
            Open on officer map <span aria-hidden="true">→</span>
          </span>
        </div>
        <div className={styles.criticalScore}>
          {percent(hazard.risk_score)}
          <span className={styles.scoreLabel}>Risk score</span>
        </div>
      </div>
    </a>
  );
}

/** Shown when the hazard's node has stopped reporting: last known state, no alarm. */
function StaleNote({ hazard }: { hazard: Pick<Hazard, "stale" | "last_reading_at"> }) {
  if (hazard.stale !== true) return null;
  return (
    <div className={styles.stale} title={hazard.last_reading_at ? `Last reading: ${hazard.last_reading_at}` : undefined}>
      <span aria-hidden="true">⚠</span> {staleText(hazard.last_reading_at)}
    </div>
  );
}

export function HazardList({ hazards, highlightKey = null }: { hazards: Hazard[]; highlightKey?: string | null }) {
  if (hazards.length === 0) {
    return <p className={styles.empty}>No active hazards - all nodes normal.</p>;
  }
  return (
    <ul className={styles.hazardGrid}>
      {hazards.map((h) => {
        const key = hazardKey(h);
        return (
          <li key={key} className={styles.hazardItem}>
            <a className={styles.cardLink} href={officerLink(h.node_id)} target={OFFICER_MAP_TAB}
               data-hazard-key={key}>
              <article
                className={`${styles.hazardCard} ${styles[severityClass(h.severity)] ?? ""} ${
                  key === highlightKey ? styles.highlighted : ""
                }`}
              >
                <div className={styles.cardHead}>
                  <HazardTitle hazard={h} />
                  <SeverityBadge severity={h.severity} srPrefix="Severity" />
                </div>
                <div className={styles.location}>
                  <span aria-hidden="true">📍</span> {h.location} ({h.node_id})
                </div>
                <div className={styles.scoreRow}>
                  <span>Risk score</span>
                  <span className={styles.score}>{percent(h.risk_score)}</span>
                </div>
                <RiskMeter score={h.risk_score} />
                {h.stale !== true && (
                  <div className={styles.eta}>
                    <span aria-hidden="true">⏱</span> {h.prediction_text}
                  </div>
                )}
                <StaleNote hazard={h} />
                <div className={styles.hint}>
                  <span aria-hidden="true">📌</span> Open on officer map
                </div>
              </article>
            </a>
          </li>
        );
      })}
    </ul>
  );
}

/** Placeholder while the first hazard response is in flight. */
export function HazardSkeleton({ label, cards = 1 }: { label: string; cards?: number }) {
  return (
    <div className={cards > 1 ? styles.skeletonGrid : undefined} aria-busy="true">
      <span className="visually-hidden">{label}</span>
      {Array.from({ length: cards }, (_, i) => (
        <span key={i} className={`${styles.skeleton} ${styles.skeletonCard}`} aria-hidden="true" />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- sensor table

function Measure({ value, digits, unit }: { value: number | null | undefined; digits: number; unit: string }) {
  const text = fmt(value, digits);
  if (text === "--") return <>--</>;
  return (
    <>
      {text}
      <span className={styles.cellUnit}> {unit}</span>
    </>
  );
}

const COLUMNS: { label: string; numeric?: boolean }[] = [
  { label: "ID", numeric: true },
  { label: "Device" },
  { label: "Hazard" },
  { label: "Water Level", numeric: true },
  { label: "Temperature", numeric: true },
  { label: "Humidity", numeric: true },
  { label: "Risk" },
  { label: "Score", numeric: true },
  { label: "Time", numeric: true },
];

export function SensorTable({
  rows,
  loading = false,
  failed = false,
}: {
  rows: SensorRow[];
  loading?: boolean;
  /** the request failed and there is no earlier data to show */
  failed?: boolean;
}) {
  const emptyText = loading ? "Loading readings..." : failed ? "Couldn't load sensor readings." : "No readings yet.";
  return (
    // Focusable so keyboard users can scroll the table (it scrolls on its own
    // both ways: sideways on phones, down on long lists with a sticky header).
    <div className={styles.tableWrap} role="region" aria-label="Sensor readings table"
         tabIndex={0}>
      <table className={styles.table}>
        <thead>
          <tr>
            {COLUMNS.map((c) => (
              <th key={c.label} scope="col" className={c.numeric ? styles.num : undefined}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className={isSevere(r.risk) ? styles.rowSevere : undefined}>
              <td className={`${styles.num} ${styles.muted}`}>{r.id}</td>
              <td className={styles.device}>{r.device_id}</td>
              <td>{r.hazard}</td>
              <td className={styles.num}><Measure value={r.water_level} digits={2} unit="m" /></td>
              <td className={styles.num}><Measure value={r.temperature} digits={1} unit="°C" /></td>
              <td className={styles.num}><Measure value={r.humidity} digits={1} unit="%" /></td>
              <td><SeverityBadge severity={r.risk} /></td>
              <td className={styles.num}>{percent(r.risk_score)}</td>
              <td className={styles.num}>
                <time dateTime={r.timestamp}>{new Date(r.timestamp).toLocaleTimeString()}</time>
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={COLUMNS.length} className={styles.empty}>{emptyText}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
