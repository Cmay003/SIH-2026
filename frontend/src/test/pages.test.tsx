import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { Hazard, SensorRow } from "../api/types";
import { OFFICER_MAP_TAB } from "../components/dashboard";
import { receivesAlarm } from "../lib/alarm";
import { DashboardPage } from "../pages/DashboardPage";
import { LoginPage } from "../pages/LoginPage";
import { Providers } from "../Providers";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Routes fetch calls by path to canned responses. */
function routeFetch(routes: Record<string, () => Response>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).split("?")[0];
    const handler = routes[path];
    return handler ? handler() : json(404, { error: `no mock for ${path}` });
  });
}

let replace: ReturnType<typeof vi.fn>;
beforeEach(() => {
  replace = vi.fn();
  sessionStorage.clear(); // alarm acknowledgements are kept per tab
  vi.stubGlobal("location", { ...window.location, search: "", pathname: "/", replace });
  setUnauthorizedHandler(vi.fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("LoginPage", () => {
  it("shows the server's error and clears the password on a failed login", async () => {
    routeFetch({ "/api/auth/login": () => json(401, { error: "Sign-in failed: wrong username or password, or the account is temporarily locked after repeated failures." }) });
    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Username"), "officer1");
    await userEvent.type(screen.getByLabelText("Password"), "wrong-password");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByText("Sign-in failed: wrong username or password, or the account is temporarily locked after repeated failures.")).toBeInTheDocument();
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(replace).not.toHaveBeenCalled();
  });

  it("asks for both fields before calling the server", async () => {
    const spy = routeFetch({});
    render(<LoginPage />);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getByText("Enter your username and password.")).toBeInTheDocument();
    expect(spy).not.toHaveBeenCalled();
  });

  it("goes to a safe ?next= after signing in, never to another site", async () => {
    vi.stubGlobal("location", { ...window.location, search: "?next=//evil.example", pathname: "/login.html", replace });
    routeFetch({ "/api/auth/login": () => json(200, { ok: true, user: { username: "a", role: "officer" } }) });
    render(<LoginPage />);
    await userEvent.type(screen.getByLabelText("Username"), "a");
    await userEvent.type(screen.getByLabelText("Password"), "CorrectHorse42!");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/"));
  });

  it("show/hide toggles the password field and the SOS link is always there", async () => {
    render(<LoginPage />);
    const pw = screen.getByLabelText("Password");
    expect(pw).toHaveAttribute("type", "password");
    await userEvent.click(screen.getByRole("button", { name: "Show" }));
    expect(pw).toHaveAttribute("type", "text");
    expect(screen.getByRole("link", { name: /Open SOS page/ })).toHaveAttribute("href", "/sos.html");
  });
});

const sensorRow = (over: Partial<SensorRow> = {}): SensorRow => ({
  id: 1, device_id: "NODE-04", hazard: "flood", water_level: 2.4, temperature: 28, humidity: 70,
  risk: "MEDIUM", risk_score: 0.55, timestamp: "2026-10-06T12:00:00Z", ...over,
});
const hazard = (over: Partial<Hazard> = {}): Hazard => ({
  label: "Hazard 1", node_id: "NODE-04", location: "Sector 4, Riverside", hazard_type: "flood", severity: "HIGH",
  risk_score: 0.82, latitude: 29.39, longitude: 79.45, eta_minutes: 130, predicted_time: null,
  prediction_text: "Expected to reach critical level in ~2h 10m", ...over,
});

const renderDashboard = () => render(<Providers><DashboardPage /></Providers>);

describe("DashboardPage", () => {
  it("shows tiles, the critical hazard, the hazard list and the nearest hospital", async () => {
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 }),
      "/api/sensors": () => json(200, { success: true, count: 1, data: [sensorRow({ risk: "HIGH" })] }),
      "/api/hazards": () => json(200, { success: true, count: 1, hazards: [hazard()] }),
      "/api/route/NODE-04": () => json(200, { node_id: "NODE-04", hospital: "District Hospital", distance_km: 1.2, maps_url: "https://maps.example/x" }),
    });
    renderDashboard();
    expect(await screen.findByText("Backend connected")).toBeInTheDocument();
    // On the page: critical callout + hazard card. The HIGH hazard also opens
    // the emergency alarm (portalled outside <main>) with its own risk score.
    const main = screen.getByRole("main");
    expect(await within(main).findAllByText("82%")).toHaveLength(2);
    const alarm = await screen.findByRole("alertdialog", { name: "Emergency alert" });
    expect(within(alarm).getByText("82%")).toBeInTheDocument();
    expect(screen.getByText("District Hospital")).toBeInTheDocument();
    expect(await screen.findByText("officer1")).toBeInTheDocument();
    const cardLinks = screen.getAllByRole("link").filter((a) => a.getAttribute("href")?.startsWith("/officer.html"));
    expect(cardLinks[0]).toHaveAttribute("href", "/officer.html?focus=NODE-04");
  });

  it("shows the all-clear state when there are no hazards", async () => {
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: "v", role: "viewer" }, idle_timeout_minutes: 60 }),
      "/api/sensors": () => json(200, { success: true, count: 0, data: [] }),
      "/api/hazards": () => json(200, { success: true, count: 0, hazards: [] }),
    });
    renderDashboard();
    expect(await screen.findByText(/No critical hazard right now/)).toBeInTheDocument();
    expect(screen.getByText("No active hazards - all nodes normal.")).toBeInTheDocument();
    expect(screen.getByText("No readings yet.")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull(); // nothing to alarm about
  });

  it("a stale CRITICAL hazard (node stopped reporting) is listed and labelled, but does not alarm", async () => {
    const lastReading = new Date(Date.now() - 2 * 3_600_000).toISOString();
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: "officer1", role: "officer" }, idle_timeout_minutes: 60 }),
      "/api/sensors": () => json(200, { success: true, count: 0, data: [] }),
      "/api/hazards": () =>
        json(200, {
          success: true,
          count: 1,
          hazards: [
            hazard({
              severity: "CRITICAL",
              stale: true,
              last_reading_at: lastReading,
              prediction_text: "No recent reading from this node - last known state only",
            }),
          ],
        }),
    });
    renderDashboard();
    const labels = await screen.findAllByText(/Stale - last reading 2 h ago; node may be offline/);
    expect(labels.length).toBeGreaterThan(0);
    expect(labels[0]).toHaveAttribute("title", `Last reading: ${lastReading}`);
    // the stale note alone carries the staleness - no duplicate server text
    expect(screen.queryByText(/No recent reading from this node/)).toBeNull();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("renders hostile text from the server as plain text, never as HTML", async () => {
    const payload = '<img src=x onerror="window.__xss=1">';
    routeFetch({
      "/api/auth/me": () => json(200, { user: { username: payload, role: "officer" }, idle_timeout_minutes: 60 }),
      "/api/sensors": () => json(200, { success: true, count: 1, data: [sensorRow({ device_id: payload })] }),
      "/api/hazards": () => json(200, { success: true, count: 1, hazards: [hazard({ location: payload })] }),
    });
    const { container } = renderDashboard();
    await screen.findAllByText(new RegExp("Sector|img"));
    await waitFor(() => expect(container.textContent).toContain(payload));
    expect(container.querySelector("img")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
  });

  it("shows 'not connected' when the backend is down", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    renderDashboard();
    expect(await screen.findByText("Backend not connected", {}, { timeout: 4000 })).toBeInTheDocument();
  });
});

