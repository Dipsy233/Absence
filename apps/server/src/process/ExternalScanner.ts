import fs from "node:fs";
import { snapshotProcesses, type ProcInfo, type ProcessTable } from "./ProcessTable";
import {
  attributedTree,
  defaultPiCandidates,
  findPiSession,
  pairDefaultSessions,
} from "./ProcessScanner";

/**
 * How often the shared scanner looks. A snapshot costs hundreds of
 * milliseconds (one machine-wide enumeration), which is exactly why the scan
 * is shared: five observed sessions must not mean five snapshots per cycle.
 * The cadence matches the watcher's own slow tick (ProcessWatcher.TICK_SLOW_MS).
 */
const TICK_MS = 4000;

/**
 * One machine-wide process snapshot, dispatched to every observed session.
 *
 * Before this scanner, each observed transcript ran its own 4 s poll loop, so
 * N observed sessions meant N full process-table sweeps — on a machine with
 * thirty transcripts attached, that was thirty sweeps of the same table every
 * four seconds. The scanner sweeps once and hands each transcript the root
 * subtree the evidence binds to it.
 *
 * Binding evidence, strongest first:
 *  1. `--session <file>` on a pi entry's command line names the transcript
 *     outright (`findPiSession`);
 *  2. a brand-new default-`pi` process paired with a brand-new transcript —
 *     only when the 1:1 pairing is unambiguous (`pairDefaultSessions`);
 *  3. nothing. A transcript whose agent cannot be proven gets no pid, and its
 *     session simply shows no process tree.
 */
export class ExternalScanner {
  private static instance?: ExternalScanner;

  /** The process-wide scanner, created on first use (mirrors JobMonitor.get). */
  static get(): ExternalScanner {
    this.instance ??= new ExternalScanner();
    return this.instance;
  }

  private readonly sinks = new Map<string, (root: ProcInfo | undefined, rows: ProcInfo[]) => void>();
  /** When each registered transcript first appeared — the pairing's anchor. */
  private readonly fileBirth = new Map<string, number>();
  /** pid → transcript file, for pairings proven in an earlier tick. */
  private readonly bindings = new Map<number, string>();
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private disposed = false;
  private readonly snapshot: () => Promise<ProcessTable>;

  constructor(options?: { snapshot?: () => Promise<ProcessTable> }) {
    this.snapshot = options?.snapshot ?? snapshotProcesses;
  }

  register(file: string, sink: (root: ProcInfo | undefined, rows: ProcInfo[]) => void): void {
    if (this.disposed) return;
    this.sinks.set(file, sink);
    if (!this.fileBirth.has(file)) this.fileBirth.set(file, this.statBirth(file));
    // The first scan comes at once: an agent seen this moment should not wait
    // a full cadence for its tree. Later scans keep the steady tick.
    this.timer ??= setTimeout(() => void this.tick(), 250);
  }

  unregister(file: string): void {
    this.sinks.delete(file);
    this.fileBirth.delete(file);
    for (const [pid, bound] of [...this.bindings]) {
      if (bound === file) this.bindings.delete(pid);
    }
    if (this.sinks.size === 0 && this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** Test hook: stop the timer without invalidating the instance. */
  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** The transcript files bound to a pid right now (diagnostics). */
  bindingFor(pid: number): string | undefined {
    return this.bindings.get(pid);
  }

  private statBirth(file: string): number {
    try {
      const stat = fs.statSync(file);
      // Windows and most Linux filesystems report a real birth time; where the
      // platform cannot, first sighting is the honest floor.
      return stat.birthtimeMs > 0 ? stat.birthtimeMs : Date.now();
    } catch {
      return Date.now();
    }
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) return;
    this.inFlight ??= this.scan().finally(() => {
      this.inFlight = undefined;
    });
    await this.inFlight.catch(() => {});
    if (!this.disposed && this.sinks.size > 0) {
      this.timer = setTimeout(() => void this.tick(), TICK_MS);
    }
  }

  private async scan(): Promise<void> {
    if (this.sinks.size === 0) return;
    let table: ProcessTable;
    try {
      table = await this.snapshot();
    } catch {
      return; // A failed table read is missing evidence, not evidence of exit.
    }
    if (this.disposed) return;
    const entries = [...this.sinks.entries()];

    // 1. Explicit `--session` evidence wins, always.
    const explicit = new Map<string, ProcInfo>();
    const claimed = new Set<number>();
    for (const [file] of entries) {
      const root = findPiSession(table, file);
      if (root) {
        explicit.set(file, root);
        claimed.add(root.pid);
      }
    }

    // 2. Fresh 1:1 pairings for default pi runs. Bindings persist while the
    // process lives; a dead binding frees nothing (the transcript keeps its
    // history) but stops receiving rows.
    for (const [pid, file] of [...this.bindings]) {
      if (!table.has(pid)) this.bindings.delete(pid);
    }
    const unbound = entries.filter(([file]) => !explicit.has(file) && !this.boundTo(file));
    if (unbound.length > 0) {
      const candidates = defaultPiCandidates(table).filter((info) => !claimed.has(info.pid));
      const pairs = pairDefaultSessions(
        unbound.map(([file]) => ({ file, createdAt: this.fileBirth.get(file) ?? Date.now() })),
        candidates,
      );
      for (const [file, pid] of pairs) this.bindings.set(pid, file);
    }

    // 3. Deliver each transcript its bound subtree (empty rows when none).
    // One sink failing must not starve the others of their sweep.
    for (const [file, sink] of entries) {
      const boundPid = explicit.get(file)?.pid ?? this.boundTo(file);
      const root = boundPid !== undefined ? table.get(boundPid) : undefined;
      const rows = root ? [root, ...attributedTree(table, root.pid)] : [];
      try {
        sink(root, rows);
      } catch {
        // The session's own error handling owns this; the sweep continues.
      }
    }
  }

  private boundTo(file: string): number | undefined {
    for (const [pid, bound] of this.bindings) {
      if (bound === file) return pid;
    }
    return undefined;
  }
}
