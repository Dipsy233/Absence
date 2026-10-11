import type { ProcessPayload } from "@absence/core";
import { parseCommandIntent, type CommandIntent } from "./CommandIntent";
import { classifyProcess } from "./classify";
import { isTransparentLauncher } from "./priors";
import { JobMonitor } from "./JobMonitor";
import type { WatchExit, WatchStart } from "./observer";
import { snapshotProcesses, type ProcessTable, type ProcInfo } from "./ProcessTable";
import { unwrapCommandText } from "./CodexShell";

/** How long after a command returns we take the final look. */
const SETTLE_MS = 2500;

/**
 * How often we look *while* a command is still running.
 *
 * Looking only after a command was a real hole: `timeout 20 bash daemon.sh`, or
 * plain `npm run dev`, keeps a process alive for as long as the tool call lasts —
 * by the time the command returned there was nothing left to see.
 *
 * A snapshot costs ~0.5s (one CIM enumeration of every process on Windows), and
 * that cost is the floor: nothing can be sampled more often than it takes to
 * look. A process that lives three seconds and is killed inside the command is
 * only caught because a sample lands *inside* those three seconds, so the early
 * part of a command — where a command's processes are born — is sampled tightly,
 * and a long-running command is then sampled slowly, because anything it laid is
 * long-lived and any sample will do.
 */
const TICK_FAST_MS = 1100;
const TICK_SLOW_MS = 4000;
const TICK_FAST_WINDOW_MS = 8000;

/** How often a running egg is re-checked for still being alive. */
const ALIVE_TICK_MS = 5000;

/**
 * How far before a command a process may have started and still count. Shells
 * and job runners spawn a hair before the tool call is timestamped.
 */
const WINDOW_SLACK_MS = 1500;

/**
 * How long after a command returns it may still be laying eggs. `npm run dev &`
 * returns the moment the shell forks, and the real process appears a little
 * later — so "when the tool returned" is not the end of the window. The next
 * command's start is; this is only the fallback when there is no next command.
 */
const POST_SLACK_MS = 2500;

/** Windows console plumbing: given to console processes, never an egg. */
const CONSOLE_HOSTS = new Set(["conhost.exe", "openconsole.exe", "windowsterminal.exe", "wt.exe"]);

/**
 * How long after a command returns an event may still belong to it. Only used in
 * Job mode, where events arrive with their real timestamp rather than being
 * sampled: a shell that backgrounds a daemon returns before the daemon appears,
 * and the next command's start is the true end of this one — this is the
 * fallback when there is no next command.
 */
const JOB_POST_SLACK_MS = 2500;

/**
 * How far before a command's start an event may carry and still belong to it.
 * The kernel stamps the process, the shell reaches `begin` a moment later.
 */
const JOB_PRE_SLACK_MS = 1500;

/** A command's window: everything it could possibly have started. */
export interface ProcessWindow {
  /** Epoch ms the command started. */
  from: number;
  /** Epoch ms it stopped being responsible — the next command's start. */
  to: number;
}

/** A command in flight, or one whose evidence is still being gathered. */
interface CommandWindow {
  command: string;
  startedAt: number;
  endedAt?: number;
  /** When the *next* command began: the true end of this one's window. */
  closedAt?: number;
  /** Parsed intent of the command, for classifying what it laid. */
  intent: CommandIntent;
  /** Working directory the command ran in. */
  cwd: string;
}

interface Egg {
  info: ProcInfo;
  command: string;
  startedAt: number;
  children: number;
  status: "running" | "exited";
  exitedAt?: number;
  /** Primary (worth tracking) or tool (a short-lived helper, folded in the UI). */
  kind: "primary" | "tool";
  /** Why classify() reached that verdict, for the UI's tooltip. */
  kindReason?: string;
  /** Working directory of the command that laid it, for provenance checks. */
  cwd: string;
  /** The full image path the observer resolved, for provenance checks. */
  exePath?: string;
  /** The intent of the command that laid it, for re-classification on exit. */
  intent: CommandIntent;
  /** The shell pid Absence drove the command through, when known. */
  shellPid?: number;
  /** The command a young tool belongs to; promoted to primary on survival. */
  reclassifyOnSurvive: boolean;
  /** True once this egg has outlived the command that laid it. */
  survivedCommand: boolean;
  /** True when the command named it as a subject: never demoted on exit. */
  namedSubject: boolean;
}

