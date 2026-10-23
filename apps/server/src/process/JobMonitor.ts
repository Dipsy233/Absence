import { EbpfObserver } from "./EbpfObserver";
import { JobSidecar } from "./JobSidecar";
import type {
  WatchExit,
  WatchHostMetric,
  WatchMetric,
  WatchSample,
  WatchStart,
  WatchStatus,
} from "./observer";

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
  /** In-flight sampling pass, so concurrent callers share one request. */
  private sampling?: Promise<WatchSample | undefined>;

  private constructor() {
    this.sidecar =
      process.platform === "linux"
        ? new EbpfObserver({ exePath: process.env.ABSENCE_AGENTWATCH_LINUX })
        : new JobSidecar({ exePath: process.env.ABSENCE_AGENTWATCH });
    this.sidecarOn("start", (event) => this.fanOut(event));
    this.sidecarOn("exit", (event) => this.fanOut(event));
    this.sidecarOn("status", (status, detail) => {
      this.lastStatus = status;
      this.lastDetail = detail;
      for (const observer of this.statusObservers) observer(status, detail);
    });
  }

  /**
   * `on`, narrowed per event. The two observers are structurally different
   * (the Windows helper can sample, eBPF cannot), so the union's `on` is not
   * callable directly.
   */
  private sidecarOn(event: "start", listener: (event: WatchStart) => void): () => void;
  private sidecarOn(event: "exit", listener: (event: WatchExit) => void): () => void;
  private sidecarOn(event: "metric", listener: (event: WatchMetric) => void): () => void;
  private sidecarOn(event: "host", listener: (event: WatchHostMetric) => void): () => void;
  private sidecarOn(event: "status", listener: (status: WatchStatus, detail?: string) => void): () => void;
  private sidecarOn(event: string, listener: (...args: never[]) => void): () => void {
    return (this.sidecar as unknown as { on(e: string, l: unknown): () => void }).on(event, listener);
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

  /**
   * True when this platform can report per-process counters from a handle the
   * observer already holds (Windows, via the helper's sampling pass). Linux
   * reports the same numbers through /proc, which is exact too — it just does
   * not need the helper for it.
   */
  get metricsAvailable(): boolean {
    return process.platform === "win32" && this.lastStatus === "watching";
  }

  /**
   * One resource pass, driven by the metrics sampler's cadence. Returns
   * `undefined` when this platform cannot sample natively, so the caller falls
   * back to reading the process table.
   */
  async sampleMetrics(pids: number[] = [], timeoutMs = 1500): Promise<WatchSample | undefined> {
    if (!this.metricsAvailable) return undefined;
    if (this.sampling) return this.sampling;
    const sidecar = this.sidecar as unknown as {
      requestSample?(timeoutMs?: number, pids?: number[]): Promise<boolean>;
    };
    if (!sidecar.requestSample) return undefined;

    const promise = (async (): Promise<WatchSample | undefined> => {
      const processes = new Map<number, WatchMetric>();
      let host: WatchHostMetric | undefined;
      const offMetric = this.sidecarOn("metric", (event) => processes.set(event.pid, event));
      const offHost = this.sidecarOn("host", (event) => {
        host = event;
      });
      try {
        const answered = await sidecar.requestSample!(timeoutMs, pids);
        return answered ? { processes, host } : undefined;
      } finally {
        offMetric();
        offHost();
      }
    })().finally(() => {
      this.sampling = undefined;
    });
    this.sampling = promise;
    return promise;
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
