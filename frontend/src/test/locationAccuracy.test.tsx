// Location accuracy (devices without GPS) and the sensor-node SOS button.
// A phone or laptop without GPS still returns a position - from Wi-Fi, cell
// towers or the IP address - that can be kilometres off. The SOS page sends
// coords.accuracy as location_accuracy_m, says when the fix is approximate
// and offers the map, but never holds the SOS back; the officer views show
// the accuracy, warn above APPROX_LOCATION_M and label node-button SOS.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone, SosRequest, UnlocatedNodeSos } from "../api/types";
import { approximateLocationNote, nodeButtonNote, sosAccuracyText } from "../lib/hazards";
import { accuracyOrNull, APPROX_LOCATION_M, formatAccuracy, isApproximateFix } from "../lib/sos";
import { OfficerPage } from "../pages/OfficerPage";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82,
  latitude: 29.3919, longitude: 79.4542, radius_m: 1000, confirmed: true, ...over,
});
const IN_ZONE = { latitude: 29.3929, longitude: 79.4542 };
const HOSPITAL = { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" };
/** what a laptop without GPS typically gets: a Wi-Fi / IP position */
const COARSE = { latitude: 29.41, longitude: 79.47, accuracy: 2300 };
const PRECISE = { latitude: 29.4, longitude: 79.46, accuracy: 35 };

const maps: L.Map[] = [];
L.Map.addInitHook(function (this: L.Map) {
  maps.push(this);
});

type Fix = { latitude: number; longitude: number; accuracy: number };
/** getCurrentPosition answers from this list in order; the last answer repeats */
function scriptedGeolocation(answers: Fix[]) {
  const calls: PositionOptions[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: {
      getCurrentPosition: (ok: PositionCallback, _err: PositionErrorCallback, options: PositionOptions) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        calls.push(options);
        ok({ coords: answer } as unknown as GeolocationPosition);
      },
    },
  });
  return calls;
}

/** SOS page routes; returns the POST /api/sos bodies */
function sosRoutes() {
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).split("?")[0];
    if (path.startsWith("/api/sos/device/")) {
      return json(200, posted.length ? { active: true, sos_id: 7, ...HOSPITAL } : { active: false });
    }
    if (path === "/api/status") return json(200, { ok: true });
    if (path === "/api/hazard-zones") return json(200, { success: true, zones: [zone()] });
    if (path === "/api/nearest-hospital") return json(200, HOSPITAL);
    if (path === "/api/sos") {
      posted.push(JSON.parse(String(init?.body)));
      return json(201, { status: "received", sos_id: 7, ...HOSPITAL });
    }
    return json(404, { error: `no mock for ${path}` });
  });
  return posted;
}

const renderSos = () => render(<Providers><SosPage /></Providers>);
const APPROX_TEXT = /Your location is approximate \(about ±2\.3 km\)\. If you can, check it or set your location on the map\./;