export interface ProcessWatcherOptions {
  /** Every egg state change, ready to become a `process` AbsenceEvent. */
  onProcess: (payload: ProcessPayload) => void;
  /**
   * The process every egg descends from. Defaults to the server itself, which
   * is where Pi — and therefore every tool — runs in-process.
   */
  rootPid?: number;
  /** Injectable for tests. */
  snapshot?: () => Promise<ProcessTable>;
  now?: () => number;
}

/**
 * Watches the OS for processes the agent creates (read.md §6, v0.3).
 *
 * An egg is a process the agent started that Absence has not seen before — a dev
 * server, a watcher, a daemon script. Its status says what became of it, which
 * is exactly what the panel's `running` / `dead` tabs are for; a process that
 * lived and died inside one long command is still something the agent created,
 * and it is reported as it is seen, then marked `exited` when it goes.
 *
 * The agent's shell is Absence's own (see AbsenceShell), so Absence knows when every
 * command starts and finishes — that window is the evidence. Snapshots are never
 * taken on the agent's path: `begin` is free, and the sampling happens while the
 * command runs and after it has returned, off to the side.
 *
 * Eggs are reported at the root of each new subtree, because one `npm run dev`
 * is one egg and not the nine processes it turns into. Absence never kills
 * anything: it reports what the agent started, and notices when it dies.
 */
export class ProcessWatcher {
  private readonly rootPid: number;
  private readonly snapshot: () => Promise<ProcessTable>;
  private readonly now: () => number;
  private readonly eggs = new Map<number, Egg>();
  /** Every pid we have ever claimed — a re-parented child must still read as ours. */
  private readonly seen = new Set<number>();
  /**
   * Markers Absence put at the head of the commands it drove (see AbsenceShell). Any
   * process carrying one is plumbing — the shell and its launcher — never an egg.
   */
  private readonly markers = new Set<string>();
  private readonly open = new Map<number, CommandWindow>();
  /** Windows whose evidence is still being gathered. */
  private readonly pending: CommandWindow[] = [];
  /**
   * What was already running when the session opened (its first command): the
   * observer's own process, and whatever its runtime spawned to start up. Never
   * an egg, whatever the window says.
   */
  private baseline?: ProcessTable;
  private baselinePromise?: Promise<void>;
  private settleQueue: Promise<void> = Promise.resolve();
  private inFlight?: Promise<ProcessTable>;
  private tickTimer?: ReturnType<typeof setTimeout>;
  private aliveTimer?: ReturnType<typeof setTimeout>;
  private nextId = 0;
  private disposed = false;

  /**
   * The kernel event stream, when the Job Object observer is available. In this
   * mode there is no sampling at all: every creation and exit arrives as it
   * happens, so a 20 ms process is seen like any other. The polling fields above
   * stay unused.
   */
  private jobUnsubscribe?: () => void;
  /** Commands whose wall-clock window is still open, keyed by `begin` id. */
  private readonly jobOpen = new Map<
    number,
    { command: string; startedAt: number; endedAt?: number; intent: CommandIntent; cwd: string }
  >();
  /** A command that has returned but whose late events still belong to it. */
  private jobLastClosed?: { command: string; endedAt: number; intent: CommandIntent; cwd: string };
  /**
   * pid → the root pid of the egg it was folded into. A child appearing after
   * its parent is not a second egg; it is the same subtree.
   */
  private readonly jobParent = new Map<number, number>();
  /** Every pid the kernel has reported, so a repeated start is not a second egg. */
  private readonly jobSeen = new Set<number>();
  /**
   * pid → the command line last seen for it. On Linux a process can `exec` in
   * place: `nohup node ticker.mjs` reports once as `nohup` and once as `node`
   * under the *same* pid. A pid alone therefore cannot mean "already handled" —
   * only a repeated (pid, command line) pair does.
   */
  private readonly jobExec = new Map<number, string>();
  /** The working directory commands run in; set by the shell wrapper. */
  private jobCwd = process.cwd();
  /**
   * The Absence session the observed runtime belongs to, when the runtime's
   * shell environment carries `ABSENCE_SESSION_ID` (Windows does, through the
   * Job-Object observer's PEB read; the Linux eBPF observer reports no marker).
   * Set by `beginSession`. Used only to *exclude* — a process carrying a
   * different session's marker is meant to be ignored — never as a requirement.
   */
  private jobSessionId?: string;

