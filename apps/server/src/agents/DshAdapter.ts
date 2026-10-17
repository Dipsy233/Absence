import path from "node:path";
import {
  type ApprovalOption,
  type CapabilityState,
  type CommandOption,
  type ContextState,
  type AbsenceEventPayloadMap,
  type AbsenceEventType,
  type SessionStatsInfo,
} from "@absence/core";
import { DshClient, type AcpConfigOption } from "./DshClient";
import { BaseAdapter, type AdapterOptions, type AgentStartContext, type AgentStartResult } from "./AgentAdapter";
import { readFileSafe } from "../filesystem/FileTree";
import { config } from "../config";
import { discoverCapabilities } from "../capabilities/discover";
import { languageFromPath } from "../util/language";
import { toPosix } from "../util/paths";

/**
 * Drives DeepSeek Harness (dsh) through its automation-only ACP server —
 * `dsh --profile acp` — the JSON-RPC/NDJSON channel DSH defines for programmatic
 * clients. Same observer shape as Codex's app-server: Absence subscribes to the
 * runtime's own event stream and translates every update into a AbsenceEvent.
 *
 * ACP (`session/update` notifications) carries the whole turn:
 *   agent_message_chunk   → message (assistant, streaming)
 *   agent_thought_chunk   → thinking
 *   tool_call             → tool_start
 *   tool_call_update      → tool_end (+ file_read/file_write/command by title)
 *   usage_update          → getContextUsage()
 *   config_option_update  → listModels()/setModel()
 * plus `session/request_permission` requests, surfaced as `approval` events.
 *
 * DSH's tool titles are its own tool names ("bash", "read", …) because the ACP
 * bridge forwards the durable call fact's `name` verbatim, so the same
 * first-class mapping Pi's tools get is applied here.
 */
export class DshAdapter extends BaseAdapter {
  readonly runtime = "dsh";
  private client?: DshClient;
  private acpSessionId?: string;
  private model = "dsh";
  private aborted = false;
  private busy = false;
  private usage?: { used: number; total?: number };
  /** Skills / MCP servers this session can use (see capabilities/discover.ts). */
  private capabilities?: CapabilityState;
  /** Last configOptions payload, for the model list. */
  private configOptions?: AcpConfigOption[];
  /** Approval prompts waiting for a user decision, keyed by the event id. */
  private pendingApprovals = new Map<string, (value: string) => void>();
  /** Accumulators so a streamed chunk becomes a full message/thought on end. */
  private assistantAcc = "";
  private thinkingAcc = "";
  /** The last assistant message id counted into the stats. */
  private countedMessageId = "";
  private stats = {
    userMessages: 0,
    assistantMessages: 0,
    toolCalls: 0,
    tokens: { input: 0, output: 0, total: 0 },
  };

  constructor(private readonly options: AdapterOptions) {
    super();
  }

  async start(ctx: AgentStartContext): Promise<AgentStartResult> {
    this.sessionId = ctx.sessionId;
    this.cwd = ctx.cwd;

    this.client = new DshClient({
      dshBin: config.dshBin,
      profile: config.dshProfile,
      dshHome: config.dshHome,
      cwd: ctx.cwd,
      env: {
        // The env marker every shell child inherits, so agentwatch can attribute
        // the processes dsh lays to this Absence session (same marker Pi/Codex use).
        ABSENCE_SESSION_ID: ctx.sessionId,
        ...(config.dshProvider ? { DSH_PROVIDER: config.dshProvider } : {}),
        ...(config.dshModel ? { DSH_MODEL: config.dshModel } : {}),
      },
      onNotification: (method, params) => this.onNotification(method, params),
      onRequest: (method, params) => this.onRequest(method, params),
      onErrorOutput: () => {
        /* stderr is diagnostics; the event stream is the truth */
      },
    });
    await this.client.start();

    // A resumed session reopens the dsh session we recorded; a fresh one is
    // created. `session/resume` degrades to a new session when dsh no longer
    // knows the id, which the adapter reports honestly via the returned id.
    const session = ctx.sessionFile
      ? await this.client.resumeSession(ctx.sessionFile, ctx.cwd).catch(() => this.client!.newSession(ctx.cwd))
      : await this.client.newSession(ctx.cwd);
    this.acpSessionId = session.sessionId;
    this.configOptions = session.configOptions;
    this.model = this.modelFromConfigOptions(session.configOptions) ?? (config.dshProvider && config.dshModel
      ? `${config.dshProvider}/${config.dshModel}`
      : "dsh");
    this.options.processWatcher?.beginSession(ctx.sessionId);
    // DSH has no catalog request in ACP today; its skills live in
    // `<DSH_HOME>/skills` and its MCP/tool plugins surface as `tool_call`s,
    // which already become events. Discovery gives the panel the same list
    // the other runtimes report (see capabilities/discover.ts).
    const discovered = discoverCapabilities({ cwd: ctx.cwd, dshHome: config.dshHome });
    this.capabilities = {
      skills: discovered.skills.map((skill) => ({
        name: skill.name,
        description: skill.description,
        filePath: skill.filePath,
        scope: skill.scope,
      })),
      mcp: discovered.mcpServers.map((server) => ({
        name: server.name,
        type: server.type,
        source: server.source,
        exposure: server.exposure,
        enabled: server.enabled !== false,
        description: server.description,
      })),
      diagnostics: [...discovered.diagnostics],
    };
    return { model: this.model };
  }

