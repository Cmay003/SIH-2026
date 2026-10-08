import { useEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";

const style: CSSProperties = {
  position: "fixed",
  left: "50%",
  top: 16,
  transform: "translateX(-50%)",
  zIndex: 3000,
  background: "#1b1b1b",
  color: "#fff",
  padding: "10px 16px",
  borderRadius: 10,
  boxShadow: "0 6px 20px rgba(0,0,0,.25)",
  maxWidth: "calc(100vw - 32px)",
};

export function Toast({ message, onDone, ms = 6000 }: { message: string; onDone: () => void; ms?: number }) {
  useEffect(() => {
    const t = setTimeout(onDone, ms);
    return () => clearTimeout(t);
  }, [onDone, ms]);
  return createPortal(<div role="status" style={style}>{message}</div>, document.body);
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
