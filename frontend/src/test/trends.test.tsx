// Trends & reports (step W2): chart geometry, CSV export, report findings,
// the per-alert CAP XML / PDF report / Timeline buttons and the trends page.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { Hazard, SummaryResponse, TrendsResponse } from "../api/types";
import { AlertActions } from "../components/AlertActions";
import { HazardList } from "../components/dashboard";
import {
  alertLinks, bandPath, csvCell, exceedanceBasis, exceedanceLabel, fieldPoints, linePath, makeScale, nearestIndex, riskPoints, segments,
  summaryCsv, summaryFindings, toCsv, trendsCsv, valueDomain, type ChartPoint,
} from "../lib/trends";
import { OfficerPage } from "../pages/OfficerPage";
import { TrendsPage } from "../pages/TrendsPage";
import { Providers } from "../Providers";

vi.mock("../lib/siren", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/siren")>()),
  siren: { isSupported: () => false, isUnlocked: () => false, unlock: async () => false, start: () => {}, stop: () => {},
           subscribe: () => () => {} },
}));

const H = (h: number) => `2026-10-09T${String(h).padStart(2, "0")}:00:00Z`;
const TRENDS: TrendsResponse = {
  node_id: "NODE-A", range: "24h", bucket_s: 3600, generated_at: "2026-10-09T12:00:00Z",
  data_note: "Includes simulated readings from the demo simulator.",
  series: [
    { t: H(9), risk_score_max: 0.2, severity_max: "LOW", river_level_m: { min: 1, max: 1.4, mean: 1.2 }, pm25_ugm3: null },
    { t: H(10), risk_score_max: null, severity_max: null, river_level_m: null },
    { t: H(11), risk_score_max: 0.9, severity_max: "CRITICAL", river_level_m: { min: 2, max: 3, mean: 2.5 } },
  ],
};
const SUMMARY: SummaryResponse = {
  range: "7d", generated_at: "2026-10-09T12:00:00Z", data_note: "Summary counts include simulated readings.",
  alerts_by_hazard: {
    flood: { count: 5, confirmed: 3, max_severity: "CRITICAL" },
    "air pollution": { count: 2, confirmed: 2, max_severity: "HIGH" },
  },
  alerts_by_node: { "NODE-A": { count: 6, max_severity: "CRITICAL" }, "NODE-B": { count: 1, max_severity: "HIGH" } },
  exceedance_hours: { pm25_poor_or_worse: 12, heat_wave: 0, rain_heavy_or_worse: 3.5 },
  top_hotspots: [{ node_id: "NODE-A", location: "Riverside", score: 0.62, dominant_hazard: "flood" }],
  node_uptime_pct: { "NODE-A": 99.2, "NODE-B": 71.5, "NODE-C": 100 },
};

describe("chart geometry", () => {
  const pts = fieldPoints(TRENDS.series, "river_level_m");
  it("maps buckets to points; missing stats are gaps, never zeros", () => {
    expect(pts.map((p) => p.mid)).toEqual([1.2, null, 2.5]);
    expect(pts[1]).toMatchObject({ lo: null, hi: null });
    expect(riskPoints(TRENDS.series).map((p) => p.mid)).toEqual([0.2, null, 0.9]);
    expect(fieldPoints(TRENDS.series, "pm25_ugm3").every((p) => p.mid === null)).toBe(true);
  });
  it("breaks the line at a gap", () => {
    const runs = segments(pts, (p) => p.mid !== null);
    expect(runs.map((r) => r.length)).toEqual([1, 1]);
  });
  it("pads the value range; a fixed range wins; a flat series still has height", () => {
    const [lo, hi] = valueDomain(pts);
    expect(lo).toBeLessThan(1);
    expect(hi).toBeGreaterThan(3);
    expect(valueDomain(pts, [0, 1])).toEqual([0, 1]);
    const flat: ChartPoint[] = [{ t: 0, lo: null, hi: null, mid: 5 }, { t: 1, lo: null, hi: null, mid: 5 }];
    expect(valueDomain(flat)).toEqual([4.5, 5.5]);
    expect(valueDomain([])).toEqual([0, 1]);
  });
  it("draws paths inside the box and finds the nearest bucket", () => {
    const run: ChartPoint[] = [{ t: 0, lo: 0, hi: 2, mid: 1 }, { t: 10, lo: 1, hi: 3, mid: 2 }];
    const s = makeScale(run, [0, 4], 100, 40);
    expect(linePath(run, s)).toBe("M0 30L100 20");
    expect(bandPath(run, s)).toBe("M0 20L100 10L100 30L0 40Z");
    const lone = makeScale([run[0]], [0, 4], 100, 40);
    expect(linePath([run[0]], lone)).toBe("M47 30L53 30"); // a lone bucket: a short tick in the middle
    expect(nearestIndex(run, 0.2)).toBe(0);
    expect(nearestIndex(run, 0.8)).toBe(1);
  });
});

