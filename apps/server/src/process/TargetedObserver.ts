import { EventEmitter } from "node:events";
import { JobSidecar } from "./JobSidecar";
import { JobMonitor } from "./JobMonitor";
import { snapshotProcesses, type ProcessTable, type ProcInfo } from "./ProcessTable";
import { attributedTree } from "./ProcessScanner";
import type { WatchExit, WatchStart, WatchStatus } from "./observer";

/**
 * Kernel-grade observation of one already-running external process tree.
 *
 * This is the pure third-party path: the user keeps running pi in their own
 * terminal, exactly as before, and Absence never becomes its parent or its
 * proxy. Instead it asks the kernel to report that process's subtree directly.
 *
 *   - Windows: a dedicated `agentwatch.exe --target-pid <pid>` adopts the
 *     process into its own Job Object (`OpenProcess` +
 *     `AssignProcessToJobObject`), so every later descendant's creation and
 *     exit is reported as an event — no sampling. This is the same kernel
 *     mechanism the server-wide observer uses on itself, now pointed at the
 *     agent the user chose.
 *   - Linux: the eBPF tracepoints are already machine-wide, so this observer
 *     subscribes to the shared stream and keeps only the events whose
 *     pid→ppid chain reaches the chosen root.
 *
 * A process that was already running when the observer attached cannot be
 * retroactively reported: only the adopted process and the descendants it
 * spawns *afterwards* join the job. `seed()` therefore snapshots the subtree
 * that already exists and emits those as starts, so the panel is complete from
 * the first paint. An existing descendant's *exit* is not a job event (it never
 * joined); the watcher's liveness probe covers those.
 */

export interface TargetedObserverEvents {
  start: (event: WatchStart) => void;
  exit: (event: WatchExit) => void;
  status: (status: WatchStatus, detail?: string) => void;
}

type Listener<K extends keyof TargetedObserverEvents> = TargetedObserverEvents[K];

export interface TargetedObserverOptions {
  /** The root process the user chose to watch. */
  pid: number;
  /** That process's start time (epoch ms) — the pid-reuse guard. */
  startedAt: number;
  /** Injectable machine snapshot (checks). */
  snapshot?: () => Promise<ProcessTable>;
  /**
   * Injectable kernel stream (checks). Production omits it: on Windows a
   * dedicated Job Object is spawned, on Linux the shared eBPF stream is used.
   */
  subscribeKernel?: (listener: (event: WatchStart | WatchExit) => void) => () => void;
  /**
   * Force a backend (checks). Omitted in production, where the platform picks:
   * "job" adopts the pid into a Job Object (Windows), "filter" keeps the
   * machine-wide stream's subtree (Linux). A check forces "filter" on Windows
   * to pin the ancestry logic without a real helper.
   */
  backend?: "job" | "filter";
}

const START_SLACK_MS = 2000;

export class TargetedObserver {
  private readonly emitter = new EventEmitter();
  private readonly pid: number;
  private readonly startedAt: number;
  private readonly snapshot: () => Promise<ProcessTable>;
  private readonly subscribeKernel?: TargetedObserverOptions["subscribeKernel"];
  private readonly backend: "job" | "filter";
  private sidecar?: JobSidecar;
  private unsubKernel?: () => void;
  private statusValue: WatchStatus = "starting";
  private disposed = false;
  /** pid → ppid for the Linux ancestry filter, seeded from the snapshot. */
  private readonly parents = new Map<number, number>();
  /** Pids proven to belong to the chosen subtree (Linux filter). */
  private readonly subtree = new Set<number>();

  constructor(options: TargetedObserverOptions) {
    this.pid = options.pid;
    this.startedAt = options.startedAt;
    this.snapshot = options.snapshot ?? snapshotProcesses;
    this.subscribeKernel = options.subscribeKernel;
    this.backend = options.backend ?? (process.platform === "win32" ? "job" : "filter");
  }

  get available(): boolean {
    return this.statusValue === "watching";
  }

  get status(): WatchStatus {
    return this.statusValue;
  }

  on<K extends keyof TargetedObserverEvents>(event: K, listener: Listener<K>): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /**
   * Begin observing. Resolves once the kernel mechanism is live and the
   * existing subtree has been seeded, or rejects when it cannot attach (no
   * rights, the pid is already in a non-nestable job, the helper is missing) —
   * the caller then falls back to polling.
   */
  async start(): Promise<void> {
    if (this.disposed) throw new Error("targeted observer disposed");
    // A dedicated Job Object on the chosen pid (Windows), or the machine-wide
    // stream filtered by ancestry (Linux).
    if (this.backend === "job") {
      await this.startJobBackend();
    } else {
      await this.startKernelFilterBackend();
    }
    await this.seed();
    this.setStatus("watching");
  }

