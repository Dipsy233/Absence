import type { AbsenceEvent } from "@absence/core";
import { createStageItem, eventToStageItem } from "../../lib/events";
import { languageFromPath } from "../../lib/language";
import { unifiedDiff } from "../../lib/diff";
import type { StageItem } from "../../types/stage";

/**
 * The tabs on the Stage, and what each one means.
 *
 * `file` / `diff` / `terminal` are not three separate pages you switch between
 * — they are three *views of one activity*. Select a `file_edit` in the feed and
 * the same moment can be read as the change (DIFF), as the file after the
 * change (FILE), or — for a command — as what it printed (TERMINAL).
 *
 * That distinction matters for honesty: `lastByType` used to answer "the last
 * diff anywhere in the run", which meant clicking a `file_read` row could leave
 * the Stage showing an unrelated edit from ten activities ago. Every view here
 * is derived from the one event that is pinned.
 */
export type ActivityViewKind = "file" | "diff" | "terminal" | "thought" | "process" | "approval";

export type ActivityViews = Partial<Record<ActivityViewKind, StageItem>>;

/** Which of the three tabs this activity can be read as. */
export function activityViews(item: StageItem | undefined): ActivityViews {
  if (!item) return {};
  const views: ActivityViews = {};

  // The activity's own card, whatever kind it is (a thought, an egg, an
  // approval). Always present: it is the thing the row actually was.
  if (item.type === "thought" || item.type === "process" || item.type === "approval") {
    views[item.type] = item;
    return views;
  }

  const event = item.event;
  if (!event) {
    // An item built by hand (a diff opened from the Files panel) carries no
    // event; its own payload is still the view it stands for.
    if (item.payload.kind === "file" || item.payload.kind === "diff" || item.payload.kind === "terminal") {
      views[item.payload.kind] = item;
    }
    return views;
  }

  switch (event.type) {
    case "file_read":
      views.file = item;
      break;

    case "file_write": {
      const { path, content } = event.payload;
      views.file = item;
      // A write replaces the whole file, so its diff is "nothing → this".
      views.diff = createStageItem(
        "diff",
        path,
        {
          kind: "diff",
          path,
          before: "",
          after: content,
          diff: unifiedDiff("", content, "(empty)", path),
          language: languageFromPath(path),
          emptied: content.length === 0,
        },
        { path, eventId: event.id },
      );
      break;
    }

    case "file_edit": {
      const { path, before, after, diff } = event.payload;
      views.diff = item;
      // The file view is the text *after* the edit: what the agent left behind.
      views.file = createStageItem(
        "file",
        path,
        {
          kind: "file",
          path,
          content: after,
          language: languageFromPath(path),
          lineOffset: 0,
          badge: "after the edit",
          caption: before.trim() === "" && after.trim() !== "" ? "Agent created this content" : "Agent edited this file",
        },
        { path, eventId: event.id },
      );
      void diff;
      break;
    }

    case "command":
    case "search":
    case "mcp":
      views.terminal = item;
      break;

    default:
      break;
  }

  return views;
}

/** The tab to light for an item: its own kind, or the first view it offers. */
export function defaultViewKind(item: StageItem | undefined): StageItem["type"] | undefined {
  if (!item) return undefined;
  return item.type;
}

/**
 * Views for a *live* action that the user has not pinned.
 *
 * Same derivation, but from the raw event, so a live `file_edit` gets a FILE
 * view too instead of only the DIFF card the event maps to by default.
 */
export function activityViewsForEvent(event: AbsenceEvent | undefined): ActivityViews {
  if (!event) return {};
  return activityViews(eventToStageItem(event));
}
