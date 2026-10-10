import type { ReactNode } from "react";
import { useLogout, useMe } from "../hooks/useAuth";
import styles from "./AppHeader.module.css";
import { Logo } from "./Logo";

export type ConnectionState = "connecting" | "connected" | "disconnected";

const CONNECTION_TEXT: Record<ConnectionState, string> = {
  connecting: "Connecting to backend...",
  connected: "Backend connected",
  disconnected: "Backend not connected",
};

/**
 * Green page header for the staff pages.
 * Layout (wraps by width): brand | connection status | extra controls + user chip.
 * `children` go in the controls slot on the right (e.g. the alarm sound toggle).
 */
export function AppHeader({ connection, children }: { connection?: ConnectionState; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <div className={styles.inner}>
        <div className={styles.brand}>
          <Logo size={40} decorative className={styles.logo} />
          <div className={styles.brandText}>
            <h1>SANJEEVNI</h1>
            <p className={styles.tagline}>Disaster monitoring &amp; response</p>
          </div>
        </div>
        {connection && (
          <div className={`${styles.status} ${connection === "disconnected" ? styles.statusDown : ""}`}
               role="status" aria-live="polite">
            <span className={`${styles.dot} ${styles[connection]}`} aria-hidden="true" />
            {CONNECTION_TEXT[connection]}
          </div>
        )}
        <div className={styles.controls}>
          {children}
          <UserChip />
        </div>
      </div>
    </header>
  );
}

export function UserChip({ variant = "onBrand" }: { variant?: "onBrand" | "light" }) {
  const me = useMe();
  const logout = useLogout();
  if (!me.data) return null;
  const { username, role } = me.data.user;
  return (
    <div className={`${styles.chip} ${variant === "light" ? styles.chipLight : ""}`}>
      <span className={styles.who}>
        <span className={styles.name}>{username}</span>
        <span className={styles.role}>{role}</span>
      </span>
      {(role === "officer" || role === "admin") && window.location.pathname !== "/trends.html" && (
        <a className={styles.adminLink} href="/trends.html">Trends &amp; reports</a>
      )}
      {role === "admin" && window.location.pathname !== "/admin.html" && (
        <a className={styles.adminLink} href="/admin.html">Manage nodes</a>
      )}
      <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {logout.isPending ? "Signing out..." : "Log out"}
      </button>
    </div>
  );
}

/** A plain page link styled for the green header (e.g. the trends page's "Officer map"). */
export function HeaderNavLink({ href, children }: { href: string; children: ReactNode }) {
  return <a className={styles.adminLink} href={href}>{children}</a>;
}
