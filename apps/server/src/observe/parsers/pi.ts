import {
  createEvent,
  type AbsenceEvent,
  type AbsenceEventOf,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type MonitorFidelity,
} from "@absence/core";
import { AcpToolMapper } from "../../agents/acp/AcpToolMapper";
import type { AcpToolFacts } from "../../agents/acp/ToolRules";
import { unifiedDiff } from "../../util/diff";

/**
 * pi session transcript → AbsenceEvent.
 *
 * pi writes its own session record (`~/.pi/agent/sessions/--<path>--/<ts>_<id>.jsonl`)
 * for resuming; this parser reads it. The format is the agent's own persistence
 * (documented at docs.pi.dev/latest/session-format.md, open source), and it is
 * explicitly lifecycle-shaped — the cleanest transcript of the three agents
 * this project has examined:
 *
 *   - every assistant record carries a `stopReason` (`stop`/`toolUse`/`error`/
 *     `aborted`/`length`), so turn boundaries are stated, not inferred;
 *   - tool calls are first-class: a `toolCall` block on the assistant record
 *     and a separate `toolResult` *message* paired by `toolCallId`, carrying
 *     `isError` and `durationMs`;
 *   - model switches are their own `model_change` entries;
 *   - usage carries real numbers (`input/output/cacheRead/cacheWrite/reasoning/
 *     totalTokens` plus `cost`).
 *
 * Entries form a tree via `id`/`parentId` (branching); v1 processes them in
 * file order — the order the user actually experienced. `context_edit`
 * rewrites what the *model* sees, not what happened, so it is not applied.
 * Everything here is `source: "transcript"`: facts read from records the agent
 * wrote, never asked for and never sent back.
 */

const SOURCE = "transcript" as const;

/** Placeholder until the discovery layer attaches this parser to a session. */
const UNATTACHED = "observe-unattached";

/** A `toolCall` block whose result has not arrived yet. */
interface PendingToolCall {
  toolCallId: string;
  name: string;
  rawInput: unknown;
  at: number;
}

/** Turn-ending stop reasons; `toolUse` keeps the turn open. */
const TURN_END_REASONS: Record<string, string> = {
  stop: "completed",
  length: "length",
  aborted: "aborted",
  error: "error",
};

export class PiTranscriptParser {
  /** pi's own session id — from the `session` header entry. */
  externalId: string | undefined = undefined;
  /** The project the session was created in — from the header's `cwd`. */
  cwd: string | undefined = undefined;
  /** Lines that were not JSON — counted, never fatal. */
  malformed = 0;
  /** The first user message's text (truncated), for a board row subtitle. */
  firstUserPrompt: string | undefined = undefined;
  /** `toolResult` messages with no matching `toolCall` — drift evidence. */
  orphanResults = 0;

  private readonly out: AbsenceEvent[] = [];
  private mapper: AcpToolMapper | undefined = undefined;
  private readonly pending = new Map<string, PendingToolCall>();
  private turnOpen = false;
  private agentStartEmitted = false;
  private model: string | undefined = undefined;
  private turnOutputTokens = 0;
  private turnContextTokens = 0;

  /** Feed one transcript line. Lines arrive in file order. */
  async feed(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let record: unknown;
    try {
      record = JSON.parse(trimmed);
    } catch {
      this.malformed += 1;
      return;
    }
    if (!isRecord(record)) return;

    if (record.type === "session") {
      if (typeof record.id === "string" && record.id.length > 0) this.externalId ??= record.id;
      if (typeof record.cwd === "string" && record.cwd.length > 0) {
        if (this.cwd === undefined) {
          this.cwd = record.cwd;
          this.mapper = new AcpToolMapper(record.cwd);
        }
      }
      return;
    }
    if (record.type !== "message") {
      this.nonMessageEntry(record);
      return;
    }

    const message = isRecord(record.message) ? record.message : undefined;
    if (!message) return;
    // Entry-level timestamps are ISO 8601; the nested message carries its own
    // Unix-millisecond stamp, which is the moment the fact belongs to.
    const at = numberAt(message, "timestamp") ?? timestampOf(record.timestamp);

    switch (message.role) {
      case "user":
        this.userMessage(message, at);
        break;
      case "assistant":
        await this.assistantMessage(message, at);
        break;
      case "toolResult":
        await this.toolResultMessage(message, at);
        break;
      default:
        // `system` messages are prompt/tool patches (sections, toolsAdded) —
        // replay bookkeeping, not monitor facts.
        break;
    }
  }