  getCapabilities(): CapabilityState | undefined {
    return this.capabilities;
  }

  getContextUsage(): ContextState | undefined {
    if (!this.usage) return undefined;
    return { used: this.usage.used, total: this.usage.total ?? 0 };
  }

  getSessionFile(): string | undefined {
    return this.acpSessionId;
  }

  getRuntimeSessionId(): string | undefined {
    return this.acpSessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  async prompt(text: string): Promise<void> {
    const client = this.client;
    const sessionId = this.acpSessionId;
    if (!client || !sessionId) throw new Error("dsh session not started");
    if (!client.isAlive()) throw new Error("dsh acp server has exited");
    this.aborted = false;
    this.busy = true;
    this.assistantAcc = "";
    this.thinkingAcc = "";
    this.stats.userMessages += 1;
    this.emitAbsence("agent_start", { model: this.model });
    try {
      // `session/prompt` resolves when the turn settles, with a stopReason.
      const { stopReason } = await client.prompt(sessionId, text);
      this.emitAbsence("agent_end", { reason: stopReasonToReason(stopReason, this.aborted) });
    } catch (error) {
      this.emitAbsence("error", { message: errorMessage(error) });
      this.emitAbsence("agent_end", { reason: "error" });
    } finally {
      this.busy = false;
    }
  }

  async abort(): Promise<void> {
    this.aborted = true;
    const client = this.client;
    if (!client || !this.acpSessionId) return;
    // session/cancel is a notification; the in-flight session/prompt settles
    // with stopReason "cancelled" and prompt() emits agent_end.
    client.cancel(this.acpSessionId);
  }

  async listModels(): Promise<CommandOption[]> {
    const options = this.modelOptions();
    if (options.length === 0) return this.currentModelOption();
    const current = this.modelFromConfigOptions(this.configOptions);
    return options.map((option) => ({
      value: option.value,
      label: option.name || option.value,
      description: option.group ?? option.description,
      active: option.value === current,
    }));
  }

  async setModel(value: string): Promise<string> {
    const client = this.client;
    const sessionId = this.acpSessionId;
    if (!client || !sessionId) throw new Error("dsh session not started");
    await client.setConfigOption(sessionId, "model", value);
    // The ACP value for a model is its own "provider/model" pair in the option
    // list; report the human-readable form the rest of Absence shows.
    this.model = humanModelName(value);
    return this.model;
  }

  getSessionStats(): SessionStatsInfo {
    return {
      sessionId: this.acpSessionId ?? this.sessionId,
      userMessages: this.stats.userMessages,
      assistantMessages: this.stats.assistantMessages,
      toolCalls: this.stats.toolCalls,
      tokens: { ...this.stats.tokens, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      contextUsed: this.usage?.used,
      contextTotal: this.usage?.total,
    };
  }

  /**
   * Answer an agent-to-client request. DSH asks the client for permission
   * (`session/request_permission`); the turn stays blocked until we answer.
   * Absence surfaces it as an `approval` event and waits for the user's pick.
   */
  private onRequest(method: string, params: any): unknown | Promise<unknown> {
    switch (method) {
      case "session/request_permission":
        return this.requestPermission(params);
      default:
        throw new Error(`unsupported request: ${method}`);
    }
  }

  private requestPermission(params: any): Promise<unknown> {
    const id = `appr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const toolCall = params?.toolCall ?? {};
    const options = permissionOptions(params?.options);
    const title = String(toolCall.title ?? toolCall.toolCallId ?? "Run a tool");
    const detail = formatToolCallDetail(toolCall);
    this.emitAbsence("approval", {
      id,
      kind: "command",
      title,
      detail,
      itemId: toolCall.toolCallId ? String(toolCall.toolCallId) : undefined,
      options,
    });
    return new Promise((resolve) => {
      this.pendingApprovals.set(id, (value) => {
        this.pendingApprovals.delete(id);
        // ACP wants { outcome: { outcome: "selected", optionId } } — or
        // { outcome: { outcome: "cancelled" } } when the user dismissed.
        if (value === "cancel") {
          resolve({ outcome: { outcome: "cancelled" } });
        } else {
          resolve({ outcome: { outcome: "selected", optionId: value } });
        }
      });
    });
  }

  /** Answer an approval the user picked on the Stage. */
  async respondApproval(id: string, value: string): Promise<void> {
    this.pendingApprovals.get(id)?.(value);
  }

  dispose(): void {
    this.aborted = true;
    for (const [, resolve] of this.pendingApprovals) resolve("cancel");
    this.pendingApprovals.clear();
    for (const windowId of this.commandWindows.values()) this.options.processWatcher?.end(windowId);
    this.commandWindows.clear();
    const client = this.client;
    const sessionId = this.acpSessionId;
    if (client && sessionId) void client.closeSession(sessionId);
    client?.dispose();
    this.client = undefined;
    this.acpSessionId = undefined;
  }

  // --------------------------------------------------------------------------

  private onNotification(method: string, params: any): void {
    if (method !== "session/update") return;
    const update = params?.update;
    if (!update || typeof update !== "object") return;
    const emit = <K extends AbsenceEventType>(type: K, payload: AbsenceEventPayloadMap[K]) =>
      this.emitAbsence(type, payload);

    switch (update.sessionUpdate) {
      case "agent_message_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) break;
        // Count each assistant message once, on its first chunk (ACP carries a
        // stable messageId across a message's deltas).
        const messageId = String(update.messageId ?? "");
        if (messageId && messageId !== this.countedMessageId) {
          this.countedMessageId = messageId;
          this.stats.assistantMessages += 1;
        }
        this.assistantAcc += text;
        emit("message", {
          role: "assistant",
          content: this.assistantAcc,
          delta: text,
          streaming: true,
        });
        break;
      }

      case "agent_thought_chunk": {
        const text = textOfContentBlock(update.content);
        if (text.length === 0) break;
        this.thinkingAcc += text;
        emit("thinking", {
          content: this.thinkingAcc,
          delta: text,
          streaming: true,
        });
        break;
      }

      case "tool_call": {
        this.stats.toolCalls += 1;
        const name = String(update.title ?? "tool");
        const callId = String(update.toolCallId);
        this.toolNames.set(callId, name);
        this.toolInputs.set(callId, update.rawInput);
        // A shell tool is about to run: open a command window so the process
        // watcher can attribute whatever it lays to this command (the same
        // begin/end contract Pi's AbsenceShell and Codex's exec-server use).
        this.openCommandWindow(callId, name, update.rawInput);
        emit("tool_start", {
          toolCallId: callId,
          toolName: name,
          args: update.rawInput ?? {},
        });
        break;
      }

      case "tool_call_update": {
        const isError = update.status === "failed";
        const callId = String(update.toolCallId);
        const name = String(update.title ?? this.toolNames.get(callId) ?? "tool");
        const rawInput = update.rawInput ?? this.toolInputs.get(callId);
        // Close the command window before mapping the result: the watcher takes
        // its final look once the command has returned.
        this.closeCommandWindow(callId);
        emit("tool_end", {
          toolCallId: callId,
          toolName: name,
          isError,
        });
        if (!isError) void this.mapToolResult(name, { ...update, rawInput });
        this.toolNames.delete(callId);
        this.toolInputs.delete(callId);
        break;
      }

      case "usage_update": {
        const used = toNumber(update.used);
        const total = toNumber(update.size);
        if (used > 0 || total > 0) this.usage = { used, total: total || undefined };
        break;
      }

      case "config_option_update": {
        if (Array.isArray(update.configOptions)) this.configOptions = update.configOptions as AcpConfigOption[];
        break;
      }

      default:
        break; // plan, current_mode, available_commands, session_info, …
    }
  }

  /** Map a finished tool call to the first-class event it deserves. */
  private async mapToolResult(name: string, update: any): Promise<void> {
    const lowered = name.toLowerCase();
    const content = textOfToolContent(update.content);
    try {
      // DSH forwards whatever the tool is called upstream. An MCP-backed tool
      // reaches it as `mcp__<server>__<tool>` (the naming every MCP client
      // uses), so it is reported as an MCP call rather than as an unknown tool
      // with no Stage output.
      if (mcpParts(name)) {
        const parts = mcpParts(name)!;
        this.emitAbsence("mcp", {
          server: parts.server,
          tool: parts.tool,
          toolName: name,
          toolCallId: String(update.toolCallId ?? name),
          args: JSON.stringify(update.rawInput ?? {}, null, 2),
          result: content.slice(0, 20_000),
          isError: update.status === "failed",
        });
        return;
      }
      if (lowered === "read" || lowered === "file_read") {
        // DSH's read result is wrapped:
        //   <path>…</path>\n<type>file</type>\n<content>\nNN: line\n…
        // Absence's file_read wants the plain text with real line numbers, so
        // unwrap and de-number. Fall back to reading from disk when the result
        // is empty.
        const p = toolInputPath(update) ?? "";
        if (!p) return;
        const abs = this.abs(p);
        const raw = content.length > 0 ? content : (await readFileSafe(abs)) ?? "";
        const text = stripDshReadWrapper(raw);
        const lineCount = text.length === 0 ? 0 : text.split("\n").length;
        this.emitAbsence("file_read", {
          path: this.display(p),
          startLine: 1,
          endLine: Math.max(1, lineCount),
          content: text,
          language: languageFromPath(abs),
        });
      } else if (lowered === "write" || lowered === "file_write") {
        const p = toolInputPath(update) ?? "";
        if (!p) return;
        // The tool result is only a status line ("Created file …"); the bytes
        // the agent wrote are in the call's input.
        const written = toolInputContent(update);
        const abs = this.abs(p);
        const text = written ?? ((await readFileSafe(abs)) ?? "");
        this.emitAbsence("file_write", { path: this.display(p), content: text });
      } else if (lowered === "edit" || lowered === "str_replace" || lowered === "str_replace_editor") {
        const p = toolInputPath(update) ?? "";
        if (!p) return;
        // dsh reports the new content / a diff in the result; the before/after
        // pair is reconstructed from disk when the tool only says "updated".
        const after = stripDshReadWrapper(content);
        this.emitAbsence("file_edit", { path: this.display(p), before: "", after, diff: "" });
      } else if (lowered === "bash" || lowered === "pwsh" || lowered === "shell" || lowered === "command") {
        this.emitAbsence("command", {
          command: String(toolInputCommand(update) ?? ""),
          stdout: content,
          stderr: "",
          exitCode: 0,
        });
      } else if (lowered === "grep" || lowered === "find" || lowered === "ls" || lowered === "search") {
        const query = String(toolInputQuery(update) ?? "");
        const scope = toolInputPath(update);
        const matches = content.split("\n").filter((line) => line.trim().length > 0).length;
        this.emitAbsence("search", {
          tool: lowered,
          query,
          scope: scope ? this.display(scope) : undefined,
          matches,
          output: content.slice(0, 4000),
        });
      }
    } catch (error) {
      this.emitAbsence("error", { message: errorMessage(error) });
    }
  }

  /** Remember tool titles/inputs so a bare tool_call_update still names the tool. */
  private toolNames = new Map<string, string>();
  private toolInputs = new Map<string, unknown>();
  /**
   * The ProcessWatcher command window each in-flight shell tool opened, keyed by
   * tool call id. Opened on tool_call and closed on tool_call_update, so the
   * watcher can attribute the processes the command lays (Agent Eggs) exactly as
   * it does for Pi's shell and Codex's exec-server.
   */
  private commandWindows = new Map<string, number>();

  /** The dsh tools that actually spawn a shell. */
  private static readonly SHELL_TOOLS = new Set(["bash", "pwsh", "powershell", "shell", "command"]);

  /** Open a ProcessWatcher window for a shell tool call, when the watcher is wired. */
  private openCommandWindow(callId: string, toolName: string, rawInput: unknown): void {
    if (!this.options.processWatcher) return;
    if (!DshAdapter.SHELL_TOOLS.has(toolName.toLowerCase())) return;
    const command = commandFromInput(rawInput);
    if (!command) return;
    const windowId = this.options.processWatcher.begin(command, this.cwd);
    this.commandWindows.set(callId, windowId);
  }

  /** Close the shell tool's window; the watcher settles its evidence off-path. */
  private closeCommandWindow(callId: string): void {
    const windowId = this.commandWindows.get(callId);
    if (windowId === undefined) return;
    this.commandWindows.delete(callId);
    this.options.processWatcher?.end(windowId);
  }

  private abs(p: unknown): string {
    const value = String(p ?? "").replace(/^@/, "");
    return path.isAbsolute(value) ? value : path.join(this.cwd, value);
  }

  private display(p: unknown): string {
    const value = String(p ?? "");
    const absolute = this.abs(value);
    const rel = path.relative(this.cwd, absolute);
    return rel && !rel.startsWith("..") ? toPosix(rel) : value;
  }

  /** The current model's human name, from the ACP config option list. */
  private modelFromConfigOptions(options: AcpConfigOption[] | undefined): string | undefined {
    const model = (options ?? []).find((option) => option.id === "model" || option.category === "model");
    if (!model || model.currentValue === undefined) return undefined;
    const value = String(model.currentValue);
    return humanModelName(value);
  }

  /** Every model option DSH advertised, flattened out of its groups. */
  private modelOptions(): Array<{ value: string; name?: string; description?: string; group?: string }> {
    const model = (this.configOptions ?? []).find((option) => option.id === "model" || option.category === "model");
    if (!model || !Array.isArray(model.options)) return [];
    const out: Array<{ value: string; name?: string; description?: string; group?: string }> = [];
    for (const entry of model.options) {
      if ("value" in entry) {
        out.push({ value: entry.value, name: entry.name, description: entry.description });
      } else if ("options" in entry && Array.isArray(entry.options)) {
        for (const inner of entry.options) {
          out.push({ value: inner.value, name: inner.name, description: inner.description, group: entry.name });
        }
      }
    }
    return out;
  }

  private currentModelOption(): CommandOption[] {
    return [
      {
        value: this.model,
        label: this.model,
        description: "reported by the dsh acp session",
        active: true,
      },
    ];
  }
}

/**
 * ACP's model values look like `["deepseek-official","deepseek-v4-flash"]`
 * (a JSON-encoded provider/model pair). Absence shows `provider/model`.
 */
function humanModelName(value: string): string {
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.length === 2) return `${parsed[0]}/${parsed[1]}`;
  } catch {
    // not JSON; fall through
  }
  return value;
}

/** Map ACP's stopReason to an Absence agent_end reason. */
function stopReasonToReason(stopReason: string | undefined, aborted: boolean): string {
  if (aborted) return "aborted";
  switch (stopReason) {
    case "cancelled":
      return "aborted";
    case "max_tokens":
    case "max_turn_requests":
      return "error";
    case "refusal":
      return "error";
    default:
      return "completed";
  }
}

/**
 * The choices a permission card offers, from ACP's own options. ACP kinds
 * (`allow_once`, `allow_always`, `reject_once`, `reject_always`) map to the
 * Stage's tones; the optionId is what we send back.
 */
function permissionOptions(options: unknown): ApprovalOption[] {
  const list = Array.isArray(options) ? (options as Array<{ optionId?: string; name?: string; kind?: string }>) : [];
  if (list.length === 0) {
    return [
      { value: "allow-once", label: "Allow once", tone: "accept" },
      { value: "reject-once", label: "Deny", tone: "decline" },
    ];
  }
  return list
    .filter((option) => typeof option.optionId === "string")
    .map((option) => ({
      value: option.optionId as string,
      label: option.name || option.optionId || "Choose",
      tone: toneForAcpKind(option.kind),
    }));
}

function toneForAcpKind(kind: string | undefined): ApprovalOption["tone"] {
  switch (kind) {
    case "allow_once":
      return "accept";
    case "allow_always":
      return "accept-session";
    case "reject_once":
      return "decline";
    case "reject_always":
      return "cancel";
    default:
      return "accept";
  }
}

/** A tool call's detail, shown verbatim on the Stage. */
function formatToolCallDetail(toolCall: any): string {
  const lines: string[] = [];
  if (toolCall.title) lines.push(String(toolCall.title));
  if (toolCall.rawInput !== undefined) {
    lines.push(typeof toolCall.rawInput === "string" ? toolCall.rawInput : JSON.stringify(toolCall.rawInput, null, 2));
  }
  if (toolCall.locations) {
    for (const location of toolCall.locations as Array<{ path?: string }>) {
      if (location.path) lines.push(location.path);
    }
  }
  return lines.length > 0 ? lines.join("\n") : "(no detail)";
}

/** Extract text from an ACP content block or tool-call content array. */
function textOfContentBlock(content: unknown): string {
  if (typeof content === "string") return content;
  if (!content || typeof content !== "object") return "";
  const block = content as { type?: string; text?: unknown };
  if (block.type === "text") return String(block.text ?? "");
  return "";
}

/** `mcp__filesystem__read_file` → the server and tool, or undefined. */
function mcpParts(name: string): { server: string; tool: string } | undefined {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice("mcp__".length);
  const separator = rest.indexOf("__");
  if (separator === -1) return { server: rest, tool: "" };
  return { server: rest.slice(0, separator), tool: rest.slice(separator + 2) };
}

function textOfToolContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    // tool_call_update content entries look like { type: "content", content: {...} }.
    const inner = (item as { content?: unknown })?.content ?? item;
    const text = textOfContentBlock(inner);
    if (text.length > 0) parts.push(text);
  }
  return parts.join("\n");
}

function toolInputPath(update: any): string | undefined {
  const input = update?.rawInput ?? update?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath", "file", "filename"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

/** The bytes a write/edit tool was given to store, from its call input. */
function toolInputContent(update: any): string | undefined {
  const input = update?.rawInput ?? update?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["content", "contents", "text", "new_string", "newText"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

/**
 * Unwrap a dsh read result. The tool answers with:
 *
 *   <path>/abs/path</path>
 *   <type>file</type>
 *   <content>
 *   1: first line
 *   2: second line
 *   </content>
 *
 * Absence's `file_read` carries the plain text (no wrapper, no line-number
 * prefix), the same shape Pi's read produces, so strip both here.
 */
function stripDshReadWrapper(text: string): string {
  let body = text;
  // Drop a leading <path>… and <type>… header, and the <content> opener.
  const contentAt = body.indexOf("<content>");
  if (contentAt >= 0) {
    body = body.slice(contentAt + "<content>".length);
  } else if (/^\s*<path>[\s\S]*?<\/path>/.test(body)) {
    // No <content> tag: strip the header lines anyway.
    body = body.replace(/^\s*<path>[\s\S]*?<\/path>\s*/, "").replace(/^\s*<type>[^<]*<\/type>\s*/, "");
  }
  // Remove a trailing </content>.
  body = body.replace(/\s*<\/content>\s*$/, "");
  // Drop one leading and one trailing newline introduced by the wrapper.
  body = body.replace(/^\n/, "").replace(/\n$/, "");
  // Remove the “N: ” / “N\t” line-number prefix dsh puts on each line.
  body = body
    .split("\n")
    .map((line) => line.replace(/^\s*\d+[:\t]\s?/, ""))
    .join("\n");
  return body;
}

function toolInputCommand(update: any): string | undefined {
  const input = update?.rawInput ?? update?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

/** The shell command text a tool call carries, from its own rawInput. */
function commandFromInput(rawInput: unknown): string | undefined {
  if (!rawInput || typeof rawInput !== "object") return undefined;
  const record = rawInput as Record<string, unknown>;
  for (const key of ["command", "cmd", "script"]) {
    if (typeof record[key] === "string" && (record[key] as string).trim().length > 0) {
      return record[key] as string;
    }
  }
  return undefined;
}

function toolInputQuery(update: any): string | undefined {
  const input = update?.rawInput ?? update?.input;
  if (!input || typeof input !== "object") return undefined;
  const record = input as Record<string, unknown>;
  for (const key of ["pattern", "query", "path", "glob"]) {
    if (typeof record[key] === "string") return record[key] as string;
  }
  return undefined;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
