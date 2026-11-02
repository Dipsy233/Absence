import path from "node:path";
import {
  createEvent,
  isAgentBusy,
  isStreamingEvent,
  MAX_SESSION_EVENTS,
  type AgentStatus,
  type ChatMessage,
  type ContextState,
  type AbsenceEvent,
  type FileState,
  type FileTreeNode,
  type MetricsFrame,
  type ObservedRange,
  type Session,
  type SessionRuntimeState,
  type SessionSnapshot,
  type SessionSource,
} from "@absence/core";
import { config, type AgentKind } from "../config";
import {
  appendEvents,
  closeStaleOpenRun,
  drainArchive,
  readEvents,
  readMeta,
  readProcessEvents,
  readEventsPage,
  readRuns,
  writeMeta,
} from "./archive";
import { appendMetricsFrame, drainMetrics } from "./storage/metrics";
import { EventBus } from "../events";
import type { AgentAdapter } from "../agents/AgentAdapter";
import { TerminalMirror } from "./TerminalMirror";
import { SessionLogTail } from "./SessionLogTail";
import { OutsideAttribution } from "./OutsideAttribution";
import { createAdapter } from "../agents/createAdapter";
import { formatAgentCommand } from "../agents/slashCommands";
import { FileWatcher } from "../filesystem/FileWatcher";
import { buildTree, readFileSafe } from "../filesystem/FileTree";
import { ProcessWatcher } from "../process/ProcessWatcher";
import { ProcessMetricsSampler } from "../process/ProcessMetrics";
import { snapshotProcesses } from "../process/ProcessTable";
import { JobMonitor } from "../process/JobMonitor";
import { DockerMonitor } from "../process/DockerMonitor";
import { DockerEggs } from "../process/DockerEggs";
import { unifiedDiff } from "../util/diff";
import { newId } from "../util/ids";
import { toPosix } from "../util/paths";

/**
 * The in-memory event window. Shared with the web client so both trim at the
 * same point — see `MAX_SESSION_EVENTS`. Older events still reach the archive
 * on disk; only the live window is bounded.
 */
const MAX_EVENTS = MAX_SESSION_EVENTS;

/**
 * How many events a snapshot carries. The live window can hold 10k, but sending
 * all of them on every connect/resume is the largest remaining payload. The
 * tail is enough to draw the current run; `eventsBefore` lets the client page
 * backwards through the store (GET /api/sessions/:id/events?before=).
 */
const SNAPSHOT_EVENT_LIMIT = 2_000;

/**
 * How long a path the agent wrote stays attributable. The outside watcher's
 * event for the same file can trail the tool call by the write-finish debounce
 * plus a large file's flush; a couple of minutes covers that without keeping
 * stale attributions alive long enough to catch a neighbour agent's later edit
 * of the same file.
 */
const OUTSIDE_ATTRIBUTION_WINDOW_MS = 120_000;

/** Newline, kept as a constant so multi-line notices read the same on Windows. */
const NL = String.fromCharCode(10);

/**
 * What an observed session says when the UI asks it to do something only the
 * owner of a process can do. One sentence, because it is the same sentence for
 * every action: watch, do not drive.
 */
const OBSERVE_NOTICE =
  "This session only observes: the agent runs in a terminal Absence did not start, so it cannot be prompted, stopped or reconfigured from here.";

/**
 * Thrown when the requested agent runtime cannot start — not installed, the
 * binary path is wrong, or credentials are missing. Carries a message ready for
 * the UI, naming the runtime and the underlying cause, and never falls back to
 * the mock runtime (the user asked for this runtime and should hear why).
 */
export class RuntimeUnavailableError extends Error {
  readonly runtime: string;
  override readonly cause?: unknown;
  constructor(runtime: string, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `${runtime} runtime could not start — check that it is installed and its path is configured. (${detail})`,
    );
    this.name = "RuntimeUnavailableError";
    this.runtime = runtime;
    this.cause = cause;
  }
}

/** Events that own the Stage. */
const STAGE_TYPES = new Set<AbsenceEvent["type"]>([
  "thinking",
  "file_read",
  "file_write",
  "file_edit",
  "command",
  "search",
  "approval",
  "mcp",
  "agent_start",
  "agent_end",
]);

/** Everything needed to reopen a session after it was closed or the server restarted. */
export interface AbsenceResume {
  /** ABSENCE's archive id — its events rebuild the Stage, Activity, files and chat. */
  absenceSessionId?: string;
  /** The agent's opaque ACP resume handle, from the archive of this session. */
  resumeHandle?: string;
  /** The agent's own session id, when it exposes one. */
  runtimeSessionId?: string;
  startedAt?: number;
  /** Dwell time accrued before this visit (see `Session.dwellMs`). */
  dwellMs?: number;
}

/**
 * One open workspace, observed (read.md §24). Live state is in memory; the
 * AbsenceEvent stream is also archived to disk, so a session survives a restart.
 */
export class AbsenceSession {
  readonly id: string;
  readonly bus = new EventBus<AbsenceEvent>();
  readonly stateBus = new EventBus<SessionRuntimeState>();
  /**
   * The agent's terminal output, mirrored. Present only when Absence started
   * the agent under a PTY (see cli.ts `watchCommand`); an agent somebody else
   * started has a terminal we can never see. Deliberately *not* part of the
   * event stream — a redraw would flush the History window in seconds. See
   * TerminalMirror.
   */
  readonly terminal?: TerminalMirror;
  /**
   * Reads the agent's own session transcript and turns the tool calls it
   * records into `mcp` / `tool_start` events.
   *
   * The transcript is the only surface that sees *every* MCP call — stdio, HTTP
   * and in-process alike — because all of them end up written down as a tool
   * call. It needs no change to the agent's config and no proxy in the middle,
   * so observing cannot break what it observes. Present only in observe mode;
   * a driven session gets the same facts from its adapter.
   */
  private transcriptTail?: SessionLogTail;
  readonly session: Session;

