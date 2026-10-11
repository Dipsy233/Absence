import type { AgentStatus, AbsenceEvent } from "@absence/core";
import type { ActivityRow, StageItem } from "../types/stage";
import { EPHEMERAL_MS } from "@absence/server/src/process/classify";
import { formatBytes, formatClock } from "./format";
import { languageFromPath } from "./language";

/** Events worth showing in the Activity timeline (read02 §18). */
export const ACTIVITY_TYPES = new Set<AbsenceEvent["type"]>([
  "agent_start",
  "agent_end",
  "thinking",
  "file_read",
  "file_write",
  "file_edit",
  "file_change",
  "command",
  "search",
  "process",
  "approval",
  "error",
]);

/** Events that own the Stage. */
export const STAGE_EVENT_TYPES = new Set<AbsenceEvent["type"]>([
  "thinking",
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "search",
  "approval",
]);

/**
 * A run ended, a new one started, or the agent began speaking: the Stage goes
 * back to its default page. Text to the user ends whatever action was showing.
 */
export function clearsStage(event: AbsenceEvent): boolean {
  if (event.type === "agent_end") return true;
  // A system message is a Absence notice/command result, not the agent speaking,
  // so it must leave whatever the Stage is showing alone.
  return event.type === "message" && event.payload.role !== "system";
}

/** The action the Stage should still be showing, or undefined for the default page. */
export function lastStageAction(events: AbsenceEvent[]): AbsenceEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (clearsStage(event)) return undefined;
    if (STAGE_EVENT_TYPES.has(event.type) && !isInstantSearch(event)) return event;
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
export function eventPath(event: AbsenceEvent | undefined): string | undefined {
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
  event: AbsenceEvent,
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
/**
 * An instant search is plumbing, not an action worth a row: a `find` that
 * returned in a blink told the agent where a file is, which the file tree and
 * the report's counts already say. The threshold is the eggs classifier's own
 * `EPHEMERAL_MS` — one standard for "lived only a blink" across Absence, applied
 * here to a search event's measured duration instead of a process's lifetime.
 * Below it the search stays in the raw stream (counts, report) but is filtered
 * out of Activity and the Stage.
 */
export function isInstantSearch(event: AbsenceEvent): boolean {
  if (event.type !== "search") return false;
  const { tool, durationMs } = event.payload;
  if (tool !== "find" && tool !== "ls") return false;
  // No duration recorded (older archives): keep the row rather than guess.
  return durationMs !== undefined && durationMs < EPHEMERAL_MS;
}

export function eventToStageItem(event: AbsenceEvent): StageItem | undefined {
  if (isInstantSearch(event)) return undefined;
  switch (event.type) {
    case "thinking": {
      // Reasoning streams token by token, so one thought arrives as a long run
      // of events whose content keeps growing. Keying the item on the event
      // would re-mount the Stage panel on every delta (and on every replay
      // tick, since currentAction is re-derived); one id per session keeps the
      // card in place while its text fills in.
      return {
        id: `think_${event.sessionId}`,
        type: "thought",
        title: "Thinking",
        source: { eventId: event.id },
        payload: { kind: "thought", text: event.payload.content, streaming: event.payload.streaming },
        createdAt: event.timestamp,
        event,
      };
    }
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
          // The payload content is the slice that was read, so number it as it
          // appears in the file (a read of 10–20 shows lines 10–20, not 1–11).
          lineOffset: Math.max(0, startLine - 1),
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
      // Search renders through the terminal view (one output surface for "the
      // agent ran something and here is what came back").
      const { tool, query, scope, matches, output } = event.payload;
      const command = `${tool} ${query}${scope ? ` ${scope}` : ""}`;
      return baseItem(event, "terminal", command, {
        kind: "terminal",
        command,
        stdout: `${output}\n\n${matches} match${matches === 1 ? "" : "es"}`,
        stderr: "",
        exitCode: 0,
      });
    }
    case "process": {
      // An egg gets its own card: it is not an action the agent took, it is
      // something it left behind (v0.3).
      const { pid, ppid, name, commandLine, status, children, command, startedAt, exitedAt } = event.payload;
      // An egg is updated in place — it is laid once and then re-reported as it
      // runs and finally exits. Keying the card on the event would re-mount it
      // (and re-run the Stage animation) on every update, and would drop the
      // Agent Eggs panel's selection highlight at the same moment. The pid is
      // the egg's stable identity, so the card is keyed on that instead.
      return {
        id: `process_${pid}`,
        type: "process",
        title: name,
        source: { eventId: event.id },
        payload: {
          kind: "process",
          pid,
          ppid,
          name,
          commandLine,
          status,
          children,
          command,
          startedAt,
          exitedAt,
        },
        createdAt: event.timestamp,
        event,
      };
    }
    case "approval": {
      // An approval is a prompt, not an action: it is keyed on the approval id
      // so re-deriving the item (every state push, every replay tick) does not
      // re-mount the card and drop the user's focus mid-decision.
      const { id: approvalId, kind: approvalKind, title, detail, reason, cwd, options } = event.payload;
      return {
        id: `approval_${approvalId}`,
        type: "approval",
        title: "Approval needed",
        source: { eventId: event.id },
        payload: { kind: "approval", approvalId, approvalKind, title, detail, reason, cwd, options },
        createdAt: event.timestamp,
        event,
      };
    }
    default:
      return undefined;
  }
}

/** Added/removed line counts of a unified diff (ignores the +++/--- headers). */
export function countDiff(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}

/** The first non-empty line — enough to name a thought in one row. */
export function firstLine(text: string): string {
  return text.split("\n").find((line) => line.trim().length > 0)?.trim() ?? "(thinking…)";
}

/** A compact, clickable row for the Activity panel. */
export function eventToActivityRow(event: AbsenceEvent): ActivityRow | undefined {
  if (!ACTIVITY_TYPES.has(event.type)) return undefined;
  if (isInstantSearch(event)) return undefined;
  const id = event.id;
  const time = formatClock(event.timestamp);
  const stageItem = eventToStageItem(event);

  switch (event.type) {
    case "thinking":
      return {
        id,
        event,
        time,
        action: "THINK",
        primary: firstLine(event.payload.content),
        secondary: event.payload.streaming ? "reasoning…" : "reasoning",
        tone: "think",
        stageItem,
      };
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
    case "approval":
      return {
        id,
        event,
        time,
        action: "APPROVE?",
        primary: event.payload.title,
        secondary: event.payload.reason ?? event.payload.kind,
        tone: "approval",
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
    case "process": {
      const { name, pid, status, children, kind } = event.payload;
      // Helpers are folded away here too: a run's `cat`, `grep` and `sleep` are
      // noise next to the daemon it started. The raw events remain in the stream.
      if (kind === "tool") return undefined;
      return {
        id,
        event,
        time,
        action: status === "running" ? "LAID" : "DIED",
        primary: name,
        secondary: `pid ${pid}${children > 0 ? ` · +${children}` : ""}`,
        tone: "process",
        stageItem,
      };
    }
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
export function statusFromEvent(event: AbsenceEvent): AgentStatus | undefined {
  switch (event.type) {
    case "agent_start":
      return "thinking";
    case "agent_end":
      return "listening";
    case "thinking":
      return "thinking";
    case "message":
      return event.payload.role === "system" ? undefined : "speaking";
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
    case "approval":
      return "waiting";
    case "error":
      return "error";
    default:
      return undefined;
  }
}
