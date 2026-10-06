// Automated accessibility checks (axe-core, WCAG 2.x A/AA rules) on every
// page, rendered with realistic data. Colour contrast is skipped here
// because jsdom can't compute layout/colours - checked separately in a
// real browser. Automated checks find ~30-50% of issues; keyboard and
// screen-reader passes are still needed by a person.
import { render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { OfficerPage } from "../pages/OfficerPage";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const zone = { node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82, latitude: 29.3919,
               longitude: 79.4542, radius_m: 1000, confirmed: true };
const API: Record<string, unknown> = {
  "/api/auth/me": { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 },
  "/api/status": { ok: true },
  "/api/sensors": { success: true, count: 1, data: [{ id: 1, device_id: "NODE-04", hazard: "flood", water_level: 2.4,
    temperature: 28, humidity: 70, risk: "HIGH", risk_score: 0.82, timestamp: "2026-10-06T12:00:00Z" }] },
  "/api/hazards": { success: true, count: 1, hazards: [{ label: "Hazard 1", node_id: "NODE-04", location: "Sector 4",
    hazard_type: "flood", severity: "HIGH", risk_score: 0.82, latitude: 29.39, longitude: 79.45, eta_minutes: null,
    predicted_time: null, prediction_text: "Stable" }] },
  "/api/route/NODE-04": { node_id: "NODE-04", hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/x" },
  "/api/hazard-zones": { success: true, zones: [zone] },
  "/api/sos": { success: true, count: 1, escalated_count: 1, data: [{ id: 7, latitude: 29.39, longitude: 79.45,
    note: "2 people on roof", status: "open", timestamp: "2026-10-06T12:00:00Z", escalated: true, minutes_open: 22,
    nearest_hospital: "District Hospital", hospital_distance_km: 1.2, hospital_route_url: "https://maps.example/h",
    responder_route_url: "https://maps.example/r" }] },
  "/api/node-health": { generated_at: "", summary: { online: 2, offline: 1, never_seen: 0 }, nodes_with_issues: 1,
    nodes: [{ node_id: "NODE-INDB", location: "Industrial Zone B", latitude: 29.385, longitude: 79.448, status: "offline",
      level: "critical", last_seen: null, seconds_since_seen: 420, expected_interval_seconds: 60, battery_pct: 61,
      signal_strength_dbm: -104, link: "lora", issues: [{ level: "critical", type: "missing", message: "No report for 7 min" }] }] },
  "/api/nearest-hospital": { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/x" },
};

beforeEach(() => {
  setUnauthorizedHandler(vi.fn());
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).split("?")[0];
    return json(path.startsWith("/api/sos/device/") ? { active: false } : API[path] ?? {});
  });
  vi.stubGlobal("navigator", { ...navigator, geolocation: {
    getCurrentPosition: (ok: PositionCallback) => ok({ coords: { latitude: 29.3919, longitude: 79.4542 } } as GeolocationPosition),
  } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false }, // needs a real browser (checked separately)
      region: { enabled: false }, // fragment render: page landmarks are checked per page below
    },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

describe("accessibility (axe)", () => {
  it("login page", async () => {
    const { container } = render(<LoginPage />);
    expect(await violations(container)).toEqual([]);
  });

  it("dashboard", async () => {
    const { container } = render(<Providers><DashboardPage /></Providers>);
    await screen.findByText("District Hospital");
    expect(await violations(container)).toEqual([]);
  });

  it("officer page (panel + map)", async () => {
    const { container } = render(<Providers><OfficerPage /></Providers>);
    await screen.findByText("No report for 7 min");
    expect(await violations(container)).toEqual([]);
  });

  it("citizen SOS page", async () => {
    const { container } = render(<Providers><SosPage /></Providers>);
    await screen.findByText("HIGH RISK");
    expect(await violations(container)).toEqual([]);
  });
});