  /** Take everything parsed so far. The caller re-stamps `sessionId` on attach. */
  drain(): AbsenceEvent[] {
    const events = [...this.out];
    this.out.length = 0;
    return events;
  }

  // --------------------------------------------------------------------------

  private userMessage(message: AnyRecord, at: number): void {
    const text = textOf(message.content) ?? joinBlocks(message.content);
    if (text.length === 0) return;
    if (this.firstUserPrompt === undefined) {
      this.firstUserPrompt = text.length > 100 ? `${text.slice(0, 97)}…` : text;
    }
    this.emit("message", { role: "user", content: text }, at, "reported");
    this.turnOpen = true;
    this.agentStartEmitted = false;
    this.turnOutputTokens = 0;
    this.turnContextTokens = 0;
  }

  private async assistantMessage(message: AnyRecord, at: number): Promise<void> {
    if (typeof message.model === "string" && message.model.length > 0) this.model = message.model;
    this.collectUsage(message.usage);

    if (this.turnOpen && !this.agentStartEmitted) {
      this.emit("agent_start", { model: this.model ?? "" }, at, "inferred");
      this.agentStartEmitted = true;
    }

    const errorMessage = textOf(message.errorMessage);
    if (errorMessage !== undefined) {
      this.emit("error", { message: errorMessage }, at, "reported");
    }

    const blocks = Array.isArray(message.content) ? message.content.filter(isRecord) : [];
    for (const block of blocks) {
      switch (block.type) {
        case "thinking": {
          const content = textOf(block.thinking);
          if (content !== undefined && content.trim().length > 0) {
            this.emit("thinking", { content }, at, "reported");
          }
          break;
        }
        case "text": {
          const text = textOf(block.text);
          if (text !== undefined && text.trim().length > 0) {
            this.emit("message", { role: "assistant", content: text }, at, "reported");
          }
          break;
        }
        case "toolCall": {
          const toolCallId = textOf(block.id);
          if (toolCallId === undefined) break;
          const name = textOf(block.name) ?? "tool";
          this.pending.set(toolCallId, { toolCallId, name, rawInput: block.arguments, at });
          this.emit(
            "tool_start",
            { toolCallId, toolName: name, args: block.arguments ?? null },
            at,
            "reported",
          );
          break;
        }
        default:
          // `image` and anything a newer pi adds — not monitor facts yet.
          break;
      }
    }

    const reason = TURN_END_REASONS[textOf(message.stopReason) ?? ""];
    if (reason !== undefined) {
      this.closeTurn(reason, at);
    }
  }

  private async toolResultMessage(message: AnyRecord, at: number): Promise<void> {
    const toolCallId = textOf(message.toolCallId);
    const toolName = textOf(message.toolName) ?? "tool";
    if (toolCallId === undefined) return;
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      this.orphanResults += 1;
      return;
    }
    this.pending.delete(toolCallId);

    const isError = message.isError === true;
    const resultText = joinBlocks(message.content);

    this.emit("tool_end", { toolCallId, toolName, isError }, at, "reported");

    const input = isRecord(pending.rawInput) ? pending.rawInput : {};

    // Write-shape tools carry their content verbatim — mapped here so the
    // mapper's write path cannot report them twice.
    if (toolName === "write" && typeof input.path === "string" && typeof input.content === "string") {
      this.emit("file_write", { path: input.path, content: input.content }, at, "reported");
      return;
    }
    if (toolName === "edit" && typeof input.path === "string" && Array.isArray(input.edits)) {
      for (const edit of input.edits.filter(isRecord)) {
        if (typeof edit.oldText !== "string" || typeof edit.newText !== "string") continue;
        this.emit(
          "file_edit",
          {
            path: input.path,
            before: edit.oldText,
            after: edit.newText,
            diff: unifiedDiff(edit.oldText, edit.newText),
            fullContent: false,
          },
          at,
          "reported",
        );
      }
      return;
    }

