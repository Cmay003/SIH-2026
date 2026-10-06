import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone } from "../api/types";
import { evaluateArea, sosGate } from "../lib/sos";
import { OfficerPage } from "../pages/OfficerPage";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function routeFetch(routes: Record<string, (init?: RequestInit) => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).split("?")[0];
    const handler = routes[path];
    return handler ? handler(init) : json(404, { error: `no mock for ${path}` });
  });
}

const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82,
  latitude: 29.3919, longitude: 79.4542, radius_m: 1000, confirmed: true, ...over,
});

beforeEach(() => setUnauthorizedHandler(vi.fn()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SOS decision logic", () => {
  const here = { latitude: 29.3919, longitude: 79.4542 };

  it("picks the most severe zone the user is inside, ignores zones they're outside", () => {
    const zones = [
      zone({ severity: "MEDIUM", risk_score: 0.5 }),
      zone({ node_id: "B", severity: "CRITICAL", risk_score: 0.95, radius_m: 2000 }),
      zone({ node_id: "FAR", severity: "CRITICAL", latitude: 28.6, longitude: 77.2 }),
    ];
    expect(evaluateArea(here, zones)).toMatchObject({ severity: "CRITICAL", score: 95 });
    expect(evaluateArea({ latitude: 29.5, longitude: 79.6 }, zones)).toMatchObject({ severity: "LOW", score: 0 });
    expect(evaluateArea(null, zones).severity).toBe("LOW");
  });

  it("allows SOS anywhere once the location is known (risk only changes the hint)", () => {
    const base = { sending: false, deviceActive: false, hasLocation: true, severity: "HIGH" as const };
    expect(sosGate(base)).toEqual({ enabled: true, hint: "highRisk" });
    expect(sosGate({ ...base, severity: "MEDIUM" })).toEqual({ enabled: true, hint: "available" });
    expect(sosGate({ ...base, severity: "LOW" })).toEqual({ enabled: true, hint: "available" });
    expect(sosGate({ ...base, hasLocation: false })).toEqual({ enabled: false, hint: "locating" });
    expect(sosGate({ ...base, hasLocation: false, locationFailed: true })).toEqual({ enabled: false, hint: "needLocation" });
    expect(sosGate({ ...base, deviceActive: true })).toEqual({ enabled: false, hint: "active" });
    expect(sosGate({ ...base, sending: true })).toEqual({ enabled: false, hint: "sending" });
  });
});

function mockGeolocation(coords = { latitude: 29.3919, longitude: 79.4542 }) {
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: {
      getCurrentPosition: (ok: PositionCallback) => ok({ coords } as GeolocationPosition),
    },
  });
}

const renderSos = () => render(<Providers><SosPage /></Providers>);

describe("Citizen SOS page", () => {
  it("unlocks SOS inside a HIGH zone, sends once, and shows the hospital", async () => {
    mockGeolocation();
    let posted: Record<string, unknown> | null = null;
    let active = false;
    routeFetch({
      "/api/status": () => json(200, { ok: true }),
      "/api/hazard-zones": () => json(200, { success: true, zones: [zone()] }),
      "/api/nearest-hospital": () => json(200, { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" }),
      "/api/sos": (init) => {
        posted = JSON.parse(String(init?.body));
        active = true;
        return json(201, { status: "received", sos_id: 7, hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" });
      },
    });
    // device-status route depends on the generated id - match it generically
    const fetchSpy = vi.mocked(globalThis.fetch);
    const original = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation(async (input, init) =>
      String(input).startsWith("/api/sos/device/")
        ? json(200, active ? { active: true, sos_id: 7, hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" } : { active: false })
        : original(input, init));

    renderSos();
    const sos = await screen.findByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    expect(screen.getByText("HIGH RISK")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText(/describe your situation/), "2 people on the roof");
    await userEvent.click(sos);

    expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
    expect(posted).toMatchObject({ latitude: 29.3919, longitude: 79.4542, note: "2 people on the roof" });
    expect(String(posted!.device_id)).toMatch(/^dev-/);
    await waitFor(() => expect(screen.getByRole("button", { name: "SOS" })).toBeDisabled()); // one SOS per device
  });

  it("allows SOS outside any hazard zone (emergencies no sensor detected)", async () => {
    mockGeolocation({ latitude: 29.6, longitude: 79.8 });
    routeFetch({
      "/api/status": () => json(200, { ok: true }),
      "/api/hazard-zones": () => json(200, { success: true, zones: [zone()] }),
      "/api/nearest-hospital": () => json(200, { hospital: "H", distance_km: 9, maps_url: "https://maps.example/b" }),
    });
    vi.mocked(globalThis.fetch).mockImplementationOnce(async () => json(200, { ok: true }));
    renderSos();
    expect(await screen.findByText("LOW RISK")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "SOS" })).toBeEnabled());
    expect(await screen.findByText(/Tap SOS if you need emergency help/)).toBeInTheDocument();
  });

  it("switches to Hindi and remembers the choice", async () => {
    mockGeolocation();
    routeFetch({ "/api/status": () => json(200, { ok: true }), "/api/hazard-zones": () => json(200, { success: true, zones: [] }) });
    renderSos();
    await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
    expect(screen.getByText("अपने क्षेत्र की सुरक्षा जांचें")).toBeInTheDocument();
    expect(localStorage.getItem("sanjeevni_lang")).toBe("hi");
  });
});

describe("Officer page", () => {
  it("shows SOS count, escalations and node problems - hostile text stays text", async () => {
    const hostile = '<img src=x onerror="window.__xss=1">';
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 }),
      "/api/hazard-zones": () => json(200, { success: true, zones: [zone({ confirmed: false })] }),
      "/api/sos": () => json(200, { success: true, count: 2, escalated_count: 1, data: [] }),
      "/api/node-health": () => json(200, {
        generated_at: "", summary: { online: 2, offline: 1, never_seen: 0 }, nodes_with_issues: 1,
        nodes: [{ node_id: "NODE-INDB", location: hostile, latitude: null, longitude: null, status: "offline", level: "critical",
                  last_seen: null, seconds_since_seen: 420, expected_interval_seconds: 60, battery_pct: 50,
                  signal_strength_dbm: -70, link: "lora",
                  issues: [{ level: "critical", type: "missing", message: "No report for 7 min (expected every 60s)" }] }],
      }),
    });
    const { container } = render(<Providers><OfficerPage /></Providers>);
    expect(await screen.findByText("2 online, 1 offline", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("1 escalated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve all" })).toBeInTheDocument();
    expect(screen.getByText("No report for 7 min (expected every 60s)")).toBeInTheDocument();
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(await screen.findByText("officer1")).toBeInTheDocument();
  });

  it("shows the all-clear when there are no open SOS requests", async () => {
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: "o", role: "officer" }, idle_timeout_minutes: 60 }),
      "/api/hazard-zones": () => json(200, { success: true, zones: [] }),
      "/api/sos": () => json(200, { success: true, count: 0, escalated_count: 0, data: [] }),
      "/api/node-health": () => json(200, { generated_at: "", summary: { online: 3, offline: 0, never_seen: 0 }, nodes_with_issues: 0, nodes: [] }),
    });
    render(<Providers><OfficerPage /></Providers>);
    expect(await screen.findByText(/All SOS requests resolved/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Resolve all" })).toBeNull();
    expect(await screen.findByText("All nodes reporting normally")).toBeInTheDocument();
  });
});
