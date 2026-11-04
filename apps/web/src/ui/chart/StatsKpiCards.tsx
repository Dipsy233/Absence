import type { StatsTotals } from "@absence/core";
import { formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";

/**
 * The run scope as four KPI cards: runs, events, errors, and the estimated
 * tokens. The Chart report's KPI row carries them next to the selection's own
 * four — one row of eight, no new indicators.
 *
 * `scope` says what the totals cover: "run" is the selected run, "runs" is
 * every run in the session (the "all runs" reading). The numbers are the same
 * shape either way; the subtitles name the scope honestly (no "164 sessions"
 * under a single run).
 *
 * The cards keep the reporting contract: derived values arrive `null` when
 * the scope holds no samples, and the card says "no data" rather than a
 * confident zero.
 */
export function StatsKpiCards({
  totals,
  scope,
}: {
  totals: StatsTotals;
  scope: "run" | "runs";
}) {
  const t = useT();
  return (
    <>
      <div className="chart-kpi">
        <div className="chart-kpi__row">
          <span className="chart-kpi__cap">{t("Run count")}</span>
          <span className="chart-chip chart-chip--run">{t("RUN")}</span>
        </div>
        <div className="chart-kpi__v">{t("{n} runs", { n: totals.runs })}</div>
        <div className="chart-kpi__s">
          {totals.errorRuns > 0
            ? t("{n} errored", { n: totals.errorRuns })
            : t("none errored")}
          {totals.runWallMs !== null ? <> · {t("busy {time}", { time: formatOffset(totals.runWallMs) })}</> : null}
        </div>
      </div>

      <div className="chart-kpi">
        <div className="chart-kpi__row">
          <span className="chart-kpi__cap">{t("Events")}</span>
          <span className="chart-chip chart-chip--read">{t("OBS")}</span>
        </div>
        <div className="chart-kpi__v">{t("{n} events", { n: totals.events })}</div>
        <div className="chart-kpi__s">
          {totals.runWallMs !== null
            ? t("avg {time} / run", { time: formatOffset(Math.round(totals.runWallMs / Math.max(1, totals.runs))) })
            : t("no ended runs")}
        </div>
      </div>

      <div className="chart-kpi">
        <div className="chart-kpi__row">
          <span className="chart-kpi__cap">{t("Errors")}</span>
          <span className="chart-chip chart-chip--err">{t("ERR")}</span>
        </div>
        <div className="chart-kpi__v">
          {totals.errorRate === null ? t("no data") : `${Math.round(totals.errorRate * 100)}%`}
        </div>
        <div className="chart-kpi__s">
          {totals.errorRate === null
            ? t("no ended runs")
            : t("{n} of {m} runs · {k} error events", {
                n: totals.errorRuns,
                m: totals.runs,
                k: totals.errorEvents,
              })}
        </div>
      </div>

      <div className="chart-kpi">
        <div className="chart-kpi__row">
          <span className="chart-kpi__cap">{t("Tokens · est.")}</span>
          <span className="chart-chip chart-chip--edit">{t("≈")}</span>
        </div>
        <div className="chart-kpi__v">{formatTokenSum(totals.tokens.output)}</div>
        <div className="chart-kpi__s">
          {totals.tokens.input === null && totals.tokens.output === null
            ? scope === "run"
              ? t("no usage data in this run")
              : t("no usage data in these runs")
            : t("in {i} · out {o}", {
                i: formatTokenSum(totals.tokens.input),
                o: formatTokenSum(totals.tokens.output),
              })}
        </div>
      </div>
    </>
  );
}

/** A token sum in its shortest honest form; `—` when the window had no samples. */
export function formatTokenSum(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
