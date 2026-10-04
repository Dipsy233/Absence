import type { StageItemType } from "../../types/stage";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";

/**
 * Two groups, reflecting the two perspectives (read02 §13):
 *   left  — what the user is looking at (opened files/diffs, replay)
 *   right — what the agent is doing (terminal output, its file, live)
 */
export function StageToolbar() {
  const mode = useStageStore((s) => s.mode);
  const lastByType = useStageStore((s) => s.lastByType);
  const showType = useStageStore((s) => s.showType);
  const setMode = useStageStore((s) => s.setMode);
  const replayReady = useReplayStore((s) => s.events.length > 0);

  const buttonClass = (active: boolean, enabled: boolean) =>
    [
      "rounded px-2 py-1 font-mono text-[10px] tracking-[0.12em] transition-colors",
      active
        ? "bg-desk-panel2 text-desk-amber"
        : enabled
          ? "text-desk-dim hover:text-desk-ink"
          : "cursor-not-allowed text-desk-dim/30",
    ].join(" ");

  const itemButton = (type: StageItemType, label: string) => (
    <button
      key={`${type}-${label}`}
      type="button"
      disabled={lastByType[type] === undefined}
      onClick={() => showType(type)}
      className={buttonClass(mode === type, lastByType[type] !== undefined)}
    >
      {label}
    </button>
  );

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-desk-line px-2 py-1.5">
      {itemButton("file", "FILE")}
      {itemButton("diff", "DIFF")}
      <button
        type="button"
        disabled={!replayReady}
        onClick={() => setMode("replay")}
        className={buttonClass(mode === "replay", replayReady)}
      >
        REPLAY
      </button>

      <div className="ml-auto flex items-center gap-1">
        {itemButton("terminal", "TERMINAL")}
        {itemButton("file", "FILE")}
        <button
          type="button"
          onClick={() => setMode("live")}
          className={buttonClass(mode === "live", true)}
        >
          LIVE
        </button>
      </div>
    </div>
  );
}
