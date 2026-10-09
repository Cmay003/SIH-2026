// "Set my location on a map" (upgrade sos-manual-location): when the
// device location is denied, unavailable or slow, the citizen can place
// their SOS point by hand; it is sent as location_source "manual" and the
// officer views mark it as approximate. A device fix always wins.
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import L from "leaflet";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone } from "../api/types";
import { manualLocationNote } from "../lib/hazards";
import { OfficerPage } from "../pages/OfficerPage";
import { parseTypedCoords, SLOW_LOCATE_MS, SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82,
  latitude: 29.3919, longitude: 79.4542, radius_m: 1000, confirmed: true, ...over,
});
/** inside zone() (about 110 m from its centre) */
const IN_ZONE = { latitude: 29.3929, longitude: 79.4542 };
const HOSPITAL = { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" };

// Every Leaflet map the page creates, so a test can "tap" it - jsdom has
// no layout, so a real click can't be turned into a map position.
const maps: L.Map[] = [];
L.Map.addInitHook(function (this: L.Map) {
  maps.push(this);
});

type Answer = { coords: { latitude: number; longitude: number } } | { code: number; message: string } | "never";
/** getCurrentPosition answers from this list in order; the last answer repeats. "never" = no answer (slow GPS). */
function scriptedGeolocation(answers: Answer[]) {
  const calls: PositionOptions[] = [];
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: {
      getCurrentPosition: (ok: PositionCallback, err: PositionErrorCallback, options: PositionOptions) => {
        const answer = answers[Math.min(calls.length, answers.length - 1)];
        calls.push(options);
        if (answer === "never") return;
        if ("coords" in answer) ok({ coords: answer.coords } as GeolocationPosition);
        else err(answer as GeolocationPositionError);
      },
    },
  });
  return calls;
}
const DENIED: Answer = { code: 1, message: "User denied Geolocation" };

