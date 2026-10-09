// Citizen "what to do now" advice (data/hazard_advice.json, shared with
// server.js WhatsApp alerts), the straight-line distance label and the
// "nearer hospital skipped because it is in a hazard zone" note.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone, NearestHospital, Severity } from "../api/types";
import { ADVICE, hazardActions, hazardName } from "../lib/advice";
import { hospitalZoneNote } from "../lib/hazards";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

/** Every hazard_type the backend produces (hazard_classification.py / rag_alert_pipeline.py). */
const HAZARD_TYPES = ["flood", "gas leak", "fire", "extreme heat", "landslide", "air pollution", "water quality degradation"];

/** server.js HAZARD_ADVICE before it moved into the shared table - WhatsApp {{4}} must not change. */
const OLD_WHATSAPP_ADVICE: Record<string, string> = {
  flood: "Move to higher ground and avoid flooded roads and bridges.",
  "gas leak": "Leave the area, avoid flames and electrical switches.",
  fire: "Move away from the fire and follow official evacuation advice.",
  "extreme heat": "Drink water often, stay out of the sun 12-3 pm, call 112 for heatstroke.",
  landslide: "Move away from the slope and avoid hill roads nearby.",
  "air pollution": "Limit outdoor activity; wear an N95 mask outdoors.",
  "water quality degradation": "Do not drink untreated water from this source; boil water.",
};

const DEVANAGARI = /[ऀ-ॿ]/;

describe("shared hazard advice table", () => {
  it("covers every hazard type, in English and Hindi, with 2-3 actions per level", () => {
    expect(Object.keys(ADVICE.hazards).sort()).toEqual([...HAZARD_TYPES].sort());
    for (const entry of [...HAZARD_TYPES.map((h) => ADVICE.hazards[h]), ADVICE.default]) {
      expect(entry.name.en).toBeTruthy();
      expect(entry.name.hi).toMatch(DEVANAGARI);
      for (const level of ["MEDIUM", "HIGH"] as const) {
        const { en, hi } = entry.actions[level];
        expect(en.length).toBeGreaterThanOrEqual(2);
        expect(en.length).toBeLessThanOrEqual(3);
        expect(hi).toHaveLength(en.length); // one Hindi line per English line
        for (const line of [...en, ...hi]) expect(line.trim()).not.toBe("");
        for (const line of hi) expect(line).toMatch(DEVANAGARI);
      }
    }
  });

  it("keeps the WhatsApp lines one line long and the English ones unchanged", () => {
    for (const h of HAZARD_TYPES) {
      const { en, hi } = ADVICE.hazards[h].whatsapp;
      expect(en).toBe(OLD_WHATSAPP_ADVICE[h]);
      // Meta rejects template parameters with newlines or tabs
      for (const line of [en, hi]) expect(line).not.toMatch(/[\n\t]| {4,}/);
      expect(hi).toMatch(DEVANAGARI);
    }
    expect(ADVICE.default.whatsapp.en).toBe("Follow instructions from local authorities.");
  });

  it("marks the Hindi as not yet reviewed by a native speaker", () => {
    const raw = ADVICE as unknown as { hi_reviewed: boolean; _hi_status: string };
    expect(raw.hi_reviewed).toBe(false);
    expect(raw._hi_status).toMatch(/needs native-speaker review/);
  });

  it("uses the MEDIUM step for MEDIUM, the HIGH step for HIGH and CRITICAL, nothing for LOW", () => {
    expect(hazardActions("flood", "MEDIUM", "en")).toEqual(ADVICE.hazards.flood.actions.MEDIUM.en);
    expect(hazardActions("flood", "HIGH", "en")).toEqual(ADVICE.hazards.flood.actions.HIGH.en);
    expect(hazardActions("flood", "CRITICAL", "hi")).toEqual(ADVICE.hazards.flood.actions.HIGH.hi);
    expect(hazardActions("flood", "LOW", "en")).toEqual([]);
  });

  it("falls back to generic advice for an unknown or prototype-named hazard type", () => {
    expect(hazardName("meteor", "en")).toBe("Hazard");
    expect(hazardName("constructor", "en")).toBe("Hazard");
    expect(hazardName(null, "hi")).toBe(ADVICE.default.name.hi);
    expect(hazardActions("constructor", "HIGH", "en")).toEqual(ADVICE.default.actions.HIGH.en);
  });
});

