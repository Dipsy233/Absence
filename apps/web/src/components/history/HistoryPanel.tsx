import { useEffect, useMemo, useRef } from "react";
import type { HistoryRun } from "../../types/history";
import { memoBuildHistory, runEvents } from "../../lib/history";
import { formatClock, formatOffset } from "../../lib/format";
import { useSessionStore } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { Panel } from "../Panel";

const STATUS_LABEL: Record<HistoryRun["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};

const STATUS_CLASS: Record<HistoryRun["status"], string> = {
  running: "text-desk-amber",
  completed: "text-desk-teal",
  interrupted: "text-desk-dim",
  error: "text-desk-ember",
};

/**
 * Left rail, middle: one row per run — prompt to completion/interruption.
 * Oldest first with the newest at the bottom, like a log.
 */
export function HistoryPanel() {
  const events = useSessionStore((s) => s.events);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const load = useReplayStore((s) => s.load);
  const setMode = useStageStore((s) => s.setMode);
  const bodyRef = useRef<HTMLDivElement>(null);

  const runs = useMemo(() => memoBuildHistory(events), [events]);

  useEffect(() => {
    const element = bodyRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [runs.length]);

  /**
   * Roll the *view* back to the end of this run: the Stage shows what the world
   * looked like when it finished, and can be scrubbed from there. DAZE never
   * writes to the project, so this is a view-only revert.
   */
  const rollback = (run: HistoryRun) => {
    const slice = runEvents(events, run);
    if (slice.length === 0) return;
    selectRun(run.id);
    load(slice, { startAtEnd: true, label: `#${run.index} · ${run.prompt}` });
    setMode("replay");
  };

  return (
    <Panel
      title="History"
      aside={`${runs.length} run${runs.length === 1 ? "" : "s"}`}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
      bodyRef={bodyRef}
    >
      {runs.length === 0 ? (
        <p className="text-xs text-desk-dim">No runs yet. Send the agent a task.</p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => {
            const active = run.id === selectedRunId;
            const duration = (run.endedAt ?? Date.now()) - run.startedAt;
            return (
              <li key={run.id}>
                <div
                  className={[
                    "flex items-center rounded border",
                    active
                      ? "border-desk-amber/60 bg-desk-amber/10"
                      : "border-transparent hover:border-desk-line hover:bg-desk-panel2",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => selectRun(run.id)}
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                  >
                    <div className="flex items-baseline gap-2 font-mono text-[11px]">
                      <span className={active ? "text-desk-amber" : "text-desk-dim"}>#{run.index}</span>
                      <span className="text-desk-dim/70">{formatClock(run.startedAt)}</span>
                      <span className={STATUS_CLASS[run.status]}>{STATUS_LABEL[run.status]}</span>
                      <span className="ml-auto text-desk-dim/70">{formatOffset(duration)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-desk-ink/85" title={run.prompt}>
                      {run.prompt}
                    </div>
                    <div className="mt-0.5 flex gap-2 font-mono text-[10px] text-desk-dim">
                      <span title="files read">R{run.counts.read}</span>
                      <span title="searches">S{run.counts.search}</span>
                      <span title="files edited">E{run.counts.edit}</span>
                      <span title="files created">C{run.counts.created}</span>
                      <span title="commands run">$ {run.counts.run}</span>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => rollback(run)}
                    title="Show the state at the end of this run (reverts the view, not the files)"
                    className="mr-1 shrink-0 rounded border border-desk-line px-1.5 py-0.5 text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
                  >
                    ⟲
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
