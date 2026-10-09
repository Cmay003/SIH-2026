// Emergency alarm: decision logic (pure), the Web Audio siren (fake
// AudioContext) and the pop-up component (siren module mocked).
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Hazard, HazardZone } from "../api/types";
import { AlarmSoundToggle, EmergencyAlarm } from "../components/EmergencyAlarm";
import {
  ACK_HOLD_MS,
  ACK_STORAGE_KEY,
  acknowledgeItems,
  ALERT_TITLE_PREFIX,
  alarmingItems,
  alarmItemsFromHazards,
  alarmItemsFromZones,
  alarmSoundPref,
  hazardTitle,
  readAcks,
  refreshAcks,
  SOUND_STORAGE_KEY,
  writeAcks,
  type AckMap,
  type AlarmItem,
} from "../lib/alarm";
import { hazardKey } from "../components/dashboard";

// ---- siren mock: records start/stop, simulates the browser audio lock ----
const sirenMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { unlocked: true, supported: true };
  const notify = () => listeners.forEach((l) => l());
  return {
    state,
    notify,
    isSupported: () => state.supported,
    isUnlocked: () => state.unlocked,
    unlock: vi.fn(async () => {
      if (!state.unlocked) {
        state.unlocked = true;
        notify();
      }
      return true;
    }),
    start: vi.fn(),
    stop: vi.fn(),
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
});
vi.mock("../lib/siren", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/siren")>()),
  siren: sirenMock,
}));

const item = (over: Partial<AlarmItem> = {}): AlarmItem => ({
  key: "NODE-04|flood",
  severity: "HIGH",
  title: "Flood",
  location: "Sector 4",
  nodeId: "NODE-04",
  riskScore: 0.82,
  detail: "Stable at current readings - no imminent escalation predicted",
  ...over,
});

const hazard = (over: Partial<Hazard> = {}): Hazard => ({
  label: "Hazard 1", node_id: "NODE-04", location: "Sector 4", hazard_type: "flood", severity: "HIGH",
  risk_score: 0.82, latitude: 29.39, longitude: 79.45, eta_minutes: null, predicted_time: null,
  prediction_text: "Stable", ...over,
});

const zone = (over: Partial<HazardZone> = {}): HazardZone => ({
  node_id: "NODE-04", hazard_type: "flood", severity: "HIGH", risk_score: 0.82, latitude: 29.39,
  longitude: 79.45, radius_m: 1000, confirmed: true, ...over,
});

/** key -> acknowledged severity (drops the lastSeen timestamps) */
const severities = (acks: AckMap) => Object.fromEntries(Object.entries(acks).map(([k, v]) => [k, v.severity]));

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  alarmSoundPref.reset();
  sirenMock.state.unlocked = true;
  sirenMock.state.supported = true;
  sirenMock.start.mockClear();
  sirenMock.stop.mockClear();
  sirenMock.unlock.mockClear();
  document.title = "SANJEEVNI";
});
afterEach(() => {
  vi.restoreAllMocks();
});

