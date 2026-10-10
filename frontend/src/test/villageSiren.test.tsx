// Village siren controls and offline SOS Wi-Fi (hotspot) labels on the
// officer page. The server keeps the desired state and the node reports
// what it does (server/siren.js), so the page must show "requested" and
// "sounding" separately, and only officers/admins get the buttons.
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { Role, SirenStatus, SirensResponse, SosRequest, UnlocatedNodeSos } from "../api/types";
import { hotspotNote, isApproximateSos, peopleNeedsText } from "../lib/hazards";
import {
  autoSirenHint, canControlSiren, offersSilence, sirenConfirmText, sirenPendingText, sirenStateText, sirenUntilText,
} from "../lib/villageSiren";
import { OfficerPage } from "../pages/OfficerPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const siren = (over: Partial<SirenStatus> = {}): SirenStatus => ({
  node_id: "SIREN-01", fitted: true, sounding: false, desired: null, reason: null, desired_reason: null,
  desired_by: null, until: null, reported_reason: null, reported_at: new Date().toISOString(), simulated: false,
  desired_simulated: false, ...over,
});

const sosRow = (id: number, over: Partial<SosRequest>): SosRequest => ({
  id, latitude: 29.39, longitude: 79.45, location_source: "gps", location_accuracy_m: null, node_id: null,
  note: null, status: "open", timestamp: new Date().toISOString(), escalated: false, minutes_open: 3,
  nearest_hospital: "H", hospital_distance_km: 1, hospital_route_url: "https://maps.example/h",
  responder_route_url: "https://maps.example/r", ...over,
});

interface Routes {
  role?: Role | null;
  sirens?: SirensResponse | null;
  sos?: SosRequest[];
  unlocated?: UnlocatedNodeSos[];
}

/** Officer page routes; returns the siren POSTs as [path, body]. */
function officerRoutes({ role = "officer", sirens = null, sos = [], unlocated = [] }: Routes) {
  const posts: [string, unknown][] = [];
  let state = sirens;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).split("?")[0];
    if (path === "/api/auth/me") {
      return role ? json(200, { user: { username: "o", role }, idle_timeout_minutes: 60 }) : json(401, { error: "Not logged in" });
    }
    if (path === "/api/hazard-zones") return json(200, { success: true, zones: [] });
    if (path === "/api/sos") {
      return json(200, { success: true, count: sos.length, escalated_count: 0, invalid_location_count: unlocated.length,
        unlocated_node_sos: unlocated, data: sos });
    }
    if (path === "/api/node-health") {
      return json(200, { generated_at: "", summary: { online: 0, offline: 0, never_seen: 0 }, nodes_with_issues: 0, nodes: [] });
    }
    if (path === "/api/sirens" && state) return json(200, state);
    const m = path.match(/^\/api\/nodes\/([^/]+)\/siren$/);
    if (m && init?.method === "POST" && state) {
      const body = JSON.parse(String(init.body)) as { action: "on" | "off" };
      posts.push([path, body]);
      const nodeId = decodeURIComponent(m[1]);
      const updated = siren({
        ...state.sirens.find((s) => s.node_id === nodeId), desired: body.action, desired_reason: "officer", desired_by: "o",
        until: body.action === "on" ? new Date(Date.now() + 180_000).toISOString() : null,
      });
      state = { ...state, sirens: state.sirens.map((s) => (s.node_id === nodeId ? updated : s)) };
      return json(200, { status: "ok", siren: updated });
    }
    return json(404, { error: `no mock for ${path}` });
  });
  return posts;
}

const sirensResponse = (list: SirenStatus[], auto: "CRITICAL" | "off" = "CRITICAL"): SirensResponse => ({
  auto_severity: auto, default_on_seconds: 180, sirens: list,
});
const renderOfficer = () => render(<Providers><OfficerPage /></Providers>);

// The officer page (Leaflet + several queries) can take over the 1 s find default while the
// whole suite runs in parallel on a busy machine.
const SLOW = { timeout: 5000 };

