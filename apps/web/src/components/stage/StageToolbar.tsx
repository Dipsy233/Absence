import type { StageItemType, StageMode } from "../../types/stage";
import { useStageStore } from "../../stores/stageStore";

const MODES: Array<{ mode: StageMode; label: string; type?: StageItemType }> = [
  { mode: "live", label: "LIVE" },
  { mode: "file", label: "FILE", type: "file" },
  { mode: "diff", label: "DIFF", type: "diff" },
  { mode: "terminal", label: "TERMINAL", type: "terminal" },
  { mode: "search", label: "SEARCH", type: "search" },
  { mode: "replay", label: "REPLAY" },
];

/** A light mode switcher plus the Stage navigation stack (read02 §13, §40). */
export function StageToolbar() {
  const mode = useStageStore((s) => s.mode);
  const navIndex = useStageStore((s) => s.navIndex);
  const navLength = useStageStore((s) => s.navStack.length);
  const setMode = useStageStore((s) => s.setMode);
  const showType = useStageStore((s) => s.showType);
  const hasItemOfType = useStageStore((s) => s.hasItemOfType);
  const goBack = useStageStore((s) => s.goBack);
  const goForward = useStageStore((s) => s.goForward);

  const canBack = navIndex > 0;
  const canForward = navIndex >= 0 && navIndex < navLength - 1;

  return (
    <div className="flex shrink-0 items-center gap-1 border-b border-desk-line px-2 py-1.5">
      {MODES.map((entry) => {
        const active =
          entry.mode === "live" ? mode === "live" : entry.mode === "replay" ? mode === "replay" : mode === entry.mode;
        const available =
          entry.mode === "live" || entry.mode === "replay" || (entry.type ? hasItemOfType(entry.type) : false);
        return (
          <button
            key={entry.mode}
            type="button"
            disabled={!available}
            onClick={() => {
              if (entry.mode === "live") setMode("live");
              else if (entry.mode === "replay") setMode("replay");
              else if (entry.type) showType(entry.type);
            }}
            className={[
              "rounded px-2 py-1 font-mono text-[10px] tracking-[0.12em] transition-colors",
              active
                ? "bg-desk-panel2 text-desk-amber"
                : available
                  ? "text-desk-dim hover:text-desk-ink"
                  : "cursor-not-allowed text-desk-dim/30",
            ].join(" ")}
          >
            {entry.label}
          </button>
        );
      })}

      <div className="ml-auto flex items-center gap-1">
        <button
          type="button"
          disabled={!canBack}
          onClick={goBack}
          className="rounded border border-desk-line px-1.5 py-0.5 text-xs text-desk-dim enabled:hover:border-desk-amber/60 enabled:hover:text-desk-amber disabled:opacity-30"
          title="Back"
        >
          ←
        </button>
        <button
          type="button"
          disabled={!canForward}
          onClick={goForward}
          className="rounded border border-desk-line px-1.5 py-0.5 text-xs text-desk-dim enabled:hover:border-desk-amber/60 enabled:hover:text-desk-amber disabled:opacity-30"
          title="Forward"
        >
          →
        </button>
      </div>
    </div>
  );
}
