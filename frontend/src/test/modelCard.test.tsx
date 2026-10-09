// Model card on the admin page: the synthetic-data banner must always sit
// next to the numbers, each metric is compared with its baseline row by
// row, and the server's reasons (not generated yet, switched off) are shown.
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setUnauthorizedHandler } from "../api/client";
import type { ModelCard } from "../api/types";
import {
  compareToBaseline, formatMetric, formatRate, formatUtc, parseModelCard, provenanceText,
} from "../lib/modelCard";
import { AdminPage } from "../pages/AdminPage";
import { Providers } from "../Providers";
import { MODEL_CARD } from "./fixtures/modelCard";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function api(modelCard: () => Response) {
  const paths: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input).split("?")[0];
    paths.push(path);
    if (path === "/api/auth/me") return json(200, { user: { username: "admin1", role: "admin" }, idle_timeout_minutes: 60 });
    if (path === "/api/admin/nodes") return json(200, { nodes: {} });
    if (path === "/api/node-health") return json(200, { generated_at: "", summary: {}, nodes_with_issues: 0, nodes: [] });
    if (path === "/api/admin/model-card") return modelCard();
    return json(404, { error: `no mock for ${path}` });
  });
  return paths;
}

beforeEach(() => {
  vi.stubGlobal("location", { ...window.location, search: "", pathname: "/admin.html", replace: vi.fn() });
  setUnauthorizedHandler(vi.fn());
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const renderPage = () => render(<Providers><AdminPage /></Providers>);
const section = async () => {
  const heading = await screen.findByRole("heading", { level: 2, name: "Model card" });
  return heading.closest("section")!;
};

describe("model card formatting", () => {
  it("shows rates as percentages, scores as decimals and LSTM errors in metres", () => {
    expect(formatMetric("recall_alert", 0.6567)).toBe("65.7%");
    expect(formatMetric("false_alarm_rate", 0.0007)).toBe("0.07%"); // small rates keep 2 dp, not "0.1%"
    expect(formatMetric("false_alarm_rate", 0)).toBe("0%");
    expect(formatMetric("roc_auc", 0.9363)).toBe("0.936");
    expect(formatMetric("macro_f1", 0.2421)).toBe("0.242");
    expect(formatMetric("f1_alert", 0.7142)).toBe("0.714");
    expect(formatMetric("brier", 0.0584)).toBe("0.058");
    expect(formatMetric("mae_60_rising_m", 0.0574)).toBe("0.057 m");
    expect(formatMetric("rise_recall", null)).toBe("-");
    expect(formatRate(1)).toBe("100.0%");
  });

  it("compares each metric in the right direction", () => {
    const m = { key: "x", label: "x", higher_is_better: true };
    expect(compareToBaseline({ ...m, value: 0.9, baseline: 0.8 })).toBe("better");
    expect(compareToBaseline({ ...m, value: 0.7, baseline: 0.8 })).toBe("worse");
    expect(compareToBaseline({ ...m, value: 0.03, baseline: 0.1, higher_is_better: false })).toBe("better");
    expect(compareToBaseline({ ...m, value: 0.0017, baseline: 0, higher_is_better: false })).toBe("worse");
    expect(compareToBaseline({ ...m, value: 0.5, baseline: 0.5 })).toBe("same");
    expect(compareToBaseline({ ...m, value: 0.99, baseline: null })).toBe("none");
  });

  it("names the data source in plain words and formats UTC times", () => {
    expect(provenanceText("SYNTHETIC")).toMatch(/computer-generated/);
    expect(provenanceText(null)).toMatch(/unverified/);
    expect(formatUtc("2026-10-08T10:12:05Z")).toBe("2026-10-08 10:12 UTC");
    expect(formatUtc(null)).toBe("unknown");
  });

  it("refuses a reply without models or without the banner", () => {
    expect(() => parseModelCard({ models: [] })).toThrow(/not a model card/);
    expect(() => parseModelCard({ banner: "x" })).toThrow(/not a model card/);
    expect(() => parseModelCard(null)).toThrow(/not a model card/);
    expect(parseModelCard(MODEL_CARD)).toBe(MODEL_CARD);
  });
});

describe("Model card section", () => {
  it("shows the synthetic banner, every model, metrics vs baseline, false alarms and limitations", async () => {
    const paths = api(() => json(200, MODEL_CARD));
    renderPage();
    const card = await section();
    const banner = await within(card).findByText(/NOT evidence of accuracy on real floods/);
    expect(banner).toHaveTextContent(/Data: SYNTHETIC - computer-generated/);
    expect(banner.className).toMatch(/cardBanner/);
    expect(banner.className).not.toMatch(/cardBannerReal/); // red, because the data isn't real
    expect(paths).toContain("/api/admin/model-card");
    expect(within(card).getByText(/Models last updated 2026-10-08 10:12 UTC/)).toBeInTheDocument();

    const articles = within(card).getAllByRole("article");
    expect(articles.map((a) => within(a).getByRole("heading", { level: 3 }).textContent)).toEqual([
      "Flood risk model Evaluated", "Sensor-fault filter (Isolation Forest) Evaluated",
      "On-device edge network (int8 TFLite Micro) Evaluated", "River-level forecast (LSTM) Not available",
    ]);

    const flood = articles[0];
    expect(within(flood).getAllByText("SYNTHETIC (computer-generated)")).toHaveLength(2); // trained on + tested on
    expect(within(flood).getByText(/4,800 rows/)).toBeInTheDocument();
    const recall = within(flood).getByRole("rowheader", { name: "Floods caught (MEDIUM+)" }).closest("tr")!;
    expect(within(recall).getAllByRole("cell").map((c) => c.textContent)).toEqual(["65.7%", "44.8%", "Better"]);
    const fa = within(flood).getByRole("rowheader", { name: /False-alarm rate \(MEDIUM\+\)/ }).closest("tr")!;
    expect(within(fa).getAllByRole("cell").map((c) => c.textContent)).toEqual(["3.2%", "9.9%", "Better"]);
    expect(within(flood).getByText(/False-alarm rate: 3\.2%/)).toBeInTheDocument();
    expect(within(flood).getByText(/Missed: 34\.3%/)).toBeInTheDocument();
    expect(within(flood).getByText("Overall: beats the baseline on its main measure.")).toBeInTheDocument();
    expect(within(flood).getByText(/re-learning|fixed formula/)).toBeInTheDocument(); // limitation

    // a metric with no baseline says so instead of a blank cell
    const auc = within(articles[1]).getByRole("rowheader", { name: "ROC-AUC of the anomaly score" }).closest("tr")!;
    expect(within(auc).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0.993", "-", "No baseline"]);

    // "beats the baseline" overall must not hide a row where it is worse
    const edge = articles[2];
    const edgeFa = within(edge).getByRole("rowheader", { name: /NORMAL readings raised/ }).closest("tr")!;
    expect(within(edgeFa).getAllByRole("cell").map((c) => c.textContent)).toEqual(["0.17%", "0%", "Worse"]);
    expect(within(edge).getByText(/still worse on 1 of the 2 measures/)).toBeInTheDocument();

    // not evaluated: the reason, and no numbers
    const lstm = articles[3];
    expect(within(lstm).getByText(/TensorFlow is not installed/)).toBeInTheDocument();
    expect(within(lstm).queryByRole("table")).not.toBeInTheDocument();
    expect(within(lstm).queryByText(/False-alarm rate/)).not.toBeInTheDocument();
  });

  it("shows calibration and the confusion matrix on request", async () => {
    api(() => json(200, MODEL_CARD));
    renderPage();
    const flood = (await within(await section()).findAllByRole("article"))[0];
    await userEvent.click(within(flood).getByText("Calibration and confusion matrices"));
    expect(within(flood).getByText(/Brier score 0\.058 vs 0\.12\d/)).toBeInTheDocument();
    const cm = within(flood).getByRole("table", { name: /MEDIUM and above \(risk > 0\.4\)/ });
    const wasFlood = within(cm).getByRole("rowheader", { name: "Was flood" }).closest("tr")!;
    expect(within(wasFlood).getAllByRole("cell").map((c) => c.textContent)).toEqual(["309", "591"]);
    // empty reliability bins are left out
    const rel = within(flood).getByRole("table", { name: /reliability/ });
    expect(within(rel).getAllByRole("row")).toHaveLength(2); // header + the one non-empty bin
  });

  it("uses the calm style for the banner only when the data is real", async () => {
    api(() => json(200, { ...MODEL_CARD, provenance: "REAL", banner: "Real gauge data from 2025." } satisfies ModelCard));
    renderPage();
    const banner = await within(await section()).findByText(/Real gauge data from 2025\./);
    expect(banner.className).toMatch(/cardBannerReal/);
  });

  it("tells the admin how to generate a missing card", async () => {
    api(() => json(404, { error: "No model card yet - run: venv\\Scripts\\python.exe ml\\evaluate_models.py" }));
    renderPage();
    const alert = await within(await section()).findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't load the model card: No model card yet - run: venv\\Scripts\\python.exe ml\\evaluate_models.py");
    // the node list is unaffected
    expect(screen.getByRole("heading", { name: "Sensor nodes (0)" })).toBeInTheDocument();
  });

  it("explains a 403 and a reply that is not a card", async () => {
    api(() => json(403, { error: "Admin role required" }));
    const { unmount } = renderPage();
    expect(await within(await section()).findByRole("alert")).toHaveTextContent("Only admin accounts can see the model card.");
    unmount();
    vi.restoreAllMocks();
    api(() => json(200, { models: MODEL_CARD.models })); // no banner: never show the numbers bare
    renderPage();
    const card = await section();
    expect(await within(card).findByRole("alert")).toHaveTextContent(/not a model card/);
    expect(within(card).queryByRole("article")).not.toBeInTheDocument();
  });
});
