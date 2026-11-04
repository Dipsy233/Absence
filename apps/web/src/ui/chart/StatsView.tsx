import { useEffect, useMemo, useState } from "react";
import type { StatsQuery, StatsReport } from "@absence/core";
import { fetchRuntimes, type RuntimeStatus } from "../../lib/api";
import { formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useStatsStore } from "../../stores/statsStore";
import { MiniLineChart } from "../../components/metrics/MiniLineChart";

/**
 * The Chart face's cumulative tab — the same archive, read across every
 * session and run in a window instead of one run.
 *
 * The reporting contract is the archive's own: a count may honestly be 0, but
 * anything derived (error rate, percentiles, tokens, cost) arrives `null` when
 * the window holds no samples, and this view says "no data" rather than
 * drawing a confident zero. Cost is computed on the server at query time from
 * the price table and is always an estimate — tokens are the fact, cost is a
 * derived figure.
 */

const RUNS_COLOR = "#de9255";
const ERROR_COLOR = "#e06c5a";
const TOKEN_COLOR = "#5aa88f";

const RANGES = [
  { id: "24h", ms: 24 * 60 * 60_000 },
  { id: "7d", ms: 7 * 24 * 60 * 60_000 },
  { id: "30d", ms: 30 * 24 * 60 * 60_000 },
  { id: "all", ms: Number.MAX_SAFE_INTEGER },
] as const;