  constructor(private readonly options: ProcessWatcherOptions) {
    this.rootPid = options.rootPid ?? process.pid;
    this.snapshot = options.snapshot ?? snapshotProcesses;
    this.now = options.now ?? Date.now;
    this.attachJobObserver();
  }

  /**
   * Subscribe to the kernel's process events, when the Job Object observer is
   * running. This is the whole precision story: nothing to poll, nothing to
   * miss. When it is not available the watcher falls back to snapshots.
   */
  private attachJobObserver(): void {
    const monitor = JobMonitor.get();
    if (!monitor.available && monitor.status === "unavailable") {
      // The helper did not start (missing binary, no rights). Stay on polling.
      return;
    }
    this.jobUnsubscribe = monitor.observe((event) => this.onJobEvent(event));
  }

  /** True while events, rather than snapshots, drive this watcher. */
  private get jobMode(): boolean {
    return this.jobUnsubscribe !== undefined;
  }

  /**
   * Take the session baseline: what is already running before the agent has done
   * anything. Called when the session opens, so the snapshot (half a second) has
   * landed long before the first command.
   */
  warm(): void {
    void this.ensureBaseline();
  }

  /** Absence put this marker at the head of a command it drove. */
  noteMarker(marker: string): void {
    this.markers.add(marker);
  }

  /**
   * Declare which Absence session the observed runtime belongs to. Start events
   * whose environment carries a *different* `ABSENCE_SESSION_ID` are then known
   * to be another session's and are ignored. Observations without a marker — all
   * of Linux, where the eBPF observer reports none — are unaffected.
   */
  beginSession(sessionId: string): void {
    this.jobSessionId = sessionId;
  }

  /**
   * A shell command is about to run. Deliberately cheap: taking a snapshot here
   * would add the cost of it to every command the agent runs. All we keep is
   * *when* it started, and that it closes whatever window was still open — two
   * commands a second apart must not both claim the same new process.
   */
  begin(command: string, cwd?: string, startedAtMs?: number): number {
    const at = startedAtMs && startedAtMs < this.now() ? startedAtMs : this.now();
    if (cwd) this.jobCwd = cwd;
    for (const earlier of this.open.values()) earlier.closedAt ??= at;
    for (const window of this.pending) window.closedAt ??= at;
    const id = (this.nextId += 1);
    if (this.jobMode) {
      // Close the previous command's tail: an event that arrives from now on
      // belongs to this command, not the one before it.
      if (this.jobLastClosed) this.jobLastClosed = undefined;
      this.jobOpen.set(id, {
        command,
        startedAt: at,
        intent: parseCommandIntent(command),
        cwd: this.jobCwd,
      });
      return id;
    }
    this.open.set(id, {
      command,
      startedAt: at,
      intent: parseCommandIntent(command),
      cwd: this.jobCwd,
    });
    this.startTick();
    return id;
  }

  /** The command has finished. Returns immediately; the evidence arrives later. */
  end(id: number): void {
    if (this.jobMode) {
      const entry = this.jobOpen.get(id);
      this.jobOpen.delete(id);
      if (entry) this.jobLastClosed = { ...entry, endedAt: this.now() };
      // Everything still alive when the command returned has survived it: that
      // is a daemon, whatever its name. Promote it before the next command's
      // window opens or it will be filed as a tool forever.
      this.promoteSurvivors();
      return;
    }
    const entry = this.open.get(id);
    this.open.delete(id);
    if (entry === undefined || this.disposed) return;
    const window: CommandWindow = { ...entry, endedAt: this.now() };
    this.pending.push(window);
    // Serialised: a burst of commands must not race the same delta.
    this.settleQueue = this.settleQueue
      .then(() => this.settle(window))
      .catch(() => undefined)
      .finally(() => {
        const index = this.pending.indexOf(window);
        if (index >= 0) this.pending.splice(index, 1);
      });
  }

