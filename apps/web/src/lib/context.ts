import type { AbsenceEvent } from "@absence/core";
import type { ChatContext } from "../types/chat";
import { languageFromPath } from "./language";

const MAX_SNIPPET = 2000;

function snippet(content: string | undefined, max = MAX_SNIPPET): string {
  if (!content) return "";
  return content.length > max ? `${content.slice(0, max)}\n… (${content.length - max} more chars)` : content;
}

export function contextLabel(ctx: ChatContext): string {
  if (ctx.type === "selection" && ctx.path) {
    return `@${ctx.path}:${ctx.startLine}-${ctx.endLine}`;
  }
  if (ctx.path) return `@${ctx.path}`;
  return ctx.label;
}

function codeBlock(content: string | undefined, language: string): string {
  return `\`\`\`${language}\n${snippet(content)}\n\`\`\``;
}

/** Render one context attachment as plain text for the prompt (read02 §29). */
export function formatChatContext(ctx: ChatContext): string {
  const label = contextLabel(ctx);
  const language = ctx.path ? languageFromPath(ctx.path) : "";
  switch (ctx.type) {
    case "selection":
      return `${label}\n${codeBlock(ctx.content, language)}`;
    case "diff":
      return `${label} (diff)\n${codeBlock(ctx.content, "diff")}`;
    case "file":
      return `${label}\n${codeBlock(ctx.content, language)}`;
    case "event":
      return `@event ${ctx.label}${ctx.content ? `\n${snippet(ctx.content, 400)}` : ""}`;
    default:
      return label;
  }
}

/** Combine pending contexts with the typed message. */
export function buildPrompt(contexts: ChatContext[], text: string): string {
  if (contexts.length === 0) return text;
  const blocks = contexts.map(formatChatContext).join("\n\n");
  return `${blocks}\n\n${text}`;
}

// ---------------------------------------------------------------------------
// Constructors
// ---------------------------------------------------------------------------

export function fileContext(path: string, content: string): ChatContext {
  return { type: "file", path, content, label: path };
}

export function selectionContext(
  path: string,
  startLine: number,
  endLine: number,
  content: string,
): ChatContext {
  return { type: "selection", path, startLine, endLine, content, label: `${path}:${startLine}-${endLine}` };
}

export function diffContext(path: string, diff: string): ChatContext {
  return { type: "diff", path, content: diff, label: `${path} (diff)` };
}

export function eventContext(event: AbsenceEvent): ChatContext {
  return {
    type: "event",
    eventId: event.id,
    content: summarizeEvent(event),
    label: `${event.type} · ${new Date(event.timestamp).toLocaleTimeString()}`,
  };
}

export function summarizeEvent(event: AbsenceEvent): string {
  switch (event.type) {
    case "file_read":
      return `read ${event.payload.path} lines ${event.payload.startLine}-${event.payload.endLine}`;
    case "file_write":
      return `wrote ${event.payload.path} (${event.payload.content.length} chars)`;
    case "file_edit":
      return `edited ${event.payload.path}`;
    case "command":
      return `ran \`${event.payload.command}\` (exit ${event.payload.exitCode})`;
    case "search":
      return `searched "${event.payload.query}" — ${event.payload.matches} hits`;
    case "message":
      return `${event.payload.role}: ${event.payload.content}`;
    case "error":
      return `error: ${event.payload.message}`;
    default:
      return event.type;
  }
}
