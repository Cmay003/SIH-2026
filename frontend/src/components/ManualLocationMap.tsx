// Small map for the citizen to set their SOS location by hand when the
// device location is denied, unavailable or too slow. Loaded lazily by
// SosPage: Leaflet is the biggest library on the page and most people get
// a GPS fix, so they never download it (a slow network in a disaster).
// Tiles come only from *.tile.openstreetmap.org, the one image host the
// Content-Security-Policy allows. Offline the tiles stay blank - the
// latitude/longitude fields next to the map work without it.
import "leaflet/dist/leaflet.css";
import { useEffect } from "react";
import { Circle, CircleMarker, MapContainer, TileLayer, useMap } from "react-leaflet";
import type { HazardZone } from "../api/types";
import { severityMapColor } from "../lib/severity";
import type { Coords } from "../lib/sos";
import styles from "../pages/Sos.module.css";
import { PickPosition } from "./PickPosition";

/** The monitored district (same centre as the officer and admin maps) */
const DEFAULT_CENTER: [number, number] = [29.3919, 79.4542];

export default function ManualLocationMap({ point, zones, onPick }: {
  /** the point set by hand so far, or null */
  point: Coords | null;
  /** public (confirmed) hazard zones, so the person can see where they are relative to them */
  zones: HazardZone[];
  onPick: (c: Coords) => void;
}) {
  return (
    <MapContainer center={point ? [point.latitude, point.longitude] : DEFAULT_CENTER} zoom={point ? 15 : 12}
                  className={styles.manualMap} worldCopyJump>
      <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
      {/* not interactive: a tap inside a zone must set the point, not open a popup */}
      {zones.map((z) => (
        <Circle key={`${z.node_id}:${z.hazard_type}`} center={[z.latitude, z.longitude]} radius={z.radius_m}
                interactive={false}
                pathOptions={{ color: severityMapColor(z.severity), fillColor: severityMapColor(z.severity), fillOpacity: 0.2 }} />
      ))}
      {point && (
        <CircleMarker center={[point.latitude, point.longitude]} radius={9} interactive={false}
                      pathOptions={{ color: "#1e3a8a", weight: 3, fillColor: "#3b82f6", fillOpacity: 0.9 }} />
      )}
      <PickPosition onPick={(latitude, longitude) => onPick({ latitude, longitude })} />
      <FollowPoint point={point} />
    </MapContainer>
  );
}

/** Pan to coordinates typed into the fields (a tapped point is already in view) */
function FollowPoint({ point }: { point: Coords | null }) {
  const map = useMap();
  const lat = point?.latitude;
  const lon = point?.longitude;
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    if (!map.getBounds().contains([lat, lon])) map.setView([lat, lon], Math.max(map.getZoom(), 14), { animate: false });
  }, [map, lat, lon]);
  return null;
}
