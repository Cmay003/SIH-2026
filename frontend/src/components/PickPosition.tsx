// Map click -> position, shared by the admin node editor and the citizen
// SOS page's "set my location on a map" picker. Its own module so the SOS
// page's lazy map chunk doesn't pull in the whole admin page.
import { useMapEvents } from "react-leaflet";

/**
 * Zoomed out, Leaflet repeats the world side by side and a click on a copy
 * gives an unwrapped longitude (e.g. 439.45). wrap() maps it back to
 * -180..180, or the field got a value the form then rejected (B65).
 */
export function PickPosition({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({
    click: (e) => {
      const p = e.latlng.wrap();
      onPick(p.lat, p.lng);
    },
  });
  return null;
}
