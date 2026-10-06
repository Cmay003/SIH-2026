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
import { hazardIcon } from "../lib/hazards";
import { severityMapColor } from "../lib/severity";
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
      // Content-Security-Policy blocks inline style attributes.
      html: `<div class="${styles.hazardIcon} ${severityIconClass(severity)}">${hazardIcon(hazardType)}</div>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15],
      popupAnchor: [0, -12],
    }),
  );

const sosMarkerIcon = () =>
  cachedIcon("sos", () =>
    L.divIcon({
      className: styles.divIconReset,
      html: `<div class="${styles.sosPinWrap}"><div class="${styles.sosPulse}"></div><div class="${styles.sosPin}">📍</div></div>`,
      iconSize: [44, 54],
      iconAnchor: [22, 54],
      popupAnchor: [0, -48],
    }),
  );

export const NODE_LEVEL_COLOR = { ok: "#2e7d32", warning: "#f2a900", critical: "#d90429" } as const;

// ---- hazard zones -------------------------------------------------------
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
                    title={`${z.hazard_type} ${z.severity} at ${z.node_id}${z.confirmed ? "" : " (awaiting confirmation)"}`}
                    ref={(m) => { if (m) markerRefs.current?.set(z.node_id, m); }}>
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
      <strong>{zone.node_id}</strong>
      <div>{hazardIcon(zone.hazard_type)} {zone.hazard_type} - {zone.severity}</div>
      <div>Risk score: {zone.risk_score.toFixed(2)}</div>
      {!zone.confirmed && <div><em>Awaiting confirmation - not yet public</em></div>}
      {withInsights && zone.hazard_type === "flood" && <FloodInsights nodeId={zone.node_id} />}
    </div>
  );
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

// ---- deep link: /officer.html?focus=NODE-04 -------------------------------
export function FocusOnNode({ nodeId, zones, markerRefs }: {
  nodeId: string | null;
  zones: HazardZone[];
  markerRefs: RefObject<Map<string, L.Marker>>;
}) {
  const map = useMap();
  const done = useRef(false);
  const [ring, setRing] = useState<HazardZone | null>(null);
  useEffect(() => {
    if (!nodeId || done.current) return;
    const zone = zones.find((z) => z.node_id === nodeId);
    if (!zone) return;
    done.current = true;
    map.flyTo([zone.latitude, zone.longitude], 15, { duration: 1.2 });
    setRing(zone);
    const openTimer = setTimeout(() => markerRefs.current?.get(nodeId)?.openPopup(), 1300);
    const ringTimer = setTimeout(() => setRing(null), 3000);
    return () => {
      clearTimeout(openTimer);
      clearTimeout(ringTimer);
    };
  }, [nodeId, zones, map, markerRefs]);
  return ring ? (
    <Circle center={[ring.latitude, ring.longitude]} radius={ring.radius_m + 150}
            pathOptions={{ color: "#1a73e8", weight: 4, fill: false, className: styles.focusRing }} />
  ) : null;
}

// ---- SOS ------------------------------------------------------------------
export function SosMarkers({ requests, markerRefs }: {
  requests: SosRequest[];
  markerRefs: RefObject<Map<string, L.Marker>>;
}) {
  return (
    <>
      {requests.map((s) => (
        <Marker key={s.id} position={[s.latitude, s.longitude]} icon={sosMarkerIcon()}
                title={`SOS #${s.id}${s.escalated ? ", escalated" : ""}, open ${s.minutes_open} min`}
                ref={(m) => { if (m) markerRefs.current?.set(`sos:${s.id}`, m); }}>
          <Popup minWidth={230}><SosPopup sos={s} /></Popup>
        </Marker>
      ))}
    </>
  );
}

function SosPopup({ sos }: { sos: SosRequest }) {
  const resolve = useResolveSos();
  return (
    <div className={styles.popup}>
      {sos.escalated && <div className={styles.escalated}>⚠ ESCALATED - open {sos.minutes_open} min</div>}
      <strong>SOS #{sos.id}</strong> - {new Date(sos.timestamp).toLocaleTimeString()}
      {sos.note && <div className={styles.note}>{sos.note}</div>}
      <div>Nearest hospital: <strong>{sos.nearest_hospital}</strong> ({sos.hospital_distance_km} km)</div>
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

export function useResolveAllSos() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ resolved_count: number }>("/api/sos/resolve-all"),
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
          <Popup>
            <div className={styles.popup}>
              <strong>{n.node_id}</strong> ({n.status})
              <div>{n.location}</div>
              <div>Last seen: {n.seconds_since_seen == null ? "never" : `${n.seconds_since_seen}s ago`}</div>
              <div>
                Battery: {n.battery_pct == null ? "-" : `${n.battery_pct.toFixed(0)}%`} · Signal:{" "}
                {n.signal_strength_dbm == null ? "-" : `${n.signal_strength_dbm} dBm`}{n.link ? ` (${n.link})` : ""}
              </div>
              {n.issues.map((i) => (
                <div key={i.type + i.message} className={styles[`issue_${i.level}`]}>{i.message}</div>
              ))}
            </div>
          </Popup>
        </CircleMarker>
      ))}
    </>
  );
}
