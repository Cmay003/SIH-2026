// Generous find timeouts: the full suite runs files in parallel, and the officer page (Leaflet + 5 queries) can take over 1 s.
// Risk map (step W1): CPCB NAQI bands, the per-sensor value text, the
// node values panel and the officer page's "Hotspots" layer.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { NodeLatest } from "../api/types";
import { NodeSensorValues } from "../components/RiskLayers";
import {
  SENSOR_ROWS, hotspotRadiusM, isHotspotRange, naqiCategory, nodeSensorView, readingAge, sensorCellText,
} from "../lib/sensors";
import { OfficerPage } from "../pages/OfficerPage";
import { Providers } from "../Providers";

vi.mock("../lib/siren", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/siren")>()),
  siren: { isSupported: () => false, isUnlocked: () => false, unlock: async () => false, start: () => {}, stop: () => {},
           subscribe: () => () => {} },
}));

const row = (field: string) => SENSOR_ROWS.find((r) => r.field === field)!;

describe("CPCB NAQI band (About NAQI table)", () => {
  it("PM2.5 edges: a value moves up only once ABOVE a band's top", () => {
    expect(naqiCategory("pm25", 0)).toBe("Good");
    expect(naqiCategory("pm25", 30)).toBe("Good");
    expect(naqiCategory("pm25", 30.5)).toBe("Satisfactory");
    expect(naqiCategory("pm25", 60)).toBe("Satisfactory");
    expect(naqiCategory("pm25", 61)).toBe("Moderately polluted");
    expect(naqiCategory("pm25", 91)).toBe("Poor");
    expect(naqiCategory("pm25", 121)).toBe("Very Poor");
    expect(naqiCategory("pm25", 250)).toBe("Very Poor");
    expect(naqiCategory("pm25", 251)).toBe("Severe");
  });
  it("PM10 edges", () => {
    expect(naqiCategory("pm10", 50)).toBe("Good");
    expect(naqiCategory("pm10", 100)).toBe("Satisfactory");
    expect(naqiCategory("pm10", 250)).toBe("Moderately polluted");
    expect(naqiCategory("pm10", 350)).toBe("Poor");
    expect(naqiCategory("pm10", 430)).toBe("Very Poor");
    expect(naqiCategory("pm10", 431)).toBe("Severe");
  });
  it("no band for missing or impossible values", () => {
    expect(naqiCategory("pm25", null)).toBeNull();
    expect(naqiCategory("pm25", Number.NaN)).toBeNull();
    expect(naqiCategory("pm10", -1)).toBeNull();
  });
});

describe("sensor value text", () => {
  it("formats units, NAQI, flame and a signed rise rate", () => {
    expect(sensorCellText(row("pm25_ugm3"), { value: 130, state: "ok" })).toBe("130 µg/m³ · NAQI Very Poor");
    expect(sensorCellText(row("tilt_angle_deg"), { value: 4.26, state: "ok" })).toBe("4.3 °");
    expect(sensorCellText(row("water_ph"), { value: 7.04, state: "ok" })).toBe("7.0");
    expect(sensorCellText(row("flame_reading"), { value: 0.31, state: "ok" })).toBe("flame detected (0.31)");
    expect(sensorCellText(row("flame_reading"), { value: 0.05, state: "ok" })).toBe("no flame (0.05)");
    expect(sensorCellText(row("river_level_rate_m_per_hr"), { value: 0.4, state: "ok" })).toBe("+0.40 m/h");
  });
  it("says what is missing and why", () => {
    expect(sensorCellText(row("tilt_angle_deg"), { value: null, state: "no_sensor" })).toBeNull();
    expect(sensorCellText(row("tilt_angle_deg"), undefined)).toBeNull();
    expect(sensorCellText(row("pm10_ugm3"), { value: null, state: "fault", last_value: 80 }))
      .toBe("sensor fault - value dropped (last 80 µg/m³)");
    expect(sensorCellText(row("soil_moisture_pct"), { value: null, state: "not_in_latest" })).toBe("not in the latest reading");
  });
  it("lists every sensor exactly once: a row or a 'no sensor' name", () => {
    const latest: NodeLatest = {
      reading_id: 1, reading_at: null, simulated: false, link: null, hazard_type: null, severity: null, status: null,
      sensor_faults: [], edge_anomaly: [],
      values: { battery_pct: { value: 80, state: "ok" }, gas_ppm: { value: 410, state: "ok" } },
    };
    const view = nodeSensorView(latest);
    expect(view.rows.map((r) => r.row.label)).toEqual(["Gas", "Battery"]);
    expect(view.noSensor).toHaveLength(SENSOR_ROWS.length - 2);
    expect(view.noSensor).toContain("Turbidity");
  });
  it("reading age and hotspot helpers", () => {
    const now = Date.parse("2026-10-09T12:00:00Z");
    expect(readingAge("2026-10-09T11:59:30Z", now)).toBe("30 s ago");
    expect(readingAge("2026-10-09T11:00:00Z", now)).toBe("60 min ago");
    expect(readingAge(null, now)).toBeNull();
    expect(hotspotRadiusM(0)).toBe(400);
    expect(hotspotRadiusM(1)).toBe(2000);
    expect(hotspotRadiusM(5)).toBe(2000);
    expect(hotspotRadiusM(Number.NaN)).toBe(400);
    expect(isHotspotRange("7d")).toBe(true);
    expect(isHotspotRange("1y")).toBe(false);
  });
});

