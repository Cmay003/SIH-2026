import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { NodeConfig } from "../api/types";
import { curveNumberHint, emptyNodeForm, validateNodeForm } from "../lib/nodes";
import { AdminPage } from "../pages/AdminPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const NODES: Record<string, NodeConfig> = {
  "NODE-04": { location: "Sector 4, Riverside", land_use: "urban_low", curve_number: 78, latitude: 29.3919,
               longitude: 79.4542, upstream_node: "NODE-07", report_interval_seconds: null },
  "NODE-07": { location: "Hill Road", land_use: "forest", curve_number: 45, latitude: 29.4002,
               longitude: 79.461, upstream_node: null, report_interval_seconds: 60 },
};
const HEALTH = {
  generated_at: "", summary: { online: 1, offline: 1, never_seen: 0 }, nodes_with_issues: 1,
  nodes: [
    { node_id: "NODE-04", location: "", latitude: 29.39, longitude: 79.45, status: "online", level: "ok", last_seen: null,
      seconds_since_seen: 3, expected_interval_seconds: 5, battery_pct: null, signal_strength_dbm: null, link: null, issues: [] },
    { node_id: "NODE-07", location: "", latitude: 29.4, longitude: 79.46, status: "offline", level: "critical", last_seen: null,
      seconds_since_seen: 900, expected_interval_seconds: 60, battery_pct: null, signal_strength_dbm: null, link: null, issues: [] },
  ],
};

type Call = { method: string; path: string; body: unknown };

/** Routes "METHOD /path" to canned responses and records every call. */
function api(routes: Record<string, () => Response>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const method = init?.method ?? "GET";
    const path = String(input).split("?")[0];
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const handler = routes[`${method} ${path}`];
    return handler ? handler() : json(404, { error: `no mock for ${method} ${path}` });
  });
  return calls;
}

const baseRoutes = {
  "GET /api/auth/me": () => json(200, { user: { username: "admin1", role: "admin" }, idle_timeout_minutes: 60 }),
  "GET /api/admin/nodes": () => json(200, { nodes: NODES }),
  "GET /api/node-health": () => json(200, HEALTH),
};

beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, search: "", pathname: "/admin.html", replace: vi.fn() });
  setUnauthorizedHandler(vi.fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderPage = () => render(<Providers><AdminPage /></Providers>);

describe("validateNodeForm", () => {
  const filled = { ...emptyNodeForm(), node_id: "NODE-05", location: "Bridge", latitude: "29.38", longitude: "79.46" };

  it("turns a valid form into the config the server expects", () => {
    const { errors, config } = validateNodeForm({ ...filled, upstream_node: "NODE-04" }, NODES, true);
    expect(errors).toEqual({});
    expect(config).toEqual({ location: "Bridge", land_use: "urban_low", curve_number: 80, latitude: 29.38,
      longitude: 79.46, upstream_node: "NODE-04", report_interval_seconds: null });
  });

  it("rejects ids the LoRa packet can't carry, and duplicates", () => {
    expect(validateNodeForm({ ...filled, node_id: "NODE-TOO-LONG1" }, NODES, true).errors.node_id).toMatch(/1-12/);
    expect(validateNodeForm({ ...filled, node_id: "bad id" }, NODES, true).errors.node_id).toMatch(/1-12/);
    expect(validateNodeForm({ ...filled, node_id: "NODE-04" }, NODES, true).errors.node_id).toMatch(/already exists/);
    // editing keeps its own id
    expect(validateNodeForm({ ...filled, node_id: "NODE-04" }, NODES, false).errors.node_id).toBeUndefined();
  });

  it("checks number ranges and keeps half-typed numbers as errors, not NaN", () => {
    const { errors } = validateNodeForm({ ...filled, curve_number: "150", latitude: "91", longitude: "abc",
                                          report_interval_seconds: "0" }, NODES, true);
    expect(Object.keys(errors).sort()).toEqual(["curve_number", "latitude", "longitude", "report_interval_seconds"]);
  });

  it("refuses an upstream link that would loop", () => {
    // NODE-04's upstream is NODE-07, so NODE-07 can't take NODE-04 as upstream
    const { errors } = validateNodeForm({ ...filled, node_id: "NODE-07", upstream_node: "NODE-04" }, NODES, false);
    expect(errors.upstream_node).toMatch(/loop/);
  });

  it("only hints (never blocks) when the curve number is unusual for the land use", () => {
    expect(curveNumberHint("forest", "90")).toMatch(/typically 35-55/);
    expect(curveNumberHint("forest", "45")).toBeNull();
  });
});

describe("AdminPage", () => {
  it("lists the nodes with their live status", async () => {
    api(baseRoutes);
    renderPage();
    const row04 = (await screen.findByRole("rowheader", { name: "NODE-04" })).closest("tr")!;
    expect(within(row04).getByText("Sector 4, Riverside")).toBeInTheDocument();
    expect(within(row04).getByText("5 s (default)")).toBeInTheDocument();
    expect(within(row04).getByText("Online")).toBeInTheDocument();
    const row07 = screen.getByRole("rowheader", { name: "NODE-07" }).closest("tr")!;
    expect(within(row07).getByText("Offline")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Sensor nodes (2)" })).toBeInTheDocument();
  });

  it("adds a node and tells the admin how to give it a device key", async () => {
    const calls = api({ ...baseRoutes, "POST /api/admin/nodes/NODE-05": () => json(200, { status: "created", node_id: "NODE-05" }) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "+ Add node" }));
    await userEvent.type(screen.getByLabelText("Node ID"), "NODE-05");
    await userEvent.type(screen.getByLabelText("Location"), "New Bridge");
    await userEvent.type(screen.getByLabelText("Latitude"), "29.38");
    await userEvent.type(screen.getByLabelText("Longitude"), "79.46");
    await userEvent.selectOptions(screen.getByLabelText("Upstream node"), "NODE-04");
    await userEvent.type(screen.getByLabelText("Reports every (seconds)"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Add node" }));

    expect(await screen.findByText(/node server\/device_keys\.js add node-05 --nodes NODE-05/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.path).toBe("/api/admin/nodes/NODE-05");
    expect(post.body).toEqual({ location: "New Bridge", land_use: "urban_low", curve_number: 80, latitude: 29.38,
      longitude: 79.46, upstream_node: "NODE-04", report_interval_seconds: 60 });
  });

  it("shows field errors and sends nothing when the form is invalid", async () => {
    const calls = api(baseRoutes);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "+ Add node" }));
    await userEvent.type(screen.getByLabelText("Node ID"), "NODE-04");
    await userEvent.click(screen.getByRole("button", { name: "Add node" }));
    expect(screen.getByText("NODE-04 already exists.")).toBeInTheDocument();
    expect(screen.getByLabelText("Node ID")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Node ID")).toHaveFocus(); // first invalid field
    expect(screen.getByLabelText("Location")).toHaveAttribute("aria-invalid", "true");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("edits a node with PUT and shows the server's reason when it refuses", async () => {
    const calls = api({ ...baseRoutes,
      "PUT /api/admin/nodes/NODE-07": () => json(400, { error: "Upstream node 'X' does not exist" }) });
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Edit NODE-07" }));
    expect(screen.getByLabelText("Node ID")).toBeDisabled();
    expect(screen.getByLabelText("Location")).toHaveValue("Hill Road");
    await userEvent.clear(screen.getByLabelText("Location"));
    await userEvent.type(screen.getByLabelText("Location"), "Hill Road (moved)");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Couldn't save: Upstream node 'X' does not exist")).toBeInTheDocument();
    expect(calls.find((c) => c.method === "PUT")!.body).toMatchObject({ location: "Hill Road (moved)", report_interval_seconds: 60 });
  });

  it("deletes only after confirmation and explains a refusal", async () => {
    const calls = api({ ...baseRoutes, "DELETE /api/admin/nodes/NODE-07": () =>
      json(409, { error: "Cannot delete 'NODE-07' - it's set as upstream_node for: ['NODE-04']. Update those nodes first." }) });
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Delete NODE-07" }));
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(screen.getByRole("button", { name: "Delete NODE-07" }));
    expect(await screen.findByText(/Couldn't delete: Cannot delete 'NODE-07'/)).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("explains when node management is switched off on the server", async () => {
    api({ ...baseRoutes, "GET /api/admin/nodes": () =>
      json(503, { error: "Node management is switched off: set OFFICER_API_KEY in .env and restart both servers." }) });
    renderPage();
    expect(await screen.findByText(/set OFFICER_API_KEY in \.env/)).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("button", { name: "+ Add node" })).not.toBeInTheDocument());
  });
});