  private adapter: AgentAdapter | undefined;
  private watcher?: FileWatcher;
  /** Reports the OS processes the agent lays; Absence owns the shell (v0.3). */
  private processWatcher: ProcessWatcher;
  /** Samples the eggs' CPU/RSS; its frames are streamed beside the events. */
  private readonly metricsSampler: ProcessMetricsSampler;
  private readonly metricsListeners = new Set<(frame: MetricsFrame) => void>();
  /**
   * Container eggs, for the workloads the kernel observers cannot reach (a
   * container lives inside the daemon's VM). Undefined when docker watching is
   * disabled or the machine has no docker — then nothing here changes.
   */
  private dockerEggs?: DockerEggs;
  private unsubDocker?: () => void;
  private unsubAdapter?: () => void;
  private events: AbsenceEvent[] = [];
  private currentAction?: AbsenceEvent;
  private files = new Map<string, FileState>();
  /**
   * Full-file baselines being read from disk after a partial `file_read`.
   * `computeDiskDiff` awaits the one for its path, so a command that changes the
   * file cannot race the baseline and produce a slice-shaped `before`.
   */
  private readonly baselineLoads = new Map<string, Promise<void>>();
  /**
   * Content the agent itself just reported (an explicit `file_edit`/`file_write`),
   * keyed by project-relative path. The filesystem watcher consults this so a
   * shell write (`Set-Content`, `echo >`) is not reported twice when the agent
   * also announced it: whichever arrives first wins, the other is dropped.
   */
  private recentAgentWrites = new Map<string, { content: string; at: number }>();
  /** Paths whose disk diff is being computed right now, so concurrent watcher
   * events for one write cannot both diff against the same stale known content. */
  private diffingFiles = new Set<string>();
  /**
   * Which outside file changes are the agent's own doing (see the class doc):
   * fed by adapter write events when driving, transcript tool calls when
   * observing, consulted by the outside watcher before it reports.
   */
  private outsideAttribution = new OutsideAttribution(OUTSIDE_ATTRIBUTION_WINDOW_MS);
  private chat: ChatMessage[] = [];
  private context?: ContextState;
  private tree?: FileTreeNode;
  /**
   * True when `tree` changed since the last state push. A tree can hold 4000
   * entries; sending it with every 40ms state update is pure waste. New
   * clients still get it in their snapshot; live clients only when it moves.
   */
  private treeDirty = true;
  private assistantStreamId?: string;
  private lastActiveAt: number;
  /** Dwell time accrued before this visit, in ms. */
  private readonly dwellBase: number;
  /** When this visit opened; the live dwell time is `dwellBase` + now - this. */
  private readonly openedAt: number;
  private promptCount = 0;
  private firstPrompt?: string;
  /** The agent's opaque ACP resume handle (session/load or session/resume). */
  private resumeHandle?: string;
  /** The agent's own session id, when it exposes one. */
  private runtimeSessionId?: string;
  private metaTimer?: NodeJS.Timeout;
  private stateTimer?: NodeJS.Timeout;
  private treeTimer?: NodeJS.Timeout;
  private disposed = false;

  /**
   * The agent Absence is only *watching* — somebody else's process tree.
   *
   * Set instead of an adapter (see `createObserved`). Everything that needs a
   * runtime is then unavailable by construction rather than by a guard that
   * someone will forget to add.
   */
  private readonly observe?: { pid: number; label: string; terminal?: TerminalMirror; transcript?: string };

  constructor(
    projectPath: string,
    kind: AgentKind,
    private readonly resume?: AbsenceResume,
    observe?: { pid: number; label: string; terminal?: TerminalMirror; transcript?: string },
  ) {
    this.id = resume?.absenceSessionId ?? newId("sess");
    // Dwell time is accrued across visits: a session reopened later continues
    // the clock instead of restarting it (see `Session.dwellMs`).
    this.dwellBase = Math.max(0, resume?.dwellMs ?? 0);
    this.openedAt = Date.now();
    this.session = {
      id: this.id,
      projectPath,
      projectName: path.basename(projectPath) || projectPath,
      startedAt: resume?.startedAt ?? Date.now(),
      agentRuntime: kind,
      status: "listening",
      dwellMs: this.dwellBase,
      openedAt: this.openedAt,
    };
    this.resumeHandle = resume?.resumeHandle;
    this.runtimeSessionId = resume?.runtimeSessionId;
    // A driven session's egg tree ends at the server process that spawned the
    // agent; an observed one is rooted at the pid it was handed.
    this.observe = observe;
    this.terminal = observe?.terminal;
    this.processWatcher = new ProcessWatcher({
      // In observe mode the agent is somebody else's child, so its subtree is
      // rooted at the agent's pid, not at ours (see ProcessWatcher.rootPid).
      rootPid: observe?.pid,
      onProcess: (payload) => this.handleEvent(createEvent(this.id, "process", payload)),
      // Bound the live egg view: running eggs always stay, only the oldest
      // exits beyond the cap are retired. See ProcessWatcher.retireOverflow.
      maxFinishedEggs: config.maxEggs,
    });
    // Say how precise process watching is, so the UI can be honest about it.
    this.session.processPrecision = JobMonitor.get().available ? "exact" : "sampled";
    // An observed session never gets an adapter: there is no runtime to drive.
    if (!observe) {
      this.adapter = createAdapter(kind, {
        processWatcher: this.processWatcher,
        onStateChange: () => this.scheduleState(),
      });
    }
    // Baseline now: what is already running before the agent starts. The snapshot
    // costs half a second, so it has to be taken here rather than when the first
    // command begins.
    this.processWatcher.warm();
    // Containers the kernel observers cannot see ride the daemon's own event
    // stream. Best effort: a machine with no docker (or with it disabled)
    // simply has no container eggs, and everything else is unchanged. Only
    // containers laid during one of this session's command windows become
    // eggs — the daemon reports every container on the machine, so adopting
    // whatever was already running would show another session's (or the
    // user's own) containers in this one.
    if (config.dockerEnabled) {
      void DockerMonitor.get()
        .start()
        .catch(() => {
          // Status was already reported by the monitor; sessions run without it.
        });
      this.dockerEggs = new DockerEggs(this.processWatcher, (payload) =>
        this.handleEvent(createEvent(this.id, "process", payload)),
      );
      this.unsubDocker = DockerMonitor.get().onContainer((event) => this.dockerEggs?.onContainerEvent(event));
    }
    // Resource metrics ride their own channel: the event window is for facts,
    // not for a process table sampled every two seconds.
    this.metricsSampler = new ProcessMetricsSampler({
      targets: () => [
        this.processWatcher.metricsAgentTarget(),
        ...this.processWatcher.metricsTargets(),
        ...(this.dockerEggs?.metricsTargets() ?? []),
      ],
      extraSamples: this.dockerEggs ? () => this.dockerEggs!.extraSamples() : undefined,
      onFrame: (frame) => {
        appendMetricsFrame(this.id, frame);
        for (const listener of this.metricsListeners) listener(frame);
      },
    });
    this.metricsSampler.start();
    this.lastActiveAt = this.session.startedAt;
  }

