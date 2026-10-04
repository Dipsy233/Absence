import path from "node:path";
import { type ContextState, type DazeEventPayloadMap, type DazeEventType } from "@daze/core";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { BaseAdapter, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { readFileSafe } from "../filesystem/FileTree";
import { languageFromPath } from "../util/language";
import { toPosix } from "../util/paths";

export interface PiAdapterOptions {
  tools: string[];
}

/**
 * Wraps the Pi SDK (read.md §6). Pi is the worker; Daze only observes.
 *
 * We subscribe to `AgentSessionEvent` and translate each one into a
 * DazeEvent. The UI never learns that Pi exists.
 */
export class PiAdapter extends BaseAdapter {
  readonly runtime = "pi";
  private session?: AgentSession;
  private unsubscribe?: () => void;
  private model = "pi";
  private toolArgs = new Map<string, unknown>();
  /** Lines the agent has received, keyed by their line number in the file. */
  private fileLines = new Map<string, Map<number, string>>();
  /** Paths whose whole content we hold (a write/edit). */
  private wholeFiles = new Set<string>();
  private assistantAcc = "";
  private thinkingAcc = "";
  private aborted = false;

  constructor(private readonly options: PiAdapterOptions) {
    super();
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;

    // Loaded lazily so the mock runtime never pays Pi's import cost.
    const { createAgentSession, SessionManager } = await import("@earendil-works/pi-coding-agent");

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      tools: this.options.tools,
      sessionManager: SessionManager.inMemory(ctx.cwd),
    });

    this.session = session;
    const model = session.model;
    // Without a configured model/credential Pi hands back a placeholder. Rather
    // than fail on every prompt, let the caller degrade to the mock runtime.
    if (!model || model.provider === "unknown") {
      session.dispose();
      this.session = undefined;
      throw new Error("no model or credentials configured (run `pi` and use /login)");
    }
    this.model = `${model.provider}/${model.id}`;
    this.unsubscribe = session.subscribe((event) => this.onEvent(event));
    return { model: this.model };
  }

  getContextUsage(): ContextState | undefined {
    const usage = this.session?.getContextUsage();
    if (!usage) return undefined;
    return { used: usage.tokens, total: usage.contextWindow };
  }

  async prompt(text: string): Promise<void> {
    if (!this.session) throw new Error("Pi session not started");
    this.aborted = false;
    this.assistantAcc = "";
    this.thinkingAcc = "";
    try {
      await this.session.prompt(text);
    } catch (error) {
      this.emitDaze("error", { message: errorMessage(error) });
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    await this.session?.abort();
  }

  dispose(): void {
    this.aborted = true;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  private onEvent(event: AgentSessionEvent): void {
    const emit = <K extends DazeEventType>(type: K, payload: DazeEventPayloadMap[K]) =>
      this.emitDaze(type, payload);

    switch (event.type) {
      case "agent_start":
        emit("agent_start", { model: this.model });
        break;

      case "agent_settled":
        emit("agent_end", { reason: this.aborted ? "aborted" : "completed" });
        break;

      case "message_start":
        this.assistantAcc = "";
        this.thinkingAcc = "";
        break;

      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (inner.type === "text_delta") {
          this.assistantAcc += inner.delta;
          emit("message", {
            role: "assistant",
            content: this.assistantAcc,
            delta: inner.delta,
            streaming: true,
          });
        } else if (inner.type === "thinking_delta") {
          this.thinkingAcc += inner.delta;
          emit("thinking", {
            content: this.thinkingAcc,
            delta: inner.delta,
            streaming: true,
          });
        } else if (inner.type === "error") {
          emit("error", { message: errorMessage(inner.error) });
        }
        break;
      }

      case "message_end": {
        const message = event.message as { role?: string; content?: unknown };
        if (message.role === "assistant") {
          const text = textOfContent(message.content);
          this.assistantAcc = "";
          this.thinkingAcc = "";
          // A tool-only turn (e.g. a bare find/grep) carries no text. Emitting it
          // would append an empty bubble to the chat.
          if (text.trim().length > 0) {
            emit("message", { role: "assistant", content: text, streaming: false });
          }
        }
        break;
      }

      case "tool_execution_start":
        this.toolArgs.set(event.toolCallId, event.args);
        emit("tool_start", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
        });
        break;

      case "tool_execution_update":
        emit("tool_update", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          partial: event.partialResult,
        });
        break;

      case "tool_execution_end": {
        emit("tool_end", {
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          isError: event.isError,
        });
        const args = this.toolArgs.get(event.toolCallId);
        this.toolArgs.delete(event.toolCallId);
        void this.mapToolResult(event.toolName, args, event.result, event.isError);
        break;
      }

      case "compaction_start":
        emit("thinking", { content: `Compacting context (${event.reason})…`, streaming: true });
        break;

      case "auto_retry_start":
        emit("error", { message: `Retrying after error: ${event.errorMessage}` });
        break;

      default:
        break;
    }
  }

  /** Turn a finished tool call into a first-class, visual DazeEvent. */
  private async mapToolResult(
    toolName: string,
    rawArgs: unknown,
    result: unknown,
    isError: boolean,
  ): Promise<void> {
    if (isError) return;
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    try {
      switch (toolName) {
        case "read": {
          const abs = this.abs(args.path);
          // Capture exactly what the agent received rather than re-reading the
          // file: the tool result is the plain slice (no line numbers), and it
          // cannot drift if something else touches the file first.
          const content = stripReadNote(textOfResult(result));
          const startLine = Math.max(1, toNumber(args.offset, 1));
          const lineCount = content.length === 0 ? 0 : content.split("\n").length;
          const endLine = startLine + Math.max(0, lineCount - 1);
          this.mergeSlice(abs, startLine, content);
          this.emitDaze("file_read", {
            path: this.display(args.path),
            startLine,
            endLine,
            content,
            language: languageFromPath(abs),
          });
          break;
        }
        case "write": {
          const abs = this.abs(args.path);
          // The argument is exactly what the agent wrote.
          const content = String(args.content ?? "");
          this.rememberWholeFile(abs, content);
          this.emitDaze("file_write", {
            path: this.display(args.path),
            content,
          });
          break;
        }
        case "edit": {
          const abs = this.abs(args.path);
          const known = this.knownText(abs);
          const edits = Array.isArray(args.edits) ? (args.edits as Array<{ oldText?: string; newText?: string }>) : [];
          // Reconstruct the result from the agent's own edit when we hold the
          // whole file (a full write/edit); otherwise the file must be read.
          const reconstructed = known !== undefined && this.wholeFiles.has(abs) ? applyEdits(known, edits) : undefined;
          const after = reconstructed ?? (await readFileSafe(abs)) ?? known ?? "";
          const before = known ?? "";
          const details = (result as { details?: { diff?: string } } | undefined)?.details;
          this.rememberWholeFile(abs, after);
          this.emitDaze("file_edit", {
            path: this.display(args.path),
            before,
            after,
            diff: details?.diff ?? "",
          });
          break;
        }
        case "bash":
        case "powershell": {
          const structured = (result as { structuredContent?: Record<string, unknown> } | undefined)
            ?.structuredContent;
          const output = structured?.output !== undefined ? String(structured.output) : textOfResult(result);
          const exitCode = structured?.exit_code !== undefined ? Number(structured.exit_code) : 0;
          this.emitDaze("command", {
            command: String(args.command ?? ""),
            stdout: output,
            stderr: "",
            exitCode,
          });
          break;
        }
        case "grep":
        case "find":
        case "ls": {
          const output = textOfResult(result);
          const matches = output.split("\n").filter((line) => line.trim().length > 0).length;
          const scope =
            toolName === "ls"
              ? this.display(args.path ?? ".")
              : args.path !== undefined
                ? this.display(args.path)
                : undefined;
          const query = toolName === "ls" ? this.display(args.path ?? ".") : String(args.pattern ?? "");
          this.emitDaze("search", {
            tool: toolName,
            query,
            scope,
            matches,
            output: output.slice(0, 4000),
          });
          break;
        }
        default:
          break;
      }
    } catch (error) {
      this.emitDaze("error", { message: errorMessage(error) });
    }
  }

  /** Merge a read slice into what we know about a file. */
  private mergeSlice(abs: string, startLine: number, content: string): void {
    if (content.length === 0) return;
    const lines = this.fileLines.get(abs) ?? new Map<number, string>();
    content.split("\n").forEach((line, index) => lines.set(startLine + index, line));
    this.fileLines.set(abs, lines);
  }

  private rememberWholeFile(abs: string, content: string): void {
    const lines = new Map<number, string>();
    content.split("\n").forEach((line, index) => lines.set(index + 1, line));
    this.fileLines.set(abs, lines);
    this.wholeFiles.add(abs);
  }

  /** The file text as the agent knows it, or undefined if nothing was read. */
  private knownText(abs: string): string | undefined {
    const lines = this.fileLines.get(abs);
    if (!lines || lines.size === 0) return undefined;
    const numbers = [...lines.keys()].sort((a, b) => a - b);
    const first = numbers[0]!;
    const last = numbers[numbers.length - 1]!;
    const out: string[] = [];
    for (let n = first; n <= last; n++) out.push(lines.get(n) ?? "");
    return out.join("\n");
  }

  private abs(p: unknown): string {    const value = String(p ?? "");
    return path.isAbsolute(value) ? value : path.join(this.cwd, value);
  }

  private display(p: unknown): string {
    const value = String(p ?? "");
    const absolute = this.abs(value);
    const rel = path.relative(this.cwd, absolute);
    return rel && !rel.startsWith("..") ? toPosix(rel) : value;
  }
}

function toNumber(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** The read tool appends a "[Showing lines a-b of n…]" footer to its output. */
function stripReadNote(text: string): string {
  return text.replace(/\n\n\[(?:Showing lines|Line \d+ is)[^\]]*\]\s*$/, "");
}

/**
 * Apply the agent's own edits to the text it holds. Edits are matched against
 * the original text and must not overlap, so applying them in any order works.
 * Returns undefined when nothing matched (a stale or partial base).
 */
function applyEdits(
  before: string,
  edits: Array<{ oldText?: string; newText?: string }>,
): string | undefined {
  let text = before;
  let matched = false;
  for (const edit of edits) {
    const oldText = edit.oldText ?? "";
    if (oldText.length === 0 || !text.includes(oldText)) continue;
    text = text.replace(oldText, edit.newText ?? "");
    matched = true;
  }
  return matched ? text : undefined;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Extract the concatenated text from a message/tool content array. */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (block && typeof block === "object" && "type" in block && (block as { type?: string }).type === "text") {
        return String((block as { text?: unknown }).text ?? "");
      }
      return "";
    })
    .join("");
}

function textOfResult(result: unknown): string {
  const content = (result as { content?: unknown } | undefined)?.content;
  return textOfContent(content);
}
