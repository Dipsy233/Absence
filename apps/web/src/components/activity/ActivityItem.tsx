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

/** One clickable row; clicking opens the matching Stage content (read02 §19). */
export function ActivityItem({ row }: { row: ActivityRow }) {
  const openStage = useStageStore((s) => s.openStage);
  const openMenu = useUiStore((s) => s.openMenu);
  const addContext = useChatStore((s) => s.addContext);
  const seek = useReplayStore((s) => s.seekTimestamp);

  const canOpen = row.stageItem !== undefined;

  const handleContextMenu = (event: MouseEvent) => {
    event.preventDefault();
    openMenu(event.clientX, event.clientY, [
      {
        label: "Open in Stage",
        disabled: !canOpen,
        onSelect: () => row.stageItem && openStage(row.stageItem),
      },
      { label: "Replay to this event", onSelect: () => seek(row.event.timestamp) },
      { label: "", onSelect: () => {}, separator: true },
      { label: "Add event to Chat", onSelect: () => addContext(eventContext(row.event)) },
    ]);
  };

  return (
    <li>
      <button
        type="button"
        disabled={!canOpen}
        onClick={() => row.stageItem && openStage(row.stageItem)}
        onContextMenu={handleContextMenu}
        title={canOpen ? "Open in Stage" : undefined}
        className={[
          "block w-full rounded px-1.5 py-1 text-left font-mono text-[11px] leading-tight",
          canOpen ? "hover:bg-desk-panel2" : "cursor-default",
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