// User report 2026-10-09: every click on a hazard card opened ANOTHER officer
// map tab; the siren must be for officers only; Acknowledge on the dashboard
// should take the officer to the map.
describe("Dashboard -> officer map + who gets the alarm", () => {
  const routes = (role: "viewer" | "officer" | "admin", hazards: Hazard[]) => ({
    "/api/auth/me": () => json(200, { user: { username: `${role}1`, role }, idle_timeout_minutes: 60 }),
    "/api/sensors": () => json(200, { success: true, count: 0, data: [] }),
    "/api/hazards": () => json(200, { success: true, count: hazards.length, hazards }),
  });

  it("only officers receive the alarm", () => {
    expect(receivesAlarm("officer")).toBe(true);
    expect(receivesAlarm("viewer")).toBe(false);
    expect(receivesAlarm("admin")).toBe(false);
    expect(receivesAlarm(undefined)).toBe(false); // still loading who is signed in
  });

  it("every hazard card targets the one named officer-map tab, so a second click re-uses it", async () => {
    routeFetch(routes("officer", [hazard(), hazard({ node_id: "NODE-07", severity: "MEDIUM" })]));
    renderDashboard();
    await screen.findByRole("alertdialog");
    const links = screen.getAllByRole("link", { hidden: true }).filter((a) => a.getAttribute("href")?.startsWith("/officer.html"));
    expect(links.length).toBeGreaterThanOrEqual(3); // critical callout + 2 cards
    for (const a of links) {
      expect(a).toHaveAttribute("target", OFFICER_MAP_TAB);
      // rel="noopener" would put each tab in its own group, where the name is never found again
      expect(a).not.toHaveAttribute("rel");
    }
  });

  it("a viewer sees the HIGH hazard but gets no pop-up, siren or sound control", async () => {
    routeFetch(routes("viewer", [hazard({ severity: "CRITICAL" })]));
    renderDashboard();
    expect(await screen.findByText("viewer1")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getAllByText("82%").length).toBeGreaterThan(0);
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(screen.queryByRole("button", { name: /Alarm sound|enable sound/ })).toBeNull();
  });

  it("an admin on the dashboard gets no pop-up either", async () => {
    routeFetch(routes("admin", [hazard({ severity: "CRITICAL" })]));
    renderDashboard();
    expect(await screen.findByText("admin1")).toBeInTheDocument();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("officer: Acknowledge silences the alarm and opens the officer map tab on the most severe hazard", async () => {
    const focus = vi.fn();
    const open = vi.spyOn(window, "open").mockReturnValue({ focus } as unknown as Window);
    routeFetch(routes("officer", [hazard(), hazard({ node_id: "NODE-07", severity: "CRITICAL", risk_score: 0.95 })]));
    renderDashboard();
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Acknowledge opens the officer map")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "Acknowledge" }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("/officer.html?focus=NODE-07", OFFICER_MAP_TAB);
    expect(focus).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  it("officer: Escape only acknowledges - it does not open the map", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    routeFetch(routes("officer", [hazard()]));
    renderDashboard();
    await screen.findByRole("alertdialog");
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(open).not.toHaveBeenCalled();
  });
});
