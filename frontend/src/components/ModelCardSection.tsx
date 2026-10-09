// "Model card" on the admin page: what each AI model is for, what data it
// was trained and tested on, how it scores against a simple baseline, how
// often it raises a false alarm, and what it can't do. The numbers come
// from SYNTHETIC data today, so the card's own banner sits at the top of
// the section and every model repeats where its data came from - a figure
// copied off this page should never travel without that label.
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { ApiError, apiGet } from "../api/client";
import type { ModelConfusionMatrix, ModelEntry } from "../api/types";
import {
  COMPARISON_TEXT, compareToBaseline, formatCount, formatMetric, formatRate, formatUtc, parseModelCard,
  provenanceText,
} from "../lib/modelCard";
import styles from "./Admin.module.css";

export function ModelCardSection() {
  const card = useQuery({
    queryKey: ["model-card"],
    queryFn: async () => parseModelCard(await apiGet<unknown>("/api/admin/model-card")),
    // Same rule as the node list: retry once only when it may help. "Not
    // generated yet" (404), "switched off" (503) or a reply that isn't a
    // card won't change by retrying. fetch's own network failure is a TypeError.
    retry: (count, error) => count < 1 && (error instanceof TypeError
      || (error instanceof ApiError && (error.status === 502 || error.status === 504))),
    // The card only changes when someone re-runs ml/evaluate_models.py.
    staleTime: 5 * 60_000,
  });

  return (
    <section id="model-card" className={styles.modelCard} aria-labelledby="model-card-title">
      <h2 id="model-card-title">Model card</h2>
      <p className={styles.intro}>
        How the AI models behind alerts were tested, compared with a simple rule (the baseline). Read the limitations
        before quoting any number.
      </p>
      {card.isPending && <p className={styles.loading}>Loading the model card...</p>}
      {card.isError && <div role="alert" className={styles.errorBox}>{cardErrorText(card.error)}</div>}
      {card.isSuccess && (
        <>
          {/* Red unless every number is from real data (contract: always shown next to the numbers) */}
          <div className={card.data.provenance === "REAL" ? styles.cardBannerReal : styles.cardBanner}>
            <strong>Data: {provenanceText(card.data.provenance)}.</strong> {card.data.banner}
          </div>
          <p className={styles.hint}>
            Models last updated {formatUtc(card.data.models_updated_at)}. Report made by{" "}
            <code>{card.data.generated_by}</code> (seed {card.data.seed}) - re-run it after retraining.
          </p>
          {card.data.models.length === 0
            ? <p className={styles.empty}>The model card lists no models.</p>
            : card.data.models.map((m) => <ModelArticle key={m.id} model={m} />)}
        </>
      )}
    </section>
  );
}

function cardErrorText(error: Error): string {
  if (error instanceof ApiError && error.status === 403) return "Only admin accounts can see the model card.";
  return `Couldn't load the model card: ${error.message}`;
}

