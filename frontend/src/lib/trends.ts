// Trends & reports page (step W2): chart geometry, CSV export, the
// district summary's plain-language findings and the CAP / PDF / timeline
// links of one confirmed alert. Pure functions, so they are unit-tested
// without a browser.
import type {
  FieldStats, SummaryRange, SummaryResponse, TrendField, TrendPoint, TrendRange, TrendsResponse,
} from "../api/types";
import { hazardTypeText } from "./hazards";
import { SEVERITY_RANK } from "./severity";
import { SENSOR_ROWS, type SensorRowDef } from "./sensors";

export { CAP_FEED_URL, alertLinks, isOfficerRole } from "./alertLinks";

export const TREND_RANGES: readonly { value: TrendRange; label: string }[] = [
  { value: "24h", label: "Last 24 hours" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
export const SUMMARY_RANGES: readonly { value: SummaryRange; label: string }[] = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
];
export const isTrendRange = (v: unknown): v is TrendRange => v === "24h" || v === "7d" || v === "30d";
export const isSummaryRange = (v: unknown): v is SummaryRange => v === "7d" || v === "30d";

/** The sensors the backend aggregates per bucket, in chart order (contract). */
export const TREND_FIELDS: readonly TrendField[] = [
  "river_level_m", "pm25_ugm3", "pm10_ugm3", "gas_ppm", "temp_c", "humidity_pct", "soil_moisture_pct", "tilt_angle_deg",
];

export const trendFieldRow = (field: TrendField): SensorRowDef => SENSOR_ROWS.find((r) => r.field === field)!;

/**
 * Dashed reference lines: where CPCB NAQI "Poor" begins (PM2.5 above 90,
 * PM10 above 250 ug/m3 - "About National Air Quality Index", CPCB,
 * https://cpcb.gov.in/displaypdf.php?id=bmF0aW9uYWwtYWlyLXF1YWxpdHktaW5kZXgvQWJvdXRfQVFJLnBkZg==,
 * read 2026-10-09; same table as lib/sensors.ts). CPCB bands are 24-hour
 * averages; the chart shows readings, so the line is a guide only.
 */
export const TREND_REFERENCE: Partial<Record<TrendField, { value: number; label: string }>> = {
  pm25_ugm3: { value: 90, label: "CPCB NAQI “Poor” starts above 90 µg/m³ (a 24-hour-average band - readings here are not 24-h averages)" },
  pm10_ugm3: { value: 250, label: "CPCB NAQI “Poor” starts above 250 µg/m³ (a 24-hour-average band - readings here are not 24-h averages)" },
};

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** One bucket as the chart draws it: lo..hi band and a mid line; null = no data. */
export interface ChartPoint {
  t: number;
  lo: number | null;
  hi: number | null;
  mid: number | null;
}

export function fieldPoints(series: TrendPoint[], field: TrendField): ChartPoint[] {
  return series.flatMap((p) => {
    const t = Date.parse(p.t);
    if (!Number.isFinite(t)) return [];
    const s = p[field] as FieldStats | null | undefined;
    return [{
      t,
      lo: finite(s?.min) ? s!.min : null,
      hi: finite(s?.max) ? s!.max : null,
      mid: finite(s?.mean) ? s!.mean : null,
    }];
  });
}

export function riskPoints(series: TrendPoint[]): ChartPoint[] {
  return series.flatMap((p) => {
    const t = Date.parse(p.t);
    return Number.isFinite(t) ? [{ t, lo: null, hi: null, mid: finite(p.risk_score_max) ? p.risk_score_max : null }] : [];
  });
}

export const hasData = (points: ChartPoint[]) => points.some((p) => p.lo !== null || p.hi !== null || p.mid !== null);

/** Value range to draw; padded 8 %, a flat series gets +-1 (or +-10 % of its size). */
export function valueDomain(points: ChartPoint[], fixed?: [number, number], extra: number[] = []): [number, number] {
  if (fixed) return fixed;
  const values = points.flatMap((p) => [p.lo, p.hi, p.mid]).filter(finite).concat(extra.filter(finite));
  if (values.length === 0) return [0, 1];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    const pad = lo === 0 ? 1 : Math.abs(lo) * 0.1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.08;
  lo -= pad;
  hi += pad;
  return [lo, hi];
}

/**
 * Runs of consecutive points that have `key` - a gap (bucket without a
 * reading) breaks the line instead of drawing a straight line across it.
 */
export function segments(points: ChartPoint[], has: (p: ChartPoint) => boolean): ChartPoint[][] {
  const out: ChartPoint[][] = [];
  let run: ChartPoint[] = [];
  for (const p of points) {
    if (has(p)) run.push(p);
    else if (run.length) {
      out.push(run);
      run = [];
    }
  }
  if (run.length) out.push(run);
  return out;
}

export interface Scale {
  x: (t: number) => number;
  y: (v: number) => number;
}

export function makeScale(points: ChartPoint[], domain: [number, number], width: number, height: number): Scale {
  const t0 = points.length ? points[0].t : 0;
  const t1 = points.length ? points[points.length - 1].t : 1;
  const [lo, hi] = domain;
  return {
    x: (t) => (t1 === t0 ? width / 2 : ((t - t0) / (t1 - t0)) * width),
    y: (v) => height - ((v - lo) / (hi - lo)) * height,
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** SVG path "M x y L x y ..." through the mid values of one segment. */
export function linePath(run: ChartPoint[], s: Scale, key: "mid" | "lo" | "hi" = "mid"): string {
  if (run.length === 1) {
    // a lone bucket: a short flat tick so it is still visible
    const x = s.x(run[0].t);
    const y = s.y(run[0][key]!);
    return `M${r2(x - 3)} ${r2(y)}L${r2(x + 3)} ${r2(y)}`;
  }
  return run.map((p, i) => `${i ? "L" : "M"}${r2(s.x(p.t))} ${r2(s.y(p[key]!))}`).join("");
}

/** Closed polygon from max (left to right) back along min (right to left). */
export function bandPath(run: ChartPoint[], s: Scale): string {
  if (run.length === 1) {
    const x = s.x(run[0].t);
    return `M${r2(x - 3)} ${r2(s.y(run[0].hi!))}L${r2(x + 3)} ${r2(s.y(run[0].hi!))}` +
      `L${r2(x + 3)} ${r2(s.y(run[0].lo!))}L${r2(x - 3)} ${r2(s.y(run[0].lo!))}Z`;
  }
  const top = run.map((p, i) => `${i ? "L" : "M"}${r2(s.x(p.t))} ${r2(s.y(p.hi!))}`).join("");
  const bottom = [...run].reverse().map((p) => `L${r2(s.x(p.t))} ${r2(s.y(p.lo!))}`).join("");
  return `${top}${bottom}Z`;
}

/** Index of the bucket nearest to a fraction (0..1) of the chart width. */
export function nearestIndex(points: ChartPoint[], fraction: number): number {
  if (points.length <= 1) return 0;
  const t0 = points[0].t;
  const t = t0 + Math.min(1, Math.max(0, fraction)) * (points[points.length - 1].t - t0);
  let best = 0;
  for (let i = 1; i < points.length; i++) if (Math.abs(points[i].t - t) < Math.abs(points[best].t - t)) best = i;
  return best;
}

// ------------------------------------------------------------- time text
export function bucketText(t: number, bucketS: number): string {
  const d = new Date(t);
  if (bucketS >= 86400) return d.toLocaleDateString([], { day: "numeric", month: "short" });
  return d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function bucketSizeText(bucketS: number): string {
  if (!finite(bucketS) || bucketS <= 0) return "";
  if (bucketS % 86400 === 0) return bucketS === 86400 ? "1 day" : `${bucketS / 86400} days`;
  if (bucketS % 3600 === 0) return bucketS === 3600 ? "1 hour" : `${bucketS / 3600} hours`;
  return `${Math.round(bucketS / 60)} min`;
}

export function fmtNum(v: number | null | undefined, digits: number): string {
  return finite(v) ? v.toFixed(digits) : "–";
}

// ------------------------------------------------------------- CSV export
/**
 * One CSV cell. Quoted when needed; text that a spreadsheet would run as a
 * formula (= + - @ at the start) gets a leading apostrophe - node ids and
 * hazard names come from devices, not from us. Numbers stay numbers.
 */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const toCsv = (rows: (string | number | boolean | null | undefined)[][]) =>
  rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";

export function trendsCsv(data: TrendsResponse): string {
  const header = ["bucket_start_utc", "risk_score_max", "severity_max"];
  for (const f of TREND_FIELDS) header.push(`${f}_min`, `${f}_max`, `${f}_mean`);
  const rows: (string | number | null)[][] = [
    [`# SANJEEVNI trends - node ${data.node_id}, range ${data.range}, bucket ${data.bucket_s} s, generated ${data.generated_at}`],
    [`# ${data.data_note || "Demo data may include SIMULATED readings."}`],
    header,
  ];
  for (const p of data.series) {
    const row: (string | number | null)[] = [p.t, p.risk_score_max, p.severity_max];
    for (const f of TREND_FIELDS) {
      const s = p[f] as FieldStats | null | undefined;
      row.push(s?.min ?? null, s?.max ?? null, s?.mean ?? null);
    }
    rows.push(row);
  }
  return toCsv(rows);
}

export function summaryCsv(s: SummaryResponse): string {
  const fc = s.forecast_alerts;
  const rows: (string | number | null)[][] = [
    [`# SANJEEVNI district summary - range ${s.range}, generated ${s.generated_at}`],
    [`# ${s.data_note || "Demo data may include SIMULATED readings."}`],
    [`# alerts_by_hazard / alerts_by_node count: ${s.alerts_count_basis || ALERTS_COUNT_FALLBACK}`],
    [`# forecast_alerts: ${fc?.basis || FORECAST_ALERTS_FALLBACK} (forecast_alerts_total value = nodes affected)`],
    [`# exceedance_hours value: ${nodeHoursText(summaryNodeIds(s).length, s.range)}${s.exceedance_note ? ` ${s.exceedance_note}` : ""}`],
    ...Object.entries(s.exceedance_basis ?? {}).map(([k, v]) => [`# exceedance_hours ${k}: ${v}`]),
    [`# top_hotspots value = score: ${s.hotspot_basis || "see the backend's hotspot rule"}`],
    ...(s.uptime_basis ? [[`# node_uptime_pct: ${s.uptime_basis}`]] : []),
    ["section", "key", "count", "confirmed", "max_severity", "value"],
  ];
  for (const [k, v] of Object.entries(s.alerts_by_hazard ?? {})) rows.push(["alerts_by_hazard", k, v.count, v.confirmed, v.max_severity, null]);
  if (fc && finite(fc.count)) {
    rows.push(["forecast_alerts_total", "all forecast hazards", fc.count, fc.confirmed, null, fc.nodes]);
    for (const [k, v] of Object.entries(fc.by_hazard ?? {})) rows.push(["forecast_alerts", k, v.count, v.confirmed, v.max_severity, null]);
  }
  for (const [k, v] of Object.entries(s.alerts_by_node ?? {})) rows.push(["alerts_by_node", k, v.count, null, v.max_severity, null]);
  for (const [k, v] of Object.entries(s.exceedance_hours ?? {})) rows.push(["exceedance_hours", k, null, null, null, v]);
  (s.top_hotspots ?? []).forEach((h, i) =>
    rows.push(["top_hotspots", `${i + 1}. ${h.node_id} (${h.location})`, null, null, h.dominant_hazard, h.score]));
  for (const [k, v] of Object.entries(s.node_uptime_pct ?? {})) rows.push(["node_uptime_pct", k, null, null, null, v]);
  return toCsv(rows);
}

/** Saves text as a file (Blob + object URL - allowed by the page CSP). */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  // BOM so Excel reads the µ / ³ in the CSV as UTF-8
  saveBlob(new Blob(["﻿", text], { type }), filename);
}

export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ------------------------------------------------------------- summary text
// What the backend counts (backend/analytics.py, review 2026-10-09). The
// backend sends these texts itself (alerts_count_basis, exceedance_basis,
// ...); the fallbacks are for an older backend that does not.
export const ALERTS_COUNT_FALLBACK =
  "alert readings (confirmed + pending) assessed from the nodes' own sensors - not separate events";
export const FORECAST_ALERTS_FALLBACK =
  "alert readings whose severity came from the weather forecast alone - area-wide, raised at every node in the forecast area";
/**
 * What an exceedance value is, with the ceiling for THIS report. It used to
 * say "(10 nodes over 7 days = up to 1,680 node-hours)" on every report - an
 * example that read as a fact (the demo has 3 nodes; W2 browser check).
 */
export function nodeHoursText(nodeCount: number, range: SummaryRange): string {
  const days = range === "30d" ? 30 : 7;
  if (!(nodeCount > 0)) return "node-hours, summed over all nodes (up to 24 per node per day), not clock hours.";
  const max = (nodeCount * days * 24).toLocaleString("en-US");
  return `node-hours, summed over all nodes (${nodeCount} node${nodeCount === 1 ? "" : "s"} over ${days} days = ` +
    `up to ${max} node-hours), not clock hours.`;
}

export interface BannerNote { label: string; text: string }

/**
 * The backend's data notes for the trends page banner, each labelled with
 * the section it describes (their reading counts differ); one note when
 * both say the same thing; none when the backend sent none.
 */
export function bannerNotes(trendsNote: string | null | undefined, summaryNote: string | null | undefined): BannerNote[] {
  const t = trendsNote?.trim() || null;
  const s = summaryNote?.trim() || null;
  if (t && s && t === s) return [{ label: "Node trends and district summary", text: t }];
  return [
    ...(t ? [{ label: "Node trends", text: t }] : []),
    ...(s ? [{ label: "District summary", text: s }] : []),
  ];
}

/** The nodes a summary covers: every node with an alert count or an uptime figure. */
export function summaryNodeIds(s: Pick<SummaryResponse, "alerts_by_node" | "node_uptime_pct">): string[] {
  return [...new Set([...Object.keys(s.alerts_by_node ?? {}), ...Object.keys(s.node_uptime_pct ?? {})])];
}

// Uptime, honestly: SANJEEVNI has not been field-deployed, so the stored
// readings are mostly the demo simulator's (server/simulation.js), which
// only sends while a demo runs - every slot between demos counts as "no
// reading". Intervals: user decision 2026-10-09 (siren nodes 1 min, the
// others 5 min, urgent readings at once).
export const UPTIME_NOTE =
  "Why uptime can look low: this prototype has not been field-deployed, so most readings come from the demo " +
  "simulator, which only sends while a demo is running. Every slot without a demo counts as \"no reading\", so a " +
  "simulated node shows a low uptime although nothing failed. A deployed node reports every minute (with a siren) " +
  "or every 5 minutes (without one), and at once for anything urgent - for a real node, low uptime means power " +
  "or radio-link trouble.";

// Thresholds as backend/analytics.py counts them: CPCB NAQI bands (the
// same table as lib/sensors.ts - Poor PM2.5 91-120 / PM10 251-350, Severe
// PM2.5 250+ / PM10 430+) and IMD heat-wave criteria for the node's region.
const EXCEEDANCE_LABELS: Record<string, string> = {
  pm25_poor_or_worse: "PM2.5 in CPCB NAQI “Poor” or worse (above 90 µg/m³)",
  pm10_poor_or_worse: "PM10 in CPCB NAQI “Poor” or worse (above 250 µg/m³)",
  pm25_severe: "PM2.5 in CPCB NAQI “Severe” (above 250 µg/m³)",
  pm10_severe: "PM10 in CPCB NAQI “Severe” (above 430 µg/m³)",
  heat_wave: "Heat-wave conditions (IMD criteria for the node's region)",
  severe_heat_wave: "Severe heat-wave conditions (IMD criteria for the node's region)",
};

/** Label for an exceedance key; unknown keys are shown readably, never dropped. */
export function exceedanceLabel(key: string): string {
  if (Object.hasOwn(EXCEEDANCE_LABELS, key)) return EXCEEDANCE_LABELS[key];
  const text = key.replace(/_/g, " ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The backend's own description of how an exceedance key is counted, or null. */
export function exceedanceBasis(s: SummaryResponse, key: string): string | null {
  const b = s.exceedance_basis;
  return b && Object.hasOwn(b, key) && typeof b[key] === "string" ? b[key] : null;
}

const sevRank = (s: string | null | undefined) =>
  s && Object.hasOwn(SEVERITY_RANK, s) ? SEVERITY_RANK[s as keyof typeof SEVERITY_RANK] : -1;

export const bySeverityThenCount = <T extends { count: number; max_severity: string | null }>(
  a: [string, T], b: [string, T],
) => b[1].count - a[1].count || sevRank(b[1].max_severity) - sevRank(a[1].max_severity) || a[0].localeCompare(b[0]);

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const fmtHours = (h: number) => (Number.isInteger(h) ? String(h) : h.toFixed(1));

/**
 * Plain-language findings for the printed district report, computed only
 * from the summary itself (no extra claims). The page shows the data note
 * next to them.
 */
export function summaryFindings(s: SummaryResponse, rangeText: string): string[] {
  const out: string[] = [];
  const period = rangeText.toLowerCase();
  const hazards = Object.entries(s.alerts_by_hazard ?? {}).filter(([, v]) => finite(v.count));
  const total = hazards.reduce((n, [, v]) => n + v.count, 0);
  const confirmed = hazards.reduce((n, [, v]) => n + (finite(v.confirmed) ? v.confirmed : 0), 0);
  const fc = s.forecast_alerts;
  const fcCount = fc && finite(fc.count) ? fc.count : 0;
  if (total === 0 && fcCount === 0) {
    out.push(`No hazard alerts were recorded in the ${period}.`);
  } else if (total === 0) {
    out.push(`No alerts from the nodes' own sensors in the ${period}.`);
  } else {
    out.push(`${plural(total, "alert reading")} from the nodes' own sensors in the ${period}, ${confirmed} of them confirmed.`);
    const [topType, top] = [...hazards].sort(bySeverityThenCount)[0];
    out.push(`Most frequent hazard: ${hazardTypeText(topType)} (${plural(top.count, "alert reading")}` +
      `${top.max_severity ? `, highest severity ${top.max_severity}` : ""}).`);
  }
  if (fc && fcCount > 0) {
    const kinds = Object.entries(fc.by_hazard ?? {}).filter(([, v]) => finite(v.count)).sort(bySeverityThenCount)
      .map(([k, v]) => `${hazardTypeText(k)}${v.max_severity ? ` up to ${v.max_severity}` : ""}`);
    out.push(`Forecast-based alerts (area-wide, from the weather forecast, not measured): ${plural(fcCount, "alert reading")}` +
      `${finite(fc.nodes) ? ` at ${plural(fc.nodes, "node")}` : ""}, ${finite(fc.confirmed) ? fc.confirmed : 0} confirmed` +
      `${kinds.length ? ` - ${kinds.join(", ")}` : ""}. Not counted in the node totals or hotspots.`);
  }
  const nodes = Object.entries(s.alerts_by_node ?? {}).filter(([, v]) => finite(v.count) && v.count > 0);
  if (nodes.length) {
    const [node, v] = [...nodes].sort(bySeverityThenCount)[0];
    out.push(`Node with the most alert readings: ${node} (${plural(v.count, "alert reading")}).`);
  }
  const hot = s.top_hotspots?.[0];
  if (hot) {
    out.push(`Top hotspot: ${hot.location} (${hot.node_id})${hot.dominant_hazard ? `, mostly ${hazardTypeText(hot.dominant_hazard)}` : ""}.`);
  }
  for (const [key, hours] of Object.entries(s.exceedance_hours ?? {})) {
    if (finite(hours) && hours > 0) out.push(`${exceedanceLabel(key)}: ${fmtHours(hours)} node-hours.`);
  }
  const uptime = Object.entries(s.node_uptime_pct ?? {}).filter(([, v]) => finite(v));
  if (uptime.length) {
    const [node, pct] = uptime.sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))[0];
    if (pct < 95) {
      out.push(`Lowest node uptime: ${node} at ${pct.toFixed(1)} % - a simulated node only reports while a demo runs; ` +
        "for a real node, check its power and link before relying on its trend.");
    }
    else out.push(`All nodes reported at least ${pct.toFixed(1)} % of the time.`);
  }
  return out;
}