  /** Stop watching. Never touches the processes themselves. */
  stop(): void {
    this.disposed = true;
    if (this.tickTimer !== undefined) clearTimeout(this.tickTimer);
    if (this.aliveTimer !== undefined) clearTimeout(this.aliveTimer);
    this.tickTimer = undefined;
    this.aliveTimer = undefined;
    this.open.clear();
    this.jobOpen.clear();
    this.jobExec.clear();
    this.jobUnsubscribe?.();
    this.jobUnsubscribe = undefined;
  }

  /** Look while a command is still running. */
  private startTick(after = TICK_FAST_MS): void {
    if (this.tickTimer !== undefined || this.disposed) return;
    this.tickTimer = setTimeout(() => void this.tick(), after);
  }

  private async tick(): Promise<void> {
    this.tickTimer = undefined;
    if (this.disposed) return;
    const running = [...this.open.values()].sort((a, b) => a.startedAt - b.startedAt)[0];
    if (!running) return; // the command finished; the settle takes over
    const age = this.now() - running.startedAt;
    const table = await this.table();
    if (this.disposed) return;
    this.adopt(
      table,
      { from: running.startedAt - WINDOW_SLACK_MS, to: this.now() },
      running.command,
      running.intent,
      running.cwd,
    );
    this.startTick(age < TICK_FAST_WINDOW_MS ? TICK_FAST_MS : TICK_SLOW_MS);
  }

  private async settle(window: CommandWindow): Promise<void> {
    await this.ensureBaseline();
    await delay(SETTLE_MS);
    if (this.disposed) return;
    const table = await this.table();
    if (this.disposed) return;
    this.adopt(
      table,
      {
        from: window.startedAt - WINDOW_SLACK_MS,
        to: window.closedAt ?? (window.endedAt ?? 0) + POST_SLACK_MS,
      },
      window.command,
      window.intent,
      window.cwd,
    );
  }

  /** The heart of it: which of these processes are eggs we have not seen yet. */
  private adopt(
    table: ProcessTable,
    window: ProcessWindow,
    command: string,
    intent: CommandIntent,
    cwd: string,
  ): void {
    const candidates = candidatePids(this.baseline, table, this.seen, window);
    const { roots, children, claimed } = attributeProcesses(
      table,
      candidates,
      this.seen,
      this.rootPid,
      this.markers,
    );
    for (const pid of claimed) this.seen.add(pid);
    if (roots.length === 0) return;

    const at = this.now();
    let laid = false;
    for (const root of roots) {
      if (this.eggs.has(root.pid)) continue;
      const verdict = classifyProcess({
        name: root.name,
        commandLine: root.commandLine,
        cwd,
        intent,
        // A snapshot taken after a command settles is the one place polling can
        // tell survival: what is alive now outlived the command.
        survivedCommand: true,
        ageMs: 0,
        children: children.get(root.pid) ?? 0,
        ppid: root.ppid,
      });
      const egg: Egg = {
        info: root,
        command,
        // The OS's own start time reads better than "when we first noticed".
        startedAt: root.startedAt > 0 ? root.startedAt : at,
        children: children.get(root.pid) ?? 0,
        status: "running",
        kind: verdict.kind,
        kindReason: verdict.reason,
        cwd,
        intent,
        reclassifyOnSurvive: false,
        survivedCommand: true,
        namedSubject: verdict.reason === "named by the command",
      };
      this.eggs.set(root.pid, egg);
      this.emit(egg);
      laid = true;
    }
    if (laid) this.startAliveTick();
  }

  /**
   * One kernel event. The Job Object observer reports every creation and exit as
   * it happens, so this is where an egg is recognized — no sampling, no window
   * heuristic, no chance of a short-lived process slipping through.
   *
   * Attribution is by ancestry, not by timing: the server is the root, and an
   * event belongs to the agent when its ancestor chain reaches a pid the kernel
   * already reported as ours. The command window only decides *which command*
   * gets the credit, and is generous about backgrounded daemons.
   */
  private onJobEvent(event: WatchStart | WatchExit): void {
    if (this.disposed) return;
    if (isExit(event)) this.onJobExit(event);
    else this.onJobStart(event);
  }

