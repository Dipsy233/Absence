import type { AgentStatus, DazeEvent } from "@daze/core";
import type { ActivityRow, StageItem } from "../types/stage";
import { formatBytes, formatClock } from "./format";
import { languageFromPath } from "./language";

/** Events worth showing in the Activity timeline (read02 §18). */
export const ACTIVITY_TYPES = new Set<DazeEvent["type"]>([
  "agent_start",
  "agent_end",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "search",
  "error",
]);

/** Events that own the Stage. */
export const STAGE_EVENT_TYPES = new Set<DazeEvent["type"]>([
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "search",
]);

/** A run ended, or a new one started: the Stage goes back to its default page. */
export function clearsStage(event: DazeEvent): boolean {
  return event.type === "agent_end" || (event.type === "message" && event.payload.role === "user");
}

/** The action the Stage should still be showing, or undefined for the default page. */
export function lastStageAction(events: DazeEvent[]): DazeEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (clearsStage(event)) return undefined;
    if (STAGE_EVENT_TYPES.has(event.type)) return event;
  }
  return undefined;
}

let itemCounter = 0;
function nextItemId(): string {
  itemCounter = (itemCounter + 1) % 1_000_000;
  return `stage_${itemCounter.toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** Build a Stage item that is not tied to a single event (e.g. from Files). */
export function createStageItem(
  type: StageItem["type"],
  title: string,
  payload: StageItem["payload"],
  source?: { eventId?: string; path?: string },
): StageItem {
  return { id: nextItemId(), type, title, source, payload, createdAt: Date.now() };
}

/** The file a stage-ish event refers to, if any. */
export function eventPath(event: DazeEvent | undefined): string | undefined {
  if (!event) return undefined;
  switch (event.type) {
    case "file_read":
    case "file_write":
    case "file_edit":
    case "file_change":
      return event.payload.path;
    default:
      return undefined;
  }
}

function baseItem(
  event: DazeEvent,
  type: StageItem["type"],
  title: string,
  payload: StageItem["payload"],
  path?: string,
): StageItem {
  // The id is derived from the event so the item is stable across renders.
  // A random id here would churn the Stage's animation key every frame and
  // make replay appear frozen.
  return {
    id: event.id,
    type,
    title,
    source: { eventId: event.id, path },
    payload,
    createdAt: event.timestamp,
    event,
  };
}

/** Turn an event into something the Stage can render (read02 §12, §43). */
export function eventToStageItem(event: DazeEvent): StageItem | undefined {
  switch (event.type) {
    case "file_read": {
      const { path, content, startLine, endLine, language } = event.payload;
      return baseItem(
        event,
        "file",
        path,
        {
          kind: "file",
          path,
          content,
          language: language ?? languageFromPath(path),
          startLine,
          endLine,
          caption: "Agent is reading",
        },
        path,
      );
    }
    case "file_write": {
      const { path, content } = event.payload;
      const emptied = content.length === 0;
      return baseItem(
        event,
        "file",
        path,
        {
          kind: "file",
          path,
          content,
          language: languageFromPath(path),
          badge: emptied ? "EMPTIED" : "written",
          badgeTone: emptied ? "warn" : "normal",
          caption: emptied
            ? "Agent wrote an empty file — it still exists on disk. Deleting a file needs the bash tool (rm)."
            : "Agent wrote this file",
        },
        path,
      );
    }
    case "file_edit": {
      const { path, before, after, diff } = event.payload;
      const emptied = after.trim() === "" && before.trim() !== "";
      return baseItem(
        event,
        "diff",
        path,
        {
          kind: "diff",
          path,
          before,
          after,
          diff,
          language: languageFromPath(path),
          emptied,
        },
        path,
      );
    }
    case "command": {
      const { command, stdout, stderr, exitCode } = event.payload;
      return baseItem(event, "terminal", command, {
        kind: "terminal",
        command,
        stdout,
        stderr,
        exitCode,
      });
    }
    case "search": {
      const { tool, query, scope, matches, output } = event.payload;
      return baseItem(event, "search", query, { kind: "search", tool, query, scope, matches, output });
    }
    default:
      return undefined;
  }
}

function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** A compact, clickable row for the Activity panel. */
export function eventToActivityRow(event: DazeEvent): ActivityRow | undefined {
  if (!ACTIVITY_TYPES.has(event.type)) return undefined;
  const id = event.id;
  const time = formatClock(event.timestamp);
  const stageItem = eventToStageItem(event);

  switch (event.type) {
    case "file_read":
      return {
        id,
        event,
        time,
        action: "READ",
        primary: event.payload.path,
        secondary: `${event.payload.startLine}–${event.payload.endLine} · ${formatBytes(event.payload.content.length)}`,
        tone: "read",
        stageItem,
      };
    case "file_write": {
      const bytes = event.payload.content.length;
      if (bytes === 0) {
        return {
          id,
          event,
          time,
          action: "EMPTIED",
          primary: event.payload.path,
          secondary: "0 B · file still on disk",
          tone: "warn",
          stageItem,
        };
      }
      return {
        id,
        event,
        time,
        action: "WRITE",
        primary: event.payload.path,
        secondary: formatBytes(bytes),
        tone: "edit",
        stageItem,
      };
    }
    case "file_edit": {
      const { added, removed } = countDiff(event.payload.diff);
      if (event.payload.after.trim() === "" && event.payload.before.trim() !== "") {
        return {
          id,
          event,
          time,
          action: "EMPTIED",
          primary: event.payload.path,
          secondary: `−${removed} · file still on disk`,
          tone: "warn",
          stageItem,
        };
      }
      return {
        id,
        event,
        time,
        action: "EDIT",
        primary: event.payload.path,
        secondary: `+${added} −${removed}`,
        tone: "edit",
        stageItem,
      };
    }
    case "file_change":
      return {
        id,
        event,
        time,
        action: event.payload.kind.toUpperCase(),
        primary: event.payload.path,
        tone: "edit",
      };
    case "command":
      return {
        id,
        event,
        time,
        action: "RUN",
        primary: event.payload.command,
        secondary: `exit ${event.payload.exitCode}`,
        tone: "run",
        stageItem,
      };
    case "search":
      return {
        id,
        event,
        time,
        action: "SEARCH",
        primary: event.payload.query,
        secondary: `${event.payload.matches} hit${event.payload.matches === 1 ? "" : "s"}${
          event.payload.scope ? ` · ${event.payload.scope}` : ""
        }`,
        tone: "search",
        stageItem,
      };
    case "agent_start":
      return {
        id,
        event,
        time,
        action: "START",
        primary: event.payload.model,
        tone: "lifecycle",
      };
    case "agent_end":
      return { id, event, time, action: "END", primary: event.payload.reason, tone: "lifecycle" };
    case "error":
      return { id, event, time, action: "ERROR", primary: event.payload.message, tone: "error" };
    default:
      return undefined;
  }
}

export function statusForTool(toolName: string): AgentStatus {
  switch (toolName) {
    case "read":
      return "reading";
    case "grep":
    case "find":
    case "ls":
      return "searching";
    case "edit":
    case "write":
      return "editing";
    case "bash":
    case "powershell":
      return "running";
    default:
      return "running";
  }
}

/** Derive agent status from a single event (used by the replay reconstruction). */
export function statusFromEvent(event: DazeEvent): AgentStatus | undefined {
  switch (event.type) {
    case "agent_start":
      return "thinking";
    case "agent_end":
      return "listening";
    case "thinking":
      return "thinking";
    case "message":
      return "speaking";
    case "tool_start":
      return statusForTool(event.payload.toolName);
    case "file_read":
      return "reading";
    case "file_write":
    case "file_edit":
      return "editing";
    case "command":
      return "running";
    case "search":
      return "searching";
    case "error":
      return "error";
    default:
      return undefined;
  }
}