// ---- rendered ---------------------------------------------------------------
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const LATEST = {
  node_id: "NODE-A", location: "Riverside",
  siren: { node_id: "NODE-A", fitted: true, sounding: true, desired: null, reason: "auto_offline", desired_reason: null,
           desired_by: null, until: null, reported_reason: "auto_offline", reported_at: null, simulated: true,
           desired_simulated: false },
  latest: { reading_id: 2, reading_at: new Date(Date.now() - 20_000).toISOString(), simulated: true, link: "lora",
            hazard_type: "air pollution", severity: "HIGH", status: "alert_dispatched", sensor_faults: ["pm10_ugm3"],
            edge_anomaly: [],
            values: { pm25_ugm3: { value: 130, state: "ok" }, pm10_ugm3: { value: null, state: "fault", last_value: 80 },
                      battery_pct: { value: 88, state: "ok" }, tilt_angle_deg: { value: null, state: "no_sensor" },
                      rainfall_24h_mm: { value: 0, state: "ok" } } },
};
const HEATMAP = {
  range: "7d", days: 7, from_day: "2026-10-03", generated_at: "2026-10-09T12:00:00Z",
  data_note: "Counts every stored reading in the window, simulated (demo) readings included.",
  level_edges: { moderate: 0.1, high: 0.3 },
  hotspots: [
    { node_id: "NODE-A", location: "Riverside", latitude: 29.4, longitude: 79.46, reading_count: 10, high_count: 4,
      medium_count: 2, max_risk_score: 0.8, days_reported: 1, days_with_high: 1, intensity: 0.5, level: "high" },
    { node_id: "NODE-X", location: "Unplaced", latitude: null, longitude: null, reading_count: 5, high_count: 0,
      medium_count: 0, max_risk_score: 0.1, days_reported: 1, days_with_high: 0, intensity: 0, level: "low" },
  ],
};
const API: Record<string, unknown> = {
  "/api/auth/me": { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 },
  "/api/hazard-zones": { success: true, zones: [] },
  "/api/sos": { success: true, count: 0, escalated_count: 0, data: [] },
  "/api/sirens": { auto_severity: "CRITICAL", default_on_seconds: 180, sirens: [] },
  "/api/node-health": { generated_at: "", summary: { online: 1, offline: 0, never_seen: 0 }, nodes_with_issues: 0,
    nodes: [{ node_id: "NODE-A", location: "Riverside", latitude: 29.4, longitude: 79.46, status: "online", level: "ok",
              last_seen: null, seconds_since_seen: 20, expected_interval_seconds: 60, battery_pct: 88,
              signal_strength_dbm: -90, link: "lora", issues: [] }] },
  "/api/officer/heatmap": HEATMAP,
  "/api/officer/nodes/NODE-A/latest": LATEST,
};
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  setUnauthorizedHandler(vi.fn());
  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = String(input).split("?")[0];
    return path in API ? json(API[path]) : json({ error: "not found" }, 404);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as typeof fetch);
});
afterEach(() => {
  vi.restoreAllMocks();
});
const calledWith = (prefix: string) => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(prefix));

describe("node sensor values", () => {
  it("shows fitted sensors with units, NAQI band, fault, siren and the SIMULATED badge", async () => {
    render(<Providers><NodeSensorValues nodeId="NODE-A" /></Providers>);
    const table = await screen.findByRole("table", { name: "Latest sensor values at NODE-A" }, { timeout: 5000 });
    const cell = (label: string) => within(table).getByRole("rowheader", { name: label }).nextElementSibling;
    expect(cell("PM2.5")).toHaveTextContent("130 µg/m³ · NAQI Very Poor");
    expect(cell("PM10")).toHaveTextContent("sensor fault - value dropped (last 80 µg/m³)");
    expect(cell("Battery")).toHaveTextContent("88 %");
    expect(cell("Rain, last 24 h")).toHaveTextContent("0.0 mm0 mm is also shown for a node without a rain gauge");
    expect(cell("Village siren")).toHaveTextContent("SOUNDING");
    expect(screen.getByText("SIMULATED")).toBeInTheDocument();
    expect(screen.getByText(/^No sensor: .*Tilt/)).toBeInTheDocument();
    expect(screen.getByText(/rates 24-hour averages/)).toBeInTheDocument();
    expect(screen.getByText(/Latest reading \d+ s ago via lora/)).toBeInTheDocument();
  });

  it("says when a node has no stored reading, and when the server fails", async () => {
    API["/api/officer/nodes/NODE-B/latest"] = { node_id: "NODE-B", location: null, latest: null, siren: null };
    render(<Providers><NodeSensorValues nodeId="NODE-B" /><NodeSensorValues nodeId="NODE-Z" /></Providers>);
    await screen.findByText("No reading stored for this node yet", {}, { timeout: 5000 });
    expect(screen.getByText("Village siren: no siren")).toBeInTheDocument();
    await screen.findByText("Sensor values unavailable: not found", {}, { timeout: 5000 }); // after one retry
  });
});