  private onJobStart(event: WatchStart): void {
    const pid = event.pid;
    if (pid === this.rootPid) return;
    if (isConsoleHost(nameOf(event))) return;

    // A pid that has already reported this exact command line is a duplicate of
    // an event already handled. The same pid with a *different* command line is
    // a re-exec — `nohup` turning into `node` — and must be judged afresh.
    const line = event.commandLine ?? event.exePath ?? "";
    if (this.jobExec.get(pid) === line && this.jobSeen.has(pid)) return;
    this.jobExec.set(pid, line);

    if (this.hasMarker(event.commandLine)) {
      // Absence's own shell (or the launcher around it): plumbing, never an egg.
      // Remembered so its descendants still read as ours, but deliberately NOT
      // registered as a parent egg: the shell only forwards the command, so its
      // children are the roots of the subtrees we actually report.
      this.jobSeen.add(pid);
      return;
    }

    // Session attribution. When a runtime's shell carries `ABSENCE_SESSION_ID`,
    // the kernel reports it and a process belonging to a *different* session is
    // none of our business — the one thing the marker is used for here. It is
    // deliberately not a *requirement*: the Linux observer (eBPF) reports no
    // marker at all, and the shell wrapper is a comment on the command line
    // rather than an environment variable, so an unmarked process is judged by
    // the window and its ancestry below, exactly as it always was for Pi. When
    // Codex delegates execution (see CodexExecServer) every command is Absence's
    // own child, so that ancestry is complete.
    const session = this.sessionVerdict(event);
    if (session === "foreign") {
      this.jobSeen.add(pid);
      return;
    }

    const window = this.commandFor(event.createdAt);
    if (window === undefined) {
      // Outside any command window. An env-marked process is still the
      // runtime's shell tree (a detached daemon, most likely), so it is
      // remembered but not reported — it has no command to be credited to.
      // Unmarked, it is infrastructure the server itself spawns (update
      // checks, git, tooling): remembered for the same reason.
      this.jobSeen.add(pid);
      return;
    }

    // A descendant of an egg we already reported is folded into it. A descendant
    // of our own shell is not: the shell is transparent, so the child is a new
    // root and becomes the egg. A pid that re-execs into something else is a new
    // root too, so it must not still be listed as a child of its old parent.
    const parentEgg = this.jobParent.get(event.ppid);
    if (parentEgg !== undefined && parentEgg !== pid) {
      this.jobParent.set(pid, parentEgg);
      this.jobSeen.add(pid);
      const egg = this.eggs.get(parentEgg);
      if (egg) {
        egg.children += 1;
        // A child that itself spawns processes marks its tree as a scheduler.
        if (egg.kind === "tool") {
          egg.kind = "primary";
          egg.kindReason = "spawns its own processes";
          egg.reclassifyOnSurvive = false;
        }
        this.emit(egg);
      }
      return;
    }

    const name = nameOf(event);

    // A transparent launcher (`nohup`, `setsid`, `time`, `env`) is not the
    // process the agent laid — the child it starts is. Mark it ours so its whole
    // subtree stays attributed, but do not register it as a root: the child that
    // arrives next has no parent egg and becomes the root itself, so the panel
    // shows `node ticker.mjs` rather than `nohup.exe`. When the launcher execs
    // into the real process, that second event arrives under the same pid and is
    // judged here as a root.
    if (isTransparentLauncher(name)) {
      this.jobSeen.add(pid);
      return;
    }

    // A new root: a subtree the agent just laid. Classify it now, when it is
    // young; `end()` promotes it again if it outlives its command.
    this.jobSeen.add(pid);
    this.jobParent.set(pid, pid);
    const verdict = classifyProcess({
      name,
      commandLine: event.commandLine ?? "",
      exePath: event.exePath,
      cwd: window.cwd,
      intent: window.intent,
      survivedCommand: false,
      ageMs: 0,
      children: 0,
      ppid: event.ppid,
    });
    const egg: Egg = {
      info: {
        pid,
        ppid: event.ppid,
        name,
        commandLine: event.commandLine ?? "",
        startedAt: event.createdAt ?? this.now(),
      },
      command: window.command,
      startedAt: event.createdAt ?? this.now(),
      children: 0,
      status: "running",
      kind: verdict.kind,
      kindReason: verdict.reason,
      cwd: window.cwd,
      exePath: event.exePath,
      intent: window.intent,
      reclassifyOnSurvive: verdict.kind === "tool",
      survivedCommand: false,
      namedSubject: verdict.reason === "named by the command",
    };
    this.eggs.set(pid, egg);
    this.emit(egg);
  }

