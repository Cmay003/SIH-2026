// Automated accessibility checks (axe-core, WCAG 2.x A/AA rules) on every
// page, rendered with realistic data. Colour contrast is skipped here
// because jsdom can't compute layout/colours - checked separately in a
// real browser. Automated checks find ~30-50% of issues; keyboard and
// screen-reader passes are still needed by a person.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import { AdminPage } from "../pages/AdminPage";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { OfficerPage } from "../pages/OfficerPage";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";
import { MODEL_CARD } from "./fixtures/modelCard";

// jsdom has no Web Audio. Simulate the usual state of a real browser on page
// load instead: audio supported but still locked until the first click, so
// the alarm dialog shows its "Enable alarm sound" button and the header
// toggle is a real button - both get checked below.
vi.mock("../lib/siren", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/siren")>()),
  siren: {
    isSupported: () => true,
    isUnlocked: () => false,
    unlock: async () => false,
    start: () => {},
    stop: () => {},
    subscribe: () => () => {},
  },
}));

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
    responder_route_url: "https://maps.example/r", location_source: "manual", // "Set by hand" badge + note
    hospital_skipped: { hospital: "Riverside Clinic", distance_km: 0.4, hazard_type: "flood", severity: "HIGH" } }] },
  "/api/node-health": { generated_at: "", summary: { online: 2, offline: 1, never_seen: 0 }, nodes_with_issues: 1,
    nodes: [{ node_id: "NODE-INDB", location: "Industrial Zone B", latitude: 29.385, longitude: 79.448, status: "offline",
      level: "critical", last_seen: null, seconds_since_seen: 420, expected_interval_seconds: 60, battery_pct: 61,
      signal_strength_dbm: -104, link: "lora", issues: [{ level: "critical", type: "missing", message: "No report for 7 min" }] }] },
  "/api/admin/nodes": { nodes: { "NODE-04": { location: "Sector 4", land_use: "urban_low", curve_number: 78,
    latitude: 29.3919, longitude: 79.4542, upstream_node: null, report_interval_seconds: null } } },
  "/api/admin/model-card": MODEL_CARD,
  "/api/nearest-hospital": { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/x",
    skipped_hospital: { hospital: "Riverside Clinic", distance_km: 0.4, hazard_type: "flood", severity: "HIGH" } },
};

beforeEach(() => {
  sessionStorage.clear(); // no remembered alarm acknowledgements between tests
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

async function violations(container: HTMLElement | Document) {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: {
      "color-contrast": { enabled: false }, // needs a real browser (checked separately)
      region: { enabled: false }, // fragment render: page landmarks are checked per page below
    },
  });
  return result.violations.map((v) => `${v.id}: ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`);
}

