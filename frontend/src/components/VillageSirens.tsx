// Officer panel: village sirens on sensor nodes (server/siren.js).
// Shows what each node REPORTS (sounding / silent) next to what the server
// is still asking for, so an officer never mistakes "requested" for "on".
// Hidden while the list can't be loaded (e.g. an older server).
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost } from "../api/client";
import type { Role, SirenActionResponse, SirensResponse, SirenStatus } from "../api/types";
import {
  autoSirenHint, canControlSiren, offersSilence, sirenConfirmText, sirenPendingText, sirenStateText, sirenUntilText,
} from "../lib/villageSiren";
import styles from "./Officer.module.css";

export function VillageSirens({ role }: { role: Role | undefined }) {
  const sirens = useQuery({
    queryKey: ["sirens"],
    queryFn: () => apiGet<SirensResponse>("/api/sirens"),
    refetchInterval: 5000,
  });
  const client = useQueryClient();
  const action = useMutation({
    mutationFn: ({ nodeId, on }: { nodeId: string; on: boolean }) =>
      apiPost<SirenActionResponse>(`/api/nodes/${encodeURIComponent(nodeId)}/siren`, { action: on ? "on" : "off" }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["sirens"] }),
  });
  // Something other than a siren list (an older server, a proxy page): no section
  if (!sirens.data || !Array.isArray(sirens.data.sirens)) return null;
  const list = sirens.data.sirens;
  const allowed = canControlSiren(role);

  const onPress = (s: SirenStatus) => {
    // A real siren wakes a whole village (and silencing one may leave people
    // unwarned): always ask first.
    if (window.confirm(sirenConfirmText(s, sirens.data.default_on_seconds))) {
      action.mutate({ nodeId: s.node_id, on: !offersSilence(s) });
    }
  };

  return (
    <section className={styles.section} aria-labelledby="siren-section-title">
      <h2 id="siren-section-title" className={styles.sectionTitle}>
        Village sirens{list.length > 0 && <span className={styles.titleCount}> ({list.length})</span>}
      </h2>
      <p className={styles.sirenHint}>
        {sirens.data.auto_severity === "off"
          ? "Automatic sounding is switched off - only officers sound the sirens."
          : autoSirenHint(sirens.data.auto_hazards)}
      </p>
      {list.length === 0 && <p className={styles.muted}>No sensor node reports a siren.</p>}
      {list.length > 0 && (
        <ul className={styles.sirenList} aria-label="Village sirens">
          {list.map((s) => {
            const pending = sirenPendingText(s);
            const until = sirenUntilText(s);
            const busy = action.isPending && action.variables?.nodeId === s.node_id;
            const titleId = `siren-${s.node_id}`;
            return (
              <li key={s.node_id} className={`${styles.sirenItem} ${s.sounding ? styles.sirenItemSounding : ""}`}>
                <div className={styles.sirenHead}>
                  <strong id={titleId}>{s.node_id}</strong>
                  <span className={s.sounding ? styles.sirenOn : styles.sirenOff}>{s.sounding ? "Sounding" : "Silent"}</span>
                  {(s.simulated || s.desired_simulated) && <span className={styles.manualBadge}>Simulated</span>}
                  {!s.fitted && <span className={styles.manualBadge}>No siren reported</span>}
                </div>
                <div className={styles.sirenDetail}>{sirenStateText(s)}{until && ` · ${until}`}</div>
                {pending && <div className={styles.sirenPending} role="status">{pending}</div>}
                {allowed && (s.fitted || offersSilence(s)) && (
                  <button type="button"
                          className={`${styles.actionBtn} ${offersSilence(s) ? styles.actionPrimary : styles.sirenSoundBtn}`}
                          onClick={() => onPress(s)} disabled={action.isPending} aria-describedby={titleId}>
                    {busy ? "Sending..." : offersSilence(s) ? "Silence" : "Sound village siren"}
                    <span className="visually-hidden"> at {s.node_id}</span>
                  </button>
                )}
                {action.isError && action.variables?.nodeId === s.node_id && (
                  <div className={styles.errorText} role="alert">{action.error.message}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