  private onJobExit(event: WatchExit): void {
    this.jobSeen.delete(event.pid);
    this.jobParent.delete(event.pid);
    this.jobExec.delete(event.pid);
    const egg = this.eggs.get(event.pid);
    if (!egg) return;
    egg.status = "exited";
    egg.exitedAt = event.exitedAt;
    // Re-run the classifier now that the process has a real lifetime. A tool
    // that lived far longer than a tool should, or that ended up with children,
    // is promoted. A process that was only provisionally a primary — an unknown
    // name classified before its lifetime was known — is demoted if it turned
    // out ephemeral. A named subject or a survivor is never demoted: those were
    // decided by something stronger than a lifetime.
    const verdict = classifyProcess({
      name: egg.info.name,
      commandLine: egg.info.commandLine,
      exePath: egg.exePath,
      cwd: egg.cwd,
      intent: egg.intent,
      survivedCommand: egg.survivedCommand,
      ageMs: event.exitedAt - egg.startedAt,
      children: egg.children,
      ppid: egg.info.ppid,
    });
    if (!egg.survivedCommand && !egg.namedSubject) {
      egg.kind = verdict.kind;
      egg.kindReason = verdict.reason;
    } else if (verdict.kind === "primary" && egg.kind === "tool") {
      egg.kind = verdict.kind;
      egg.kindReason = verdict.reason;
    }
    this.emit(egg);
  }

  /**
   * Everything still running when a command returned survived that command.
   * That is the definitive signal for a daemon — stronger than any name, path or
   * timing rule — so promote it now.
   */
  private promoteSurvivors(): void {
    for (const egg of this.eggs.values()) {
      if (egg.status !== "running") continue;
      // Whatever it is, it is alive after the command returned: it survived.
      egg.survivedCommand = true;
      if (egg.kind === "primary") continue;
      egg.kind = "primary";
      egg.kindReason = "outlived its command";
      egg.reclassifyOnSurvive = false;
      this.emit(egg);
    }
  }

  /** The command a process started at `at` belongs to, if any. */
  private commandFor(
    at: number | undefined,
  ): { command: string; intent: CommandIntent; cwd: string } | undefined {
    const when = at ?? this.now();
    // A command still running owns everything since a moment before it began.
    for (const entry of this.jobOpen.values()) {
      if (when >= entry.startedAt - JOB_PRE_SLACK_MS) {
        return { command: entry.command, intent: entry.intent, cwd: entry.cwd };
      }
    }
    // A command that has returned still owns a backgrounded daemon's late start,
    // but only until the next command begins.
    const last = this.jobLastClosed;
    if (last && when <= last.endedAt + JOB_POST_SLACK_MS) {
      return { command: last.command, intent: last.intent, cwd: last.cwd };
    }
    return undefined;
  }

  private hasMarker(commandLine: string | undefined): boolean {
    if (!commandLine || this.markers.size === 0) return false;
    for (const marker of this.markers) if (commandLine.includes(marker)) return true;
    return false;
  }

  /**
   * Whether a kernel event belongs to this Absence session, judged by the
   * `ABSENCE_SESSION_ID` the runtime injected into its shell environment.
   *
   *   - "ours"     — the marker matches `beginSession`; the runtime laid it.
   *   - "foreign"  — the marker is a *different* session's; not ours to report.
   *   - "unmarked" — no marker was reported. In session mode (Codex) that is
   *                  the server's own infrastructure; outside it, the older
   *                  heuristics (ancestry, the command window) still decide.
   */
  private sessionVerdict(event: WatchStart): "ours" | "foreign" | "unmarked" {
    if (this.jobSessionId === undefined) return "unmarked";
    const marker = event.absenceSessionId;
    if (marker === undefined) return "unmarked";
    return marker === this.jobSessionId ? "ours" : "foreign";
  }