describe("CSV export", () => {
  it("quotes, and defuses spreadsheet formulas in text cells", () => {
    expect(csvCell('a "b", c')).toBe('"a ""b"", c"');
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell(-2.5)).toBe("-2.5"); // numbers stay numbers
    expect(csvCell(null)).toBe("");
    expect(csvCell(Number.NaN)).toBe("");
    expect(toCsv([["a", 1], ["b", null]])).toBe("a,1\r\nb,\r\n");
  });
  it("trends CSV: the data note, a header with min/max/mean per sensor, one row per bucket", () => {
    const lines = trendsCsv(TRENDS).trim().split("\r\n");
    expect(lines[0]).toMatch(/^"# SANJEEVNI trends - node NODE-A, range 24h/); // one quoted cell (has commas)
    expect(lines[1]).toBe("# Includes simulated readings from the demo simulator.");
    expect(lines[2]).toMatch(/^bucket_start_utc,risk_score_max,severity_max,river_level_m_min,river_level_m_max,river_level_m_mean,/);
    expect(lines).toHaveLength(3 + 3);
    expect(lines[3]).toMatch(/^2026-10-09T09:00:00Z,0.2,LOW,1,1.4,1.2,/);
    expect(lines[4]).toMatch(/^2026-10-09T10:00:00Z,,,,,,/);
  });
  it("summary CSV has every section", () => {
    const csv = summaryCsv(SUMMARY);
    for (const s of ["alerts_by_hazard,flood,5,3,CRITICAL,", "alerts_by_node,NODE-B,1,,HIGH,", "exceedance_hours,heat_wave,,,,0",
      "top_hotspots,1. NODE-A (Riverside),,,flood,0.62", "node_uptime_pct,NODE-B,,,,71.5"]) {
      expect(csv).toContain(s);
    }
    expect(csv).toContain("# Summary counts include simulated readings.");
  });
});

