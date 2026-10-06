import path from "node:path";
import {
  createEvent,
  type AgentStatus,
  type ChatMessage,
  type CommandOption,
  type ContextState,
  type DazeEvent,
  type FileState,
  type FileTreeNode,
  type Session,
  type SessionRuntimeState,
  type SessionSnapshot,
  type SessionStatsInfo,
} from "@daze/core";
import { config, type AgentKind } from "../config";
import { appendEvents, drainArchive, readEvents, writeMeta } from "./archive";
import { EventBus } from "../events";
import type { AgentAdapter } from "../agents/AgentAdapter";
import { createAdapter } from "../agents/createAdapter";
import { MockAdapter } from "../agents/MockAdapter";
import { FileWatcher } from "../filesystem/FileWatcher";
import { buildTree, readFileSafe } from "../filesystem/FileTree";
import { ProcessWatcher } from "../process/ProcessWatcher";
import { JobMonitor } from "../process/JobMonitor";
import { newId } from "../util/ids";
import { toPosix } from "../util/paths";

const MAX_EVENTS = 1000;

/** Events that own the Stage. */
const STAGE_TYPES = new Set<DazeEvent["type"]>([
  "thinking",
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "search",
  "agent_start",
  "agent_end",
]);

/** Everything needed to reopen a session after it was closed or the server restarted. */
export interface DazeResume {
  /** DAZE's archive id — its events rebuild the Stage, Activity, files and chat. */
  dazeSessionId?: string;
  /** Pi's session file — reopens the model's conversation. */
  piSessionFile?: string;
  piSessionId?: string;
  startedAt?: number;
}

/**
 * One open workspace, observed (read.md §24). Live state is in memory; the
 * DazeEvent stream is also archived to disk, so a session survives a restart.
 */
export class DazeSession {
  readonly id: string;
  readonly bus = new EventBus<DazeEvent>();
  readonly stateBus = new EventBus<SessionRuntimeState>();
  readonly session: Session;

  private adapter: AgentAdapter;
  private watcher?: FileWatcher;
  /** Reports the OS processes the agent lays; Daze owns the shell (v0.3). */
  private processWatcher: ProcessWatcher;
  private unsubAdapter?: () => void;
  private events: DazeEvent[] = [];
  private currentAction?: DazeEvent;
  private files = new Map<string, FileState>();
  private chat: ChatMessage[] = [];
  private context?: ContextState;
  private tree?: FileTreeNode;
  private assistantStreamId?: string;
  private lastActiveAt: number;
  private promptCount = 0;
  private firstPrompt?: string;
  private piSessionFile?: string;
  private piSessionId?: string;
  private metaTimer?: NodeJS.Timeout;
  private stateTimer?: NodeJS.Timeout;
  private treeTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(projectPath: string, kind: AgentKind, private readonly resume?: DazeResume) {
    this.id = resume?.dazeSessionId ?? newId("sess");
    this.session = {
      id: this.id,
      projectPath,
      projectName: path.basename(projectPath) || projectPath,
      startedAt: resume?.startedAt ?? Date.now(),
      agentRuntime: kind,
      status: "listening",
    };
    this.piSessionFile = resume?.piSessionFile;
    this.piSessionId = resume?.piSessionId;
    // Pi and its tools run in this very process, so an egg's ancestor chain ends
    // here — the watcher's default root pid is us.
    this.processWatcher = new ProcessWatcher({
      onProcess: (payload) => this.handleEvent(createEvent(this.id, "process", payload)),
    });
    // Say how precise process watching is, so the UI can be honest about it.
    this.session.processPrecision = JobMonitor.get().available ? "exact" : "sampled";
    this.adapter = createAdapter(kind, { tools: config.piTools, processWatcher: this.processWatcher });
    // Baseline now: what is already running before the agent starts. The snapshot
    // costs half a second, so it has to be taken here rather than when the first
    // command begins.
    this.processWatcher.warm();
    this.lastActiveAt = this.session.startedAt;
  }

