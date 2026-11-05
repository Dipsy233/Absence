import type { TimelineNode } from "../../types/report";

/**
 * The three independent tracks the run's world line is split into.
 *
 * A track is data: an id, a label, and the nodes that belong to it. Nothing
 * here knows how a track is drawn, and no track imports another one.
 */
export type TimelineTrackId = "model" | "tools" | "shell";

export interface TimelineTrackDefinition {
  id: TimelineTrackId;
  /** i18n key for the lane label (`t(label)`). */
  label: string;
}

export interface TimelineTrack extends TimelineTrackDefinition {
  nodes: TimelineNode[];
}

/** One node placed on one track, in percentages of the run's time axis. */
export interface TimelineMark {
  trackId: TimelineTrackId;
  node: TimelineNode;
  left: number;
  width: number;
}

export interface TimelineLayout {
  /** Only tracks that have something to draw, in registry order. */
  tracks: TimelineTrack[];
  marks: TimelineMark[];
}