beforeEach(() => setUnauthorizedHandler(vi.fn()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("village siren wording", () => {
  it("separates what the node reports from what is still requested", () => {
    expect(sirenStateText(siren())).toBe("Silent");
    expect(sirenStateText(siren({ sounding: true, reported_reason: "auto_offline" })))
      .toBe("Sounding - the node decided itself (no gateway contact)");
    expect(sirenStateText(siren({ sounding: true, desired: "on", desired_reason: "auto" })))
      .toBe("Sounding - automatic (confirmed CRITICAL hazard)");
    expect(sirenStateText(siren({ sounding: true, desired: "on", desired_reason: "officer", desired_by: "asha" })))
      .toBe("Sounding - sounded by asha");
    expect(sirenPendingText(siren({ desired: "on", desired_reason: "auto" })))
      .toBe("Sound requested automatic (confirmed CRITICAL hazard) - waiting for the node to report it");
    expect(sirenPendingText(siren({ desired: "off", sounding: true }))).toBe("Silence requested - waiting for the node to report it");
    expect(sirenPendingText(siren({ desired: "on", sounding: true }))).toBeNull();
    expect(sirenPendingText(siren())).toBeNull();
    expect(sirenUntilText(siren({ desired: "on", until: "2026-10-09T08:30:00Z" }))).toMatch(/^until \d/);
    expect(sirenUntilText(siren({ desired: "off", until: null }))).toBeNull();
  });

  it("offers Silence while sounding or requested on, and asks before either", () => {
    expect(offersSilence(siren())).toBe(false);
    expect(offersSilence(siren({ sounding: true }))).toBe(true);
    expect(offersSilence(siren({ desired: "on" }))).toBe(true);
    expect(sirenConfirmText(siren(), 180)).toMatch(/^Sound the village siren at SIREN-01 for about 3 min\?/);
    expect(sirenConfirmText(siren({ sounding: true }), 180)).toMatch(/^Silence the village siren at SIREN-01\?/);
    expect(canControlSiren("officer")).toBe(true);
    expect(canControlSiren("admin")).toBe(true);
    expect(canControlSiren("viewer")).toBe(false);
    expect(canControlSiren(undefined)).toBe(false);
  });
});

describe("hotspot SOS wording", () => {
  it("labels the node position, typed coordinates and a hotspot without a position", () => {
    expect(hotspotNote({ location_source: "hotspot", node_id: "NODE-07", location_accuracy_m: 150, latitude: 29.4 }))
      .toBe("via offline SOS Wi-Fi at NODE-07 - within ~150 m");
    expect(hotspotNote({ location_source: "hotspot", node_id: "NODE-07", location_accuracy_m: null, latitude: 29.4 }))
      .toBe("via offline SOS Wi-Fi at NODE-07 - location typed by the person (unverified)");
    expect(hotspotNote({ location_source: "hotspot", node_id: "GW-01" }))
      .toBe("via offline SOS Wi-Fi at GW-01 - the hotspot has no registered position");
    expect(hotspotNote({ location_source: "node", node_id: "NODE-07" })).toBeNull();
    expect(peopleNeedsText({ people: 3, needs: ["trapped", "injured"] })).toBe("3 people · needs: trapped, injured");
    expect(peopleNeedsText({ people: 1, needs: [] })).toBe("1 person");
    expect(peopleNeedsText({ people: null, needs: ["fire"] })).toBe("needs: fire");
    expect(peopleNeedsText({})).toBeNull();
    // the node's Wi-Fi range is not a device fix: never "approximate"
    expect(isApproximateSos({ location_source: "hotspot", location_accuracy_m: 150, node_id: "N" })).toBe(false);
  });
});

describe("officer page: village sirens", () => {
  it("lists the sirens with reported state and pending requests", async () => {
    officerRoutes({ sirens: sirensResponse([
      siren({ node_id: "SIREN-01" }),
      siren({ node_id: "SIREN-02", sounding: true, reported_reason: "auto_offline" }),
      siren({ node_id: "SIREN-03", desired: "on", desired_reason: "auto", until: new Date(Date.now() + 9e4).toISOString() }),
    ]) });
    renderOfficer();
    const list = await screen.findByRole("list", { name: "Village sirens" }, SLOW);
    const item = (id: string) => within(list).getAllByRole("listitem").find((li) => within(li).queryByText(id))!;
    expect(within(item("SIREN-01")).getAllByText("Silent").length).toBeGreaterThan(0);
    expect(within(item("SIREN-02")).getByText("Sounding")).toBeInTheDocument();
    expect(within(item("SIREN-02")).getByText(/the node decided itself/)).toBeInTheDocument();
    expect(within(item("SIREN-03")).getByText(/Sound requested automatic .* waiting for the node/)).toBeInTheDocument();
    expect(screen.getByText(/Sounds by itself only for a confirmed CRITICAL evacuation hazard at that node \(flood, flash flood, landslide, fire, gas leak\)/))
      .toBeInTheDocument();
    expect(within(item("SIREN-01")).getByRole("button", { name: /Sound village siren\s*at SIREN-01/ })).toBeInTheDocument();
    expect(within(item("SIREN-02")).getByRole("button", { name: /Silence\s*at SIREN-02/ })).toBeInTheDocument();
    expect(within(item("SIREN-03")).getByRole("button", { name: /Silence\s*at SIREN-03/ })).toBeInTheDocument();
  });

  it("sounds a siren only after the officer confirms", async () => {
    const posts = officerRoutes({ sirens: sirensResponse([siren()]) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderOfficer();
    const button = await screen.findByRole("button", { name: /Sound village siren\s*at SIREN-01/ }, SLOW);
    await userEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/^Sound the village siren at SIREN-01 for about 3 min\?/));
    expect(posts).toEqual([]); // cancelled
    await userEvent.click(button);
    await waitFor(() => expect(posts).toEqual([["/api/nodes/SIREN-01/siren", { action: "on" }]]), SLOW);
    // after the refresh: requested, not yet sounding, and Silence offered
    expect(await screen.findByText(/Sound requested by o - waiting for the node to report it/, {}, SLOW)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Silence\s*at SIREN-01/ })).toBeInTheDocument();
  });

  it("silences a sounding siren after confirmation", async () => {
    const posts = officerRoutes({ sirens: sirensResponse([siren({ sounding: true, desired: "on", desired_reason: "auto" })]) });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderOfficer();
    await userEvent.click(await screen.findByRole("button", { name: /Silence\s*at SIREN-01/ }, SLOW));
    await waitFor(() => expect(posts).toEqual([["/api/nodes/SIREN-01/siren", { action: "off" }]]), SLOW);
    expect(await screen.findByText("Silence requested - waiting for the node to report it", {}, SLOW)).toBeInTheDocument();
  });

  it("no buttons while the role is unknown; the hint says when automatic sounding is off", async () => {
    officerRoutes({ role: null, sirens: sirensResponse([siren()], "off") });
    renderOfficer();
    await screen.findByRole("list", { name: "Village sirens" });
    expect(screen.getByText(/Automatic sounding is switched off/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Sound village siren/ })).not.toBeInTheDocument();
  });

  it("no section at all when the server has no siren list", async () => {
    officerRoutes({ sirens: null });
    renderOfficer();
    await screen.findByText("✅ All SOS requests resolved");
    expect(screen.queryByRole("heading", { name: /Village sirens/ })).not.toBeInTheDocument();
  });
});

