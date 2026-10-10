// Small hand-written SVG chart for the trends page (no chart library: the
// page CSP allows no inline styles, and the bundle stays small).
// One series per chart, one y-axis. "band" = shaded min-max per time bucket
// with the mean as a line; "line" = one value per bucket. Gaps (buckets with
// no reading) break the line. Axis text is HTML next to the SVG, so it stays
// readable when the SVG stretches to the page width.
import { useId, useMemo, useState, type PointerEvent } from "react";
import {
  bandPath, bucketText, fmtNum, linePath, makeScale, nearestIndex, segments, valueDomain, type ChartPoint,
} from "../lib/trends";
import styles from "./Trends.module.css";

const W = 600;
const H = 160;

export interface TrendChartProps {
  title: string;
  unit: string;
  digits: number;
  points: ChartPoint[];
  bucketS: number;
  kind: "band" | "line";
  /** fixed value range (e.g. risk 0..1) */
  domain?: [number, number];
  /** dashed guide line, e.g. where NAQI "Poor" starts */
  reference?: { value: number; label: string };
  /** what the line value is called in the readout ("mean", "max risk", ...) */
  valueName?: string;
  /** extra text per bucket in the readout (e.g. the highest severity) */
  extra?: (index: number) => string | null;
  /** index to mark (e.g. the alert a timeline is centred on) */
  markIndex?: number | null;
}

export function TrendChart({
  title, unit, digits, points, bucketS, kind, domain, reference, valueName = "mean", extra, markIndex = null,
}: TrendChartProps) {
  const headingId = useId();
  const [hover, setHover] = useState<number | null>(null);
  const [tableOpen, setTableOpen] = useState(false);
  const dom = useMemo(() => valueDomain(points, domain, reference ? [reference.value] : []), [points, domain, reference]);
  const scale = useMemo(() => makeScale(points, dom, W, H), [points, dom]);
  const u = unit ? ` ${unit}` : "";
  const v = (n: number | null) => (n === null ? "no reading" : `${fmtNum(n, digits)}${u}`);

  const lastWithData = useMemo(() => {
    for (let i = points.length - 1; i >= 0; i--) if (points[i].mid !== null || points[i].hi !== null) return i;
    return null;
  }, [points]);
  const shown = hover ?? markIndex ?? lastWithData;

  const readout = (i: number) => {
    const p = points[i];
    const parts = [bucketText(p.t, bucketS)];
    if (kind === "band") {
      parts.push(p.mid === null && p.hi === null ? "no reading"
        : `${valueName} ${v(p.mid)} (min ${v(p.lo)}, max ${v(p.hi)})`);
    } else {
      parts.push(`${valueName} ${v(p.mid)}`);
    }
    const more = extra?.(i);
    if (more) parts.push(more);
    return parts.join(" · ");
  };

  const summary = useMemo(() => {
    const vals = points.flatMap((p) => [p.lo, p.hi, p.mid]).filter((n): n is number => n !== null);
    if (!vals.length || !points.length) return `${title}: no readings in this period.`;
    const first = bucketText(points[0].t, bucketS);
    const last = bucketText(points[points.length - 1].t, bucketS);
    const latest = lastWithData !== null ? points[lastWithData].mid ?? points[lastWithData].hi : null;
    return `${title}, ${first} to ${last}: lowest ${v(Math.min(...vals))}, highest ${v(Math.max(...vals))}` +
      (latest !== null ? `, latest ${valueName} ${v(latest)}` : "") + ". The data table below lists every value.";
  }, [points, title, bucketS, lastWithData, valueName, digits, unit]); // v() only uses digits + unit

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    if (r.width > 0 && points.length) setHover(nearestIndex(points, (e.clientX - r.left) / r.width));
  };

  const bandRuns = kind === "band" ? segments(points, (p) => p.lo !== null && p.hi !== null) : [];
  const lineRuns = segments(points, (p) => p.mid !== null);
  const [lo, hi] = dom;
  const markX = shown !== null && points[shown] ? scale.x(points[shown].t) : null;

  return (
    <figure className={styles.chart} aria-labelledby={headingId}>
      <figcaption className={styles.chartHead}>
        <h3 id={headingId} className={styles.chartTitle}>{title}</h3>
        <span className={styles.chartKey}>
          {kind === "band" ? (
            <>
              <span className={styles.keyLine} aria-hidden="true" /> {valueName}
              <span className={styles.keyBand} aria-hidden="true" /> min–max per bucket
            </>
          ) : (
            <><span className={styles.keyLine} aria-hidden="true" /> {valueName}</>
          )}
          {reference && <><span className={styles.keyRef} aria-hidden="true" /> guide line</>}
        </span>
      </figcaption>
      <p className={styles.readout}>{shown !== null && points[shown] ? readout(shown) : "No readings in this period"}</p>
      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          <span>{fmtNum(hi, digits)}</span>
          <span>{fmtNum((hi + lo) / 2, digits)}</span>
          <span>{fmtNum(lo, digits)}</span>
        </div>
        <svg className={styles.svg} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label={summary}
             onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {[0, H / 2, H].map((y) => (
            <line key={y} className={styles.grid} x1={0} x2={W} y1={y} y2={y} vectorEffect="non-scaling-stroke" />
          ))}
          {reference && reference.value >= lo && reference.value <= hi && (
            <line className={styles.refLine} x1={0} x2={W} y1={scale.y(reference.value)} y2={scale.y(reference.value)}
                  vectorEffect="non-scaling-stroke" />
          )}
          {bandRuns.map((run) => <path key={`b${run[0].t}`} className={styles.band} d={bandPath(run, scale)} />)}
          {lineRuns.map((run) => (
            <path key={`l${run[0].t}`} className={styles.line} d={linePath(run, scale)} vectorEffect="non-scaling-stroke" />
          ))}
          {markX !== null && (
            <line className={styles.cursor} x1={markX} x2={markX} y1={0} y2={H} vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
      <div className={styles.xAxis} aria-hidden="true">
        <span>{points.length ? bucketText(points[0].t, bucketS) : ""}</span>
        <span>{points.length > 1 ? bucketText(points[points.length - 1].t, bucketS) : ""}</span>
      </div>
      {reference && <p className={styles.refNote}>Dashed line: {reference.label}</p>}
      <details className={styles.tableDetails} onToggle={(e) => setTableOpen(e.currentTarget.open)}>
        <summary>Data table<span className="visually-hidden"> for {title}</span></summary>
        {tableOpen && (
          <div className={styles.tableWrap}>
            <table className={styles.dataTable}>
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  {kind === "band" ? (
                    <><th scope="col">Min</th><th scope="col">Mean</th><th scope="col">Max</th></>
                  ) : <th scope="col">{valueName}</th>}
                  {extra && <th scope="col">Note</th>}
                </tr>
              </thead>
              <tbody>
                {points.map((p, i) => (
                  <tr key={p.t + ":" + i}>
                    <th scope="row">{bucketText(p.t, bucketS)}</th>
                    {kind === "band" ? (
                      <><td>{fmtNum(p.lo, digits)}</td><td>{fmtNum(p.mid, digits)}</td><td>{fmtNum(p.hi, digits)}</td></>
                    ) : <td>{fmtNum(p.mid, digits)}</td>}
                    {extra && <td>{extra(i) ?? ""}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
            {unit && <p className={styles.muted}>Values in {unit}.</p>}
          </div>
        )}
      </details>
    </figure>
  );
}
