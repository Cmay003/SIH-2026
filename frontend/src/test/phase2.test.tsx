import { act, render, screen, waitFor, within } from "@testing-library/react";
import L from "leaflet";
import { useRef } from "react";
import { MapContainer } from "react-leaflet";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone, SosRequest } from "../api/types";
import { FocusOnNode, SosMarkers, sosZIndexOffset, type FocusRequest } from "../components/officerMap";
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

  it("shows UNKNOWN (not 'LOW RISK / 0') while the location is unknown", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) =>
          err({ code: 1, message: "User denied Geolocation" } as GeolocationPositionError),
      },
    });
    routeFetch({
      "/api/status": () => json(200, { ok: true }),
      "/api/hazard-zones": () => json(200, { success: true, zones: [zone({ severity: "CRITICAL" })] }),
    });
    renderSos();
    expect(await screen.findByText("UNKNOWN")).toBeInTheDocument();
    expect(await screen.findByText(/Share your location to check the hazard level/)).toBeInTheDocument();
    expect(screen.queryByText("LOW RISK")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "SOS" })).toBeDisabled();
  });

  // B54: a fresh fix that times out used to cancel the SOS, although a
  // position from moments earlier was already known.
  describe("when the confirming location fix fails", () => {
    const first = { latitude: 29.3919, longitude: 79.4542 };
    /** getCurrentPosition answers from this list in order; the last answer repeats */
    function scriptedGeolocation(answers: ({ coords: typeof first } | { code: number; message: string })[]) {
      const calls: PositionOptions[] = [];
      vi.stubGlobal("navigator", {
        ...navigator,
        geolocation: {
          getCurrentPosition: (ok: PositionCallback, err: PositionErrorCallback, options: PositionOptions) => {
            const answer = answers[Math.min(calls.length, answers.length - 1)];
            calls.push(options);
            if ("coords" in answer) ok({ coords: answer.coords } as GeolocationPosition);
            else err(answer as GeolocationPositionError);
          },
        },
      });
      return calls;
    }
    function sosRoutes() {
      const posted: Record<string, unknown>[] = [];
      routeFetch({
        "/api/status": () => json(200, { ok: true }),
        "/api/hazard-zones": () => json(200, { success: true, zones: [zone()] }),
        "/api/nearest-hospital": () => json(200, { hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" }),
        "/api/sos": (init) => {
          posted.push(JSON.parse(String(init?.body)));
          return json(201, { status: "received", sos_id: 7, hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" });
        },
      });
      const fetchSpy = vi.mocked(globalThis.fetch);
      const original = fetchSpy.getMockImplementation()!;
      fetchSpy.mockImplementation(async (input, init) =>
        String(input).startsWith("/api/sos/device/") ? json(200, { active: posted.length > 0, sos_id: 7,
          hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/a" }) : original(input, init));
      return posted;
    }

    it("sends the SOS with the earlier position when both fresh fixes time out", async () => {
      const calls = scriptedGeolocation([{ coords: first }, { code: 3, message: "Timeout expired" }]);
      const posted = sosRoutes();
      renderSos();
      const sos = await screen.findByRole("button", { name: "SOS" });
      await waitFor(() => expect(sos).toBeEnabled());
      await userEvent.click(sos);

      expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
      expect(posted).toHaveLength(1);
      expect(posted[0]).toMatchObject(first);
      // precise fix, then a quick coarse one, before falling back
      expect(calls.slice(1)).toEqual([
        expect.objectContaining({ enableHighAccuracy: true }),
        expect.objectContaining({ enableHighAccuracy: false, maximumAge: 60_000 }),
      ]);
      expect(screen.getByText(/location found earlier \(29\.3919, 79\.4542\) was sent/)).toBeInTheDocument();
      expect(screen.queryByText(/enable location access/)).not.toBeInTheDocument();
    });

    it("uses the quick coarse fix when only the precise one times out", async () => {
      const moved = { latitude: 29.4, longitude: 79.46 };
      scriptedGeolocation([{ coords: first }, { code: 3, message: "Timeout expired" }, { coords: moved }]);
      const posted = sosRoutes();
      renderSos();
      const sos = await screen.findByRole("button", { name: "SOS" });
      await waitFor(() => expect(sos).toBeEnabled());
      await userEvent.click(sos);

      expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
      expect(posted[0]).toMatchObject(moved);
      expect(screen.queryByText(/location found earlier/)).not.toBeInTheDocument();
    });

    it("does not ask again after a refusal, and still sends with the earlier position", async () => {
      const calls = scriptedGeolocation([{ coords: first }, { code: 1, message: "User denied Geolocation" }]);
      const posted = sosRoutes();
      renderSos();
      const sos = await screen.findByRole("button", { name: "SOS" });
      await waitFor(() => expect(sos).toBeEnabled());
      await userEvent.click(sos);

      expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
      expect(posted[0]).toMatchObject(first);
      expect(calls).toHaveLength(2); // no coarse retry: a refusal won't change
    });
  });

  it("only a refusal asks the user to enable location access", async () => {
    vi.stubGlobal("navigator", {
      ...navigator,
      geolocation: {
        getCurrentPosition: (_ok: PositionCallback, err: PositionErrorCallback) =>
          err({ code: 3, message: "Timeout expired" } as GeolocationPositionError),
      },
    });
    routeFetch({ "/api/status": () => json(200, { ok: true }), "/api/hazard-zones": () => json(200, { success: true, zones: [] }) });
    renderSos();
    await userEvent.click(screen.getByRole("button", { name: "Get My Location" }));
    expect(await screen.findByText(/Could not get location: Timeout expired\. Please try again/)).toBeInTheDocument();
    expect(screen.queryByText(/enable location access/)).not.toBeInTheDocument();
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

const sosRow = (id: number) => ({
  id, device_id: `dev-${id}`, latitude: 29.39, longitude: 79.45, note: null, status: "open",
  timestamp: new Date().toISOString(), escalated: false, minutes_open: 3, nearest_hospital: "H",
  hospital_distance_km: 1, hospital_route_url: "https://maps.example/h", responder_route_url: "https://maps.example/r",
});

/** The officer page's GET routes; `sos` is read on every poll. */
const officerRoutes = (sos: () => ReturnType<typeof sosRow>[], zones: HazardZone[] = []) => ({
  "/api/auth/me": () => json(200, { user: { username: "o", role: "officer" }, idle_timeout_minutes: 60 }),
  "/api/hazard-zones": () => json(200, { success: true, zones }),
  "/api/sos": () => {
    const data = sos();
    return json(200, { success: true, count: data.length, escalated_count: 0, invalid_location_count: 0, data });
  },
  "/api/node-health": () => json(200, { generated_at: "", summary: { online: 1, offline: 0, never_seen: 0 }, nodes_with_issues: 0, nodes: [] }),
});

// The officer page loads auth, zones, SOS and node health and draws the map
// before the first assertion; on a busy PC (Python suite running alongside)
// that passed the 1 s findBy default, so the first wait in each test gets 5 s.
describe("Officer page", { timeout: 30_000 }, () => {
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
    expect(await screen.findByText("2 online, 1 offline", { exact: false }, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByText("1 escalated")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resolve all" })).toBeInTheDocument();
    expect(screen.getByText("No report for 7 min (expected every 60s)")).toBeInTheDocument();
    expect(container.textContent).toContain(hostile);
    expect(container.querySelector("img[src='x']")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(await screen.findByText("officer1")).toBeInTheDocument();
  });

  // B42: "Resolve all" used to POST no body and the server closed every
  // open row - including SOS requests that arrived while the confirm dialog
  // was open and that nobody had seen.
  it("'Resolve all' resolves only the SOS requests on screen when the dialog opened", async () => {
    let open = [sosRow(11), sosRow(12)];
    let resolveBody: unknown = null;
    routeFetch({
      ...officerRoutes(() => open),
      "/api/sos/resolve-all": (init) => {
        resolveBody = JSON.parse(String(init?.body));
        return json(200, { status: "ok", resolved_count: 2 });
      },
    });
    // A citizen sends SOS #13 while the officer reads the confirm dialog
    const confirm = vi.spyOn(window, "confirm").mockImplementation((message) => {
      open = [...open, sosRow(13)];
      expect(String(message)).toMatch(/the 2 SOS requests listed here/);
      return true;
    });
    render(<Providers><OfficerPage /></Providers>);
    await userEvent.click(await screen.findByRole("button", { name: "Resolve all" }, { timeout: 5000 }));
    expect(confirm).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(resolveBody).toEqual({ ids: [11, 12] }));
  });

  it("'Resolve all' sends nothing when the officer cancels", async () => {
    let resolveCalled = false;
    routeFetch({
      ...officerRoutes(() => [sosRow(5)]),
      "/api/sos/resolve-all": () => {
        resolveCalled = true;
        return json(200, { status: "ok", resolved_count: 1 });
      },
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    render(<Providers><OfficerPage /></Providers>);
    await userEvent.click(await screen.findByRole("button", { name: "Resolve all" }, { timeout: 5000 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(resolveCalled).toBe(false);
  });

  it("?focus= for a zone that has ended says so instead of 'Showing ...'", async () => {
    vi.stubGlobal("location", { ...window.location, search: "?focus=NODE-09", pathname: "/officer.html", replace: vi.fn() });
    routeFetch(officerRoutes(() => [], [zone()])); // NODE-04 only
    render(<Providers><OfficerPage /></Providers>);
    expect(await screen.findByText("NODE-09 has no active hazard zone on the map")).toBeInTheDocument();
  });

  it("officer: a confirmed HIGH zone pops up the alarm; Acknowledge just closes it (already on the map)", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    routeFetch(officerRoutes(() => [], [zone()]));
    render(<Providers><OfficerPage /></Providers>);
    const dialog = await screen.findByRole("alertdialog", {}, { timeout: 5000 });
    await userEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(open).not.toHaveBeenCalled();
  });

  it("admin: the same zone shows on the map but there is no alarm or sound control", async () => {
    routeFetch({
      ...officerRoutes(() => [], [zone({ severity: "CRITICAL" })]),
      "/api/auth/me": () => json(200, { user: { username: "admin1", role: "admin" }, idle_timeout_minutes: 60 }),
    });
    render(<Providers><OfficerPage /></Providers>);
    expect(await screen.findByText("admin1", {}, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/All SOS requests resolved/)).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Alarm sound|enable sound/ })).toBeNull();
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

// B63: a focus request for a zone that is gone used to stay pending and fly
// the map there hours later, when the node raised a new hazard.
describe("FocusOnNode", () => {
  type Props = { request: FocusRequest | null; zones: HazardZone[]; loaded: boolean; onMissing?: (r: FocusRequest) => void };
  function Harness(p: Props) {
    const markerRefs = useRef(new Map<string, L.Marker>());
    return (
      <MapContainer center={[29.39, 79.45]} zoom={12}>
        <FocusOnNode request={p.request} zones={p.zones} loaded={p.loaded} markerRefs={markerRefs} onMissing={p.onMissing} />
      </MapContainer>
    );
  }
  function renderFocus(props: Props) {
    const flyTo = vi.spyOn(L.Map.prototype, "flyTo").mockImplementation(function (this: L.Map) { return this; });
    const utils = render(<Harness {...props} />);
    return { flyTo, rerender: (p: Props) => utils.rerender(<Harness {...p} />) };
  }

  it("waits for the first zone list, then drops a request whose zone is gone", () => {
    const request = { nodeId: "NODE-04", seq: 1 };
    const onMissing = vi.fn();
    const { flyTo, rerender } = renderFocus({ request, zones: [], loaded: false, onMissing });
    expect(onMissing).not.toHaveBeenCalled(); // still loading - keep waiting
    rerender({ request, zones: [zone({ node_id: "NODE-07" })], loaded: true, onMissing });
    expect(onMissing).toHaveBeenCalledWith(request);
    // hours later NODE-04 raises a new hazard: the old request must not fire
    rerender({ request, zones: [zone()], loaded: true, onMissing });
    expect(flyTo).not.toHaveBeenCalled();
    expect(onMissing).toHaveBeenCalledTimes(1);
  });

  it("still flies to a zone that arrives with the first zone list", () => {
    const request = { nodeId: "NODE-04", seq: 1 };
    const onMissing = vi.fn();
    const { flyTo, rerender } = renderFocus({ request, zones: [], loaded: false, onMissing });
    act(() => rerender({ request, zones: [zone()], loaded: true, onMissing }));
    expect(flyTo).toHaveBeenCalledTimes(1);
    expect(onMissing).not.toHaveBeenCalled();
  });
});

describe("SOS pin stacking (overlapping pins at district zoom)", () => {
  it("puts escalated SOS on top, then the longest-open, all above hazard icons", () => {
    const off = (escalated: boolean, minutes_open: number) => sosZIndexOffset({ escalated, minutes_open });
    expect(off(true, 0)).toBeGreaterThan(off(false, 999));
    expect(off(true, 0)).toBeGreaterThan(off(false, 50_000)); // the cap keeps it below every escalated one
    expect(off(false, 30)).toBeGreaterThan(off(false, 5));
    expect(off(true, 30)).toBeGreaterThan(off(true, 5));
    for (const v of [off(false, 0), off(false, -3), off(false, Number.NaN), off(true, 0)]) {
      expect(v).toBeGreaterThan(0); // hazard markers use Leaflet's default offset 0
    }
  });

  it("is applied to the Leaflet markers", () => {
    const sos = (id: number, escalated: boolean, minutes_open: number): SosRequest => ({
      id, latitude: 29.39, longitude: 79.45, location_source: "gps", note: null, status: "open",
      timestamp: new Date().toISOString(), escalated, minutes_open, nearest_hospital: "H", hospital_distance_km: 1,
      hospital_route_url: "https://maps.example/h", responder_route_url: "https://maps.example/r",
    });
    const refs = { current: new Map<string, L.Marker>() };
    render(
      <Providers>
        <MapContainer center={[29.39, 79.45]} zoom={12}>
          <SosMarkers requests={[sos(1, false, 40), sos(2, true, 2)]} markerRefs={refs} />
        </MapContainer>
      </Providers>,
    );
    expect(refs.current.get("sos:1")!.options.zIndexOffset).toBe(1040);
    expect(refs.current.get("sos:2")!.options.zIndexOffset).toBe(2002);
  });
});
