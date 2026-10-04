import { useMemo } from "react";
import type { HistoryRun } from "../../types/history";
import { buildHistory } from "../../lib/history";
import { formatClock, formatOffset } from "../../lib/format";
import { useSessionStore } from "../../stores/sessionStore";
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

/** Left rail, middle: one row per run — prompt to completion/interrupt. */
export function HistoryPanel() {
  const events = useSessionStore((s) => s.events);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);

  const runs = useMemo(() => buildHistory(events), [events]);
  const newestFirst = useMemo(() => [...runs].reverse(), [runs]);

  return (
    <Panel
      title="History"
      aside={`${runs.length} run${runs.length === 1 ? "" : "s"}`}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
    >
      {newestFirst.length === 0 ? (
        <p className="text-xs text-desk-dim">No runs yet. Send the agent a task.</p>
      ) : (
        <ul className="space-y-1">
          {newestFirst.map((run) => {
            const active = run.id === selectedRunId;
            const duration = (run.endedAt ?? Date.now()) - run.startedAt;
            return (
              <li key={run.id}>
                <button
                  type="button"
                  onClick={() => selectRun(run.id)}
                  className={[
                    "block w-full rounded border px-2 py-1.5 text-left",
                    active
                      ? "border-desk-amber/60 bg-desk-amber/10"
                      : "border-transparent hover:border-desk-line hover:bg-desk-panel2",
                  ].join(" ")}
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
                    <span>R{run.counts.read}</span>
                    <span>S{run.counts.search}</span>
                    <span>E{run.counts.edit}</span>
                    <span>$ {run.counts.run}</span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
