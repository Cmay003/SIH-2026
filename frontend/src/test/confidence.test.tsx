// Per-alert confidence (server.js stores what the AI backend returns, see
// server/confidence.js) and the two new hazard types "flash_flood" and
// "smoke": wording, icons, where it shows, and that it never re-orders an
// alert list (severity order is unchanged).
import { render, screen, within } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it } from "vitest";
import type { Hazard, HazardZone } from "../api/types";
import { Confidence } from "../components/Confidence";
import { CriticalHazard, HazardList, SensorTable } from "../components/dashboard";
import { EmergencyAlarm } from "../components/EmergencyAlarm";
import { ADVICE, hazardActions, hazardName } from "../lib/advice";
import { alarmingItems, alarmItemsFromHazards, alarmItemsFromZones, hazardTitle } from "../lib/alarm";
import { confidenceLevel, confidenceReasons, confidenceText, hasConfidence, hazardIcon, hazardTypeText } from "../lib/hazards";

const hazard = (over: Partial<Hazard> = {}): Hazard => ({
  label: "Hazard 1", node_id: "NODE-04", location: "Sector 4", hazard_type: "flood", severity: "HIGH",
  risk_score: 0.82, latitude: 29.39, longitude: 79.45, eta_minutes: null, predicted_time: null,
  prediction_text: "Stable", ...over,
});
const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82, latitude: 29.39,
  longitude: 79.45, radius_m: 1000, confirmed: true, ...over,
});
const HIGH = { confidence: 0.82, confidence_label: "High" as const, confidence_reasons: ["confirmed by repeat reading", "node edge verdict agrees", "sensor data clean", "model calibrated"] };
const LOW = { confidence: 0.31, confidence_label: "Low" as const, confidence_reasons: ["waiting for confirmation"] };

async function violations(container: HTMLElement) {
  const result = await axe.run(container, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
  });
  return result.violations.map((v) => v.id);
}

describe("confidence wording", () => {
  it("label and percent, either one alone, or nothing", () => {
    expect(confidenceText(HIGH)).toBe("Confidence: High (82%)");
    expect(confidenceText({ confidence_label: "Medium" })).toBe("Confidence: Medium");
    expect(confidenceText({ confidence: 0.5 })).toBe("Confidence: 50%");
    expect(confidenceText({})).toBeNull();
    expect(confidenceText(null)).toBeNull();
    expect(confidenceText({ confidence: null, confidence_label: null, confidence_reasons: null })).toBeNull();
    expect(hasConfidence(HIGH)).toBe(true);
    expect(hasConfidence({ confidence_reasons: ["x"] })).toBe(false); // reasons without a score say nothing
  });

  it("never shows a value outside the contract", () => {
    expect(confidenceText({ confidence: 1.7 })).toBeNull();
    expect(confidenceText({ confidence: -0.2 })).toBeNull();
    expect(confidenceText({ confidence: Number.NaN })).toBeNull();
    // a label the contract does not have is ignored, the score still shows
    expect(confidenceText({ confidence: 0.4, confidence_label: "Sure" as never })).toBe("Confidence: 40%");
    expect(confidenceLevel({ confidence_label: "Sure" as never })).toBeNull();
  });

  it("reasons: non-empty strings only, capped", () => {
    expect(confidenceReasons(HIGH, 3)).toEqual(HIGH.confidence_reasons.slice(0, 3));
    expect(confidenceReasons({ confidence_reasons: ["a", " ", "" , 5 as never, "b"] })).toEqual(["a", "b"]);
    expect(confidenceReasons({ confidence_reasons: null })).toEqual([]);
  });
});

