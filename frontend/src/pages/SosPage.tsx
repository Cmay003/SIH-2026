import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiError, apiGet, apiPost } from "../api/client";
import type { DeviceSosStatus, HazardZonesResponse, NearestHospital, SosCreateResponse } from "../api/types";
import { t, type Lang, type StringKey } from "../lib/i18n";
import { evaluateArea, newDeviceId, sosGate, type Coords, type SosHint } from "../lib/sos";
import { readStored, writeStored } from "../lib/storage";
import styles from "./Sos.module.css";

const DESC_BY_LEVEL = {
  LOW: "SANJEEVNI is monitoring environmental conditions in your area.",
  MEDIUM: "A moderate hazard has been detected near your location. Stay alert.",
  HIGH: "A serious hazard has been detected near your location. Follow local safety guidance.",
  CRITICAL: "A critical hazard has been detected near your location. Move to safety immediately.",
} as const;

const HINT_KEY: Record<SosHint, StringKey> = {
  sending: "sosHintSending",
  active: "sosHintActive",
  locating: "sosHintLocating",
  needLocation: "sosHintNeedLocation",
  highRisk: "sosHintHighRisk",
  available: "sosHintAvailable",
};

const GEO_OPTIONS: PositionOptions = { enableHighAccuracy: true, timeout: 15000 };

function getPosition(): Promise<Coords> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("Location is not supported on this device or browser"));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude }),
      (err) => reject(new Error(err.message)),
      GEO_OPTIONS,
    );
  });
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

