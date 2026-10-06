import { useMemo } from "react";
import type { ActivityRow } from "../../types/stage";
import { memoBuildHistory, pickRun, runEvents } from "../../lib/history";
import { eventToActivityRow } from "../../lib/events";
import { useSessionStore } from "../../stores/sessionStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { Panel } from "../Panel";
import { ActivityItem } from "./ActivityItem";

/** Bottom-left: the actions of the selected run, with a Replay button. */
export function ActivityPanel() {
  const events = useSessionStore((s) => s.events);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const mode = useStageStore((s) => s.mode);
  const setMode = useStageStore((s) => s.setMode);
  const load = useReplayStore((s) => s.load);

  const runs = useMemo(() => memoBuildHistory(events), [events]);
  const run = pickRun(runs, selectedRunId);
  const shown = useMemo(() => (run ? runEvents(events, run) : events), [events, run]);
  const rows = useMemo(
    () => shown.map(eventToActivityRow).filter((row): row is ActivityRow => row !== undefined),
    [shown],
  );

  const enterReplay = () => {
    if (!run || rows.length === 0) return;
    // Pin the selection to the run being replayed so the report summarises the
    // same run instead of falling back to the newest one.
    selectRun(run.id);
    load(runEvents(events, run), { label: `#${run.index} · ${run.prompt}` });
    setMode("replay");
  };

  return (
    <Panel
      title="Activity"
      aside={
        <span className="flex items-center gap-2">
          <span>{rows.length}</span>
          <button
            type="button"
            onClick={enterReplay}
            disabled={!run || rows.length === 0}
            className={[
              "rounded border px-1.5 py-0.5 text-[10px] normal-case tracking-normal",
              mode === "replay"
                ? "border-desk-amber/60 text-desk-amber"
                : "border-desk-line text-desk-dim enabled:hover:border-desk-amber/60 enabled:hover:text-desk-amber",
              "disabled:opacity-40",
            ].join(" ")}
            title={run ? `Replay run #${run.index}` : "Nothing to replay"}
          >
            ▶ replay
          </button>
        </span>
      }
      className="min-h-0 flex-1"
      bodyClassName="p-2"
    >
      {run ? (
        <div className="mb-1.5 flex items-baseline gap-2 border-b border-desk-line pb-1 text-[10px] text-desk-dim">
          <span className="font-mono">run #{run.index}</span>
          <span className="truncate" title={run.prompt}>
            {run.prompt}
          </span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-xs text-desk-dim">Nothing yet. Send the agent a task.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <ActivityItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
