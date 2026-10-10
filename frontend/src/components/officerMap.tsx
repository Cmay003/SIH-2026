// Officer map layers. Every popup is a React component, so server text
// (SOS notes, locations, satellite messages) is always escaped - the
// classic page needed a hand-written escapeHtml() for each field.
// Markers keep stable keys across the 5 s refresh, so an open popup is no
// longer destroyed by the refresh (review finding R18).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import L from "leaflet";
import { Fragment, useEffect, useRef, useState, type RefObject } from "react";
import { Circle, CircleMarker, Marker, Popup, useMap } from "react-leaflet";
import { apiGet, apiPost } from "../api/client";
import type { ForecastResponse, HazardZone, NodeHealth, SatelliteCheck, SosRequest } from "../api/types";
import {
  approximateLocationNote, hazardIcon, hazardTypeText, hospitalZoneNote, hotspotNote, isApproximateSos,
  manualLocationNote, nodeButtonNote, peopleNeedsText, sosAccuracyText, staleText,
} from "../lib/hazards";
import { severityMapColor } from "../lib/severity";
import { useMe } from "../hooks/useAuth";
import { AlertActions } from "./AlertActions";
import { Confidence } from "./Confidence";
import { NodeSensorValues } from "./RiskLayers";
import { PublicAdviceSection } from "./PublicAdvice";
import styles from "./Officer.module.css";

// ---- marker icons (built from fixed values only - never server text) ----
const iconCache = new Map<string, L.DivIcon>();
function cachedIcon(key: string, make: () => L.DivIcon): L.DivIcon {
  let icon = iconCache.get(key);
  if (!icon) {
    icon = make();
    iconCache.set(key, icon); // same object every refresh -> no marker re-render
  }
  return icon;
}

function severityIconClass(severity: string): string {
  if (severity === "HIGH" || severity === "CRITICAL") return styles.iconHigh;
  if (severity === "MEDIUM") return styles.iconMedium;
  return styles.iconLow;
}