// ---- the SOS page ----------------------------------------------------------
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const HERE = { latitude: 29.3919, longitude: 79.4542 };
const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82,
  latitude: HERE.latitude, longitude: HERE.longitude, radius_m: 1000, confirmed: true, ...over,
});
const HOSPITAL: NearestHospital = { hospital: "District Hospital", distance_km: 4.6, maps_url: "https://maps.example/a" };

function mockApi(zones: HazardZone[], hospital: NearestHospital = HOSPITAL) {
  let sosSent = false;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const path = String(input).split("?")[0];
    if (path === "/api/status") return json(200, { ok: true });
    if (path === "/api/hazard-zones") return json(200, { success: true, zones });
    if (path === "/api/nearest-hospital") return json(200, hospital);
    if (path.startsWith("/api/sos/device/")) return json(200, sosSent ? { active: true, sos_id: 9, ...hospital } : { active: false });
    if (path === "/api/sos" && init?.method === "POST") {
      sosSent = true;
      return json(201, { status: "received", sos_id: 9, ...hospital });
    }
    return json(404, { error: `no mock for ${path}` });
  });
}

beforeEach(() => {
  setUnauthorizedHandler(vi.fn());
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: { getCurrentPosition: (ok: PositionCallback) => ok({ coords: HERE } as GeolocationPosition) },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const renderSos = () => render(<Providers><SosPage /></Providers>);
const liveRegion = () => document.querySelector('[aria-live="polite"][aria-atomic="true"]') as HTMLElement;

describe("SOS page advice", () => {
  it.each(HAZARD_TYPES)("shows the %s name, severity and actions in English and Hindi", async (hazardType) => {
    mockApi([zone({ hazard_type: hazardType })]);
    renderSos();
    expect(await screen.findByText("HIGH RISK")).toBeInTheDocument();
    const entry = ADVICE.hazards[hazardType];
    expect(screen.getByText(entry.name.en)).toBeInTheDocument();
    for (const action of entry.actions.HIGH.en) expect(screen.getByText(action)).toBeInTheDocument();
    // the hazard is part of what a screen reader announces
    expect(liveRegion()).toHaveTextContent(`HIGH RISK`);
    expect(liveRegion()).toHaveTextContent(entry.name.en);

    await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
    expect(screen.getByText("उच्च जोखिम")).toBeInTheDocument();
    expect(screen.getByText(entry.name.hi)).toBeInTheDocument();
    for (const action of entry.actions.HIGH.hi) expect(screen.getByText(action)).toBeInTheDocument();
    expect(liveRegion()).toHaveTextContent(entry.name.hi);
  });

  it("shows the most severe zone's hazard when zones overlap", async () => {
    mockApi([
      zone({ node_id: "GAS", hazard_type: "gas leak", severity: "MEDIUM", risk_score: 0.5 }),
      zone({ node_id: "FLOOD", hazard_type: "flood", severity: "CRITICAL", risk_score: 0.95, radius_m: 2000 }),
    ]);
    renderSos();
    expect(await screen.findByText("CRITICAL RISK")).toBeInTheDocument();
    expect(screen.getByText("Flood")).toBeInTheDocument();
    expect(screen.getByText(ADVICE.hazards.flood.actions.HIGH.en[0])).toBeInTheDocument(); // CRITICAL uses the HIGH step
    expect(screen.queryByText("Gas leak")).not.toBeInTheDocument();
  });

  it("gives the MEDIUM step (not the evacuation step) for a MEDIUM zone", async () => {
    mockApi([zone({ severity: "MEDIUM", risk_score: 0.5 })]);
    renderSos();
    expect(await screen.findByText("MEDIUM RISK")).toBeInTheDocument();
    expect(screen.getByText(ADVICE.hazards.flood.actions.MEDIUM.en[0])).toBeInTheDocument();
    expect(screen.queryByText(ADVICE.hazards.flood.actions.HIGH.en[0])).not.toBeInTheDocument();
  });

  it("shows no hazard advice outside every zone", async () => {
    mockApi([zone({ latitude: 28.6, longitude: 77.2 })]);
    renderSos();
    expect(await screen.findByText("LOW RISK")).toBeInTheDocument();
    expect(screen.getByText(/monitoring environmental conditions/)).toBeInTheDocument();
    expect(screen.queryByText("What to do now:")).not.toBeInTheDocument();
  });
});

describe("SOS page hospital", () => {
  it("labels the distance as straight-line, never as a driving route", async () => {
    mockApi([]);
    renderSos();
    expect(await screen.findByText(/4\.6 km away \(straight-line distance/)).toBeInTheDocument();
    expect(screen.queryByText(/driving route/)).not.toBeInTheDocument();
  });

  it("says why a nearer hospital inside a hazard zone was skipped, also after SOS", async () => {
    mockApi([zone({ severity: "CRITICAL" })], {
      ...HOSPITAL,
      skipped_hospital: { hospital: "Riverside Clinic", distance_km: 0.4, hazard_type: "flood", severity: "CRITICAL" },
    });
    renderSos();
    expect(await screen.findByText("District Hospital")).toBeInTheDocument();
    expect(screen.getByText(/Riverside Clinic \(0\.4 km\) is closer, but it is inside an active flood zone \(CRITICAL\)/))
      .toBeInTheDocument();

    const sos = screen.getByRole("button", { name: "SOS" });
    await waitFor(() => expect(sos).toBeEnabled());
    await userEvent.click(sos);
    expect(await screen.findByText("Help is on the way")).toBeInTheDocument();
    expect(screen.getByText(/Distance: 4\.6 km \(straight-line\)/)).toBeInTheDocument();
    expect(screen.getAllByText(/Riverside Clinic \(0\.4 km\) is closer/)).toHaveLength(2); // hospital card + result card
  });

  it("warns when every hospital is inside a hazard zone", async () => {
    mockApi([zone()], { ...HOSPITAL, hospital_in_hazard_zone: { hazard_type: "gas leak", severity: "HIGH" } });
    renderSos();
    expect(await screen.findByText(/Every nearby hospital is inside an active hazard zone/)).toBeInTheDocument();
    expect(screen.getByText(/active gas leak zone \(HIGH\) - call 112 before/)).toBeInTheDocument();
  });

  it("looks the hospital up again when the set of severe zones changes", async () => {
    let zones: HazardZone[] = [];
    let lookups = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const path = String(input).split("?")[0];
      if (path === "/api/hazard-zones") return json(200, { success: true, zones });
      if (path === "/api/nearest-hospital") {
        lookups++;
        return json(200, HOSPITAL);
      }
      if (path.startsWith("/api/sos/device/")) return json(200, { active: false });
      return json(200, { ok: true });
    });
    renderSos();
    await screen.findByText("LOW RISK");
    await waitFor(() => expect(lookups).toBeGreaterThan(0));
    const before = lookups;
    zones = [zone({ latitude: 29.5, longitude: 79.6, severity: "CRITICAL" })]; // a new zone elsewhere
    // the page polls zones every 5 s; wait for that poll and the new lookup
    await waitFor(() => expect(lookups).toBeGreaterThan(before), { timeout: 8000 });
  });
});

describe("officer hospital note", () => {
  const S: Severity = "HIGH";
  it("explains a skipped hospital, or an in-zone one, and says nothing otherwise", () => {
    expect(hospitalZoneNote({ hospital_skipped: { hospital: "A", distance_km: 1, hazard_type: "flood", severity: S } }))
      .toBe("nearer A (1 km) skipped: inside a flood zone (HIGH)");
    expect(hospitalZoneNote({ hospital_in_hazard_zone: { hazard_type: "fire", severity: S } })).toMatch(/fire zone \(HIGH\)/);
    expect(hospitalZoneNote({})).toBeNull();
  });
});
