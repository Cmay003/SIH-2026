// Risk-map additions for the officer view (PS part 4): the "Hotspots" layer
// (where hazards keep coming back, from GET /api/officer/heatmap) and the
// latest value of every sensor a node carries (GET /api/officer/nodes/:id/latest).
// No chart library: Leaflet circles in their own pane, plain HTML tables.
// Colours come from fixed values or CSS classes, never inline style=""
// attributes (the page's Content-Security-Policy blocks those).
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Circle, Pane, Popup } from "react-leaflet";
import { apiGet } from "../api/client";
import type { HeatmapResponse, Hotspot, NodeHealth, NodeLatestResponse, SirenStatus } from "../api/types";
import {
  HOTSPOT_COLOR, HOTSPOT_LEVEL_TEXT, HOTSPOT_RANGES, hotspotRadiusM, nodeSensorView, readingAge, type HotspotRange,
} from "../lib/sensors";
import { sirenPendingText } from "../lib/villageSiren";
import styles from "./Officer.module.css";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hasPosition = (h: Hotspot): h is Hotspot & { latitude: number; longitude: number } =>
  typeof h.latitude === "number" && typeof h.longitude === "number";

// ---- map layer --------------------------------------------------------------
/**
 * Always mounted (the pane must exist once); draws nothing while the layer is
 * off. Its pane sits under the live hazard zones and markers (overlayPane is
 * 400), so a hotspot never hides a zone or an SOS pin from a click.
 */
export function HotspotLayer({ hotspots, days }: { hotspots: Hotspot[]; days: number | null }) {
  return (
    <Pane name="sanjeevni-hotspots" style={{ zIndex: 350 }}>
      {hotspots.filter(hasPosition).map((h) => {
        const color = HOTSPOT_COLOR[h.level];
        return (
          <Circle key={`hot:${h.node_id}`} center={[h.latitude, h.longitude]} radius={hotspotRadiusM(h.intensity)}
                  pathOptions={{ color, weight: 2, dashArray: "2 6", fillColor: color,
                                 fillOpacity: 0.12 + 0.3 * Math.min(Math.max(h.intensity, 0), 1) }}>
            <Popup><HotspotDetails hotspot={h} days={days} /></Popup>
          </Circle>
        );
      })}
    </Pane>
  );
}

function HotspotDetails({ hotspot: h, days }: { hotspot: Hotspot; days: number | null }) {
  return (
    <div className={styles.popup}>
      <strong>Hotspot · {h.node_id}</strong>
      <div>{h.location}</div>
      <div><strong>{HOTSPOT_LEVEL_TEXT[h.level]}</strong> ({pct(h.intensity)} of readings elevated{days ? `, last ${days} days` : ""})</div>
      <div>{h.high_count} HIGH/CRITICAL and {h.medium_count} MEDIUM of {h.reading_count} readings</div>
      <div>Hazard on {h.days_with_high} of {h.days_reported} days with data</div>
      {h.max_risk_score != null && <div>Highest risk score: {pct(h.max_risk_score)}</div>}
      <div className={styles.muted}><em>Simulated (demo) readings are included</em></div>
    </div>
  );
}

// ---- side panel ---------------------------------------------------------------
// Same words as server.js HOTSPOT_DEFINITION, for a server that does not send them yet
const HOTSPOT_DEFINITION_FALLBACK =
  "A hotspot is a node where hazards keep coming back. Intensity = (elevated readings + half the MEDIUM ones) / " +
  "all readings the node sent in the window.";