  private async checkAlive(): Promise<void> {
    this.aliveTimer = undefined;
    if (this.disposed) return;
    const table = await this.table();
    if (this.disposed) return;

    const at = this.now();
    let live = 0;
    for (const egg of this.eggs.values()) {
      if (egg.status === "exited") continue;
      if (table.has(egg.info.pid)) {
        live += 1;
        continue;
      }
      egg.status = "exited";
      egg.exitedAt = at;
      this.emit(egg);
    }
    if (live > 0) this.startAliveTick();
  }

  private startAliveTick(): void {
    if (this.aliveTimer !== undefined || this.disposed) return;
    this.aliveTimer = setTimeout(() => void this.checkAlive(), ALIVE_TICK_MS);
  }

  private emit(egg: Egg): void {
    this.options.onProcess({
      pid: egg.info.pid,
      ppid: egg.info.ppid,
      name: egg.info.name,
      // The reported command line is the human-facing one: for a command Codex
      // wrapped in a shell (`pwsh -NoProfile -Command "<preamble>node x"`) this
      // is the model's own command, so the egg panel shows what was asked for,
      // not the plumbing. Matching and classification used the raw line already.
      commandLine: unwrapCommandText(egg.info.commandLine),
      status: egg.status,
      startedAt: egg.startedAt,
      exitedAt: egg.exitedAt,
      children: egg.children,
      command: egg.command,
      kind: egg.kind,
      kindReason: egg.kindReason,
    });
  }

  /** What was already running when the session opened — never an egg. */
  private async ensureBaseline(): Promise<void> {
    this.baselinePromise ??= (async () => {
      this.baseline = await this.table();
    })();
    await this.baselinePromise;
  }

  /** One snapshot at a time: a burst of commands must not spawn a burst of `ps`. */
  private table(): Promise<ProcessTable> {
    this.inFlight ??= this.snapshot().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }
}

/**
 * The processes worth looking at: alive in this snapshot, not already known to
 * Absence, and started inside the command's window.
 *
 * The start time is what makes this precise, and it is authoritative when the OS
 * reports it: a `sleep` from the user's own terminal — or the child of the next
 * command, or of the previous one, whose late snapshot already saw it — can never
 * be mistaken for this command's work. Without a start time (a platform that
 * cannot say, reported as 0) the baseline is the only evidence left, and the rule
 * falls back to "new since the session opened".
 *
 * Note the baseline is consulted *only* on that fallback: it is a snapshot, and a
 * snapshot costs half a second, so one taken when a command begins lands after
 * the command has already spawned things — excluding on it would hide exactly the
 * processes Absence is looking for.
 */
export function candidatePids(
  baseline: ProcessTable | undefined,
  settled: ProcessTable,
  seen: ReadonlySet<number>,
  window?: ProcessWindow,
): number[] {
  const pids: number[] = [];
  for (const info of settled.values()) {
    if (seen.has(info.pid)) continue;
    if (window && info.startedAt > 0) {
      if (info.startedAt < window.from) continue;
      if (window.to > 0 && info.startedAt > window.to) continue;
    } else if (baseline?.has(info.pid)) {
      continue;
    }
    pids.push(info.pid);
  }
  return pids;
}

/**
 * Out of `candidates`, the processes that are new eggs, collapsed to the root of
 * each new subtree with a count of the descendants rolled into it.
 *
 * Three things are never new eggs, and each was a real false positive:
 *  - a console host (`conhost.exe`), which Windows attaches to any console process;
 *  - the shell Absence drove the command through, and the launcher around it —
 *    recognised by the marker Absence put at the head of the command, so a shell the
 *    agent started *itself* (`bash daemon.sh`) is reported like anything else;
 *  - anything under an egg we already reported: `npm` is the egg, the `node` it
 *    spawns a second later is its child, not a second egg.
 *
 * A candidate is ours when its ancestor chain reaches the server, or an ancestor
 * is already ours (a reported egg, or one of our marked shells). An orphan whose
 * parent is unknown is *not* ours: claiming every orphan swept in unrelated
 * `sleep`s from elsewhere on the machine, and a process that needs them to be
 * attributed is one Absence cannot honestly pin on the agent.
 */
