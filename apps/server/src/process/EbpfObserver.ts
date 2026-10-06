import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { WatchExit, WatchStart, WatchStatus } from "./observer";

/**
 * The Linux process observer: the Daze-side half of `native/agentwatch-linux`.
 *
 * The helper is an eBPF program and its user-space loader, which reports every
 * fork, exec and exit the kernel performs. There is nothing to poll: a process
 * that lives a millisecond is seen exactly like one that lives an hour, which is
 * the whole reason the eBPF path exists.
 *
 * Two events arrive for one exec — the exec tracepoint (which has the resolved
 * path) and sys_enter_execve (which has argv) — so the loader joins them and
 * emits a single `start`. `fork` carries the parent/child link, which is what
 * lets a process be attributed to the command that laid it after the shell has
 * gone.
 *
 * Privileges: loading BPF needs CAP_BPF + CAP_PERFMON (or root). The loader says
 * so on stderr when it cannot, and `start()` rejects, so the session falls back
 * to polling with a clear reason.
 */
export interface EbpfEvents {
  start: (event: WatchStart) => void;
  exit: (event: WatchExit) => void;
  status: (status: WatchStatus, detail?: string) => void;
}

type Listener<K extends keyof EbpfEvents> = EbpfEvents[K];

/** pid → ppid, from fork events, so a start can carry its parent. */
const FORK_TABLE_MAX = 4096;

export class EbpfObserver {
  private readonly emitter = new EventEmitter();
  private child?: ChildProcess;
  private buffer = "";
  private statusValue: WatchStatus = "starting";
  private detail?: string;
  private disposed = false;
  private restarts = 0;
  private readonly exePath: string;
  private readonly maxRestarts: number;
  private restartTimer?: NodeJS.Timeout;
  /** Recent fork relationships, keyed by child pid. */
  private readonly parents = new Map<number, number>();

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

  get statusDetail(): string | undefined {
    return this.detail;
  }

  on<K extends keyof EbpfEvents>(event: K, listener: Listener<K>): () => void {
    this.emitter.on(event, listener);
    return () => this.emitter.off(event, listener);
  }

  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("observer disposed"));
    if (process.platform !== "linux") {
      this.setStatus("unavailable", "eBPF observation is Linux-only");
      return Promise.reject(new Error("eBPF observation is Linux-only"));
    }
    if (!fs.existsSync(this.exePath)) {
      const detail = `agentwatch-linux not found at ${this.exePath} (build it with native/agentwatch-linux/build.sh)`;
      this.setStatus("unavailable", detail);
      return Promise.reject(new Error(detail));
    }

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const child = spawn(this.exePath, [], { stdio: ["ignore", "pipe", "pipe"] });
      this.child = child;
      this.buffer = "";

      child.stdout?.on("data", (chunk: Buffer) => {
        this.buffer += chunk.toString("utf8");
        let index: number;
        while ((index = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, index).replace(/\r$/, "");
          this.buffer = this.buffer.slice(index + 1);
          if (!line.trim()) continue;
          const ready = this.handleLine(line);
          if (ready && !settled) {
            settled = true;
            this.setStatus("watching");
            resolve();
          }
        }
      });

      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
        // The loader explains a privilege or verifier failure here; keep the
        // last line for the status detail rather than spamming the log.
        const lines = stderr.trim().split("\n");
        this.detail = lines[lines.length - 1];
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
        if (this.disposed) return;
        if (!settled) {
          settled = true;
          const detail = this.detail ?? "agentwatch-linux exited before ready";
          this.setStatus("unavailable", detail);
          reject(new Error(detail));
          return;
        }
        this.scheduleRestart();
      });
    });
  }

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
      this.setStatus("unavailable", `agentwatch-linux stopped after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    this.setStatus("starting", "restarting agentwatch-linux");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      void this.start().catch(() => {
        // `start` already reported through status; a further exit schedules the
        // next attempt.
      });
    }, 500);
  }

  /** Returns true once the loader has reported ready. */
  private handleLine(line: string): boolean {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return false;
    }
    const ev = typeof parsed.ev === "string" ? parsed.ev : "";
    const pid = numberOrUndefined(parsed.pid);
    switch (ev) {
      case "ready":
        return true;
      case "fork": {
        if (pid !== undefined) this.rememberParent(pid, numberOrUndefined(parsed.ppid) ?? 0);
        return false;
      }
      case "start": {
        if (pid === undefined) return false;
        const commandLine = typeof parsed.cmd === "string" ? parsed.cmd : undefined;
        this.emitter.emit("start", {
          pid,
          // The event may not carry ppid; the fork table usually knows it.
          ppid: numberOrUndefined(parsed.ppid) ?? this.parents.get(pid) ?? 0,
          exePath: typeof parsed.path === "string" ? parsed.path : undefined,
          commandLine,
          comm: typeof parsed.comm === "string" ? parsed.comm : undefined,
        } satisfies WatchStart);
        return false;
      }
      case "exit": {
        if (pid === undefined) return false;
        this.parents.delete(pid);
        this.emitter.emit("exit", {
          pid,
          exitedAt: Date.now(),
        } satisfies WatchExit);
        return false;
      }
      default:
        return false;
    }
  }

  private rememberParent(pid: number, ppid: number): void {
    if (this.parents.size >= FORK_TABLE_MAX) {
      // Drop the oldest entry; the map preserves insertion order.
      const first = this.parents.keys().next().value;
      if (first !== undefined) this.parents.delete(first);
    }
    this.parents.set(pid, ppid);
  }

  private setStatus(status: WatchStatus, detail?: string): void {
    const changed = status !== this.statusValue;
    this.statusValue = status;
    if (detail !== undefined) this.detail = detail;
    if (changed || detail) this.emitter.emit("status", status, detail);
  }
}

function numberOrUndefined(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** The committed binary lives next to its source, not in the build output. */
function defaultExePath(): string {
  if (process.env.DAZE_AGENTWATCH_LINUX) return process.env.DAZE_AGENTWATCH_LINUX;
  const base = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(base, "../../../..");
  return path.join(repoRoot, "native", "agentwatch-linux", "agentwatch-linux");
}