// ======================================================================
describe("alarm decision logic", () => {
  it("a new HIGH/CRITICAL item alarms", () => {
    expect(alarmingItems([item()], {})).toHaveLength(1);
  });

  it("an acknowledged item does not alarm again at the same or lower severity", () => {
    const acks = acknowledgeItems({}, [item({ severity: "CRITICAL" })]);
    expect(alarmingItems([item({ severity: "CRITICAL" })], acks)).toEqual([]);
    expect(alarmingItems([item({ severity: "HIGH" })], acks)).toEqual([]);
  });

  it("HIGH -> CRITICAL escalation alarms again", () => {
    const acks = acknowledgeItems({}, [item({ severity: "HIGH" })]);
    expect(alarmingItems([item({ severity: "CRITICAL" })], acks)).toHaveLength(1);
    // acknowledging never lowers the stored severity
    const stored: AckMap = { [item().key]: { severity: "CRITICAL", lastSeen: 0 } };
    expect(severities(acknowledgeItems(stored, [item({ severity: "HIGH" })], 1000))).toEqual({ [item().key]: "CRITICAL" });
  });

  it("a hazard that dips below HIGH for a poll does not alarm again when it returns", () => {
    const t = 1_000_000;
    let acks = acknowledgeItems({}, [item()], t);
    acks = refreshAcks(acks, [], t + 5_000); // one MEDIUM reading: not in the alarm items
    expect(alarmingItems([item()], acks)).toEqual([]); // back to HIGH at t+10s: still acknowledged
    expect(severities(acks)).toEqual({ [item().key]: "HIGH" });
  });

  it("forgets an acknowledgement once the hazard has been gone longer than the hold-off", () => {
    const t = 1_000_000;
    const acks = refreshAcks(acknowledgeItems({}, [item()], t), [], t + ACK_HOLD_MS + 1);
    expect(acks).toEqual({});
    expect(alarmingItems([item()], acks)).toHaveLength(1); // a real recurrence alarms again
  });

  it("a hazard that stays active keeps its acknowledgement fresh", () => {
    const t = 1_000_000;
    let acks = acknowledgeItems({}, [item()], t);
    acks = refreshAcks(acks, [item()], t + ACK_HOLD_MS - 1_000);
    expect(acks[item().key].lastSeen).toBe(t + ACK_HOLD_MS - 1_000);
    acks = refreshAcks(acks, [item()], t + 2 * ACK_HOLD_MS - 2_000);
    expect(alarmingItems([item()], acks)).toEqual([]);
  });

  it("an acknowledged HIGH hazard still alarms when it escalates to CRITICAL", () => {
    const t = 1_000_000;
    const acks = refreshAcks(acknowledgeItems({}, [item()], t), [item({ severity: "CRITICAL" })], t + 5_000);
    expect(alarmingItems([item({ severity: "CRITICAL" })], acks)).toHaveLength(1);
  });

  it("a CRITICAL ack lowers to HIGH after the hazard stays HIGH past the hold-off, so a later CRITICAL alarms", () => {
    const t = 1_000_000;
    let acks = acknowledgeItems({}, [item({ severity: "CRITICAL" })], t);
    acks = refreshAcks(acks, [item({ severity: "HIGH" })], t + 5_000); // lowerSince set
    expect(acks[item().key]).toMatchObject({ severity: "CRITICAL", lowerSince: t + 5_000 });
    acks = refreshAcks(acks, [item({ severity: "HIGH" })], t + 5_000 + ACK_HOLD_MS / 2); // still HIGH (lastSeen refreshed)
    expect(severities(acks)).toEqual({ [item().key]: "CRITICAL" });
    acks = refreshAcks(acks, [item({ severity: "HIGH" })], t + 5_000 + ACK_HOLD_MS); // settled at HIGH
    expect(severities(acks)).toEqual({ [item().key]: "HIGH" });
    expect(acks[item().key].lowerSince).toBeUndefined();
    expect(alarmingItems([item({ severity: "HIGH" })], acks)).toEqual([]);
    expect(alarmingItems([item({ severity: "CRITICAL" })], acks)).toHaveLength(1);
  });

  it("a short CRITICAL -> HIGH -> CRITICAL flicker stays acknowledged", () => {
    const t = 1_000_000;
    let acks = acknowledgeItems({}, [item({ severity: "CRITICAL" })], t);
    acks = refreshAcks(acks, [item({ severity: "HIGH" })], t + 5_000);
    acks = refreshAcks(acks, [item({ severity: "CRITICAL" })], t + 60_000); // lowerSince cleared
    expect(alarmingItems([item({ severity: "CRITICAL" })], acks)).toEqual([]);
    expect(acks[item().key].lowerSince).toBeUndefined();
    expect(severities(acks)).toEqual({ [item().key]: "CRITICAL" });
  });

  it("re-acknowledging at a lower severity keeps the CRITICAL ack and its lowerSince", () => {
    const t = 1_000_000;
    let acks = acknowledgeItems({}, [item({ severity: "CRITICAL" })], t);
    acks = refreshAcks(acks, [item({ severity: "HIGH" })], t + 5_000);
    acks = acknowledgeItems(acks, [item({ severity: "HIGH" })], t + 6_000);
    expect(acks[item().key]).toEqual({ severity: "CRITICAL", lastSeen: t + 6_000, lowerSince: t + 5_000 });
  });

  it("an acknowledgement stamped in the future (clock moved back) is re-stamped, then expires normally", () => {
    const t = 1_000_000_000;
    const acks = acknowledgeItems({}, [item()], t);
    const back = t - 3_600_000; // clock jumped back an hour
    const next = refreshAcks(acks, [], back);
    expect(next[item().key].lastSeen).toBe(back);
    expect(refreshAcks(next, [], back + ACK_HOLD_MS + 1)).toEqual({});
  });

  it("readAcks clamps a future lastSeen and keeps a valid lowerSince", () => {
    const future = Date.now() + 3_600_000;
    sessionStorage.setItem(
      ACK_STORAGE_KEY,
      JSON.stringify({
        a: { severity: "HIGH", lastSeen: future },
        b: { severity: "CRITICAL", lastSeen: 5, lowerSince: 4 },
        c: { severity: "CRITICAL", lastSeen: 5, lowerSince: "x" },
      }),
    );
    const read = readAcks();
    expect(read.a.lastSeen).toBeLessThanOrEqual(Date.now());
    expect(read.b).toEqual({ severity: "CRITICAL", lastSeen: 5, lowerSince: 4 });
    expect(read.c).toEqual({ severity: "CRITICAL", lastSeen: 5 });
  });

  it("stale hazards and zones (node stopped reporting) never alarm", () => {
    const fromHazards = alarmItemsFromHazards([
      hazard({ node_id: "S1", severity: "CRITICAL", stale: true }),
      hazard({ node_id: "S2", severity: "HIGH", stale: true }),
      hazard({ node_id: "F1", severity: "CRITICAL", stale: false }),
      hazard({ node_id: "U1", severity: "HIGH" }),
    ]);
    expect(fromHazards.map((i) => i.nodeId).sort()).toEqual(["F1", "U1"]);
    const fromZones = alarmItemsFromZones([
      zone({ node_id: "S1", severity: "CRITICAL", stale: true }),
      zone({ node_id: "S2", severity: "HIGH", stale: true }),
      zone({ node_id: "F1", severity: "CRITICAL", stale: false }),
      zone({ node_id: "U1", severity: "HIGH" }),
    ]);
    expect(fromZones.map((i) => i.nodeId).sort()).toEqual(["F1", "U1"]);
  });

  it("refreshAcks returns the same object when nothing changed", () => {
    const t = 1_000_000;
    const acks = acknowledgeItems({}, [item()], t);
    expect(refreshAcks(acks, [item()], t + 5_000)).toBe(acks); // lastSeen updates are throttled
    expect(refreshAcks(acks, [], t + 5_000)).toBe(acks); // missing, but within the hold-off
    expect(refreshAcks({}, [item()], t)).toEqual({});
  });

  it("the dashboard's hazard key matches the alarm item key", () => {
    const h = hazard({ hazard_type: "gas leak" });
    expect(alarmItemsFromHazards([h])[0].key).toBe(hazardKey(h));
  });

  it("orders most severe first: CRITICAL before HIGH, then risk score", () => {
    const a = item({ key: "A|flood", severity: "HIGH", riskScore: 0.95 });
    const b = item({ key: "B|fire", severity: "CRITICAL", riskScore: 0.7 });
    const c = item({ key: "C|fire", severity: "CRITICAL", riskScore: 0.9 });
    const d = item({ key: "D|fire", severity: "HIGH", riskScore: null });
    expect(alarmingItems([a, d, b, c], {}).map((i) => i.key)).toEqual(["C|fire", "B|fire", "A|flood", "D|fire"]);
  });

  it("zones: only confirmed HIGH/CRITICAL zones, location = node id, no detail", () => {
    const items = alarmItemsFromZones([
      zone(),
      zone({ node_id: "N2", confirmed: false, severity: "CRITICAL" }),
      zone({ node_id: "N3", severity: "MEDIUM" }),
      zone({ node_id: "N4", hazard_type: "gas leak", severity: "CRITICAL", risk_score: 0.91 }),
    ]);
    expect(items.map((i) => i.key)).toEqual(["NODE-04|flood", "N4|gas leak"]);
    expect(items[1]).toEqual({ key: "N4|gas leak", severity: "CRITICAL", title: "Gas leak", location: "N4", nodeId: "N4",
                               riskScore: 0.91, detail: null });
  });

  it("hazards: keeps HIGH/CRITICAL, maps location and prediction text", () => {
    const items = alarmItemsFromHazards([hazard(), hazard({ node_id: "N2", severity: "MEDIUM" }), hazard({ node_id: "N3", severity: "LOW" })]);
    expect(items).toEqual([{ key: "NODE-04|flood", severity: "HIGH", title: "Flood", location: "Sector 4", nodeId: "NODE-04",
                             riskScore: 0.82, detail: "Stable" }]);
  });

  it("de-duplicates a repeated key, keeping the more severe entry", () => {
    const items = alarmItemsFromHazards([hazard(), hazard({ severity: "CRITICAL" })]);
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("CRITICAL");
  });

  it("writes hazard types in words", () => {
    expect(hazardTitle("flood")).toBe("Flood");
    expect(hazardTitle("extreme_heat")).toBe("Extreme heat");
    expect(hazardTitle("")).toBe("Hazard");
  });

  it("acknowledgements survive storage that throws or holds junk", () => {
    sessionStorage.setItem(ACK_STORAGE_KEY, "{not json");
    expect(readAcks()).toEqual({});
    sessionStorage.setItem(
      ACK_STORAGE_KEY,
      JSON.stringify({
        a: "CRITICAL", // older format: migrated
        b: "LOW",
        c: 3,
        d: { severity: "HIGH", lastSeen: 5 },
        e: { severity: "HIGH" },
        f: { severity: "MEDIUM", lastSeen: 5 },
      }),
    );
    const read = readAcks();
    expect(severities(read)).toEqual({ a: "CRITICAL", d: "HIGH" });
    expect(read.d.lastSeen).toBe(5);
    expect(typeof read.a.lastSeen).toBe("number");
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(readAcks()).toEqual({});
    expect(() => writeAcks({ a: { severity: "HIGH", lastSeen: 0 } })).not.toThrow();
  });
});