export function StatsView() {
  const t = useT();
  const [rangeId, setRangeId] = useState<string>("7d");
  const [project, setProject] = useState("");
  const [runtime, setRuntime] = useState("");
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);

  const report = useStatsStore((s) => s.report);
  const loading = useStatsStore((s) => s.loading);
  const error = useStatsStore((s) => s.error);
  const load = useStatsStore((s) => s.load);

  const query = useMemo<StatsQuery>(() => {
    const range = RANGES.find((entry) => entry.id === rangeId) ?? RANGES[1]!;
    return {
      from: range.ms === Number.MAX_SAFE_INTEGER ? 0 : Date.now() - range.ms,
      ...(project ? { project } : {}),
      ...(runtime ? { runtime } : {}),
    };
  }, [rangeId, project, runtime]);

  // One fetch per range/filter change, then a slow poll while the tab is open —
  // aggregate numbers move at run speed, not at event speed.
  useEffect(() => {
    void load(query);
    const timer = setInterval(() => void load(query), 15_000);
    return () => clearInterval(timer);
  }, [query, load]);

  useEffect(() => {
    let cancelled = false;
    void fetchRuntimes()
      .then((list) => {
        if (!cancelled) setRuntimes(list);
      })
      .catch(() => {
        // The filter dropdown simply stays empty.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <div className="chart-page-empty">{t("Stats failed to load: {error}", { error })}</div>;
  }
  if (!report) {
    return <div className="chart-page-empty">{loading ? t("loading…") : t("No data.")}</div>;
  }

  const { totals } = report;
  const hasAnyData = totals.sessions > 0 || totals.runs > 0 || totals.events > 0;

  // A plain reshaping, not a hook: this line sits after the early returns
  // above, and a hook there would change the hook count between renders
  // (React #310). The reduction over ~60 buckets is trivial.
  const chart = {
    ts: report.series.map((bucket) => Math.floor(bucket.ts / 1000)),
    runs: report.series.map((bucket) => bucket.runs),
    errorRuns: report.series.map((bucket) => bucket.errorRuns),
    outputTokens: report.series.map((bucket) => bucket.outputTokens),
  };

  return (
    <div className="chart-stats">
      {/* ── range + filters ─────────────────────────────────────────────── */}
      <section className="chart-hero chart-hero--stats">
        <div className="chart-meta">
          <span className="chart-chip chart-chip--read">{t("cumulative")}</span>
          <span>{t("{n} sessions", { n: totals.sessions })}</span>
          <span aria-hidden>·</span>
          <span>{t("{n} runs", { n: totals.runs })}</span>
        </div>
        <div className="chart-h1">{t("Every run in the window, in four numbers.")}</div>
        <div className="chart-stats__filters">
          <div className="chart-tabs" role="tablist" aria-label={t("Range")}>
            {RANGES.map((range) => (
              <button
                key={range.id}
                type="button"
                role="tab"
                aria-selected={rangeId === range.id}
                className={`chart-tab${rangeId === range.id ? " chart-tab--on" : ""}`}
                onClick={() => setRangeId(range.id)}
              >
                {t(range.id)}
              </button>
            ))}
          </div>
          <select
            className="chart-stats__select"
            value={project}
            onChange={(event) => setProject(event.target.value)}
            aria-label={t("Project")}
          >
            <option value="">{t("All projects")}</option>
            {report.projects.map((entry) => (
              <option key={entry.projectPath} value={entry.projectPath}>
                {entry.projectName}
              </option>
            ))}
          </select>
          <select
            className="chart-stats__select"
            value={runtime}
            onChange={(event) => setRuntime(event.target.value)}
            aria-label={t("Runtime")}
          >
            <option value="">{t("All runtimes")}</option>
            {runtimes.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.kind}
              </option>
            ))}
          </select>
        </div>
      </section>

      {/* ── the four numbers ────────────────────────────────────────────── */}
      <section className="chart-kpis">
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
            {t("{n} sessions", { n: totals.sessions })} ·{" "}
            {totals.runWallMs !== null ? t("avg {time} / run", { time: formatOffset(Math.round(totals.runWallMs / Math.max(1, totals.runs))) }) : t("no ended runs")}
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
              ? t("no ended runs in this window")
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
          <div className="chart-kpi__v">
            {totals.cost !== null ? `≈ $${totals.cost.toFixed(2)}` : formatTokenSum(totals.tokens.output)}
          </div>
          <div className="chart-kpi__s">
            {totals.tokens.input === null && totals.tokens.output === null
              ? t("no usage data in this window")
              : t("in {i} · out {o}", {
                  i: formatTokenSum(totals.tokens.input),
                  o: formatTokenSum(totals.tokens.output),
                })}
            {totals.cost === null && (totals.tokens.input !== null || totals.tokens.output !== null)
              ? ` · ${t("cost: no price configured")}`
              : null}
          </div>
        </div>
      </section>

      {!hasAnyData ? (
        <div className="chart-page-empty">{t("Nothing recorded in this window.")}</div>
      ) : (
        <>
          {/* ── the trend ─────────────────────────────────────────────────── */}
          <section className="chart-panel">
            <div className="chart-pt">
              <span className="chart-chip chart-chip--run">{t("Trend")}</span>
              <span className="chart-pt__name">{t("Runs and output tokens per bucket")}</span>
              <span className="chart-pt__meta chart-mono">
                {t("{n}-buckets", { n: formatOffset(report.stepMs) })}
              </span>
            </div>
            <div className="chart-body">
              <MiniLineChart
                ts={chart.ts}
                series={[
                  { label: t("runs"), color: RUNS_COLOR, values: chart.runs },
                  { label: t("errors"), color: ERROR_COLOR, values: chart.errorRuns },
                  ...(report.totals.tokens.output !== null
                    ? [{ label: t("tokens out"), color: TOKEN_COLOR, values: chart.outputTokens }]
                    : []),
                ]}
              />
            </div>
          </section>

          {/* ── tool / error / model / project breakdowns ─────────────────── */}
          <section className="chart-stats-grid">
            <div className="chart-panel">
              <div className="chart-pt">
                <span className="chart-chip chart-chip--run">{t("Tools")}</span>
                <span className="chart-pt__name">{t("Calls and latency")}</span>
              </div>
              <div className="chart-body">
                {report.tools.length === 0 ? (
                  <p className="chart-empty">{t("No tool calls in this window.")}</p>
                ) : (
                  report.tools.map((tool) => (
                    <div key={tool.toolName} className="chart-it" title={tool.toolName}>
                      <span className="chart-it__n">{tool.toolName}</span>
                      <span className="chart-it__m">
                        {t("{n} calls", { n: tool.calls })}
                        {tool.errors > 0 ? <span className="chart-it__m--err"> · {t("{n} failed", { n: tool.errors })}</span> : null}
                        {" · "}
                        {tool.p50Ms === null ? t("p50 no data") : `p50 ${formatOffset(tool.p50Ms)}`}
                        {" · "}
                        {tool.p95Ms === null ? t("p95 no data") : `p95 ${formatOffset(tool.p95Ms)}`}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="chart-panel">
              <div className="chart-pt">
                <span className="chart-chip chart-chip--err">{t("Errors")}</span>
                <span className="chart-pt__name">{t("Most frequent")}</span>
              </div>
              <div className="chart-body">
                {report.topErrors.length === 0 ? (
                  <p className="chart-empty">{t("No errors in this window.")}</p>
                ) : (
                  report.topErrors.map((entry) => (
                    <div key={entry.message} className="chart-it" title={entry.message}>
                      <span className="chart-it__n" style={{ color: "var(--ch-err)" }}>
                        {entry.message}
                      </span>
                      <span className="chart-it__m">×{entry.count}</span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="chart-panel">
              <div className="chart-pt">
                <span className="chart-chip chart-chip--edit">{t("Models")}</span>
                <span className="chart-pt__name">{t("Tokens by model · est.")}</span>
              </div>
              <div className="chart-body">
                {report.models.length === 0 ? (
                  <p className="chart-empty">{t("No usage data in this window.")}</p>
                ) : (
                  report.models.map((model) => (
                    <div key={model.model} className="chart-it" title={model.model}>
                      <span className="chart-it__n">{model.model}</span>
                      <span className="chart-it__m">
                        {t("in {i} · out {o}", {
                          i: formatTokenSum(model.input),
                          o: formatTokenSum(model.output),
                        })}
                        {model.cost !== null ? <> · ≈ ${model.cost.toFixed(2)}</> : null}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>

            <div className="chart-panel">
              <div className="chart-pt">
                <span className="chart-chip chart-chip--read">{t("Projects")}</span>
                <span className="chart-pt__name">{t("Where the work happened")}</span>
              </div>
              <div className="chart-body">
                {report.projects.length === 0 ? (
                  <p className="chart-empty">{t("No sessions in this window.")}</p>
                ) : (
                  report.projects.map((entry) => (
                    <div key={entry.projectPath} className="chart-it" title={entry.projectPath}>
                      <span className="chart-it__n">{entry.projectName}</span>
                      <span className="chart-it__m">
                        {t("{n} runs", { n: entry.runs })}
                        {entry.errorRuns > 0 ? (
                          <span className="chart-it__m--err"> · {t("{n} errored", { n: entry.errorRuns })}</span>
                        ) : null}
                        {" · "}
                        {t("{n} sessions", { n: entry.sessions })}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function formatTokenSum(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}
