import { useEffect, useState } from "react";
import { ADVICE_URL, loadAdviceTable, publicAdviceFor, type AdviceTableJson } from "../lib/publicAdvice";
import styles from "./PublicAdvice.module.css";

/**
 * Collapsed "What the public is told" section for one hazard: the citizen
 * advice (data/hazard_advice.json) that the SOS page shows and the WhatsApp
 * alert sends. Fetched only when opened, once per page (see
 * lib/publicAdvice.ts) - no react-query, so it also works in the alarm
 * pop-up and in cards rendered without a QueryClientProvider.
 * `label` names the hazard for screen readers ("Heavy rain at NODE-04").
 */
export function PublicAdviceSection({
  hazardType, severity, label, className,
}: {
  hazardType: string;
  severity: string;
  label: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [table, setTable] = useState<{ data?: AdviceTableJson; failed?: boolean } | null>(null);
  useEffect(() => {
    if (!open || (table && !table.failed)) return;
    let live = true;
    loadAdviceTable().then(
      (data) => live && setTable({ data }),
      () => live && setTable({ failed: true }),
    );
    return () => {
      live = false;
    };
    // reload only on (re)open
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const advice = publicAdviceFor(table?.data, hazardType, severity);

  return (
    <details className={`${styles.advice} ${className ?? ""}`}
             onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
      <summary className={styles.summary}>
        What the public is told<span className="visually-hidden"> about {label}</span>
      </summary>
      {open && (
        !table ? <p className={styles.note}>Loading advice…</p>
        : table.failed || !advice ? (
          <p className={styles.note} role="status">
            Could not load the advice table. It is <a href={ADVICE_URL} target="_blank" rel="noopener">{ADVICE_URL}</a>.
          </p>
        ) : (
          <div className={styles.body}>
            {!advice.specific && <p className={styles.note}>No advice written for this hazard type yet - generic advice is sent.</p>}
            {advice.whatsapp && (
              <p><strong>WhatsApp alert line:</strong> “{advice.whatsapp}”</p>
            )}
            {advice.actions.length > 0 && (
              <>
                <p className={styles.head}>SOS page - what to do now ({advice.name}):</p>
                <ul className={styles.list}>
                  {advice.actions.map((a) => <li key={a}>{a}</li>)}
                </ul>
              </>
            )}
            <p className={styles.note}>
              Same text for citizens on the SOS page and in WhatsApp alerts (data/hazard_advice.json). Safety-critical:
              to be checked against the district SOPs before a real deployment.
            </p>
          </div>
        )
      )}
    </details>
  );
}
