// Dashboard building blocks. All server values are rendered as React text
// (auto-escaped) - no innerHTML anywhere, which is what closes the stored
// XSS hole the original pages had (B2).
import type { Hazard, HospitalRoute, SensorRow } from "../api/types";
import { hazardIcon, orDash, percent, severityClass } from "../lib/hazards";
import styles from "./Dashboard.module.css";

const officerLink = (nodeId: string) => `/officer.html?focus=${encodeURIComponent(nodeId)}`;

export function KpiTiles({ latest, count }: { latest: SensorRow | undefined; count: number }) {
  const tiles: [string, string][] = [
    ["Device", orDash(latest?.device_id)],
    ["Hazard", latest?.hazard ? latest.hazard.toUpperCase() : "--"],
    ["Water Level", orDash(latest?.water_level, " m")],
    ["Risk", orDash(latest?.risk)],
    ["Risk Score", latest?.risk_score == null ? "--" : latest.risk_score.toFixed(2)],
    ["Temperature", orDash(latest?.temperature, " °C")],
    ["Humidity", orDash(latest?.humidity, " %")],
    ["Data Received", String(count)],
  ];
  return (
    // Label/value pairs, not headings: a description list keeps the page's
    // heading outline (h1 -> h2 sections) clean for screen-reader users.
    <dl className={styles.tiles} aria-label="Latest reading">
      {tiles.map(([label, value]) => (
        <div className={styles.tile} key={label}>
          <dt className={styles.tileLabel}>{label}</dt>
          <dd className={styles.tileValue}>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HospitalCard({ route }: { route: HospitalRoute }) {
  return (
    <div className={styles.hospital}>
      Nearest hospital to {route.node_id}: <strong>{route.hospital}</strong> ({route.distance_km} km) —{" "}
      <a href={route.maps_url} target="_blank" rel="noopener noreferrer">
        Get directions
      </a>
    </div>
  );
}

function HazardTitle({ hazard }: { hazard: Hazard }) {
  return (
    <h3>
      <span aria-hidden="true">{hazardIcon(hazard.hazard_type)}</span> {hazard.label}: {hazard.hazard_type.toUpperCase()}
    </h3>
  );
}

export function CriticalHazard({ hazard }: { hazard: Hazard | undefined }) {
  if (!hazard) {
    return <div className={styles.allClear}>✅ No critical hazard right now - all nodes within safe range.</div>;
  }
  return (
    <a className={styles.cardLink} href={officerLink(hazard.node_id)} target="_blank" rel="noopener">
      <div className={styles.critical}>
        <div>
          <HazardTitle hazard={hazard} />
          <div className={styles.location}>
            📍 {hazard.location} ({hazard.node_id})
          </div>
          <div className={styles.eta}>⏱ {hazard.prediction_text}</div>
        </div>
        <div className={styles.criticalScore}>
          {percent(hazard.risk_score)}
          <span className={styles.scoreLabel}>Risk score</span>
        </div>
      </div>
    </a>
  );
}

export function HazardList({ hazards }: { hazards: Hazard[] }) {
  if (hazards.length === 0) {
    return <p className={styles.empty}>No active hazards - all nodes normal.</p>;
  }
  return (
    <div className={styles.hazardGrid}>
      {hazards.map((h) => (
        <a key={`${h.node_id}-${h.hazard_type}`} className={styles.cardLink} href={officerLink(h.node_id)}
           target="_blank" rel="noopener">
          <article className={`${styles.hazardCard} ${styles[severityClass(h.severity)] ?? ""}`}>
            <HazardTitle hazard={h} />
            <div className={styles.location}>
              📍 {h.location} ({h.node_id})
            </div>
            <div className={styles.scoreRow}>
              <span>Risk score</span>
              <span className={styles.score}>{percent(h.risk_score)}</span>
            </div>
            <div className={styles.eta}>⏱ {h.prediction_text}</div>
            <div className={styles.hint}>📌 Open on officer map</div>
          </article>
        </a>
      ))}
    </div>
  );
}

export function SensorTable({ rows }: { rows: SensorRow[] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {["ID", "Device", "Hazard", "Water Level", "Temperature", "Humidity", "Risk", "Score", "Time"].map((h) => (
              <th key={h} scope="col">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{r.device_id}</td>
              <td>{r.hazard}</td>
              <td>{orDash(r.water_level, " m")}</td>
              <td>{orDash(r.temperature, " °C")}</td>
              <td>{orDash(r.humidity, " %")}</td>
              <td className={styles[`risk_${severityClass(r.risk)}`]}>{r.risk}</td>
              <td>{r.risk_score == null ? "--" : r.risk_score.toFixed(2)}</td>
              <td>{new Date(r.timestamp).toLocaleTimeString()}</td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={9} className={styles.empty}>No readings yet.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