describe("officer page: offline SOS Wi-Fi requests", () => {
  it("labels a hotspot SOS with the node, ~150 m, people and needs", async () => {
    officerRoutes({ sos: [
      sosRow(5, { location_source: "hotspot", node_id: "NODE-07", location_accuracy_m: 150, people: 3,
        needs: ["trapped", "injured"], note: "Offline SOS Wi-Fi at NODE-07 (Bridge): \"blue house roof\"" }),
      sosRow(6, { location_source: "hotspot", node_id: "NODE-07", location_accuracy_m: null, people: null, needs: [] }),
    ] });
    const { container } = renderOfficer();
    const queue = await screen.findByRole("list", { name: "SOS queue" });
    const card = (id: number) => within(queue).getAllByRole("listitem").find((c) => within(c).queryByText(`SOS #${id}`))!;
    expect(within(card(5)).getByText("SOS Wi-Fi")).toBeInTheDocument();
    expect(within(card(5)).getByText("via offline SOS Wi-Fi at NODE-07 - within ~150 m")).toBeInTheDocument();
    expect(within(card(5)).getByText("3 people · needs: trapped, injured")).toBeInTheDocument();
    expect(within(card(5)).queryByText("Approximate")).not.toBeInTheDocument();
    expect(within(card(6)).getByText("via offline SOS Wi-Fi at NODE-07 - location typed by the person (unverified)"))
      .toBeInTheDocument();
    await waitFor(() => expect(container.querySelector('[title^="SOS #5,"]')).not.toBeNull());
    expect(container.querySelector('[title^="SOS #5,"]')!.getAttribute("title"))
      .toMatch(/via offline SOS Wi-Fi at NODE-07 - within ~150 m/);
  });

  it("a hotspot without a position is in the unlocated banner, with people and needs", async () => {
    officerRoutes({ unlocated: [{ id: 9, node_id: "GW-01", location_source: "hotspot", people: 4, needs: ["medical"],
      note: "Offline SOS Wi-Fi at GW-01 (NO REGISTERED POSITION) - no description given", status: "open",
      timestamp: new Date().toISOString(), minutes_open: 2 }] });
    renderOfficer();
    const title = await screen.findByText(/SOS from a node or offline SOS Wi-Fi with no registered position/);
    const banner = title.closest("[role=alert]")!;
    expect(banner).toHaveTextContent(/SOS #9 · GW-01/);
    expect(banner).toHaveTextContent("via offline SOS Wi-Fi at GW-01 - the hotspot has no registered position");
    expect(banner).toHaveTextContent("4 people · needs: medical");
  });
});

describe("automatic siren hint (SIREN_AUTO_HAZARDS)", () => {
  it("names the evacuation hazards and what never sounds it by itself", () => {
    const text = autoSirenHint(["flood", "flash_flood", "landslide", "fire", "gas_leak"]);
    expect(text).toMatch(/confirmed CRITICAL evacuation hazard at that node \(flood, flash flood, landslide, fire, gas leak\)/);
    expect(text).toMatch(/Heat, air pollution, smoke and weather forecasts never sound it by themselves/);
    expect(text).toMatch(/you can sound it for anything/);
    expect(autoSirenHint(undefined)).toBe(text); // an older server without the list: the default
  });

  it("follows a server list that includes a usually excluded type", () => {
    const text = autoSirenHint(["flood", "extreme_heat"]);
    expect(text).toMatch(/\(flood, extreme heat\)/);
    expect(text).toMatch(/Air pollution, smoke and weather forecasts never/);
  });
});
