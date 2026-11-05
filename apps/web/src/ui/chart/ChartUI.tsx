import { useEffect, useMemo, useRef, useState } from "react";
import type { AbsenceEvent } from "@absence/core";
import { formatClock, formatOffset } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { useT } from "../../lib/i18n";
import {
  reasonLevel,
} from "../../lib/report";
import { eventToStageItem } from "../../lib/events";
import { useRunsStore } from "../../stores/runsStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { FaceBar } from "../../components/layout/FaceBar";
import { StageItemView } from "../../components/stage/StageItemView";
import { ATTENTION_REASON_TEXT } from "../../lib/attention";
import { RUN_WORD } from "../shared/atoms";
import { useMonitorData } from "../../hooks/useMonitorData";
import type {
  Attention,
  AttentionLevel,
  AttentionReason,
  CommandFact,
  FileDelta,
  ReportAttentionOptions,
  TimelineKind,
} from "../../types/report";

import { ChartTimeline, type TimelinePick } from "./ChartTimeline";
import { buildTimelineTracks, timelineTotalMs } from "../../lib/timeline";
import { ChartChat } from "./ChartChat";
import { StatsKpiCards } from "./StatsKpiCards";
import { useAllRunsData } from "../../hooks/useAllRunsData";
import { buildAllRunsTotals } from "../../lib/allRuns";
import { listErrors, listToolCalls } from "../../lib/runLists";
import "./chart.css";
import { useRideScroll } from "../shared/rideScroll";

/**
 * CHART (病历报告) — the run, after the fact, as a record.
 *
 * The whole page is the report: who ran, what it was asked, how loudly it wants
 * a human, what it learned, what it changed, what it executed, and when. The
 * timeline is the spine — one lane per kind of activity, each block where it
 * happened — and picking a block (or a row) puts that event's own content in
 * the pane on the right, so the record is one click from its evidence.
 *
 * Everything is drawn from `useMonitorData` and `renderRun`: the same facts the
 * Monitor shows, read once the run has settled. No second derivation, no forked
 * engine. The run switcher's "all runs" entry widens the subject from the
 * selected run to every run in the session, via the same engine.
 */

const KIND_CHIP: Record<TimelineKind, string> = {
  start: "mute",
  think: "think",
  speak: "think",
  read: "read",
  search: "search",
  edit: "edit",
  write: "edit",
  tool: "run",
  run: "run",
  process: "egg",
  observe: "mute",
  error: "err",
  end: "mute",
};

/** The chip a level wears: green / orange / red, grey when nothing fired. */
const ATTENTION_CHIP: Record<AttentionLevel, string> = {
  none: "mute",
  low: "edit",
  medium: "run",
  high: "err",
};

const OUTCOME_CHIP: Record<string, string> = {
  completed: "edit",
  completed_with_warnings: "run",
  failed: "err",
  stopped: "err",
  no_change: "mute",
};

type Tab = "changes" | "executions" | "knows" | "toolcalls" | "errors" | "attention";

/** The attention verdict of a view that has none to give yet. */
const NO_ATTENTION: Attention = { level: "none", reasons: [], evidence: [] };

