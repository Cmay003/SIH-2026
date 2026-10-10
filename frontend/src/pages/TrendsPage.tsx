// Trends & reports (officers and admins - server.js checks the role before
// sending this page). Step W2 of the problem-statement work:
//  - per-node risk and sensor trends (24 h / 7 d / 30 d), CSV download
//  - confirmed alerts with CAP XML / PDF report / timeline
//  - event timeline around one alert (what led up to it)
//  - district summary for planners, printable as a report
// Everything here may include SIMULATED readings: the banner says so on
// screen and on paper, with the backend's own data_note.
import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { apiGet } from "../api/client";
import type {
  ConfirmedAlertsResponse, NodeHealthResponse, Role, SummaryRange, SummaryResponse, TimelineResponse, TimelineRow,
  TrendRange, TrendsResponse,
} from "../api/types";
import { AlertActions } from "../components/AlertActions";
import { AppHeader, HeaderNavLink } from "../components/AppHeader";
import { TrendChart } from "../components/TrendChart";
import styles from "../components/Trends.module.css";
import { useMe } from "../hooks/useAuth";
import { hazardIcon, hazardTypeText } from "../lib/hazards";
import { SENSOR_ROWS } from "../lib/sensors";
import {
  ALERTS_COUNT_FALLBACK, CAP_FEED_URL, FORECAST_ALERTS_FALLBACK, SUMMARY_RANGES, TREND_FIELDS, TREND_RANGES,
  UPTIME_NOTE,
  TREND_REFERENCE, bucketSizeText, bySeverityThenCount, downloadText, exceedanceBasis, exceedanceLabel, fieldPoints, fmtNum, hasData, isSummaryRange, isTrendRange, riskPoints, summaryCsv,
  bannerNotes, nodeHoursText, summaryFindings, summaryNodeIds, trendFieldRow, trendsCsv, type BannerNote, type ChartPoint,
} from "../lib/trends";

/** Shown even when the backend sends no data_note: nothing here is field data yet. */
const DEMO_NOTE =
  "SANJEEVNI has not been field-deployed. The demo database holds simulator readings, so every chart, count and " +
  "report on this page describes SIMULATED / SYNTHETIC data - use it to judge the method, not a real district.";
const TIMELINE_WINDOW = 40;

function readParams() {
  const q = new URLSearchParams(window.location.search);
  const around = Number(q.get("around"));
  return {
    node: q.get("node"),
    range: isTrendRange(q.get("range")) ? (q.get("range") as TrendRange) : "24h",
    summary: isSummaryRange(q.get("summary")) ? (q.get("summary") as SummaryRange) : "7d",
    around: Number.isInteger(around) && around > 0 ? around : null,
  };
}