export function attributeProcesses(
  table: ProcessTable,
  candidates: number[],
  known: ReadonlySet<number>,
  rootPid: number,
  markers: ReadonlySet<string> = new Set(),
): { roots: ProcInfo[]; children: Map<number, number>; claimed: number[] } {
  const isOurs = (pid: number): boolean => {
    const visited = new Set<number>();
    let current = pid;
    while (current > 0 && !visited.has(current)) {
      // Our own shell (marked) is an ancestor we own, even once it is gone.
      if (current === rootPid || known.has(current) || hasMarker(table.get(current), markers)) return true;
      visited.add(current);
      const info = table.get(current);
      if (!info) return false;
      current = info.ppid;
    }
    return false;
  };

  const eligible = candidates.filter((pid) => {
    // The observer is never an egg: on a freshly started server its own process
    // is young enough to fall inside the first command's window, and it would
    // then swallow everything the command spawned as children.
    if (pid === rootPid) return false;
    const info = table.get(pid);
    if (isConsoleHost(info?.name ?? "")) return false;
    if (hasMarker(info, markers)) return false;
    return !hasAncestorIn(table, pid, known);
  });

  const claimed = eligible.filter(isOurs);
  const claimedSet = new Set(claimed);

  // The root of a subtree is its highest member; the rest are its children.
  const roots = claimed
    .map((pid) => table.get(pid))
    .filter((info): info is ProcInfo => info !== undefined)
    .filter((info) => !hasAncestorIn(table, info.ppid, claimedSet));

  const children = new Map<number, number>();
  for (const root of roots) children.set(root.pid, countDescendants(table, root.pid, claimedSet));
  return { roots, children, claimed };
}

/** True for the console hosts Windows gives console processes. */
export function isConsoleHost(name: string): boolean {
  return CONSOLE_HOSTS.has(name.toLowerCase());
}

/** True when this process carries one of the markers Absence put on its own commands. */
function hasMarker(info: ProcInfo | undefined, markers: ReadonlySet<string>): boolean {
  if (!info || markers.size === 0) return false;
  for (const marker of markers) {
    if (info.commandLine.includes(marker)) return true;
  }
  return false;
}

function hasAncestorIn(table: ProcessTable, pid: number, pids: ReadonlySet<number>): boolean {
  const visited = new Set<number>();
  let current = pid;
  while (current > 0 && !visited.has(current)) {
    if (pids.has(current)) return true;
    visited.add(current);
    const info = table.get(current);
    if (!info) return false;
    current = info.ppid;
  }
  return false;
}

function countDescendants(table: ProcessTable, root: number, claimed: ReadonlySet<number>): number {
  let count = 0;
  for (const pid of claimed) {
    if (pid === root) continue;
    const visited = new Set<number>();
    let current = table.get(pid)?.ppid;
    while (current !== undefined && current > 0 && !visited.has(current)) {
      if (current === root) {
        count += 1;
        break;
      }
      visited.add(current);
      current = table.get(current)?.ppid;
    }
  }
  return count;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Distinguish the two shapes the kernel observer emits. */
function isExit(event: WatchStart | WatchExit): event is WatchExit {
  return (event as WatchExit).exitedAt !== undefined;
}

/** A display name for a start event: the executable's own name, not its path. */
function nameOf(event: WatchStart): string {
  const exe = event.exePath;
  if (exe) {
    const index = Math.max(exe.lastIndexOf("\\"), exe.lastIndexOf("/"));
    return index >= 0 ? exe.slice(index + 1) : exe;
  }
  // `lost` starts carry no path; the kernel's own name (`comm`) is the next
  // best thing, and the pid is all that is left after that.
  if (event.comm) return event.comm;
  return "?";
}