  /**
   * Observe mode: no runtime, no prompt surface — just the OS.
   *
   * The process watcher is already rooted at the observed agent's pid, so every
   * process it spawns is reported as its work; the file watcher reports what it
   * writes. That is the whole session. Absence is a viewer here in the literal
   * sense: it never sends the agent a byte.
   */
  private async startObserving(): Promise<void> {
    const target = this.observe!;
    this.setStatus("listening");
    this.session.model = undefined;
    this.tree = await buildTree(this.session.projectPath);
    this.treeDirty = true;
    this.watcher = new FileWatcher(
      this.session.projectPath,
      (kind, abs) => this.onFsChange(kind, abs),
      (kind, abs) => this.onOutsideFsChange(kind, abs),
    );
    await this.watcher.start();

    // The agent's own transcript. This is a poll over a file that only grows
    // when a tool call happens — nothing like enumerating the process table.
    //
    // Why not a proxy on the MCP door: that door is only the stdio spec's
    // `{command, args}`, so it misses HTTP and in-process servers, and it has
    // to be written into the agent's config. The transcript covers all three
    // and leaves the agent untouched.
    const tail = new SessionLogTail(
      this.session.projectPath,
      {
        onCall: (call) => {
          // The transcript is also how an outside file change is attributed:
          // the watched parent directory holds sibling projects, and only a
          // path the agent itself *wrote through a write-semantics tool* may
          // read as this agent's activity (see WRITE_TOOL).
          if (WRITE_TOOL.test(call.toolName)) {
            for (const p of pathsInJson(call.args)) this.outsideAttribution.note(p);
          }
          // A call the model made to a server is an `mcp` event; a built-in
          // tool recorded in the same transcript is a plain `tool_start`.
          if (call.server) {
            this.handleEvent(
              createEvent(this.id, "mcp", {
                server: call.server,
                tool: call.tool,
                toolName: call.toolName,
                toolCallId: call.id,
                args: call.args,
                result: call.result,
                isError: call.isError,
                durationMs: call.durationMs,
              }),
            );
          }
        },
        onSkills: (skills) => {
          // The agent stated which skills it can load. Recording one event per
          // skill turns "what is available" into something the Stage can show
          // happening, without reading the agent's config.
          for (const skill of skills) {
            this.handleEvent(
              createEvent(this.id, "tool_start", {
                toolCallId: `skill:${skill.name}`,
                toolName: "skill",
                args: { name: skill.name, file: skill.filePath, description: skill.description },
              }),
            );
          }
        },
      },
      undefined,
      this.observe?.transcript,
    );
    tail.start();
    this.transcriptTail = tail;
    this.handleEvent(
      createEvent(this.id, "message", {
        role: "system",
        content: `Observing ${target.label} (pid ${target.pid}) in ${this.session.projectPath}. Absence watches what it does — processes, files — and never drives it.`,
        streaming: false,
      }),
    );
    await this.flushMeta();
    this.scheduleState();
  }

  async start(): Promise<void> {
    // Bring ABSENCE's own history back first, so the UI already has the Stage,
    // Activity, files and chat from before the restart.
    const archiveId = this.resume?.absenceSessionId;
    if (archiveId !== undefined) {
      const events = await readEvents(this.session.projectPath, archiveId);
      for (const event of events) this.applyToState(event);
      this.events = events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events;
      // A resumed session is not mid-run: the agent is idle again.
      this.setStatus("listening");
      // …so a run the archive still marks `running` is one whose `agent_end`
      // never arrived (the server died, or the agent was killed). Left alone it
      // stays `running` forever, and `MonitorStage` keeps following work that
      // already stopped — the centre panel sits on the last activity of that run
      // instead of resting on the default page. Close it as interrupted.
      await closeStaleOpenRun(archiveId);
      // Containers this session laid may still be running. The archive already
      // holds their eggs, but the live observer that sampled them died with the
      // old session (or the server); re-attach before the snapshot is served.
      await this.dockerEggs?.restore(events);
    }

    if (this.observe) {
      await this.startObserving();
      return;
    }

    const ctx = {
      sessionId: this.id,
      cwd: this.session.projectPath,
      resumeHandle: this.resumeHandle,
    };
    // No silent fallback: if the requested runtime will not start (not
    // installed, wrong path, missing credentials), the session fails loudly so
    // the user can fix the runtime instead of unknowingly driving a mock.
    // The error propagates to the API, which returns it and the picker shows it.
    try {
      const result = await this.adapter!.start(ctx);
      this.session.model = result.model;
    } catch (error) {
      this.adapter?.dispose();
      this.processWatcher.stop();
      throw new RuntimeUnavailableError(this.session.agentRuntime, error);
    }

    // The adapter may have opened (or created) its own persisted session.
    this.resumeHandle = this.adapter?.getSessionFile?.() ?? this.resumeHandle;
    this.runtimeSessionId = this.adapter?.getRuntimeSessionId?.() ?? this.runtimeSessionId;

    this.unsubAdapter = this.adapter?.subscribe((event) => this.handleEvent(event));

    // An ACP agent can answer `initialize` with auth methods and then refuse
    // `session/new` until `authenticate`. The adapter keeps the connection and
    // reports `authRequired`; this is the one actionable sentence telling the
    // user how to unblock it from the chat.
    const authMethods = this.adapter?.getAuthMethods?.() ?? [];
    if (this.adapter?.isAuthRequired?.() && authMethods.length > 0) {
      const methods = authMethods
        .map((method) => `${method.id} (${method.name})`)
        .join(", ");
      this.handleEvent(
        createEvent(this.id, "message", {
          role: "system",
          content: `Authentication required by ${this.session.agentRuntime}. Methods: ${methods}. Run /auth <methodId> to sign in.`,
          streaming: false,
        }),
      );
    }

    this.tree = await buildTree(this.session.projectPath);
    this.treeDirty = true;

    this.watcher = new FileWatcher(
      this.session.projectPath,
      (kind, abs) => this.onFsChange(kind, abs),
      (kind, abs) => this.onOutsideFsChange(kind, abs),
    );
    await this.watcher.start();

    await this.flushMeta();
    this.scheduleState();
  }

