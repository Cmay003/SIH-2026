import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Component, lazy, Suspense, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { ApiError, apiGet, apiPost } from "../api/client";
import type { DeviceSosStatus, HazardZonesResponse, LocationSource, NearestHospital, SosCreateResponse } from "../api/types";
import { hazardActions, hazardName } from "../lib/advice";
import { hazardIcon, isSevere } from "../lib/hazards";
import { STRING_KEYS, t, type Lang, type StringKey } from "../lib/i18n";
import {
  accuracyOrNull, evaluateArea, formatAccuracy, isApproximateFix, newDeviceId, sosGate, type Coords, type SosHint,
} from "../lib/sos";
import { readStored, writeStored } from "../lib/storage";
import styles from "./Sos.module.css";

// Leaflet only loads when someone opens the map picker (see the component)
const ManualLocationMap = lazy(() => import("../components/ManualLocationMap"));

const HINT_KEY: Record<SosHint, StringKey> = {
  sending: "sosHintSending",
  active: "sosHintActive",
  locating: "sosHintLocating",
  needLocation: "sosHintNeedLocation",
  highRisk: "sosHintHighRisk",
  available: "sosHintAvailable",
};

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 15000 };
/**
 * Second try when the precise fix fails: a network/cached position up to a
 * minute old, quickly. Indoors or under debris GPS often times out.
 */
const QUICK_GEO_OPTIONS: PositionOptions = { enableHighAccuracy: false, maximumAge: 60_000, timeout: 5000 };

/**
 * One short device-location try when the SOS is sent from a point set by
 * hand on the map: a device fix still wins over a hand-placed point, but the
 * person set the point because location failed, so the SOS must not wait
 * the full 15 + 5 s again.
 */
const MANUAL_RECHECK_OPTIONS: PositionOptions = { enableHighAccuracy: true, maximumAge: 60_000, timeout: 5000 };
/** Offer the map picker when the location takes this long ("slow"), not only after it fails */
export const SLOW_LOCATE_MS = 8000;

/** GeolocationPositionError.PERMISSION_DENIED (the constant isn't on every browser's global) */
const PERMISSION_DENIED = 1;

/** Keeps the GeolocationPositionError code, so "denied" and "timed out" get different advice. */
class LocationError extends Error {
  constructor(message: string, readonly code: number | null) {
    super(message);
  }
}

/**
 * A position from the device, with how far off it may be (coords.accuracy,
 * metres; null if the browser gave none). A device without GPS still answers,
 * from Wi-Fi / cell / IP positioning - sometimes kilometres off.
 */
type DeviceFix = Coords & { accuracy_m: number | null };

function getPosition(options: PositionOptions = GEO_OPTIONS): Promise<DeviceFix> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new LocationError("Location is not supported on this device or browser", null));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        latitude: p.coords.latitude,
        longitude: p.coords.longitude,
        accuracy_m: accuracyOrNull(p.coords.accuracy),
      }),
      (err) => reject(new LocationError(err.message, err.code)),
      options,
    );
  });
}

const isPermissionDenied = (err: unknown) => err instanceof LocationError && err.code === PERMISSION_DENIED;

/** Precise fix first; if that fails for any reason but "denied", a quick coarse one. */
async function getSosPosition(): Promise<DeviceFix> {
  try {
    return await getPosition();
  } catch (err) {
    if (isPermissionDenied(err)) throw err; // asking again can't succeed
    return getPosition(QUICK_GEO_OPTIONS);
  }
}

function useDeviceId(): string {
  const [id] = useState(() => {
    const existing = readStored("sanjeevni_device_id");
    if (existing) return existing;
    const created = newDeviceId();
    writeStored("sanjeevni_device_id", created);
    return created;
  });
  return id;
}

type SendStatus = { kind: "ok" | "error"; text: string } | null;
/**
 * The location status line, kept as keys + values rather than finished text:
 * it is rendered with the current language at display time, so it switches
 * language with the toggle even after the fix that wrote it.
 */
type LocateMsg = { key: StringKey; params?: Record<string, string>; suffix?: StringKey[] };
const locateMessage = (lang: Lang, m: LocateMsg) =>
  [t(lang, m.key, m.params), ...(m.suffix ?? []).map((k) => t(lang, k))].join(" ");
