import { useEffect, useRef, type MouseEvent } from "react";
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
  think: "text-desk-dim",
  process: "text-desk-ink",
  approval: "text-desk-amber",
  error: "text-desk-ember",
  warn: "text-desk-ember",
};

/**
 * One clickable row. Outside replay it opens the matching Stage content
 * (read02 §19); inside replay it scrubs the Stage to that event.
 */
export function ActivityItem({ row, replayCurrent }: { row: ActivityRow; replayCurrent?: boolean }) {
  const openStage = useStageStore((s) => s.openStage);
  const mode = useStageStore((s) => s.mode);
  const activeItemId = useStageStore((s) => s.activeItem?.id);
  const openMenu = useUiStore((s) => s.openMenu);
  const focusedEventId = useUiStore((s) => s.focusedEventId);
  const addContext = useChatStore((s) => s.addContext);
  const seek = useReplayStore((s) => s.seekTimestamp);
  const ref = useRef<HTMLButtonElement>(null);

  const inReplay = mode === "replay";
  const canOpen = row.stageItem !== undefined;
  const clickable = inReplay || canOpen;
  const focused = row.id === focusedEventId;
  // "Selected" is not its own state: it means "this row is what the Stage is
  // showing". Live, that is the row whose Stage item is the active one — true
  // however the Stage got there, so the hint cannot drift. In replay the Stage
  // is showing whatever the cursor has reached, which the panel resolves to one
  // row (`replayCurrent`); marking the active item would be wrong there, because
  // replay pins its own view instead of opening Stage items.
  const selected = inReplay
    ? replayCurrent === true
    : row.stageItem !== undefined && row.stageItem.id === activeItemId;

  // Followed from a report link: bring the row into view.
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView({ block: "nearest" });
  }, [focused]);

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
        ref={ref}
        disabled={!clickable}
        onClick={activate}
        onContextMenu={handleContextMenu}
        title={inReplay ? "Scrub to this event" : canOpen ? "Open in Stage" : undefined}
        aria-current={selected ? "true" : undefined}
        className={[
          // The left border is always 2px wide so selecting a row never shifts
          // its content sideways; only the colour changes (and the two colour
          // classes are mutually exclusive, or Tailwind's rule order would let
          // `transparent` win over the accent).
          "block w-full rounded border-l-2 px-1.5 py-1 text-left font-mono text-[11px] leading-tight",
          clickable ? "hover:bg-desk-panel2" : "cursor-default",
          // A selected row is what the Stage is showing: an amber left bar and
          // a filled background, legible even when the row already has a hover
          // tint.
          selected ? "border-l-desk-amber bg-desk-panel2" : "border-l-transparent",
          focused ? "bg-desk-panel2 ring-1 ring-desk-amber/50" : "",
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