  /** Fire-and-forget: the run streams over the bus, the HTTP call returns at once. */
  prompt(text: string): void {
    // An observed agent is not ours to prompt. Say so in the chat rather than
    // dropping the message on the floor.
    if (!this.adapter) {
      this.handleEvent(createEvent(this.id, "message", { role: "system", content: OBSERVE_NOTICE, streaming: false }));
      return;
    }
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
    // Absence never kills an agent it does not own — not even on abort. Watching
    // is a promise that we leave the thing we watch alone.
    if (!this.adapter) {
      this.handleEvent(createEvent(this.id, "message", { role: "system", content: OBSERVE_NOTICE, streaming: false }));
      return;
    }
    await this.adapter.abort();
  }

  /**
   * Answer an approval prompt the agent raised (see the `approval` event). The
   * decision is one of that event's option values; the adapter unblocks the
   * runtime request. A system notice records the choice in the chat so it is
   * archived with the session.
   */
  async respondApproval(id: string, value: string): Promise<void> {
    if (!this.adapter?.respondApproval) {
      this.handleEvent(
        createEvent(this.id, "message", {
          role: "system",
          content: "This runtime has no approvals to answer.",
          streaming: false,
        }),
      );
      return;
    }
    await this.adapter.respondApproval(id, value);
    this.handleEvent(
      createEvent(this.id, "message", {
        role: "system",
        content: `Approval ${value}.`,
        streaming: false,
      }),
    );
    // The agent is working again; wait for the next event to say what it is.
    this.setStatus("thinking");
    this.scheduleState();
  }

  /**
   * Forward a `/…` line to the agent, verbatim.
   *
   * Absence no longer parses or implements `/model`, `/skill`, `/mcp` or any
   * other product command: the agent owns their meaning. The line is recorded
   * as a user message and sent as a plain prompt, exactly as typed.
   */
  forwardCommand(text: string): void {
    this.prompt(text);
  }

