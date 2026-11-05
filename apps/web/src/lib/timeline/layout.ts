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
