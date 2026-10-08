import "leaflet/dist/leaflet.css";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  cloneElement, useEffect, useId, useRef, useState, type FormEvent, type InputHTMLAttributes, type ReactElement,
  type ReactNode,
} from "react";
import { CircleMarker, MapContainer, TileLayer, Tooltip, useMap, useMapEvents } from "react-leaflet";
import { ApiError, apiDelete, apiGet, apiPost, apiPut } from "../api/client";
import type { AdminNodesResponse, NodeConfig, NodeHealth, NodeHealthResponse } from "../api/types";
import { AppHeader } from "../components/AppHeader";
import styles from "../components/Admin.module.css";
import {
  curveNumberHint, DEFAULT_REPORT_INTERVAL_SECONDS, emptyNodeForm, formFromNode, LAND_USES, landUseLabel,
  validateNodeForm, type NodeForm, type NodeFormErrors,
} from "../lib/nodes";

const DEFAULT_CENTER: [number, number] = [29.3919, 79.4542];

type Editing = { mode: "new" } | { mode: "edit"; nodeId: string } | null;

export function AdminPage() {
  const queryClient = useQueryClient();
  const nodes = useQuery({
    queryKey: ["admin-nodes"],
    queryFn: () => apiGet<AdminNodesResponse>("/api/admin/nodes"),
    // Retry once only when it may help (network drop, backend restarting) -
    // a 403 or "switched off" (503) answer won't change, so show it at once.
    retry: (count, error) => count < 1 && (!(error instanceof ApiError) || error.status === 502 || error.status === 504),
  });
  const health = useQuery({
    queryKey: ["node-health"],
    queryFn: () => apiGet<NodeHealthResponse>("/api/node-health"),
    refetchInterval: 15_000,
  });
  const [editing, setEditing] = useState<Editing>(null);
  const [notice, setNotice] = useState<ReactNode>(null);

  const remove = useMutation({
    mutationFn: (nodeId: string) => apiDelete<{ status: string }>(`/api/admin/nodes/${encodeURIComponent(nodeId)}`),
    onSuccess: (_data, nodeId) => {
      setNotice(<>Node <strong>{nodeId}</strong> deleted. Its past readings stay in the database.
        Revoke its device key if it had one: <code>node server/device_keys.js list</code></>);
      void queryClient.invalidateQueries({ queryKey: ["admin-nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["node-health"] });
    },
  });

  const registry = nodes.data?.nodes ?? {};
  const ids = Object.keys(registry).sort();
  const healthById = new Map((health.data?.nodes ?? []).map((n) => [n.node_id, n]));

  const onDelete = (nodeId: string) => {
    remove.reset();
    if (window.confirm(`Delete node ${nodeId}? Readings from it will be rejected until it is added again. Its past readings are kept.`)) {
      setNotice(null);
      remove.mutate(nodeId);
    }
  };

  return (
    <>
      <a className="skip-link" href="#main">Skip to main content</a>
      <AppHeader />
      <main id="main" className={styles.main} tabIndex={-1}>
        <nav className={styles.crumbs} aria-label="Pages">
          <a href="/">Dashboard</a> · <a href="/officer.html">Officer map</a>
        </nav>
        <div className={styles.titleRow}>
          <h2>Sensor nodes{nodes.isSuccess ? ` (${ids.length})` : ""}</h2>
          {nodes.isSuccess && editing === null && (
            <button type="button" className={styles.primary} onClick={() => { setNotice(null); setEditing({ mode: "new" }); }}>
              + Add node
            </button>
          )}
        </div>
        <p className={styles.intro}>
          The AI only accepts readings from nodes listed here. Position, land use and the upstream link feed the flood
          model, the hospital routing and the public map, so changes take effect on the next reading.
        </p>

        <div role="status" aria-live="polite" className={notice ? styles.notice : undefined}>{notice}</div>
        {remove.isError && <div role="alert" className={styles.errorBox}>Couldn't delete: {remove.error.message}</div>}
        {nodes.isError && <div role="alert" className={styles.errorBox}>{loadErrorText(nodes.error)}</div>}
        {nodes.isPending && <p>Loading nodes...</p>}

        {editing && nodes.isSuccess && (
          <NodeEditor
            key={editing.mode === "edit" ? editing.nodeId : "new"}
            editing={editing}
            registry={registry}
            onCancel={() => setEditing(null)}
            onSaved={(nodeId, created) => {
              setEditing(null);
              setNotice(created
                ? <>Node <strong>{nodeId}</strong> added. Next, give its device (or the gateway) a key:{" "}
                    <code>node server/device_keys.js add {nodeId.toLowerCase()} --nodes {nodeId}</code></>
                : <>Node <strong>{nodeId}</strong> updated.</>);
            }}
          />
        )}

        {nodes.isSuccess && (
          <NodeTable ids={ids} registry={registry} health={healthById} busy={remove.isPending}
                     onEdit={(nodeId) => { setNotice(null); setEditing({ mode: "edit", nodeId }); }}
                     onDelete={onDelete} />
        )}
      </main>
    </>
  );
}

function loadErrorText(error: Error): string {
  if (error instanceof ApiError && error.status === 403) return "Only admin accounts can manage nodes.";
  return `Couldn't load the node list: ${error.message}`;
}

function statusText(h: NodeHealth | undefined): { text: string; className: string } {
  if (!h) return { text: "-", className: "" };
  if (h.status === "never_seen") return { text: "Never reported", className: styles.statusIdle };
  if (h.status === "offline") return { text: "Offline", className: styles.statusBad };
  return { text: h.level === "ok" ? "Online" : "Online - check", className: h.level === "ok" ? styles.statusOk : styles.statusWarn };
}

function NodeTable({ ids, registry, health, busy, onEdit, onDelete }: {
  ids: string[];
  registry: Record<string, NodeConfig>;
  health: Map<string, NodeHealth>;
  busy: boolean;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  if (!ids.length) return <p className={styles.empty}>No nodes yet - add the first one.</p>;
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <caption className="visually-hidden">Registered sensor nodes</caption>
        <thead>
          <tr>
            <th scope="col">Node ID</th><th scope="col">Location</th><th scope="col">Land use (CN)</th>
            <th scope="col">Position</th><th scope="col">Upstream</th><th scope="col">Reports every</th>
            <th scope="col">Status</th><th scope="col"><span className="visually-hidden">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const n = registry[id];
            const s = statusText(health.get(id));
            return (
              <tr key={id}>
                <th scope="row">{id}</th>
                <td>{n.location}</td>
                <td>{landUseLabel(n.land_use)} ({n.curve_number})</td>
                <td>{n.latitude.toFixed(4)}, {n.longitude.toFixed(4)}</td>
                <td>{n.upstream_node ?? "-"}</td>
                <td>{n.report_interval_seconds == null ? `${DEFAULT_REPORT_INTERVAL_SECONDS} s (default)` : `${n.report_interval_seconds} s`}</td>
                <td className={s.className}>{s.text}</td>
                <td className={styles.actions}>
                  <button type="button" onClick={() => onEdit(id)} aria-label={`Edit ${id}`}>Edit</button>
                  <button type="button" className={styles.danger} onClick={() => onDelete(id)} disabled={busy}
                          aria-label={`Delete ${id}`}>Delete</button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function NodeEditor({ editing, registry, onCancel, onSaved }: {
  editing: NonNullable<Editing>;
  registry: Record<string, NodeConfig>;
  onCancel: () => void;
  onSaved: (nodeId: string, created: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const isNew = editing.mode === "new";
  const [form, setForm] = useState<NodeForm>(() =>
    editing.mode === "edit" ? formFromNode(editing.nodeId, registry[editing.nodeId]) : emptyNodeForm());
  const [errors, setErrors] = useState<NodeFormErrors>({});
  const headingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => headingRef.current?.focus(), []);

  const save = useMutation({
    mutationFn: ({ nodeId, config }: { nodeId: string; config: NodeConfig }) => {
      const path = `/api/admin/nodes/${encodeURIComponent(nodeId)}`;
      return isNew ? apiPost<{ status: string }>(path, config) : apiPut<{ status: string }>(path, config);
    },
    onSuccess: (_data, { nodeId }) => {
      void queryClient.invalidateQueries({ queryKey: ["admin-nodes"] });
      void queryClient.invalidateQueries({ queryKey: ["node-health"] });
      onSaved(nodeId, isNew);
    },
  });

  const set = <K extends keyof NodeForm>(key: K, value: NodeForm[K]) => setForm((f) => ({ ...f, [key]: value }));
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const result = validateNodeForm(form, registry, isNew);
    setErrors(result.errors);
    if (result.config) save.mutate({ nodeId: form.node_id.trim(), config: result.config });
    else document.getElementById(`node-${Object.keys(result.errors)[0]}`)?.focus();
  };

  const nodeId = form.node_id.trim();
  const upstreamOptions = Object.keys(registry).filter((id) => id !== nodeId).sort();
  const lat = Number(form.latitude);
  const lon = Number(form.longitude);
  const hasPosition = form.latitude.trim() !== "" && form.longitude.trim() !== "" && Number.isFinite(lat) && Number.isFinite(lon);
  const cnHint = curveNumberHint(form.land_use, form.curve_number);

  return (
    <form className={styles.editor} onSubmit={onSubmit} noValidate aria-labelledby="node-editor-title">
      <h3 id="node-editor-title" ref={headingRef} tabIndex={-1}>{isNew ? "Add a node" : `Edit ${nodeId}`}</h3>
      <div className={styles.editorGrid}>
        <div className={styles.fields}>
          <Field id="node-node_id" label="Node ID" error={errors.node_id}
                 hint={isNew ? "Must match NODE_ID in the firmware config.h. Up to 12 characters." : "The ID can't be changed - delete and re-add instead."}>
            <input value={form.node_id} onChange={(e) => set("node_id", e.target.value)} disabled={!isNew}
                   autoComplete="off" spellCheck={false} maxLength={12} placeholder="NODE-05" />
          </Field>
          <Field id="node-location" label="Location" error={errors.location}>
            <input value={form.location} onChange={(e) => set("location", e.target.value)} maxLength={100}
                   placeholder="Sector 4, Riverside" />
          </Field>
          <div className={styles.pair}>
            <Field id="node-land_use" label="Land use">
              <select value={form.land_use} onChange={(e) => set("land_use", e.target.value as NodeForm["land_use"])}>
                {LAND_USES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </Field>
            <Field id="node-curve_number" label="Curve number" error={errors.curve_number} hint={cnHint ?? "SCS-CN runoff: 30 (soaks up rain) - 100 (all runs off)."}>
              <input value={form.curve_number} onChange={(e) => set("curve_number", e.target.value)} inputMode="decimal" />
            </Field>
          </div>
          <div className={styles.pair}>
            <Field id="node-latitude" label="Latitude" error={errors.latitude}>
              <input value={form.latitude} onChange={(e) => set("latitude", e.target.value)} inputMode="decimal" placeholder="29.3919" />
            </Field>
            <Field id="node-longitude" label="Longitude" error={errors.longitude}>
              <input value={form.longitude} onChange={(e) => set("longitude", e.target.value)} inputMode="decimal" placeholder="79.4542" />
            </Field>
          </div>
          <Field id="node-upstream_node" label="Upstream node" error={errors.upstream_node}
                 hint="The node upriver of this one: its rise raises this node's flood risk early.">
            <select value={form.upstream_node} onChange={(e) => set("upstream_node", e.target.value)}>
              <option value="">None</option>
              {upstreamOptions.map((id) => <option key={id} value={id}>{id} - {registry[id].location}</option>)}
            </select>
          </Field>
          <Field id="node-report_interval_seconds" label="Reports every (seconds)" error={errors.report_interval_seconds}
                 hint={`Empty = ${DEFAULT_REPORT_INTERVAL_SECONDS} s (always-on node). LoRa heartbeat nodes: 60. Sleeping nodes: their wake interval.`}>
            <input value={form.report_interval_seconds} onChange={(e) => set("report_interval_seconds", e.target.value)}
                   inputMode="decimal" placeholder={String(DEFAULT_REPORT_INTERVAL_SECONDS)} />
          </Field>
        </div>

        <div className={styles.mapBox}>
          <p id="node-map-help" className={styles.hint}>Click the map to set the position. Grey dots are the other nodes.</p>
          <div className={styles.map} role="region" aria-label="Position picker map (the latitude and longitude fields do the same)">
            <MapContainer center={hasPosition ? [lat, lon] : DEFAULT_CENTER} zoom={13} className={styles.map}>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap contributors" />
              {Object.entries(registry).filter(([id]) => id !== nodeId).map(([id, n]) => (
                <CircleMarker key={id} center={[n.latitude, n.longitude]} radius={6}
                              pathOptions={{ color: "#333", weight: 1, fillColor: "#9aa1ab", fillOpacity: 0.9 }}>
                  <Tooltip>{id}</Tooltip>
                </CircleMarker>
              ))}
              {hasPosition && (
                <CircleMarker center={[lat, lon]} radius={9}
                              pathOptions={{ color: "#1b5e20", weight: 3, fillColor: "#43a047", fillOpacity: 0.9 }}>
                  <Tooltip permanent direction="top">{nodeId || "new node"}</Tooltip>
                </CircleMarker>
              )}
              <PickPosition onPick={(la, lo) => setForm((f) => ({ ...f, latitude: la.toFixed(6), longitude: lo.toFixed(6) }))} />
              <FollowPosition position={hasPosition ? [lat, lon] : null} />
            </MapContainer>
          </div>
        </div>
      </div>

      {save.isError && <div role="alert" className={styles.errorBox}>Couldn't save: {save.error.message}</div>}
      <div className={styles.buttons}>
        <button type="submit" className={styles.primary} disabled={save.isPending}>
          {save.isPending ? "Saving..." : isNew ? "Add node" : "Save changes"}
        </button>
        <button type="button" onClick={onCancel} disabled={save.isPending}>Cancel</button>
      </div>
    </form>
  );
}

function Field({ id, label, error, hint, children }: {
  id: string;
  label: string;
  error?: string;
  hint?: string;
  children: ReactElement<InputHTMLAttributes<HTMLElement>>;
}) {
  const hintId = useId();
  const errorId = useId();
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(" ") || undefined;
  const control = cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined });
  return (
    <div className={styles.field}>
      <label htmlFor={id}>{label}</label>
      {control}
      {error && <div id={errorId} className={styles.fieldError}>{error}</div>}
      {hint && <div id={hintId} className={styles.hint}>{hint}</div>}
    </div>
  );
}

function PickPosition({ onPick }: { onPick: (lat: number, lon: number) => void }) {
  useMapEvents({ click: (e) => onPick(e.latlng.lat, e.latlng.lng) });
  return null;
}

/** Pan to a position typed into the fields (clicks are already in view) */
function FollowPosition({ position }: { position: [number, number] | null }) {
  const map = useMap();
  const lat = position?.[0];
  const lon = position?.[1];
  useEffect(() => {
    if (lat === undefined || lon === undefined || Math.abs(lat) > 90 || Math.abs(lon) > 180) return;
    if (!map.getBounds().contains([lat, lon])) map.panTo([lat, lon]);
  }, [map, lat, lon]);
  return null;
}
