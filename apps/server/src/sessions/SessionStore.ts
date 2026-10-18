import path from "node:path";
import {
  createEvent,
  MAX_SESSION_EVENTS,
  type AgentStatus,
  type CapabilityState,
  type ChatMessage,
  type CommandOption,
  type ContextState,
  type AbsenceEvent,
  type FileState,
  type FileTreeNode,
  type Session,
  type SessionRuntimeState,
  type SessionSnapshot,
  type SessionSource,
  type SessionStatsInfo,
} from "@absence/core";
import { config, type AgentKind } from "../config";
import { appendEvents, drainArchive, readEvents, writeMeta } from "./archive";
import { EventBus } from "../events";
import type { AgentAdapter } from "../agents/AgentAdapter";
import { TerminalMirror } from "./TerminalMirror";
import { SessionLogTail } from "./SessionLogTail";
import { createAdapter } from "../agents/createAdapter";
import { FileWatcher } from "../filesystem/FileWatcher";
import { buildTree, readFileSafe } from "../filesystem/FileTree";
import { ProcessWatcher } from "../process/ProcessWatcher";
import { snapshotProcesses } from "../process/ProcessTable";
import { JobMonitor } from "../process/JobMonitor";
import { unifiedDiff } from "../util/diff";
import { newId } from "../util/ids";
import { toPosix } from "../util/paths";
import { discoverCapabilities } from "../capabilities/discover";
import { capabilityPaths } from "../capabilities/manage";

/**
 * The in-memory event window. Shared with the web client so both trim at the
 * same point — see `MAX_SESSION_EVENTS`. Older events still reach the archive
 * on disk; only the live window is bounded.
 */
