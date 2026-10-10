import "leaflet/dist/leaflet.css";
import { useQuery } from "@tanstack/react-query";
import type L from "leaflet";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { MapContainer, TileLayer } from "react-leaflet";
import { apiGet } from "../api/client";
import type {
  HazardZone, HazardZonesResponse, HeatmapResponse, Hotspot, NodeHealth, NodeHealthResponse, Role, SosListResponse,
  SosRequest, UnlocatedNodeSos,
} from "../api/types";
import { AlertActions } from "../components/AlertActions";
import { UserChip } from "../components/AppHeader";
import { useMe } from "../hooks/useAuth";
import { AlarmSoundToggle, EmergencyAlarm } from "../components/EmergencyAlarm";
import { Logo } from "../components/Logo";
import { HotspotLayer, HotspotSection, NodeValuesList } from "../components/RiskLayers";
import { VillageSirens } from "../components/VillageSirens";
import styles from "../components/Officer.module.css";
import {
  FocusOnNode, HazardZones, MapAutoResize, NodeMarkers, SosMarkers, prefersReducedMotion, useResolveAllSos,
  useResolveSos, type FocusRequest,
} from "../components/officerMap";
import { alarmItemsFromZones, alarmKey, hazardTitle, receivesAlarm, showKeyOf, type AlarmItem } from "../lib/alarm";
import {
  CARD_REASONS, approximateLocationNote, confidenceReasons, confidenceText, hazardIcon, hazardTypeText, hospitalZoneNote,
  hotspotNote, isApproximateSos, joinReasons, manualLocationNote, nodeButtonNote, peopleNeedsText, percent, sosAccuracyText,
} from "../lib/hazards";
import { isHotspotRange, type HotspotRange } from "../lib/sensors";
import { SEVERITY_RANK } from "../lib/severity";
import { CAP_FEED_URL } from "../lib/alertLinks";
import { readStored, writeStored } from "../lib/storage";
import { useBackgroundRefetch } from "../lib/useBackgroundRefetch";

const CENTER: [number, number] = [29.3919, 79.4542];
const ZONES_MS = 5000;
const HOTSPOT_RANGE_KEY = "sanjeevni_officer_hotspots";