function ModelArticle({ model: m }: { model: ModelEntry }) {
  const titleId = useId();
  const available = m.status === "evaluated";
  const worse = m.headline_metrics.filter((x) => compareToBaseline(x) === "worse").length;
  return (
    <article className={styles.model} aria-labelledby={titleId}>
      <h3 id={titleId}>
        {m.name}{" "}
        <span className={available ? styles.modelOk : styles.modelMissing}>{available ? "Evaluated" : "Not available"}</span>
      </h3>
      {!available && <p className={styles.errorBox}>Not evaluated: {m.status_reason ?? "no reason given"}</p>}

      <dl className={styles.facts}>
        <dt>Purpose</dt><dd>{m.purpose}</dd>
        <dt>Runs on</dt><dd>{m.runs_where}</dd>
        {available && (
          <>
            <dt>Trained on</dt>
            <dd>
              <DataTag provenance={m.training_data.provenance} />{" "}
              {formatCount(m.training_data.size)} rows. {m.training_data.description}
              {m.training_data.generator && <> Made by <code>{m.training_data.generator}</code>.</>}
            </dd>
            <dt>Tested on</dt>
            <dd>
              <DataTag provenance={m.evaluation.provenance} />{" "}
              {formatCount(m.evaluation.test_size)} rows ({formatCount(m.evaluation.test_positives)} positive): {m.evaluation.split}.
              {m.evaluation.leakage_guard && <> No overlap with training: {m.evaluation.leakage_guard}.</>}
            </dd>
            <dt>Baseline</dt>
            <dd><strong>{m.baseline.name ?? "none"}</strong>{m.baseline.description && <> - {m.baseline.description}</>}</dd>
          </>
        )}
      </dl>

      {available && m.headline_metrics.length > 0 && (
        <>
          <h4>Results vs baseline</h4>
          <div className={styles.tableWrap}>
            <table className={styles.metricTable}>
              <caption className="visually-hidden">
                {m.name}: results on {m.evaluation.provenance === "REAL" ? "real" : "synthetic"} test data, compared with the baseline
              </caption>
              <thead>
                <tr>
                  <th scope="col">Measure</th><th scope="col">This model</th>
                  <th scope="col">Baseline</th><th scope="col">Compared</th>
                </tr>
              </thead>
              <tbody>
                {m.headline_metrics.map((x) => {
                  const c = compareToBaseline(x);
                  return (
                    <tr key={x.key}>
                      <th scope="row">{x.label}{!x.higher_is_better && <span className={styles.hint}> (lower is better)</span>}</th>
                      <td>{formatMetric(x.key, x.value)}</td>
                      <td>{formatMetric(x.key, x.baseline)}</td>
                      <td className={c === "worse" ? styles.cmpWorse : c === "better" ? styles.cmpBetter : undefined}>
                        {COMPARISON_TEXT[c]}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className={styles.verdict}>
            {verdictText(m.beats_baseline)}
            {m.beats_baseline && worse > 0 && ` It is still worse on ${worse} of the ${m.headline_metrics.length} measures above.`}
          </p>
        </>
      )}

      {available && (
        <>
          <h4>False alarms and misses</h4>
          <ul className={styles.alarmList}>
            <li><strong>False-alarm rate: {formatRate(m.false_alarm.rate)}</strong> - {m.false_alarm.definition ?? "not defined"}</li>
            <li><strong>Missed: {formatRate(m.false_alarm.miss_rate)}</strong> - {m.false_alarm.miss_definition ?? "not defined"}</li>
          </ul>
          <details className={styles.more}>
            <summary>Calibration and confusion matrices</summary>
            <Calibration model={m} />
            {m.confusion_matrices.map((cm) => <Confusion key={cm.title} cm={cm} />)}
          </details>
        </>
      )}

      {m.limitations.length > 0 && (
        <>
          <h4>Limitations</h4>
          <ul className={styles.limitations}>
            {m.limitations.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </>
      )}

      <p className={styles.hint}>
        File <code>{m.artifact.path}</code>
        {m.artifact.modified_at ? `, updated ${formatUtc(m.artifact.modified_at)}` : " (missing)"}
        {m.artifact.sha256 && <>, SHA-256 <code title={m.artifact.sha256}>{m.artifact.sha256.slice(0, 12)}...</code></>}
      </p>
    </article>
  );
}

function verdictText(beats: boolean | null): string {
  if (beats === null) return "Overall: not compared with a baseline.";
  return beats ? "Overall: beats the baseline on its main measure." : "Overall: does NOT beat the baseline on its main measure.";
}

/** Text tag (not colour alone) saying where a data set came from. */
function DataTag({ provenance }: { provenance: ModelEntry["training_data"]["provenance"] }) {
  return (
    <span className={provenance === "REAL" ? styles.dataReal : styles.dataSynthetic}>
      {provenance === "SYNTHETIC" ? "SYNTHETIC (computer-generated)" : provenance === "REAL" ? "Real data" : "Source not recorded"}
    </span>
  );
}

function Calibration({ model: m }: { model: ModelEntry }) {
  const c = m.calibration;
  if (!c.applicable) return <p>{c.note ?? "Calibration: not applicable."}</p>;
  const bins = c.reliability.filter((b) => b.count > 0);
  return (
    <>
      <p>
        Calibration ({c.method ?? "method not recorded"}): Brier score {formatMetric("brier", c.brier)}
        {c.brier_reference !== null && <> vs {formatMetric("brier", c.brier_reference)} for always guessing the average</>}
        , expected calibration error {formatRate(c.ece)} (lower is better for both).{c.note && <> {c.note}</>}
      </p>
      {bins.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.smallTable}>
            <caption>When the model says... (reliability, test rows per band)</caption>
            <thead>
              <tr><th scope="col">Predicted</th><th scope="col">Rows</th><th scope="col">Average predicted</th><th scope="col">Actually happened</th></tr>
            </thead>
            <tbody>
              {bins.map((b) => (
                <tr key={b.bin_lower}>
                  <th scope="row">{formatRate(b.bin_lower)} - {formatRate(b.bin_upper)}</th>
                  <td>{formatCount(b.count)}</td>
                  <td>{formatRate(b.mean_predicted)}</td>
                  <td>{formatRate(b.observed_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function Confusion({ cm }: { cm: ModelConfusionMatrix }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.smallTable}>
        <caption>{cm.title} (rows = what actually happened, columns = what the model said)</caption>
        <thead>
          <tr>
            <td />
            {cm.labels.map((l) => <th key={l} scope="col">Said {l}</th>)}
          </tr>
        </thead>
        <tbody>
          {cm.matrix.map((row, i) => (
            <tr key={cm.labels[i] ?? i}>
              <th scope="row">Was {cm.labels[i] ?? `class ${i + 1}`}</th>
              {row.map((n, j) => <td key={j}>{formatCount(n)}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
