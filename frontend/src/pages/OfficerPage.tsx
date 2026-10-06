import "leaflet/dist/leaflet.css";
import { useQuery } from "@tanstack/react-query";
import type L from "leaflet";
import { useRef, useState } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import { apiGet } from "../api/client";
import type { HazardZonesResponse, NodeHealthResponse, SosListResponse, SosRequest } from "../api/types";
import { UserChip } from "../components/AppHeader";
import styles from "../components/Officer.module.css";
import {
  FocusOnNode, HazardZones, NODE_LEVEL_COLOR, NodeMarkers, SosMarkers, useResolveAllSos, useResolveSos,
} from "../components/officerMap";

const CENTER: [number, number] = [29.3919, 79.4542];

export function OfficerPage() {
  // Same refresh rates as the classic page
  const zones = useQuery({
    queryKey: ["zones", "officer"],
    queryFn: () => apiGet<HazardZonesResponse>("/api/hazard-zones?include_pending=1"),
    refetchInterval: 5000,
  });
  const sos = useQuery({
    queryKey: ["sos"],
    queryFn: () => apiGet<SosListResponse>("/api/sos"),
    refetchInterval: 5000,
  });
  const health = useQuery({
    queryKey: ["node-health"],
    queryFn: () => apiGet<NodeHealthResponse>("/api/node-health"),
    refetchInterval: 10_000,
  });
  const markerRefs = useRef(new Map<string, L.Marker>());
  const mapRef = useRef<L.Map | null>(null);

  // Keyboard / screen-reader path to an SOS without using the map
  const showSosOnMap = (s: SosRequest) => {
    mapRef.current?.flyTo([s.latitude, s.longitude], 16, { duration: 1 });
    setTimeout(() => markerRefs.current.get(`sos:${s.id}`)?.openPopup(), 1100);
  };
  const focusNode = new URLSearchParams(window.location.search).get("focus");
  const zoneList = zones.data?.zones ?? [];

  return (
    <div className={styles.page}>
      <div className={styles.map} role="region" aria-label="Hazard map (the SOS queue in the side panel lists the same requests)">
      <MapContainer center={CENTER} zoom={12} className={styles.map} ref={mapRef}>
        <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                   attribution="&copy; OpenStreetMap contributors" />
        <HazardZones zones={zoneList} markerRefs={markerRefs} />
        <SosMarkers requests={sos.data?.data ?? []} markerRefs={markerRefs} />
        <NodeMarkers nodes={health.data?.nodes ?? []} />
        <FocusOnNode nodeId={focusNode} zones={zoneList} markerRefs={markerRefs} />
      </MapContainer>
      </div>
      <OfficerPanel sos={sos.data} health={health.data} loadError={zones.isError || sos.isError} onShowSos={showSosOnMap} />
    </div>
  );
}

