// Emergency alarm pop-up + siren for HIGH/CRITICAL hazards.
//
// Render <EmergencyAlarm items={...} /> once per page (inside <Providers>);
// the dialog is portalled to document.body. Which items alarm, their order
// and the acknowledgement bookkeeping live in lib/alarm.ts (pure functions);
// the Web Audio siren lives in lib/siren.ts.
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  acknowledgeItems,
  ALERT_TITLE_PREFIX,
  alarmingItems,
  alarmSoundPref,
  nodeListText,
  readAcks,
  refreshAcks,
  writeAcks,
  type AckMap,
  type AlarmItem,
} from "../lib/alarm";
import { hazardIcon, percent } from "../lib/hazards";
import { PublicAdviceSection } from "./PublicAdvice";
import { Confidence } from "./Confidence";
import { siren } from "../lib/siren";
import styles from "./EmergencyAlarm.module.css";

/**
 * Until the feed has delivered at least one item (or this long has passed),
 * an empty list may just mean "still loading" - don't prune the stored
 * acknowledgements yet, or a page reload would re-alarm everything.
 */
const PRUNE_GRACE_MS = 20_000;
/**
 * How often acknowledgements are re-checked while `items` keeps the same
 * reference (TanStack structural sharing). Background tabs may stretch this
 * to about a minute - still well inside ACK_HOLD_MS.
 */
const ACK_REFRESH_MS = 30_000;

const SEVERITY_RANK: Record<AlarmItem["severity"], number> = { HIGH: 1, CRITICAL: 2 };

/** Events that count as a user gesture for unlocking audio (incl. iOS touchend). */
const UNLOCK_EVENTS = ["pointerdown", "pointerup", "keydown", "touchend", "click"] as const;

/** Marks a control that unlocks audio itself, so the page-wide gesture listener leaves it alone. */
const OWN_UNLOCK_ATTR = "data-own-audio-unlock"; // keep in sync with AlarmSoundToggle

// details > summary: the "What the public is told" toggle is a tab stop too - without it the
// wrap from Acknowledge skipped the first item's toggle (W2 browser check)
const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), details > summary:first-of-type, [tabindex]:not([tabindex="-1"])';

function useSoundOn(): boolean {
  return useSyncExternalStore(alarmSoundPref.subscribe, alarmSoundPref.get, alarmSoundPref.get);
}

function useAudioUnlocked(): boolean {
  return useSyncExternalStore(siren.subscribe, siren.isUnlocked, siren.isUnlocked);
}

/** Where the hazard is, for the Location line. An area-wide forecast item names its nodes. */
const placeText = (item: AlarmItem) =>
  item.forecastNodeIds
    ? `Forecast area: ${nodeListText(item.forecastNodeIds)}`
    : item.location && item.location !== item.nodeId ? `${item.location} (${item.nodeId})` : item.nodeId;
/** "at Sector 4 (NODE-04)" / "across the forecast area (NODE-01, NODE-02)" - for sentences. */
const whereText = (item: AlarmItem) =>
  item.forecastNodeIds ? `across the forecast area (${nodeListText(item.forecastNodeIds)})` : `at ${placeText(item)}`;

/**
 * returnFocusTo: id of an element to focus when the dialog closes and there is
 * no real element to give focus back to (e.g. it opened during page load).
 */
