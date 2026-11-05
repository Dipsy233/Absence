import type { TimelineNode } from "../../types/report";
import { classifyTimelineNode } from "./classify";
import type { TimelineTrack, TimelineTrackDefinition, TimelineTrackId } from "./types";

/**
 * The track registry, in drawing order.
 *
 * Adding or removing a track is an edit to this list (and to the classifier's
 * kind table); the other tracks are untouched, and both faces render whatever
 * this list contains.
 */
export const TIMELINE_TRACKS: readonly TimelineTrackDefinition[] = [
  { id: "model", label: "Model" },
  { id: "tools", label: "Tools" },
  { id: "shell", label: "Shell" },
];

/**
 * Classification + aggregation, with no shared mutable state between tracks.
 *
 * Each track gets its own array while the nodes are bucketed, then each array
 * is handed to its own track unchanged. A track that grows or disappears never
 * rewrites another track's data.
 */
export function buildTimelineTracks(nodes: TimelineNode[]): TimelineTrack[] {
  const buckets = new Map<TimelineTrackId, TimelineNode[]>();
  for (const track of TIMELINE_TRACKS) buckets.set(track.id, []);

  for (const node of nodes) {
    const trackId = classifyTimelineNode(node);
    if (trackId === undefined) continue;
    buckets.get(trackId)?.push(node);
  }

  return TIMELINE_TRACKS.map((track) => ({
    ...track,
    nodes: buckets.get(track.id) ?? [],
  }));
}