  async start(): Promise<void> {
    // Bring DAZE's own history back first, so the UI already has the Stage,
    // Activity, files and chat from before the restart.
    const archiveId = this.resume?.dazeSessionId;
    if (archiveId !== undefined) {
      const events = await readEvents(this.session.projectPath, archiveId);
      for (const event of events) this.applyToState(event);
      this.events = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
      // A resumed session is not mid-run: the agent is idle again.
      this.setStatus("listening");
    }

    const ctx = {
      sessionId: this.id,
      cwd: this.session.projectPath,
      sessionFile: this.piSessionFile,
    };
    try {
      const result = await this.adapter.start(ctx);
      this.session.model = result.model;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.adapter = new MockAdapter({ tools: config.piTools, processWatcher: this.processWatcher });
      const result = await this.adapter.start(ctx);
      this.session.model = result.model;
      this.session.agentRuntime = "mock";
      this.session.degraded = true;
      this.emitInternal(
        createEvent(this.id, "error", { message: `Pi runtime unavailable, using mock: ${message}` }),
      );
    }

    // The adapter may have opened (or created) its own persisted session file.
    this.piSessionFile = this.adapter.getSessionFile?.() ?? this.piSessionFile;
    this.piSessionId = this.adapter.getRuntimeSessionId?.() ?? this.piSessionId;

    this.unsubAdapter = this.adapter.subscribe((event) => this.handleEvent(event));

    this.tree = await buildTree(this.session.projectPath);

    this.watcher = new FileWatcher(this.session.projectPath, (kind, abs) => this.onFsChange(kind, abs));
    this.watcher.start();

    await this.flushMeta();
    this.scheduleState();
  }