describe("district report text", () => {
  it("states only what the summary contains", () => {
    expect(summaryFindings(SUMMARY, "Last 7 days")).toEqual([
      "7 alert readings from the nodes' own sensors in the last 7 days, 5 of them confirmed.",
      "Most frequent hazard: flood (5 alert readings, highest severity CRITICAL).",
      "Node with the most alert readings: NODE-A (6 alert readings).",
      "Top hotspot: Riverside (NODE-A), mostly flood.",
      "PM2.5 in CPCB NAQI “Poor” or worse (above 90 µg/m³): 12 node-hours.",
      "Rain heavy or worse: 3.5 node-hours.",
      "Lowest node uptime: NODE-B at 71.5 % - a simulated node only reports while a demo runs; for a real node, " +
        "check its power and link before relying on its trend.",
    ]);
  });
  it("an empty period says so", () => {
    const empty = { ...SUMMARY, alerts_by_hazard: {}, alerts_by_node: {}, exceedance_hours: {}, top_hotspots: [], node_uptime_pct: {} };
    expect(summaryFindings(empty, "Last 30 days")).toEqual(["No hazard alerts were recorded in the last 30 days."]);
    const zeroForecast = { ...empty, forecast_alerts: { count: 0, confirmed: 0, nodes: 0, by_hazard: {} } };
    expect(summaryFindings(zeroForecast, "Last 30 days")).toEqual(["No hazard alerts were recorded in the last 30 days."]);
  });
  it("forecast-based alerts are reported, never hidden behind 'no alerts'", () => {
    const onlyForecast: SummaryResponse = {
      ...SUMMARY, alerts_by_hazard: {}, alerts_by_node: {}, exceedance_hours: {}, top_hotspots: [], node_uptime_pct: {},
      forecast_alerts: { count: 40, confirmed: 30, nodes: 5, by_hazard: {
        heavy_rain: { count: 30, confirmed: 25, max_severity: "HIGH" },
        high_wind: { count: 10, confirmed: 5, max_severity: "MEDIUM" },
      } },
    };
    expect(summaryFindings(onlyForecast, "Last 7 days")).toEqual([
      "No alerts from the nodes' own sensors in the last 7 days.",
      "Forecast-based alerts (area-wide, from the weather forecast, not measured): 40 alert readings at 5 nodes, " +
        "30 confirmed - heavy rain up to HIGH, high wind up to MEDIUM. Not counted in the node totals or hotspots.",
    ]);
    const csv = summaryCsv(onlyForecast);
    expect(csv).toContain("forecast_alerts_total,all forecast hazards,40,30,,5");
    expect(csv).toContain("forecast_alerts,heavy_rain,30,25,HIGH,");
  });
  it("labels: severe bands and IMD heat wave; unknown exceedance keys stay readable; the backend's basis is used", () => {
    expect(exceedanceLabel("pm10_poor_or_worse")).toMatch(/PM10 .*above 250/);
    expect(exceedanceLabel("pm25_severe")).toMatch(/PM2\.5 .*Severe.*above 250/);
    expect(exceedanceLabel("pm10_severe")).toMatch(/PM10 .*Severe.*above 430/);
    expect(exceedanceLabel("heat_wave")).toMatch(/IMD/);
    expect(exceedanceLabel("severe_heat_wave")).toMatch(/Severe heat-wave .*IMD/);
    expect(exceedanceLabel("constructor")).toBe("Constructor");
    const withBasis = { ...SUMMARY, exceedance_basis: { heat_wave: "node-hours whose 1-h maximum met IMD criteria" } };
    expect(exceedanceBasis(withBasis, "heat_wave")).toBe("node-hours whose 1-h maximum met IMD criteria");
    expect(exceedanceBasis(withBasis, "constructor")).toBeNull();
    expect(exceedanceBasis(SUMMARY, "heat_wave")).toBeNull();
  });
});

describe("alert links", () => {
  it("staff get the officer proxies + timeline; others only the public confirmed-only CAP", () => {
    expect(alertLinks(3, "NODE-A", "officer")).toEqual({
      cap: "/api/officer/alerts/3/cap", pdf: "/api/officer/alerts/3/report.pdf",
      pdfName: "sanjeevni_situation_report_3.pdf", timeline: "/trends.html?node=NODE-A&around=3#timeline",
    });
    expect(alertLinks(3, "NODE-A", "admin").pdf).not.toBeNull();
    expect(alertLinks(3, "NODE-A", "viewer")).toMatchObject({ cap: "/cap/alerts/3.xml", pdf: null, timeline: null });
    expect(alertLinks(3, "N&x", undefined).cap).toBe("/cap/alerts/3.xml");
  });
});