/** SOS page routes; returns the POST /api/sos bodies */
function sosRoutes(zones: HazardZone[] = [zone()]) {
  const posted: Record<string, unknown>[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).split("?")[0];
    if (path.startsWith("/api/sos/device/")) {
      return json(200, posted.length ? { active: true, sos_id: 7, ...HOSPITAL } : { active: false });
    }
    if (path === "/api/status") return json(200, { ok: true });
    if (path === "/api/hazard-zones") return json(200, { success: true, zones });
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

/** Opens the picker and waits for the lazily loaded map */
async function openPicker() {
  await userEvent.click(await screen.findByRole("button", { name: "Set my location on a map" }));
  const region = await screen.findByRole("region", { name: /Map for setting your location/ });
  await waitFor(() => expect(region.querySelector(".leaflet-container")).not.toBeNull(), { timeout: 5000 });
  return maps[maps.length - 1];
}

const tapMap = (map: L.Map, p: { latitude: number; longitude: number }) =>
  act(() => {
    map.fire("click", { latlng: L.latLng(p.latitude, p.longitude) });
  });

beforeEach(() => {
  maps.length = 0;
  setUnauthorizedHandler(vi.fn());
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("SOS page: set my location on a map", () => {
  it("location denied -> tap a point in a HIGH zone -> HIGH risk, and the SOS is sent as 'manual'", async () => {
    const calls = scriptedGeolocation([DENIED]);
    const posted = sosRoutes();
    renderSos();
    const sos = await screen.findByRole("button", { name: "SOS" });
    expect(sos).toBeDisabled();

    const map = await openPicker();
    // focus moves to the picker (the offer button it replaced is gone)
    expect(screen.getByRole("heading", { name: "Set your location on the map" })).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Set my location on a map" })).not.toBeInTheDocument();

    await tapMap(map, IN_ZONE);
    expect(await screen.findByText("HIGH RISK")).toBeInTheDocument();
    expect(screen.getByText(/Location set by hand on the map \(29\.3929, 79\.4542\)/)).toBeInTheDocument();
    expect(screen.getByLabelText("Latitude")).toHaveValue("29.39290"); // the fields follow the tap
    expect(await screen.findByText("District Hospital")).toBeInTheDocument(); // hospital for the chosen point
    await waitFor(() => expect(sos).toBeEnabled());

    await userEvent.click(sos);
    expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ ...IN_ZONE, location_source: "manual" });
    expect(screen.getByText(/The point you set on the map \(29\.3929, 79\.4542\)\s+was sent/)).toBeInTheDocument();
    expect(screen.queryByText(/location found earlier/)).not.toBeInTheDocument();
    // one short device try before sending, not the full precise + coarse wait
    expect(calls.slice(1)).toEqual([expect.objectContaining({ timeout: 5000 })]);
  });

  it("a device fix at send time wins over the hand-placed point", async () => {
    const device = { latitude: 29.4, longitude: 79.46 };
    scriptedGeolocation([DENIED, { coords: device }]);
    const posted = sosRoutes();
    renderSos();
    await tapMap(await openPicker(), IN_ZONE);
    const sos = screen.getByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    await userEvent.click(sos);

    expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
    expect(posted[0]).toMatchObject({ ...device, location_source: "gps" });
    expect(screen.getByText(/It was sent instead of the point you set on the map/)).toBeInTheDocument();
    expect(screen.queryByText(/The point you set on the map \(/)).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /Map for setting your location/ })).not.toBeInTheDocument();
  });

  it("'Get My Location' succeeding later replaces the point and closes the picker", async () => {
    const device = { latitude: 29.6, longitude: 79.8 };
    scriptedGeolocation([DENIED, { coords: device }]);
    sosRoutes();
    renderSos();
    await tapMap(await openPicker(), IN_ZONE);
    expect(await screen.findByText("HIGH RISK")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Get My Location" }));
    expect(await screen.findByText(/It replaces the point you set on the map/)).toBeInTheDocument();
    expect(await screen.findByText("LOW RISK")).toBeInTheDocument(); // the device position is outside the zone
    expect(screen.queryByRole("heading", { name: "Set your location on the map" })).not.toBeInTheDocument();
  });

  it("a failed retry keeps the hand-placed point", async () => {
    scriptedGeolocation([DENIED]);
    sosRoutes();
    renderSos();
    await tapMap(await openPicker(), IN_ZONE);
    await userEvent.click(screen.getByRole("button", { name: "Get My Location" }));
    expect(await screen.findByText(/The point you set on the map is still used/)).toBeInTheDocument();
    expect(screen.getByText("HIGH RISK")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SOS" })).toBeEnabled();
  });

  it("typed coordinates work without the map, and bad ones are refused", async () => {
    scriptedGeolocation([{ code: 2, message: "Position unavailable" }]);
    const posted = sosRoutes();
    renderSos();
    await openPicker();
    const lat = screen.getByLabelText("Latitude");
    const lon = screen.getByLabelText("Longitude");

    await userEvent.type(lat, "95");
    await userEvent.type(lon, "79.45");
    await userEvent.click(screen.getByRole("button", { name: "Use these coordinates" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/latitude between -90 and 90/);
    expect(lat).toHaveAttribute("aria-invalid", "true");
    expect(lat).toHaveAccessibleDescription(/latitude between -90 and 90/);
    expect(screen.getByRole("button", { name: "SOS" })).toBeDisabled();

    await userEvent.clear(lat);
    await userEvent.type(lat, "29,3929"); // comma decimal from a phone keyboard
    await userEvent.click(screen.getByRole("button", { name: "Use these coordinates" }));
    expect(await screen.findByText("HIGH RISK")).toBeInTheDocument();
    expect(lat).not.toHaveAttribute("aria-invalid");
    await userEvent.click(screen.getByRole("button", { name: "SOS" }));
    await screen.findByText("Help is on the way");
    expect(posted[0]).toMatchObject({ latitude: 29.3929, longitude: 79.45, location_source: "manual" });
  });

  it("is not offered while a device fix works", async () => {
    const calls = scriptedGeolocation([{ coords: IN_ZONE }]);
    const posted = sosRoutes();
    renderSos();
    const sos = await screen.findByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Set my location on a map" })).not.toBeInTheDocument();
    await userEvent.click(sos);
    await screen.findByText("Help is on the way");
    expect(posted[0]).toMatchObject({ ...IN_ZONE, location_source: "gps" });
    expect(calls[1]).toMatchObject({ timeout: 15000 }); // the normal precise fix, unchanged
  });

  it("is offered when the location is slow, not only after it fails", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    scriptedGeolocation(["never"]);
    sosRoutes();
    renderSos();
    await screen.findByText("Detecting your location automatically...");
    await act(() => vi.advanceTimersByTimeAsync(SLOW_LOCATE_MS - 1000));
    expect(screen.queryByRole("button", { name: "Set my location on a map" })).not.toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(1500));
    expect(screen.getByRole("button", { name: "Set my location on a map" })).toBeInTheDocument();
  });

  it("shows the picker in Hindi", async () => {
    scriptedGeolocation([DENIED]);
    sosRoutes();
    renderSos();
    await screen.findByRole("button", { name: "Set my location on a map" });
    await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
    await userEvent.click(screen.getByRole("button", { name: "मानचित्र पर अपना स्थान चुनें" }));
    expect(await screen.findByLabelText("अक्षांश (Latitude)")).toBeInTheDocument();
  });
});

describe("parseTypedCoords", () => {
  it("accepts real positions only", () => {
    expect(parseTypedCoords("29.39", "79.45")).toEqual({ latitude: 29.39, longitude: 79.45 });
    expect(parseTypedCoords(" 29,39 ", "79,45")).toEqual({ latitude: 29.39, longitude: 79.45 });
    expect(parseTypedCoords("", "79.45")).toBeNull();
    expect(parseTypedCoords("91", "79.45")).toBeNull();
    expect(parseTypedCoords("29", "181")).toBeNull();
    expect(parseTypedCoords("abc", "79.45")).toBeNull();
    expect(parseTypedCoords("Infinity", "79.45")).toBeNull();
  });
});

describe("officer view of a hand-placed SOS", () => {
  const sosRow = (id: number, location_source: string | null) => ({
    id, latitude: 29.39, longitude: 79.45, location_source, note: null, status: "open",
    timestamp: new Date().toISOString(), escalated: false, minutes_open: 3, nearest_hospital: "H",
    hospital_distance_km: 1, hospital_route_url: "https://maps.example/h", responder_route_url: "https://maps.example/r",
  });

  it("marks only the manual one in the queue and on its map pin", async () => {
    const data = [sosRow(1, "manual"), sosRow(2, "gps"), sosRow(3, null)];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/api/auth/me") return json(200, { user: { username: "o", role: "officer" }, idle_timeout_minutes: 60 });
      if (path === "/api/hazard-zones") return json(200, { success: true, zones: [] });
      if (path === "/api/sos") return json(200, { success: true, count: 3, escalated_count: 0, invalid_location_count: 0, data });
      if (path === "/api/node-health") {
        return json(200, { generated_at: "", summary: { online: 0, offline: 0, never_seen: 0 }, nodes_with_issues: 0, nodes: [] });
      }
      return json(404, {});
    });
    const { container } = render(<Providers><OfficerPage /></Providers>);
    const queue = await screen.findByRole("list", { name: "SOS queue" });
    const cards = within(queue).getAllByRole("listitem");
    const card = (id: number) => cards.find((c) => within(c).queryByText(`SOS #${id}`))!;
    expect(within(card(1)).getByText("Set by hand")).toBeInTheDocument();
    expect(within(card(1)).getByText(/approximate, confirm it when you reach them/)).toBeInTheDocument();
    expect(within(card(2)).queryByText("Set by hand")).not.toBeInTheDocument();
    expect(within(card(3)).queryByText("Set by hand")).not.toBeInTheDocument();

    await waitFor(() => expect(container.querySelector('[title^="SOS #1,"]')).not.toBeNull());
    expect(container.querySelector('[title^="SOS #1,"]')!.getAttribute("title")).toMatch(/location set by hand \(approximate\)/);
    expect(container.querySelector('[title^="SOS #2,"]')!.getAttribute("title")).not.toMatch(/set by hand/);
  });

  it("manualLocationNote says nothing for a device or unknown location", () => {
    expect(manualLocationNote({ location_source: "manual" })).toMatch(/set by hand/);
    expect(manualLocationNote({ location_source: "gps" })).toBeNull();
    expect(manualLocationNote({ location_source: "whatsapp" })).toBeNull();
    expect(manualLocationNote({ location_source: null })).toBeNull();
    expect(manualLocationNote({})).toBeNull();
  });
});
