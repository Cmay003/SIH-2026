import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { HazardsResponse, HospitalRoute, SensorsResponse } from "../api/types";
import { AppHeader, type ConnectionState } from "../components/AppHeader";
import { CriticalHazard, HazardList, HospitalCard, KpiTiles, SensorTable } from "../components/dashboard";
import styles from "../components/Dashboard.module.css";
import { isSevere } from "../lib/hazards";
import { useDeniedToast } from "../components/Toast";

// Same refresh rates as the original dashboard (2 s readings, 5 s hazards).
// TanStack Query pauses polling while the tab is hidden.
const SENSORS_MS = 2000;
const HAZARDS_MS = 5000;

export function DashboardPage() {
  const sensors = useQuery({
    queryKey: ["sensors"],
    queryFn: () => apiGet<SensorsResponse>("/api/sensors"),
    refetchInterval: SENSORS_MS,
  });
  const hazards = useQuery({
    queryKey: ["hazards"],
    queryFn: () => apiGet<HazardsResponse>("/api/hazards"),
    refetchInterval: HAZARDS_MS,
  });

  const rows = sensors.data?.data ?? [];
  const latest = rows[0];
  // Nearest-hospital route only matters when the latest reading is severe
  const routeNode = latest && isSevere(latest.risk) ? latest.device_id : null;
  const route = useQuery({
    queryKey: ["route", routeNode],
    queryFn: () => apiGet<HospitalRoute>(`/api/route/${encodeURIComponent(routeNode!)}`),
    enabled: routeNode !== null,
    staleTime: 5 * 60_000, // hospitals don't move
  });

  const connection: ConnectionState = sensors.isError ? "disconnected" : sensors.isSuccess ? "connected" : "connecting";
  const hazardList = hazards.data?.hazards ?? [];
  const deniedToast = useDeniedToast();

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      {deniedToast}
      <AppHeader connection={connection} />
      <main id="main" className={styles.main} tabIndex={-1}>
        <KpiTiles latest={latest} count={sensors.data?.count ?? 0} />
        {route.data && <HospitalCard route={route.data} />}

        <h2>Critical Hazard</h2>
        {hazards.isSuccess && <CriticalHazard hazard={hazardList[0]} />}

        <h2>All Active Hazards</h2>
        {hazards.isSuccess && <HazardList hazards={hazardList} />}
        {hazards.isError && <div className={styles.errorBox}>Couldn't load hazards: {hazards.error.message}</div>}

        <h2>Latest Sensor Readings</h2>
        <SensorTable rows={rows} />
      </main>
    </>
  );
}
