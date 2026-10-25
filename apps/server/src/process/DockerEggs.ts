import type { ProcessPayload } from "@absence/core";
import type { RawProcessSample } from "./metricSample";
import type { MetricsTarget } from "./ProcessMetrics";
import { DockerMonitor, type ContainerEvent } from "./DockerMonitor";
import type { ProcessWatcher } from "./ProcessWatcher";

/**
 * A session's container eggs: the workloads the kernel observers cannot see.
 *
 * A container is a real workload with no real pid — it lives inside the
 * daemon's VM. `DockerMonitor` reports its lifecycle from `docker events`; this
 * class turns those events into `process` AbsenceEvents in the exact shape the
 * eggs panel, the report and the metrics store already consume:
 *
 *  - the pid is **synthetic** (a range far above any real pid), stable for the
 *    container's lifetime, so every pid-keyed surface keys it cleanly;
 *  - `command` is the attribution: the agent command whose window was open when
 *    the daemon started the container — `docker run -d` and
 *    `docker compose up -d` credit their containers the same way a spawned
 *    process is credited. A container laid outside any command window gets **no
 *    egg**: the daemon reports no client, so a container the user started in
 *    their own terminal is not this agent's work, and only the one-time
 *    adoption at session open reports unattributed containers;
 *  - `kind` is always `primary`, because a container is by definition the
 *    workload itself, and only primary eggs reach metrics storage.
 *
 * Bookkeeping here is deliberately separate from `ProcessWatcher`'s pid maps:
 * those are shared with the kernel observer, and a synthetic pid must never
 * meet a real one.
 */

/**
 * Where container pids start. Real pids stop orders of magnitude below this
 * (Windows allocates well under 2^31, Linux pid_max tops out at 2^22), so a
 * container egg cannot collide with a process egg in any pid-keyed surface.
 */
export const SYNTHETIC_PID_BASE = 1_000_000_000;

/**
 * How far past a command's return a container start may still be credited to
 * it. The daemon's event timestamp is exact — the slack covers stream delivery
 * lag, not the backgrounded-daemon window a spawned process needs — and it is
 * deliberately tighter than the kernel observer's: a container the *user*
 * started in another terminal must not drift into the agent's last command.
 */
const CONTAINER_POST_SLACK_MS = 1_500;

/**
 * A window whose command cannot drive a container cannot have laid one. The
 * daemon reports no client, so this text prior is the second gate after the
 * window: a container appearing just after `git status` is nobody's egg, while
 * `wsl docker run -d` and `docker compose up -d` pass as they should.
 */
const CONTAINER_DRIVER = /\bdocker(\.exe)?\b|docker-compose|\bpodman\b|\bnerdctl\b/i;

/** BuildKit's build containers are the builder's plumbing, never the workload. */
const BUILD_INFRASTRUCTURE = /^buildx_buildkit_/;

interface ContainerEgg {
  pid: number;
  containerId: string;
  name: string;
  image: string;
  startedAt: number;
  command?: string;
  status: "running" | "exited";
  exitedAt?: number;
  exitCode?: number;
}

export class DockerEggs {
  private readonly eggs = new Map<number, ContainerEgg>();
  private readonly byContainer = new Map<string, number>();
  private nextPid = SYNTHETIC_PID_BASE;
  private disposed = false;

  constructor(
    private readonly watcher: ProcessWatcher,
    /** The session's process-event sink — the same channel kernel eggs use. */
    private readonly emit: (payload: ProcessPayload) => void,
  ) {}

  /**
   * Adopt the containers that were already running when the session opened.
   * They have no command window to be attributed to, so they arrive
   * unattributed — visible, honest about it, and not dropped.
   */
  async adopt(): Promise<void> {
    let running: Array<{ containerId: string; name: string; image: string }>;
    try {
      running = await DockerMonitor.get().listRunning();
    } catch {
      return; // no docker: nothing to adopt, and nothing else changes
    }
    for (const container of running) {
      if (this.byContainer.has(container.containerId)) continue;
      this.lay(
        {
          kind: "start",
          containerId: container.containerId,
          name: container.name,
          image: container.image,
          at: Date.now(),
        },
        { adopted: true },
      );
    }
  }

