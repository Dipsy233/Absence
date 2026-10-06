import { EbpfObserver } from "./EbpfObserver";
import { JobSidecar } from "./JobSidecar";
import type { WatchExit, WatchStart, WatchStatus } from "./observer";

/**
 * The process-wide owner of the kernel process observer.
 *
 * Windows observes through a Job Object (`native/agentwatch`); Linux through
 * eBPF tracepoints (`native/agentwatch-linux`). Both report creation and exit as
 * they happen, so there is exactly one observer per server process — not one per
 * session — and this is the single place that starts it, restarts it and
 * republishes its events.
 *
 * It is created before any session exists, so that nothing the server itself
 * spawns early is mistaken for a session's work.
 *
 * Sessions do not talk to this directly; `ProcessWatcher` subscribes.
 */
export class JobMonitor {
  private static instance?: JobMonitor;
  private readonly sidecar: JobSidecar | EbpfObserver;
  private startPromise?: Promise<void>;
  private readonly observers = new Set<(event: WatchStart | WatchExit) => void>();
  private readonly statusObservers = new Set<(status: WatchStatus, detail?: string) => void>();
  private lastStatus: WatchStatus = "starting";
  private lastDetail?: string;

  private constructor() {
    this.sidecar =
      process.platform === "linux"
        ? new EbpfObserver({ exePath: process.env.DAZE_AGENTWATCH_LINUX })
        : new JobSidecar({ exePath: process.env.DAZE_AGENTWATCH });
    this.sidecar.on("start", (event) => this.fanOut(event as WatchStart));
    this.sidecar.on("exit", (event) => this.fanOut(event as WatchExit));
    this.sidecar.on("status", (status, detail) => {
      this.lastStatus = status;
      this.lastDetail = detail;
      for (const observer of this.statusObservers) observer(status, detail);
    });
  }

  static get(): JobMonitor {
    JobMonitor.instance ??= new JobMonitor();
    return JobMonitor.instance;
  }

  /**
   * A no-op on platforms with no observer, so the server still runs there. On
   * Windows and Linux this must resolve before the first `createAgentSession`.
   */
  async start(): Promise<void> {
    if (process.platform !== "win32" && process.platform !== "linux") {
      this.lastStatus = "unavailable";
      this.lastDetail = "no kernel process observer for this platform";
      return;
    }
    this.startPromise ??= this.sidecar.start().catch((error: unknown) => {
      // A failed start is not fatal: sessions fall back to polling. Clear the
      // promise so a later attempt can retry.
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  /** True only while the helper is alive and the server is in its job. */
  get available(): boolean {
    return this.sidecar.available;
  }

  get status(): WatchStatus {
    return this.lastStatus;
  }

  get statusDetail(): string | undefined {
    return this.lastDetail;
  }

  /** Subscribe to every process creation/exit the kernel reports. */
  observe(listener: (event: WatchStart | WatchExit) => void): () => void {
    this.observers.add(listener);
    return () => this.observers.delete(listener);
  }

  onStatus(listener: (status: WatchStatus, detail?: string) => void): () => void {
    this.statusObservers.add(listener);
    listener(this.lastStatus, this.lastDetail);
    return () => this.statusObservers.delete(listener);
  }

  /** Stop the helper. Used by tests; the server keeps it for its lifetime. */
  dispose(): void {
    this.sidecar.dispose();
    this.observers.clear();
    this.statusObservers.clear();
    if (JobMonitor.instance === this) JobMonitor.instance = undefined;
  }

  private fanOut(event: WatchStart | WatchExit): void {
    for (const observer of this.observers) {
      try {
        observer(event);
      } catch {
        // A broken observer must not take down the event loop for the others.
      }
    }
  }
}