beforeEach(() => {
  maps.length = 0;
  setUnauthorizedHandler(vi.fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SOS page: location accuracy", () => {
  it("sends location_accuracy_m with a device fix, and no notice for a precise one", async () => {
    scriptedGeolocation([PRECISE]);
    const posted = sosRoutes();
    renderSos();
    const sos = await screen.findByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    expect(screen.queryByText(/Your location is approximate/)).not.toBeInTheDocument();
    await userEvent.click(sos);
    await screen.findByText("Help is on the way");
    expect(posted[0]).toEqual({
      latitude: PRECISE.latitude, longitude: PRECISE.longitude, note: "", device_id: expect.any(String),
      location_source: "gps", location_accuracy_m: 35,
    });
  });

  it("an approximate fix (> 500 m) shows the notice, and SOS still works right away", async () => {
    scriptedGeolocation([COARSE]);
    const posted = sosRoutes();
    renderSos();
    expect(await screen.findByText(APPROX_TEXT)).toBeInTheDocument();
    const sos = screen.getByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled()); // never blocked by the accuracy
    await userEvent.click(sos);
    await screen.findByText("Help is on the way");
    expect(posted[0]).toMatchObject({ latitude: COARSE.latitude, location_source: "gps", location_accuracy_m: 2300 });
  });

  it("the notice's button opens the manual map; a point set there is sent instead of the coarse fix", async () => {
    const calls = scriptedGeolocation([COARSE]);
    const posted = sosRoutes();
    renderSos();
    await screen.findByText(APPROX_TEXT);
    await userEvent.click(screen.getByRole("button", { name: "Check / set my location on the map" }));
    expect(screen.getByRole("heading", { name: "Set your location on the map" })).toHaveFocus();
    const region = screen.getByRole("region", { name: /Map for setting your location/ });
    await waitFor(() => expect(region.querySelector(".leaflet-container")).not.toBeNull(), { timeout: 5000 });
    expect(screen.queryByText(/Your location is approximate/)).not.toBeInTheDocument();

    await act(() => {
      maps[maps.length - 1].fire("click", { latlng: L.latLng(IN_ZONE.latitude, IN_ZONE.longitude) });
    });
    expect(await screen.findByText("HIGH RISK")).toBeInTheDocument();
    const sos = screen.getByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    await userEvent.click(sos);
    await screen.findByText("Help is on the way");
    // the device was asked again at send time, but its fix is still ±2.3 km:
    // it must not replace the point the person set because of exactly that
    expect(calls.length).toBe(2);
    expect(posted[0]).toMatchObject({ ...IN_ZONE, location_source: "manual", location_accuracy_m: null });
    expect(screen.getByText(/The point you set on the map \(29\.3929, 79\.4542\)\s+was sent/)).toBeInTheDocument();
  });

  it("'Get My Location' with only a coarse fix keeps the hand-set point", async () => {
    scriptedGeolocation([COARSE]);
    sosRoutes();
    renderSos();
    await screen.findByText(APPROX_TEXT);
    await userEvent.click(screen.getByRole("button", { name: "Check / set my location on the map" }));
    await waitFor(() => expect(maps.length).toBeGreaterThan(0), { timeout: 5000 });
    await act(() => {
      maps[maps.length - 1].fire("click", { latlng: L.latLng(IN_ZONE.latitude, IN_ZONE.longitude) });
    });
    await userEvent.click(screen.getByRole("button", { name: "Get My Location" }));
    expect(await screen.findByText(/only approximate \(±2\.3 km\), so the point you set on the map is still used/))
      .toBeInTheDocument();
    expect(screen.getByText("HIGH RISK")).toBeInTheDocument(); // still the hand-set point (inside the zone)
  });

  it("shows the notice in Hindi", async () => {
    scriptedGeolocation([COARSE]);
    sosRoutes();
    renderSos();
    await screen.findByText(APPROX_TEXT);
    await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
    expect(screen.getByText(/आपकी लोकेशन अनुमानित है \(लगभग ±2\.3 km\)/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "मानचित्र पर अपना स्थान जाँचें / चुनें" })).toBeInTheDocument();
  });
});

describe("accuracy helpers", () => {
  it("formats and classifies accuracies", () => {
    expect(APPROX_LOCATION_M).toBe(500);
    expect(formatAccuracy(35.4)).toBe("±35 m");
    expect(formatAccuracy(999)).toBe("±999 m");
    expect(formatAccuracy(2300)).toBe("±2.3 km");
    expect(formatAccuracy(15400)).toBe("±15 km");
    expect(isApproximateFix(500)).toBe(false);
    expect(isApproximateFix(501)).toBe(true);
    expect(isApproximateFix(null)).toBe(false);
    expect(accuracyOrNull(12)).toBe(12);
    expect(accuracyOrNull(Number.NaN)).toBeNull();
    expect(accuracyOrNull(-1)).toBeNull();
    expect(accuracyOrNull(undefined)).toBeNull();
  });

  it("officer notes: approximate only for a device fix, node label only for node SOS", () => {
    expect(approximateLocationNote({ location_source: "gps", location_accuracy_m: 2300 }))
      .toBe("Approximate location (±2.3 km) - confirm with the caller");
    expect(approximateLocationNote({ location_source: "gps", location_accuracy_m: 35 })).toBeNull();
    expect(approximateLocationNote({ location_source: null, location_accuracy_m: null })).toBeNull();
    expect(approximateLocationNote({ location_source: "node", location_accuracy_m: 9000 })).toBeNull();
    expect(nodeButtonNote({ location_source: "node", node_id: "NODE-07" }))
      .toBe("SOS button on node NODE-07 - location is the node's position");
    expect(nodeButtonNote({ location_source: "gps" })).toBeNull();
    expect(sosAccuracyText({ location_accuracy_m: 35 })).toBe("±35 m");
    expect(sosAccuracyText({ location_accuracy_m: null })).toBeNull();
  });
});

