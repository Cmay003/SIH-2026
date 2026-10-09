import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Short message at the top of the page (styles: .app-toast in global.css).
 * Closes itself after `ms`, but the timer waits while the pointer or
 * keyboard focus is on it, and it can be dismissed at once (WCAG 2.2.1).
 */
export function Toast({ message, onDone, ms = 6000 }: { message: string; onDone: () => void; ms?: number }) {
  const [paused, setPaused] = useState(false);
  // Callers often pass a new arrow function each render (the dashboard
  // re-renders on every 2 s poll). Keep the latest one in a ref so a
  // re-render doesn't restart the timer and keep the toast up forever.
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);
  useEffect(() => {
    if (paused) return;
    const t = setTimeout(() => onDoneRef.current(), ms);
    return () => clearTimeout(t);
  }, [ms, paused]);
  return createPortal(
    <div className="app-toast"
         onMouseEnter={() => setPaused(true)} onMouseLeave={() => setPaused(false)}
         onFocus={() => setPaused(true)} onBlur={() => setPaused(false)}>
      <div role="status" className="app-toast-text">{message}</div>
      <button type="button" className="app-toast-close" onClick={onDone}>Dismiss</button>
    </div>,
    document.body,
  );
}

/** server.js sends users without the role back to /?denied=officer (or =admin) */
const DENIED_MESSAGES: Record<string, string> = {
  officer: "Your account can view the dashboard only - the officer page needs an officer account.",
  admin: "Managing sensor nodes needs an admin account.",
};

export function useDeniedToast() {
  const [denied, setDenied] = useState(() => new URLSearchParams(window.location.search).get("denied"));
  const message = denied ? DENIED_MESSAGES[denied] : undefined;
  return message ? <Toast message={message} onDone={() => setDenied(null)} /> : null;
}
