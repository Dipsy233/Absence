import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WatchExit, WatchHostMetric, WatchMetric, WatchStart, WatchStatus } from "./observer";

/**
 * The Windows process observer: the Absence-side half of `native/agentwatch`.
 *
 * `WatchStart`, `WatchExit` and `WatchStatus` are the platform-neutral shapes
 * from `observer.ts`; the Linux observer emits the same ones.
 */
export type { WatchExit, WatchStart, WatchStatus };

export interface SidecarEvents {
  start: (event: WatchStart) => void;
  exit: (event: WatchExit) => void;
  status: (status: WatchStatus, detail?: string) => void;
  /** One process's counters, in answer to a `sample` request. */
  metric: (event: WatchMetric) => void;
  /** Host counters, once per sampling pass. */
  host: (event: WatchHostMetric) => void;
}

type Listener<K extends keyof SidecarEvents> = SidecarEvents[K];

/**
 * The Absence-side half of `native/agentwatch`. It starts the helper, hands it the
 * server's pid so the server itself is placed in a Job Object, and republishes
 * every process creation and exit the kernel reports.
 *
 * The helper is deliberately not a child of a "watched" tree: it is started
 * *before* the server is placed in the job (by the helper, using the server's
 * pid), so the helper's own process is never in the job and never reports
 * itself.
 *
 * If the helper dies, it is restarted. The server may already be in the old
 * job — Windows 8 and later support nested jobs, so the server is placed in a
 * second job as well, and both jobs' events are delivered (the old job's
 * completion port is gone with the old helper, so only the new one is heard).
 * A baseline snapshot taken by the caller covers the gap.
 */
export class JobSidecar {
  private readonly emitter = new EventEmitter();
  private child?: ChildProcess;
  private buffer = "";
  /** Resolvers waiting for the helper's `sample_done`. */
  private readonly sampleWaiters = new Set<() => void>();
  private statusValue: WatchStatus = "starting";
  /** True once a helper has reported `ready` — post-ready errors get logged. */
  private ready = false;
  private disposed = false;
  private restarts = 0;
  private readonly exePath: string;
  private readonly maxRestarts: number;
  /** Debounce: a helper that dies instantly must not be restarted in a loop. */
  private restartTimer?: NodeJS.Timeout;

  constructor(options: { exePath?: string; maxRestarts?: number } = {}) {
    this.exePath = options.exePath ?? defaultExePath();
    this.maxRestarts = options.maxRestarts ?? 5;
  }

  get available(): boolean {
    return this.statusValue === "watching";
  }

  get status(): WatchStatus {
    return this.statusValue;
  }