  /**
   * The HTTP command entry point.
   *
   * `/auth` is the one command Absence performs, because signing in is an ACP
   * port action (`authenticate`) rather than a prompt the agent can interpret.
   * Every other `/…` line is forwarded to the agent untouched.
   */
  async runCommand(name: string, args: string): Promise<void> {
    if (!this.adapter) {
      this.handleEvent(createEvent(this.id, "message", { role: "system", content: OBSERVE_NOTICE, streaming: false }));
      return;
    }
    if (name.trim() !== "auth") {
      this.forwardCommand(formatAgentCommand(name, args));
      return;
    }
    const adapter = this.adapter;
    const notice = (content: string): void =>
      this.handleEvent(createEvent(this.id, "message", { role: "system", content, streaming: false }));
    if (!adapter.authenticate) {
      return notice("This runtime does not support ACP authentication.");
    }
    const methods = adapter.getAuthMethods?.() ?? [];
    const methodId = args.trim();
    if (!methodId) {
      const lines = methods.map(
        (method) => `  ${method.id}  ${method.name}${method.description ? ` — ${method.description}` : ""}`,
      );
      return notice(
        lines.length > 0
          ? ["Usage: /auth <methodId>", ...lines].join(NL)
          : "No authentication methods were advertised.",
      );
    }
    try {
      await adapter.authenticate(methodId);
      // The deferred session only exists now; record its id so a later
      // resume can reopen the same agent conversation.
      this.resumeHandle = adapter.getSessionFile?.() ?? this.resumeHandle;
      this.runtimeSessionId = adapter.getRuntimeSessionId?.() ?? this.runtimeSessionId;
      await this.flushMeta();
      this.scheduleState();
      notice(`Authenticated with ${methodId}.`);
    } catch (error) {
      notice(`/auth failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Where this session's events come from — see SessionSource. */
  private source(): SessionSource {
    if (this.observe) {
      return { kind: "observe", targetPid: this.observe.pid, label: this.observe.label };
    }
    return { kind: "runtime", runtime: this.session.agentRuntime };
  }

  history(): AbsenceEvent[] {
    return [...this.events];
  }

  runtimeState(options: { includeTree?: boolean } = {}): SessionRuntimeState {
    // ACP carries the agent's own command list and auth state; Absence never
    // scans an agent's config for capabilities.
    const capabilities = this.adapter?.getCapabilities?.();
    const agentCommands = this.adapter?.getAvailableCommands?.();
    const authMethods = this.adapter?.getAuthMethods?.();
    const authRequired = this.adapter?.isAuthRequired?.() === true;
    const includeTree = options.includeTree ?? true;
    return {
      session: this.session,
      agent: { status: this.session.status, model: this.session.model },
      source: this.source(),
      context: this.context,
      ...(includeTree && this.tree ? { tree: this.tree } : {}),
      ...(capabilities ? { capabilities } : {}),
      ...(agentCommands && agentCommands.length > 0 ? { agentCommands } : {}),
      ...(authMethods && authMethods.length > 0 ? { authMethods } : {}),
      ...(authRequired ? { authRequired } : {}),
    };
  }

  /**
   * A snapshot for the wire: runtime state plus the newest `eventLimit` events.
   *
   * The events come from the store rather than the in-memory window so the
   * response can carry a cursor for older pages. A small/new session (its whole
   * live window fits) is served from memory, which also keeps a streaming
   * message visible on reconnect. The rest is durable history; the UI loads it
   * with `eventsBefore` when the user asks for older Activity.
   */
  async snapshot(options: { eventLimit?: number } = {}): Promise<SessionSnapshot> {
    const limit = Math.min(
      Math.max(Math.trunc(options.eventLimit ?? SNAPSHOT_EVENT_LIMIT), 1),
      SNAPSHOT_EVENT_LIMIT,
    );
    const runs = await readRuns(this.id);
    const processEvents = await readProcessEvents(this.session.projectPath, this.id);
    // Events are only needed while a run is live: History and a settled run's
    // Activity come from the run index. Sending a tail for a finished session
    // would be bytes the client immediately replaces with the selected run.
    const live =
      isAgentBusy(this.session.status) || runs[runs.length - 1]?.status === "running";
    let events: AbsenceEvent[] = [];
    if (live) {
      if (this.events.length < limit) {
        events = [...this.events];
      } else {
        const page = await readEventsPage(this.id, { limit });
        if (page.events.length > 0) {
          events = page.events;
        } else {
          // The store is empty or unavailable (a brand-new session, or a
          // storage failure). Fall back to the live tail.
          events = this.events.slice(-limit);
        }
      }
    }

    return {
      ...this.runtimeState(),
      currentAction: this.currentAction,
      files: [...this.files.values()],
      chat: [...this.chat],
      events,
      processEvents,
      runs,
      metrics: this.metricsSampler.snapshot(),
    };
  }

  /** Live metric frames for a new WebSocket client. */
  onMetrics(listener: (frame: MetricsFrame) => void): () => void {
    this.metricsListeners.add(listener);
    return () => this.metricsListeners.delete(listener);
  }

  /** The dashboard's selected egg gets the 2s cadence back. */
  setMetricsHotEgg(eggPid?: number): void {
    this.metricsSampler.setHotEgg(eggPid);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.metricsSampler.stop();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    if (this.treeTimer) clearTimeout(this.treeTimer);
    if (this.metaTimer) clearTimeout(this.metaTimer);
    // Closing a session Absence *drove* is the one moment its commands are
    // ours to stop. An agent watched from the outside is never touched; a
    // driven agent's subtree is, before the agent itself goes away and its
    // children are reparented. Eggs the agent left behind are reaped too.
    const terminated = await this.processWatcher.terminateCommands(
      this.adapter?.getAgentPid?.(),
    );
    if (terminated > 0) {
      console.log(
        `[absence] session ${this.id}: terminated ${terminated} command process(es) on close`,
      );
    }
    this.processWatcher.stop();
    this.unsubDocker?.();
    this.dockerEggs?.dispose();
    this.unsubAdapter?.();
    this.adapter?.dispose();
    this.terminal?.dispose();
    this.transcriptTail?.dispose();
    await this.watcher?.close();
    await this.flushMeta();
    await drainArchive();
    await drainMetrics();
  }

  // --------------------------------------------------------------------------

  private handleEvent(event: AbsenceEvent): void {
    if (this.disposed) return;
    // Absence's own events (OS watchers, system notices) are not tagged by an
    // adapter. Stamp them too, so every live WS frame and every archived row
    // carries the same `at`/`source`/`fidelity` shape. An unknown origin is
    // reported as `unknown`, never guessed.
    const stamped: AbsenceEvent =
      event.at !== undefined && event.source !== undefined && event.fidelity !== undefined
        ? event
        : {
            ...event,
            at: event.at ?? event.timestamp,
            source: event.source ?? "unknown",
            fidelity: event.fidelity ?? "unknown",
          };
    this.lastActiveAt = stamped.timestamp;
    this.events.push(stamped);
    if (this.events.length > MAX_EVENTS) {
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    this.applyToState(stamped);
    this.bus.emit(stamped);
    this.persist(stamped);
    this.scheduleState();
  }

  /** Used for events Absence itself originates (before the bus exists). */
  private emitInternal(event: AbsenceEvent): void {
    this.events.push(event);
    this.bus.emit(event);
    this.persist(event);
  }

  /** Append to the on-disk archive and refresh its header (best-effort). */
  private persist(event: AbsenceEvent): void {
    // Streaming message/thinking events are the live view of a value that is
    // re-sent in full on every update. Persisting them writes O(n²) bytes for
    // one reply and makes resume replay every prefix. The final non-streaming
    // event carries the whole value, so that is what the archive keeps.
    if (!isStreamingEvent(event)) {
      appendEvents(this.session.projectPath, this.id, [event], {
        observed: this.observe !== undefined,
      });
    }
    this.scheduleMeta();
  }

  private scheduleMeta(): void {
    if (this.metaTimer) return;
    this.metaTimer = setTimeout(() => {
      this.metaTimer = undefined;
      void this.flushMeta();
    }, 800);
  }

  /** Dwell time accrued by this visit so far, in ms. */
  private dwellNow(at = Date.now()): number {
    return this.dwellBase + Math.max(0, at - this.openedAt);
  }

  private async flushMeta(): Promise<void> {
    await writeMeta(this.session.projectPath, {
      version: 1,
      absenceSessionId: this.id,
      projectPath: this.session.projectPath,
      projectName: this.session.projectName,
      startedAt: this.session.startedAt,
      updatedAt: this.lastActiveAt,
      model: this.session.model,
      runtime: this.session.agentRuntime,
      piSessionFile: this.resumeHandle,
      piSessionId: this.runtimeSessionId,
      messageCount: this.promptCount,
      firstPrompt: this.firstPrompt,
      // Persisted while the visit is open so a crash still keeps the clock, not
      // only a clean close.
      dwellMs: this.dwellNow(),
    });
  }

  private applyToState(event: AbsenceEvent): void {
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
        // A system message is Absence talking (a command result, a notice), not the
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

      // An MCP call is an action with an output, like a command: it holds the
      // status until the agent moves on, so "running" stays visible while the
      // server answers.
      case "mcp":
        this.setStatus("running");
        break;

      // These describe what is currently on the Stage, so they hold the status
      // until the agent moves on. `tool_end` deliberately does NOT reset it:
      // executing a tool takes milliseconds while generating the next step takes
      // seconds, so resetting there would make searching/reading invisible.
      // The status exits when the agent starts emitting text (see "message").
      case "file_read":
        this.setStatus("reading");
        this.applyFileRead(event.payload);
        break;

      case "file_write":
        this.setStatus("editing");
        this.noteAgentWrite(event.payload.path, event.payload.content);
        this.upsertFile(event.payload.path, event.payload.content, { bump: true });
        break;

      case "file_edit":
        this.setStatus("editing");
        // A runtime that reports a patch without a diff (Codex's `fileChange`
        // carries paths, not hunks) still gets a real diff here, computed
        // against what Absence last knew. This runs before the bus emits, so
        // subscribers receive the enriched event.
        if (!event.payload.diff) {
          const previous = this.files.get(event.payload.path)?.content;
          if (previous !== undefined && previous !== event.payload.after) {
            event.payload.diff = unifiedDiff(previous, event.payload.after, event.payload.path, event.payload.path);
          } else if (event.payload.before) {
            event.payload.diff = unifiedDiff(event.payload.before, event.payload.after, event.payload.path, event.payload.path);
          }
        }
        // A snippet-only edit is real, but its `after` is not the whole file.
        // Storing it would make the next disk diff look like a second edit and
        // would claim file content the agent never sent.
        if (event.payload.fullContent !== false) {
          this.noteAgentWrite(event.payload.path, event.payload.after);
          this.upsertFile(event.payload.path, event.payload.after, { bump: true });
        }
        break;

      case "command":
        this.setStatus("running");
        break;

      case "search":
        this.setStatus("searching");
        break;

      case "approval":
        // A pending approval is the agent waiting on the user: nothing else is
        // happening until one of the card's options is chosen.
        this.setStatus("waiting");
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

  /**
   * A read is evidence about a *range*, not the whole file. Store it in
   * `observedRanges` and leave `content` alone; when no whole-file baseline
   * exists, read one from disk so a later command's diff has an honest `before`.
   */
  private applyFileRead(payload: {
    path: string;
    content: string;
    startLine?: number;
    endLine?: number;
    rangeKnown?: boolean;
  }): void {
    const existing = this.files.get(payload.path);
    const state: FileState = existing ?? {
      path: payload.path,
      content: "",
      version: 0,
    };
    const range = {
      ...(payload.startLine !== undefined ? { startLine: payload.startLine } : {}),
      ...(payload.endLine !== undefined ? { endLine: payload.endLine } : {}),
      content: payload.content,
      ...(payload.rangeKnown !== undefined ? { rangeKnown: payload.rangeKnown } : {}),
    };
    state.lastRead = {
      ...(payload.startLine !== undefined ? { startLine: payload.startLine } : {}),
      ...(payload.endLine !== undefined ? { endLine: payload.endLine } : {}),
      ...(payload.rangeKnown !== undefined ? { rangeKnown: payload.rangeKnown } : {}),
    };
    state.observedRanges = mergeObservedRange(state.observedRanges, range);
    state.lastModified = Date.now();
    this.files.set(payload.path, state);
    if (state.content.length === 0 && !this.baselineLoads.has(payload.path)) {
      this.baselineLoads.set(payload.path, this.loadBaseline(payload.path));
    }
  }

  /**
   * Cache the full file from disk without claiming the agent read it. This is
   * the OS baseline for the next diff; the agent's own evidence stays in
   * `observedRanges`.
   */
  private async loadBaseline(filePath: string): Promise<void> {
    try {
      const absolute = path.isAbsolute(filePath) ? filePath : path.join(this.session.projectPath, filePath);
      const content = await readFileSafe(absolute);
      const state = this.files.get(filePath);
      // A write/edit may have landed while the read was in flight; never
      // overwrite content the agent itself supplied.
      if (state && content !== null && state.content.length === 0) {
        state.content = content;
      }
    } finally {
      this.baselineLoads.delete(filePath);
    }
  }

  private upsertFile(
    filePath: string,
    content: string,
    options: {
      lastRead?: { startLine?: number; endLine?: number; rangeKnown?: boolean };
      bump?: boolean;
    } = {},
  ): void {
    const existing = this.files.get(filePath);
    const version = options.bump ? (existing?.version ?? 0) + 1 : existing?.version ?? 0;
    this.files.set(filePath, {
      path: filePath,
      content,
      version,
      lastRead: options.lastRead ?? existing?.lastRead,
      observedRanges: existing?.observedRanges,
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
    void this.handleFsChange(rel, kind);
  }

  /**
   * One OS change, judged against what the agent already reported. The
   * `file_change` is always emitted (it is real OS evidence); when its content
   * matches a tool call Absence already recorded, it is marked `echo` and the
   * second, redundant diff is skipped.
   */
  private async handleFsChange(
    rel: string,
    kind: "created" | "modified" | "deleted",
  ): Promise<void> {
    const absolute = path.join(this.session.projectPath, rel);
    const content = kind === "deleted" ? null : await readFileSafe(absolute);
    const reported = this.recentAgentWrites.get(rel);
    const echo = content !== null && reported !== undefined && reported.content === content;
    this.handleEvent(
      createEvent(this.id, "file_change", {
        path: rel,
        kind,
        ...(echo ? { echo: true as const } : {}),
      }),
    );
    if (kind === "deleted" || echo) {
      if (echo) this.recentAgentWrites.delete(rel);
      return;
    }
    // The watcher is what turns a shell write into a diff: Codex has no Write
    // action in its command parse (`Set-Content`, `echo > file`, a sed in a
    // pipeline are all `Unknown`), so without this a file changed by a command
    // would show only as "file touch" and never as a diff on the Stage.
    void this.diffFromDisk(rel);
  }

  /**
   * Read a project file back from disk and, when its content differs from what
   * Absence last knew, emit the `file_write`/`file_edit` that a runtime with a
   * first-class write tool would have sent directly.
   *
   * This is how a file changed by a shell command reaches the Stage: the diff is
   * computed here instead of being declared by the agent. It is skipped when the
   * change is one the agent already reported (see `recentAgentWrites`), so a
   * Codex `apply_patch` or Pi's edit tool is not counted twice.
   */
  private async diffFromDisk(rel: string): Promise<void> {
    if (this.diffingFiles.has(rel)) return;
    this.diffingFiles.add(rel);
    try {
      await this.computeDiskDiff(rel);
    } finally {
      this.diffingFiles.delete(rel);
    }
  }

  private async computeDiskDiff(rel: string): Promise<void> {
    // A partial read starts a full-file baseline asynchronously. Wait for it
    // before comparing: otherwise the command's change can win the race and
    // the diff's `before` is the slice the agent read, not the previous file.
    const baseline = this.baselineLoads.get(rel);
    if (baseline) await baseline;
    const absolute = path.join(this.session.projectPath, rel);
    const content = await readFileSafe(absolute);
    // Binary, gone, or unreadable: the `file_change` above already told the
    // story; not every file has a text diff to show.
    if (content === null) return;

    const known = this.files.get(rel);
    if (known?.content === content) return;

    // The agent announced this exact write, and the watcher just arrived after
    // it: the agent's own event already carried the change, so drop the echo.
    const reported = this.recentAgentWrites.get(rel);
    if (reported && reported.content === content) {
      this.recentAgentWrites.delete(rel);
      return;
    }

    if (known === undefined) {
      this.handleEvent(createEvent(this.id, "file_write", { path: rel, content }));
      return;
    }
    this.handleEvent(
      createEvent(this.id, "file_edit", {
        path: rel,
        before: known.content,
        after: content,
        diff: unifiedDiff(known.content, content, rel, rel),
      }),
    );
  }

  /**
   * Remember a write the agent reported directly, so the watcher does not
   * report it a second time, and so an outside change on the same file can be
   * attributed to the agent. Old entries are pruned so the maps cannot grow
   * without bound over a long session.
   */
  private noteAgentWrite(rel: string, content: string): void {
    const at = Date.now();
    this.recentAgentWrites.set(rel, { content, at });
    if (this.recentAgentWrites.size > 64) {
      for (const [key, value] of this.recentAgentWrites) {
        if (at - value.at > 10_000) this.recentAgentWrites.delete(key);
      }
    }
    // The write tool accepts absolute paths, so a reported path may itself be
    // outside the project — exactly the case the outside watcher must confirm
    // against the attribution map rather than assume.
    const absolute = path.isAbsolute(rel) ? rel : path.join(this.session.projectPath, rel);
    this.outsideAttribution.note(absolute, at);
  }

  /**
   * A change outside the project. Only the agent's own writes can be reported
   * as its doing: the watched parent directory holds sibling projects whose
   * agents write all the time, and an unattributed echo of *their* work in
   * this session's Activity is a lie about what this agent did. A change on a
   * path the agent recently wrote through a tool is the agent's echo — report
   * it. Anything else is somebody else's work, and Absence stays silent: the
   * run row already shows whatever command or call carried the write.
   */
  private onOutsideFsChange(kind: "created" | "modified" | "deleted", absolutePath: string): void {
    if (!this.outsideAttribution.owns(absolutePath)) return;
    // Spend the attribution: this echo is the record. What the same path does
    // for the rest of the window is no longer provably this agent's — most
    // plausibly a sibling agent writing the same shared file.
    this.outsideAttribution.demote(absolutePath);
    this.handleEvent(
      createEvent(this.id, "file_change", { path: toPosix(absolutePath), kind, outside: true }),
    );
  }

  private setStatus(status: AgentStatus): void {
    this.session.status = status;
  }

  private scheduleState(): void {
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = undefined;
      const usage = this.adapter?.getContextUsage?.();
      if (usage) this.context = usage;
      const includeTree = this.treeDirty;
      this.treeDirty = false;
      this.stateBus.emit(this.runtimeState({ includeTree }));
    }, 40);
  }

  private scheduleTree(): void {
    if (this.treeTimer) return;
    this.treeTimer = setTimeout(() => {
      this.treeTimer = undefined;
      void buildTree(this.session.projectPath).then((tree) => {
        this.tree = tree;
        this.treeDirty = true;
        this.scheduleState();
      });
    }, 500);
  }
}

/** Keep the agent's observed ranges without letting a long run grow forever. */
function mergeObservedRange(
  existing: ObservedRange[] | undefined,
  next: ObservedRange,
): ObservedRange[] {
  const list = [...(existing ?? [])];
  const index = list.findIndex(
    (range) =>
      range.startLine === next.startLine &&
      range.endLine === next.endLine &&
      (range.rangeKnown ?? true) === (next.rangeKnown ?? true),
  );
  if (index >= 0) list[index] = next;
  else list.push(next);
  return list.slice(-50);
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

/**
 * The executable name for a pid, or undefined when it is gone.
 *
 * Used only to label an observed session. A missing pid is not an error the
 * caller has to interpret: it is the agent having already finished.
 */
async function describeProcess(pid: number): Promise<{ name: string } | undefined> {
  const table = await snapshotProcesses();
  const info = table.get(pid);
  if (!info) return undefined;
  return { name: info.name };
}

/** In-memory registry of live sessions. */
export class SessionStore {
  private sessions = new Map<string, AbsenceSession>();

  /**
   * Open a session that only *watches* an agent somebody else started.
   *
   * This is the decoupled end of Absence: no adapter, no runtime version to
   * match, no skills or MCP config to read. The agent's pid is the root of the
   * process tree Absence reports, and the project directory is what it watches
   * for file changes. Every agent is observable this way — see
   * docs/decoupling.md.
   */
  async createObserved(
    projectPath: string,
    pid: number,
    label?: string,
    terminal?: TerminalMirror,
    transcript?: string,
  ): Promise<AbsenceSession> {
    const target = await describeProcess(pid);
    if (!target) {
      throw new Error(`No process with pid ${pid} — it may already have exited.`);
    }
    const session = new AbsenceSession(
      projectPath,
      "observe" as unknown as AgentKind,
      undefined,
      { pid, label: label?.trim() || target.name, terminal, transcript },
    );
    this.sessions.set(session.id, session);
    try {
      await session.start();
    } catch (error) {
      this.sessions.delete(session.id);
      throw error;
    }
    return session;
  }

  async create(projectPath: string, kind: AgentKind, resume?: AbsenceResume): Promise<AbsenceSession> {
    // Reopening a session that is still live just returns it.
    const resumeId = resume?.absenceSessionId;
    const existing = resumeId !== undefined ? this.sessions.get(resumeId) : undefined;
    if (existing) return existing;
    // A reopen continues the archive's own clock: the original creation time and
    // the dwell time already accrued. The opaque ACP resume handle is also read
    // from the archive, so a client resuming by id alone can reconnect the
    // agent's conversation without naming any agent-private file.
    const restored = resumeId !== undefined ? await readMeta("", resumeId) : undefined;
    const session = new AbsenceSession(projectPath, kind, {
      ...resume,
      resumeHandle: resume?.resumeHandle ?? restored?.piSessionFile,
      runtimeSessionId: resume?.runtimeSessionId ?? restored?.piSessionId,
      startedAt: resume?.startedAt ?? restored?.startedAt,
      dwellMs: resume?.dwellMs ?? restored?.dwellMs,
    });
    this.sessions.set(session.id, session);
    try {
      await session.start();
    } catch (error) {
      // The runtime would not start: drop the half-built session so it does not
      // linger in the store, and let the API report the failure to the picker.
      this.sessions.delete(session.id);
      throw error;
    }
    return session;
  }

  get(id: string): AbsenceSession | undefined {
    return this.sessions.get(id);
  }

  list(): AbsenceSession[] {
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

/**
 * Tools whose semantics are writing a file. Only these may make an outside
 * file change attributable: their arguments name the paths they target. The
 * first cut of this rule was a *blacklist* of read-ish tools, and it leaked:
 * `bash` sat outside the list, so a `bash cat E:/other/x.txt` — a read —
 * attributed the path, and the sibling agent's later write of that file read
 * as this agent's outside change. A whitelist is the honest polarity: an MCP
 * tool with unknown semantics, a shell command whose effect on files is not
 * proven, none of them earn attribution. A shell write outside the project is
 * still visible in its run row; it just cannot claim the watcher's echo.
 */
export const WRITE_TOOL =
  /^(write|edit|multiedit|apply_patch|patch|save|create|remove|delete|unlink|move|rename|str_replace|insert|notebook_edit)\b/i;

/**
 * Absolute paths in a write tool's arguments JSON — but only where paths live.
 *
 * Write tools name their targets in different fields per runtime (`path`,
 * `file_path`, a changes map, a patch body), so the shape is not pinned;
 * instead a string is scanned only when its *key* is path-shaped (path, file,
 * dir, patch, diff, changes, target, source, dest…) or when an object's key is
 * itself an absolute path (the `changes` map). Everything else — a written
 * file's `content`, an edit's `oldText`, a shell `command` — is skipped on
 * purpose: a config that *mentions* other absolute paths must not attribute
 * them, or the next write by whoever owns those paths reads as this agent's.
 *
 * Relative paths are skipped: the outside watcher only reports absolute paths
 * outside the project, and a relative argument cannot be one.
 */
export function pathsInJson(json: string): string[] {
  if (!json) return [];
  const found: string[] = [];
  const PATHY_KEY = /(path|file|dir|folder|target|source|src|dest|patch|diff|changes|location)/i;
  const ABSOLUTE = /[A-Za-z]:[\\/][^\s"'`\]}]*|(?:\/[^\s"'`\]}]{2,})+/g;
  const consider = (candidate: string): void => {
    // A URL is not a filesystem path (`https://host/x`), and the unix branch
    // happily matches the tail of one.
    if (candidate.includes("://")) return;
    // A unix path must have a directory separator beyond the leading slash,
    // so a bare word or a URL's `//` does not match.
    if (/^[A-Za-z]:/.test(candidate) || candidate.split("/").length > 2) found.push(candidate);
  };
  const scan = (text: string): void => {
    for (const match of text.matchAll(ABSOLUTE)) consider(match[0]);
  };
  const walk = (value: unknown, key: string, depth: number): void => {
    if (depth > 6) return;
    if (typeof value === "string") {
      // The value's own key decides whether its strings can hold a target. A
      // patch body is included whole: the target sits after `*** Update
      // File:` inside it, and `patch` is a pathy key.
      if (PATHY_KEY.test(key)) scan(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key, depth + 1);
      return;
    }
    if (value && typeof value === "object") {
      for (const [childKey, item] of Object.entries(value)) {
        // A key that is itself an absolute path is a file the tool targets —
        // Codex's `changes` map is keyed by path.
        scan(childKey);
        walk(item, childKey, depth + 1);
      }
    }
  };
  try {
    walk(JSON.parse(json), "", 0);
  } catch {
    // Unparseable arguments name no paths we can trust.
  }
  return found;
}