const MAX_EVENTS = MAX_SESSION_EVENTS;

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
  /** Pi's session file — reopens the model's conversation. */
  piSessionFile?: string;
  piSessionId?: string;
  startedAt?: number;
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
  private unsubAdapter?: () => void;
  private events: AbsenceEvent[] = [];
  private currentAction?: AbsenceEvent;
  private files = new Map<string, FileState>();
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
      this.adapter = createAdapter(kind, { tools: config.piTools, processWatcher: this.processWatcher });
    }
    // Baseline now: what is already running before the agent starts. The snapshot
    // costs half a second, so it has to be taken here rather than when the first
    // command begins.
    this.processWatcher.warm();
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
    this.watcher = new FileWatcher(
      this.session.projectPath,
      (kind, abs) => this.onFsChange(kind, abs),
      (kind, abs) => this.onOutsideFsChange(kind, abs),
    );
    this.watcher.start();

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
    }

    if (this.observe) {
      await this.startObserving();
      return;
    }

    const ctx = {
      sessionId: this.id,
      cwd: this.session.projectPath,
      sessionFile: this.piSessionFile,
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

    // The adapter may have opened (or created) its own persisted session file.
    this.piSessionFile = this.adapter?.getSessionFile?.() ?? this.piSessionFile;
    this.piSessionId = this.adapter?.getRuntimeSessionId?.() ?? this.piSessionId;

    this.unsubAdapter = this.adapter?.subscribe((event) => this.handleEvent(event));

    this.tree = await buildTree(this.session.projectPath);

    this.watcher = new FileWatcher(
      this.session.projectPath,
      (kind, abs) => this.onFsChange(kind, abs),
      (kind, abs) => this.onOutsideFsChange(kind, abs),
    );
    this.watcher.start();

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

  /** Choice lists for the commands that need one (the palette's submenu). */
  async commandOptions(name: string): Promise<CommandOption[]> {
    // An observed agent's model list, thinking levels and MCP servers live in
    // *its* process, which Absence has no handle on. The palette stays empty
    // rather than showing stale configuration Absence read off disk.
    if (!this.adapter) return [];
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
      case "permission": {
        const permission = this.adapter.getPermission?.();
        if (!permission) return [];
        return permission.available.map((level) => ({
          value: level,
          label: level,
          description: PERMISSION_DESCRIPTIONS[level],
          active: level === permission.level,
        }));
      }
      // `/skill <name>` and `/mcp <action> [server]` complete from what the
      // session actually has, so the palette lists real skills and servers.
      case "skill":
        return this.discoveredSkills().map((skill) => ({
          value: skill.name,
          label: skill.name,
          description: `${skill.scope} · ${skill.description}`.slice(0, 120),
        }));
      case "mcp":
        return [
          { value: "list", label: "list", description: "servers and whether they connected" },
          { value: "reconnect", label: "reconnect", description: "reconnect a server in this session" },
        ];
      default:
        return [];
    }
  }

  /** Skills found on disk for this project (shared by the command surface). */
  private discoveredSkills() {
    return discoverCapabilities({ cwd: this.session.projectPath }).skills;
  }

  /**
   * Run a terminal-box command (`/model …`). Output is emitted as a system
   * `message` event so it reaches the chat, persists to the archive and comes
   * back on resume — the HTTP call itself only reports that it ran.
   */
  async runCommand(name: string, args: string): Promise<void> {
    const adapter = this.adapter;
    if (!adapter) {
      this.handleEvent(createEvent(this.id, "message", { role: "system", content: OBSERVE_NOTICE, streaming: false }));
      return;
    }
    const notice = (content: string): void =>
      this.handleEvent(createEvent(this.id, "message", { role: "system", content, streaming: false }));
    // `/skill <name>` prompts the agent, so it counts as mutating too — but a
    // bare `/skill` only lists, and `/mcp` is allowed while a run is going,
    // because someone watching a stuck run needs to see why a server is not
    // answering.
    const mutating =
      name === "model" ||
      name === "thinking" ||
      name === "compact" ||
      name === "permission" ||
      (name === "skill" && (this.adapter?.getCapabilities?.()?.skills ?? []).some((skill) =>
        skill.name.toLowerCase() === args.trim().split(/\s+/)[0]?.toLowerCase(),
      ));
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
        case "permission": {
          if (!adapter.getPermission || !adapter.setPermission) {
            return notice("This runtime has no permission setting.");
          }
          const level = args.trim();
          if (!level) {
            const current = adapter.getPermission();
            return notice(`Permission: ${current.level}. Options: ${current.available.join(", ")}.`);
          }
          const applied = await adapter.setPermission(level);
          notice(`Permission set to ${applied}. New turns run with it; the approvals card reflects it.`);
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
        case "skill":
          notice(await this.runSkillCommand(args));
          break;
        case "mcp":
          notice(await this.runMcpCommand(args));
          break;
        default:
          notice(`Unknown command: /${name}`);
      }
    } catch (error) {
      notice(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * `/skill` — the skills the session can load, and how to use them.
   *
   * Pi expands `/skill:<name> [args]` into the skill's instructions before the
   * prompt reaches the model, so `/skill` here is the discovery half: it prints
   * what exists and the exact line to type. `/skill <name>` narrows the list.
   */
  private async runSkillCommand(args: string): Promise<string> {
    const skills = this.discoveredSkills();
    if (skills.length === 0) {
      return [
        "No skills found. A skill is a folder with a SKILL.md; Absence looks in",
        "  ~/.agents/skills  ~/.pi/agent/skills  ~/.codex/skills  ~/.dsh/skills",
        `  ${this.session.projectPath}/.agents/skills  ${this.session.projectPath}/.pi/skills`,
        "Drop one there and run /skill again.",
      ].join(NL);
    }
    const query = args.trim().toLowerCase();
    // `/skill <name> [request]` is an invocation, not a filter: hand the skill
    // to the runtime the way Pi and Codex do, as `/skill:<name> request`.
    const exact = skills.find((skill) => skill.name.toLowerCase() === query.split(/\s+/)[0]);
    if (exact) {
      const request = args.trim().slice(exact.name.length).trim();
      const line = `/skill:${exact.name}${request ? ` ${request}` : ""}`;
      await this.adapter?.prompt(line);
      return `Loaded skill "${exact.name}"${request ? ` with: ${request}` : ""}.`;
    }
    const shown = query ? skills.filter((skill) => skill.name.toLowerCase().includes(query)) : skills;
    if (shown.length === 0) {
      return `No skill matches "${args.trim()}". Known: ${skills.map((skill) => skill.name).join(", ")}`;
    }
    const first = shown[0]!.name;
    const lines = shown.map((skill) => {
      const where = skill.scope === "project" ? "project" : "user";
      return `  ${skill.name}  (${where})\n      ${skill.description}`;
    });
    const header = query
      ? `Skill "${first}" — load it with:`
      : `${skills.length} skill${skills.length === 1 ? "" : "s"} — load one with:`;
    const usage = query ? `  /skill:${first} [request]` : `  /skill:<name> [request]   — e.g. /skill:${first}`;
    return [header, usage, "", ...lines].join(NL);
  }

  /**
   * `/mcp` — the MCP command surface, shaped like Pi's own `/mcp`:
   *
   *   /mcp                     list servers: state, tools, exposure, errors
   *   /mcp reconnect [server]  reconnect one in this session
   *   /mcp enable|disable <s>  flip `enabled` in mcp.json
   *   /mcp add <name> -- <cmd> [args…]   add a stdio server
   *   /mcp add <name> --url <url>        add an HTTP server
   *   /mcp remove <name>                 remove it from mcp.json
   *
   * Reconnecting is Absence asking the runtime to re-read its MCP state: the
   * transport belongs to the runtime, so Absence reloads the session and
   * reports the state that follows instead of pretending to dial.
   */
  private async runMcpCommand(args: string): Promise<string> {
    const [action, ...rest] = args.trim().split(/\s+/).filter(Boolean);

    // Session-scoped only, matching Pi's own `/mcp` (login / logout / reconnect).
    // Adding, removing, enabling or disabling a server edits the shared
    // `mcp.json`, which every runtime deliberately keeps outside the session —
    // use `pi mcp add …`, `codex mcp add …`, or edit the file; `/mcp reconnect`
    // then applies it here.
    const usage = [
      "Usage:",
      "  /mcp                     list servers and their state",
      "  /mcp reconnect [server]  reconnect in this session",
      "",
      "Adding or removing a server is a config change, not a session action:",
      "  pi mcp add <name> -- <command> [args…]      (or: codex mcp add …)",
      `  then edit ${capabilityPaths(this.session.projectPath).mcpConfig} directly,`,
      "  and run /mcp reconnect to apply it.",
    ].join(NL);

    if (action === undefined || action === "list") return this.formatMcpStatus();

    if (action === "reconnect") {
      const name = rest[0];
      const before = this.mcpStatusFor(name);
      if (before === undefined) {
        return name ? `No MCP server named "${name}".` : "No enabled MCP server to reconnect.";
      }
      await this.reloadExtensions();
      const after = this.mcpStatusFor(before.name);
      return after === undefined
        ? `Server "${before.name}" is no longer configured.`
        : `Reconnected "${before.name}": ${describeMcpState(after)}`;
    }

    return usage;
  }

  /** One server's live state from the adapter, or undefined when absent. */
  private mcpStatusFor(name?: string): CapabilityState["mcp"][number] | undefined {
    const servers = this.adapter?.getCapabilities?.()?.mcp ?? [];
    if (name) return servers.find((server) => server.name === name);
    return servers.find((server) => server.enabled);
  }

  /**
   * Apply mcp.json / skill edits to the running session. A runtime that can
   * reload its extensions does so (Pi re-reads mcp.json on `session.reload()`);
   * otherwise the edit still applies to the next session.
   */
  private async reloadExtensions(): Promise<void> {
    const adapter = this.adapter as (AgentAdapter & { reloadExtensions?(): Promise<void> }) | undefined;
    if (adapter?.reloadExtensions) await adapter.reloadExtensions();
  }

  /** `/mcp` with no arguments: the list, in Pi's own wording. */
  private formatMcpStatus(): string {
    const state = this.adapter?.getCapabilities?.();
    if (!state) return OBSERVE_NOTICE;
    if (state.mcp.length === 0) {
      return [
        "No MCP servers configured. Add one outside the session, as every runtime expects:",
        "  pi mcp add <name> -- <command> [args…]",
        "  codex mcp add <name> --url <https://…>",
        `or edit ${capabilityPaths(this.session.projectPath).mcpConfig}`,
        "then run /mcp reconnect here to pick it up.",
      ].join(NL);
    }
    const lines = state.mcp.map((server) => `${server.name}: ${describeMcpState(server)}`);
    for (const diagnostic of state.diagnostics.slice(0, 5)) {
      lines.push(`config warning: ${diagnostic.message}${diagnostic.path ? ` (${diagnostic.path})` : ""}`);
    }
    return lines.join(NL);
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

  runtimeState(): SessionRuntimeState {
    // Asked per push, not cached: an MCP tool appears when its server
    // connects, which happens after the session started (see
    // capabilities/piResources.ts). Absence re-reads the runtime's own list
    // rather than guessing when it changed.
    const capabilities = this.adapter?.getCapabilities?.();
    return {
      session: this.session,
      agent: { status: this.session.status, model: this.session.model },
      source: this.source(),
      context: this.context,
      tree: this.tree,
      ...(capabilities ? { capabilities } : {}),
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
    this.adapter?.dispose();
    this.terminal?.dispose();
    this.transcriptTail?.dispose();
    await this.watcher?.close();
    await this.flushMeta();
    await drainArchive();
  }

  // --------------------------------------------------------------------------

  private handleEvent(event: AbsenceEvent): void {
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

  /** Used for events Absence itself originates (before the bus exists). */
  private emitInternal(event: AbsenceEvent): void {
    this.events.push(event);
    this.bus.emit(event);
    this.persist(event);
  }

  /** Append to the on-disk archive and refresh its header (best-effort). */
  private persist(event: AbsenceEvent): void {
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
      absenceSessionId: this.id,
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
        this.upsertFile(event.payload.path, event.payload.content, {
          lastRead: { startLine: event.payload.startLine, endLine: event.payload.endLine },
        });
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
        this.noteAgentWrite(event.payload.path, event.payload.after);
        this.upsertFile(event.payload.path, event.payload.after, { bump: true });
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
   * report it a second time. Old entries are pruned so the map cannot grow
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
  }

  /** A change outside the project — rare, and always worth reporting. */
  private onOutsideFsChange(kind: "created" | "modified" | "deleted", absolutePath: string): void {
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

/** One-line explanations for the sandbox levels in the `/permission` palette. */
const PERMISSION_DESCRIPTIONS: Record<string, string> = {
  "read-only": "the agent may read but never write",
  "workspace-write": "the agent may edit inside the project",
  "danger-full-access": "no sandbox — the agent may touch anything",
};

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
    const session = new AbsenceSession(projectPath, kind, resume);
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

/** One MCP server as `/mcp` reads it: state, tools, exposure, reason. */
function describeMcpState(server: CapabilityState["mcp"][number]): string {
  if (!server.enabled) return "disabled";
  if (server.connected === undefined) return server.exposure ? `configured (${server.exposure})` : "configured";
  if (!server.connected) return "not connected, reconnects on next call";
  const tools =
    server.toolCount !== undefined ? `, ${server.toolCount} tool${server.toolCount === 1 ? "" : "s"}` : "";
  const exposure = server.exposure ? ` (${server.exposure})` : "";
  const indirect = server.declared === false ? " — reachable via codemode/tool_search" : "";
  return `connected${tools}${exposure}${indirect}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
