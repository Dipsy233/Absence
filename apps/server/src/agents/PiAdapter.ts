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
  private fileCache = new Map<string, string>();
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
          const content = (await readFileSafe(abs)) ?? textOfResult(result);
          const lines = content.split("\n");
          const offset = toNumber(args.offset, 1);
          const startLine = Math.max(1, offset);
          const limit = args.limit !== undefined ? toNumber(args.limit, lines.length) : undefined;
          const endLine = Math.min(lines.length, limit ? startLine + limit - 1 : lines.length);
          this.fileCache.set(abs, content);
          this.emitDaze("file_read", {
            path: this.display(args.path),
            startLine,
            endLine,
            content: lines.slice(startLine - 1, endLine).join("\n"),
            language: languageFromPath(abs),
          });
          break;
        }
        case "write": {
          const abs = this.abs(args.path);
          const content = (await readFileSafe(abs)) ?? String(args.content ?? "");
          this.fileCache.set(abs, content);
          this.emitDaze("file_write", {
            path: this.display(args.path),
            content,
          });
          break;
        }
        case "edit": {
          const abs = this.abs(args.path);
          const before = this.fileCache.get(abs) ?? "";
          const after = (await readFileSafe(abs)) ?? "";
          const details = (result as { details?: { diff?: string } } | undefined)?.details;
          this.fileCache.set(abs, after);
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

  private abs(p: unknown): string {
    const value = String(p ?? "");
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