describe("<Confidence>", () => {
  it("shows label, percent and reasons; Low is marked as such", () => {
    const { container, rerender } = render(<Confidence value={HIGH} maxReasons={2} />);
    expect(screen.getByText("Confidence: High (82%)")).toBeInTheDocument();
    expect(screen.getByText("confirmed by repeat reading; node edge verdict agrees")).toBeInTheDocument();
    expect(container.querySelector("[data-confidence]")).toHaveAttribute("data-confidence", "High");
    rerender(<Confidence value={LOW} />);
    expect(screen.getByText("Confidence: Low (31%)")).toBeInTheDocument();
    expect(container.querySelector("[data-confidence]")).toHaveAttribute("data-confidence", "Low");
  });

  it("renders nothing for an alert stored before the score existed", () => {
    const { container } = render(<Confidence value={{ confidence: null, confidence_label: null, confidence_reasons: null }} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe("dashboard cards", () => {
  it("hazard card and top-hazard callout show the confidence with up to 3 reasons", async () => {
    const { container } = render(
      <>
        <CriticalHazard hazard={hazard({ severity: "CRITICAL", ...LOW })} />
        <HazardList hazards={[hazard({ node_id: "N2", ...HIGH })]} />
      </>,
    );
    expect(screen.getByText("Confidence: Low (31%)")).toBeInTheDocument();
    expect(screen.getByText("Confidence: High (82%)")).toBeInTheDocument();
    expect(screen.getByText("confirmed by repeat reading; node edge verdict agrees; sensor data clean")).toBeInTheDocument();
    expect(screen.queryByText(/model calibrated/)).not.toBeInTheDocument();
    expect(await violations(container)).toEqual([]);
  });

  it("an old hazard without a score shows no confidence line at all", () => {
    render(<HazardList hazards={[hazard()]} />);
    expect(screen.queryByText(/Confidence/)).not.toBeInTheDocument();
  });

  it("flash flood and smoke get their own icon and a readable title", () => {
    render(<HazardList hazards={[hazard({ hazard_type: "flash_flood" }), hazard({ node_id: "N2", hazard_type: "smoke" })]} />);
    expect(screen.getByRole("heading", { name: /Hazard 1: FLASH FLOOD/ })).toHaveTextContent(hazardIcon("flash_flood"));
    expect(screen.getByRole("heading", { name: /Hazard 1: SMOKE/ })).toHaveTextContent(hazardIcon("smoke"));
  });

  it("sensor table shows 'flash flood', not the raw id", () => {
    render(<SensorTable rows={[{ id: 1, device_id: "N1", hazard: "flash_flood", water_level: 1, temperature: 20,
      humidity: 50, risk: "HIGH", risk_score: 0.7, timestamp: "2026-10-09T10:00:00Z" }]} />);
    expect(screen.getByRole("cell", { name: "flash flood" })).toBeInTheDocument();
  });
});

describe("emergency alarm", () => {
  it("carries the confidence onto the alarm item, only when there is one", () => {
    const [withScore] = alarmItemsFromHazards([hazard(HIGH)]);
    expect(withScore.confidence).toEqual({ confidence: 0.82, confidence_label: "High", confidence_reasons: HIGH.confidence_reasons });
    const [without] = alarmItemsFromHazards([hazard()]);
    expect("confidence" in without).toBe(false);
    const [fromZone] = alarmItemsFromZones([zone(LOW)]);
    expect(fromZone.confidence?.confidence_label).toBe("Low");
  });

  it("severity order is unchanged: a Low-confidence CRITICAL stays above a High-confidence HIGH", () => {
    const items = alarmItemsFromHazards([
      hazard({ node_id: "A", severity: "HIGH", risk_score: 0.95, ...HIGH }),
      hazard({ node_id: "B", severity: "CRITICAL", risk_score: 0.6, ...LOW }),
    ]);
    expect(alarmingItems(items, {}).map((i) => i.nodeId)).toEqual(["B", "A"]);
  });

  it("pop-up shows the confidence line for each hazard", async () => {
    const items = alarmItemsFromHazards([hazard({ severity: "CRITICAL", hazard_type: "flash_flood", ...LOW })]);
    render(<EmergencyAlarm items={items} />);
    const dialog = screen.getByRole("alertdialog");
    expect(within(dialog).getByRole("heading", { name: "Flash flood" })).toBeInTheDocument();
    expect(within(dialog).getByText("Confidence: Low (31%)")).toBeInTheDocument();
    expect(within(dialog).getByText("waiting for confirmation")).toBeInTheDocument();
    expect(await violations(dialog)).toEqual([]);
  });
});

describe("new hazard types", () => {
  it("icons: distinct from flood / fire / air pollution, any spelling of the type", () => {
    const ff = hazardIcon("flash_flood");
    const sm = hazardIcon("smoke");
    for (const other of ["flood", "fire", "air pollution", "unknown"]) {
      expect(ff).not.toBe(hazardIcon(other));
      expect(sm).not.toBe(hazardIcon(other));
    }
    expect(hazardIcon("Flash flood")).toBe(ff); // the alarm passes its title
    expect(hazardIcon("flash flood")).toBe(ff);
    expect(hazardIcon("constructor")).toBe(hazardIcon("unknown"));
  });

  it("titles read naturally", () => {
    expect(hazardTitle("flash_flood")).toBe("Flash flood");
    expect(hazardTypeText("flash_flood")).toBe("flash flood");
    expect(hazardTypeText("gas leak")).toBe("gas leak");
  });

  it("citizen advice comes from the shared table (data/hazard_advice.json)", () => {
    expect(hazardName("flash_flood", "en")).toBe(ADVICE.hazards.flash_flood.name.en);
    expect(hazardName("smoke", "en")).toBe(ADVICE.hazards.smoke.name.en);
    expect(hazardActions("flash_flood", "CRITICAL", "en")).toEqual(ADVICE.hazards.flash_flood.actions.HIGH.en);
    expect(hazardActions("smoke", "MEDIUM", "hi")).toEqual(ADVICE.hazards.smoke.actions.MEDIUM.hi);
  });
});
