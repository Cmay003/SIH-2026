// Hindi mode on the citizen SOS page: after the हिंदी toggle, the safety
// text a person relies on (connection status, the GPS-denied hint, the
// location status, the hospital card) must not stay in English - and no
// i18n key may quietly hold an English copy in its Hindi slot.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { HazardZone, NearestHospital } from "../api/types";
import { STRING_KEYS, t, type StringKey } from "../lib/i18n";
import { SosPage } from "../pages/SosPage";
import { Providers } from "../Providers";

const DEVANAGARI = /[ऀ-ॿ]/;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "CRITICAL", risk_score: 0.9,
  latitude: 29.3919, longitude: 79.4542, radius_m: 1000, confirmed: true, ...over,
});
const IN_ZONE = { latitude: 29.3929, longitude: 79.4542 };
const HOSPITAL: NearestHospital = { hospital: "District Hospital", distance_km: 4.6, maps_url: "https://maps.example/a" };

function mockApi(hospital: NearestHospital = HOSPITAL) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).split("?")[0];
    if (path.startsWith("/api/sos/device/")) return json(200, { active: false });
    if (path === "/api/status") return json(200, { ok: true });
    if (path === "/api/hazard-zones") return json(200, { success: true, zones: [zone()] });
    if (path === "/api/nearest-hospital") return json(200, hospital);
    return json(404, { error: `no mock for ${path}` });
  });
}

function geolocation(answer: { coords: typeof IN_ZONE } | { code: number; message: string }) {
  vi.stubGlobal("navigator", {
    ...navigator,
    geolocation: {
      getCurrentPosition: (ok: PositionCallback, err: PositionErrorCallback) => {
        if ("coords" in answer) ok({ coords: answer.coords } as GeolocationPosition);
        else err(answer as GeolocationPositionError);
      },
    },
  });
}

const renderSos = () => render(<Providers><SosPage /></Providers>);
const toHindi = async () => {
  await userEvent.click(screen.getByRole("button", { name: "हिंदी" }));
  await waitFor(() => expect(document.documentElement.lang).toBe("hi"));
};
/** The status line under "Get My Location" (the connection status is the other role=status) */
const locateStatus = () => screen.getAllByRole("status").find((el) => el !== connStatus())!;
const connStatus = () => screen.getAllByRole("status")[0];

beforeEach(() => setUnauthorizedHandler(vi.fn()));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.lang = "";
});

describe("SOS page in Hindi", () => {
  it("GPS denied: status, hint, locate text, hospital card and intros are all Hindi", async () => {
    geolocation({ code: 1, message: "User denied Geolocation" });
    mockApi();
    renderSos();
    await screen.findByText(t("en", "connected"));
    await screen.findByText(t("en", "locNeedSilent"));
    await toHindi();

    expect(connStatus()).toHaveTextContent(t("hi", "connected"));
    expect(connStatus().textContent).toMatch(DEVANAGARI);
    // the hint a Hindi user sees when GPS is denied
    expect(screen.getByText(t("hi", "sosHintNeedLocation"))).toBeInTheDocument();
    expect(locateStatus()).toHaveTextContent(t("hi", "locNeedSilent"));
    expect(locateStatus().textContent).toMatch(DEVANAGARI);
    expect(screen.getByRole("heading", { name: t("hi", "hospTitle") })).toBeInTheDocument();
    expect(screen.getByText(t("hi", "hospWaiting"))).toBeInTheDocument();
    expect(screen.getByText(t("hi", "locateIntro"))).toBeInTheDocument();
    expect(screen.getByText(t("hi", "sosIntro"))).toBeInTheDocument();
    expect(screen.getByText(t("hi", "areaNeedLocation"))).toBeInTheDocument();
    expect(screen.getByLabelText(t("hi", "noteLabel"))).toHaveAttribute("placeholder", t("hi", "notePlaceholder"));
    for (const english of ["Connected to SANJEEVNI server.", "Nearest Hospital & Route", "Optional: describe your situation"]) {
      expect(screen.queryByText(english)).not.toBeInTheDocument();
    }
  });

  it("a location status written before the switch is re-rendered in the new language", async () => {
    geolocation({ coords: IN_ZONE });
    mockApi({
      ...HOSPITAL,
      skipped_hospital: { hospital: "Riverside Clinic", distance_km: 0.4, hazard_type: "flood", severity: "CRITICAL" },
    });
    renderSos();
    await screen.findByText("Location detected (29.3929, 79.4542).");
    expect(await screen.findByText(/Riverside Clinic \(0\.4 km\) is closer/)).toBeInTheDocument();
    await toHindi();

    expect(locateStatus()).toHaveTextContent(t("hi", "locDetected", { lat: "29.3929", lon: "79.4542" }));
    expect(screen.getByText(t("hi", "hospDistance", { km: "4.6" }))).toBeInTheDocument();
    // hazard name and severity in Hindi too, not "flood" / "(CRITICAL)"
    const note = screen.getByText(/Riverside Clinic \(0\.4 किमी\)/);
    expect(note).toHaveTextContent("बाढ़");
    expect(note).toHaveTextContent(`(${t("hi", "riskCRITICAL")})`);
    expect(note.textContent).not.toMatch(/CRITICAL|flood/);
    expect(screen.getByRole("link", { name: t("hi", "hospDirections") })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "English" }));
    expect(locateStatus()).toHaveTextContent("Location detected (29.3929, 79.4542).");
  });
});

describe("i18n strings", () => {
  /** Keys whose Hindi may legitimately equal the English (e.g. a brand name). Empty today. */
  const SAME_IN_BOTH = new Set<StringKey>([]);

  it("has a real Hindi value for every key, never an English copy", () => {
    for (const key of STRING_KEYS) {
      if (SAME_IN_BOTH.has(key)) continue;
      expect(t("hi", key), key).not.toBe(t("en", key));
      expect(t("hi", key), key).toMatch(DEVANAGARI);
    }
  });

  it("keeps the same {placeholders} in both languages", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const key of STRING_KEYS) expect(names(t("hi", key)), key).toEqual(names(t("en", key)));
  });

  it("quotes the real 'Get My Location' button label in each language", () => {
    for (const lang of ["en", "hi"] as const) {
      for (const key of ["sosHintNeedLocation", "locNeedSilent"] as const) {
        expect(t(lang, key), `${lang}.${key}`).toContain(`“${t(lang, "getLocation")}”`);
      }
    }
  });

  it("fills params literally and leaves unknown placeholders alone", () => {
    expect(t("en", "locDenied", { msg: "a $& b {lat}" })).toBe(
      "Could not get location: a $& b {lat}. Please enable location access and try again.",
    );
    expect(t("en", "locDetected", { lat: "1" })).toBe("Location detected (1, {lon}).");
    expect(t("en", "locDetected")).toBe("Location detected ({lat}, {lon}).");
  });
});
