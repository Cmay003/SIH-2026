// Problems found by the real-browser check (step W2, headless Edge at 360
// and 1366 px against a fresh demo stack) - each test pins one fix.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import type L from "leaflet";
import { MapContainer } from "react-leaflet";
import { describe, expect, it } from "vitest";
import type { HazardZone, SosRequest, SummaryResponse } from "../api/types";
import { Confidence } from "../components/Confidence";
import { HazardZones, SosMarkers } from "../components/officerMap";
import { hospitalZoneNote, joinReasons } from "../lib/hazards";
import { bannerNotes, nodeHoursText, summaryCsv, summaryNodeIds } from "../lib/trends";
import { Providers } from "../Providers";

describe("map markers have their title as the accessible name", () => {
  // Leaflet makes every marker a focusable role="button"; its name came from
  // the emoji inside ("🌊", "📍 W") - Edge's accessibility tree showed that.
  const zone: HazardZone = {
    node_id: "NODE-04", hazard_type: "flood", severity: "CRITICAL", risk_score: 0.9,
    latitude: 29.39, longitude: 79.45, radius_m: 1000, confirmed: true,
  };
  const sos: SosRequest = {
    id: 30, latitude: 29.39, longitude: 79.45, location_source: "hotspot", note: null, status: "open",
    timestamp: new Date().toISOString(), escalated: true, minutes_open: 19, nearest_hospital: "H", hospital_distance_km: 1,
    hospital_route_url: "https://maps.example/h", responder_route_url: "https://maps.example/r",
  };

  it("hazard and SOS markers", () => {
    const refs = { current: new Map<string, L.Marker>() };
    render(
      <Providers>
        <MapContainer center={[29.39, 79.45]} zoom={12}>
          <HazardZones zones={[zone]} markerRefs={refs} />
          <SosMarkers requests={[sos]} markerRefs={refs} />
        </MapContainer>
      </Providers>,
    );
    expect(screen.getByRole("button", { name: "flood CRITICAL at NODE-04" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^SOS #30, escalated/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /🌊|📍/u })).toBeNull();
  });
});

describe("confidence reasons read as one sentence", () => {
  it("lower-cases a following reason's first word, but not an ID or acronym", () => {
    expect(joinReasons(["Confirmed: the same node measured it again", "Node's own check also flags it (URGENT)"]))
      .toBe("Confirmed: the same node measured it again; node's own check also flags it (URGENT)");
    expect(joinReasons(["Rising fast", "NODE-07 upstream agrees", "IMD criteria met"]))
      .toBe("Rising fast; NODE-07 upstream agrees; IMD criteria met");
    expect(joinReasons([])).toBe("");
  });

  it("<Confidence> uses it", () => {
    render(<Confidence value={{ confidence: 0.8, confidence_label: "High",
      confidence_reasons: ["Confirmed: repeat reading", "Node's own check agrees (URGENT)"] }} />);
    expect(screen.getByText("Confirmed: repeat reading; node's own check agrees (URGENT)")).toBeInTheDocument();
  });
});

describe("hospital note grammar", () => {
  it("an extreme heat zone, a flash flood zone (no underscore)", () => {
    expect(hospitalZoneNote({ hospital_skipped: { hospital: "B.D. Pandey", distance_km: 1.11, hazard_type: "extreme heat", severity: "CRITICAL" } }))
      .toBe("nearer B.D. Pandey (1.11 km) skipped: inside an extreme heat zone (CRITICAL)");
    expect(hospitalZoneNote({ hospital_in_hazard_zone: { hazard_type: "flash_flood", severity: "HIGH" } }))
      .toBe("every hospital is in a hazard zone; this one is in a flash flood zone (HIGH)");
    expect(hospitalZoneNote({ hospital_in_hazard_zone: { hazard_type: "air pollution", severity: "HIGH" } }))
      .toMatch(/in an air pollution zone/);
  });
});

describe("district report node-hours ceiling", () => {
  // was a fixed "(10 nodes over 7 days = up to 1,680 node-hours)" on every report
  it("uses this report's node count and range", () => {
    expect(nodeHoursText(3, "7d")).toBe("node-hours, summed over all nodes (3 nodes over 7 days = up to 504 node-hours), not clock hours.");
    expect(nodeHoursText(1, "30d")).toBe("node-hours, summed over all nodes (1 node over 30 days = up to 720 node-hours), not clock hours.");
    expect(nodeHoursText(10, "30d")).toContain("up to 7,200 node-hours");
    expect(nodeHoursText(0, "7d")).toBe("node-hours, summed over all nodes (up to 24 per node per day), not clock hours.");
  });

  it("the CSV says the same", () => {
    const s: SummaryResponse = {
      range: "7d", generated_at: "2026-10-09T12:00:00Z", alerts_by_hazard: {},
      alerts_by_node: { "NODE-A": { count: 1, max_severity: "HIGH" } },
      exceedance_hours: {}, top_hotspots: [], node_uptime_pct: { "NODE-A": 90, "NODE-B": 80 },
    };
    expect(summaryNodeIds(s)).toEqual(["NODE-A", "NODE-B"]);
    expect(summaryCsv(s)).toContain("# exceedance_hours value: node-hours, summed over all nodes (2 nodes over 7 days = up to 336 node-hours)");
  });
});

describe("trends banner data notes", () => {
  it("labels each note with its section; one note when both agree; none when absent", () => {
    expect(bannerNotes("30 of 30 readings simulated", "90 of 90 readings simulated")).toEqual([
      { label: "Node trends", text: "30 of 30 readings simulated" },
      { label: "District summary", text: "90 of 90 readings simulated" },
    ]);
    expect(bannerNotes("same", "same")).toEqual([{ label: "Node trends and district summary", text: "same" }]);
    expect(bannerNotes(null, " ")).toEqual([]);
    expect(bannerNotes(undefined, "x")).toEqual([{ label: "District summary", text: "x" }]);
  });
});

describe("light palette where the background is always white", () => {
  // CSS cannot be rendered in jsdom; these pin the token resets the browser
  // check measured (contrast before -> after, see the comments in the CSS).
  const css = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8").replace(/\r\n/g, "\n");
  const block = (text: string, start: RegExp): string => {
    const i = text.search(start);
    expect(i).toBeGreaterThanOrEqual(0);
    let depth = 0;
    for (let j = text.indexOf("{", i); j < text.length; j++) {
      if (text[j] === "{") depth++;
      else if (text[j] === "}" && --depth === 0) return text.slice(i, j + 1);
    }
    throw new Error("unclosed block");
  };
  const tokens = (text: string) => new Map([...text.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const NOT_COLOUR_OF_CONTENT = /^--(shadow|overlay|focus|toast)/;

  it("print resets every content colour the dark theme changes, to the light value", () => {
    const g = css("../styles/global.css");
    const light = tokens(block(g, /:root\s*\{/));
    const dark = tokens(block(g, /@media \(prefers-color-scheme: dark\)/));
    const print = tokens(block(g, /@media print/));
    for (const name of dark.keys()) {
      if (NOT_COLOUR_OF_CONTENT.test(name)) continue;
      expect(print.has(name), `${name} missing from @media print`).toBe(true);
      const l = light.get(name);
      // --page-bg is plain white on paper on purpose
      if (name !== "--page-bg" && l && /^#[0-9a-f]{3,8}$/i.test(l)) expect(print.get(name), name).toBe(l);
    }
  });

  it("Leaflet popups (always white) use light values for the shared components' tokens", () => {
    const popup = tokens(block(css("../components/Officer.module.css"), /\.popup\s*\{/));
    for (const name of ["--surface", "--text", "--text-muted", "--link", "--link-hover", "--border-strong", "--green-lighter",
      "--warning-text", "--warning-bg", "--danger"]) {
      expect(popup.has(name), `${name} missing from .popup`).toBe(true);
    }
    expect(popup.get("--text-muted")).toBe("#5f6b60"); // 5.6:1 on white; the dark value was 2.3:1
  });
});