export function EmergencyAlarm({
  items,
  onShow,
  onAcknowledge,
  acknowledgeNote,
  returnFocusTo,
}: {
  items: AlarmItem[];
  onShow?: (item: AlarmItem) => void;
  /**
   * Called with the most severe item when the Acknowledge BUTTON is clicked
   * (not on Escape) - still inside the click, so it may open a tab.
   */
  onAcknowledge?: (top: AlarmItem) => void;
  /** Short text next to Acknowledge saying what else it does (e.g. "Opens the officer map"). */
  acknowledgeNote?: string;
  returnFocusTo?: string;
}) {
  const [acks, setAcks] = useState<AckMap>(readAcks);
  const [canPrune, setCanPrune] = useState(false);
  const soundOn = useSoundOn();
  const unlocked = useAudioUnlocked();
  const supported = siren.isSupported();

  const alarming = useMemo(() => alarmingItems(items, acks), [items, acks]);
  const open = alarming.length > 0;

  const dialogRef = useRef<HTMLDivElement>(null);
  const ackRef = useRef<HTMLButtonElement>(null);
  /** set while "Show" hands focus to the page, so the focus trap lets go */
  const releasingRef = useRef(false);
  const titleId = useId();
  const descId = useId();
  const ackNoteId = useId();
  const itemsRef = useRef(items);
  itemsRef.current = items;
  // a ref keeps it out of the [open] focus effect's dependencies
  const returnFocusToRef = useRef(returnFocusTo);
  returnFocusToRef.current = returnFocusTo;

  // ---- acknowledgements: mirror to sessionStorage, expire ended hazards ----
  useEffect(() => writeAcks(acks), [acks]);

  useEffect(() => {
    if (items.length > 0) setCanPrune(true);
  }, [items.length]);

  useEffect(() => {
    const t = window.setTimeout(() => setCanPrune(true), PRUNE_GRACE_MS);
    return () => window.clearTimeout(t);
  }, []);

  // A hazard that dips below HIGH for a poll or two keeps its acknowledgement
  // (ACK_HOLD_MS); one that has been gone longer alarms again when it returns.
  useEffect(() => {
    if (!canPrune) return;
    const run = () => setAcks((prev) => refreshAcks(prev, itemsRef.current, Date.now()));
    run();
    const t = window.setInterval(run, ACK_REFRESH_MS);
    return () => window.clearInterval(t);
  }, [canPrune, items]);

  const acknowledge = useCallback((list: AlarmItem[]) => {
    siren.stop(); // silence at once, before React re-renders
    setAcks((prev) => acknowledgeItems(prev, list, Date.now()));
  }, []);

  const acknowledgeAll = useCallback(() => acknowledge(alarming), [acknowledge, alarming]);

  // Acknowledge and Show are skipped by the page-wide unlock listener
  // (OWN_UNLOCK_ATTR): it would unlock on their pointerdown/keydown, while
  // the alarm is still open, and the siren would blare until the click lands
  // a moment later - the action meant to silence it made it sound (B64).
  // They unlock here instead, in the click (still a user gesture) and after
  // the acknowledgement is queued: React commits it before resume() resolves
  // (in the same render when unlock happens synchronously), so the alarm is
  // already closed when audio unlocks, and later alarms can sound.
  const unlockAfterAck = () => {
    if (supported && !unlocked) void siren.unlock();
  };

  const acknowledgeByClick = () => {
    const top = alarming[0];
    acknowledgeAll();
    unlockAfterAck();
    if (top) onAcknowledge?.(top);
  };

  const show = (item: AlarmItem) => {
    releasingRef.current = true;
    acknowledge(alarming); // everything listed has now been seen
    unlockAfterAck();
    onShow?.(item);
  };

  // ---- audio: unlock on the first user gesture anywhere on the page ----
  useEffect(() => {
    if (!supported || unlocked) return;
    const tryUnlock = (e: Event) => {
      if (e.target instanceof Element && e.target.closest(`[${OWN_UNLOCK_ATTR}]`)) return;
      // Escape, touch pointerdown etc. are not user activation: creating the
      // AudioContext then logs a warning and leaves it suspended. Wait for a real
      // gesture - the listener stays attached, so the next activating event unlocks.
      if (navigator.userActivation?.isActive === false) return;
      void siren.unlock();
    };
    UNLOCK_EVENTS.forEach((ev) => document.addEventListener(ev, tryUnlock, true));
    return () => UNLOCK_EVENTS.forEach((ev) => document.removeEventListener(ev, tryUnlock, true));
  }, [supported, unlocked]);

  const shouldSound = open && soundOn && unlocked;
  useEffect(() => {
    if (!shouldSound) return;
    siren.start();
    return () => siren.stop();
  }, [shouldSound]);

  // ---- tab title while unacknowledged ----
  useEffect(() => {
    if (!open) return;
    if (!document.title.startsWith(ALERT_TITLE_PREFIX)) document.title = ALERT_TITLE_PREFIX + document.title;
    return () => {
      if (document.title.startsWith(ALERT_TITLE_PREFIX)) document.title = document.title.slice(ALERT_TITLE_PREFIX.length);
    };
  }, [open]);

  // ---- focus + modality: make the page inert, move focus in, restore on close ----
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // The dialog is portalled to document.body, outside #root, so it stays reachable.
    const root = document.getElementById("root");
    const inertRoot = root && !root.hasAttribute("inert") ? root : null;
    inertRoot?.setAttribute("inert", "");
    releasingRef.current = false;
    ackRef.current?.focus();
    return () => {
      // Lift inert first, or nothing inside #root can take focus back.
      inertRoot?.removeAttribute("inert");
      // After the dialog is gone: give focus back unless something already
      // took it. If focus was on <body> (opened during page load), fall back
      // to returnFocusTo so keyboard users don't restart from the top.
      window.setTimeout(() => {
        if (releasingRef.current) return; // "Show": the page moves focus itself
        const active = document.activeElement;
        if (active && active !== document.body) return; // something already took focus
        const fallback = returnFocusToRef.current ? document.getElementById(returnFocusToRef.current) : null;
        const target = previous && previous !== document.body && previous.isConnected ? previous : fallback;
        target?.focus({ preventScroll: true });
      }, 0);
    };
  }, [open]);

  // The footer's sound buttons swap when audio unlocks or the mute pref
  // changes. Audio unlocks on pointerdown (capture listener), so "Enable alarm
  // sound" is often removed before its click fires and focus falls to <body>.
  // Pull it back into the dialog.
  useEffect(() => {
    if (!open || releasingRef.current) return;
    const dialog = dialogRef.current;
    const active = document.activeElement;
    if (dialog && (!active || active === document.body || !dialog.contains(active))) {
      ackRef.current?.focus();
    }
  }, [open, unlocked, soundOn]);

  // ---- keyboard: Escape acknowledges, Tab stays inside the dialog ----
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        acknowledgeAll();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && dialog.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    const onFocusIn = (e: FocusEvent) => {
      const dialog = dialogRef.current;
      if (releasingRef.current || !dialog) return;
      if (e.target instanceof Node && !dialog.contains(e.target)) ackRef.current?.focus();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [open, acknowledgeAll]);

  // ---- lock page scroll behind the modal ----
  // Reserve the scrollbar's space while locked, so the page behind does not
  // shift sideways on open/close - only if a scrollbar is showing (dashboard),
  // so pages without one (officer map) don't gain an empty gutter. CSSOM
  // writes, not a style attribute, so the strict CSP does not block them.
  useEffect(() => {
    if (!open) return;
    const html = document.documentElement;
    const prevOverflow = html.style.overflow;
    const prevGutter = html.style.getPropertyValue("scrollbar-gutter");
    if (window.innerWidth > html.clientWidth) html.style.setProperty("scrollbar-gutter", "stable");
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevOverflow;
      if (prevGutter) html.style.setProperty("scrollbar-gutter", prevGutter);
      else html.style.removeProperty("scrollbar-gutter");
    };
  }, [open]);

  // ---- announce hazards that arrive or escalate while the dialog is open ----
  const [announcement, setAnnouncement] = useState("");
  const seenRef = useRef<Map<string, AlarmItem["severity"]> | null>(null);
  useEffect(() => {
    if (!open) {
      seenRef.current = null;
      setAnnouncement("");
      return;
    }
    const prev = seenRef.current;
    seenRef.current = new Map(alarming.map((i) => [i.key, i.severity]));
    if (!prev) return; // first open: the alertdialog itself is announced
    const fresh = alarming.filter((i) => {
      const p = prev.get(i.key);
      return !p || SEVERITY_RANK[i.severity] > SEVERITY_RANK[p];
    });
    if (fresh.length === 0) return;
    const f = fresh[0]; // alarming is sorted most severe first
    const n = alarming.length;
    setAnnouncement(
      `New ${f.severity} hazard: ${f.title} ${whereText(f)}.` +
        (fresh.length > 1 ? ` ${fresh.length - 1} more new.` : "") +
        ` ${n} ${n === 1 ? "hazard needs" : "hazards need"} attention.`,
    );
  }, [open, alarming]);

  if (!open) return null;

  const top = alarming[0];
  const critical = top.severity === "CRITICAL";
  const count = alarming.length;
  const summary =
    count === 1
      ? `${top.title}: ${top.severity} risk ${whereText(top)}. Acknowledge to silence the alarm.`
      : `${count} hazards need immediate attention. Most severe: ${top.title}, ${top.severity} ${whereText(top)}.`;
  const needsSoundButton = supported && soundOn && !unlocked;

  return createPortal(
    <div className={styles.backdrop}>
      <div
        ref={dialogRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        className={`${styles.dialog} ${critical ? styles.critical : ""}`}
      >
        <p className="visually-hidden" aria-live="assertive" aria-atomic="true">{announcement}</p>
        <div className={styles.banner}>
          <span className={styles.bannerIcon} aria-hidden="true">🚨</span>
          <div>
            <h2 id={titleId} className={styles.heading}>
              {critical ? "Critical hazard alert" : "Emergency alert"}
            </h2>
            <p id={descId} className={styles.summary}>{summary}</p>
          </div>
        </div>

        <div className={styles.body}>
          <ul className={styles.list} aria-label="Hazards needing attention">
            {alarming.map((item) => (
              <li key={item.key} className={`${styles.item} ${item.severity === "CRITICAL" ? styles.itemCritical : ""}`}>
                <div className={styles.itemHead}>
                  <span className={styles.itemIcon} aria-hidden="true">{hazardIcon(item.hazardType)}</span>
                  <h3 className={styles.itemTitle}>{item.title}</h3>
                  <span className={`${styles.badge} ${item.severity === "CRITICAL" ? styles.badgeCritical : ""}`}>
                    {item.severity}
                  </span>
                </div>
                <dl className={styles.facts}>
                  <div>
                    <dt>Location</dt>
                    <dd>{placeText(item)}</dd>
                  </div>
                  <div className={styles.risk}>
                    <dt>Risk score</dt>
                    <dd>{percent(item.riskScore)}</dd>
                  </div>
                </dl>
                <Confidence value={item.confidence} maxReasons={3} />
                {item.detail && <p className={styles.detail}>{item.detail}</p>}
                <PublicAdviceSection hazardType={item.hazardType} severity={item.severity}
                                     label={`${item.title} ${whereText(item)}`} />
                {onShow && (
                  <button
                    type="button"
                    className={styles.showBtn}
                    aria-label={`Show ${item.title} ${whereText(item)}`}
                    data-own-audio-unlock=""
                    onClick={() => show(item)}
                  >
                    Show
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div
          className={styles.footer}
          // Audio unlocks on pointerdown, so "Enable alarm sound" can unmount before
          // mousedown. mousedown then hits this non-focusable div and would blur focus
          // to <body>. Cancel that default so focus stays on Acknowledge (put there by
          // the pull-back effect). Scoped to the footer so text in the hazard list
          // (e.g. a location) can still be selected and copied.
          onMouseDown={(e) => {
            if (!(e.target as Element).closest(FOCUSABLE)) e.preventDefault();
          }}
        >
          {needsSoundButton && (
            <button
              type="button"
              className={styles.soundBtn}
              onClick={() => {
                void siren.unlock().then(() => ackRef.current?.focus());
              }}
            >
              <span aria-hidden="true">🔊</span> Enable alarm sound
            </button>
          )}
          {supported && soundOn && unlocked && (
            <button
              type="button"
              className={styles.soundBtn}
              onClick={() => {
                alarmSoundPref.set(false); // the shouldSound effect cleanup also stops the siren
                siren.stop(); // stop right away, before React re-renders
                ackRef.current?.focus(); // this button unmounts: keep focus in the dialog
              }}
            >
              <span aria-hidden="true">🔕</span> Mute alarm sound
            </button>
          )}
          {supported && !soundOn && (
            <>
              <p className={styles.mutedNote}>Alarm sound is muted.</p>
              <button
                type="button"
                className={styles.soundBtn}
                onClick={() => {
                  alarmSoundPref.set(true);
                  void siren.unlock(); // this click is a user gesture
                  ackRef.current?.focus();
                }}
              >
                <span aria-hidden="true">🔔</span> Unmute
              </button>
            </>
          )}
          {acknowledgeNote && <p id={ackNoteId} className={styles.mutedNote}>{acknowledgeNote}</p>}
          <button ref={ackRef} type="button" className={styles.ackBtn} data-own-audio-unlock="" onClick={acknowledgeByClick}
                  aria-describedby={acknowledgeNote ? ackNoteId : undefined}>
            Acknowledge
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Small control for the alarm sound: On / Off / "Click to enable sound" (browser audio still locked). */
export function AlarmSoundToggle({ variant = "onBrand" }: { variant?: "onBrand" | "light" }) {
  const soundOn = useSoundOn();
  const unlocked = useAudioUnlocked();
  const variantClass = variant === "light" ? styles.light : styles.onBrand;

  if (!siren.isSupported()) {
    return (
      <span className={`${styles.toggle} ${styles.unavailable} ${variantClass}`}>
        <span aria-hidden="true">🔕</span> Alarm sound unavailable
      </span>
    );
  }

  const locked = soundOn && !unlocked;
  const label = !soundOn ? "Alarm sound: Off" : locked ? "Click to enable sound" : "Alarm sound: On";
  const hint = !soundOn
    ? "Turn the emergency alarm sound on"
    : locked
      ? "Browsers allow sound only after you click the page once"
      : "Turn the emergency alarm sound off (pop-ups still appear)";

  const onClick = () => {
    if (locked) {
      void siren.unlock();
      return;
    }
    alarmSoundPref.set(!soundOn);
    if (!soundOn) void siren.unlock(); // turning on is a gesture - unlock now too
  };

  return (
    <button
      type="button"
      className={`${styles.toggle} ${variantClass} ${!soundOn ? styles.off : ""} ${locked ? styles.locked : ""}`}
      title={hint}
      // The page-wide unlock listener skips this button: otherwise it unlocks
      // on pointerdown, the button re-renders as "On" before its click, and
      // that click mutes. This button's own click does the unlocking.
      data-own-audio-unlock=""
      onClick={onClick}
    >
      <span aria-hidden="true">{soundOn ? "🔔" : "🔕"}</span> {label}
    </button>
  );
}
