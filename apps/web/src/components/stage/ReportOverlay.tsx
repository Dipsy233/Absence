import { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy, type AbsenceEvent } from "@absence/core";
import { useNow } from "../../hooks/useNow";
import { memoBuildHistory, pickRun } from "../../lib/history";
import { eventToStageItem } from "../../lib/events";
import { buildRunFacts, renderLive, renderRun } from "../../lib/report";
import { formatOffset } from "../../lib/format";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useUiStore } from "../../stores/uiStore";
import { StageItemView } from "./StageItemView";
import type { HistoryRun } from "../../types/history";
import type {
  Attention,
  AttentionReason,
  CommandFact,
  FileDelta,
  LiveReport,
  RunReport,
  TimelineKind,
  TimelineNode,
} from "../../types/report";

/**
 * The Absence Report: a small tab at the top-centre of
 * the Stage that expands into a translucent layer over the Stage body. While a
 * run is live it reports the current phase; once it settles it summarises what
 * the run changed. Derived entirely from the AbsenceEvent stream.
 */
export function ReportOverlay() {
  const events = useSessionStore((s) => s.events);
  const status = useSessionStore((s) => s.agent.status);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const reportOpen = useUiStore((s) => s.reportOpen);
  const commandFailThreshold = useSettingsStore((s) => s.commandFailThreshold);
  const commandFailLevel = useSettingsStore((s) => s.commandFailLevel);
  const commandStreakThreshold = useSettingsStore((s) => s.commandStreakThreshold);
  const commandStreakLevel = useSettingsStore((s) => s.commandStreakLevel);
  const activityStallThreshold = useSettingsStore((s) => s.activityStallThreshold);
  const activityStallLevel = useSettingsStore((s) => s.activityStallLevel);
  const toggleReport = useUiStore((s) => s.toggleReport);
  const selectRun = useUiStore((s) => s.selectRun);
  const focusEvent = useUiStore((s) => s.focusEvent);

  const runs = useMemo(() => memoBuildHistory(events), [events]);
  const run = pickRun(runs, selectedRunId);

  // Skip the reduction while the layer is closed so live events stay cheap.
  const attentionOptions = useMemo(
    () => ({
      commandFailThreshold,
      commandFailLevel,
      commandStreakThreshold,
      commandStreakLevel,
      activityStallThreshold,
      activityStallLevel,
    }),
    [commandFailThreshold, commandFailLevel, commandStreakThreshold, commandStreakLevel, activityStallThreshold, activityStallLevel],
  );
  const facts = useMemo(
    () => (reportOpen && run ? buildRunFacts(events, run, attentionOptions) : undefined),
    [reportOpen, events, run, attentionOptions],
  );
  const running = run?.status === "running";
  // Ticks once a second so a stalled run re-renders and can cross the threshold.
  const nowMs = useNow(1000);
  const live = useMemo(
    () =>
      facts && running
        ? renderLive(facts, { busy: isAgentBusy(status), status, nowMs }, attentionOptions)
        : undefined,
    [facts, running, status, attentionOptions, nowMs],
  );
  const report = useMemo(() => (facts && !running ? renderRun(facts) : undefined), [facts, running]);

  /** What the pane to the left of the report is showing. */
  const [preview, setPreview] = useState<{ event: AbsenceEvent; node?: TimelineNode } | undefined>(undefined);
  useEffect(() => {
    if (!reportOpen) setPreview(undefined);
  }, [reportOpen]);

  /**
   * Evidence link: pin the run and highlight the Activity row, then show the
   * referenced event in the pane left of the report — without leaving the report
   * or touching the Stage. Picks the most recent evidence event that has content.
   * A timeline node also carries its effects, so the pane can say what the
   * activity caused even when its event has nothing to render.
   */
  const reveal = (ids: string[], node?: TimelineNode) => {
    if (run) selectRun(run.id);
    const wanted = new Set(ids);
    let chosen: AbsenceEvent | undefined;
    let fallback: AbsenceEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!;
      if (!wanted.has(event.id)) continue;
      if (!chosen && eventToStageItem(event)) chosen = event;
      if (!fallback) fallback = event;
    }
    const event = chosen ?? fallback;
    if (!event) return;
    focusEvent(event.id);
    setPreview({ event, node });
  };

  return (
    <>
      <button
        type="button"
        onClick={toggleReport}
        title={reportOpen ? "Collapse the Absence Report" : "Expand the Absence Report"}
        className={[
          "absolute left-1/2 top-0 z-40 -translate-x-1/2 rounded-b-md border border-t-0 px-3 py-0.5",
          "font-mono text-[10px] uppercase tracking-[0.15em] backdrop-blur-[2px] transition-colors",
          reportOpen
            ? "border-desk-amber/60 bg-desk-panel/90 text-desk-amber"
            : "border-desk-line bg-desk-panel/85 text-desk-dim hover:text-desk-amber",
        ].join(" ")}
      >
        {reportOpen ? "▲" : "▼"} ABSENCE REPORT
      </button>

      <AnimatePresence>
        {reportOpen ? (
          <motion.div
            key="report"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="absence-overlay absolute inset-x-0 top-0 bottom-14 z-30 flex overflow-hidden border border-desk-line/70 bg-desk-panel/85 backdrop-blur-[3px]"
          >
            <AnimatePresence>
              {preview ? (
                <EvidencePane
                  key="evidence"
                  event={preview.event}
                  node={preview.node}
                  onClose={() => setPreview(undefined)}
                />
              ) : null}
            </AnimatePresence>

            <div className="min-w-0 flex-1 overflow-auto">
              <div className="mx-auto max-w-2xl px-5 pb-8 pt-8">
                <div className="mb-4 flex items-center justify-between border-b border-desk-line pb-2">
                  <span className="font-mono text-sm uppercase tracking-[0.25em] text-desk-amber">Absence Report</span>
                  <div className="flex items-center gap-3 font-mono text-[10px] text-desk-dim">
                    {run ? <span>run #{run.index}</span> : null}
                    <button
                      type="button"
                      onClick={toggleReport}
                      className="rounded border border-desk-line px-1.5 py-0.5 hover:border-desk-amber/60 hover:text-desk-amber"
                    >
                      ✕ close
                    </button>
                  </div>
                </div>

                {report ? (
                  <RunReportView report={report} run={run} onReveal={reveal} />
                ) : live ? (
                  <LiveReportView live={live} />
                ) : (
                  <p className="py-10 text-center text-xs text-desk-dim">
                    Nothing to report yet — send the agent a task.
                  </p>
                )}
              </div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}

/**
 * The evidence pane, shown to the left of the report when a report item is
 * clicked. Renders the referenced event's content in place, so following a link
 * no longer leaves the report.
 */
function EvidencePane({
  event,
  node,
  onClose,
}: {
  event: AbsenceEvent;
  node?: TimelineNode;
  onClose: () => void;
}) {
  const item = eventToStageItem(event);
  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -8 }}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className="flex min-w-0 flex-1 flex-col border-r border-desk-line/70 bg-desk-deep/40"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line/70 px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.15em] text-desk-amber">Evidence</span>
        <button
          type="button"
          onClick={onClose}
          title="Close the evidence view"
          className="shrink-0 rounded border border-desk-line px-1.5 py-0.5 font-mono text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
        >
          ✕
        </button>
      </div>

      {/* Opened from a timeline node: what the activity was and what it caused. */}
      {node ? (
        <div className="shrink-0 border-b border-desk-line/70 px-3 py-2">
          <div className="font-mono text-[10px] uppercase tracking-wide text-desk-dim">
            {node.action} · {formatOffset(node.offsetMs)}
          </div>
          <div className="truncate font-mono text-[11px] text-desk-ink/85" title={node.subject}>
            {node.subject}
          </div>
          {node.effects.map((effect, index) => (
            <div key={index} className="text-[10px] leading-tight text-desk-amber/80">
              {effect}
            </div>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {item ? (
          <StageItemView item={item} />
        ) : (
          <p className="p-3 font-mono text-xs text-desk-dim">No preview for a {event.type} event.</p>
        )}
      </div>
    </motion.div>
  );
}

/** An evidence link: full-width, hover-highlighted like an Activity row. */
const LINK =
  "block w-full -mx-1 truncate rounded px-1 text-left font-mono text-[11px] transition-colors hover:bg-desk-panel2";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-4">
      <div className="label mb-1">{title}</div>
      <div className="text-xs leading-relaxed text-desk-ink/90">{children}</div>
    </section>
  );
}

function LiveReportView({ live }: { live: LiveReport }) {
  return (
    <div>
      <div className="mb-1 font-mono text-lg uppercase tracking-[0.2em] text-desk-amber">{live.phase}</div>
      <p className="mb-4 text-sm text-desk-ink">{live.headline}</p>

      <Section title="Progress">
        <ul className="space-y-0.5">
          {live.details.map((line, index) => (
            <li key={index} className="text-desk-ink/80">
              {line}
            </li>
          ))}
        </ul>
      </Section>

      <AttentionBlock attention={live.attention} />
    </div>
  );
}

function RunReportView({
  report,
  run,
  onReveal,
}: {
  report: RunReport;
  run?: HistoryRun;
  onReveal: (ids: string[], node?: TimelineNode) => void;
}) {
  const { created, modified, deleted, observed } = report.changes;
  const total = created.length + modified.length + deleted.length + observed.length;

  return (
    <div>
      <div className="mb-1 font-mono text-lg uppercase tracking-[0.2em] text-desk-amber">{report.outcome.replace(/_/g, " ")}</div>
      <p className="mb-1 text-sm text-desk-ink">{report.headline}</p>
      <p className="mb-4 font-mono text-[10px] text-desk-dim">duration {formatOffset(report.durationMs)}</p>

      {report.timeline.length > 0 ? (
        <Section title={`Timeline · ${report.timeline.length}`}>
          <TimelineStrip nodes={report.timeline} onSelect={(node) => onReveal([node.eventId], node)} />
        </Section>
      ) : null}

      {run ? (
        <Section title="Request">
          <p className="whitespace-pre-wrap text-desk-ink/90">{run.prompt}</p>
        </Section>
      ) : null}

      <Section title="Knows">
        {report.knows.reads.length === 0 && report.knows.searches.length === 0 ? (
          <p className="text-desk-dim">Nothing inspected.</p>
        ) : (
          <div className="space-y-2">
            {report.knows.reads.length > 0 ? (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wide text-desk-dim">read</div>
                <ul className="space-y-0.5">
                  {report.knows.reads.map((read) => (
                    <li key={read.path}>
                      <button
                        type="button"
                        onClick={() => onReveal(read.evidence)}
                        title={`Show in Activity — ${read.path}`}
                        className={`${LINK} text-desk-teal hover:text-desk-amber`}
                      >
                        {read.path}
                        <span className="ml-2 text-desk-dim">
                          lines {read.startLine}–{read.endLine}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {report.knows.searches.length > 0 ? (
              <div>
                <div className="font-mono text-[10px] uppercase tracking-wide text-desk-dim">searched</div>
                <ul className="space-y-0.5">
                  {report.knows.searches.map((search, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        onClick={() => onReveal(search.evidence)}
                        title="Show in Activity"
                        className={`${LINK} text-desk-ink/80 hover:text-desk-amber`}
                      >
                        {search.tool} “{search.query}”
                        {search.scope ? <span className="text-desk-dim"> · {search.scope}</span> : null}
                        <span className="ml-2 text-desk-dim">
                          {search.matches} hit{search.matches === 1 ? "" : "s"}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </div>
        )}
      </Section>

      <Section title="Changes">
        {total === 0 ? (
          <p className="text-desk-dim">No files changed.</p>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-desk-ink/80">
              +{report.changes.created.length + report.changes.modified.length} changed
              {report.changes.observed.length ? ` · ${report.changes.observed.length} observed` : ""}
              {report.changes.deleted.length ? ` · ${report.changes.deleted.length} deleted` : ""}
              {report.changes.additions + report.changes.deletions > 0
                ? ` · +${report.changes.additions} / −${report.changes.deletions} lines`
                : ""}
            </p>
            <FileList label="modified" files={modified} tone="text-desk-amber" onReveal={onReveal} />
            <FileList label="created" files={created} tone="text-desk-teal" onReveal={onReveal} />
            <FileList label="deleted" files={deleted} tone="text-desk-ember" onReveal={onReveal} />
            <FileList label="observed" files={observed} tone="text-desk-dim" onReveal={onReveal} />
          </div>
        )}
      </Section>

      <Section title="Executions">
        {report.executions.length === 0 ? (
          <p className="text-desk-dim">No commands run.</p>
        ) : (
          <div className="space-y-2">
            <p className="font-mono text-[11px] text-desk-dim">
              {report.execution.commands} command{report.execution.commands === 1 ? "" : "s"} ·{" "}
              {report.execution.succeeded} succeeded · {report.execution.failed} failed
              {report.execution.unknown ? ` · ${report.execution.unknown} unknown` : ""}
            </p>
            <ul className="space-y-0.5">
              {report.executions.map((command) => (
                <li key={command.eventId}>
                  <button
                    type="button"
                    onClick={() => onReveal(command.evidence)}
                    title="Show in Activity"
                    className={`${LINK} hover:text-desk-amber`}
                  >
                    <span className={command.status === "failed" ? "text-desk-ember" : "text-desk-dim"}>$</span>{" "}
                    <span className="text-desk-ink/80">{command.command || "(shell)"}</span>
                    <span className="ml-2 text-desk-dim">{commandLabel(command)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {report.recoveries.length > 0 ? (
              <p className="text-desk-ink/70">
                {report.recoveries.length} recovery detected — a command failed, then the agent continued successfully.
              </p>
            ) : null}
          </div>
        )}
      </Section>

      {report.outsideChanges.length > 0 ? (
        <Section title="Outside the project">
          <ul className="space-y-0.5">
            {report.outsideChanges.map((change) => (
              <li key={change.path} className="font-mono text-[11px] text-desk-ember/90">
                <button
                  type="button"
                  onClick={() => onReveal(change.evidence)}
                  title="Show in Activity"
                  className={`${LINK} hover:text-desk-amber`}
                >
                  {change.path}
                  {change.count > 1 ? <span className="ml-2 text-desk-dim">×{change.count}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <AttentionBlock attention={report.attention} />

      <Section title="Response">
        {report.response ? (
          <p className="whitespace-pre-wrap text-desk-ink/90">{report.response}</p>
        ) : (
          <p className="text-desk-dim">(no reply)</p>
        )}
      </Section>
    </div>
  );
}

const NODE_TONE: Record<TimelineKind, string> = {
  start: "text-desk-dim",
  think: "text-desk-dim",
  read: "text-desk-teal",
  search: "text-desk-teal",
  edit: "text-desk-amber",
  write: "text-desk-teal",
  run: "text-desk-ink",
  process: "text-desk-teal",
  observe: "text-desk-dim",
  error: "text-desk-ember",
  end: "text-desk-dim",
};

/**
 * The run as a horizontal world line. Each activity is a node on the line, in
 * the order it happened, with what it caused listed underneath. Clicking a node
 * opens it in the pane to the left (the one evidence links use), so the specifics
 * — the diff, the output, the reasoning — are one click away without leaving the
 * report.
 */
function TimelineStrip({ nodes, onSelect }: { nodes: TimelineNode[]; onSelect: (node: TimelineNode) => void }) {
  return (
    <div className="overflow-x-auto pb-1">
      <div className="min-w-max px-1 pt-2">
        <div className="flex border-t border-desk-line">
          {nodes.map((node) => (
            <button
              key={node.eventId}
              type="button"
              onClick={() => onSelect(node)}
              title={`${node.action} · ${node.subject} — click for the specifics`}
              className="group relative w-44 shrink-0 px-2.5 pt-3 text-left"
            >
              <span
                className={[
                  "absolute -top-[5px] left-2.5 h-2 w-2 rounded-full bg-current ring-2 ring-desk-panel transition-transform",
                  "group-hover:scale-125",
                  NODE_TONE[node.kind],
                ].join(" ")}
              />
              <span className="block font-mono text-[10px] text-desk-dim">{formatOffset(node.offsetMs)}</span>
              <span
                className={[
                  "block font-mono text-[10px] font-semibold uppercase tracking-wide",
                  NODE_TONE[node.kind],
                ].join(" ")}
              >
                {node.action}
              </span>
              <span className="block truncate font-mono text-[11px] text-desk-ink/85" title={node.subject}>
                {node.subject}
              </span>
              {node.effects.length > 0 ? (
                node.effects.map((effect, index) => (
                  <span
                    key={index}
                    title={effect}
                    className="block truncate text-[10px] leading-tight text-desk-amber/80"
                  >
                    {effect}
                  </span>
                ))
              ) : (
                <span className="block text-[10px] leading-tight text-desk-dim/60">—</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 font-mono text-[10px] text-desk-dim">
        {nodes.length} {nodes.length === 1 ? "activity" : "activities"} · scroll → · click a node for the specifics
      </p>
    </div>
  );
}

function commandLabel(command: CommandFact): string {
  if (command.status === "running") return "running";
  if (command.exitCode !== undefined) return `exit ${command.exitCode}`;
  if (command.status === "failed") return "failed";
  return "—";
}

function FileList({
  label,
  files,
  tone,
  onReveal,
}: {
  label: string;
  files: FileDelta[];
  tone: string;
  onReveal: (ids: string[]) => void;
}) {
  if (files.length === 0) return null;
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wide text-desk-dim">{label}</div>
      <ul className="space-y-0.5">
        {files.map((file) => (
          <li key={file.path}>
            <button
              type="button"
              onClick={() => onReveal(file.evidence)}
              title={`Show in Activity — ${file.path}`}
              className={`${LINK} hover:text-desk-amber ${tone}`}
            >
              {file.path}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ATTENTION_TONE: Record<Attention["level"], string> = {
  none: "text-desk-dim",
  low: "text-desk-teal",
  medium: "text-desk-amber",
  high: "text-desk-ember",
};

const REASON_TEXT: Record<AttentionReason, string> = {
  command_failed: "A command failed",
  command_failure_streak: "Commands failed back-to-back — the agent may be flailing",
  activity_stalled: "No activity for a long time — something may be stuck",
  unresolved_error: "Unresolved error — no successful recovery detected",
  agent_waiting: "Agent is waiting",
  agent_stopped: "Agent stopped",
  no_progress: "No progress detected",
  external_change: "External file change observed",
  process_left_running: "A process the agent started is still running",
  outside_change: "A file outside the project was changed",
  file_version_loop: "File versions oscillated — the agent may have undone its own edit",
  command_retry_loop: "The same command failed repeatedly",
};

function AttentionBlock({ attention }: { attention: Attention }) {
  return (
    <Section title="Human attention">
      <div className={`font-mono text-lg uppercase tracking-[0.15em] ${ATTENTION_TONE[attention.level]}`}>
        {attention.level}
      </div>
      {attention.reasons.length > 0 ? (
        <ul className="mt-1 space-y-0.5">
          {attention.reasons.map((reason) => (
            <li key={reason} className="text-desk-ink/80">
              • {REASON_TEXT[reason]}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-desk-ink/70">Agent is working normally.</p>
      )}
    </Section>
  );
}