describe("officer page risk map", () => {
  it("hotspot layer: off by default (no request), then 7 days with list, note, legend and a remembered choice", async () => {
    const user = userEvent.setup();
    render(<Providers><OfficerPage /></Providers>);
    const group = await screen.findByRole("group", { name: "Hotspot layer on the map" }, { timeout: 5000 });
    expect(within(group).getByRole("radio", { name: "Off" })).toBeChecked();
    expect(calledWith("/api/officer/heatmap")).toEqual([]);

    await user.click(within(group).getByRole("radio", { name: "Last 7 days" }));
    const list = await screen.findByRole("list", { name: "Hotspots, last 7 days, most frequent first" }, { timeout: 5000 });
    expect(calledWith("/api/officer/heatmap")).toContain("/api/officer/heatmap?range=7d");
    expect(screen.getByText("Includes SIMULATED data.")).toBeInTheDocument();
    expect(within(list).getByText(/Frequent hazards - 50% of readings elevated, hazard on 1 of 1 days/)).toBeInTheDocument();
    expect(screen.getByText(/Frequent hazards: 30% or more of readings elevated/)).toBeInTheDocument(); // legend
    // the definition (fallback text: this fixture has no `definition`), tied to the list
    expect(screen.getByText(/What is a hotspot\?/).closest("p")).toHaveTextContent(
      /A hotspot is a node where hazards keep coming back\. Intensity = \(elevated readings \+ half the MEDIUM ones\)/);
    expect(list).toHaveAccessibleDescription(/What is a hotspot\?/);
    expect(localStorage.getItem("sanjeevni_officer_hotspots")).toBe("7d");

    // keyboard path to a hotspot; one without a position can't be shown
    const [placed, unplaced] = within(list).getAllByRole("button");
    expect(unplaced).toBeDisabled();
    expect(unplaced).toHaveTextContent("no map position");
    placed.focus();
    await user.keyboard("{Enter}");
    expect(await screen.findByText("Showing hotspot at NODE-A (Riverside) on the map", {}, { timeout: 5000 })).toBeInTheDocument();
  });

  it("hotspot definition and basis come from the server when it sends them", async () => {
    const user = userEvent.setup();
    API["/api/officer/heatmap"] = { ...HEATMAP, definition: "A hotspot is DEFINED BY THE SERVER.", basis: "Elevated = server basis." };
    try {
      render(<Providers><OfficerPage /></Providers>);
      const group = await screen.findByRole("group", { name: "Hotspot layer on the map" }, { timeout: 5000 });
      await user.click(within(group).getByRole("radio", { name: "Last 7 days" }));
      const note = (await screen.findByText(/What is a hotspot\?/, {}, { timeout: 5000 })).closest("p");
      expect(note).toHaveTextContent("What is a hotspot? A hotspot is DEFINED BY THE SERVER. Elevated = server basis.");
    } finally {
      API["/api/officer/heatmap"] = HEATMAP;
    }
  });

  it("node values in the side panel open on demand (keyboard path; markers are not focusable)", async () => {
    const user = userEvent.setup();
    render(<Providers><OfficerPage /></Providers>);
    const btn = await screen.findByRole("button", { name: "NODE-A · Riverside" }, { timeout: 5000 });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(calledWith("/api/officer/nodes/")).toEqual([]);
    await user.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    await screen.findByRole("table", { name: "Latest sensor values at NODE-A" }, { timeout: 5000 });
    expect(calledWith("/api/officer/nodes/")).toContain("/api/officer/nodes/NODE-A/latest");
  });

  it("hotspot request failing shows the server's message", async () => {
    localStorage.setItem("sanjeevni_officer_hotspots", "30d");
    API["/api/officer/heatmap"] = undefined;
    delete API["/api/officer/heatmap"];
    render(<Providers><OfficerPage /></Providers>);
    // after the one retry Providers allows
    expect(await screen.findByText("Hotspots unavailable: not found", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Last 30 days" })).toBeChecked();
    API["/api/officer/heatmap"] = HEATMAP;
  });
});
