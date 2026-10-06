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

export function AppHeader({ connection, children }: { connection?: ConnectionState; children?: ReactNode }) {
  return (
    <header className={styles.header}>
      <div className={styles.userSlot}>
        <UserChip />
      </div>
      <div className={styles.brand}>
        <Logo />
        <h1>SANJEEVNI</h1>
      </div>
      {connection && (
        <div className={styles.status} role="status" aria-live="polite">
          <span className={`${styles.dot} ${styles[connection]}`} aria-hidden="true" />
          {CONNECTION_TEXT[connection]}
        </div>
      )}
      {children}
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
      <span className={styles.name}>{username}</span>
      <span className={styles.role}>{role}</span>
      <button type="button" onClick={() => logout.mutate()} disabled={logout.isPending}>
        {logout.isPending ? "Signing out..." : "Log out"}
      </button>
    </div>
  );
}