export function OfficerPage() {
  // Same refresh rates as the classic page
  const zones = useQuery({
    queryKey: ["zones", "officer"],
    queryFn: () => apiGet<HazardZonesResponse>("/api/hazard-zones?include_pending=1"),
    refetchInterval: ZONES_MS,
    // Feeds the emergency alarm: a control-room tab behind another window must still alarm
    refetchIntervalInBackground: true,
  });
  useBackgroundRefetch(["zones", "officer"], ZONES_MS);
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
  // Hotspot layer (off by default; the officer's choice is remembered on this device)
  const [hotspotRange, setHotspotRangeState] = useState<HotspotRange>(() => {
    const stored = readStored(HOTSPOT_RANGE_KEY);
    return isHotspotRange(stored) ? stored : "off";
  });
  const setHotspotRange = useCallback((r: HotspotRange) => {
    setHotspotRangeState(r);
    writeStored(HOTSPOT_RANGE_KEY, r);
  }, []);
  const hotspots = useQuery({
    queryKey: ["hotspots", hotspotRange],
    queryFn: () => apiGet<HeatmapResponse>(`/api/officer/heatmap?range=${hotspotRange}`),
    enabled: hotspotRange !== "off",
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const markerRefs = useRef(new Map<string, L.Marker>());
  const mapRef = useRef<L.Map | null>(null);

  // ?focus=NODE-04 deep link (dashboard cards) is the first focus request;
  // the alarm and the hazard list add more.
  const focusSeq = useRef(1);
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(() => {
    const nodeId = new URLSearchParams(window.location.search).get("focus");
    return nodeId ? { nodeId, seq: 1 } : null;
  });
  const showZone = useCallback(
    (nodeId: string, hazardType?: string) => setFocusRequest({ nodeId, hazardType, seq: ++focusSeq.current }),
    [],
  );

  const [collapsed, setCollapsed] = useState(false);
  /** Polite announcement of what the map just moved to (keyboard / screen-reader users). */
  const [mapStatus, setMapStatus] = useState("");

  // Keyboard / screen-reader path to an SOS without using the map
  const showSosOnMap = (s: SosRequest) => {
    const reduce = prefersReducedMotion();
    if (reduce) mapRef.current?.setView([s.latitude, s.longitude], 16, { animate: false });
    else mapRef.current?.flyTo([s.latitude, s.longitude], 16, { duration: 1 });
    setTimeout(() => markerRefs.current.get(`sos:${s.id}`)?.openPopup(), reduce ? 50 : 1100);
  };
  const showHotspot = (h: Hotspot) => {
    if (h.latitude == null || h.longitude == null) return;
    if (prefersReducedMotion()) mapRef.current?.setView([h.latitude, h.longitude], 14, { animate: false });
    else mapRef.current?.flyTo([h.latitude, h.longitude], 14, { duration: 1 });
    setMapStatus(`Showing hotspot at ${h.node_id} (${h.location}) on the map`);
  };
  const showZoneFromList = (nodeId: string, hazardType: string) => {
    showZone(nodeId, hazardType);
    setMapStatus(`Showing ${hazardTitle(hazardType)} at ${nodeId} on the map`);
  };
  const zoneList = useMemo(() => zones.data?.zones ?? [], [zones.data]);
  const alarmItems = useMemo(() => alarmItemsFromZones(zoneList), [zoneList]);
  // Only officers get the pop-up + siren (admins can open this map too)
  const role = useMe().data?.user.role;
  const alarmOn = receivesAlarm(role);

  // "Show" in the alarm: fly to the zone, open the panel, announce it and
  // move keyboard focus to that zone's button (the dialog has just closed).
  const zoneListRef = useRef(zoneList);
  zoneListRef.current = zoneList;
  const focusTimer = useRef<number | undefined>(undefined);
  const showAlarmItem = useCallback(
    (item: AlarmItem) => {
      // an area-wide forecast item goes to its most severe node's zone
      const key = showKeyOf(item);
      const z = zoneListRef.current.find((zone) => alarmKey(zone.node_id, zone.hazard_type) === key);
      if (z) showZone(z.node_id, z.hazard_type);
      else showZone(item.nodeId);
      setCollapsed(false);
      setMapStatus(`Showing ${item.title} at ${item.nodeId} on the map`);
      window.clearTimeout(focusTimer.current);
      // runs after the dialog's own focus restore (0 ms timer)
      focusTimer.current = window.setTimeout(() => {
        const btn = Array.from(document.querySelectorAll<HTMLElement>("[data-zone-key]")).find(
          (el) => el.dataset.zoneKey === key,
        );
        const target = btn ?? document.getElementById("officer-panel-title");
        const reduce = prefersReducedMotion();
        target?.scrollIntoView?.({ behavior: reduce ? "auto" : "smooth", block: "center" });
        target?.focus({ preventScroll: true });
      }, 50);
    },
    [showZone],
  );
  useEffect(() => () => window.clearTimeout(focusTimer.current), []);

  // The zone is gone (hazard ended) - replace the "Showing ..." announcement,
  // which would otherwise claim the map moved when it did not.
  const onFocusMissing = useCallback(
    (r: FocusRequest) => setMapStatus(`${r.nodeId} has no active hazard zone on the map`),
    [],
  );

  return (
    <div className={styles.page}>
      <a className="skip-link" href="#officer-panel-title">Skip to officer panel</a>
      <div className={styles.mapRegion} role="region"
           aria-label="Hazard map (the SOS queue in the side panel lists the same requests)">
        <MapContainer center={CENTER} zoom={12} className={styles.map} ref={mapRef}>
          <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                     attribution="&copy; OpenStreetMap contributors" />
          <HotspotLayer hotspots={hotspotRange !== "off" ? hotspots.data?.hotspots ?? [] : []}
                        days={hotspots.data?.days ?? null} />
          <HazardZones zones={zoneList} markerRefs={markerRefs} />
          <SosMarkers requests={sos.data?.data ?? []} markerRefs={markerRefs} />
          <NodeMarkers nodes={health.data?.nodes ?? []} />
          <FocusOnNode request={focusRequest} zones={zoneList} loaded={zones.data !== undefined}
                       markerRefs={markerRefs} onMissing={onFocusMissing} />
          <MapAutoResize />
        </MapContainer>
      </div>
      <OfficerPanel sos={sos.data} health={health.data} zones={zones.data ? zoneList : undefined}
                    loadError={zones.isError || sos.isError} onShowSos={showSosOnMap} onShowZone={showZoneFromList}
                    collapsed={collapsed} onToggle={() => setCollapsed((c) => !c)} mapStatus={mapStatus}
                    alarmOn={alarmOn} role={role}
                    hotspots={
                      <HotspotSection range={hotspotRange} onRangeChange={setHotspotRange} data={hotspots.data}
                                      isPending={hotspots.isPending} error={hotspots.error} onShow={showHotspot} />
                    } />
      {alarmOn && <EmergencyAlarm items={alarmItems} onShow={showAlarmItem} returnFocusTo="officer-panel-title" />}
    </div>
  );
}

function OfficerPanel({
  sos, health, zones, loadError, onShowSos, onShowZone, collapsed, onToggle, mapStatus, alarmOn, role, hotspots,
}: {
  sos: SosListResponse | undefined;
  health: NodeHealthResponse | undefined;
  zones: HazardZone[] | undefined;
  loadError: boolean;
  onShowSos: (s: SosRequest) => void;
  onShowZone: (nodeId: string, hazardType: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  mapStatus: string;
  alarmOn: boolean;
  role: Role | undefined;
  /** the hotspot layer's controls + list (its state lives in OfficerPage, next to the map) */
  hotspots: ReactNode;
}) {
  const resolveAll = useResolveAllSos();
  const unlocatedCount = sos?.unlocated_node_sos?.length ?? 0;

  // Snapshot the ids on screen BEFORE the confirm dialog: it blocks the
  // page (and polling), and a request that arrives meanwhile has not been
  // seen by anyone - it must stay open (B42).
  const onResolveAll = () => {
    const ids = sos?.data.map((s) => s.id) ?? [];
    if (ids.length === 0) return;
    const n = ids.length;
    const what = n === 1 ? "the 1 SOS request" : `the ${n} SOS requests`;
    if (window.confirm(`Mark ${what} listed here as resolved? New requests that arrive meanwhile stay open. This cannot be undone.`)) {
      resolveAll.mutate(ids);
    }
  };

  return (
    <aside className={styles.panel} aria-label="Officer panel">
      <div className={styles.panelHeader}>
        <h1 id="officer-panel-title" className={styles.title} tabIndex={-1}>
          <Logo size={30} />
          <span className={styles.titleText}>Officer view</span>
        </h1>
        {/* Counts the unlocated node SOS too: they have no pin, and their
            banner is inside the hidden body - without this a collapsed panel
            would show nothing at all for them. */}
        {sos && collapsed && sos.count + unlocatedCount > 0 && (
          <span className={styles.headerCount}>
            {sos.count + unlocatedCount} SOS{unlocatedCount > 0 && ` (${unlocatedCount} no position)`}
          </span>
        )}
        <button type="button" className={styles.collapse} aria-expanded={!collapsed} aria-controls="officer-panel-body"
                onClick={onToggle}>
          {collapsed ? "Show" : "Hide"}<span className="visually-hidden"> panel</span>
        </button>
      </div>
      {/* outside the collapsible body, so it is announced even while the panel is hidden */}
      <p className="visually-hidden" role="status" aria-live="polite">{mapStatus}</p>

      <div id="officer-panel-body" className={styles.body} hidden={collapsed}>
        <div className={styles.toolsRow}>
          <UserChip variant="light" />
          {alarmOn && <AlarmSoundToggle variant="light" />}
        </div>

        {loadError && <div className={styles.loadError} role="status">Can't reach the server - retrying...</div>}

        <section className={styles.section} aria-labelledby="sos-section-title">
          <h2 id="sos-section-title" className={styles.sectionTitle}>SOS requests</h2>
          {!sos && <p className={styles.muted}>Loading SOS requests...</p>}
          {sos && (sos.unlocated_node_sos?.length ?? 0) > 0 && <UnlocatedNodeSosList requests={sos.unlocated_node_sos!} />}
          {sos && sos.count > 0 && (
            <>
              <div className={styles.sosSummary}>
                <p className={styles.sosHeadline}>
                  Open SOS requests: <span className={styles.count}>{sos.count}</span>
                </p>
                {sos.escalated_count > 0 && <span className={styles.escalatedPill}>{sos.escalated_count} escalated</span>}
                <button type="button" className={styles.resolveAll} onClick={onResolveAll} disabled={resolveAll.isPending}>
                  {resolveAll.isPending ? "Resolving..." : "Resolve all"}
                </button>
              </div>
              {resolveAll.isError && <div className={styles.errorText} role="alert">{resolveAll.error.message}</div>}
              <SosQueue requests={sos.data} onShow={onShowSos} />
            </>
          )}
          {sos && sos.count === 0 && !sos.unlocated_node_sos?.length && (
            <div className={styles.allClear}>✅ All SOS requests resolved</div>
          )}
        </section>

        <VillageSirens role={role} />
        <HazardList zones={zones} onShow={onShowZone} role={role} />
        {hotspots}
        <NodeHealthSection health={health} />
        <Legend />
        <p className={styles.feedNote}>
          <a href={CAP_FEED_URL}>Public CAP 1.2 alert feed (Atom)</a> - confirmed alerts for other dashboards
        </p>
      </div>
    </aside>
  );
}

const formatWait = (minutes: number) =>
  minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;

/** Triage order: escalated first, then the longest-waiting. */
function SosQueue({ requests, onShow }: { requests: SosRequest[]; onShow: (s: SosRequest) => void }) {
  const resolve = useResolveSos();
  const ordered = [...requests].sort((a, b) => Number(b.escalated) - Number(a.escalated) || b.minutes_open - a.minutes_open);
  return (
    <>
      {/* Pins only a few metres apart overlap at district zoom; the card's
          button zooms in and opens that exact SOS. */}
      <p className={styles.queueHint}>
        Escalated first, then longest waiting. Pins on top of each other? Use “Show on map” on a card.
      </p>
      <ol className={styles.queue} aria-label="SOS queue">
        {ordered.map((s) => {
          const titleId = `sos-card-${s.id}`;
          const resolvingThis = resolve.isPending && resolve.variables === s.id;
          return (
            <li key={s.id} className={`${styles.sosCard} ${s.escalated ? styles.sosCardEscalated : ""}`}>
              <div className={styles.sosCardHead}>
                <strong id={titleId} className={styles.sosId}>SOS #{s.id}</strong>
                {s.escalated && <span className={styles.escalatedBadge}>Escalated</span>}
                {s.location_source === "manual" && <span className={styles.manualBadge}>Set by hand</span>}
                {s.location_source === "node" && <span className={styles.nodeBadge}>Node button</span>}
                {s.location_source === "hotspot" && <span className={styles.nodeBadge}>SOS Wi-Fi</span>}
                {isApproximateSos(s) && <span className={styles.manualBadge}>Approximate</span>}
                {sosAccuracyText(s) && <span className={styles.accuracyChip}>{sosAccuracyText(s)}</span>}
                <span className={styles.wait}>
                  <span className={styles.waitValue}>{formatWait(s.minutes_open)}</span> waiting
                </span>
              </div>
              {manualLocationNote(s) && <div className={styles.queueManual}>{manualLocationNote(s)}</div>}
              {approximateLocationNote(s) && <div className={styles.queueManual}>{approximateLocationNote(s)}</div>}
              {nodeButtonNote(s) && <div className={styles.queueNode}>{nodeButtonNote(s)}</div>}
              {hotspotNote(s) && <div className={styles.queueNode}>{hotspotNote(s)}</div>}
              {peopleNeedsText(s) && <div className={styles.queuePeople}>{peopleNeedsText(s)}</div>}
              {s.note && <div className={styles.queueNote}>{s.note}</div>}
              <div className={styles.queueMeta}>
                Nearest hospital: {s.nearest_hospital} ({s.hospital_distance_km} km straight-line)
                {hospitalZoneNote(s) && <> - {hospitalZoneNote(s)}</>}
              </div>
              <div className={styles.queueActions}>
                <button type="button" className={styles.actionBtn} aria-describedby={titleId} onClick={() => onShow(s)}>
                  Show on map
                </button>
                <a className={styles.actionBtn} href={s.responder_route_url} target="_blank" rel="noopener noreferrer"
                   aria-describedby={titleId}>
                  Route to person<span className="visually-hidden"> (opens in a new tab)</span>
                </a>
                <button type="button" className={`${styles.actionBtn} ${styles.actionPrimary}`} aria-describedby={titleId}
                        onClick={() => resolve.mutate(s.id)} disabled={resolve.isPending}>
                  {resolvingThis ? "Resolving..." : "Resolve"}
                </button>
              </div>
              {resolve.isError && resolve.variables === s.id && (
                <div className={styles.errorText} role="alert">{resolve.error.message}</div>
              )}
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * SOS-button presses (or offline SOS Wi-Fi requests) at a node/gateway that
 * has no registered position: there is nowhere to put a pin, but someone
 * asked for help - so they are listed loudly at the top of the SOS section
 * until resolved (server.js createNodeButtonSos / createHotspotSos).
 */
function UnlocatedNodeSosList({ requests }: { requests: UnlocatedNodeSos[] }) {
  const resolve = useResolveSos();
  const anyHotspot = requests.some((u) => u.location_source === "hotspot");
  return (
    <div className={styles.unlocated} role="alert">
      <p className={styles.unlocatedTitle}>
        {anyHotspot
          ? "SOS from a node or offline SOS Wi-Fi with no registered position - find where it is installed"
          : "SOS button pressed on a node with no registered position - find where the node is installed"}
      </p>
      <ul className={styles.unlocatedList}>
        {requests.map((u) => (
          <li key={u.id}>
            <strong>SOS #{u.id} · {u.node_id}</strong> - {formatWait(u.minutes_open)} waiting
            {hotspotNote(u) && <div>{hotspotNote(u)}</div>}
            {peopleNeedsText(u) && <div className={styles.queuePeople}>{peopleNeedsText(u)}</div>}
            {u.note && <div className={styles.queueNote}>{u.note}</div>}
            <button type="button" className={styles.actionBtn} onClick={() => resolve.mutate(u.id)}
                    disabled={resolve.isPending} aria-label={`Resolve SOS #${u.id}`}>
              {resolve.isPending && resolve.variables === u.id ? "Resolving..." : "Resolve"}
            </button>
          </li>
        ))}
      </ul>
      <p className={styles.unlocatedHint}>Register the node's position on the admin page so the next press shows on the map.</p>
    </div>
  );
}

/** Keyboard / screen-reader path to every hazard zone; most severe first. */
function HazardList({ zones, onShow, role }: {
  zones: HazardZone[] | undefined;
  onShow: (nodeId: string, hazardType: string) => void;
  role: Role | undefined;
}) {
  const ordered = useMemo(
    () => [...(zones ?? [])].sort((a, b) =>
      Number(b.confirmed) - Number(a.confirmed) ||
      (SEVERITY_RANK[b.severity] ?? 0) - (SEVERITY_RANK[a.severity] ?? 0) ||
      b.risk_score - a.risk_score),
    [zones],
  );
  return (
    <section className={styles.section} aria-labelledby="hazard-section-title">
      <h2 id="hazard-section-title" className={styles.sectionTitle}>
        Hazard zones{zones && zones.length > 0 && <span className={styles.titleCount}> ({zones.length})</span>}
      </h2>
      {!zones && <p className={styles.muted}>Loading hazard zones...</p>}
      {zones && zones.length === 0 && <div className={styles.ok}>No active hazard zones</div>}
      {ordered.length > 0 && (
        <ul className={styles.zoneList}>
          {ordered.map((z) => (
            <li key={`${z.node_id}|${z.hazard_type}`}>
              <button type="button" className={styles.zoneBtn} data-zone-key={alarmKey(z.node_id, z.hazard_type)}
                      onClick={() => onShow(z.node_id, z.hazard_type)}>
                <span className={styles.zoneIcon} aria-hidden="true">{hazardIcon(z.hazard_type)}</span>
                <span className={styles.zoneText}>
                  <span className={styles.zoneName}>{z.node_id} · {hazardTypeText(z.hazard_type)}</span>
                  <span className={styles.zoneMeta}>
                    Risk {percent(z.risk_score)}{z.confirmed ? "" : " · awaiting confirmation"}
                    {z.stale === true ? " · stale (node may be offline)" : ""}
                  </span>
                  <ZoneConfidence zone={z} />
                </span>
                <span className={`${styles.sevChip} ${styles[`sev_${z.severity}`] ?? ""}`}>{z.severity}</span>
              </button>
              {/* confirmed alerts only: CAP XML / PDF report / timeline (outside the zone button) */}
              {z.confirmed && typeof z.alert_id === "number" && (
                <AlertActions alertId={z.alert_id} nodeId={z.node_id} role={role} compact
                              label={`${hazardTitle(z.hazard_type)} at ${z.node_id}`} />
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function nodeStatusLabel(n: NodeHealth): string {
  if (n.status === "offline") return "Offline";
  if (n.status === "never_seen") return "Never seen";
  return n.level === "critical" ? "Critical" : n.level === "warning" ? "Warning" : "OK";
}

const LEVEL_RANK = { critical: 2, warning: 1, ok: 0 } as const;

function NodeHealthSection({ health }: { health: NodeHealthResponse | undefined }) {
  const attention = (health?.nodes.filter((n) => n.issues.length) ?? [])
    .sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level]);
  return (
    <section className={styles.section} aria-labelledby="node-section-title">
      <h2 id="node-section-title" className={styles.sectionTitle}>Sensor nodes</h2>
      <p className={styles.nodeSummary}>
        {health
          ? `${health.summary.online} online, ${health.summary.offline} offline` +
            (health.summary.never_seen ? `, ${health.summary.never_seen} never seen` : "")
          : "Loading node status..."}
      </p>
      {health && attention.length === 0 && <div className={styles.ok}>All nodes reporting normally</div>}
      {attention.length > 0 && (
        <ul className={styles.nodeList} aria-label="Nodes needing attention">
          {attention.map((n) => (
            <li key={n.node_id} className={styles.nodeItem}>
              <div className={styles.nodeHead}>
                <span className={`${styles.statusChip} ${n.status === "online" ? styles[`chip_${n.level}`] : styles.chip_offline}`}>
                  {nodeStatusLabel(n)}
                </span>
                <strong>{n.node_id}</strong>
              </div>
              <div className={styles.nodeLocation}>{n.location}</div>
              <ul className={styles.issueList}>
                {n.issues.map((i) => (
                  <li key={i.type + i.message} className={styles[`issue_${i.level}`]}>{i.message}</li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
      {health && <NodeValuesList nodes={health.nodes} />}
    </section>
  );
}

/**
 * Confidence line inside a zone button. Plain spans (a button may only hold
 * phrasing content), so not the shared <Confidence> block; same wording.
 * Nothing for a zone without a score.
 */
function ZoneConfidence({ zone }: { zone: HazardZone }) {
  const text = confidenceText(zone);
  if (!text) return null;
  const reasons = confidenceReasons(zone, CARD_REASONS);
  return (
    <span className={`${styles.zoneMeta} ${styles.zoneConfidence}`}
          data-confidence={zone.confidence_label ?? "unlabelled"}>
      {text}{reasons.length > 0 ? ` - ${joinReasons(reasons)}` : ""}
    </span>
  );
}

const HAZARD_TYPES: [type: string, label: string][] = [
  ["flood", "Flood"], ["flash_flood", "Flash flood (river rising fast)"], ["fire", "Fire"], ["smoke", "Smoke"],
  ["gas leak", "Gas leak"], ["extreme heat", "Heat"], ["landslide", "Landslide"], ["air pollution", "Air pollution"],
  ["water quality degradation", "Water quality"], ["heavy_rain", "Heavy rain"], ["high_wind", "High wind (forecast)"],
];

function Legend() {
  return (
    <details className={`${styles.section} ${styles.legend}`} open>
      <summary className={styles.legendSummary}>Map legend</summary>
      <p className={styles.legendSub}>Hazard zones - colour shows severity</p>
      <ul className={styles.legendList}>
        <li><span className={`${styles.swatch} ${styles.swatchMedium}`} aria-hidden="true" />MEDIUM hazard zone</li>
        <li><span className={`${styles.swatch} ${styles.swatchHigh}`} aria-hidden="true" />HIGH / CRITICAL hazard zone</li>
        <li><span className={styles.swatchPending} aria-hidden="true" />Awaiting confirmation (officers only)</li>
      </ul>
      <p className={styles.legendSub}>Markers</p>
      <ul className={styles.legendList}>
        <li><span className={styles.legendIcon} aria-hidden="true">📍</span>Person needing help (SOS)</li>
        <li>N / W badge on a pin: node SOS button / offline SOS Wi-Fi (pin = the node)</li>
        <li><span className={`${styles.swatch} ${styles.nodeOk}`} aria-hidden="true" />Sensor node - normal</li>
        <li><span className={`${styles.swatch} ${styles.nodeWarning}`} aria-hidden="true" />Sensor node - warning</li>
        <li><span className={`${styles.swatch} ${styles.nodeCritical}`} aria-hidden="true" />Sensor node - critical</li>
        <li><span className={`${styles.swatch} ${styles.nodeOffline}`} aria-hidden="true" />Sensor node - offline</li>
      </ul>
      <p className={styles.legendSub}>Hazard type (icon)</p>
      <ul className={`${styles.legendList} ${styles.iconGrid}`}>
        {HAZARD_TYPES.map(([type, label]) => (
          <li key={type}><span className={styles.legendIcon} aria-hidden="true">{hazardIcon(type)}</span>{label}</li>
        ))}
      </ul>
    </details>
  );
}