// ======================================================================
describe("Web Audio siren", () => {
  class FakeParam {
    value = 0;
    setValueAtTime = vi.fn((v: number) => {
      this.value = v;
    });
    linearRampToValueAtTime = vi.fn();
    cancelScheduledValues = vi.fn();
  }
  class FakeNode {
    connect = vi.fn();
    disconnect = vi.fn();
  }
  class FakeOsc extends FakeNode {
    type = "sine";
    frequency = new FakeParam();
    start = vi.fn();
    stop = vi.fn();
    onended: (() => void) | null = null;
  }
  class FakeGain extends FakeNode {
    gain = new FakeParam();
  }
  class FakeCtx {
    static last: FakeCtx | null = null;
    state = "suspended";
    currentTime = 0;
    destination = {};
    oscs: FakeOsc[] = [];
    gains: FakeGain[] = [];
    resume = vi.fn(async () => {
      this.state = "running";
    });
    addEventListener = vi.fn();
    constructor() {
      FakeCtx.last = this;
    }
    createOscillator() {
      const o = new FakeOsc();
      this.oscs.push(o);
      return o;
    }
    createGain() {
      const g = new FakeGain();
      this.gains.push(g);
      return g;
    }
  }

  it("is locked until unlock(), then wails 650-1250 Hz about once a second and stops", async () => {
    const { createWebAudioSiren } = await vi.importActual<typeof import("../lib/siren")>("../lib/siren");
    const s = createWebAudioSiren({ AudioContext: FakeCtx as unknown as new () => AudioContext });
    expect(s.isSupported()).toBe(true);
    expect(s.isUnlocked()).toBe(false);
    s.start(); // locked: nothing happens
    expect(FakeCtx.last).toBeNull();

    const listener = vi.fn();
    s.subscribe(listener);
    expect(await s.unlock()).toBe(true);
    expect(listener).toHaveBeenCalled();

    s.start();
    s.start(); // idempotent
    const ctx = FakeCtx.last!;
    expect(ctx.oscs).toHaveLength(2);
    const [tone, lfo] = ctx.oscs;
    const [depth, out] = ctx.gains;
    expect(tone.frequency.value).toBe(950); // centre
    expect(depth.gain.value).toBe(300); // +-300 Hz -> 650..1250
    expect(lfo.frequency.value).toBe(1); // one sweep per second
    expect(out.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.2, expect.any(Number));
    expect(tone.start).toHaveBeenCalled();

    s.stop();
    expect(tone.stop).toHaveBeenCalled();
    expect(lfo.stop).toHaveBeenCalled();
    s.stop(); // no-op
    expect(tone.stop).toHaveBeenCalledTimes(1);
  });

  it("without Web Audio it is unsupported and silent", async () => {
    const { createWebAudioSiren } = await vi.importActual<typeof import("../lib/siren")>("../lib/siren");
    const s = createWebAudioSiren({});
    expect(s.isSupported()).toBe(false);
    expect(await s.unlock()).toBe(false);
    expect(() => {
      s.start();
      s.stop();
    }).not.toThrow();
  });
});

