import type { TimelineLayout, TimelineMark, TimelineTrack } from "./types";

/**
 * A mark's width is the time it was the thing happening on its own track.
 *
 * Strictly proportional: no cap and no floor, so when the axis grows every mark
 * and every gap between marks shrink by the same factor — a block parked at a
 * fixed 28% while the clock advances would look like it is drifting. A long
 * silence therefore does stretch the marks around it; a truthful axis is the
 * point. A node that carries its own end (`endOffsetMs`) is drawn only that
 * long — a thought that stopped after 600ms does not keep the model lane lit
 * while the shell runs — and the last mark without an end runs to the axis end.
 */

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

  // The fallback end for a node without one of its own is the *next activity
  // of any track* — another thing starting is what stopped this one from being
  // the thing happening. Bounding by the next same-track node alone let a
  // one-shot mark (a read, a command) stretch straight across other tracks'
  // work, and the last mark of a track ran to the axis end no matter how much
  // happened after it. Undrawn moments (START, END, an egg dying) bound too:
  // they are activities all the same.
  const all = visible.flatMap((track) => track.nodes).sort((a, b) => a.offsetMs - b.offsetMs);
  const nextActivityAfter = (offset: number): number | undefined => {
    for (const node of all) {
      if (node.offsetMs > offset) return node.offsetMs;
    }
    return undefined;
  };

  for (const track of visible) {
    const nodes = track.nodes;
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      // A node that knows when it actually stopped (a finished thought, a
      // reply, a command's own run) is drawn only that long: the track goes
      // quiet while other tracks work, which is the truth.
      const span =
        node.endOffsetMs !== undefined
          ? Math.min(total, node.endOffsetMs) - node.offsetMs
          : (nextActivityAfter(node.offsetMs) ?? total) - node.offsetMs;
      marks.push({
        trackId: track.id,
        node,
        left: (node.offsetMs / total) * 100,
        // Pure time share: no cap, no floor. When the axis grows, every mark
        // and every gap shrink by the same factor — a block parked at a fixed
        // percentage while the clock advances would look like it is drifting.
        width: Math.min(100, Math.max(0, (span / total) * 100)),
      });
    }
  }

  return { tracks: visible, marks };
}
