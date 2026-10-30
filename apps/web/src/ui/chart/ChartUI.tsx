import { useEffect, useMemo, useState } from "react";
import type { AbsenceEvent } from "@absence/core";
import { formatClock, formatOffset } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { useT } from "../../lib/i18n";
import {
  DEFAULT_AGENT_STOPPED_LEVEL,
  DEFAULT_COMMAND_RETRY_LOOP_LEVEL,
  DEFAULT_FILE_VERSION_LOOP_LEVEL,
  DEFAULT_OUTSIDE_CHANGE_LEVEL,
  DEFAULT_PROCESS_LEFT_RUNNING_LEVEL,
  DEFAULT_UNRESOLVED_ERROR_LEVEL,
  renderRun,
} from "../../lib/report";
import { eventToStageItem } from "../../lib/events";
import { leaveSession } from "../../stores/reset";
import { useSessionStore } from "../../stores/sessionStore";
import { ViewModeSwitch } from "../../components/layout/ViewModeSwitch";
import { WindowControls } from "../../components/common/WindowControls";
import { StageItemView } from "../../components/stage/StageItemView";
import { ATTENTION_REASON_TEXT } from "../../components/stage/ReportOverlay";
import { useMonitorData } from "../monitor/useMonitorData";
import type {
  AttentionLevel,
  AttentionReason,
  CommandFact,
  FileDelta,
  ReportAttentionOptions,
  TimelineKind,
} from "../../types/report";

import { ChartTimeline, type TimelinePick } from "./ChartTimeline";
import "./chart.css";

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
 * engine.
 */