const hazardMarkerIcon = (severity: string, hazardType: string) =>
  cachedIcon(`h:${severity}:${hazardType}`, () =>
    L.divIcon({
      className: styles.divIconReset,
      // Colour via a class, not an inline style="" - the page's
      // Content-Security-Policy blocks inline style attributes. The emoji is
      // aria-hidden: Leaflet makes the marker a focusable role="button", and
      // its name came from the emoji ("🌊") instead of the marker's title.
      html: `<div aria-hidden="true" class="${styles.hazardIcon} ${severityIconClass(severity)}">${hazardIcon(hazardType)}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -12],
    }),
  );

/**
 * "uncertain": the person placed the point by hand on a map (no device fix),
 * or the device fix may be far off (no GPS - Wi-Fi / cell / IP position), so
 * the pin carries a "?" badge - it must not look as exact as a GPS pin.
 * "node": the SOS button on a sensor node - an "N" badge (pin = the node).
 * "hotspot": the offline SOS Wi-Fi at a node/gateway - a "W" badge (pin = the
 * node, person within Wi-Fi range; or coordinates the person typed).
 */
type SosPinKind = "exact" | "uncertain" | "node" | "hotspot";
const sosPinKind = (s: SosRequest): SosPinKind =>
  s.location_source === "node" ? "node"
    : s.location_source === "hotspot" ? "hotspot"
    : s.location_source === "manual" || isApproximateSos(s) ? "uncertain" : "exact";
const SOS_PIN_BADGE: Record<SosPinKind, string> = {
  exact: "",
  uncertain: `<div class="${styles.sosManualBadge}">?</div>`,
  node: `<div class="${styles.sosManualBadge} ${styles.sosNodeBadge}">N</div>`,
  hotspot: `<div class="${styles.sosManualBadge} ${styles.sosNodeBadge}">W</div>`,
};
const sosMarkerIcon = (kind: SosPinKind) =>
  cachedIcon(`sos-${kind}`, () =>
    L.divIcon({
      className: styles.divIconReset,
      html: `<div aria-hidden="true" class="${styles.sosPinWrap}"><div class="${styles.sosPulse}"></div><div class="${styles.sosPin}">📍</div>` +
        SOS_PIN_BADGE[kind] + "</div>",
      iconSize: [44, 54],
      iconAnchor: [22, 54],
      popupAnchor: [0, -48],
    }),
  );

/**
 * Stacking order for SOS pins. Leaflet stacks markers by screen y unless told
 * otherwise, so a newer SOS a little further south would cover an escalated
 * one - and a click on the pin underneath opens the wrong popup. Escalated SOS
 * go on top, then the longest-open ones (the same order as the queue). The
 * +1000 base keeps every SOS above hazard icons (offset 0); the cap of 999
 * keeps a non-escalated SOS below every escalated one.
 */
export const sosZIndexOffset = (s: Pick<SosRequest, "escalated" | "minutes_open">) =>
  (s.escalated ? 2000 : 1000) + Math.min(Math.max(Math.round(s.minutes_open) || 0, 0), 999);

export const NODE_LEVEL_COLOR = { ok: "#2e7d32", warning: "#f2a900", critical: "#d90429" } as const;

// ---- hazard zones -------------------------------------------------------
/** markerRefs key for one zone; a node can carry several hazards at once. */
export const zoneMarkerKey = (z: Pick<HazardZone, "node_id" | "hazard_type">) => `zone:${z.node_id}|${z.hazard_type}`;

export function HazardZones({ zones, markerRefs }: {
  zones: HazardZone[];
  markerRefs: RefObject<Map<string, L.Marker>>;
}) {
  return (
    <>
      {zones.map((z) => {
        const key = `${z.node_id}:${z.hazard_type}`;
        const color = severityMapColor(z.severity);
        return (
          <Fragment key={key}>
            {/* Pending = waiting for a repeat reading or a neighbour to
                confirm it: dashed + faint, and not on the public map yet */}
            <Circle center={[z.latitude, z.longitude]} radius={z.radius_m}
                    pathOptions={{ color, fillColor: color, fillOpacity: z.confirmed ? 0.3 : 0.08,
                                   dashArray: z.confirmed ? undefined : "8 6" }}>
              <Popup><HazardPopup zone={z} /></Popup>
            </Circle>
            <Marker position={[z.latitude, z.longitude]} icon={hazardMarkerIcon(z.severity, z.hazard_type)}
                    title={`${hazardTypeText(z.hazard_type)} ${z.severity} at ${z.node_id}${z.confirmed ? "" : " (awaiting confirmation)"}`}
                    ref={(m) => {
                      if (!m) return;
                      markerRefs.current?.set(z.node_id, m); // ?focus=NODE-xx deep link
                      markerRefs.current?.set(zoneMarkerKey(z), m); // exact zone (alarm "Show on map")
                    }}>
              <Popup minWidth={240}><HazardPopup zone={z} withInsights /></Popup>
            </Marker>
          </Fragment>
        );
      })}
    </>
  );
}

function HazardPopup({ zone, withInsights = false }: { zone: HazardZone; withInsights?: boolean }) {
  return (
    <div className={styles.popup}>
      <div className={styles.popupHead}>
        <strong>{zone.node_id}</strong>
        <span className={`${styles.popupSev} ${severityIconClass(zone.severity)}`}>{zone.severity}</span>
      </div>
      <div><span aria-hidden="true">{hazardIcon(zone.hazard_type)}</span> {hazardTypeText(zone.hazard_type)}</div>
      <div>Risk score: {zone.risk_score.toFixed(2)}</div>
      <Confidence value={zone} />
      {!zone.confirmed && <div className={styles.pendingNote}><em>Awaiting confirmation - not yet public</em></div>}
      {zone.stale === true && (
        <div className={styles.pendingNote} title={zone.last_reading_at ? `Last reading: ${zone.last_reading_at}` : undefined}>
          <strong>{staleText(zone.last_reading_at)}</strong>
        </div>
      )}
      {zone.confirmed && typeof zone.alert_id === "number" && <PopupAlertActions zone={zone} alertId={zone.alert_id} />}
      <PublicAdviceSection hazardType={zone.hazard_type} severity={zone.severity}
                           label={`${hazardTypeText(zone.hazard_type)} at ${zone.node_id}`} />
      {/* river forecast + satellite check help with a flash flood too (same river gauge) */}
      {withInsights && (zone.hazard_type === "flood" || zone.hazard_type === "flash_flood") &&
        <FloodInsights nodeId={zone.node_id} />}
    </div>
  );
}

/** CAP XML / PDF report / Timeline for the confirmed alert behind a zone (step W2). */
function PopupAlertActions({ zone, alertId }: { zone: HazardZone; alertId: number }) {
  const role = useMe().data?.user.role;
  return <AlertActions alertId={alertId} nodeId={zone.node_id} role={role} compact
                       label={`${hazardTypeText(zone.hazard_type)} at ${zone.node_id}`} />;
}

/** Rendered only while the popup is open, so these requests run on demand. */
function FloodInsights({ nodeId }: { nodeId: string }) {
  const forecast = useQuery({
    queryKey: ["forecast", nodeId],
    queryFn: () => apiGet<ForecastResponse>(`/api/forecast/${encodeURIComponent(nodeId)}`),
    staleTime: 60_000,
  });
  const satellite = useQuery({
    queryKey: ["satellite", nodeId],
    queryFn: () => apiGet<SatelliteCheck>(`/api/satellite-check/${encodeURIComponent(nodeId)}`),
    staleTime: 60 * 60_000, // server caches 6 h; don't spend Copernicus quota on re-opens
    retry: false,
  });
  const f = forecast.data;
  return (
    <div className={styles.insights}>
      <h4>River forecast</h4>
      {forecast.isPending && <div className={styles.muted}>Loading...</div>}
      {forecast.isError && <div className={styles.muted}>Forecast unavailable: {forecast.error.message}</div>}
      {f && !f.available && <div className={styles.muted}>Forecast unavailable: {f.reason}</div>}
      {f && f.available && (
        <>
          <div>Now {f.current_level_m.toFixed(2)} m</div>
          {f.forecast.map((p) => (
            <div key={p.minutes_ahead}>
              +{p.minutes_ahead} min: <strong>{p.level_m.toFixed(2)} m</strong> ({p.change_m >= 0 ? "+" : ""}
              {p.change_m.toFixed(2)}; straight-line {p.linear_baseline_level_m.toFixed(2)} m)
            </div>
          ))}
          <div className={styles.muted}><em>Indicative only - model trained on synthetic data</em></div>
        </>
      )}
      <h4>Sentinel-1 radar</h4>
      {satellite.isPending && <div className={styles.muted}>Checking satellite data (can take up to a minute)...</div>}
      {satellite.isError && <div className={styles.muted}>Unavailable: {satellite.error.message}</div>}
      {satellite.data && (
        <>
          <div>{satellite.data.message || satellite.data.status}</div>
          {satellite.data.agreement && <div><em>{satellite.data.agreement}</em></div>}
        </>
      )}
    </div>
  );
}

/** Leaflet's flyTo is a JS animation the CSS reduced-motion rules can't stop. */
export function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

// ---- fly to a zone: ?focus=NODE-04 deep link and the alarm's "Show on map" ----
/** `seq` changes on every request, so asking for the same zone twice flies there again. */
export interface FocusRequest {
  nodeId: string;
  hazardType?: string;
  seq: number;
}

/**
 * loaded: the zone list has arrived at least once. Until then a missing zone
 * may just be "not loaded yet" and the request is retried on each refresh;
 * after that, a missing zone means the hazard has ended and the request is
 * dropped (onMissing is told). It used to stay pending, and hours later the
 * node's next hazard flew the map away from whatever the officer was doing
 * (B63).
 */
export function FocusOnNode({ request, zones, loaded, markerRefs, onMissing }: {
  request: FocusRequest | null;
  zones: HazardZone[];
  loaded: boolean;
  markerRefs: RefObject<Map<string, L.Marker>>;
  onMissing?: (request: FocusRequest) => void;
}) {
  const map = useMap();
  const handled = useRef(0);
  const cancelPending = useRef<(() => void) | null>(null);
  const [ring, setRing] = useState<{ zone: HazardZone; seq: number } | null>(null);
  // a ref, so a new callback identity on each render doesn't re-run the effect
  const onMissingRef = useRef(onMissing);
  onMissingRef.current = onMissing;
  useEffect(() => {
    if (!request || handled.current === request.seq) return;
    const zone =
      (request.hazardType && zones.find((z) => z.node_id === request.nodeId && z.hazard_type === request.hazardType)) ||
      zones.find((z) => z.node_id === request.nodeId);
    if (!zone) {
      if (loaded) {
        handled.current = request.seq; // the hazard has ended - never fly there later
        onMissingRef.current?.(request);
      }
      return; // zones not loaded yet - tried again when they arrive
    }
    handled.current = request.seq;
    cancelPending.current?.();
    const reduce = prefersReducedMotion();
    if (reduce) map.setView([zone.latitude, zone.longitude], 15, { animate: false });
    else map.flyTo([zone.latitude, zone.longitude], 15, { duration: 1.2 });
    setRing({ zone, seq: request.seq });
    // Timers live in a ref, not in this effect's cleanup: the 5 s zone
    // refresh re-runs the effect and must not cancel the popup half-way.
    const openTimer = setTimeout(
      () => (markerRefs.current?.get(zoneMarkerKey(zone)) ?? markerRefs.current?.get(zone.node_id))?.openPopup(),
      reduce ? 50 : 1300,
    );
    const ringTimer = setTimeout(() => setRing(null), 3000);
    cancelPending.current = () => {
      clearTimeout(openTimer);
      clearTimeout(ringTimer);
    };
  }, [request, zones, loaded, map, markerRefs]);
  useEffect(
    () => () => {
      cancelPending.current?.();
      cancelPending.current = null;
      handled.current = 0; // a remount (StrictMode) runs the request again
    },
    [],
  );
  return ring ? (
    <Circle key={ring.seq} center={[ring.zone.latitude, ring.zone.longitude]} radius={ring.zone.radius_m + 150}
            pathOptions={{ color: "#1a73e8", weight: 4, fill: false, className: styles.focusRing }} />
  ) : null;
}

/** Leaflet only re-measures on window resize; the panel can resize the map too (phones). */
export function MapAutoResize() {
  const map = useMap();
  useEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => map.invalidateSize());
    observer.observe(map.getContainer());
    return () => observer.disconnect();
  }, [map]);
  return null;
}

// ---- SOS ------------------------------------------------------------------
export function SosMarkers({ requests, markerRefs }: {
  requests: SosRequest[];
  markerRefs: RefObject<Map<string, L.Marker>>;
}) {
  return (
    <>
      {requests.map((s) => (
        <Fragment key={s.id}>
          {/* How far off an approximate device fix may be: the person is
              somewhere in this circle, not necessarily at the pin */}
          {isApproximateSos(s) && (
            <Circle center={[s.latitude, s.longitude]} radius={s.location_accuracy_m!} interactive={false}
                    pathOptions={{ color: "#7a4a00", weight: 1.5, dashArray: "6 6", fillOpacity: 0.06 }} />
          )}
          <Marker position={[s.latitude, s.longitude]} icon={sosMarkerIcon(sosPinKind(s))}
                  zIndexOffset={sosZIndexOffset(s)}
                  title={`SOS #${s.id}${s.escalated ? ", escalated" : ""}${sosPinTitle(s)}, open ${s.minutes_open} min`}
                  ref={(m) => { if (m) markerRefs.current?.set(`sos:${s.id}`, m); }}>
            <Popup minWidth={230}><SosPopup sos={s} /></Popup>
          </Marker>
        </Fragment>
      ))}
    </>
  );
}