export function TrendsPage() {
  const initial = useMemo(readParams, []);
  const [nodeId, setNodeId] = useState<string | null>(initial.node);
  const [range, setRange] = useState<TrendRange>(initial.range);
  const [summaryRange, setSummaryRange] = useState<SummaryRange>(initial.summary);
  const [around, setAround] = useState<number | null>(initial.around);
  const [timelineOpen, setTimelineOpen] = useState(initial.around !== null || window.location.hash === "#timeline");
  const role = useMe().data?.user.role;

  const nodes = useQuery({
    queryKey: ["node-health"],
    queryFn: () => apiGet<NodeHealthResponse>("/api/node-health"),
    staleTime: 60_000,
  });
  const nodeList = useMemo(
    () => [...(nodes.data?.nodes ?? [])].sort((a, b) => a.node_id.localeCompare(b.node_id)),
    [nodes.data],
  );
  // No node in the link: the first one in the registry
  useEffect(() => {
    if (nodeId === null && nodeList.length) setNodeId(nodeList[0].node_id);
  }, [nodeId, nodeList]);

  // Keep the address shareable (and the Back button sane) without reloading
  useEffect(() => {
    const q = new URLSearchParams();
    if (nodeId) q.set("node", nodeId);
    q.set("range", range);
    q.set("summary", summaryRange);
    if (around !== null) q.set("around", String(around));
    window.history.replaceState(null, "", `${window.location.pathname}?${q}${window.location.hash}`);
  }, [nodeId, range, summaryRange, around]);

  const trends = useQuery({
    queryKey: ["trends", nodeId, range],
    queryFn: () => apiGet<TrendsResponse>(`/api/officer/trends?node_id=${encodeURIComponent(nodeId!)}&range=${range}`),
    enabled: nodeId !== null,
    refetchInterval: 60_000,
  });
  const alerts = useQuery({
    queryKey: ["confirmed-alerts", nodeId, range],
    queryFn: () => apiGet<ConfirmedAlertsResponse>(
      `/api/officer/alerts?node_id=${encodeURIComponent(nodeId!)}&range=${range}&limit=50`),
    enabled: nodeId !== null,
    refetchInterval: 60_000,
  });
  const summary = useQuery({
    queryKey: ["summary", summaryRange],
    queryFn: () => apiGet<SummaryResponse>(`/api/officer/summary?range=${summaryRange}`),
    refetchInterval: 5 * 60_000,
  });

  const showTimeline = useCallback((alertId: number | null) => {
    setAround(alertId);
    setTimelineOpen(true);
    window.setTimeout(() => {
      const el = document.getElementById("timeline-heading");
      el?.scrollIntoView?.({ block: "start" });
      el?.focus({ preventScroll: true });
    }, 50);
  }, []);
  // Arrived from a map / dashboard "Timeline" link: focus that section once loaded
  useEffect(() => {
    if (initial.around === null && window.location.hash !== "#timeline") return;
    const t = window.setTimeout(() => document.getElementById("timeline-heading")?.focus(), 300);
    return () => window.clearTimeout(t);
  }, [initial.around]);

  // Each data note says how many readings in ITS range are simulated, so the
  // banner names the section it belongs to (two near-identical paragraphs with
  // different counts and no label read as a contradiction - W2 browser check).
  const notes = bannerNotes(trends.data?.data_note, summary.data?.data_note);
  const nodeLocation = nodeList.find((n) => n.node_id === nodeId)?.location;

  return (
    <>
      <a className={`skip-link ${styles.noPrint}`} href="#main">Skip to main content</a>
      <div className={styles.noPrint}>
        <AppHeader>
          <nav className={styles.headerNav} aria-label="Pages">
            <HeaderNavLink href="/">Dashboard</HeaderNavLink>
            <HeaderNavLink href="/officer.html">Officer map</HeaderNavLink>
          </nav>
        </AppHeader>
      </div>
      <main id="main" className={styles.main} tabIndex={-1}>
        <div className={styles.titleRow}>
          <h1 className={styles.pageTitle}>Risk trends &amp; reports</h1>
          <nav className={`${styles.jump} ${styles.noPrint}`} aria-label="On this page">
            <a href="#node-trends">Node trends</a>
            <a href="#alerts">Confirmed alerts</a>
            <a href="#timeline">Timeline</a>
            <a href="#district-report">District summary</a>
          </nav>
        </div>

        <DataBanner notes={notes} />

        <section id="node-trends" className={`${styles.section} ${styles.noPrint}`} aria-labelledby="trends-heading">
          <div className={styles.sectionHead}>
            <h2 id="trends-heading">Node trends</h2>
            {trends.data && (
              <button type="button" className={styles.btn}
                      onClick={() => downloadText(`sanjeevni_trends_${trends.data.node_id}_${trends.data.range}.csv`,
                                                  trendsCsv(trends.data))}>
                Download CSV<span className="visually-hidden"> of the trends shown</span>
              </button>
            )}
          </div>
          <div className={styles.controls}>
            <label className={styles.field}>
              <span>Node</span>
              <select name="trend-node" value={nodeId ?? ""} onChange={(e) => { setNodeId(e.target.value); setAround(null); }}
                      disabled={!nodeList.length}>
                {!nodeList.length && <option value="">{nodes.isPending ? "Loading nodes..." : "No nodes"}</option>}
                {nodeId && !nodeList.some((n) => n.node_id === nodeId) && <option value={nodeId}>{nodeId}</option>}
                {nodeList.map((n) => (
                  <option key={n.node_id} value={n.node_id}>{n.node_id} - {n.location}</option>
                ))}
              </select>
            </label>
            <RangePicker name="trend-range" legend="Period" options={TREND_RANGES} value={range} onChange={setRange} />
          </div>
          {nodes.isError && <p className={styles.error} role="alert">Can't load the node list: {nodes.error.message}</p>}
          <TrendCharts data={trends.data} isPending={trends.isPending && nodeId !== null} error={trends.error}
                       nodeLabel={nodeId ? `${nodeId}${nodeLocation ? ` (${nodeLocation})` : ""}` : null} />
        </section>

        <section id="alerts" className={`${styles.section} ${styles.noPrint}`} aria-labelledby="alerts-heading">
          <h2 id="alerts-heading">Confirmed alerts{nodeId ? ` - ${nodeId}` : ""}</h2>
          <p className={styles.muted}>
            Alerts the system dispatched in the selected period, newest first. CAP XML is the Common Alerting
            Protocol 1.2 message for that alert (simulated alerts are marked “Exercise”); the PDF report is the
            situation report with the readings that led up to it.
          </p>
          <AlertsTable data={alerts.data} isPending={alerts.isPending && nodeId !== null} error={alerts.error}
                       role={role} onTimeline={showTimeline} activeId={timelineOpen ? around : null} />
        </section>

        <section id="timeline" className={`${styles.section} ${styles.noPrint}`} aria-labelledby="timeline-heading">
          <h2 id="timeline-heading" tabIndex={-1}>Event timeline{nodeId ? ` - ${nodeId}` : ""}</h2>
          {!timelineOpen ? (
            <>
              <p className={styles.muted}>Use “Timeline” on an alert to replay the readings around it.</p>
              <button type="button" className={styles.btn} onClick={() => showTimeline(null)} disabled={!nodeId}>
                Show the latest {TIMELINE_WINDOW} readings
              </button>
            </>
          ) : nodeId ? (
            <Timeline nodeId={nodeId} around={around} onLatest={() => setAround(null)} />
          ) : null}
        </section>

        <DistrictReport range={summaryRange} onRange={setSummaryRange} data={summary.data}
                        isPending={summary.isPending} error={summary.error} note={summary.data?.data_note ?? null} />

        <footer className={`${styles.footer} ${styles.noPrint}`}>
          <a href={CAP_FEED_URL}>Public CAP 1.2 alert feed (Atom)</a> - confirmed alerts only, for emergency-management
          dashboards and feed readers.
        </footer>
      </main>
    </>
  );
}

function DataBanner({ notes }: { notes: BannerNote[] }) {
  return (
    // on paper the report repeats this warning itself (printOnly), right under its title
    <div className={`${styles.banner} ${styles.noPrint}`} role="note" aria-labelledby="data-banner-title">
      <p id="data-banner-title" className={styles.bannerTitle}>
        <span aria-hidden="true">⚠ </span>SIMULATED / SYNTHETIC DATA
      </p>
      <p className={styles.bannerText}>{DEMO_NOTE}</p>
      {notes.map((n) => (
        <p key={n.label} className={styles.bannerText}><strong>{n.label}:</strong> {n.text}</p>
      ))}
    </div>
  );
}

function RangePicker<T extends string>({ name, legend, options, value, onChange }: {
  name: string;
  legend: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <fieldset className={styles.radios}>
      <legend>{legend}</legend>
      {options.map((o) => (
        <label key={o.value} className={styles.radio}>
          <input type="radio" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
          {o.label}
        </label>
      ))}
    </fieldset>
  );
}

function TrendCharts({ data, isPending, error, nodeLabel }: {
  data: TrendsResponse | undefined;
  isPending: boolean;
  error: Error | null;
  nodeLabel: string | null;
}) {
  const charts = useMemo(() => {
    if (!data) return null;
    const series = Array.isArray(data.series) ? data.series : [];
    const risk = riskPoints(series);
    const fields = TREND_FIELDS.map((f) => ({ field: f, points: fieldPoints(series, f) }));
    return {
      series,
      risk,
      withData: fields.filter((f) => hasData(f.points)),
      without: fields.filter((f) => !hasData(f.points)).map((f) => trendFieldRow(f.field).label),
    };
  }, [data]);

  if (error && !data) return <p className={styles.error} role="alert">Can't load trends: {error.message}</p>;
  if (isPending) return <p className={styles.muted} role="status">Loading trends...</p>;
  if (!data || !charts) return null;
  const bucket = bucketSizeText(data.bucket_s);
  return (
    <>
      {error && <p className={styles.error} role="alert">Refresh failed ({error.message}) - showing the last loaded trends.</p>}
      <p className={styles.muted}>
        {nodeLabel}: {charts.series.length} time buckets{bucket ? ` of ${bucket}` : ""}. Generated{" "}
        <time dateTime={data.generated_at}>{new Date(data.generated_at).toLocaleString()}</time>. Point at a chart to
        read a bucket; each chart has a data table.
      </p>
      {!hasData(charts.risk) && charts.withData.length === 0 ? (
        <p className={styles.empty}>No readings from this node in the selected period.</p>
      ) : (
        <div className={styles.chartGrid}>
          <TrendChart title="Risk score (highest per bucket)" unit="" digits={2} points={charts.risk} bucketS={data.bucket_s}
                      kind="line" domain={[0, 1]} valueName="max risk"
                      extra={(i) => (charts.series[i]?.severity_max ? `highest severity ${charts.series[i].severity_max}` : null)} />
          {charts.withData.map(({ field, points }) => {
            const row = trendFieldRow(field);
            return (
              <TrendChart key={field} title={row.label} unit={row.unit} digits={row.digits} points={points}
                          bucketS={data.bucket_s} kind="band" reference={TREND_REFERENCE[field]} />
            );
          })}
        </div>
      )}
      {charts.without.length > 0 && (
        <p className={styles.muted}>No readings in this period for: {charts.without.join(", ")}.</p>
      )}
    </>
  );
}

const fmtTime = (iso: string | null | undefined) => {
  const t = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(t) ? new Date(t).toLocaleString() : iso || "–";
};

function AlertsTable({ data, isPending, error, role, onTimeline, activeId }: {
  data: ConfirmedAlertsResponse | undefined;
  isPending: boolean;
  error: Error | null;
  role: Role | undefined;
  onTimeline: (id: number) => void;
  activeId: number | null;
}) {
  if (error && !data) return <p className={styles.error} role="alert">Can't load alerts: {error.message}</p>;
  if (isPending) return <p className={styles.muted} role="status">Loading alerts...</p>;
  if (!data) return null;
  if (data.alerts.length === 0) return <p className={styles.empty}>No confirmed alerts in this period.</p>;
  return (
    <ul className={styles.alertList}>
      {data.alerts.map((a) => {
        const what = `${a.hazard_type ? hazardTypeText(a.hazard_type) : "hazard"} ${a.severity ?? ""} at ${a.node_id}`;
        return (
          <li key={a.id} className={`${styles.alertItem} ${a.id === activeId ? styles.alertActive : ""}`}
              aria-current={a.id === activeId ? "true" : undefined}>
            <div className={styles.alertHead}>
              <span aria-hidden="true">{hazardIcon(a.hazard_type)}</span>
              <strong>#{a.id} · {a.hazard_type ? hazardTypeText(a.hazard_type) : "hazard"}</strong>
              {a.severity && <span className={`${styles.sev} ${styles[`sev_${a.severity}`] ?? ""}`}>{a.severity}</span>}
              {a.simulated && <span className={styles.simTag}>Simulated</span>}
            </div>
            <div className={styles.alertMeta}>
              <time dateTime={a.timestamp}>{fmtTime(a.timestamp)}</time> · {a.location} · risk {fmtNum(a.risk_score, 2)}
            </div>
            <AlertActions alertId={a.id} nodeId={a.node_id} role={role} label={what} onTimeline={() => onTimeline(a.id)} />
          </li>
        );
      })}
    </ul>
  );
}

const STATUS_TEXT: Record<string, string> = {
  alert_dispatched: "Confirmed alert",
  pending_confirmation: "Awaiting confirmation",
  logged: "Logged",
  suppressed: "Suppressed (filtered)",
  untimed: "Backlog (time unknown)",
};
const statusText = (s: string | null) => (s && Object.hasOwn(STATUS_TEXT, s) ? STATUS_TEXT[s] : s ?? "–");
const TIMELINE_COLUMNS = ["river_level_m", "pm25_ugm3", "temp_c", "gas_ppm"] as const;

function Timeline({ nodeId, around, onLatest }: { nodeId: string; around: number | null; onLatest: () => void }) {
  const q = useQuery({
    queryKey: ["timeline", nodeId, around],
    queryFn: () => apiGet<TimelineResponse>(
      `/api/officer/timeline/${encodeURIComponent(nodeId)}?window=${TIMELINE_WINDOW}${around !== null ? `&around_id=${around}` : ""}`),
  });
  const rows: TimelineRow[] = useMemo(() => (Array.isArray(q.data?.timeline) ? q.data.timeline : []), [q.data]);
  const points: ChartPoint[] = useMemo(() => rows.flatMap((r) => {
    const t = r.timestamp ? Date.parse(r.timestamp) : NaN;
    return Number.isFinite(t)
      ? [{ t, lo: null, hi: null, mid: typeof r.risk_score === "number" && Number.isFinite(r.risk_score) ? r.risk_score : null }]
      : [];
  }).sort((a, b) => a.t - b.t), [rows]);
  const markIndex = useMemo(() => {
    const row = rows.find((r) => r.id === around);
    const t = row?.timestamp ? Date.parse(row.timestamp) : NaN;
    const i = points.findIndex((p) => p.t === t);
    return i >= 0 ? i : null;
  }, [rows, points, around]);

  const heading = around !== null ? `Readings around alert #${around}` : `Latest ${TIMELINE_WINDOW} readings`;
  if (q.isError) return <p className={styles.error} role="alert">Can't load the timeline: {q.error.message}</p>;
  if (q.isPending) return <p className={styles.muted} role="status">Loading timeline...</p>;
  return (
    <>
      <div className={styles.sectionHead}>
        <h3 className={styles.subTitle}>{heading}</h3>
        {around !== null && <button type="button" className={styles.btn} onClick={onLatest}>Show latest readings instead</button>}
      </div>
      {rows.length === 0 ? <p className={styles.empty}>No readings stored for this node.</p> : (
        <>
          {points.length > 0 && (
            <TrendChart title="Risk score per reading" unit="" digits={2} points={points} bucketS={60} kind="line"
                        domain={[0, 1]} valueName="risk" markIndex={markIndex} />
          )}
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <caption className="visually-hidden">{heading} at {nodeId}, oldest first</caption>
              <thead>
                <tr>
                  <th scope="col">Time</th><th scope="col">Status</th><th scope="col">Hazard</th>
                  <th scope="col">Severity</th><th scope="col">Risk</th>
                  {TIMELINE_COLUMNS.map((f) => {
                    const row = SENSOR_ROWS.find((r) => r.field === f)!;
                    return <th key={f} scope="col">{row.label}{row.unit ? ` (${row.unit})` : ""}</th>;
                  })}
                  <th scope="col">Source</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className={r.id === around ? styles.rowActive : undefined}
                      aria-current={r.id === around ? "true" : undefined}>
                    <th scope="row">{fmtTime(r.timestamp)}{r.id === around && <strong> (this alert)</strong>}</th>
                    <td>{statusText(r.status)}</td>
                    <td>{r.hazard_type ? hazardTypeText(r.hazard_type) : "–"}</td>
                    <td>{r.severity ?? "–"}</td>
                    <td>{fmtNum(r.risk_score, 2)}</td>
                    {TIMELINE_COLUMNS.map((f) => {
                      const row = SENSOR_ROWS.find((x) => x.field === f)!;
                      return <td key={f}>{fmtNum(r[f] as number | null | undefined, row.digits)}</td>;
                    })}
                    <td>{r.simulated ? "Simulated" : "Device"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

function DistrictReport({ range, onRange, data, isPending, error, note }: {
  range: SummaryRange;
  onRange: (r: SummaryRange) => void;
  data: SummaryResponse | undefined;
  isPending: boolean;
  error: Error | null;
  /** the summary's own data note - the printed report carries only that one */
  note: string | null;
}) {
  const titleId = useId();
  const rangeText = SUMMARY_RANGES.find((r) => r.value === range)!.label;
  const hazards = useMemo(() => Object.entries(data?.alerts_by_hazard ?? {}).sort(bySeverityThenCount), [data]);
  const nodeRows = useMemo(() => {
    const byNode = data?.alerts_by_node ?? {};
    const uptime = data?.node_uptime_pct ?? {};
    const ids = data ? summaryNodeIds(data) : [];
    return ids.map((id) => ({ id, count: byNode[id]?.count ?? 0, max_severity: byNode[id]?.max_severity ?? null, uptime: uptime[id] }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id));
  }, [data]);
  const forecastHazards = useMemo(
    () => Object.entries(data?.forecast_alerts?.by_hazard ?? {}).sort(bySeverityThenCount), [data]);
  const exceed = Object.entries(data?.exceedance_hours ?? {});
  const findings = data ? summaryFindings(data, rangeText) : [];

  return (
    <section id="district-report" className={`${styles.section} ${styles.report}`} aria-labelledby={titleId}>
      <div className={styles.sectionHead}>
        <h2 id={titleId}>District summary report</h2>
        <div className={`${styles.actionsRow} ${styles.noPrint}`}>
          {data && (
            <button type="button" className={styles.btn}
                    onClick={() => downloadText(`sanjeevni_district_summary_${data.range}.csv`, summaryCsv(data))}>
              Download CSV<span className="visually-hidden"> of the district summary</span>
            </button>
          )}
          <button type="button" className={`${styles.btn} ${styles.btnPrimary}`} onClick={() => window.print()} disabled={!data}>
            Print / save as PDF
          </button>
        </div>
      </div>
      <div className={styles.noPrint}>
        <RangePicker name="summary-range" legend="Period" options={SUMMARY_RANGES} value={range} onChange={onRange} />
      </div>
      {/* the printed page carries the same warning as the screen */}
      <div className={styles.printOnly}>
        <p className={styles.printTitle}>SANJEEVNI - district summary report ({rangeText.toLowerCase()})</p>
        <p><strong>SIMULATED / SYNTHETIC DATA.</strong> {DEMO_NOTE}</p>
        {note && <p>{note}</p>}
      </div>

      {error && !data && <p className={styles.error} role="alert">Can't load the district summary: {error.message}</p>}
      {isPending && <p className={styles.muted} role="status">Loading district summary...</p>}
      {data && (
        <>
          <p className={styles.muted}>
            {rangeText}. Generated <time dateTime={data.generated_at}>{new Date(data.generated_at).toLocaleString()}</time>.
          </p>
          <h3 className={styles.subTitle}>Key findings</h3>
          <ul className={styles.findings}>
            {findings.map((f) => <li key={f}>{f}</li>)}
          </ul>

          <div className={styles.reportGrid}>
            <div>
              <h3 className={styles.subTitle}>Alerts by hazard (node sensors)</h3>
              {hazards.length === 0 ? <p className={styles.empty}>No alerts from the nodes' own sensors.</p> : (
                <table className={styles.dataTable}>
                  <thead><tr><th scope="col">Hazard</th><th scope="col">Alert readings</th><th scope="col">Confirmed</th><th scope="col">Highest severity</th></tr></thead>
                  <tbody>
                    {hazards.map(([type, v]) => (
                      <tr key={type}>
                        <th scope="row"><span aria-hidden="true">{hazardIcon(type)} </span>{hazardTypeText(type)}</th>
                        <td>{v.count}</td><td>{v.confirmed}</td><td>{v.max_severity ?? "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p className={styles.muted}>Counted: {data.alerts_count_basis || ALERTS_COUNT_FALLBACK}.</p>
              {data.forecast_alerts && (
                <>
                  <h3 className={styles.subTitle}>Forecast-based alerts (area-wide, from the weather forecast)</h3>
                  {forecastHazards.length === 0 ? <p className={styles.empty}>No forecast-based alerts.</p> : (
                    <table className={styles.dataTable}>
                      <thead><tr><th scope="col">Hazard</th><th scope="col">Alert readings</th><th scope="col">Confirmed</th><th scope="col">Highest severity</th></tr></thead>
                      <tbody>
                        {forecastHazards.map(([type, v]) => (
                          <tr key={type}>
                            <th scope="row"><span aria-hidden="true">{hazardIcon(type)} </span>{hazardTypeText(type)}</th>
                            <td>{v.count}</td><td>{v.confirmed}</td><td>{v.max_severity ?? "–"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  <p className={styles.muted}>
                    {data.forecast_alerts.count > 0 && <>Raised at {data.forecast_alerts.nodes} node(s). </>}
                    Counted: {data.forecast_alerts.basis || FORECAST_ALERTS_FALLBACK}.
                  </p>
                </>
              )}
            </div>
            <div>
              <h3 className={styles.subTitle}>Alerts and uptime by node</h3>
              {nodeRows.length === 0 ? <p className={styles.empty}>No node data.</p> : (
                <table className={styles.dataTable}>
                  <thead><tr><th scope="col">Node</th><th scope="col">Alert readings</th><th scope="col">Highest severity</th><th scope="col">Uptime</th></tr></thead>
                  <tbody>
                    {nodeRows.map((n) => (
                      <tr key={n.id}>
                        <th scope="row" className={styles.nodeId}>{n.id}</th><td>{n.count}</td><td>{n.max_severity ?? "–"}</td>
                        <td>{typeof n.uptime === "number" ? `${n.uptime.toFixed(1)} %` : "–"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {nodeRows.length > 0 && <p className={styles.muted}>{UPTIME_NOTE}</p>}
            </div>
            <div>
              <h3 className={styles.subTitle}>Node-hours above a threshold</h3>
              {exceed.length === 0 ? <p className={styles.empty}>None reported.</p> : (
                <table className={styles.dataTable}>
                  <thead><tr><th scope="col">Condition</th><th scope="col">Node-hours</th></tr></thead>
                  <tbody>
                    {exceed.map(([k, h]) => {
                      const basis = exceedanceBasis(data, k);
                      return (
                        <tr key={k}>
                          <th scope="row">{exceedanceLabel(k)}{basis && <span className={styles.cellNote}>{basis}</span>}</th>
                          <td>{fmtNum(h, 1)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <p className={styles.muted}>
                Values are {nodeHoursText(nodeRows.length, data.range)}{" "}
                {data.exceedance_note || "Counted from node readings by the AI backend. CPCB defines NAQI bands on " +
                  "24-hour averages, so these figures are indicative, not an official exceedance count."}
              </p>
            </div>
            <div>
              <h3 className={styles.subTitle}>Top hotspots</h3>
              {(data.top_hotspots ?? []).length === 0 ? <p className={styles.empty}>No hotspots.</p> : (
                <ol className={styles.hotspots}>
                  {data.top_hotspots.map((h) => (
                    <li key={h.node_id}>
                      <strong>{h.location}</strong> ({h.node_id}) - score {fmtNum(h.score, 2)}
                      {h.dominant_hazard && <>, mostly {hazardTypeText(h.dominant_hazard)}</>}
                    </li>
                  ))}
                </ol>
              )}
              {data.hotspot_basis && <p className={styles.muted}>Score: {data.hotspot_basis}.</p>}
              {data.uptime_basis && <p className={styles.muted}>Uptime (node table): {data.uptime_basis}.</p>}
            </div>
          </div>
          <p className={`${styles.muted} ${styles.printOnly}`}>
            CAP 1.2 feed of confirmed alerts: {window.location.origin}{CAP_FEED_URL}
          </p>
        </>
      )}
    </section>
  );
}
