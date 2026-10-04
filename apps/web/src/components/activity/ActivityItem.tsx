import type { MouseEvent } from "react";
import type { ActivityRow } from "../../types/stage";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";

const TONE_CLASS: Record<ActivityRow["tone"], string> = {
  read: "text-desk-teal",
  search: "text-desk-teal",
  edit: "text-desk-amber",
  run: "text-desk-ink",
  lifecycle: "text-desk-dim",
  error: "text-desk-ember",
  warn: "text-desk-ember",
};

/**
 * One clickable row. Outside replay it opens the matching Stage content
 * (read02 §19); inside replay it scrubs the Stage to that event.
 */
export function ActivityItem({ row }: { row: ActivityRow }) {
  const openStage = useStageStore((s) => s.openStage);
  const mode = useStageStore((s) => s.mode);
  const openMenu = useUiStore((s) => s.openMenu);
  const addContext = useChatStore((s) => s.addContext);
  const seek = useReplayStore((s) => s.seekTimestamp);

  const inReplay = mode === "replay";
  const canOpen = row.stageItem !== undefined;
  const clickable = inReplay || canOpen;

  const activate = () => {
    if (inReplay) {
      seek(row.event.timestamp);
      return;
    }
    if (row.stageItem) openStage(row.stageItem);
  };

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, [
      {
        label: inReplay ? "Scrub to this event" : "Open in Stage",
        disabled: !clickable,
        onSelect: activate,
      },
      { label: "Add event to Chat", onSelect: () => addContext(eventContext(row.event)) },
    ]);
  };

  return (
    <li>
      <button
        type="button"
        disabled={!clickable}
        onClick={activate}
        onContextMenu={handleContextMenu}
        title={inReplay ? "Scrub to this event" : canOpen ? "Open in Stage" : undefined}
        className={[
          "block w-full rounded px-1.5 py-1 text-left font-mono text-[11px] leading-tight",
          clickable ? "hover:bg-desk-panel2" : "cursor-default",
        ].join(" ")}
      >
        <span className="flex items-baseline gap-2">
          <span className="shrink-0 text-desk-dim/70">{row.time}</span>
          <span className={["shrink-0 font-semibold", TONE_CLASS[row.tone]].join(" ")}>{row.action}</span>
          {row.secondary ? <span className="truncate text-desk-dim">{row.secondary}</span> : null}
        </span>
        <span className="block truncate pl-[68px] text-desk-ink/80" title={row.primary}>
          {row.primary}
        </span>
      </button>
    </li>
  );
}