  /** Fire-and-forget: the run streams over the bus, the HTTP call returns at once. */
  prompt(text: string): void {
    this.handleEvent(
      createEvent(this.id, "message", { role: "user", content: text, streaming: false }),
    );
    void this.adapter.prompt(text).catch((error) => {
      this.handleEvent(
        createEvent(this.id, "error", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    });
  }

  async abort(): Promise<void> {
    await this.adapter.abort();
  }

  /** Choice lists for the commands that need one (the palette's submenu). */
  async commandOptions(name: string): Promise<CommandOption[]> {
    switch (name) {
      case "model":
        return (await this.adapter.listModels?.()) ?? [];
      case "thinking": {
        const thinking = this.adapter.getThinking?.();
        if (!thinking) return [];
        return thinking.available.map((level) => ({
          value: level,
          label: level,
          active: level === thinking.level,
        }));
      }
      default:
        return [];
    }
  }

  /**
   * Run a terminal-box command (`/model …`). Output is emitted as a system
   * `message` event so it reaches the chat, persists to the archive and comes
   * back on resume — the HTTP call itself only reports that it ran.
   */
  async runCommand(name: string, args: string): Promise<void> {
    const adapter = this.adapter;
    const notice = (content: string): void =>
      this.handleEvent(createEvent(this.id, "message", { role: "system", content, streaming: false }));
    const mutating = name === "model" || name === "thinking" || name === "compact";
    if (mutating && (adapter.isBusy?.() ?? false)) {
      notice(`Cannot run /${name} while the agent is working — stop it first.`);
      return;
    }
    try {
      switch (name) {
        case "model": {
          if (!adapter.setModel) return notice("This runtime cannot switch models.");
          const value = args.trim();
          if (!value) return notice("Usage: /model <provider/id> — or pick from the list.");
          const active = await adapter.setModel(value);
          this.session.model = active;
          this.scheduleState();
          notice(`Model switched to ${active}.`);
          break;
        }
        case "thinking": {
          if (!adapter.getThinking || !adapter.setThinking) {
            return notice("This runtime cannot set the thinking level.");
          }
          const level = args.trim();
          if (!level) {
            const current = adapter.getThinking();
            return notice(`Thinking level: ${current.level}. Options: ${current.available.join(", ")}.`);
          }
          const applied = await adapter.setThinking(level);
          notice(`Thinking level set to ${applied}.`);
          break;
        }
        case "compact": {
          if (!adapter.compact) return notice("This runtime cannot compact.");
          const previous = this.session.status;
          const result = await adapter.compact(args.trim() || undefined);
          // compaction_start flips the status to "thinking"; put it back.
          this.setStatus(previous === "thinking" ? "listening" : previous);
          notice(
            result.tokensBefore !== undefined
              ? `Context compacted (${result.tokensBefore} → ${result.estimatedTokensAfter ?? "?"} tokens).`
              : "Context compacted.",
          );
          break;
        }
        case "name": {
          if (!adapter.setSessionName) return notice("This runtime cannot name sessions.");
          const value = args.trim();
          if (!value) {
            const current = adapter.getSessionName?.();
            return notice(current ? `Session name: ${current}` : "Usage: /name <name>");
          }
          adapter.setSessionName(value);
          notice(`Session name set to ${value}.`);
          break;
        }
        case "session": {
          if (!adapter.getSessionStats) return notice("This runtime cannot report stats.");
          notice(formatSessionStats(adapter.getSessionStats()));
          break;
        }
        case "export": {
          if (!adapter.exportSession) return notice("This runtime cannot export.");
          const format = args.trim().toLowerCase() === "jsonl" ? "jsonl" : "html";
          const file = await adapter.exportSession(format);
          notice(`Exported session (${format}) to ${file}`);
          break;
        }
        default:
          notice(`Unknown command: /${name}`);
      }
    } catch (error) {
      notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  history(): DazeEvent[] {
    return [...this.events];
  }

  runtimeState(): SessionRuntimeState {
    return {
      session: this.session,
      agent: { status: this.session.status, model: this.session.model },
      context: this.context,
      tree: this.tree,
    };
  }

  /** A compact row for the session history list. */
  snapshot(): SessionSnapshot {
    return {
      ...this.runtimeState(),
      currentAction: this.currentAction,
      files: [...this.files.values()],
      chat: [...this.chat],
      events: [...this.events],
    };
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.treeTimer) clearTimeout(this.treeTimer);
    if (this.metaTimer) clearTimeout(this.metaTimer);
    // Stops watching only. Eggs the agent left running are not ours to kill.
    this.processWatcher.stop();
    this.unsubAdapter?.();
    this.adapter.dispose();
    await this.watcher?.close();
    await this.flushMeta();
    await drainArchive();
  }

  // --------------------------------------------------------------------------

  private handleEvent(event: DazeEvent): void {
    if (this.disposed) return;
    this.lastActiveAt = event.timestamp;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.applyToState(event);
    this.bus.emit(event);
    this.persist(event);
    this.scheduleState();
  }

  /** Used for events Daze itself originates (before the bus exists). */
  private emitInternal(event: DazeEvent): void {
    this.events.push(event);
    this.bus.emit(event);
    this.persist(event);
  }

  /** Append to the on-disk archive and refresh its header (best-effort). */
  private persist(event: DazeEvent): void {
    appendEvents(this.session.projectPath, this.id, [event]);
    this.scheduleMeta();
  }

  private scheduleMeta(): void {
    if (this.metaTimer) return;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = undefined;
      void this.flushMeta();
    }, 800);
  }

  private async flushMeta(): Promise<void> {
    await writeMeta(this.session.projectPath, {
      version: 1,
      dazeSessionId: this.id,
      projectPath: this.session.projectPath,
      projectName: this.session.projectName,
      startedAt: this.session.startedAt,
      updatedAt: this.lastActiveAt,
      model: this.session.model,
      runtime: this.session.agentRuntime,
      piSessionFile: this.piSessionFile,
      piSessionId: this.piSessionId,
      messageCount: this.promptCount,
      firstPrompt: this.firstPrompt,
    });
  }

  private applyToState(event: DazeEvent): void {
    if (STAGE_TYPES.has(event.type)) {
      this.currentAction = event;
    }

    switch (event.type) {
      case "agent_start":
        this.setStatus("thinking");
        if (typeof event.payload.model === "string" && event.payload.model) {
          this.session.model = event.payload.model;
        }
        break;

      case "agent_end":
        this.setStatus("listening");
        // The run is over: the Stage returns to its default page.
        this.currentAction = undefined;
        break;

      case "thinking":
        this.setStatus("thinking");
        break;

      case "message": {
        const payload = event.payload;
        // A system message is Daze talking (a command result, a notice), not the
        // agent: it must not flip the avatar to "speaking" or clear the Stage.
        if (payload.role === "system") {
          this.chat.push({
            id: newId("msg"),
            role: "system",
            content: payload.content,
            timestamp: event.timestamp,
          });
          break;
        }
        // Emitting text to the user exits whatever the Stage was showing and
        // puts the agent into "speaking" until the run ends — both when the
        // agent starts talking and when a new run begins.
        this.setStatus("speaking");
        this.currentAction = undefined;
        if (payload.role === "assistant") {
          this.applyAssistantMessage(payload);
        } else if (payload.role === "user") {
          this.promptCount += 1;
          if (this.firstPrompt === undefined) {
            const text = payload.content.trim().replace(/\s+/g, " ");
            this.firstPrompt = text.length > 100 ? `${text.slice(0, 97)}…` : text;
          }
          this.chat.push({
            id: newId("msg"),
            role: "user",
            content: payload.content,
            timestamp: event.timestamp,
          });
        }
        break;
      }

      case "tool_start":
        this.setStatus(statusForTool(event.payload.toolName));
        break;

      // These describe what is currently on the Stage, so they hold the status
      // until the agent moves on. `tool_end` deliberately does NOT reset it:
      // executing a tool takes milliseconds while generating the next step takes
      // seconds, so resetting there would make searching/reading invisible.
      // The status exits when the agent starts emitting text (see "message").
      case "file_read":
        this.setStatus("reading");
        this.upsertFile(event.payload.path, event.payload.content, {
          lastRead: { startLine: event.payload.startLine, endLine: event.payload.endLine },
        });
        break;

      case "file_write":
        this.setStatus("editing");
        this.upsertFile(event.payload.path, event.payload.content, { bump: true });
        break;

      case "file_edit":
        this.setStatus("editing");
        this.upsertFile(event.payload.path, event.payload.after, { bump: true });
        break;

      case "command":
        this.setStatus("running");
        break;

      case "search":
        this.setStatus("searching");
        break;

      case "process":
        // An egg is not an action: it never owns the Stage and never changes the
        // status. It is reported, archived and replayed like any other event.
        break;

      case "file_change":
        this.applyFsChange(event.payload.path, event.payload.kind);
        break;

      case "error":
        this.setStatus("error");
        break;

      default:
        break;
    }
  }

  private applyAssistantMessage(payload: { content: string; streaming?: boolean }): void {
    if (payload.streaming) {
      if (!this.assistantStreamId) {
        const id = newId("msg");
        this.assistantStreamId = id;
        this.chat.push({
          id,
          role: "assistant",
          content: payload.content,
          timestamp: Date.now(),
          streaming: true,
        });
      } else {
        const existing = this.chat.find((m) => m.id === this.assistantStreamId);
        if (existing) {
          existing.content = payload.content;
        }
      }
    } else {
      const id = this.assistantStreamId;
      if (id) {
        const existing = this.chat.find((m) => m.id === id);
        if (existing) {
          existing.content = payload.content;
          existing.streaming = false;
        }
        this.assistantStreamId = undefined;
      } else {
        this.chat.push({
          id: newId("msg"),
          role: "assistant",
          content: payload.content,
          timestamp: Date.now(),
        });
      }
    }
  }

  private upsertFile(
    filePath: string,
    content: string,
    options: { lastRead?: { startLine: number; endLine: number }; bump?: boolean } = {},
  ): void {
    const existing = this.files.get(filePath);
    const version = (existing?.version ?? 0) + (options.bump ? 1 : existing ? 0 : 1);
    this.files.set(filePath, {
      path: filePath,
      content,
      version,
      lastRead: options.lastRead ?? existing?.lastRead,
      lastModified: Date.now(),
    });
  }

  private applyFsChange(rel: string, kind: "created" | "modified" | "deleted"): void {
    if (kind === "deleted") {
      this.files.delete(rel);
    }
    this.scheduleTree();
  }

  private onFsChange(kind: "created" | "modified" | "deleted", absolutePath: string): void {
    const rel = toPosix(path.relative(this.session.projectPath, absolutePath));
    if (!rel || rel.startsWith("..")) return;
    this.handleEvent(createEvent(this.id, "file_change", { path: rel, kind }));
  }

  private setStatus(status: AgentStatus): void {
    this.session.status = status;
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      const usage = this.adapter.getContextUsage?.();
      if (usage) this.context = usage;
      this.stateBus.emit(this.runtimeState());
    }, 40);
  }

  private scheduleTree(): void {
    if (this.treeTimer) return;
    this.treeTimer = setTimeout(() => {
      this.treeTimer = undefined;
      void buildTree(this.session.projectPath).then((tree) => {
        this.tree = tree;
        this.scheduleState();
      });
    }, 500);
  }
}

