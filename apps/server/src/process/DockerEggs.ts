import type { AbsenceEvent, ProcessPayload } from "@absence/core";
import type { RawProcessSample } from "./metricSample";
import type { MetricsTarget } from "./ProcessMetrics";
import { DockerMonitor, type ContainerEvent, type ContainerState } from "./DockerMonitor";
import type { ProcessWatcher } from "./ProcessWatcher";
import { eventMatchesPrediction, predictContainers } from "./DockerCommand";

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
 *    their own terminal — or one left running by an earlier session — is not
 *    this agent's work and never enters the panel;
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
 * deliberately tighter than the kernel observer's.
 */
const CONTAINER_POST_SLACK_MS = 1_500;

/**
 * The fallback prior, for docker-shaped commands whose words could not be read
 * (a script, a wrapper, an unknown subcommand shape). A command that names no
 * driver cannot lay a container, whatever its window says.
 */
const CONTAINER_DRIVER = /\bdocker(\.exe)?\b|docker-compose|\bpodman\b|\bnerdctl\b/i;

/** BuildKit's build containers are the builder's plumbing, never the workload. */
const BUILD_INFRASTRUCTURE = /^buildx_buildkit_/;

/** The container identity every container egg's `commandLine` carries. */
const CONTAINER_LINE = /^(.*?)\s+\(container ([0-9a-f]{12})\)$/i;

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

/** The last archived state of one container egg, as the resume path reads it. */
interface ArchivedContainerEgg {
  pid: number;
  containerId?: string;
  name: string;
  image: string;
  commandLine: string;
  startedAt: number;
  command?: string;
  status: "running" | "exited";
  exitedAt?: number;
  exitCode?: number;
  retired?: true;
}

/**
 * Fold a session's archived process events into the last state of each
 * container egg. Only synthetic pids are considered: a real process can never
 * reach that range, so the archive's kernel eggs are untouched.
 */