// axe on a full page is slow on a cold or loaded machine: allow more than the 5 s default
describe("accessibility (axe)", { timeout: 20_000 }, () => {
  it("login page", async () => {
    const { container } = render(<LoginPage />);
    expect(await violations(container)).toEqual([]);
  });

  it("dashboard", async () => {
    const { container } = render(<Providers><DashboardPage /></Providers>);
    // The hospital appears after two chained requests (hazards, then route):
    // under a full parallel run that took over findBy's 1 s default.
    await screen.findByText("District Hospital", {}, { timeout: 5000 });
    expect(await violations(container)).toEqual([]);
  });

  it("dashboard emergency alarm dialog (HIGH hazard)", async () => {
    render(<Providers><DashboardPage /></Providers>);
    const dialog = await screen.findByRole("alertdialog", { name: "Emergency alert" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/Flood: HIGH risk at Sector 4 \(NODE-04\)/);
    expect(within(dialog).getByRole("button", { name: "Acknowledge" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: /Enable alarm sound/ })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Show Flood at Sector 4 (NODE-04)" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Click to enable sound/ })).toBeInTheDocument(); // header toggle
    await screen.findByText("District Hospital", {}, { timeout: 5000 });
    // the dialog on its own, then the whole page with the dialog open on top
    expect(await violations(dialog)).toEqual([]);
    document.documentElement.lang = "en"; // as in index.html (jsdom's blank document has none)
    try {
      expect(await violations(document)).toEqual([]);
    } finally {
      document.documentElement.removeAttribute("lang");
    }
  });

  it("officer page emergency alarm dialog (confirmed HIGH zone)", async () => {
    render(<Providers><OfficerPage /></Providers>);
    const dialog = await screen.findByRole("alertdialog", { name: "Emergency alert" });
    expect(within(dialog).getByRole("button", { name: "Acknowledge" })).toHaveFocus();
    expect(within(dialog).getByRole("button", { name: "Show Flood at NODE-04" })).toBeInTheDocument();
    await screen.findByText("No report for 7 min");
    expect(await violations(dialog)).toEqual([]);
  });

  it("officer page (panel + map)", async () => {
    const { container } = render(<Providers><OfficerPage /></Providers>);
    await screen.findByText("No report for 7 min");
    await screen.findByText("Set by hand"); // hand-placed SOS badge in the queue
    expect(await violations(container)).toEqual([]);
  });

  it("admin page (node table + open editor with errors)", async () => {
    const { container } = render(<Providers><AdminPage /></Providers>);
    await userEvent.click(await screen.findByRole("button", { name: "+ Add node" }));
    await userEvent.click(screen.getByRole("button", { name: "Add node" })); // empty form -> field errors
    await screen.findByText(/1-12 characters/);
    expect(await violations(container)).toEqual([]);
  });

  it("admin page model card (banner, metric tables, calibration and confusion matrices open)", async () => {
    const { container } = render(<Providers><AdminPage /></Providers>);
    await screen.findByText(/NOT evidence of accuracy on real floods/);
    expect(await violations(container)).toEqual([]);
    for (const summary of screen.getAllByText("Calibration and confusion matrices")) await userEvent.click(summary);
    await screen.findByRole("table", { name: /MEDIUM and above/ });
    expect(await violations(container)).toEqual([]);
  });

  it("citizen SOS page", async () => {
    const { container } = render(<Providers><SosPage /></Providers>);
    await screen.findByText("HIGH RISK");
    await screen.findByText("Move to higher ground immediately."); // hazard advice list
    await screen.findByText(/Riverside Clinic \(0\.4 km\) is closer/); // skipped-hospital note
    expect(await violations(container)).toEqual([]);
  });

  it("citizen SOS page in Hindi (advice list)", async () => {
    const { container } = render(<Providers><SosPage /></Providers>);
    await screen.findByText("HIGH RISK");
    await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
    await screen.findByText("तुरंत ऊँचे स्थान पर जाएँ।");
    expect(await violations(container)).toEqual([]);
  });

  it("citizen SOS page: location denied, map picker open with a field error, then a point set", async () => {
    vi.stubGlobal("navigator", { ...navigator, geolocation: {
      getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) =>
        err({ code: 1, message: "User denied Geolocation" } as GeolocationPositionError),
    } });
    localStorage.removeItem("sanjeevni_lang"); // the Hindi test above leaves it set
    const { container } = render(<Providers><SosPage /></Providers>);
    const offer = await screen.findByRole("button", { name: "Set my location on a map" });
    expect(await violations(container)).toEqual([]); // offer button state
    await userEvent.click(offer);
    const region = await screen.findByRole("region", { name: /Map for setting your location/ });
    await vi.waitFor(() => expect(region.querySelector(".leaflet-container")).not.toBeNull(), { timeout: 5000 });
    await userEvent.click(screen.getByRole("button", { name: "Use these coordinates" })); // empty -> error
    await screen.findByText(/latitude between -90 and 90/);
    expect(await violations(container)).toEqual([]);

    await userEvent.type(screen.getByLabelText("Latitude"), "29.3929");
    await userEvent.type(screen.getByLabelText("Longitude"), "79.4542");
    await userEvent.click(screen.getByRole("button", { name: "Use these coordinates" }));
    await screen.findByText("HIGH RISK");
    expect(await violations(container)).toEqual([]);
  });
});
