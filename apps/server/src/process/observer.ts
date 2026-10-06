/**
 * The shape of a process event, shared by every platform observer.
 *
 * Windows learns these from a Job Object's completion port, Linux from eBPF
 * tracepoints; neither detail leaks past this file. What the rest of Daze —
 * `ProcessWatcher`, `classify`, the eggs panel — sees is only these two events.
 */

/** A process has started. */
export interface WatchStart {
  pid: number;
  ppid: number;
  /** Unix ms the OS says the process started, when the observer can say. */
  createdAt?: number;
  /** Full image path, e.g. `C:\Windows\System32\cmd.exe` or `/usr/bin/bash`. */
  exePath?: string;
  /** Full command line. */
  commandLine?: string;
  /** Executable name from the kernel (`comm`), when the platform has one. */
  comm?: string;
  /**
   * The process was created and exited before the observer could open it. The
   * event still proves it existed, which is exactly what polling could not say.
   */
  lost?: boolean;
}

/** A process has exited. */
export interface WatchExit {
  pid: number;
  /** Unix ms the observation of the exit happened. */
  exitedAt: number;
  durationMs?: number;
  cpuMs?: number;
  exitCode?: number;
  /** True when no `start` was reported for this pid (we only saw it leave). */
  unmatched?: boolean;
}

/** How a process observer is doing, for the UI's precision indication. */
export type WatchStatus = "starting" | "watching" | "unavailable";

/**
 * A platform mechanism that reports process creation and exit as they happen.
 *
 * Windows observes through a Job Object (`JobSidecar`); Linux through eBPF
 * tracepoints (`EbpfObserver`). Both call the same subscription, so the code
 * above never branches on the platform.
 */
export interface ProcessObserver {
  /** True only while the mechanism is live and reporting. */
  readonly available: boolean;
  readonly status: WatchStatus;
  /** The reason the observer is unavailable, when it is. */
  readonly statusDetail?: string;
  start(): Promise<void>;
  on(event: "start" | "exit", listener: (event: WatchStart | WatchExit) => void): () => void;
  on(event: "status", listener: (status: WatchStatus, detail?: string) => void): () => void;
  dispose(): void;
}