export function ChartUI() {
  const t = useT();
  const now = useNow(1000);
  const attentionOptions = useAttentionOptions();
  const data = useMonitorData();
  const session = useSessionStore((s) => s.session);

  const run = data.run;
  // The finished-run report comes rendered from the shared hook — one
  // derivation, not a second `renderRun` per face.
  const report = data.report;

  const ioARef = useRideScroll<HTMLElement>();
  const ioBRef = useRideScroll<HTMLElement>();
  const [tab, setTab] = useState<Tab>("changes");
  const [pick, setPick] = useState<TimelinePick | undefined>(undefined);
  // The run switcher's "all runs" entry: a Chart-local reading that swaps the
  // single run's slice for every run in the session, aggregated.
  const [allRuns, setAllRuns] = useState(false);
  const [runMenu, setRunMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setPick(undefined);
    setRunMenu(false);
  }, [run?.id, allRuns]);

  // A session switch always lands on the single-run reading.
  useEffect(() => setAllRuns(false), [session?.id]);

  const runs = useRunsStore((s) => s.runs);
  const ensureLoaded = useRunsStore((s) => s.ensureLoaded);
  const selectRun = useUiStore((s) => s.selectRun);
  // One guarded fetch lives in the store now; every face calls the same one.
  useEffect(() => {
    ensureLoaded(session?.id);
  }, [session?.id, ensureLoaded]);

  // The aggregate's data: the whole session's archived events, cut to the run
  // windows and reduced by the same engine a single run uses.
  const allData = useAllRunsData(allRuns);
  const activeEvents = allRuns ? allData.events : data.events;
  const activeRun = allRuns ? allData.run : run;
  // The track split is data, not layout: the drawing component receives the
  // three tracks and never decides which activity belongs on which one.
  const activeTracks = useMemo(
    () => buildTimelineTracks((allRuns ? allData.report : report)?.timeline ?? []),
    [allRuns, allData.report, report],
  );

  // The KPI row's cumulative four cards share the selection's scope: the
  // selected run's own window, or every run in the session under "all runs".
  // Field deps: useSelectedRun rebuilds the run object per render.
  const singleTotals = useMemo(
    () => (run ? buildAllRunsTotals({ events: data.events, run }, [run]) : undefined),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [data.events, run?.id, run?.status, run?.fromIndex, run?.toIndex, run?.endedAt],
  );

  /** A click anywhere but the menu closes it. */
  useEffect(() => {
    if (!runMenu) return;
    const onDown = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setRunMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [runMenu]);

  /** Prefer the newest event behind a set of evidence ids that has something to render. */
  const reveal = (ids: string[], node?: TimelinePick["node"]) => {
    const wanted = new Set(ids);
    let chosen: AbsenceEvent | undefined;
    let fallback: AbsenceEvent | undefined;
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      const event = activeEvents[i]!;
      if (!wanted.has(event.id)) continue;
      if (!chosen && eventToStageItem(event)) chosen = event;
      if (!fallback) fallback = event;
    }
    const event = chosen ?? fallback;
    if (!event) return;
    setPick({
      eventId: event.id,
      node,
      anchorMs: node?.offsetMs ?? (activeRun ? Math.max(0, event.timestamp - activeRun.startedAt) : 0),
      label: node?.action ? `${t(node.action)} · ${formatOffset(node.offsetMs)}` : formatClock(event.timestamp),
    });
  };

  const previewEvent = useMemo(() => {
    if (!pick) return undefined;
    for (let i = activeEvents.length - 1; i >= 0; i--) {
      if (activeEvents[i]!.id === pick.eventId) return activeEvents[i];
    }
    return undefined;
  }, [pick, activeEvents]);
  const previewItem = previewEvent ? eventToStageItem(previewEvent) : undefined;

  // The query panel's two listable rows, over the same slice the report reads.
  // Field deps, not the run object: useSelectedRun rebuilds it every render.
  const toolCalls = useMemo(
    () => (activeRun ? listToolCalls(activeEvents, activeRun) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEvents, activeRun?.id, activeRun?.fromIndex, activeRun?.toIndex],
  );
  const errorRows = useMemo(
    () => (activeRun ? listErrors(activeEvents, activeRun) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeEvents, activeRun?.id, activeRun?.fromIndex, activeRun?.toIndex],
  );

  const durationMs = activeRun ? (activeRun.endedAt ?? now) - activeRun.startedAt : 0;
  const facts = data.facts;

  if (!run) {
    return (
      <div className="mon-root chart-root">
        <FaceBar />
        <div className="chart-page-empty">
          {t("Nothing to report yet — send the agent a task.")}
        </div>
        <ChartChat />
      </div>
    );
  }

  if (allRuns && allData.error) {
    return (
      <div className="mon-root chart-root">
        <FaceBar />
        <div className="chart-page-empty">
          {t("Could not load the runs: {error}", { error: allData.error })}
        </div>
        <ChartChat />
      </div>
    );
  }

  const activeReport = allRuns ? allData.report : report;
  const activeFacts = allRuns ? allData.facts : facts;

  if (!activeReport || !activeFacts || !activeRun) {
    return (
      <div className="mon-root chart-root">
        <FaceBar />
        <div className="chart-page-empty">{t("loading…")}</div>
      </div>
    );
  }

  const running = activeRun.status === "running";
  // The aggregate reports the settled verdict: the live stall clock belongs to
  // a single live run and would read an idle gap between runs as a wedge.
  const attention = allRuns ? activeFacts.attention : data.attention;
  const attentionLevels = attention.reasons.map((reason) => reasonLevel(reason, attentionOptions));
  const attentionCounts = {
    low: attentionLevels.filter((level) => level === "low").length,
    medium: attentionLevels.filter((level) => level === "medium").length,
    high: attentionLevels.filter((level) => level === "high").length,
  };
  const linesInContext = activeReport.knows.reads.reduce((sum, read) => sum + (read.endLine - read.startLine + 1), 0);
  const changesTotal =
    activeReport.changes.created.length +
    activeReport.changes.modified.length +
    activeReport.changes.deleted.length +
    activeReport.changes.observed.length;
  const changeAdds = activeReport.changes.additions;
  const changeDels = activeReport.changes.deletions;
  const outcomeChip = OUTCOME_CHIP[activeReport.outcome] ?? "mute";
  // The four cumulative cards share the selection's scope: the selected run,
  // or every run in the session under "all runs".
  const kpiTotals = allRuns ? allData.totals : singleTotals;

  const headline = !allRuns && running ? data.liveHeadline ?? t(activeReport.headline) : t(activeReport.headline);
  const duration = formatOffset(durationMs);

  const fileRow = (file: FileDelta, label: string) => {
    const fact = activeFacts.files.byPath[file.path];
    const selected = Boolean(pick && file.evidence.includes(pick.eventId));
    return (
      <button
        key={file.path}
        type="button"
        onClick={() => reveal(file.evidence)}
        title={`${label} — ${file.path}`}
        className={`chart-it${selected ? " chart-it--sel" : ""}`}
      >
        <span className="chart-it__n">{file.path}</span>
        {fact && fact.additions + fact.deletions > 0 ? (
          <span className="chart-it__m chart-it__m--add">
            +{fact.additions} −{fact.deletions}
          </span>
        ) : null}
      </button>
    );
  };

  return (
    <div className="mon-root chart-root">
      <FaceBar />

      <div className="chart-wrap">
        {/* ── the run, in one sentence ──────────────────────────────────── */}
        <section className="chart-hero">
          <span className="chart-hero__icon" aria-hidden>
            <img src="/app-icon.png" alt="" />
          </span>

          <div style={{ minWidth: 0 }}>
            <div className="chart-meta">
              <span className={`chart-chip chart-chip--${outcomeChip}`}>{t(activeReport.outcome.replace(/_/g, " "))}</span>
              {allRuns ? (
                <span>{t("all runs")} · {t("{n} runs", { n: runs.length })}</span>
              ) : (
                <span>{t("run #{index}", { index: activeRun.index })}</span>
              )}
              <span aria-hidden>·</span>
              <span>{session?.agentRuntime ?? "—"}</span>
              <span aria-hidden>·</span>
              <span className="chart-mono">{duration}</span>
              <span aria-hidden>·</span>
              <span>{t("{n} activities", { n: activeReport.timeline.length })}</span>
            </div>
            <div className="chart-h1" title={headline}>
              {headline}
            </div>
            <div className="chart-req">
              <span className="chart-req__cap">{t("Started")}</span>
              <span className="chart-req__text chart-mono">{formatClock(activeRun.startedAt)}</span>
              <span aria-hidden>→</span>
              <span className="chart-req__cap">{t("Ended")}</span>
              <span className="chart-req__text chart-mono">
                {activeRun.endedAt ? formatClock(activeRun.endedAt) : t("running")}
              </span>
            </div>
          </div>

          {/* Round switching: the report is per run, so the run is the first
              choice a reader makes. A pill at the hero's top-right, its list
              opening downward over the numbers. */}
          <div className="chart-hero__side">
          <div className="chart-runselwrap" ref={menuRef}>
            <button
              type="button"
              className="chart-runsel"
              onClick={() => setRunMenu((open) => !open)}
              aria-expanded={runMenu}
              aria-haspopup="listbox"
              title={runs.length > 1 ? t("Switch run") : t("The run this report is of")}
            >
              <span className={`chart-runsel__dot chart-runsel__dot--${activeRun.status}`} aria-hidden />
              <span className="chart-runsel__label">
                {allRuns
                  ? `${t("all runs")} · ${t("{n} runs", { n: runs.length })}`
                  : `#${activeRun.index} · ${t(RUN_WORD[activeRun.status])}`}
              </span>
              <span aria-hidden>{runMenu ? "▴" : "▾"}</span>
            </button>

            {runMenu ? (
              <ul className="chart-runmenu mon-slimscroll" role="listbox" aria-label={t("Runs")}>
                <li>
                  <button
                    type="button"
                    role="option"
                    aria-selected={allRuns}
                    data-current={allRuns ? "true" : undefined}
                    className="chart-runmenu__item"
                    onClick={() => {
                      setAllRuns(true);
                      setRunMenu(false);
                    }}
                  >
                    <span className="chart-runmenu__head">
                      <span className="chart-runsel__dot" aria-hidden />
                      <span className="chart-runmenu__title">{t("all runs")}</span>
                      <span className="chart-runmenu__time chart-mono">
                        {t("{n} runs", { n: runs.length })}
                      </span>
                    </span>
                    <span className="chart-runmenu__prompt">{t("Aggregate every run in this session")}</span>
                  </button>
                </li>
                {[...runs].reverse().map((entry) => (
                  <li key={entry.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={!allRuns && entry.id === activeRun.id}
                      data-current={!allRuns && entry.id === activeRun.id ? "true" : undefined}
                      className="chart-runmenu__item"
                      onClick={() => {
                        setAllRuns(false);
                        selectRun(entry.id);
                        setRunMenu(false);
                      }}
                    >
                      <span className="chart-runmenu__head">
                        <span
                          className={`chart-runsel__dot chart-runsel__dot--${entry.status}`}
                          aria-hidden
                        />
                        <span className="chart-runmenu__title">
                          #{entry.index} · {t(RUN_WORD[entry.status])}
                        </span>
                        <span className="chart-runmenu__time chart-mono">{formatClock(entry.startedAt)}</span>
                      </span>
                      <span className="chart-runmenu__prompt">{entry.prompt}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          </div>
        </section>

        {/* ── the selection's four numbers, then its cumulative four ──── */}
        <section className={`chart-kpis${kpiTotals ? " chart-kpis--eight" : ""}`}>
          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Knows")}</span>
              <span className="chart-chip chart-chip--read">{t("READ")}</span>
            </div>
            <div className="chart-kpi__v">{t("{n} files", { n: activeReport.knows.reads.length })}</div>
            <div className="chart-kpi__s">
              {t("{n} lines in context · {s} searches", {
                n: linesInContext,
                s: activeReport.knows.searches.length,
              })}
            </div>
          </div>

          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Changes")}</span>
              <span className="chart-chip chart-chip--edit">{t("EDIT")}</span>
            </div>
            <div className="chart-kpi__v">
              {t("{n} files", { n: activeReport.changes.created.length + activeReport.changes.modified.length })}{" "}
              <span className="chart-kpi__delta chart-kpi__delta--add">+{changeAdds}</span>{" "}
              <span className="chart-kpi__delta chart-kpi__delta--del">−{changeDels}</span>
            </div>
            <div className="chart-kpi__s">
              {t("{m} modified · {c} created", {
                m: activeReport.changes.modified.length,
                c: activeReport.changes.created.length,
              })}
            </div>
          </div>

          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Executions")}</span>
              <span className="chart-chip chart-chip--run">{t("RUN")}</span>
            </div>
            <div className="chart-kpi__v">{t("{n} commands", { n: activeReport.execution.commands })}</div>
            <div className="chart-kpi__s">
              {t("{s} succeeded · {f} failed · {u} unknown", {
                s: activeReport.execution.succeeded,
                f: activeReport.execution.failed,
                u: activeReport.execution.unknown,
              })}
            </div>
          </div>

          <div className={`chart-kpi${attention.level === "high" ? " chart-kpi--att" : ""}`}>
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Attention")}</span>
              <span className={`chart-chip chart-chip--${ATTENTION_CHIP[attention.level]}`}>{t(attention.level)}</span>
            </div>
            <div className="chart-kpi__v">{t("{n} triggers", { n: attention.reasons.length })}</div>
            <div className="chart-kpi__s">
              {t("{h} high · {m} medium · {l} low", {
                h: attentionCounts.high,
                m: attentionCounts.medium,
                l: attentionCounts.low,
              })}
            </div>
          </div>

          {kpiTotals ? <StatsKpiCards totals={kpiTotals} scope={allRuns ? "runs" : "run"} /> : null}
        </section>

        {/* ── the spine ──────────────────────────────────────────────────── */}
        <section className="chart-tlc">
          <div className="chart-tlh">
            <span className="chart-tlh__cap">{t("Timeline")}</span>
            <span className="chart-tlh__hint">{t("Click a block to inspect")}</span>
            <span className="chart-tlh__count">
              {allRuns
                ? `${t("{n} activities", { n: activeReport.timeline.length })} · ${t("{n} runs", { n: runs.length })}`
                : t("{n} activities", { n: activeReport.timeline.length })}
            </span>
          </div>
          <ChartTimeline
            tracks={activeTracks}
            totalMs={timelineTotalMs({
              startedAt: activeRun.startedAt,
              endedAt: activeRun.endedAt,
              lastOffsetMs: activeReport.timeline.at(-1)?.offsetMs ?? 0,
              // Chart already ticks once a second for its live headline; the
              // axis follows the same clock while the run is in flight, then
              // freezes at the run's duration once it settles.
              nowMs: activeRun.endedAt === undefined ? now : undefined,
            })}
            selected={pick}
            onPick={(next) => {
              setPick(next);
            }}
          />
        </section>

        {/* ── lists | evidence ───────────────────────────────────────────── */}
        <section className="chart-split">
          <div className="chart-panel chart-panel--lists">
            {/* The switch bar is a vertical rail on the panel's left: the lists
                it picks between grew past a horizontal strip of pills. */}
            <div className="chart-listsrow">
            <div className="chart-rail" role="tablist" aria-label={t("Report lists")}>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "changes"}
                onClick={() => setTab("changes")}
                className={`chart-rail__item${tab === "changes" ? " chart-rail__item--on" : ""}`}
              >
                <span className="chart-rail__label">{t("Changes")}</span>
                <em>{changesTotal}</em>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "executions"}
                onClick={() => setTab("executions")}
                className={`chart-rail__item${tab === "executions" ? " chart-rail__item--on" : ""}`}
              >
                <span className="chart-rail__label">{t("Executions")}</span>
                <em>{activeReport.execution.commands}</em>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "knows"}
                onClick={() => setTab("knows")}
                className={`chart-rail__item${tab === "knows" ? " chart-rail__item--on" : ""}`}
              >
                <span className="chart-rail__label">{t("Knows")}</span>
                <em>{activeReport.knows.reads.length + activeReport.knows.searches.length}</em>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "toolcalls"}
                onClick={() => setTab("toolcalls")}
                className={`chart-rail__item${tab === "toolcalls" ? " chart-rail__item--on" : ""}`}
              >
                <span className="chart-rail__label">{t("Tool calls")}</span>
                <em>{toolCalls.length}</em>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "errors"}
                onClick={() => setTab("errors")}
                className={`chart-rail__item${tab === "errors" ? " chart-rail__item--on" : ""}`}
              >
                <span className="chart-rail__label">{t("Errors")}</span>
                <em>{errorRows.length}</em>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "attention"}
                onClick={() => setTab("attention")}
                className={`chart-rail__item${tab === "attention" ? " chart-rail__item--on" : ""}`}
                title={t("Human attention")}
              >
                <span className={`chart-rail__dot chart-rail__dot--${attention.level}`} aria-hidden />
                <span className="chart-rail__label">{t("Attention")}</span>
                <em>{attention.reasons.length}</em>
              </button>
            </div>

            <div className="chart-body">
              {tab === "changes" ? (
                changesTotal === 0 && activeReport.outsideChanges.length === 0 ? (
                  <p className="chart-empty">{t("No files changed.")}</p>
                ) : (
                  <>
                    {activeReport.changes.modified.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("modified")}</div>
                        {activeReport.changes.modified.map((file) => fileRow(file, t("modified")))}
                      </>
                    ) : null}
                    {activeReport.changes.created.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("created")}</div>
                        {activeReport.changes.created.map((file) => fileRow(file, t("created")))}
                      </>
                    ) : null}
                    {activeReport.changes.deleted.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("deleted")}</div>
                        {activeReport.changes.deleted.map((file) => fileRow(file, t("deleted")))}
                      </>
                    ) : null}
                    {activeReport.changes.observed.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("observed")}</div>
                        {activeReport.changes.observed.map((file) => fileRow(file, t("observed")))}
                      </>
                    ) : null}
                    <div className="chart-gh">{t("Outside the project")}</div>
                    {activeReport.outsideChanges.length > 0 ? (
                      activeReport.outsideChanges.map((change) => (
                        <button
                          key={change.path}
                          type="button"
                          onClick={() => reveal(change.evidence)}
                          className="chart-it"
                        >
                          <span className="chart-it__n" style={{ color: "var(--ch-err)" }}>
                            {change.path}
                          </span>
                          {change.count > 1 ? <span className="chart-it__m">×{change.count}</span> : null}
                        </button>
                      ))
                    ) : (
                      <div className="chart-it chart-it--note">{t("No outside changes.")}</div>
                    )}
                  </>
                )
              ) : null}

              {tab === "executions" ? (
                activeReport.executions.length === 0 ? (
                  <p className="chart-empty">{t("No commands run.")}</p>
                ) : (
                  activeReport.executions.map((command) => (
                    <button
                      key={command.eventId}
                      type="button"
                      onClick={() => reveal(command.evidence)}
                      className={`chart-it${pick && command.evidence.includes(pick.eventId) ? " chart-it--sel" : ""}`}
                      title={command.command}
                    >
                      <span
                        className="chart-it__n"
                        style={command.status === "failed" ? { color: "var(--ch-err)" } : undefined}
                      >
                        $ {command.command || "(shell)"}
                      </span>
                      <span className={`chart-it__m${command.status === "failed" ? " chart-it__m--err" : ""}`}>
                        {commandLabel(t, command)}
                      </span>
                    </button>
                  ))
                )
              ) : null}

              {tab === "knows" ? (
                activeReport.knows.reads.length === 0 && activeReport.knows.searches.length === 0 ? (
                  <p className="chart-empty">{t("Nothing inspected.")}</p>
                ) : (
                  <>
                    {activeReport.knows.reads.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("read")}</div>
                        {activeReport.knows.reads.map((read) => (
                          <button
                            key={read.path}
                            type="button"
                            onClick={() => reveal(read.evidence)}
                            className={`chart-it${pick && read.evidence.includes(pick.eventId) ? " chart-it--sel" : ""}`}
                            title={read.path}
                          >
                            <span className="chart-it__n">{read.path}</span>
                            <span className="chart-it__m">
                              {read.rangeKnown === false
                                ? t("range unknown")
                                : t("lines {a}–{b}", { a: read.startLine, b: read.endLine })}
                            </span>
                          </button>
                        ))}
                      </>
                    ) : null}
                    {activeReport.knows.searches.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("searched")}</div>
                        {activeReport.knows.searches.map((search, index) => (
                          <button
                            key={`${search.tool}-${index}`}
                            type="button"
                            onClick={() => reveal(search.evidence)}
                            className={`chart-it${pick && search.evidence.includes(pick.eventId) ? " chart-it--sel" : ""}`}
                            title={`${search.tool} ${search.query}`}
                          >
                            <span className="chart-it__n">
                              {search.tool} “{search.query}”
                            </span>
                            <span className="chart-it__m">{t("{n} hits", { n: search.matches })}</span>
                          </button>
                        ))}
                      </>
                    ) : null}
                  </>
                )
              ) : null}

              {tab === "toolcalls" ? (
                toolCalls.length === 0 ? (
                  <p className="chart-empty">{t("No tool calls.")}</p>
                ) : (
                  toolCalls.map((call) => (
                    <button
                      key={call.eventId}
                      type="button"
                      onClick={() => reveal(call.evidence)}
                      className={`chart-it${pick && call.evidence.includes(pick.eventId) ? " chart-it--sel" : ""}`}
                      title={call.toolCallId}
                    >
                      <span
                        className="chart-it__n"
                        style={call.isError ? { color: "var(--ch-err)" } : undefined}
                      >
                        {call.toolName}
                      </span>
                      <span className={`chart-it__m${call.isError ? " chart-it__m--err" : ""}`}>
                        {call.running
                          ? t("running")
                          : call.durationMs !== undefined
                            ? formatOffset(call.durationMs)
                            : t("unknown")}
                      </span>
                    </button>
                  ))
                )
              ) : null}

              {tab === "errors" ? (
                errorRows.length === 0 ? (
                  <p className="chart-empty">{t("No errors.")}</p>
                ) : (
                  errorRows.map((row) => (
                    <button
                      key={row.eventId}
                      type="button"
                      onClick={() => reveal([row.eventId])}
                      className={`chart-it${pick?.eventId === row.eventId ? " chart-it--sel" : ""}`}
                      title={row.message}
                    >
                      <span className="chart-it__n" style={{ color: "var(--ch-err)" }}>
                        {row.message}
                      </span>
                      <span className="chart-it__m chart-mono">{formatClock(row.at)}</span>
                    </button>
                  ))
                )
              ) : null}

              {tab === "attention" ? (
                attention.reasons.length > 0 ? (
                  <ul className="chart-att-list">
                    {attention.reasons.map((reason) => {
                      const level = reasonLevel(reason, attentionOptions);
                      return (
                        <li key={reason} className="chart-att-item">
                          <span className={`chart-att-lvl chart-att-lvl--${level}`}>{t(level)}</span>
                          <span className="chart-att-txt">{t(ATTENTION_REASON_TEXT[reason])}</span>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="chart-empty">{t("Agent is working normally.")}</p>
                )
              ) : null}
            </div>
            </div>
          </div>

          <div className="chart-panel chart-panel--preview">
            {previewEvent ? (
              <>
                <div className="chart-pt">
                  <span className={`chart-chip chart-chip--${pick?.node ? KIND_CHIP[pick.node.kind] : "mute"}`}>
                    {pick?.node ? t(pick.node.action) : previewEvent.type}
                  </span>
                  <span className="chart-pt__name" title={pick?.node?.subject ?? previewItem?.title}>
                    {pick?.node?.subject ?? previewItem?.title ?? previewEvent.type}
                  </span>
                  <span className="chart-pt__meta">
                    {pick?.node ? formatOffset(pick.node.offsetMs) : formatClock(previewEvent.timestamp)}
                  </span>
                </div>
                <div className="chart-preview">
                  {previewItem ? (
                    <StageItemView item={previewItem} showToolbar={false} />
                  ) : (
                    <p className="chart-empty">{t("No preview for a {type} event.", { type: previewEvent.type })}</p>
                  )}
                </div>
                {pick?.node?.effects.length ? (
                  <div className="chart-reply" style={{ maxHeight: 56 }}>
                    {pick.node.effects.join(" · ")}
                  </div>
                ) : null}
              </>
            ) : (
              <div className="chart-preview__empty">{t("Pick a block or a row to see the evidence.")}</div>
            )}
          </div>

          {/* ── what went in, what came out ────────────────────────────────── */}
          <div className="chart-panel chart-panel--io">
            <div className="chart-pt">
              <span className="chart-chip chart-chip--read">{t("Request")}</span>
              <span className="chart-pt__name">{t("Input and output")}</span>
              <span className="chart-pt__meta">{formatClock(activeRun.startedAt)}</span>
            </div>
            <div className="chart-body chart-io">
              <section className="chart-io__sec" ref={ioARef}>
                <div className="chart-io__cap">{t("Request")}</div>
                {allRuns ? (
                  // Every prompt is what went in; a single "request" would be made up.
                  runs.map((entry) => (
                    <p key={entry.id} className="chart-io__text">
                      #{entry.index} {entry.prompt}
                    </p>
                  ))
                ) : (
                  <p className="chart-io__text">{activeRun.prompt}</p>
                )}
              </section>
              <section className="chart-io__sec" ref={ioBRef}>
                <div className="chart-io__cap">{t("Response")}</div>
                {activeReport.response ? (
                  <p className="chart-io__text">{activeReport.response}</p>
                ) : (
                  <p className="chart-empty">{t("No response yet.")}</p>
                )}
              </section>
            </div>
          </div>
        </section>
      </div>

      {/* The report page scrolls; the input does not — one rounded line, always
          reachable at the bottom, in the same FaceChat skin as every face. */}
      <ChartChat />
    </div>
  );
}

function commandLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  command: CommandFact,
): string {
  if (command.permissionDenied || command.status === "denied") return t("not executed · permission denied");
  if (command.status === "running") return t("running");
  if (command.exitCodeKnown === false) return t("exit ?");
  if (command.exitCode !== undefined) return t("exit {code}", { code: command.exitCode });
  if (command.status === "failed") return t("failed");
  return t("unknown");
}
