import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import {
  type CommandOption,
  type ContextState,
  type DazeEventPayloadMap,
  type DazeEventType,
  type SessionStatsInfo,
} from "@daze/core";
import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { BaseAdapter, type AdapterOptions, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { createDazeShell } from "../process/DazeShell";
import { readFileSafe } from "../filesystem/FileTree";
import { languageFromPath } from "../util/language";
import { toPosix } from "../util/paths";

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
  private piSessionFile?: string;
  private piSessionId?: string;
  private toolArgs = new Map<string, unknown>();
  /** When each tool call started, so search events can carry their duration. */
  private toolStartedAt = new Map<string, number>();
  /** Lines the agent has received, keyed by their line number in the file. */
  private fileLines = new Map<string, Map<number, string>>();
  /** Paths whose whole content we hold (a write/edit). */
  private wholeFiles = new Set<string>();
  private assistantAcc = "";
  private thinkingAcc = "";
  private aborted = false;

  constructor(private readonly options: AdapterOptions) {
    super();
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;

    // Loaded lazily so the mock runtime never pays Pi's import cost.
    const {
      createAgentSession,
      SessionManager,
      createBashToolDefinition,
      createPowerShellToolDefinition,
    } = await import("@earendil-works/pi-coding-agent");

    // Pi persists a conversation to ~/.pi/agent/sessions/<cwd>/ by default. A
    // resumed session reopens that file; a fresh one creates it. (DAZE used to
    // force SessionManager.inMemory here, which is why history never survived.)
    const manager = ctx.sessionFile
      ? SessionManager.open(ctx.sessionFile, undefined, ctx.cwd)
      : SessionManager.create(ctx.cwd);

    // Take over the shell: a custom tool registered under the same name shadows
    // Pi's built-in one (Pi's registry keys by name), so the allowlist in
    // DAZE_PI_TOOLS is untouched. Pi still executes the command — Daze just owns
    // the boundary, which is what lets it see the processes the agent lays.
    const shell = this.options.processWatcher ? await createDazeShell(this.options.processWatcher) : undefined;
    // The cast is Pi's own typing wart: a tool definition is typed with the
    // schema it was built for, while the registry wants the widened form.
    const customTools = shell
      ? ([
          createBashToolDefinition(ctx.cwd, { operations: shell.bash }),
          createPowerShellToolDefinition(ctx.cwd, { operations: shell.powershell }),
        ] as unknown as NonNullable<CreateAgentSessionOptions["customTools"]>)
      : undefined;

    const { session } = await createAgentSession({
      cwd: ctx.cwd,
      tools: this.options.tools,
      sessionManager: manager,
      customTools,
    });

    this.session = session;
    this.piSessionFile = manager.getSessionFile();
    this.piSessionId = manager.getSessionId();
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

  getSessionFile(): string | undefined {
    return this.piSessionFile;
  }

  getRuntimeSessionId(): string | undefined {
    return this.piSessionId;
  }

  // --- command surface (read02 terminal box) ---------------------------------

  async listModels(): Promise<CommandOption[]> {
    const session = this.session;
    if (!session) return [];
    const runtime = session.modelRuntime;
    let models = runtime.getModels();
    try {
      // Prefer models we actually have credentials for, so setModel cannot throw.
      const available = await runtime.getAvailable();
      if (available.length > 0) models = available;
    } catch {
      // no credentials yet — fall back to every configured model
    }
    return models.map((model) => {
      const value = `${model.provider}/${model.id}`;
      return {
        value,
        label: model.name || model.id,
        description: model.provider,
        active: value === this.model,
      };
    });
  }

  async setModel(value: string): Promise<string> {
    const session = this.session;
    if (!session) throw new Error("Pi session not started");
    // Resolve the option value back to a Model object rather than splitting the
    // joined string apart: a provider or model id may itself contain a slash.
    const runtime = session.modelRuntime;
    const matches = (model: { provider: string; id: string }) => `${model.provider}/${model.id}` === value;
    const model = runtime.getModels().find(matches) ?? (await runtime.getAvailable()).find(matches);
    if (!model) throw new Error(`unknown model: ${value}`);
    await session.setModel(model, { persist: false });
    // Keep the string we report on `agent_start` in sync (otherwise the next
    // prompt re-emits the stale model and overwrites session.model).
    this.model = `${model.provider}/${model.id}`;
    return this.model;
  }

  getThinking(): { level: string; available: string[] } {
    const session = this.session;
    if (!session) return { level: "off", available: ["off"] };
    const level = String(session.thinkingLevel);
    const available = session.supportsThinking() ? session.getAvailableThinkingLevels().map(String) : ["off"];
    return { level, available };
  }

  async setThinking(level: string): Promise<string> {
    const session = this.session;
    if (!session) throw new Error("Pi session not started");
    // ThinkingLevel is not re-exported from the package root; derive it locally.
    session.setThinkingLevel(level as Parameters<AgentSession["setThinkingLevel"]>[0]);
    return String(session.thinkingLevel);
  }

  getSessionName(): string | undefined {
    return this.session?.sessionName;
  }

  setSessionName(name: string): void {
    this.session?.setSessionName(name);
  }

  getSessionStats(): SessionStatsInfo {
    const session = this.session;
    if (!session) throw new Error("Pi session not started");
    const stats = session.getSessionStats();
    const usage = stats.contextUsage;
    return {
      sessionId: stats.sessionId,
      sessionFile: stats.sessionFile,
      userMessages: stats.userMessages,
      assistantMessages: stats.assistantMessages,
      toolCalls: stats.toolCalls,
      tokens: { ...stats.tokens },
      cost: stats.cost,
      contextUsed: usage?.tokens ?? undefined,
      contextTotal: usage?.contextWindow,
    };
  }

  async compact(instructions?: string): Promise<{ tokensBefore?: number; estimatedTokensAfter?: number }> {
    const session = this.session;
    if (!session) throw new Error("Pi session not started");
    const result = await session.compact(instructions);
    return { tokensBefore: result.tokensBefore, estimatedTokensAfter: result.estimatedTokensAfter };
  }

  async exportSession(format: "html" | "jsonl"): Promise<string> {
    const session = this.session;
    if (!session) throw new Error("Pi session not started");
    // Always an explicit path under ~/.daze: exportToJsonl() defaults to cwd,
    // which would drop the file into the project and fire file_change events.
    const dir = path.join(os.homedir(), ".daze", "exports");
    await fs.mkdir(dir, { recursive: true });
    const base = this.piSessionId ?? this.sessionId ?? "session";
    if (format === "jsonl") {
      return session.exportToJsonl(path.join(dir, `${base}.jsonl`));
    }
    return session.exportToHtml(path.join(dir, `${base}.html`));
  }

  isBusy(): boolean {
    return this.session?.isStreaming ?? false;
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
        this.toolStartedAt.set(event.toolCallId, Date.now());
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
        const startedAt = this.toolStartedAt.get(event.toolCallId);
        this.toolStartedAt.delete(event.toolCallId);
        void this.mapToolResult(event.toolName, args, event.result, event.isError, startedAt);
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
    startedAt?: number,
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
          // Only remember a version we actually saw: an empty read (path
          // unresolved, binary, gone) must not overwrite the file we hold with
          // an empty whole-file version.
          if (after.length > 0 || known === undefined) this.rememberWholeFile(abs, after);
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
            durationMs: startedAt !== undefined ? Date.now() - startedAt : undefined,
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

  private abs(p: unknown): string {
    // A small model sometimes echoes the UI's `@file` reference style and passes
    // the tool a path like `@src/api.ts`. Pi's own tools tolerate it; Daze must
    // too, or the read/edit content is read from a file that does not exist and
    // every recorded version comes out empty. Strip the prefix before joining.
    const value = String(p ?? "").replace(/^@/, "");
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
