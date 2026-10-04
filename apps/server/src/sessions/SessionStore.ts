import path from "node:path";
import {
  createEvent,
  type AgentStatus,
  type ChatMessage,
  type ContextState,
  type DazeEvent,
  type FileState,
  type FileTreeNode,
  type Plan,
  type Session,
  type SessionRuntimeState,
  type SessionSnapshot,
} from "@daze/core";
import { config, type AgentKind } from "../config";
import { EventBus } from "../events";
import type { AgentAdapter } from "../agents/AgentAdapter";
import { createAdapter } from "../agents/createAdapter";
import { MockAdapter } from "../agents/MockAdapter";
import { FileWatcher } from "../filesystem/FileWatcher";
import { buildTree, readFileSafe } from "../filesystem/FileTree";
import { readPlan } from "../filesystem/readPlan";
import { newId } from "../util/ids";
import { toPosix } from "../util/paths";

const MAX_EVENTS = 1000;

/** Events that own the Stage. */
const STAGE_TYPES = new Set<DazeEvent["type"]>([
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "search",
  "agent_start",
  "agent_end",
]);

/** One open workspace, observed (read.md §24). Lives only in memory. */
export class DazeSession {
  readonly id: string;
  readonly bus = new EventBus<DazeEvent>();
  readonly stateBus = new EventBus<SessionRuntimeState>();
  readonly session: Session;

  private adapter: AgentAdapter;
  private watcher?: FileWatcher;
  private unsubAdapter?: () => void;
  private events: DazeEvent[] = [];
  private currentAction?: DazeEvent;
  private files = new Map<string, FileState>();
  private chat: ChatMessage[] = [];
  private context?: ContextState;
  private plan?: Plan;
  private tree?: FileTreeNode;
  private assistantStreamId?: string;
  private stateTimer?: NodeJS.Timeout;
  private treeTimer?: NodeJS.Timeout;
  private disposed = false;

  constructor(projectPath: string, kind: AgentKind) {
    this.id = newId("sess");
    this.session = {
      id: this.id,
      projectPath,
      projectName: path.basename(projectPath) || projectPath,
      startedAt: Date.now(),
      agentRuntime: kind,
      status: "idle",
    };
    this.adapter = createAdapter(kind, { tools: config.piTools });
  }

  async start(): Promise<void> {
    const ctx = { sessionId: this.id, cwd: this.session.projectPath };
    try {
      const result = await this.adapter.start(ctx);
      this.session.model = result.model;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.adapter = new MockAdapter();
      const result = await this.adapter.start(ctx);
      this.session.model = result.model;
      this.session.agentRuntime = "mock";
      this.session.degraded = true;
      this.emitInternal(
        createEvent(this.id, "error", { message: `Pi runtime unavailable, using mock: ${message}` }),
      );
    }

    this.unsubAdapter = this.adapter.subscribe((event) => this.handleEvent(event));

    this.tree = await buildTree(this.session.projectPath);
    this.plan = await readPlan(this.session.projectPath);

    this.watcher = new FileWatcher(this.session.projectPath, (kind, abs) => this.onFsChange(kind, abs));
    this.watcher.start();

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

  history(): DazeEvent[] {
    return [...this.events];
  }

  runtimeState(): SessionRuntimeState {
    return {
      session: this.session,
      agent: { status: this.session.status, model: this.session.model },
      context: this.context,
      plan: this.plan,
      tree: this.tree,
    };
  }

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
    this.unsubAdapter?.();
    this.adapter.dispose();
    await this.watcher?.close();
  }

  // --------------------------------------------------------------------------

  private handleEvent(event: DazeEvent): void {
    if (this.disposed) return;
    this.events.push(event);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.applyToState(event);
    this.bus.emit(event);
    this.scheduleState();
  }

  /** Used for events Daze itself originates (before the bus exists). */
  private emitInternal(event: DazeEvent): void {
    this.events.push(event);
    this.bus.emit(event);
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
        this.setStatus("completed");
        break;

      case "thinking":
        this.setStatus("thinking");
        break;

      case "message":
        // The agent is composing or streaming a reply.
        this.setStatus("thinking");
        if (event.payload.role === "assistant") {
          this.applyAssistantMessage(event.payload);
        } else if (event.payload.role === "user") {
          this.chat.push({
            id: newId("msg"),
            role: "user",
            content: event.payload.content,
            timestamp: event.timestamp,
          });
        }
        break;

      case "tool_start":
        this.setStatus(statusForTool(event.payload.toolName));
        break;

      // The tool is done, so the agent is back to thinking about its result.
      // The file_*/command/search events are only the visual of a tool that has
      // already ended, so they deliberately do not touch the status.
      case "tool_end":
        this.setStatus("thinking");
        break;

      case "file_read":
        this.upsertFile(event.payload.path, event.payload.content, {
          lastRead: { startLine: event.payload.startLine, endLine: event.payload.endLine },
        });
        break;

      case "file_write":
        this.upsertFile(event.payload.path, event.payload.content, { bump: true });
        break;

      case "file_edit":
        this.upsertFile(event.payload.path, event.payload.after, { bump: true });
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

/** In-memory registry of live sessions. */
export class SessionStore {
  private sessions = new Map<string, DazeSession>();

  async create(projectPath: string, kind: AgentKind): Promise<DazeSession> {
    const session = new DazeSession(projectPath, kind);
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