  /** One daemon event, attributed and republished as a process egg. */
  onContainerEvent(event: ContainerEvent): void {
    if (this.disposed) return;
    if (event.kind === "start") {
      this.lay(event);
      return;
    }
    this.reap(event);
  }

  /** The container eggs, in the metrics sampler's target shape. */
  metricsTargets(): MetricsTarget[] {
    return [...this.eggs.values()].map((egg) => ({
      rootPid: egg.pid,
      name: egg.name,
      kind: "primary" as const,
      status: egg.status,
      startedAt: egg.startedAt,
      pids: [egg.pid],
    }));
  }

  /**
   * The stats stream's latest counters, keyed by synthetic pid. The sampler
   * merges these into its raw table — a container has no /proc entry and no
   * kernel handle, so without this it would silently drop out of every frame.
   */
  extraSamples(): Map<number, RawProcessSample> {
    const out = new Map<number, RawProcessSample>();
    if (!DockerMonitor.get().available) return out;
    for (const egg of this.eggs.values()) {
      if (egg.status !== "running") continue;
      const resource = DockerMonitor.get().resourceOf(egg.containerId);
      if (!resource) continue;
      out.set(egg.pid, {
        pid: egg.pid,
        ppid: 0,
        name: egg.name,
        cpuSeconds: resource.cpuSeconds,
        rssBytes: resource.rssBytes,
      });
    }
    return out;
  }

  dispose(): void {
    this.disposed = true;
    this.eggs.clear();
    this.byContainer.clear();
  }

  // --------------------------------------------------------------------------

  private lay(event: ContainerEvent, options: { adopted?: boolean } = {}): void {
    // BuildKit's build containers belong to the builder, not to any command.
    if (BUILD_INFRASTRUCTURE.test(event.name)) return;
    const existing = this.byContainer.get(event.containerId);
    if (existing !== undefined) {
      // A restart under the same container id: same egg, new lifetime.
      const egg = this.eggs.get(existing);
      if (!egg) return;
      egg.status = "running";
      egg.startedAt = event.at;
      egg.exitedAt = undefined;
      egg.exitCode = undefined;
      this.publish(egg);
      return;
    }
    // The window is the whole case for attribution: the daemon reports no
    // client, so a container laid outside any command window — one the user
    // started in their own terminal, one from another session — is not this
    // agent's work and gets no egg. Only the one-time adoption below reports
    // unattributed containers. The command must also be able to drive a
    // container at all: a start landing just after `git status` is nobody's.
    let command: string | undefined;
    if (options.adopted) {
      command = undefined;
    } else {
      command = this.watcher.commandAt(event.at, CONTAINER_POST_SLACK_MS);
      if (command === undefined || !CONTAINER_DRIVER.test(command)) return;
    }
    const pid = this.nextPid++;
    const egg: ContainerEgg = {
      pid,
      containerId: event.containerId,
      name: event.name,
      image: event.image,
      startedAt: event.at,
      command,
      status: "running",
    };
    this.eggs.set(pid, egg);
    this.byContainer.set(event.containerId, pid);
    this.publish(egg);
  }

  private reap(event: ContainerEvent): void {
    const pid = this.byContainer.get(event.containerId);
    if (pid === undefined) return;
    const egg = this.eggs.get(pid);
    if (!egg || egg.status === "exited") return;
    egg.status = "exited";
    egg.exitedAt = event.at;
    if (event.exitCode !== undefined) egg.exitCode = event.exitCode;
    this.publish(egg);
  }

  private publish(egg: ContainerEgg): void {
    this.emit({
      pid: egg.pid,
      ppid: 0,
      name: egg.name,
      commandLine: `${egg.image} (container ${egg.containerId.slice(0, 12)})`,
      status: egg.status,
      startedAt: egg.startedAt,
      exitedAt: egg.exitedAt,
      exitCode: egg.exitCode,
      children: 0,
      command: egg.command,
      kind: "primary",
      kindReason: "docker container",
    });
  }
}