  dispose(): void {
    this.disposed = true;
    this.sidecar?.dispose();
    this.sidecar = undefined;
    this.unsubKernel?.();
    this.unsubKernel = undefined;
    this.emitter.removeAllListeners();
  }

  // --------------------------------------------------------------------------

  private async startJobBackend(): Promise<void> {
    if (this.subscribeKernel !== undefined) {
      // Checks: feed events straight in; the caller owns the simulation.
      this.unsubKernel = this.subscribeKernel((event) =>
        isExit(event) ? this.onKernelExit(event) : this.onKernelStart(event),
      );
      return;
    }
    // Windows: a dedicated helper adopts this pid (and nothing else), so every
    // event it reports already belongs to the chosen subtree.
    const sidecar = new JobSidecar({
      targetPid: this.pid,
      // The target's exit ends this observer; there is nothing to restart into.
      maxRestarts: 0,
    });
    this.sidecar = sidecar;
    sidecar.on("start", (event) => this.emitStart(event));
    sidecar.on("exit", (event) => this.emitExit(event));
    sidecar.on("status", (status, detail) => this.setStatus(status, detail));
    await sidecar.start();
  }

  private async startKernelFilterBackend(): Promise<void> {
    // Checks inject the machine-wide stream directly; production uses the
    // shared eBPF observer, which already reports every process on the host.
    if (this.subscribeKernel !== undefined) {
      this.unsubKernel = this.subscribeKernel((event) =>
        isExit(event) ? this.onKernelExit(event) : this.onKernelStart(event),
      );
      return;
    }
    const monitor = JobMonitor.get();
    if (!monitor.available && monitor.status === "unavailable") {
      throw new Error("no kernel process observer for the targeted watch");
    }
    this.unsubKernel = monitor.observe((event) =>
      isExit(event) ? this.onKernelExit(event) : this.onKernelStart(event),
    );
  }

  /** One machine-wide start event (Linux filter path). Keep only the subtree. */
  private onKernelStart(event: WatchStart): void {
    const pid = event.pid;
    this.parents.set(pid, event.ppid);
    if (pid === this.pid) {
      this.subtree.add(pid);
      return; // the root is the agent itself, not an egg
    }
    if (this.reachesRoot(event.ppid) && this.subtree.add(pid)) {
      this.emitStart(event);
    }
  }

  private onKernelExit(event: WatchExit): void {
    if (this.subtree.has(event.pid)) this.emitExit(event);
    this.subtree.delete(event.pid);
  }

  /** Does `ppid`'s ancestry reach the chosen root? */
  private reachesRoot(ppid: number): boolean {
    const visited = new Set<number>();
    let current = ppid;
    while (current > 0 && !visited.has(current)) {
      if (current === this.pid || this.subtree.has(current)) return true;
      visited.add(current);
      const next = this.parents.get(current);
      if (next === undefined) return false;
      current = next;
    }
    return false;
  }

  /**
   * Emit the subtree that is already alive as starts, so a process the user
   * started before Absence attached still shows. The windows path has already
   * confirmed the pid by startedAt before we get here (the watch resolver
   * checks the table); re-check defensively.
   */
  private async seed(): Promise<void> {
    let table: ProcessTable;
    try {
      table = await this.snapshot();
    } catch {
      return;
    }
    const root = table.get(this.pid);
    if (!root) return;
    if (this.startedAt > 0 && Math.abs(root.startedAt - this.startedAt) > START_SLACK_MS) return;
    const rows = [root, ...attributedTree(table, this.pid)];
    for (const info of rows) {
      this.parents.set(info.pid, info.ppid);
      this.subtree.add(info.pid);
      if (info.pid === this.pid) continue; // root is the agent, not an egg
      this.emitStart(procToStart(info));
    }
  }

  private emitStart(event: WatchStart): void {
    if (this.disposed) return;
    this.emitter.emit("start", event);
  }

  private emitExit(event: WatchExit): void {
    if (this.disposed) return;
    this.emitter.emit("exit", event);
  }

  private setStatus(status: WatchStatus, detail?: string): void {
    const changed = status !== this.statusValue;
    this.statusValue = status;
    if (changed || detail) this.emitter.emit("status", status, detail);
  }
}

function procToStart(info: ProcInfo): WatchStart {
  return {
    pid: info.pid,
    ppid: info.ppid,
    comm: info.name,
    commandLine: info.commandLine,
    createdAt: info.startedAt || undefined,
  };
}

function isExit(event: WatchStart | WatchExit): event is WatchExit {
  return (event as WatchExit).exitedAt !== undefined;
}