  on<K extends keyof SidecarEvents>(event: K, listener: Listener<K>): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  /**
   * Start the helper against this process. Resolves once the helper reports
   * `ready`, or rejects if it could not start or could not adopt the process.
   * The caller must not create any session before this resolves: processes
   * spawned earlier would be outside the job and permanently invisible.
   */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("sidecar disposed"));
    if (!fs.existsSync(this.exePath)) {
      const detail = `agentwatch helper not found at ${this.exePath}`;
      this.setStatus("unavailable", detail);
      return Promise.reject(new Error(detail));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      // stdin is the sampling channel: "sample" asks the helper for one pass
      // over the handles it already holds (see native/agentwatch/README.md).
      const child = spawn(this.exePath, ["--target-pid", String(process.pid)], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      this.buffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).replace(/\r$/, "");
          this.buffer = this.buffer.slice(index + 1);
          if (!line.trim()) continue;
          const resolved = this.handleLine(line);
          if (resolved && !settled && resolved.kind === "ready") {
            settled = true;
            this.ready = true;
            this.setStatus("watching");
            resolve();
          } else if (resolved && !settled && resolved.kind === "error") {
            settled = true;
            this.setStatus("unavailable", `${resolved.what} failed (code ${resolved.code})`);
            reject(new Error(`agentwatch ${resolved.what} failed (code ${resolved.code})`));
          }
        }
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        process.stderr.write(`[agentwatch] ${chunk.toString("utf8")}`);
      });

      child.on("error", (error) => {
        if (!settled) {
          settled = true;
          this.setStatus("unavailable", error.message);
          reject(error);
        }
      });

      child.on("exit", () => {
        this.child = undefined;
        // Nothing will answer a pending sample request now.
        this.settleSamples();
        if (this.disposed) return;
        if (!settled) {
          settled = true;
          this.setStatus("unavailable", "agentwatch exited before ready");
          reject(new Error("agentwatch exited before ready"));
          return;
        }
        this.scheduleRestart();
      });
    });
  }

  /** Stop the helper. Never touches the observed processes. */
  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.child?.kill();
    this.child = undefined;
    this.setStatus("unavailable", "stopped");
    this.emitter.removeAllListeners();
  }

  // --------------------------------------------------------------------------

  private scheduleRestart(): void {
    if (this.restartTimer !== undefined) return;
    if (this.restarts >= this.maxRestarts) {
      process.stderr.write(`[agentwatch] helper kept dying; gave up after ${this.restarts} restarts\n`);
      this.setStatus("unavailable", `agentwatch stopped after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    process.stderr.write(`[agentwatch] helper exited without warning; restarting (${this.restarts}/${this.maxRestarts})\n`);
    this.setStatus("starting", "restarting agentwatch");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(() => {
        // `start` already reported the failure through status; a further exit
        // schedules the next attempt.
      });
    }, 500);
  }

  private handleLine(line: string): { kind: string; what?: string; code?: number } | undefined {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return undefined;
    }
    const ev = typeof parsed.ev === "string" ? parsed.ev : "";
    switch (ev) {
      case "ready":
        return { kind: "ready" };
      case "sample_done":
        this.settleSamples();
        return { kind: "sample_done" };
      case "host": {
        this.emitter.emit("host", {
          cpuMs: numberOrUndefined(parsed.cpuMs) ?? 0,
          idleMs: numberOrUndefined(parsed.idleMs) ?? 0,
          cores: numberOrUndefined(parsed.cores) ?? 1,
          memTotalBytes: numberOrUndefined(parsed.memTotal) ?? 0,
          memAvailableBytes: numberOrUndefined(parsed.memAvail) ?? 0,
        } satisfies WatchHostMetric);
        return { kind: "host" };
      }
      case "metric": {
        const pid = numberOrUndefined(parsed.pid);
        if (pid === undefined) return undefined;
        this.emitter.emit("metric", {
          pid,
          cpuMs: numberOrUndefined(parsed.cpuMs) ?? 0,
          rssBytes: numberOrUndefined(parsed.rss) ?? 0,
          vszBytes: numberOrUndefined(parsed.vsz),
          threads: numberOrUndefined(parsed.threads),
          handles: numberOrUndefined(parsed.handles),
          ioReadBytes: numberOrUndefined(parsed.ioR),
          ioWriteBytes: numberOrUndefined(parsed.ioW),
        } satisfies WatchMetric);
        return { kind: "metric" };
      }
      case "error": {
        // Post-ready errors change nothing about the contract, but a helper
        // that starts failing silently is un-debuggable — say something.
        const what = typeof parsed.what === "string" ? parsed.what : "unknown";
        const code = typeof parsed.code === "number" ? parsed.code : 0;
        if (this.ready) {
          process.stderr.write(`[agentwatch] helper error: ${what} (code ${code})\n`);
        }
        return { kind: "error", what, code };
      }
      case "start": {
        const pid = numberOrUndefined(parsed.pid);
        if (pid === undefined) return undefined;
        this.emitter.emit("start", {
          pid,
          ppid: numberOrUndefined(parsed.ppid) ?? 0,
          createdAt: numberOrUndefined(parsed.create),
          exePath: typeof parsed.path === "string" ? parsed.path : undefined,
          commandLine: typeof parsed.cmd === "string" ? parsed.cmd : undefined,
          lost: parsed.lost === true,
          absenceSessionId: typeof parsed.sess === "string" && parsed.sess.length > 0 ? parsed.sess : undefined,
        } satisfies WatchStart);
        return undefined;
      }
      case "exit": {
        const pid = numberOrUndefined(parsed.pid);
        if (pid === undefined) return undefined;
        const durationMs = numberOrUndefined(parsed.durMs);
        this.emitter.emit("exit", {
          pid,
          exitedAt: Date.now(),
          durationMs,
          cpuMs: numberOrUndefined(parsed.cpuMs),
          exitCode: numberOrUndefined(parsed.code),
          // An exit with no duration is one we never saw start.
          unmatched: durationMs === undefined,
        } satisfies WatchExit);
        return undefined;
      }
      case "active_zero":
      case "target_gone":
      default:
        return undefined;
    }
  }

  private settleSamples(): void {
    for (const resolve of this.sampleWaiters) resolve();
    this.sampleWaiters.clear();
  }

  /**
   * Ask the helper for one resource pass and wait for it to finish.
   *
   * `pids` names processes outside our job (an observed agent's tree) that the
   * helper should borrow a handle for and measure. Resolves `false` when no
   * answer arrives in time (a helper built before sampling existed, a wedged
   * process, or a restart in progress), which tells the caller to fall back to
   * reading the process table.
   */
  requestSample(timeoutMs = 1500, pids: number[] = []): Promise<boolean> {
    const child = this.child;
    const stdin = child?.stdin;
    if (!child || !stdin || stdin.destroyed) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        this.sampleWaiters.delete(onDone);
        clearTimeout(timer);
        resolve(ok);
      };
      const onDone = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      timer.unref?.();
      this.sampleWaiters.add(onDone);
      try {
        const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 0);
        // The pid list names processes outside our job (an observed agent's
        // tree): the helper borrows a handle and measures them too.
        stdin.write(wanted.length > 0 ? `sample ${wanted.join(",")}\n` : "sample\n");
      } catch {
        finish(false);
      }
    });
  }

  private setStatus(status: WatchStatus, detail?: string): void {
    const changed = status !== this.statusValue;
    this.statusValue = status;
    if (changed || detail) this.emitter.emit("status", status, detail);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Where the committed binary lives, resolved for both the source checkout
 * (`tsx src/index.ts`) and a compiled run (`node dist/index.js`). The binary is
 * committed next to its source rather than copied into the build output.
 */
function defaultExePath(): string {
  if (process.env.ABSENCE_AGENTWATCH) return process.env.ABSENCE_AGENTWATCH;
  const base = path.dirname(fileURLToPath(import.meta.url));
  // apps/server/src/process → repo root
  const repoRoot = path.resolve(base, "../../../..");
  return path.join(repoRoot, "native", "agentwatch", "agentwatch.exe");
}