function OfficerPanel({ sos, health, loadError, onShowSos }: {
  sos: SosListResponse | undefined;
  health: NodeHealthResponse | undefined;
  loadError: boolean;
  onShowSos: (s: SosRequest) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const resolveAll = useResolveAllSos();
  const attention = health?.nodes.filter((n) => n.issues.length) ?? [];

  const onResolveAll = () => {
    if (window.confirm("Mark ALL open SOS requests as resolved? This cannot be undone.")) resolveAll.mutate();
  };

  return (
    <aside className={`${styles.panel} ${collapsed ? styles.collapsed : ""}`} aria-label="Officer panel">
      <button type="button" className={styles.collapse} aria-expanded={!collapsed}
              onClick={() => setCollapsed((c) => !c)}>
        {collapsed ? "Show" : "Hide"}
      </button>
      <h1>🚨 SANJEEVNI - Officer View</h1>
      <div className={styles.body}>
        <div className={styles.chipRow}><UserChip variant="light" /></div>

        {loadError && <div className={styles.errorText}>Can't reach the server - retrying...</div>}
        {sos && sos.count > 0 && (
          <>
            <div>
              Open SOS requests: <span className={styles.count}>{sos.count}</span>
              {sos.escalated_count > 0 && <> · <span className={styles.count}>{sos.escalated_count} escalated</span></>}
            </div>
            <button type="button" className={styles.resolveAll} onClick={onResolveAll} disabled={resolveAll.isPending}>
              {resolveAll.isPending ? "Resolving..." : "Resolve all"}
            </button>
            <SosQueue requests={sos.data} onShow={onShowSos} />
          </>
        )}
        {sos && sos.count === 0 && <div className={styles.allClear}>✅ All SOS requests resolved</div>}

        <section className={styles.section}>
          <h2 className={styles.sectionTitle}>
            Sensor nodes:{" "}
            {health
              ? `${health.summary.online} online, ${health.summary.offline} offline` +
                (health.summary.never_seen ? `, ${health.summary.never_seen} never seen` : "")
              : "-"}
          </h2>
          {health && attention.length === 0 && <div className={styles.ok}>All nodes reporting normally</div>}
          {attention.map((n) => (
            <div key={n.node_id} className={styles.nodeRow}>
              <span className={styles.dot} style={{ background: NODE_LEVEL_COLOR[n.level] }} aria-hidden="true" />
              <strong>{n.node_id}</strong> - {n.location}
              {n.issues.map((i) => (
                <div key={i.type + i.message} className={styles[`issue_${i.level}`]}>{i.message}</div>
              ))}
            </div>
          ))}
        </section>

        <section className={`${styles.section} ${styles.legend}`}>
          <h2 className={styles.sectionTitle}>Map legend - severity (colour)</h2>
          <div><span className={styles.swatch} style={{ background: "orange" }} />MEDIUM hazard zone</div>
          <div><span className={styles.swatch} style={{ background: "red" }} />HIGH / CRITICAL hazard zone</div>
          <div><span className={styles.swatch} style={{ background: "#d90429" }} />Person needing help (SOS)</div>
          <div><span className={styles.swatchPending} />Awaiting confirmation (officers only)</div>
          <h3 className={styles.sectionTitle} style={{ marginTop: 8 }}>Hazard type (icon)</h3>
          <div>🌊 Flood · 🔥 Fire · ☣️ Gas leak</div>
          <div>🌡️ Heat · ⛰️ Landslide</div>
          <div>😷 Air pollution · 💧 Water quality</div>
        </section>
      </div>
    </aside>
  );
}

/** Triage order: escalated first, then the longest-waiting. */
function SosQueue({ requests, onShow }: { requests: SosRequest[]; onShow: (s: SosRequest) => void }) {
  const resolve = useResolveSos();
  const ordered = [...requests].sort((a, b) => Number(b.escalated) - Number(a.escalated) || b.minutes_open - a.minutes_open);
  return (
    <section className={styles.section} aria-labelledby="sos-queue-title">
      <h2 id="sos-queue-title" className={styles.sectionTitle}>SOS queue</h2>
      <ol className={styles.queue}>
        {ordered.map((s) => (
          <li key={s.id} className={s.escalated ? styles.queueEscalated : undefined}>
            <div>
              <strong>SOS #{s.id}</strong> · open {s.minutes_open} min{s.escalated && <strong> · ESCALATED</strong>}
            </div>
            {s.note && <div className={styles.queueNote}>{s.note}</div>}
            <div className={styles.queueMeta}>Nearest hospital: {s.nearest_hospital} ({s.hospital_distance_km} km)</div>
            <div className={styles.queueActions}>
              <button type="button" onClick={() => onShow(s)}>Show on map</button>
              <a href={s.responder_route_url} target="_blank" rel="noopener noreferrer">Route to person</a>
              <button type="button" onClick={() => resolve.mutate(s.id)} disabled={resolve.isPending}>Resolve</button>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}