const KIND_CHIP: Record<TimelineKind, string> = {
  start: "mute",
  think: "think",
  read: "read",
  search: "search",
  edit: "edit",
  write: "edit",
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

type Tab = "changes" | "executions" | "knows";

export function ChartUI() {
  const t = useT();
  const now = useNow(1000);
  const attentionOptions = useAttentionOptions();
  const data = useMonitorData();
  const session = useSessionStore((s) => s.session);
  const connected = useSessionStore((s) => s.connected);
  const desktop = Boolean(window.absenceDesktop);

  const run = data.run;
  const report = useMemo(() => (data.facts ? renderRun(data.facts) : undefined), [data.facts]);

  const [tab, setTab] = useState<Tab>("changes");
  const [pick, setPick] = useState<TimelinePick | undefined>(undefined);
  const [attOpen, setAttOpen] = useState(false);
  useEffect(() => {
    setPick(undefined);
    setAttOpen(false);
  }, [run?.id]);

  /** Prefer the newest event behind a set of evidence ids that has something to render. */
  const reveal = (ids: string[], node?: TimelinePick["node"]) => {
    const wanted = new Set(ids);
    let chosen: AbsenceEvent | undefined;
    let fallback: AbsenceEvent | undefined;
    for (let i = data.events.length - 1; i >= 0; i--) {
      const event = data.events[i]!;
      if (!wanted.has(event.id)) continue;
      if (!chosen && eventToStageItem(event)) chosen = event;
      if (!fallback) fallback = event;
    }
    const event = chosen ?? fallback;
    if (!event) return;
    setAttOpen(false);
    setPick({
      eventId: event.id,
      node,
      anchorMs: node?.offsetMs ?? (run ? Math.max(0, event.timestamp - run.startedAt) : 0),
      label: node?.action ? `${t(node.action)} · ${formatOffset(node.offsetMs)}` : formatClock(event.timestamp),
    });
  };

  const previewEvent = useMemo(() => {
    if (!pick) return undefined;
    for (let i = data.events.length - 1; i >= 0; i--) {
      if (data.events[i]!.id === pick.eventId) return data.events[i];
    }
    return undefined;
  }, [pick, data.events]);
  const previewItem = previewEvent ? eventToStageItem(previewEvent) : undefined;

  const durationMs = run ? (run.endedAt ?? now) - run.startedAt : 0;
  const facts = data.facts;

  if (!run) {
    return (
      <div className="chart-root">
        <Header
          nowMs={now}
          desktop={desktop}
          runtime={session?.agentRuntime}
          sessionId={session?.id}
          path={session?.projectPath}
          connected={connected}
        />
        <div className="chart-page-empty">{t("Nothing to report yet — send the agent a task.")}</div>
      </div>
    );
  }

  if (!report || !facts) {
    return (
      <div className="chart-root">
        <Header
          nowMs={now}
          desktop={desktop}
          runtime={session?.agentRuntime}
          sessionId={session?.id}
          path={session?.projectPath}
          connected={connected}
        />
        <div className="chart-page-empty">{t("loading…")}</div>
      </div>
    );
  }

  const running = run.status === "running";
  const attention = data.attention;
  const attentionLevels = attention.reasons.map((reason) => reasonLevel(reason, attentionOptions));
  const attentionCounts = {
    low: attentionLevels.filter((level) => level === "low").length,
    medium: attentionLevels.filter((level) => level === "medium").length,
    high: attentionLevels.filter((level) => level === "high").length,
  };
  const linesInContext = report.knows.reads.reduce((sum, read) => sum + (read.endLine - read.startLine + 1), 0);
  const changesTotal =
    report.changes.created.length +
    report.changes.modified.length +
    report.changes.deleted.length +
    report.changes.observed.length;
  const changeAdds = report.changes.additions;
  const changeDels = report.changes.deletions;
  const outcomeChip = OUTCOME_CHIP[report.outcome] ?? "mute";

  const headline = running ? data.liveHeadline ?? t(report.headline) : t(report.headline);
  const duration = formatOffset(durationMs);

  const fileRow = (file: FileDelta, label: string) => {
    const fact = facts.files.byPath[file.path];
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
    <div className="chart-root">
      <Header
        nowMs={now}
        desktop={desktop}
        runtime={session?.agentRuntime}
        sessionId={session?.id}
        path={session?.projectPath}
        connected={connected}
      />

      <div className="chart-wrap">
        {/* ── the run, in one sentence ──────────────────────────────────── */}
        <section className="chart-hero">
          <span className="chart-hero__icon" aria-hidden>
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <circle cx="14" cy="14" r="10.5" stroke="currentColor" strokeWidth="1.2" opacity="0.5" />
              <circle cx="14" cy="14" r="4" stroke="currentColor" strokeWidth="1.2" />
            </svg>
          </span>

          <div style={{ minWidth: 0 }}>
            <div className="chart-meta">
              <span className={`chart-chip chart-chip--${outcomeChip}`}>{t(report.outcome.replace(/_/g, " "))}</span>
              <span>{t("run #{index}", { index: run.index })}</span>
              <span aria-hidden>·</span>
              <span>{session?.agentRuntime ?? "—"}</span>
              <span aria-hidden>·</span>
              <span className="chart-mono">{duration}</span>
              <span aria-hidden>·</span>
              <span>{t("{n} activities", { n: report.timeline.length })}</span>
            </div>
            <div className="chart-h1" title={headline}>
              {headline}
            </div>
            <div className="chart-req">
              <span>{t("Request")}:</span>
              <span className="chart-req__text" title={run.prompt}>
                {run.prompt || t("(observed activity)")}
              </span>
            </div>
          </div>
        </section>

        {/* ── four numbers ───────────────────────────────────────────────── */}
        <section className="chart-kpis">
          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Knows")}</span>
              <span className="chart-chip chart-chip--read">{t("READ")}</span>
            </div>
            <div className="chart-kpi__v">{t("{n} files", { n: report.knows.reads.length })}</div>
            <div className="chart-kpi__s">
              {t("{n} lines in context · {s} searches", {
                n: linesInContext,
                s: report.knows.searches.length,
              })}
            </div>
          </div>

          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Changes")}</span>
              <span className="chart-chip chart-chip--edit">{t("EDIT")}</span>
            </div>
            <div className="chart-kpi__v">
              {t("{n} files", { n: report.changes.created.length + report.changes.modified.length })}{" "}
              <span className="chart-kpi__delta chart-kpi__delta--add">+{changeAdds}</span>{" "}
              <span className="chart-kpi__delta chart-kpi__delta--del">−{changeDels}</span>
            </div>
            <div className="chart-kpi__s">
              {t("{m} modified · {c} created", {
                m: report.changes.modified.length,
                c: report.changes.created.length,
              })}
            </div>
          </div>

          <div className="chart-kpi">
            <div className="chart-kpi__row">
              <span className="chart-kpi__cap">{t("Executions")}</span>
              <span className="chart-chip chart-chip--run">{t("RUN")}</span>
            </div>
            <div className="chart-kpi__v">{t("{n} commands", { n: report.execution.commands })}</div>
            <div className="chart-kpi__s">
              {t("{s} succeeded · {f} failed · {u} unknown", {
                s: report.execution.succeeded,
                f: report.execution.failed,
                u: report.execution.unknown,
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
        </section>

        {/* ── the spine ──────────────────────────────────────────────────── */}
        <section className="chart-tlc">
          <div className="chart-tlh">
            <span className="chart-tlh__cap">{t("Timeline")}</span>
            <span className="chart-tlh__hint">{t("Click a block to inspect")}</span>
            <span className="chart-tlh__count">{t("{n} activities", { n: report.timeline.length })}</span>
          </div>
          <ChartTimeline
            nodes={report.timeline}
            processes={report.processes}
            startedAt={run.startedAt}
            totalMs={Math.max(1, durationMs)}
            selected={pick}
            onPick={(next) => {
              setAttOpen(false);
              setPick(next);
            }}
          />
        </section>

        {/* ── lists | evidence ───────────────────────────────────────────── */}
        <section className="chart-split">
          <div className="chart-panel chart-panel--lists">
            <div className="chart-pt chart-pt--lists">
              <div className="chart-tabs">
                <button
                  type="button"
                  onClick={() => setTab("changes")}
                  className={`chart-tab${tab === "changes" ? " chart-tab--on" : ""}`}
                >
                  {t("Changes")}
                  <em>{changesTotal}</em>
                </button>
                <button
                  type="button"
                  onClick={() => setTab("executions")}
                  className={`chart-tab${tab === "executions" ? " chart-tab--on" : ""}`}
                >
                  {t("Executions")}
                  <em>{report.execution.commands}</em>
                </button>
                <button
                  type="button"
                  onClick={() => setTab("knows")}
                  className={`chart-tab${tab === "knows" ? " chart-tab--on" : ""}`}
                >
                  {t("Knows")}
                  <em>{report.knows.reads.length + report.knows.searches.length}</em>
                </button>
              </div>

              <button
                type="button"
                className={`chart-att-btn chart-att-btn--${attention.level}`}
                onClick={() => setAttOpen((open) => !open)}
                aria-expanded={attOpen}
                aria-controls="chart-att-panel"
                title={t("Human attention")}
              >
                <span className="chart-att-btn__dot" aria-hidden />
                {t("Attention")} · {attention.reasons.length}
                <span aria-hidden>{attOpen ? "▴" : "▾"}</span>
              </button>
            </div>

            <div className="chart-body">
              {tab === "changes" ? (
                changesTotal === 0 && report.outsideChanges.length === 0 ? (
                  <p className="chart-empty">{t("No files changed.")}</p>
                ) : (
                  <>
                    {report.changes.modified.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("modified")}</div>
                        {report.changes.modified.map((file) => fileRow(file, t("modified")))}
                      </>
                    ) : null}
                    {report.changes.created.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("created")}</div>
                        {report.changes.created.map((file) => fileRow(file, t("created")))}
                      </>
                    ) : null}
                    {report.changes.deleted.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("deleted")}</div>
                        {report.changes.deleted.map((file) => fileRow(file, t("deleted")))}
                      </>
                    ) : null}
                    {report.changes.observed.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("observed")}</div>
                        {report.changes.observed.map((file) => fileRow(file, t("observed")))}
                      </>
                    ) : null}
                    <div className="chart-gh">{t("Outside the project")}</div>
                    {report.outsideChanges.length > 0 ? (
                      report.outsideChanges.map((change) => (
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
                report.executions.length === 0 ? (
                  <p className="chart-empty">{t("No commands run.")}</p>
                ) : (
                  report.executions.map((command) => (
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
                report.knows.reads.length === 0 && report.knows.searches.length === 0 ? (
                  <p className="chart-empty">{t("Nothing inspected.")}</p>
                ) : (
                  <>
                    {report.knows.reads.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("read")}</div>
                        {report.knows.reads.map((read) => (
                          <button
                            key={read.path}
                            type="button"
                            onClick={() => reveal(read.evidence)}
                            className={`chart-it${pick && read.evidence.includes(pick.eventId) ? " chart-it--sel" : ""}`}
                            title={read.path}
                          >
                            <span className="chart-it__n">{read.path}</span>
                            <span className="chart-it__m">
                              {t("lines {a}–{b}", { a: read.startLine, b: read.endLine })}
                            </span>
                          </button>
                        ))}
                      </>
                    ) : null}
                    {report.knows.searches.length > 0 ? (
                      <>
                        <div className="chart-gh">{t("searched")}</div>
                        {report.knows.searches.map((search, index) => (
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
            </div>

            {report.response ? (
              <div className="chart-reply">
                <div className="chart-reply__cap">{t("Response")}</div>
                {report.response}
              </div>
            ) : null}
          </div>

          <div className="chart-panel chart-panel--preview" id="chart-att-panel">
            {attOpen ? (
              <>
                <div className="chart-pt">
                  <span className={`chart-chip chart-chip--${ATTENTION_CHIP[attention.level]}`}>
                    {t(attention.level)}
                  </span>
                  <span className="chart-pt__name">{t("Attention")}</span>
                  <span className="chart-pt__meta">{t("{n} reasons", { n: attention.reasons.length })}</span>
                  <button
                    type="button"
                    className="chart-btn chart-att-close"
                    onClick={() => setAttOpen(false)}
                  >
                    {t("Close")}
                  </button>
                </div>
                <div className="chart-body">
                  {attention.reasons.length > 0 ? (
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
                  )}
                </div>
              </>
            ) : previewEvent ? (
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
        </section>
      </div>
    </div>
  );
}

function Header({
  nowMs,
  desktop,
  runtime,
  sessionId,
  path,
  connected,
}: {
  nowMs: number;
  desktop: boolean;
  runtime?: string;
  sessionId?: string;
  path?: string;
  connected: boolean;
}) {
  const t = useT();
  return (
    <header className={`chart-top${desktop ? " chart-drag" : ""}`}>
      <span className="chart-top__logo">ABSENCE</span>
      <span className="chart-top__clock chart-mono">{formatClock(nowMs)}</span>

      {runtime ? (
        <span className="chart-term chart-nodrag" title={t("Connected terminal and session id")}>
          <span>{runtime}</span>
          {sessionId ? <span className="chart-term__sid chart-mono">{sessionId}</span> : null}
        </span>
      ) : null}

      <span className="chart-top__path chart-mono" title={path}>
        {path ?? t("No run yet")}
      </span>

      <span className="chart-top__spacer" aria-hidden />

      <span className={`chart-chip${connected ? " chart-chip--live" : ""}`}>
        <span aria-hidden>●</span> {connected ? t("live") : t("offline")}
      </span>

      <div className="chart-nodrag">
        <ViewModeSwitch />
      </div>

      <button
        type="button"
        onClick={leaveSession}
        title={t("Close this session and pick another project")}
        className="chart-btn chart-nodrag"
      >
        {t("change")}
      </button>

      <WindowControls />
    </header>
  );
}

function commandLabel(
  t: (key: string, params?: Record<string, string | number>) => string,
  command: CommandFact,
): string {
  if (command.status === "running") return t("running");
  if (command.exitCode !== undefined) return t("exit {code}", { code: command.exitCode });
  if (command.status === "failed") return t("failed");
  return t("unknown");
}

/**
 * The level a fired reason raised, from the user's settings with the engine's
 * own defaults. `computeAttention` keeps only the loudest level for the run;
 * this restores the per-rule reading so the card can count by level.
 */
function reasonLevel(reason: AttentionReason, options: ReportAttentionOptions): AttentionLevel {
  switch (reason) {
    case "agent_stopped":
      return options.agentStoppedLevel ?? DEFAULT_AGENT_STOPPED_LEVEL;
    case "unresolved_error":
      return options.unresolvedErrorLevel ?? DEFAULT_UNRESOLVED_ERROR_LEVEL;
    case "command_failed":
      return options.commandFailLevel ?? "low";
    case "command_failure_streak":
      return options.commandStreakLevel ?? "low";
    case "activity_stalled":
      return options.activityStallLevel ?? "medium";
    case "process_left_running":
      return options.processLeftRunningLevel ?? DEFAULT_PROCESS_LEFT_RUNNING_LEVEL;
    case "outside_change":
      return options.outsideChangeLevel ?? DEFAULT_OUTSIDE_CHANGE_LEVEL;
    case "file_version_loop":
      return options.fileVersionLoopLevel ?? DEFAULT_FILE_VERSION_LOOP_LEVEL;
    case "command_retry_loop":
      return options.commandRetryLoopLevel ?? DEFAULT_COMMAND_RETRY_LOOP_LEVEL;
    default:
      return "none";
  }
}