    // Everything else — read, bash, pwsh, background shells, mcp__* — goes
    // through the shared shape rules, exactly as the ACP projector would see
    // them: identical facts, different provenance.
    const mapper = this.mapper;
    if (!mapper) return;
    const facts: AcpToolFacts = {
      toolCallId,
      name: toolName,
      kind: declaredKind(toolName),
      rawInput: pending.rawInput,
      status: isError ? "failed" : "completed",
      content: resultText.length > 0 ? resultText : undefined,
      accumulatedOutput: resultText.length > 0 ? resultText : undefined,
    };
    const mapped = await mapper.mapCompletedDetailed(facts);
    for (const item of mapped) {
      // Mapper records say "acp"; every fact here came from the transcript.
      this.emit(
        item.event.type as AbsenceEventType,
        item.event.payload as AbsenceEventPayloadMap[AbsenceEventType],
        at,
        item.fidelity,
      );
    }
  }

  /** Entries that are not messages. Everything unknown falls through silently. */
  private nonMessageEntry(record: AnyRecord): void {
    switch (record.type) {
      case "model_change": {
        const modelId = textOf(record.modelId);
        if (modelId === undefined) break;
        const provider = textOf(record.provider);
        const at = timestampOf(record.timestamp);
        this.emit(
          "message",
          {
            role: "system",
            content: provider !== undefined ? `Model switched to ${modelId} (${provider}).` : `Model switched to ${modelId}.`,
          },
          at,
          "reported",
        );
        break;
      }
      case "compaction":
      case "branch_summary": {
        const summary = textOf(record.summary);
        if (summary === undefined) break;
        this.emit("message", { role: "system", content: summary }, timestampOf(record.timestamp), "reported");
        break;
      }
      case "custom_message": {
        // Extension messages that participate in the model's context.
        const text = textOf(record.content) ?? joinBlocks(record.content);
        if (text.length === 0) break;
        this.emit("message", { role: "system", content: text }, timestampOf(record.timestamp), "reported");
        break;
      }
      default:
        // `usage` (assistant records already carry per-response usage; these
        // are cache-warm/external accounting), `thinking_level_change`,
        // `context_edit` (rewrites the model's view, not history),
        // `label`, `custom`, `session_info` — not monitor facts.
        break;
    }
  }

  private collectUsage(usage: unknown): void {
    if (!isRecord(usage)) return;
    const output = numberAt(usage, "output");
    if (output !== undefined) this.turnOutputTokens += output;
    // Context window occupancy: fresh input + cache reads + cache writes.
    const total =
      (numberAt(usage, "input") ?? 0) +
      (numberAt(usage, "cacheRead") ?? 0) +
      (numberAt(usage, "cacheWrite") ?? 0);
    if (total > this.turnContextTokens) this.turnContextTokens = total;
  }

  private closeTurn(reason: string, at: number): void {
    this.emit("agent_end", { reason }, at, "inferred");
    if (this.turnOutputTokens > 0 || this.turnContextTokens > 0) {
      this.emit(
        "usage",
        {
          ...(this.model !== undefined ? { model: this.model } : {}),
          outputEst: this.turnOutputTokens,
          contextUsed: this.turnContextTokens > 0 ? this.turnContextTokens : undefined,
          estimated: true,
        },
        at,
        "reported",
      );
    }
    this.turnOpen = false;
  }

  private emit<K extends AbsenceEventType>(
    type: K,
    payload: AbsenceEventPayloadMap[K],
    at: number,
    fidelity: MonitorFidelity,
  ): void {
    const created = createEvent(UNATTACHED, type, payload, at);
    this.out.push({ ...created, at, source: SOURCE, fidelity } as AbsenceEventOf<K>);
  }
}

/**
 * pi tool names this parser classifies for the shape rules. `edit`/`write`
 * never reach the mapper (handled above); `mcp__*` names are recognised by
 * the rules themselves.
 */
function declaredKind(name: string): string | undefined {
  switch (name) {
    case "read":
      return "read";
    case "bash":
    case "pwsh":
    case "bg_start":
    case "bg_send":
    case "bg_logs":
    case "interactive_shell":
    case "codemode":
      return "execute";
    case "grep":
    case "find":
    case "ls":
      return "search";
    default:
      return undefined;
  }
}

function timestampOf(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

/** Join text blocks (and string content) into one text value. */
function joinBlocks(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter(isRecord)
    .map((block) => (block.type === "text" ? textOf(block.text) : undefined))
    .filter((value): value is string => value !== undefined && value.length > 0)
    .join("\n")
    .trim();
}

function textOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberAt(record: AnyRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type AnyRecord = Record<string, unknown>;