export function SosPage() {
  const queryClient = useQueryClient();
  const [lang, setLang] = useState<Lang>(() => (readStored("sanjeevni_lang") === "hi" ? "hi" : "en"));
  const deviceId = useDeviceId();
  const [coords, setCoords] = useState<Coords | null>(null);
  const [locating, setLocating] = useState(false);
  const [locationFailed, setLocationFailed] = useState(false);
  const [locateText, setLocateText] = useState("Detecting your location automatically...");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [modal, setModal] = useState<string | null>(null);
  const [sendStatus, setSendStatus] = useState<SendStatus>(null);
  const [result, setResult] = useState<NearestHospital | null>(null);
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
  const nearest = useQuery({
    queryKey: ["nearest-hospital", coords?.latitude.toFixed(4), coords?.longitude.toFixed(4)],
    queryFn: () =>
      apiGet<NearestHospital>(`/api/nearest-hospital?latitude=${coords!.latitude}&longitude=${coords!.longitude}`),
    enabled: coords !== null,
    staleTime: 5 * 60_000,
  });

  // Tell the user when an officer has resolved their earlier SOS
  const deviceActive = deviceSos.data?.active === true;
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && deviceSos.data && !deviceSos.data.active) {
      setSendStatus({ kind: "ok", text: "Your previous SOS was marked resolved. You can send a new one if you still need help." });
      setResult(null);
    }
    if (deviceSos.data?.active) {
      setSendStatus({ kind: "ok", text: "Your SOS is active. Responders have been notified." });
      setResult({ hospital: deviceSos.data.hospital, distance_km: deviceSos.data.distance_km, maps_url: deviceSos.data.maps_url });
    }
    wasActive.current = deviceActive;
  }, [deviceSos.data, deviceActive]);

  async function locate(silent: boolean) {
    setLocating(true);
    setLocateText(silent ? "Detecting your location automatically..." : "Getting your location...");
    try {
      const c = await getPosition();
      setCoords(c);
      setLocationFailed(false);
      setLocateText(`Location detected (${c.latitude.toFixed(4)}, ${c.longitude.toFixed(4)}).`);
    } catch (err) {
      setLocationFailed(true);
      setLocateText(silent
        ? "Location access needed to check your area and find the nearest hospital. Tap “Get My Location” to allow it."
        : `Could not get location: ${(err as Error).message}. Please enable location access and try again.`);
    } finally {
      setLocating(false);
    }
  }

  useEffect(() => {
    void locate(true); // auto-detect on open, no click needed
  }, []);

  const area = evaluateArea(coords, zones.data?.zones ?? []);
  const gate = sosGate({ sending, deviceActive, hasLocation: coords !== null, locationFailed, severity: area.severity });

  async function sendSos() {
    if (!gate.enabled) return;
    setSending(true); // locks the button at once - a double tap can't send twice
    setSendStatus(null);
    try {
      // Never send a possibly stale position: always take a fresh fix first
      setModal("Confirming your current location...");
      let fresh: Coords;
      try {
        fresh = await getPosition();
      } catch (err) {
        setSendStatus({ kind: "error", text: `Could not confirm your location: ${(err as Error).message}. Please enable location access and try again.` });
        return;
      }
      setCoords(fresh);
      setModal("Sending SOS...");
      let data: SosCreateResponse;
      let already = false;
      try {
        data = await apiPost<SosCreateResponse>("/api/sos", { ...fresh, note, device_id: deviceId });
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
      setResult({ hospital: data.hospital, distance_km: data.distance_km, maps_url: data.maps_url });
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
              <p className={styles.muted}>Allow location access to find nearby safe locations and active danger zones.</p>
            </div>
            <button type="button" className={styles.btnPrimary} disabled={locating} onClick={() => void locate(false)}>
              {t(lang, "getLocation")}
            </button>
          </div>
          <div className={styles.locateStatus} role="status">{locateText}</div>
        </section>

        <section className={styles.gridRow}>
          <div className={`${styles.card} ${styles.safetyCard}`}>
            <div>
              <div className={styles.eyebrow}>{t(lang, "areaSafety")}</div>
              <div className={`${styles.riskLabel} ${styles[area.severity]}`}>{area.severity} RISK</div>
              <p className={styles.muted}>{DESC_BY_LEVEL[area.severity]}</p>
            </div>
            <div className={styles.scoreRing}>
              <div className={styles.scoreValue}>{area.score}</div>
              <div className={styles.scoreLabel}>{t(lang, "riskScoreLabel")}</div>
            </div>
          </div>

          <div className={`${styles.card} ${styles.sosCard}`}>
            <h2>{t(lang, "needHelp")}</h2>
            <p className={styles.muted}>If you are in immediate danger, send your location to the SANJEEVNI emergency response system.</p>
            <div className={styles.sosWrap}>
              <button type="button" className={styles.sosBtn} disabled={!gate.enabled} onClick={() => void sendSos()}>
                {t(lang, "sosButton")}
              </button>
            </div>
            <div className={styles.sosHint} aria-live="polite">{t(lang, HINT_KEY[gate.hint])}</div>
          </div>
        </section>

        <section className={`${styles.card} ${styles.spaced}`}>
          <h2 className={styles.smallTitle}>Nearest Hospital &amp; Route</h2>
          {nearest.data ? (
            <>
              <p className={styles.hospName}><strong>{nearest.data.hospital}</strong></p>
              <p className={styles.muted}>{nearest.data.distance_km} km away (driving route)</p>
              <a className={styles.btnPrimary} href={nearest.data.maps_url} target="_blank" rel="noopener noreferrer">
                Directions to hospital
              </a>
            </>
          ) : (
            <p className={styles.muted}>
              {nearest.isError ? "Could not look up the nearest hospital right now." : "Waiting for your location to look up the nearest hospital..."}
            </p>
          )}
        </section>

        <section className={`${styles.card} ${styles.spaced}`}>
          <label htmlFor="note" className={styles.muted}>Optional: describe your situation</label>
          <div className={styles.noteWrap}>
            <textarea id="note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500}
                      placeholder="e.g. trapped by flood water, number of people" />
            <VoiceInput lang={lang} onText={(text) => setNote((n) => (n ? `${n} ${text}` : text))} />
          </div>
          {sendStatus && <div className={`${styles.sendStatus} ${styles[sendStatus.kind]}`} role="alert">{sendStatus.text}</div>}
        </section>

        {result && (
          <section className={`${styles.card} ${styles.spaced} ${styles.resultCard}`}>
            <h3>Help is on the way</h3>
            <p>Nearest hospital: <strong>{result.hospital}</strong></p>
            <p>Distance: {result.distance_km} km</p>
            <a className={styles.btnPrimary} href={result.maps_url} target="_blank" rel="noopener noreferrer">Directions to hospital</a>
          </section>
        )}
      </main>

      {modal && (
        <div className={styles.modalBackdrop} role="dialog" aria-modal="true" aria-live="assertive">
          <div className={styles.modalBox} ref={modalRef} tabIndex={-1} aria-label="SOS progress">
            <div className={styles.spinner} aria-hidden="true" />
            <p>{modal}</p>
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
