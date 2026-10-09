import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiGet } from "../api/client";
import type { HazardsResponse, HospitalRoute, SensorsResponse } from "../api/types";
import { AppHeader, type ConnectionState } from "../components/AppHeader";
import {
  CriticalHazard,
  HazardList,
  HazardSkeleton,
  HospitalCard,
  KpiTiles,
  LiveBar,
  SensorTable,
  hazardKey,
  type LiveState,
} from "../components/dashboard";
import styles from "../components/Dashboard.module.css";
import { AlarmSoundToggle, EmergencyAlarm } from "../components/EmergencyAlarm";
import { alarmItemsFromHazards, type AlarmItem } from "../lib/alarm";
import { isSevere } from "../lib/hazards";
import { useBackgroundRefetch } from "../lib/useBackgroundRefetch";
import { useDeniedToast } from "../components/Toast";

// Same refresh rates as the original dashboard (2 s readings, 5 s hazards).
// TanStack Query pauses polling while the tab is hidden - except for the
// hazards query, which feeds the emergency alarm: a control-room screen
// sitting behind another window must still sound the alarm
// (useBackgroundRefetch also beats the browser's background-timer throttling).
const SENSORS_MS = 2000;
const HAZARDS_MS = 5000;
/** How long a hazard card stays highlighted after "show" in the alarm. */
const HIGHLIGHT_MS = 8000;

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
    refetchIntervalInBackground: true,
  });
  useBackgroundRefetch(["hazards"], HAZARDS_MS);

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
  const liveState: LiveState = sensors.isError ? "stale" : sensors.isSuccess ? "live" : "connecting";
  // A failed refresh keeps the last good list on screen (TanStack keeps
  // `data` on error) instead of blanking the hazards mid-incident.
  const hazardList = useMemo(() => hazards.data?.hazards ?? [], [hazards.data]);
  const severeCount = hazardList.filter((h) => isSevere(h.severity)).length;
  const alarmItems = useMemo(() => alarmItemsFromHazards(hazardList), [hazardList]);
  const deniedToast = useDeniedToast();

  // "Show" in the alarm pop-up: highlight that hazard's card, scroll to it
  // and move keyboard focus there.
  const [highlightKey, setHighlightKey] = useState<string | null>(null);
  const focusTimer = useRef<number | undefined>(undefined);
  const showHazard = useCallback((item: AlarmItem) => {
    setHighlightKey(item.key);
    window.clearTimeout(focusTimer.current);
    // Wait a moment so the alarm dialog can close (and hand focus back)
    // before focus moves to the card.
    focusTimer.current = window.setTimeout(() => {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-hazard-key]")).find(
        (el) => el.dataset.hazardKey === item.key,
      );
      const target = card ?? document.getElementById("hazards-heading");
      if (!target) return;
      const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
      target.scrollIntoView?.({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      card?.focus({ preventScroll: true });
    }, 50);
  }, []);
  useEffect(() => () => window.clearTimeout(focusTimer.current), []);
  useEffect(() => {
    if (!highlightKey) return;
    const t = window.setTimeout(() => setHighlightKey(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(t);
  }, [highlightKey]);

  const top = hazardList[0];

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      {deniedToast}
      <AppHeader connection={connection}>
        <div className={styles.headerTools}>
          <AlarmSoundToggle />
        </div>
      </AppHeader>
      <EmergencyAlarm items={alarmItems} onShow={showHazard} returnFocusTo="main" />
      <main id="main" className={styles.main} tabIndex={-1}>
        <LiveBar
          state={liveState}
          updatedAt={sensors.dataUpdatedAt}
          hazardCount={hazards.data ? hazardList.length : null}
          severeCount={severeCount}
        />

        <div className={styles.overview}>
          <section className={styles.section} aria-labelledby="critical-heading">
            <h2 id="critical-heading">Critical Hazard</h2>
            {hazards.data ? (
              <CriticalHazard
                hazard={top}
                more={Math.max(0, hazardList.length - 1)}
                highlighted={top !== undefined && hazardKey(top) === highlightKey}
              />
            ) : hazards.isPending ? (
              <HazardSkeleton label="Loading hazards..." />
            ) : (
              <p className={styles.empty}>Hazard status unavailable - see the error below.</p>
            )}
            {route.data && <HospitalCard route={route.data} />}
          </section>

          <section className={`${styles.section} ${styles.readingSection}`} aria-labelledby="reading-heading">
            <div className={styles.sectionHead}>
              <h2 id="reading-heading">Latest Reading</h2>
              {latest && (
                <p className={styles.sectionMeta}>
                  Received <time dateTime={latest.timestamp}>{new Date(latest.timestamp).toLocaleTimeString()}</time>
                </p>
              )}
            </div>
            <KpiTiles latest={latest} count={sensors.data?.count ?? 0} loading={sensors.isPending} />
          </section>
        </div>

        <section className={styles.section} aria-labelledby="hazards-heading">
          <h2 id="hazards-heading">All Active Hazards</h2>
          {hazards.isError && (
            <div className={styles.errorBox}>
              Couldn't load hazards: {hazards.error.message}
              {hazards.data ? " - showing the last known list." : ""}
            </div>
          )}
          {hazards.data ? (
            <HazardList hazards={hazardList} highlightKey={highlightKey} />
          ) : (
            hazards.isPending && <HazardSkeleton label="Loading hazard list..." cards={3} />
          )}
        </section>

        <section className={styles.section} aria-labelledby="sensors-heading">
          <div className={styles.sectionHead}>
            <h2 id="sensors-heading">Latest Sensor Readings</h2>
            <p className={styles.sectionMeta}>Newest first · refreshes every 2 s</p>
          </div>
          {sensors.isError && rows.length > 0 && (
            <div className={styles.errorBox}>
              Couldn't refresh sensor readings: {sensors.error.message} - showing the last received data.
            </div>
          )}
          <SensorTable
            rows={rows}
            loading={sensors.isPending}
            failed={sensors.isError && rows.length === 0}
          />
        </section>
      </main>
    </>
  );
}
