import { useState } from "react";
import type { Role } from "../api/types";
import { alertLinks, downloadFromServer } from "../lib/alertLinks";
import styles from "./AlertActions.module.css";

/** Named tab for timeline links from the map / dashboard, re-used on every click (like the officer-map tab). */
export const TRENDS_TAB = "sanjeevni-trends";

/**
 * "CAP XML", "PDF report" and "Timeline" for one CONFIRMED alert.
 * - CAP XML opens in a new tab: the officer proxy for staff, the public
 *   confirmed-only /cap/alerts/<id>.xml for everyone else.
 * - PDF report (staff only) is fetched first, so a stopped AI backend shows
 *   its message here instead of saving an error page as a .pdf.
 * - Timeline (staff only) opens the trends page at that alert, or calls
 *   `onTimeline` when the caller is the trends page itself.
 * `label` names the alert for screen readers ("Flood at NODE-01").
 */
export function AlertActions({
  alertId, nodeId, role, label, compact = false, onTimeline,
}: {
  alertId: number;
  nodeId: string;
  role: Role | undefined;
  label: string;
  compact?: boolean;
  onTimeline?: () => void;
}) {
  const links = alertLinks(alertId, nodeId, role);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const downloadPdf = async () => {
    if (!links.pdf) return;
    setBusy(true);
    setError(null);
    try {
      await downloadFromServer(links.pdf, links.pdfName);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Download failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`${styles.actions} ${compact ? styles.compact : ""}`} role="group"
         aria-label={`Reports for alert #${alertId}: ${label}`}>
      <a className={styles.btn} href={links.cap} target="_blank" rel="noopener noreferrer">
        CAP XML<span className="visually-hidden"> for alert #{alertId} (opens in a new tab)</span>
      </a>
      {links.pdf && (
        <button type="button" className={styles.btn} onClick={downloadPdf} disabled={busy} aria-busy={busy}>
          {busy ? "Preparing PDF..." : "PDF report"}
          <span className="visually-hidden"> for alert #{alertId}</span>
        </button>
      )}
      {links.timeline && (onTimeline ? (
        <button type="button" className={styles.btn} onClick={onTimeline}>
          Timeline<span className="visually-hidden"> around alert #{alertId}</span>
        </button>
      ) : (
        // named tab, no noopener: a second click re-uses the same trends tab (same origin)
        <a className={styles.btn} href={links.timeline} target={TRENDS_TAB}>
          Timeline<span className="visually-hidden"> around alert #{alertId} (opens the trends page)</span>
        </a>
      ))}
      {error && <p className={styles.error} role="alert">PDF report: {error}</p>}
    </div>
  );
}
