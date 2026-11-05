import type { TimelineKind, TimelineNode } from "../../types/report";
import type { TimelineTrackId } from "./types";

/**
 * Which track a timeline node belongs to.
 *
 * This is the classification step, and it only answers that one question: no
 * aggregation, no layout, no rendering. A node with no activity of its own
 * (lifecycle markers, OS observations, eggs, errors) belongs to no track.
 *
 * `tool` is the report's generic tool-call kind. MCP arrives as `tool` too, so
 * the tools track needs no per-tool-family rule of its own.
 */
const TRACK_FOR_KIND: Record<TimelineKind, TimelineTrackId | undefined> = {
  // The model: reasoning and what it says.
  think: "model",
  speak: "model",
  // Tool calls, including file reads/edits, searches and MCP calls.
  read: "tools",
  search: "tools",
  edit: "tools",
  write: "tools",
  tool: "tools",
  // Command execution and its output.
  run: "shell",
  // Not activities of their own.
  start: undefined,
  process: undefined,
  observe: undefined,
  error: undefined,
  end: undefined,
};

export function classifyTimelineNode(node: TimelineNode): TimelineTrackId | undefined {
  return TRACK_FOR_KIND[node.kind];
}