// ---- rendered -----------------------------------------------------------------
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const ALERTS = {
  range: "24h", node_id: "NODE-A", generated_at: "", count: 1,
  alerts: [{ id: 3, node_id: "NODE-A", location: "Riverside", timestamp: H(11), hazard_type: "flood", severity: "CRITICAL",
             risk_score: 0.95, simulated: true }],
};
const TIMELINE = {
  node_id: "NODE-A", count: 2,
  timeline: [
    { id: 2, timestamp: H(10), status: "pending_confirmation", severity: "HIGH", hazard_type: "flood", risk_score: 0.8,
      simulated: 1, river_level_m: 2.1, message: "x" },
    { id: 3, timestamp: H(11), status: "alert_dispatched", severity: "CRITICAL", hazard_type: "flood", risk_score: 0.95,
      simulated: 1, river_level_m: 2.6 },
  ],
};
let API: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;
const calls = (prefix: string) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

beforeEach(() => {
  API = {
    "/api/auth/me": { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 },
    "/api/node-health": { generated_at: "", summary: { online: 2, offline: 0, never_seen: 0 }, nodes_with_issues: 0,
      nodes: ["NODE-B", "NODE-A"].map((id) => ({ node_id: id, location: id === "NODE-A" ? "Riverside" : "Bridge",
        latitude: 29.4, longitude: 79.46, status: "online", level: "ok", last_seen: null, seconds_since_seen: 5,
        expected_interval_seconds: 60, battery_pct: 90, signal_strength_dbm: -90, link: "lora", issues: [] })) },
    "/api/officer/trends": TRENDS,
    "/api/officer/alerts": ALERTS,
    "/api/officer/summary": SUMMARY,
    "/api/officer/timeline/NODE-A": TIMELINE,
  };
  setUnauthorizedHandler(vi.fn());
  window.history.replaceState(null, "", "/trends.html");
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    const body = API[path];
    if (body instanceof Response) return body.clone();
    return body !== undefined ? json(body) : json({ error: "not found" }, 404);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("trends page", () => {
  it("SIMULATED banner with the backend's notes, charts for sensors with data only, CSV download", async () => {
    const createUrl = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    const user = userEvent.setup();
    render(<Providers><TrendsPage /></Providers>);
    const banner = screen.getByRole("note");
    expect(within(banner).getByText("SIMULATED / SYNTHETIC DATA")).toBeInTheDocument();
    // each backend note is labelled with the section it describes (W2 browser check)
    expect(await within(banner).findByText((_, el) => el?.tagName === "P" &&
      el.textContent === "Node trends: Includes simulated readings from the demo simulator.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await within(banner).findByText((_, el) => el?.tagName === "P" &&
      el.textContent === "District summary: Summary counts include simulated readings.")).toBeInTheDocument();
    // first node alphabetically, 24 h by default
    await waitFor(() => expect(calls("/api/officer/trends")).toContain("/api/officer/trends?node_id=NODE-A&range=24h"));
    expect(await screen.findByRole("heading", { name: "River level" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Risk score (highest per bucket)" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "PM2.5" })).toBeNull();
    expect(screen.getByText(/No readings in this period for: PM2.5, PM10, Gas/)).toBeInTheDocument();
    // the chart's text summary for screen readers
    expect(screen.getByRole("img", { name: /^River level, .*lowest 1.00 m, highest 3.00 m, latest mean 2.50 m/ })).toBeInTheDocument();
    expect(window.location.search).toBe("?node=NODE-A&range=24h&summary=7d");

    await user.click(screen.getByRole("button", { name: /Download CSV.*trends shown/ }));
    expect(createUrl).toHaveBeenCalledTimes(1);

    const trendsSection = screen.getByRole("heading", { name: "Node trends" }).closest("section")!;
    await user.click(within(trendsSection).getByRole("radio", { name: "Last 7 days" }));
    await waitFor(() => expect(calls("/api/officer/trends")).toContain("/api/officer/trends?node_id=NODE-A&range=7d"));
  });

  it("alert list: CAP XML link, PDF + Timeline buttons; Timeline replays the readings around the alert", async () => {
    const user = userEvent.setup();
    render(<Providers><TrendsPage /></Providers>);
    const group = await screen.findByRole("group", { name: /Reports for alert #3/ }, { timeout: 5000 });
    expect(within(group).getByRole("link", { name: /CAP XML/ })).toHaveAttribute("href", "/api/officer/alerts/3/cap");
    expect(within(group).getByRole("button", { name: /PDF report/ })).toBeInTheDocument();
    expect(screen.getByText("Simulated")).toBeInTheDocument();

    await user.click(within(group).getByRole("button", { name: /Timeline/ }));
    await waitFor(() => expect(calls("/api/officer/timeline/")).toContain("/api/officer/timeline/NODE-A?window=40&around_id=3"));
    expect(await screen.findByRole("heading", { name: "Readings around alert #3" })).toBeInTheDocument();
    const table = screen.getByRole("table", { name: /Readings around alert #3 at NODE-A/ });
    const active = within(table).getAllByRole("row").find((r) => r.getAttribute("aria-current") === "true")!;
    expect(active).toHaveTextContent("(this alert)");
    expect(active).toHaveTextContent("Confirmed alert");
    expect(within(table).getByText("Awaiting confirmation")).toBeInTheDocument();
    expect(window.location.search).toContain("around=3");
  });

  it("opens straight at a timeline from a map / dashboard link", async () => {
    window.history.replaceState(null, "", "/trends.html?node=NODE-B&around=7#timeline");
    API["/api/officer/timeline/NODE-B"] = { node_id: "NODE-B", count: 0, timeline: [] };
    render(<Providers><TrendsPage /></Providers>);
    expect(await screen.findByText("No readings stored for this node.", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(calls("/api/officer/timeline/")).toContain("/api/officer/timeline/NODE-B?window=40&around_id=7");
    expect(screen.getByRole("combobox", { name: "Node" })).toHaveValue("NODE-B");
  });

  it("district summary: findings, tables, print", async () => {
    const print = vi.fn();
    vi.stubGlobal("print", print);
    const user = userEvent.setup();
    render(<Providers><TrendsPage /></Providers>);
    const report = (await screen.findByRole("heading", { name: "District summary report" }, { timeout: 5000 })).closest("section")!;
    expect(await within(report).findByText("Top hotspot: Riverside (NODE-A), mostly flood.")).toBeInTheDocument();
    expect(within(report).getByRole("rowheader", { name: /PM2.5 in CPCB NAQI/ }).nextElementSibling).toHaveTextContent("12.0");
    expect(within(report).getByRole("rowheader", { name: "NODE-C" }).parentElement).toHaveTextContent("100.0 %");
    // printed copy repeats the SIMULATED warning
    expect(within(report).getByText("SIMULATED / SYNTHETIC DATA.")).toBeInTheDocument();
    // ... with the summary's own note only, not the node-trends one
    expect(within(report).getByText("Summary counts include simulated readings.")).toBeInTheDocument();
    expect(within(report).queryByText(/Includes simulated readings from the demo simulator/)).toBeNull();
    // node-hours ceiling for THIS report: NODE-A, NODE-B, NODE-C over 7 days
    expect(within(report).getByText(/3 nodes over 7 days = up to 504 node-hours/)).toBeInTheDocument();
    await user.click(within(report).getByRole("button", { name: "Print / save as PDF" }));
    expect(print).toHaveBeenCalled();
    await user.click(within(report).getByRole("radio", { name: "Last 30 days" }));
    await waitFor(() => expect(calls("/api/officer/summary")).toContain("/api/officer/summary?range=30d"));
  });

  it("district summary: forecast-based alerts get their own table; node-hours and the backend's basis texts are shown", async () => {
    API["/api/officer/summary"] = {
      ...SUMMARY,
      alerts_count_basis: "count = alert readings (confirmed + pending) assessed from the node's own sensors",
      forecast_alerts: { count: 12, confirmed: 9, nodes: 3, basis: "severity from the weather forecast alone",
        by_hazard: { heavy_rain: { count: 12, confirmed: 9, max_severity: "HIGH" } } },
      exceedance_basis: { pm25_poor_or_worse: "node-hours whose 1-h mean PM2.5 was above 90 ug/m3" },
      exceedance_note: "Indicative screen, not a compliance figure.",
      hotspot_basis: "score = weighted MEDIUM 1, HIGH 2, CRITICAL 4 (project choice)",
      uptime_basis: "percent of 15-min slots with a reading",
    };
    render(<Providers><TrendsPage /></Providers>);
    const report = (await screen.findByRole("heading", { name: "District summary report" }, { timeout: 5000 })).closest("section")!;
    expect(await within(report).findByRole("heading", { name: /Forecast-based alerts \(area-wide/ })).toBeInTheDocument();
    expect(within(report).getByText(/^Forecast-based alerts \(area-wide, from the weather forecast, not measured\): 12 alert readings at 3 nodes/))
      .toBeInTheDocument();
    expect(within(report).getAllByRole("columnheader", { name: "Alert readings" }).length).toBe(3);
    expect(within(report).getByRole("columnheader", { name: "Node-hours" })).toBeInTheDocument();
    expect(within(report).getByText("node-hours whose 1-h mean PM2.5 was above 90 ug/m3")).toBeInTheDocument();
    expect(within(report).getByText(/Indicative screen, not a compliance figure\./)).toBeInTheDocument();
    expect(within(report).getByText(/Score: score = weighted MEDIUM 1, HIGH 2, CRITICAL 4/)).toBeInTheDocument();
    expect(within(report).getByText(/Counted: count = alert readings/)).toBeInTheDocument();
    // uptime is explained honestly: the simulator only runs during demos
    expect(within(report).getByText(/^Why uptime can look low: this prototype has not been field-deployed/)).toBeInTheDocument();
    expect(within(report).getByText(/every minute \(with a siren\) or every 5 minutes \(without one\)/)).toBeInTheDocument();
  });

  it("a backend without the analytics endpoints shows the server's message", async () => {
    API["/api/officer/trends"] = json({ error: "This AI backend has no endpoint for trends yet - update and restart backend_server.py.",
      code: "backend_outdated" }, 502);
    render(<Providers><TrendsPage /></Providers>);
    expect(await screen.findByText(/Can't load trends: This AI backend has no endpoint for trends yet/, {}, { timeout: 8000 }))
      .toBeInTheDocument();
  });

  it("has no axe violations", { timeout: 20_000 }, async () => {
    const { container } = render(<Providers><TrendsPage /></Providers>);
    await screen.findByRole("heading", { name: "River level" }, { timeout: 5000 });
    await screen.findByText("Top hotspot: Riverside (NODE-A), mostly flood.");
    const result = await axe.run(container, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`)).toEqual([]);
  });
});

describe("CAP / PDF / Timeline buttons", () => {
  it("PDF: a backend error is shown, not saved as a .pdf", async () => {
    API["/api/officer/alerts/3/report.pdf"] = json({ error: "Can't reach the AI backend for the situation report", code: "backend_unreachable" }, 502);
    const createUrl = vi.fn(() => "blob:x");
    vi.stubGlobal("URL", Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() }));
    const user = userEvent.setup();
    render(<AlertActions alertId={3} nodeId="NODE-A" role="officer" label="flood at NODE-A" />);
    await user.click(screen.getByRole("button", { name: /PDF report/ }));
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF report: Can't reach the AI backend for the situation report");
    expect(createUrl).not.toHaveBeenCalled();

    API["/api/officer/alerts/3/report.pdf"] = new Response("%PDF-1.4", { headers: { "Content-Type": "application/pdf" } });
    await user.click(screen.getByRole("button", { name: /PDF report/ }));
    await waitFor(() => expect(createUrl).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("timeline link opens the trends page in one re-used tab", () => {
    render(<AlertActions alertId={9} nodeId="NODE-B" role="admin" label="fire at NODE-B" />);
    const link = screen.getByRole("link", { name: /Timeline/ });
    expect(link).toHaveAttribute("href", "/trends.html?node=NODE-B&around=9#timeline");
    expect(link).toHaveAttribute("target", "sanjeevni-trends");
  });

  const hazard = (alert_id: number | null): Hazard => ({
    label: "Hazard 1", node_id: "NODE-A", location: "Riverside", hazard_type: "flood", severity: "HIGH", risk_score: 0.8,
    latitude: 29.4, longitude: 79.46, eta_minutes: null, predicted_time: null, prediction_text: "", alert_id,
  });
  it("dashboard card: viewers get the public CAP XML only; officers also PDF + Timeline; none without an id", () => {
    const { unmount } = render(<HazardList hazards={[hazard(3)]} role="viewer" />);
    expect(screen.getByRole("link", { name: /CAP XML/ })).toHaveAttribute("href", "/cap/alerts/3.xml");
    expect(screen.queryByRole("button", { name: /PDF report/ })).toBeNull();
    expect(screen.queryByRole("link", { name: /Timeline/ })).toBeNull();
    unmount();
    const officer = render(<HazardList hazards={[hazard(3)]} role="officer" />);
    expect(screen.getByRole("link", { name: /CAP XML/ })).toHaveAttribute("href", "/api/officer/alerts/3/cap");
    expect(screen.getByRole("button", { name: /PDF report/ })).toBeInTheDocument();
    // the buttons are not inside the card link
    expect(screen.getByRole("link", { name: /CAP XML/ }).closest("a[data-hazard-key]")).toBeNull();
    officer.unmount();
    render(<HazardList hazards={[hazard(null)]} role="officer" />);
    expect(screen.queryByRole("link", { name: /CAP XML/ })).toBeNull();
  });
});

describe("officer map hazard list", () => {
  it("confirmed zones get CAP XML / PDF / Timeline; pending zones none; the feed is linked", async () => {
    const zone = { hazard_type: "flood", severity: "HIGH", risk_score: 0.8, latitude: 29.4, longitude: 79.46, radius_m: 1000 };
    API["/api/hazard-zones"] = { success: true, zones: [
      { ...zone, node_id: "NODE-A", confirmed: true, alert_id: 3 },
      { ...zone, node_id: "NODE-B", confirmed: false, alert_id: null },
    ] };
    API["/api/sos"] = { success: true, count: 0, escalated_count: 0, data: [] };
    API["/api/sirens"] = { auto_severity: "CRITICAL", default_on_seconds: 180, sirens: [] };
    window.history.replaceState(null, "", "/officer.html");
    render(<Providers><OfficerPage /></Providers>);
    const list = (await screen.findByRole("heading", { name: /Hazard zones/ }, { timeout: 5000 })).closest("section")!;
    const group = await within(list).findByRole("group", { name: /Reports for alert #3: flood at NODE-A/i }, { timeout: 5000 });
    expect(within(group).getByRole("link", { name: /CAP XML/ })).toHaveAttribute("href", "/api/officer/alerts/3/cap");
    expect(within(group).getByRole("link", { name: /Timeline/ })).toHaveAttribute("href", "/trends.html?node=NODE-A&around=3#timeline");
    expect(within(list).getAllByRole("group", { name: /Reports for alert/ })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Public CAP 1.2 alert feed (Atom)" })).toHaveAttribute("href", "/cap/feed.atom");
    expect(screen.getByRole("link", { name: "Trends & reports" })).toHaveAttribute("href", "/trends.html");
  });
});