function archivedContainerEggs(events: AbsenceEvent[]): ArchivedContainerEgg[] {
  const last = new Map<number, ArchivedContainerEgg>();
  for (const event of events) {
    if (event.type !== "process") continue;
    const payload = event.payload;
    if (payload.pid < SYNTHETIC_PID_BASE) continue;
    const match = CONTAINER_LINE.exec(payload.commandLine);
    last.set(payload.pid, {
      pid: payload.pid,
      containerId: payload.containerId ?? match?.[2],
      name: payload.name,
      image: match?.[1] ?? "",
      commandLine: payload.commandLine,
      startedAt: payload.startedAt,
      command: payload.command,
      status: payload.status,
      exitedAt: payload.exitedAt,
      exitCode: payload.exitCode,
      retired: payload.retired,
    });
  }
  return [...last.values()];
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

  /** One daemon event, attributed and republished as a process egg. */
  onContainerEvent(event: ContainerEvent): void {
    if (this.disposed) return;
    if (event.kind === "start") {
      this.lay(event);
      return;
    }
    this.reap(event);
  }

  /**
   * Re-attach to the containers this session laid that are still running.
   *
   * A resumed session replays its archive, so the Eggs panel already knows the
   * container eggs — but the live observer that sampled them died with the old
   * session (or with the server). This walks the archive's last state per
   * container, asks the daemon what actually happened while nobody watched,
   * and rebuilds exactly that much live state:
   *
   *  - running now → same pid and command; stats resume. A container that was
   *    restarted while the session was closed gets the daemon's new start time;
   *  - exited or removed meanwhile → an `exited` egg with the real exit code;
   *  - an old unattributed egg (the removed blanket-adoption behavior) → a
   *    `retired` event, so the resumed panel drops what was never ours.
   *
   * Attribution is not re-derived: the archive records which command laid the
   * container, and only eggs that carry one are revived.
   */
  async restore(events: AbsenceEvent[]): Promise<void> {
    if (this.disposed) return;
    const archived = archivedContainerEggs(events);
    if (archived.length === 0) return;
    // Keep future synthetic pids clear of every pid the archive already used,
    // exited ones included: a new egg must not overwrite a dead one in the UI.
    this.nextPid = Math.max(this.nextPid, ...archived.map((entry) => entry.pid + 1));

    // Old unattributed eggs need no daemon: retire them first, so resuming on
    // a machine without docker is not delayed by a probe just to drop them.
    for (const entry of archived) {
      if (entry.retired || entry.command !== undefined) continue;
      this.retire(entry);
    }

    const candidates = archived.filter(
      (entry) =>
        !entry.retired && entry.command !== undefined && entry.containerId !== undefined,
    );
    if (candidates.length === 0) return;
    const monitor = DockerMonitor.get();
    try {
      // No docker: the archived running eggs stay as the archive left them.
      await monitor.start();
    } catch {
      return;
    }

    const states = new Map<number, ContainerState | undefined>();
    await Promise.all(
      candidates.map(async (entry) => {
        states.set(entry.pid, await monitor.inspectContainer(entry.containerId!));
      }),
    );

    let anyRunning = false;
    for (const entry of candidates) {
      if (this.disposed) return;
      const state = states.get(entry.pid);
      if (state?.running) {
        const egg = this.revive(entry, state);
        anyRunning = true;
        // The archive's last word was `exited`: the container was restarted
        // while the session was closed, so tell recipients it is alive again.
        if (entry.status !== "running") this.publish(egg);
      } else if (entry.status === "running") {
        this.correctExit(entry, state);
      }
    }
    if (anyRunning) monitor.ensureStatsStream();
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

  private lay(event: ContainerEvent): void {
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
    // Attribution. The command's own words are the strong signal: `docker run
    // -d --name web nginx` predicts a container named `web`, and a daemon
    // start event that matches the prediction is this command's work while
    // one that matches nothing is not — however close it arrived. Every open
    // window gets to claim the event (parallel docker commands happen); a
    // docker-shaped command whose words cannot be read falls back to the
    // window alone; anything else gets no egg.
    const command = this.attribute(event);
    if (command === undefined) return;
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

  /**
   * Which open-or-recent command laid this container, if any.
   *
   * Each candidate window states a prediction from its own words; the first
   * window whose prediction matches wins. A window that parses but predicts
   * something else declines — that is the gate that keeps a foreign container
   * out even when it landed inside the window or just after it. Only windows
   * whose docker-shaped words could not be read fall back to the bare window.
   */
  private attribute(event: ContainerEvent): string | undefined {
    let looseFallback: string | undefined;
    for (const { command, cwd } of this.watcher.commandContexts(event.at, CONTAINER_POST_SLACK_MS)) {
      const prediction = predictContainers(command, cwd);
      if (prediction.parsed) {
        if (eventMatchesPrediction(event, prediction)) return command;
        continue;
      }
      if (looseFallback === undefined && CONTAINER_DRIVER.test(command)) looseFallback = command;
    }
    return looseFallback;
  }

  private revive(entry: ArchivedContainerEgg, state: ContainerState): ContainerEgg {
    const egg: ContainerEgg = {
      pid: entry.pid,
      containerId: state.id,
      name: state.name || entry.name,
      image: state.image || entry.image,
      // A restart while the session was closed resets the lifetime; otherwise
      // the archived start (the daemon's event timestamp) is the honest one.
      startedAt: entry.status === "running" ? entry.startedAt : state.startedAt ?? entry.startedAt,
      command: entry.command,
      status: "running",
    };
    this.eggs.set(entry.pid, egg);
    this.byContainer.set(state.id, entry.pid);
    return egg;
  }

  /** The container ended while the session was closed: correct the stale egg. */
  private correctExit(entry: ArchivedContainerEgg, state: ContainerState | undefined): void {
    const egg: ContainerEgg = {
      pid: entry.pid,
      containerId: state?.id ?? entry.containerId ?? "",
      name: state?.name || entry.name,
      image: state?.image || entry.image,
      startedAt: entry.startedAt,
      command: entry.command,
      status: "exited",
      exitedAt: state?.finishedAt ?? Date.now(),
      exitCode: state?.exitCode,
    };
    this.eggs.set(entry.pid, egg);
    this.publish(egg);
  }

  /**
   * Drop an egg that was never this session's work from the resumed live view.
   * The archive keeps the original record; `retired` only tells recipients to
   * drop the pid (the same shape ProcessWatcher uses for bounded history).
   */
  private retire(entry: ArchivedContainerEgg): void {
    this.emit({
      pid: entry.pid,
      ppid: 0,
      name: entry.name,
      commandLine: entry.commandLine,
      status: "exited",
      startedAt: entry.startedAt,
      exitedAt: entry.exitedAt ?? entry.startedAt,
      exitCode: entry.exitCode,
      children: 0,
      command: entry.command,
      kind: "primary",
      kindReason: "docker container",
      retired: true,
    });
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
      containerId: egg.containerId,
      kind: "primary",
      kindReason: "docker container",
    });
  }
}