export function HotspotSection({ range, onRangeChange, data, isPending, error, onShow }: {
  range: HotspotRange;
  onRangeChange: (r: HotspotRange) => void;
  data: HeatmapResponse | undefined;
  isPending: boolean;
  error: Error | null;
  onShow: (h: Hotspot) => void;
}) {
  const list = data?.hotspots ?? [];
  return (
    <section className={styles.section} aria-labelledby="hotspot-section-title">
      <h2 id="hotspot-section-title" className={styles.sectionTitle}>Hotspots</h2>
      <fieldset className={styles.rangeGroup}>
        <legend className={styles.rangeLegend}>Hotspot layer on the map</legend>
        {HOTSPOT_RANGES.map((r) => (
          <label key={r.value} className={styles.rangeOption}>
            <input type="radio" name="hotspot-range" value={r.value} checked={range === r.value}
                   onChange={() => onRangeChange(r.value)} />
            {r.label}
          </label>
        ))}
      </fieldset>
      {range === "off" && <p className={styles.muted}>Shows where hazards keep coming back, from stored readings.</p>}
      {range !== "off" && data && (
        <p className={styles.muted} id="hotspot-definition">
          <strong>What is a hotspot?</strong> {data.definition || HOTSPOT_DEFINITION_FALLBACK}
          {data.basis ? ` ${data.basis}` : ""}
        </p>
      )}
      {range !== "off" && isPending && <p className={styles.muted}>Loading hotspots...</p>}
      {range !== "off" && error && <p className={styles.errorText} role="status">Hotspots unavailable: {error.message}</p>}
      {range !== "off" && data && (
        <>
          <p className={styles.dataNote}><strong>Includes SIMULATED data.</strong> {data.data_note}</p>
          {list.length === 0 && <div className={styles.ok}>No readings in the last {data.days} days</div>}
          {list.length > 0 && (
            <ol className={styles.zoneList} aria-label={`Hotspots, last ${data.days} days, most frequent first`}
                aria-describedby="hotspot-definition">
              {list.map((h) => (
                <li key={h.node_id}>
                  <button type="button" className={styles.zoneBtn} disabled={!hasPosition(h)} onClick={() => onShow(h)}>
                    <span className={`${styles.hotSwatch} ${styles[`hot_${h.level}`]}`} aria-hidden="true" />
                    <span className={styles.zoneText}>
                      <span className={styles.zoneName}>{h.node_id} · {h.location}</span>
                      <span className={styles.zoneMeta}>
                        {HOTSPOT_LEVEL_TEXT[h.level]} - {pct(h.intensity)} of readings elevated, hazard on {h.days_with_high} of{" "}
                        {h.days_reported} days{hasPosition(h) ? "" : " · no map position"}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <HotspotLegend edges={data.level_edges} />
        </>
      )}
    </section>
  );
}

// What counts as "elevated" is in the definition paragraph above the list.
function HotspotLegend({ edges }: { edges: HeatmapResponse["level_edges"] }) {
  return (
    <>
      <p className={styles.legendSub}>Hotspot circles (dotted, purple)</p>
      <ul className={styles.legendList}>
        <li><span className={`${styles.hotSwatch} ${styles.hot_high}`} aria-hidden="true" />
          {HOTSPOT_LEVEL_TEXT.high}: {pct(edges.high)} or more of readings elevated</li>
        <li><span className={`${styles.hotSwatch} ${styles.hot_moderate}`} aria-hidden="true" />
          {HOTSPOT_LEVEL_TEXT.moderate}: {pct(edges.moderate)} to {pct(edges.high)}</li>
        <li><span className={`${styles.hotSwatch} ${styles.hot_low}`} aria-hidden="true" />
          {HOTSPOT_LEVEL_TEXT.low}: under {pct(edges.moderate)}</li>
        <li>Bigger circle = more often elevated (a display scale, not a measured area).</li>
      </ul>
    </>
  );
}

// ---- latest sensor values -------------------------------------------------------
function sirenText(s: SirenStatus | null): string {
  if (!s) return "no siren";
  const pending = sirenPendingText(s);
  return `${s.sounding ? "SOUNDING" : "silent"}${pending ? ` (${pending})` : ""}`;
}

/**
 * Every fitted sensor's latest value, with units; PM2.5/PM10 with their CPCB
 * NAQI band. Sensors the node does not have are listed on one "No sensor"
 * line. Fetched only while shown (an open popup or panel entry).
 */
export function NodeSensorValues({ nodeId }: { nodeId: string }) {
  const q = useQuery({
    queryKey: ["node-latest", nodeId],
    queryFn: () => apiGet<NodeLatestResponse>(`/api/officer/nodes/${encodeURIComponent(nodeId)}/latest`),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  if (q.isPending) return <div className={styles.muted}>Loading sensor values...</div>;
  if (q.isError) return <div className={styles.muted}>Sensor values unavailable: {q.error.message}</div>;
  const latest = q.data.latest;
  if (!latest) {
    return (
      <div className={styles.sensorBlock}>
        <div className={styles.muted}>No reading stored for this node yet</div>
        <div>Village siren: {sirenText(q.data.siren)}</div>
      </div>
    );
  }
  const view = nodeSensorView(latest);
  const hasPm = view.rows.some((r) => r.row.field === "pm25_ugm3" || r.row.field === "pm10_ugm3");
  const age = readingAge(latest.reading_at);
  return (
    <div className={styles.sensorBlock}>
      <div className={styles.sensorMeta}>
        Latest reading{age ? ` ${age}` : ""}{latest.link ? ` via ${latest.link}` : ""}
        {latest.simulated && <span className={styles.simBadge}>SIMULATED</span>}
      </div>
      <table className={styles.sensorTable}>
        <caption className="visually-hidden">Latest sensor values at {nodeId}</caption>
        <tbody>
          {view.rows.map(({ row, text }) => (
            <tr key={row.field}>
              <th scope="row">{row.label}</th>
              <td>{text}{row.note && <span className={styles.sensorNote}>{row.note}</span>}</td>
            </tr>
          ))}
          <tr>
            <th scope="row">Village siren</th>
            <td>{sirenText(q.data.siren)}</td>
          </tr>
        </tbody>
      </table>
      {view.noSensor.length > 0 && <div className={styles.noSensor}>No sensor: {view.noSensor.join(", ")}</div>}
      {hasPm && (
        <div className={styles.sensorNote}>
          NAQI band from CPCB's table, which rates 24-hour averages - one reading gives an indicative band only.
        </div>
      )}
    </div>
  );
}

/** Keyboard / screen-reader path to every node's values (the map markers are not focusable). */
export function NodeValuesList({ nodes }: { nodes: NodeHealth[] }) {
  const [open, setOpen] = useState<string | null>(null);
  if (nodes.length === 0) return null;
  return (
    <>
      <h3 className={styles.subTitle}>Latest sensor values</h3>
      <ul className={styles.valuesList}>
        {nodes.map((n) => {
          const panelId = `node-values-${n.node_id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
          const isOpen = open === n.node_id;
          return (
            <li key={n.node_id}>
              <button type="button" className={styles.valuesBtn} aria-expanded={isOpen} aria-controls={panelId}
                      onClick={() => setOpen(isOpen ? null : n.node_id)}>
                <span aria-hidden="true">{isOpen ? "▾" : "▸"}</span> {n.node_id}{" "}
                <span className={styles.valuesLocation}>· {n.location}</span>
              </button>
              <div id={panelId} hidden={!isOpen} className={styles.valuesPanel}>
                {isOpen && <NodeSensorValues nodeId={n.node_id} />}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}