const coordParams = (c: Coords) => ({ lat: c.latitude.toFixed(4), lon: c.longitude.toFixed(4) });
/** Just the position (a DeviceFix carries accuracy_m too) */
const plainCoords = (c: Coords): Coords => ({ latitude: c.latitude, longitude: c.longitude });
/** The SOS went out without a fresh device fix: with the earlier fix (B54) or the point set on the map */
type SentWith = { kind: "earlier" | "manual"; coords: Coords } | null;

/** A typed coordinate pair, or null when it isn't a real position */
export function parseTypedCoords(latText: string, lonText: string): Coords | null {
  if (!latText.trim() || !lonText.trim()) return null;
  // a comma decimal separator is common on Indian/European phone keyboards
  const latitude = Number(latText.trim().replace(",", "."));
  const longitude = Number(lonText.trim().replace(",", "."));
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    return null;
  }
  return { latitude, longitude };
}

/**
 * The map chunk can fail to load (connection dropped after the page loaded).
 * The coordinate fields still work, so say so instead of crashing the page.
 */
class MapLoadBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/** The hospital fields of a server answer (it may carry more, e.g. sos_id). */
const hospitalInfo = (d: NearestHospital): NearestHospital => ({
  hospital: d.hospital,
  distance_km: d.distance_km,
  maps_url: d.maps_url,
  skipped_hospital: d.skipped_hospital ?? null,
  hospital_in_hazard_zone: d.hospital_in_hazard_zone ?? null,
});

/**
 * "(HIGH)" in English as before; in Hindi the translated risk label, since a
 * Latin severity code means little there. A value the table doesn't know is
 * shown as sent.
 */
function severityText(lang: Lang, severity: string): string {
  const key = `risk${severity}`;
  return lang === "en" || !(STRING_KEYS as string[]).includes(key) ? severity : t(lang, key as StringKey);
}

/**
 * Why this hospital and not a nearer one: the server skips hospitals
 * inside an active HIGH/CRITICAL zone (server.js nearestHospital), which can
 * pick one much farther away - the person must be told why.
 * HUMAN REVIEW: safety-critical citizen text (hospSkipped / hospInZone in lib/i18n.ts, Hindi unreviewed).
 */
function HospitalZoneNote({ info, lang }: { info: NearestHospital; lang: Lang }) {
  const skipped = info.skipped_hospital;
  const inZone = info.hospital_in_hazard_zone;
  return (
    <>
      {skipped && (
        <p className={styles.zoneNote}>
          {t(lang, "hospSkipped", {
            hospital: skipped.hospital,
            km: String(skipped.distance_km),
            hazard: hazardName(skipped.hazard_type, lang).toLowerCase(),
            severity: severityText(lang, skipped.severity),
          })}
        </p>
      )}
      {inZone && (
        <p className={styles.zoneNote}>
          {t(lang, "hospInZone", {
            hazard: hazardName(inZone.hazard_type, lang).toLowerCase(),
            severity: severityText(lang, inZone.severity),
          })}
        </p>
      )}
    </>
  );
}

