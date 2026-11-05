import type { TimelineLayout, TimelineMark, TimelineTrack } from "./types";

/**
 * A mark's width is the time it was the thing happening on its own track.
 *
 * Capped so a long silence is not a wall of colour, floored so a 40 ms read is
 * still a mark. The span is measured against the next node *on the same track*
 * — one track's silence never stretches another track's marks.
 */
const MAX_MARK_PERCENT = 28;
const MIN_MARK_PERCENT = 0.7;

/**
 * The axis length the two faces draw against.
 *
 * The world line is time-driven, like a player's progress bar: while the run is
 * in flight the axis ends at *now* (the live edge), so the newest activity keeps
 * growing and silences read as empty space without waiting for the next event.
 * Once the run ends the axis freezes at its duration, so the historical view is
 * static and does not drift with the wall clock.
 *
 * `nowMs` is supplied only while the live clock should drive (following a
 * running run); omit it for a settled run, a pin or a replay. `lastOffsetMs`
 * always wins when a node sits beyond the run's end (a process dies after
 * `agent_end`, for instance), so the axis never clips an activity.
 */
export function timelineTotalMs(input: {
  startedAt: number;
  endedAt?: number;
  lastOffsetMs: number;
  nowMs?: number;
}): number {
  // A settled run is frozen: a wall clock passed by mistake cannot unfreeze it.
  if (input.endedAt !== undefined) {
    return Math.max(1, input.lastOffsetMs, input.endedAt - input.startedAt);
  }
  const live = input.nowMs !== undefined ? input.nowMs - input.startedAt : 0;
  return Math.max(1, input.lastOffsetMs, live);
}

/**
 * Place every track's nodes on the shared time axis, independently.
 *
 * This is the layout step: no track ids are known here, no DOM is involved.
 * Empty tracks are dropped from the result, so a run that never reasoned does
 * not draw an empty Model lane.
 */
export function layoutTimeline(tracks: TimelineTrack[], totalMs: number): TimelineLayout {
  const total = Math.max(1, totalMs);
  const visible = tracks.filter((track) => track.nodes.length > 0);
  const marks: TimelineMark[] = [];

  for (const track of visible) {
    const nodes = track.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const next = nodes[i + 1];
      const span = next ? next.offsetMs - node.offsetMs : total - node.offsetMs;
      marks.push({
        trackId: track.id,
        node,
        left: (node.offsetMs / total) * 100,
        width: Math.max(MIN_MARK_PERCENT, Math.min(MAX_MARK_PERCENT, (span / total) * 100)),
      });
    }
  }

  return { tracks: visible, marks };
}