// ======================================================================
describe("EmergencyAlarm pop-up", () => {
  it("opens an alertdialog with the hazard details and focuses Acknowledge", async () => {
    render(<EmergencyAlarm items={[item()]} />);
    const dialog = screen.getByRole("alertdialog", { name: "Emergency alert" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleDescription(/Flood: HIGH risk at Sector 4 \(NODE-04\)/);
    expect(within(dialog).getByRole("heading", { name: "Flood" })).toBeInTheDocument();
    expect(within(dialog).getByText("82%")).toBeInTheDocument();
    expect(within(dialog).getByText(/Stable at current readings/)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge" })).toHaveFocus());
    expect(sirenMock.start).toHaveBeenCalledTimes(1);
  });

  it("has no axe violations", async () => {
    render(<EmergencyAlarm items={[item(), item({ key: "N2|fire", title: "Fire", severity: "CRITICAL" })]} onShow={() => {}} />);
    const result = await axe.run(screen.getByRole("alertdialog"), {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
      rules: { "color-contrast": { enabled: false }, region: { enabled: false } },
    });
    expect(result.violations.map((v) => v.id)).toEqual([]);
  });

  it("Acknowledge closes the dialog, stops the siren and is remembered across reloads", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<EmergencyAlarm items={[item()]} />);
    sirenMock.stop.mockClear();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.stop).toHaveBeenCalled();
    expect(JSON.parse(sessionStorage.getItem(ACK_STORAGE_KEY)!)).toEqual({
      "NODE-04|flood": { severity: "HIGH", lastSeen: expect.any(Number) },
    });

    // reload: the feed is empty while loading, then the same hazard arrives
    unmount();
    sirenMock.start.mockClear();
    const { rerender } = render(<EmergencyAlarm items={[]} />);
    rerender(<EmergencyAlarm items={[item()]} />);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("Escape acknowledges", async () => {
    const user = userEvent.setup();
    render(<EmergencyAlarm items={[item()]} />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge" })).toHaveFocus());
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(severities(readAcks())).toEqual({ "NODE-04|flood": "HIGH" });
  });

  it("re-alarms on escalation and when an ended hazard recurs", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EmergencyAlarm items={[item()]} />);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));

    rerender(<EmergencyAlarm items={[item({ severity: "CRITICAL" })]} />);
    expect(screen.getByRole("alertdialog", { name: "Critical hazard alert" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));

    rerender(<EmergencyAlarm items={[]} />); // hazard ended...
    expect(severities(readAcks())).toEqual({ "NODE-04|flood": "CRITICAL" }); // ...kept during the hold-off
    const later = Date.now() + ACK_HOLD_MS + 60_000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    rerender(<EmergencyAlarm items={[]} />); // still gone after the hold-off
    await waitFor(() => expect(readAcks()).toEqual({}));
    rerender(<EmergencyAlarm items={[item()]} />); // ...and is back
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("does not re-alarm when an acknowledged hazard flickers out of the feed for a poll", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<EmergencyAlarm items={[item()]} />);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    sirenMock.start.mockClear();
    rerender(<EmergencyAlarm items={[]} />); // one MEDIUM reading
    rerender(<EmergencyAlarm items={[item()]} />); // HIGH again
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("lists several items most severe first and acknowledges them all", async () => {
    const user = userEvent.setup();
    render(
      <EmergencyAlarm
        items={[item(), item({ key: "N2|fire", title: "Fire", nodeId: "N2", location: "N2", severity: "CRITICAL", riskScore: 0.6 })]}
      />,
    );
    const titles = within(screen.getByRole("alertdialog")).getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(titles).toEqual(["Fire", "Flood"]);
    expect(screen.getByRole("alertdialog")).toHaveAccessibleDescription(/2 hazards need immediate attention/);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(severities(readAcks())).toEqual({ "NODE-04|flood": "HIGH", "N2|fire": "CRITICAL" });
  });

  it("muted: the dialog still appears but no siren plays", () => {
    localStorage.setItem(SOUND_STORAGE_KEY, "off");
    render(<EmergencyAlarm items={[item()]} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(screen.getByText("Alarm sound is muted.")).toBeInTheDocument();
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("the siren can be muted and unmuted from inside the open dialog", async () => {
    const user = userEvent.setup();
    render(<EmergencyAlarm items={[item()]} />);
    expect(sirenMock.start).toHaveBeenCalledTimes(1);
    sirenMock.stop.mockClear();
    await user.click(screen.getByRole("button", { name: "Mute alarm sound" }));
    expect(sirenMock.stop).toHaveBeenCalled();
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe("off");
    expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // pop-up stays until acknowledged
    expect(screen.getByText("Alarm sound is muted.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toHaveFocus();

    await user.click(screen.getByRole("button", { name: "Unmute" }));
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe("on");
    expect(sirenMock.start).toHaveBeenCalledTimes(2);
  });

  it("announces a hazard that arrives or escalates while the dialog is open", () => {
    const { rerender } = render(<EmergencyAlarm items={[item()]} />);
    const dialog = screen.getByRole("alertdialog");
    const live = dialog.querySelector('[aria-live="assertive"]')!;
    expect(live.textContent).toBe(""); // the opening itself is announced by the alertdialog
    rerender(<EmergencyAlarm items={[item(), item({ key: "N2|fire", title: "Fire", nodeId: "N2", location: "N2" })]} />);
    expect(live.textContent).toBe("New HIGH hazard: Fire at N2. 2 hazards need attention.");
    rerender(
      <EmergencyAlarm
        items={[item({ severity: "CRITICAL" }), item({ key: "N2|fire", title: "Fire", nodeId: "N2", location: "N2" })]}
      />,
    );
    expect(live.textContent).toBe("New CRITICAL hazard: Flood at Sector 4 (NODE-04). 2 hazards need attention.");
  });

  it("makes the page behind it inert and stops it scrolling while open", async () => {
    const user = userEvent.setup();
    const root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
    try {
      render(<EmergencyAlarm items={[item()]} />);
      expect(root).toHaveAttribute("inert");
      expect(document.documentElement.style.overflow).toBe("hidden");
      await user.click(screen.getByRole("button", { name: "Acknowledge" }));
      expect(root).not.toHaveAttribute("inert");
      expect(document.documentElement.style.overflow).toBe("");
    } finally {
      root.remove();
    }
  });

  it("audio locked: offers 'Enable alarm sound', which unlocks and starts the siren", async () => {
    sirenMock.state.unlocked = false;
    const user = userEvent.setup();
    render(<EmergencyAlarm items={[item()]} />);
    expect(sirenMock.start).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Enable alarm sound" }));
    expect(sirenMock.unlock).toHaveBeenCalled();
    expect(sirenMock.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("button", { name: "Enable alarm sound" })).not.toBeInTheDocument();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // still needs Acknowledge
  });

  it("keeps focus in the dialog when 'Enable alarm sound' disappears before its click (pointerdown unlock)", async () => {
    sirenMock.state.unlocked = false;
    render(<EmergencyAlarm items={[item()]} />);
    const enable = screen.getByRole("button", { name: "Enable alarm sound" });
    act(() => enable.focus());
    expect(enable).toHaveFocus();
    // The capture-phase pointerdown listener unlocks audio: the button is
    // removed before any click reaches it.
    act(() => {
      sirenMock.state.unlocked = true;
      sirenMock.notify();
    });
    expect(screen.queryByRole("button", { name: "Enable alarm sound" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Acknowledge" })).toHaveFocus();
  });

  it("the mousedown that follows a pointerdown unlock does not blur focus out of the dialog", () => {
    sirenMock.state.unlocked = false;
    // unlock synchronously, as the real capture-phase pointerdown listener does
    sirenMock.unlock.mockImplementationOnce(async () => {
      sirenMock.state.unlocked = true;
      sirenMock.notify();
      return true;
    });
    render(<EmergencyAlarm items={[item()]} />);
    const enable = screen.getByRole("button", { name: "Enable alarm sound" });
    const footer = enable.parentElement!;
    act(() => {
      fireEvent.pointerDown(enable);
    });
    expect(enable).not.toBeInTheDocument();
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    expect(ack).toHaveFocus();
    // The button is gone, so the browser sends mousedown to the footer; its
    // default action (blur to <body>) must be cancelled.
    expect(fireEvent.mouseDown(footer)).toBe(false); // false = defaultPrevented
    expect(ack).toHaveFocus();
    // ...but a mousedown on a real button keeps its default
    expect(fireEvent.mouseDown(screen.getByRole("button", { name: "Mute alarm sound" }))).toBe(true);
  });

  it("does not try to unlock audio on an event without user activation (e.g. Escape)", () => {
    sirenMock.state.unlocked = false;
    const activation = { isActive: false };
    Object.defineProperty(navigator, "userActivation", { configurable: true, get: () => activation });
    try {
      render(<EmergencyAlarm items={[item()]} />);
      fireEvent.pointerDown(document.body);
      expect(sirenMock.unlock).not.toHaveBeenCalled();
      activation.isActive = true; // a real gesture: the listener is still attached
      fireEvent.pointerDown(document.body);
      expect(sirenMock.unlock).toHaveBeenCalledTimes(1);
    } finally {
      delete (navigator as { userActivation?: unknown }).userActivation;
    }
  });

  // B64: the page-wide listener used to unlock audio on Acknowledge's
  // pointerdown, while the alarm was still open - the siren sounded until
  // the click arrived.
  it("acknowledging while audio is locked does not sound the siren, but unlocks it for later alarms", () => {
    sirenMock.state.unlocked = false;
    render(<EmergencyAlarm items={[item()]} />);
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    act(() => {
      fireEvent.pointerDown(ack);
      fireEvent.keyDown(ack, { key: " " });
    });
    expect(sirenMock.unlock).not.toHaveBeenCalled();
    expect(sirenMock.start).not.toHaveBeenCalled();
    fireEvent.click(ack);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.unlock).toHaveBeenCalledTimes(1); // the click is a user gesture
    expect(sirenMock.state.unlocked).toBe(true);
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("'Show' while audio is locked does not sound the siren either", () => {
    sirenMock.state.unlocked = false;
    const onShow = vi.fn();
    render(<EmergencyAlarm items={[item()]} onShow={onShow} />);
    const showBtn = screen.getByRole("button", { name: /^Show Flood/ });
    act(() => {
      fireEvent.pointerDown(showBtn);
    });
    expect(sirenMock.unlock).not.toHaveBeenCalled();
    fireEvent.click(showBtn);
    expect(onShow).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.unlock).toHaveBeenCalledTimes(1);
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("a later alarm sounds after audio was unlocked by acknowledging", () => {
    sirenMock.state.unlocked = false;
    const { rerender } = render(<EmergencyAlarm items={[item()]} />);
    fireEvent.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(sirenMock.start).not.toHaveBeenCalled();
    rerender(<EmergencyAlarm items={[item(), item({ key: "N2|fire", title: "Fire", severity: "CRITICAL", nodeId: "N2" })]} />);
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
    expect(sirenMock.start).toHaveBeenCalledTimes(1);
  });

  it("after closing, focus goes to returnFocusTo when the dialog opened with nothing focused", async () => {
    const user = userEvent.setup();
    render(
      <>
        <main id="main" tabIndex={-1} />
        <EmergencyAlarm items={[item()]} returnFocusTo="main" />
      </>,
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")));
  });

  it("after Escape, focus goes to returnFocusTo when the dialog opened with nothing focused", async () => {
    const user = userEvent.setup();
    render(
      <>
        <main id="main" tabIndex={-1} />
        <EmergencyAlarm items={[item()]} returnFocusTo="main" />
      </>,
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Acknowledge" })).toHaveFocus());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(document.getElementById("main")));
  });

  it("returnFocusTo does not override a real previously focused element", async () => {
    const user = userEvent.setup();
    function Page() {
      const [items, setItems] = useState<AlarmItem[]>([]);
      return (
        <>
          <main id="main" tabIndex={-1} />
          <button type="button" onClick={() => setItems([item()])}>Simulate alert</button>
          <EmergencyAlarm items={items} returnFocusTo="main" />
        </>
      );
    }
    render(<Page />);
    const trigger = screen.getByRole("button", { name: "Simulate alert" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("unlocks audio on the first gesture anywhere on the page", () => {
    sirenMock.state.unlocked = false;
    render(<EmergencyAlarm items={[]} />);
    fireEvent.pointerDown(document.body);
    expect(sirenMock.unlock).toHaveBeenCalledTimes(1);
  });

  it("without Web Audio the pop-up still works, silently", async () => {
    sirenMock.state.supported = false;
    sirenMock.state.unlocked = false;
    const user = userEvent.setup();
    render(<EmergencyAlarm items={[item()]} />);
    expect(screen.queryByRole("button", { name: "Enable alarm sound" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(sirenMock.start).not.toHaveBeenCalled();
  });

  it("prefixes the tab title while unacknowledged and restores it", async () => {
    const user = userEvent.setup();
    document.title = "SANJEEVNI Dashboard";
    render(<EmergencyAlarm items={[item()]} />);
    expect(document.title).toBe(`${ALERT_TITLE_PREFIX}SANJEEVNI Dashboard`);
    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    expect(document.title).toBe("SANJEEVNI Dashboard");
  });

  it("Show acknowledges and calls onShow with the item", async () => {
    const user = userEvent.setup();
    const onShow = vi.fn();
    render(<EmergencyAlarm items={[item()]} onShow={onShow} />);
    await user.click(screen.getByRole("button", { name: /^Show Flood at Sector 4/ }));
    expect(onShow).toHaveBeenCalledWith(item());
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(severities(readAcks())).toEqual({ "NODE-04|flood": "HIGH" });
  });

  it("traps Tab inside the dialog and restores focus on close", async () => {
    const user = userEvent.setup();
    function Page() {
      const [items, setItems] = useState<AlarmItem[]>([]);
      return (
        <>
          <button type="button" onClick={() => setItems([item()])}>Simulate alert</button>
          <EmergencyAlarm items={items} onShow={() => {}} />
        </>
      );
    }
    render(<Page />);
    const trigger = screen.getByRole("button", { name: "Simulate alert" });
    await user.click(trigger);
    const ack = screen.getByRole("button", { name: "Acknowledge" });
    const showBtn = screen.getByRole("button", { name: /^Show/ });
    await waitFor(() => expect(ack).toHaveFocus());
    await user.tab();
    expect(showBtn).toHaveFocus(); // wrapped to the first control
    await user.tab({ shift: true });
    expect(ack).toHaveFocus(); // wrapped back to the last
    await user.click(ack);
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("stops the siren on unmount", () => {
    const { unmount } = render(<EmergencyAlarm items={[item()]} />);
    sirenMock.stop.mockClear();
    unmount();
    expect(sirenMock.stop).toHaveBeenCalled();
    expect(document.title).toBe("SANJEEVNI");
  });
});

// ======================================================================
describe("AlarmSoundToggle", () => {
  it("toggles sound on/off, persists it, and muting silences a playing alarm", async () => {
    const user = userEvent.setup();
    render(
      <>
        <AlarmSoundToggle variant="light" />
        <EmergencyAlarm items={[item()]} />
      </>,
    );
    expect(sirenMock.start).toHaveBeenCalledTimes(1);
    sirenMock.stop.mockClear();
    // the dialog is modal: toggle from outside via the store-backed button
    const toggle = screen.getByRole("button", { name: "Alarm sound: On" });
    act(() => toggle.click());
    expect(screen.getByRole("button", { name: "Alarm sound: Off" })).toBeInTheDocument();
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe("off");
    expect(sirenMock.stop).toHaveBeenCalled();
    expect(screen.getByRole("alertdialog")).toBeInTheDocument(); // pop-up stays

    await user.click(screen.getByRole("button", { name: "Acknowledge" }));
    await user.click(screen.getByRole("button", { name: "Alarm sound: Off" }));
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).toBe("on");
  });

  it("asks for a click while the browser still blocks audio", async () => {
    sirenMock.state.unlocked = false;
    const user = userEvent.setup();
    render(<AlarmSoundToggle />);
    await user.click(screen.getByRole("button", { name: "Click to enable sound" }));
    expect(sirenMock.unlock).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Alarm sound: On" })).toBeInTheDocument();
  });

  it("one click on 'Click to enable sound' unlocks without muting (the page-wide listener leaves it alone)", () => {
    sirenMock.state.unlocked = false;
    render(
      <>
        <AlarmSoundToggle />
        <EmergencyAlarm items={[]} />
      </>,
    );
    const toggle = screen.getByRole("button", { name: "Click to enable sound" });
    // pointerdown on the toggle must not unlock (and re-render it as "On") before its click
    fireEvent.pointerDown(toggle);
    expect(sirenMock.unlock).not.toHaveBeenCalled();
    expect(toggle).toHaveAccessibleName("Click to enable sound");
    fireEvent.click(toggle);
    expect(sirenMock.unlock).toHaveBeenCalledTimes(1);
    expect(toggle).toHaveAccessibleName("Alarm sound: On");
    expect(localStorage.getItem(SOUND_STORAGE_KEY)).not.toBe("off");
    // a pointerdown elsewhere still unlocks as before
    sirenMock.state.unlocked = false;
    act(() => sirenMock.notify());
    fireEvent.pointerDown(document.body);
    expect(sirenMock.unlock).toHaveBeenCalledTimes(2);
  });

  it("says so when Web Audio is unavailable", () => {
    sirenMock.state.supported = false;
    render(<AlarmSoundToggle />);
    expect(screen.getByText(/Alarm sound unavailable/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