function sosPinTitle(s: SosRequest): string {
  if (s.location_source === "node") return `, SOS button on node ${s.node_id ?? ""}`;
  if (s.location_source === "hotspot") return `, ${hotspotNote(s)}`;
  if (s.location_source === "manual") return ", location set by hand (approximate)";
  if (isApproximateSos(s)) return `, approximate location (${sosAccuracyText(s)})`;
  return "";
}

function SosPopup({ sos }: { sos: SosRequest }) {
  const resolve = useResolveSos();
  return (
    <div className={styles.popup}>
      {sos.escalated && <div className={styles.escalated}>⚠ ESCALATED - open {sos.minutes_open} min</div>}
      <strong>SOS #{sos.id}</strong> - {new Date(sos.timestamp).toLocaleTimeString()}
      {sosAccuracyText(sos) && !isApproximateSos(sos) && <> · location {sosAccuracyText(sos)}</>}
      {manualLocationNote(sos) && <div className={styles.manualLocation}>{manualLocationNote(sos)}</div>}
      {approximateLocationNote(sos) && <div className={styles.manualLocation}>{approximateLocationNote(sos)}</div>}
      {nodeButtonNote(sos) && <div className={styles.nodeButtonNote}>{nodeButtonNote(sos)}</div>}
      {hotspotNote(sos) && <div className={styles.nodeButtonNote}>{hotspotNote(sos)}</div>}
      {peopleNeedsText(sos) && <div className={styles.escalated}>{peopleNeedsText(sos)}</div>}
      {sos.note && <div className={styles.note}>{sos.note}</div>}
      <div>Nearest hospital: <strong>{sos.nearest_hospital}</strong> ({sos.hospital_distance_km} km straight-line)</div>
      {hospitalZoneNote(sos) && <div className={styles.note}>{hospitalZoneNote(sos)}</div>}
      <a href={sos.responder_route_url} target="_blank" rel="noopener noreferrer">Route to this person</a>
      <a href={sos.hospital_route_url} target="_blank" rel="noopener noreferrer">Route from person to hospital</a>
      <button type="button" className={styles.resolveBtn} disabled={resolve.isPending}
              onClick={() => resolve.mutate(sos.id)}>
        {resolve.isPending ? "Resolving..." : "Mark resolved"}
      </button>
      {resolve.isError && <div className={styles.errorText}>{resolve.error.message}</div>}
    </div>
  );
}