describe("officer view: accuracy and node-button SOS", () => {
  const sosRow = (id: number, over: Partial<SosRequest>): SosRequest => ({
    id, latitude: 29.39, longitude: 79.45, location_source: "gps", location_accuracy_m: null, node_id: null,
    note: null, status: "open", timestamp: new Date().toISOString(), escalated: false, minutes_open: 3,
    nearest_hospital: "H", hospital_distance_km: 1, hospital_route_url: "https://maps.example/h",
    responder_route_url: "https://maps.example/r", ...over,
  });

  function officerRoutes(data: SosRequest[], unlocated: UnlocatedNodeSos[] = []) {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/api/auth/me") return json(200, { user: { username: "o", role: "officer" }, idle_timeout_minutes: 60 });
      if (path === "/api/hazard-zones") return json(200, { success: true, zones: [] });
      if (path === "/api/sos") {
        return json(200, { success: true, count: data.length, escalated_count: 0,
          invalid_location_count: unlocated.length, unlocated_node_sos: unlocated, data });
      }
      if (path === "/api/node-health") {
        return json(200, { generated_at: "", summary: { online: 0, offline: 0, never_seen: 0 }, nodes_with_issues: 0, nodes: [] });
      }
      return json(404, {});
    });
  }

  it("shows ±accuracy, the approximate warning and the node-button label", async () => {
    officerRoutes([
      sosRow(1, { location_accuracy_m: 35 }),
      sosRow(2, { location_accuracy_m: 2300 }),
      sosRow(3, { location_source: "node", node_id: "NODE-07", note: "SOS button pressed on sensor node NODE-07 (Bridge)" }),
      sosRow(4, { location_source: "manual" }),
    ]);
    const { container } = render(<Providers><OfficerPage /></Providers>);
    const queue = await screen.findByRole("list", { name: "SOS queue" });
    const cards = within(queue).getAllByRole("listitem");
    const card = (id: number) => cards.find((c) => within(c).queryByText(`SOS #${id}`))!;

    expect(within(card(1)).getByText("±35 m")).toBeInTheDocument();
    expect(within(card(1)).queryByText("Approximate")).not.toBeInTheDocument();
    expect(within(card(1)).queryByText(/confirm with the caller/)).not.toBeInTheDocument();

    expect(within(card(2)).getByText("±2.3 km")).toBeInTheDocument();
    expect(within(card(2)).getByText("Approximate")).toBeInTheDocument();
    expect(within(card(2)).getByText("Approximate location (±2.3 km) - confirm with the caller")).toBeInTheDocument();

    expect(within(card(3)).getByText("Node button")).toBeInTheDocument();
    expect(within(card(3)).getByText("SOS button on node NODE-07 - location is the node's position")).toBeInTheDocument();
    expect(within(card(3)).queryByText(/approximate|Set by hand/i)).not.toBeInTheDocument();

    expect(within(card(4)).getByText("Set by hand")).toBeInTheDocument(); // unchanged
    expect(within(card(4)).queryByText("Node button")).not.toBeInTheDocument();

    await waitFor(() => expect(container.querySelector('[title^="SOS #3,"]')).not.toBeNull());
    expect(container.querySelector('[title^="SOS #2,"]')!.getAttribute("title")).toMatch(/approximate location \(±2\.3 km\)/);
    expect(container.querySelector('[title^="SOS #3,"]')!.getAttribute("title")).toMatch(/SOS button on node NODE-07/);
    expect(container.querySelector('[title^="SOS #1,"]')!.getAttribute("title")).not.toMatch(/approximate/);
  });

  it("an SOS-button press on a node without a position is shown as an alert, not 'all resolved'", async () => {
    officerRoutes([], [{ id: 9, node_id: "NODE-NOPOS", note: "SOS button pressed on sensor node NODE-NOPOS (NO REGISTERED POSITION)",
      status: "open", timestamp: new Date().toISOString(), minutes_open: 4 }]);
    render(<Providers><OfficerPage /></Providers>);
    const alert = await screen.findByText(/SOS button pressed on a node with no registered position/);
    expect(alert.closest("[role=alert]")).toHaveTextContent(/SOS #9 · NODE-NOPOS/);
    expect(screen.getByRole("button", { name: "Resolve SOS #9" })).toBeInTheDocument();
    expect(screen.queryByText(/All SOS requests resolved/)).not.toBeInTheDocument();
  });

  it("the collapsed panel's header count includes the SOS without a position (no pin, banner hidden)", async () => {
    officerRoutes([sosRow(1, { location_accuracy_m: 35 })], [{ id: 9, node_id: "NODE-NOPOS", note: null,
      status: "open", timestamp: new Date().toISOString(), minutes_open: 4 }]);
    render(<Providers><OfficerPage /></Providers>);
    await screen.findByRole("list", { name: "SOS queue" });
    await userEvent.click(screen.getByRole("button", { name: /^Hide\s*panel$/ }));
    expect(screen.getByText("2 SOS (1 no position)")).toBeInTheDocument();
  });

  it("an unlocated node SOS alone still shows a header count while collapsed", async () => {
    officerRoutes([], [{ id: 9, node_id: "NODE-NOPOS", note: null,
      status: "open", timestamp: new Date().toISOString(), minutes_open: 4 }]);
    render(<Providers><OfficerPage /></Providers>);
    await screen.findByText(/SOS button pressed on a node with no registered position/);
    await userEvent.click(screen.getByRole("button", { name: /^Hide\s*panel$/ }));
    expect(screen.getByText("1 SOS (1 no position)")).toBeInTheDocument();
  });
});