export function SosPage() {
  const queryClient = useQueryClient();
  const [lang, setLang] = useState<Lang>(() => (readStored("sanjeevni_lang") === "hi" ? "hi" : "en"));
  const deviceId = useDeviceId();
  const [coords, setCoords] = useState<Coords | null>(null);
  /** accuracy of coords in metres while it is a device fix (null: unknown, or a point set by hand) */
  const [accuracyM, setAccuracyM] = useState<number | null>(null);
  /** "manual" = coords is a point the person set on the map (no device fix) */
  const [locationSource, setLocationSource] = useState<"gps" | "manual">("gps");
  // read by locate(): the page-open locate can finish after the person set a point
  const sourceRef = useRef(locationSource);
  sourceRef.current = locationSource;
  const [manualOpen, setManualOpen] = useState(false);
  const [slowLocate, setSlowLocate] = useState(false);
  const [latText, setLatText] = useState("");
  const [lonText, setLonText] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);
  const manualTitleRef = useRef<HTMLHeadingElement>(null);
  const [locating, setLocating] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [locateMsg, setLocateMsg] = useState<LocateMsg>({ key: "locAuto" });
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [modal, setModal] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<SendStatus>(null);
  const [result, setResult] = useState<NearestHospital | null>(null);
  /** set when the SOS went out without a fresh fix: the earlier position (B54) or the map point */
  const [sentWith, setSentWith] = useState<SentWith>(null);
  const modalRef = useRef<HTMLDivElement>(null);
  // Move focus into the progress dialog so screen readers announce it and
  // keyboard focus isn't left on the (now disabled) SOS button
  useEffect(() => {
    if (modal) modalRef.current?.focus();
  }, [modal]);

  useEffect(() => {
    document.documentElement.lang = lang;
    writeStored("sanjeevni_lang", lang);
  }, [lang]);

  const status = useQuery({
    queryKey: ["status"],
    queryFn: () => apiGet<{ ok: boolean }>("/api/status"),
    refetchInterval: 5000,
  });
  const zones = useQuery({
    queryKey: ["zones", "public"],
    queryFn: () => apiGet<HazardZonesResponse>("/api/hazard-zones"),
    refetchInterval: 5000,
  });
  const deviceSos = useQuery({
    queryKey: ["device-sos", deviceId],
    queryFn: () => apiGet<DeviceSosStatus>(`/api/sos/device/${encodeURIComponent(deviceId)}`),
    refetchInterval: 5000, // notices when an officer resolves it
  });
  // The server skips hospitals inside HIGH/CRITICAL zones, so look the
  // hospital up again whenever that set of zones changes - not only after
  // the 5 min staleTime (a hospital may have just been flooded).
  const severeZoneKey = (zones.data?.zones ?? [])
    .filter((z) => isSevere(z.severity))
    .map((z) => `${z.node_id}:${z.severity}`)
    .sort()
    .join(",");
  const nearest = useQuery({
    queryKey: ["nearest-hospital", coords?.latitude.toFixed(4), coords?.longitude.toFixed(4), severeZoneKey],
    queryFn: () =>
      apiGet<NearestHospital>(`/api/nearest-hospital?latitude=${coords!.latitude}&longitude=${coords!.longitude}`),
    enabled: coords !== null,
    staleTime: 5 * 60_000,
    placeholderData: (previous) => previous, // keep showing the last answer while re-checking
  });

  // Tell the user when an officer has resolved their earlier SOS
  const deviceActive = deviceSos.data?.active === true;
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && deviceSos.data && !deviceSos.data.active) {
      setSendStatus({ kind: "ok", text: "Your previous SOS was marked resolved. You can send a new one if you still need help." });
      setResult(null);
      setSentWith(null);
    }
    if (deviceSos.data?.active) {
      setSendStatus({ kind: "ok", text: "Your SOS is active. Responders have been notified." });
      setResult(hospitalInfo(deviceSos.data));
    }
    wasActive.current = deviceActive;
  }, [deviceSos.data, deviceActive]);

  /**
   * A device fix replaces a point set by hand on the map - unless the fix is
   * only approximate: the person may have set the point exactly BECAUSE the
   * device's own position was kilometres off, so a coarse fix must not move
   * it back. Returns false when the hand-set point was kept.
   */
  function applyDeviceFix(c: DeviceFix, replacedManual: boolean, sentInstead = false): boolean {
    if (replacedManual && c.accuracy_m !== null && isApproximateFix(c.accuracy_m)) {
      // HUMAN REVIEW: safety-critical citizen text (locApproxManualKept in lib/i18n.ts, Hindi unreviewed)
      setLocateMsg({ key: "locApproxManualKept", params: { acc: formatAccuracy(c.accuracy_m) } });
      return false;
    }
    setCoords(plainCoords(c));
    setAccuracyM(c.accuracy_m);
    setLocationSource("gps");
    setManualOpen(false);
    setManualError(null);
    setLocationFailed(false);
    setLocateMsg({
      key: "locDetected",
      params: coordParams(c),
      suffix: sentInstead ? ["locSentInstead"] : replacedManual ? ["locReplacesManual"] : [],
    });
    return true;
  }

  async function locate(silent: boolean) {
    setLocating(true);
    setLocateMsg({ key: silent ? "locAuto" : "locGetting" });
    try {
      const c = await getPosition();
      applyDeviceFix(c, sourceRef.current === "manual");
    } catch (err) {
      setLocationFailed(true);
      // Only a refusal needs "enable location access"; a timeout just needs another try.
      // The browser's error text is not translated: it goes in as {msg}.
      const msg: LocateMsg = silent
        ? { key: "locNeedSilent" }
        : { key: isPermissionDenied(err) ? "locDenied" : "locRetry", params: { msg: (err as Error).message } };
      // a failed retry must not drop the point the person already set by hand
      setLocateMsg(sourceRef.current === "manual" ? { ...msg, suffix: ["locManualKept"] } : msg);
    } finally {
      setLocating(false);
    }
  }

  // "Slow": no answer yet after SLOW_LOCATE_MS - offer the map then too
  // (indoors a fix can take the full 15 s timeout, or never come).
  useEffect(() => {
    if (!locating) return;
    const timer = window.setTimeout(() => setSlowLocate(true), SLOW_LOCATE_MS);
    return () => window.clearTimeout(timer);
  }, [locating]);

  // The offer button disappears when the picker opens: move focus to the
  // picker's heading so keyboard and screen-reader users aren't lost.
  useEffect(() => {
    if (manualOpen) manualTitleRef.current?.focus();
  }, [manualOpen]);

  /** A point set by hand: used for the area risk, the hospital and the SOS, marked "manual". */
  function applyManualPoint(picked: Coords) {
    // 5 decimals (~1 m): a tap is no more exact than that, and the value sent
    // then matches the fields (Leaflet's wrap() leaves float noise like 79.45420000000001)
    const c = { latitude: Number(picked.latitude.toFixed(5)), longitude: Number(picked.longitude.toFixed(5)) };
    setCoords(c);
    setAccuracyM(null);
    setLocationSource("manual");
    setManualError(null);
    setLatText(c.latitude.toFixed(5));
    setLonText(c.longitude.toFixed(5));
    // HUMAN REVIEW: safety-critical citizen text (locManualSet in lib/i18n.ts, Hindi unreviewed)
    setLocateMsg({ key: "locManualSet", params: coordParams(c) });
  }

  function applyTypedCoords(e: FormEvent) {
    e.preventDefault();
    const c = parseTypedCoords(latText, lonText);
    if (!c) {
      setManualError("Enter a latitude between -90 and 90 and a longitude between -180 and 180, e.g. 29.39 and 79.45.");
      return;
    }
    applyManualPoint(c);
  }

  useEffect(() => {
    void locate(true); // auto-detect on open, no click needed
  }, []);

  const area = evaluateArea(coords, zones.data?.zones ?? []);
  // Don't show "LOW RISK / 0" before we know where the user is and which
  // zones are active - a citizen could read that as "my area is safe".
  const areaKnown = coords !== null && zones.isSuccess;
  // Public zones are confirmed alerts only (server.js /api/hazard-zones), so
  // a zone here is safe to give advice for. Overlapping zones: evaluateArea
  // already picked the most severe one.
  const hazard = areaKnown ? area.zone : null;
  const gate = sosGate({ sending, deviceActive, hasLocation: coords !== null, locationFailed, severity: area.severity });
  // The device location comes first: the map is offered only once it has
  // failed or is slow, and never replaces a working fix.
  const offerManual = !manualOpen && coords === null && (locationFailed || slowLocate);
  // A device fix that may be far off (no GPS: Wi-Fi / cell / IP position).
  // Only a notice with a way to the map - the SOS button is NEVER held back
  // by it (team rule: with a location, SOS always works).
  const approxAccuracy = coords !== null && locationSource === "gps" && isApproximateFix(accuracyM) ? accuracyM : null;

  async function sendSos() {
    if (!gate.enabled) return;
    setSending(true); // locks the button at once - a double tap can't send twice
    setSendStatus(null);
    setSentWith(null);
    const manual = locationSource === "manual";
    try {
      // Prefer a fresh fix: the position found when the page opened may be
      // old. But if no fresh fix comes (indoors, under debris, poor GPS -
      // likely in a disaster), send with that earlier position rather than
      // not at all: it is where the person was a moment ago (B54).
      // A point set by hand gets one short device try (MANUAL_RECHECK_OPTIONS).
      setModal(manual ? "Checking for your device location..." : "Confirming your current location...");
      let fix: DeviceFix | null = null;
      try {
        fix = manual ? await getPosition(MANUAL_RECHECK_OPTIONS) : await getSosPosition();
      } catch (err) {
        if (!coords) {
          // (the SOS button needs a location, so this is a safety net only)
          // HUMAN REVIEW: safety-critical citizen advice - check wording (and any Hindi version) before release.
          setSendStatus({
            kind: "error",
            text: isPermissionDenied(err)
              ? `Could not get your location: ${(err as Error).message}. Please enable location access and try again, or call your local emergency number (112).`
              : `Could not get your location: ${(err as Error).message}. Please call your local emergency number (112).`,
          });
          return;
        }
      }
      let fresh: Coords;
      let accuracy: number | null;
      let source: LocationSource = "gps";
      let fallback: "earlier" | "manual" | null = null;
      if (fix && (!manual || applyDeviceFix(fix, true, true))) {
        if (!manual) {
          setCoords(plainCoords(fix));
          setAccuracyM(fix.accuracy_m);
        }
        fresh = plainCoords(fix);
        accuracy = fix.accuracy_m;
      } else {
        // No fresh fix (also after a refusal: the person pressed SOS, and
        // this position was shared with their permission when the page
        // opened - or they set it on the map themselves), or only an
        // approximate one that must not replace their hand-set point.
        fresh = coords!;
        source = locationSource;
        accuracy = manual ? null : accuracyM;
        fallback = manual ? "manual" : "earlier";
      }
      setModal("Sending SOS...");
      let data: SosCreateResponse;
      let already = false;
      try {
        // location_source lets officers see a hand-placed (approximate) point;
        // location_accuracy_m how far off a device fix may be (null = unknown / by hand)
        data = await apiPost<SosCreateResponse>("/api/sos", {
          latitude: fresh.latitude,
          longitude: fresh.longitude,
          note,
          device_id: deviceId,
          location_source: source,
          location_accuracy_m: source === "gps" ? accuracy : null,
        });
      } catch (err) {
        const body = err instanceof ApiError ? (err.data as Partial<SosCreateResponse> | null) : null;
        if (err instanceof ApiError && err.status === 409 && body?.status === "already_active") {
          data = body as SosCreateResponse; // another tab got there first - same outcome
          already = true;
        } else {
          setSendStatus({ kind: "error", text: `${(err as Error).message}. Please call your local emergency number (112).` });
          return;
        }
      }
      setResult(hospitalInfo(data));
      // Shown in the result card, not in sendStatus: the device-status poll
      // rewrites sendStatus a moment later. An "already active" SOS was
      // filed earlier with its own location, so the note doesn't apply.
      setSentWith(fallback && !already ? { kind: fallback, coords: fresh } : null);
      setSendStatus({ kind: "ok", text: already ? "Your SOS is already active. Responders have been notified." : "SOS sent. Responders have been notified." });
      await queryClient.invalidateQueries({ queryKey: ["device-sos", deviceId] });
    } finally {
      setModal(null);
      setSending(false);
    }
  }

  const connText = status.isError ? t(lang, "disconnected") : status.isSuccess ? t(lang, "connected") : t(lang, "connecting");

  return (
    <div className={styles.page}>
      <header className={styles.topbar}>
        <button type="button" className={styles.langToggle} onClick={() => setLang(lang === "en" ? "hi" : "en")}
                lang={lang === "en" ? "hi" : "en"}>
          {lang === "en" ? "हिंदी" : "English"}
        </button>
        <h1>SANJEEVNI</h1>
        <div className={styles.portalLabel}>{t(lang, "portalLabel")}</div>
        <div className={styles.connStatus} role="status">{connText}</div>
      </header>

      <main className={styles.main}>
        <section className={`${styles.card} ${styles.locateCard}`}>
          <div className={styles.locateHead}>
            <div>
              <h2>{t(lang, "checkSafety")}</h2>
              <p className={styles.muted}>{t(lang, "locateIntro")}</p>
            </div>
            <button type="button" className={styles.btnPrimary} disabled={locating} onClick={() => void locate(false)}>
              {t(lang, "getLocation")}
            </button>
          </div>
          <div className={styles.locateStatus} role="status">{locateMessage(lang, locateMsg)}</div>
          {approxAccuracy !== null && !manualOpen && (
            // HUMAN REVIEW: safety-critical citizen text (approxNotice / approxSetOnMap in lib/i18n.ts, Hindi unreviewed)
            <div className={styles.approxNotice} role="note">
              <p>{t(lang, "approxNotice", { acc: formatAccuracy(approxAccuracy) })}</p>
              <button type="button" className={styles.btnSecondary} onClick={() => setManualOpen(true)}>
                {t(lang, "approxSetOnMap")}
              </button>
            </div>
          )}
          {offerManual && (
            <button type="button" className={styles.btnSecondary} onClick={() => setManualOpen(true)}>
              {t(lang, "manualOffer")}
            </button>
          )}
          {manualOpen && (
            <div className={styles.manualBox}>
              <h3 id="manual-title" className={styles.manualTitle} ref={manualTitleRef} tabIndex={-1}>
                {t(lang, "manualTitle")}
              </h3>
              <p className={styles.muted}>{t(lang, "manualHelp")}</p>
              <div className={styles.manualMapWrap} role="region"
                   aria-label="Map for setting your location (the latitude and longitude fields do the same)">
                <MapLoadBoundary fallback={
                  <p className={styles.muted}>The map could not load. Type your coordinates below, or call 112.</p>
                }>
                  <Suspense fallback={<p className={styles.muted}>Loading map...</p>}>
                    <ManualLocationMap point={locationSource === "manual" ? coords : null}
                                       zones={zones.data?.zones ?? []} onPick={applyManualPoint} />
                  </Suspense>
                </MapLoadBoundary>
              </div>
              <form className={styles.manualFields} onSubmit={applyTypedCoords} aria-labelledby="manual-title" noValidate>
                <label>
                  <span>{t(lang, "manualLat")}</span>
                  <input name="manual-latitude" value={latText} onChange={(e) => setLatText(e.target.value)} inputMode="decimal"
                         autoComplete="off" aria-invalid={manualError ? true : undefined}
                         aria-describedby={manualError ? "manual-error" : undefined} />
                </label>
                <label>
                  <span>{t(lang, "manualLon")}</span>
                  <input name="manual-longitude" value={lonText} onChange={(e) => setLonText(e.target.value)} inputMode="decimal"
                         autoComplete="off" aria-invalid={manualError ? true : undefined}
                         aria-describedby={manualError ? "manual-error" : undefined} />
                </label>
                <button type="submit" className={styles.btnPrimary}>{t(lang, "manualApply")}</button>
              </form>
              {manualError && <p id="manual-error" className={styles.fieldError} role="alert">{manualError}</p>}
            </div>
          )}
        </section>

        <section className={styles.gridRow}>
          <div className={`${styles.card} ${styles.safetyCard}`}>
            <div>
              <div className={styles.eyebrow}>{t(lang, "areaSafety")}</div>
              {/* Live region: a screen reader announces the risk, the hazard
                  and what to do when the person walks into (or out of) a zone. */}
              <div aria-live="polite" aria-atomic="true">
                {areaKnown ? (
                  <>
                    <div className={`${styles.riskLabel} ${styles[area.severity]}`}>{t(lang, `risk${area.severity}`)}</div>
                    {hazard ? (
                      <>
                        <p className={styles.hazardName}>
                          <span aria-hidden="true">{hazardIcon(hazard.hazard_type)} </span>
                          <span className="visually-hidden">{t(lang, "hazardInArea")} </span>
                          {hazardName(hazard.hazard_type, lang)}
                        </p>
                        {/* HUMAN REVIEW: safety-critical advice from data/hazard_advice.json (Hindi unreviewed) */}
                        <p className={styles.adviceHead}>{t(lang, "whatToDo")}</p>
                        <ul className={styles.adviceList}>
                          {hazardActions(hazard.hazard_type, area.severity, lang).map((a) => <li key={a}>{a}</li>)}
                        </ul>
                      </>
                    ) : (
                      <p className={styles.muted}>{t(lang, "areaLowDesc")}</p>
                    )}
                  </>
                ) : (
                  <>
                    <div className={`${styles.riskLabel} ${styles.unknown}`}>{t(lang, "areaUnknown")}</div>
                    <p className={styles.muted}>{t(lang, coords === null ? "areaNeedLocation" : "areaChecking")}</p>
                  </>
                )}
              </div>
            </div>
            <div className={styles.scoreRing}>
              <div className={styles.scoreValue}>{areaKnown ? area.score : "–"}</div>
              <div className={styles.scoreLabel}>{t(lang, "riskScoreLabel")}</div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.sosCard}`}>
            <h2>{t(lang, "needHelp")}</h2>
            <p className={styles.muted}>{t(lang, "sosIntro")}</p>
            <div className={styles.sosWrap}>
              <button type="button" className={styles.sosBtn} disabled={!gate.enabled} onClick={() => void sendSos()}>
                {t(lang, "sosButton")}
              </button>
            </div>
            <div className={styles.sosHint} aria-live="polite">{t(lang, HINT_KEY[gate.hint])}</div>
          </div>
        </section>

        <section className={`${styles.card} ${styles.spaced}`}>
          <h2 className={styles.smallTitle}>{t(lang, "hospTitle")}</h2>
          {nearest.data ? (
            <>
              <p className={styles.hospName}><strong>{nearest.data.hospital}</strong></p>
              {/* straight-line ("as the crow flies") from server.js - the road route is usually longer */}
              <p className={styles.muted}>{t(lang, "hospDistance", { km: String(nearest.data.distance_km) })}</p>
              <HospitalZoneNote info={nearest.data} lang={lang} />
              <a className={styles.btnPrimary} href={nearest.data.maps_url} target="_blank" rel="noopener noreferrer">
                {t(lang, "hospDirections")}
              </a>
            </>
          ) : (
            <p className={styles.muted}>
              {t(lang, nearest.isError ? "hospError" : "hospWaiting")}
            </p>
          )}
        </section>

        <section className={`${styles.card} ${styles.spaced}`}>
          <label htmlFor="note" className={styles.muted}>{t(lang, "noteLabel")}</label>
          <div className={styles.noteWrap}>
            <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                      placeholder={t(lang, "notePlaceholder")} />
            <VoiceInput lang={lang} onText={(text) => setNote((n) => (n ? `${n} ${text}` : text))} />
          </div>
          {sendStatus && <div className={`${styles.sendStatus} ${styles[sendStatus.kind]}`} role="alert">{sendStatus.text}</div>}
        </section>

        {result && (
          <section className={`${styles.card} ${styles.spaced} ${styles.resultCard}`}>
            <h3>Help is on the way</h3>
            <p>Nearest hospital: <strong>{result.hospital}</strong></p>
            <p>Distance: {result.distance_km} km (straight-line)</p>
            <HospitalZoneNote info={result} lang={lang} />
            {sentWith?.kind === "earlier" && (
              // HUMAN REVIEW: safety-critical citizen advice - check wording (and add a Hindi version) before release.
              <p className={styles.earlierLocation}>
                Your current location could not be confirmed, so the location found earlier
                ({sentWith.coords.latitude.toFixed(4)}, {sentWith.coords.longitude.toFixed(4)}) was sent.
                If you have moved since then, also call 112.
              </p>
            )}
            {sentWith?.kind === "manual" && (
              // HUMAN REVIEW: safety-critical citizen advice - check wording (and add a Hindi version) before release.
              <p className={styles.earlierLocation}>
                The point you set on the map ({sentWith.coords.latitude.toFixed(4)}, {sentWith.coords.longitude.toFixed(4)})
                was sent. Responders know it was set by hand and may be approximate - if you can, also call 112 and
                describe where you are.
              </p>
            )}
            <a className={styles.btnPrimary} href={result.maps_url} target="_blank" rel="noopener noreferrer">
              {t(lang, "hospDirections")}
            </a>
          </section>
        )}
      </main>

      {modal && (
        <div className={styles.modalBackdrop}>
          <div className={styles.modalBox} ref={modalRef} tabIndex={-1}
               role="dialog" aria-modal="true" aria-label="SOS progress">
            <div className={styles.spinner} aria-hidden="true" />
            <p aria-live="assertive">{modal}</p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---- voice input (browser SpeechRecognition; hidden where unsupported) ----
interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

function VoiceInput({ lang, onText }: { lang: Lang; onText: (text: string) => void }) {
  const [listening, setListening] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const w = window as unknown as Record<string, (new () => SpeechRecognitionLike) | undefined>;
  const Impl = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  if (!Impl) return null;

  const toggle = () => {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const r = new Impl();
    r.lang = lang === "hi" ? "hi-IN" : "en-IN";
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => onText(e.results[0][0].transcript);
    r.onend = r.onerror = () => setListening(false);
    recognition.current = r;
    try {
      r.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  };

  return (
    <button type="button" className={`${styles.voiceBtn} ${listening ? styles.listening : ""}`} onClick={toggle}
            aria-label={listening ? "Stop voice input" : "Speak your situation instead of typing"}
            title="Speak your situation instead of typing">
      {listening ? "⏹" : "🎤"}
    </button>
  );
}