export function useResolveSos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => apiPost(`/api/sos/${id}/resolve`),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sos"] }),
  });
}

/**
 * Resolves only the SOS ids passed in - the ones the officer was shown. The
 * server refuses a request without ids, so an SOS that arrives while the
 * confirm dialog is open (it blocks polling) stays open (B42).
 */
export function useResolveAllSos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (ids: number[]) => apiPost<{ resolved_count: number }>("/api/sos/resolve-all", { ids }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sos"] }),
  });
}

// ---- sensor nodes -----------------------------------------------------------
export function NodeMarkers({ nodes }: { nodes: NodeHealth[] }) {
  return (
    <>
      {nodes.filter((n) => n.latitude != null && n.longitude != null).map((n) => (
        <CircleMarker key={n.node_id} center={[n.latitude!, n.longitude!]} radius={7}
                      pathOptions={{ color: "#333", weight: 1, fillOpacity: 0.9,
                                     fillColor: n.status !== "online" ? "#9aa1ab" : NODE_LEVEL_COLOR[n.level] }}>
          <Popup minWidth={250}>
            <div className={styles.popup}>
              <strong>{n.node_id}</strong> ({n.status})
              <div>{n.location}</div>
              <div>Last seen: {n.seconds_since_seen == null ? "never" : `${n.seconds_since_seen}s ago`}</div>
              {n.issues.map((i) => (
                <div key={i.type + i.message} className={styles[`issue_${i.level}`]}>{i.message}</div>
              ))}
              {/* every fitted sensor (battery, signal and siren included);
                  rendered - and fetched - only while the popup is open */}
              <NodeSensorValues nodeId={n.node_id} />
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </>
  );
}