function statusForTool(toolName: string): AgentStatus {
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

/** Render the `/session` command output as one system chat message. */
function formatSessionStats(stats: SessionStatsInfo): string {
  return [
    `Session ${stats.sessionId}`,
    stats.sessionFile ? `File: ${stats.sessionFile}` : undefined,
    `Messages: ${stats.userMessages} user · ${stats.assistantMessages} assistant · ${stats.toolCalls} tool calls`,
    `Tokens: ${stats.tokens.input} in · ${stats.tokens.output} out · ${stats.tokens.total} total`,
    stats.cost ? `Cost: $${stats.cost.toFixed(4)}` : undefined,
    stats.contextUsed !== undefined && stats.contextTotal
      ? `Context: ${stats.contextUsed}/${stats.contextTotal}`
      : undefined,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

/** In-memory registry of live sessions. */
export class SessionStore {
  private sessions = new Map<string, DazeSession>();

  async create(projectPath: string, kind: AgentKind, resume?: DazeResume): Promise<DazeSession> {
    // Reopening a session that is still live just returns it.
    const resumeId = resume?.dazeSessionId;
    const existing = resumeId !== undefined ? this.sessions.get(resumeId) : undefined;
    if (existing) return existing;
    const session = new DazeSession(projectPath, kind, resume);
    this.sessions.set(session.id, session);
    await session.start();
    return session;
  }

  get(id: string): DazeSession | undefined {
    return this.sessions.get(id);
  }

  list(): DazeSession[] {
    return [...this.sessions.values()];
  }

  async remove(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.dispose();
  }
}

export const sessionStore = new SessionStore();

export { readFileSafe };
