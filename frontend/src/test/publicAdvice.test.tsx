// Step W3: every hazard type the backend produces (incl. heavy_rain /
// high_wind from the weather forecast, flash_flood, smoke) has an icon, a
// readable title and citizen advice on every page; the staff pages'
// "What the public is told" section fetches the advice table on demand.
import fs from "node:fs";
import path from "node:path";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone } from "../api/types";
import { PublicAdviceSection } from "../components/PublicAdvice";
import { ADVICE } from "../lib/advice";
import { alarmItemsFromZones, hazardTitle } from "../lib/alarm";
import { hazardIcon } from "../lib/hazards";
import { publicAdviceFor, resetAdviceCache, type AdviceTableJson } from "../lib/publicAdvice";

const ALL_TYPES = Object.keys(ADVICE.hazards);
const TABLE = ADVICE as unknown as AdviceTableJson;
const REPO = path.resolve(__dirname, "../../..");

describe("every hazard type is covered everywhere", () => {
  it("includes the extreme-weather types from the backend contract", () => {
    expect(ALL_TYPES).toEqual(expect.arrayContaining(["heavy_rain", "high_wind", "flash_flood", "smoke"]));
  });

  it.each(ALL_TYPES)("%s: own icon (not the generic one), readable title, advice for MEDIUM and HIGH", (type) => {
    expect(hazardIcon(type)).not.toBe("⚠️");
    expect(hazardTitle(type)).not.toMatch(/_/);
    expect(hazardTitle(type)[0]).toMatch(/[A-Z]/);
    for (const sev of ["MEDIUM", "HIGH", "CRITICAL"]) {
      const a = publicAdviceFor(TABLE, type, sev)!;
      expect(a.specific).toBe(true);
      expect(a.actions.length).toBeGreaterThanOrEqual(2);
      expect(a.whatsapp).toBeTruthy();
    }
  });

  it("uses the agreed icons for the new types", () => {
    expect(hazardIcon("heavy_rain")).toBe("🌧️");
    expect(hazardIcon("high_wind")).toBe("🌬️");
    expect(hazardIcon("Heavy rain")).toBe("🌧️"); // the alarm's title form
  });

  it.each([["public/index.html"], ["public/officer.html"], ["public/sos.html"]])(
    "classic page %s has an icon for every hazard type", (file) => {
      const html = fs.readFileSync(path.join(REPO, file), "utf8");
      const block = html.slice(html.indexOf("HAZARD_ICONS = {"));
      const icons = block.slice(0, block.indexOf("}"));
      for (const type of ALL_TYPES) expect(icons, `${file} lacks ${type}`).toContain(`"${type}"`);
    });

  it("the alarm item carries the hazard type, so the alarm shows the right icon and advice", () => {
    const zone: HazardZone = { node_id: "NODE-04", hazard_type: "heavy_rain", severity: "HIGH", risk_score: 0.7,
      latitude: 29.39, longitude: 79.45, radius_m: 1000, confirmed: true };
    const [item] = alarmItemsFromZones([zone]);
    expect(item.hazardType).toBe("heavy_rain");
    expect(item.title).toBe("Heavy rain");
    expect(hazardIcon(item.hazardType)).toBe("🌧️");
  });
});

describe("publicAdviceFor", () => {
  it("MEDIUM -> the MEDIUM step, HIGH/CRITICAL -> the HIGH step, LOW -> no actions", () => {
    const h = ADVICE.hazards.heavy_rain;
    expect(publicAdviceFor(TABLE, "heavy_rain", "MEDIUM")!.actions).toEqual(h.actions.MEDIUM.en);
    expect(publicAdviceFor(TABLE, "heavy_rain", "CRITICAL")!.actions).toEqual(h.actions.HIGH.en);
    expect(publicAdviceFor(TABLE, "heavy_rain", "LOW")!.actions).toEqual([]);
    expect(publicAdviceFor(TABLE, "heavy_rain", "HIGH")!.whatsapp).toBe(h.whatsapp.en);
  });

  it("falls back to the default entry (marked not specific) and survives bad tables", () => {
    for (const odd of ["meteor", "constructor", null]) {
      const a = publicAdviceFor(TABLE, odd, "HIGH")!;
      expect(a.specific).toBe(false);
      expect(a.actions).toEqual(ADVICE.default.actions.HIGH.en);
    }
    expect(publicAdviceFor(null, "flood", "HIGH")).toBeNull();
    expect(publicAdviceFor({}, "flood", "HIGH")).toBeNull();
    expect(publicAdviceFor({ hazards: { flood: { actions: { HIGH: { en: [1, "", "Go up"] } } } } }, "flood", "HIGH"))
      .toEqual({ name: "flood", whatsapp: null, actions: ["Go up"], specific: true });
  });
});

// ---- the "What the public is told" section --------------------------------
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("PublicAdviceSection", () => {
  beforeEach(() => {
    setUnauthorizedHandler(vi.fn());
    resetAdviceCache();
  });
  afterEach(() => vi.restoreAllMocks());

  const renderSection = () => render(
    // no Providers: the section must work without a QueryClientProvider (alarm pop-up)
    <PublicAdviceSection hazardType="high_wind" severity="HIGH" label="High wind at NODE-04" />,
  );

  it("fetches nothing until opened, then shows the WhatsApp line and the actions", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input) === "/hazard-advice.json" ? json(200, ADVICE) : json(404, {}));
    renderSection();
    expect(fetchMock).not.toHaveBeenCalled();
    await userEvent.click(screen.getByText("What the public is told"));
    const h = ADVICE.hazards.high_wind;
    expect(await screen.findByText(`“${h.whatsapp.en}”`)).toBeInTheDocument();
    for (const a of h.actions.HIGH.en) expect(screen.getByText(a)).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("says so when the table cannot be loaded", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => json(500, { error: "boom" }));
    renderSection();
    await userEvent.click(screen.getByText("What the public is told"));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(/Could not load the advice table/), { timeout: 5000 });
  });
});
