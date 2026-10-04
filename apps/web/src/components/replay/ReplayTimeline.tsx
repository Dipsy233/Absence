import { useMemo } from "react";
import type { ActivityRow } from "../../types/stage";
import { eventToActivityRow } from "../../lib/events";
import { formatOffset } from "../../lib/format";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayClock } from "../../hooks/useReplay";

/** The session timeline: scrub, and jump the Stage to any event (read02 §21). */
export function ReplayTimeline() {
  const events = useReplayStore((s) => s.events);
  const currentActionId = useReplayStore((s) => s.view?.currentAction?.id);
  const seekRatio = useReplayStore((s) => s.seekRatio);
  const seekTimestamp = useReplayStore((s) => s.seekTimestamp);
  const openStage = useStageStore((s) => s.openStage);
  const clock = useReplayClock();

  const rows = useMemo(
    () => events.map(eventToActivityRow).filter((row): row is ActivityRow => row !== undefined),
    [events],
  );

  if (events.length === 0) {
    return <p className="text-xs text-desk-dim">No events recorded yet.</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <input
        type="range"
        min={0}
        max={1000}
        value={Math.round(clock.progress * 1000)}
        onChange={(event) => seekRatio(Number(event.target.value) / 1000)}
        className="h-1 w-full cursor-pointer accent-desk-amber"
        aria-label="Replay position"
      />

      <ul className="min-h-0 flex-1 overflow-auto">
        {rows.map((row) => {
          const active = row.event.id === currentActionId;
          return (
            <li key={row.id}>
              <button
                type="button"
                onClick={() => {
                  seekTimestamp(row.event.timestamp);
                  if (row.stageItem) openStage(row.stageItem);
                }}
                className={[
                  "flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left font-mono text-[11px]",
                  active ? "bg-desk-amber/15 text-desk-amber" : "text-desk-dim hover:bg-desk-panel2",
                ].join(" ")}
              >
                <span className="shrink-0">{formatOffset(row.event.timestamp - clock.start)}</span>
                <span className="shrink-0">{row.action}</span>
                <span className="truncate text-desk-ink/70" title={row.primary}>
                  {row.primary}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
