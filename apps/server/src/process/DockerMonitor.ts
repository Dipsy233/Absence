import { spawn, execFile, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { config } from "../config";

const run = promisify(execFile);

/**
 * The Docker observer: what the kernel observers structurally cannot see.
 *
 * A container's processes live inside the daemon's VM (Docker Desktop) or a WSL
 * distro — never in the Job Object's tree and never under eBPF's pid space. The
 * daemon, however, watches them first-hand: `docker events` reports every
 * container's lifecycle (`start`, `die` with the real exit code), and
 * `docker stats` streams per-container CPU and memory. This module runs those
 * two streams as sidecars and republishes what they report — the same role
 * `JobSidecar` plays for the Job Object.
 *
 * One instance per server process, created before any session needs it.
 * Sessions subscribe through `onContainer`; per-container resource numbers are
 * read on demand through `resourceOf` (the stats stream is integrated into a
 * cumulative CPU counter there, matching the shape the metrics sampler wants).
 */

/** A container lifecycle event, in the shape ProcessWatcher's attribution wants. */
export interface ContainerEvent {
  kind: "start" | "exit";
  /** Full 64-hex container id, as both `docker events` and `docker stats` key it. */
  containerId: string;
  /** The container's human name (`absence-e2e-nginx`). */
  name: string;
  /** The image the container runs (`nginx:alpine`). */
  image: string;
  /** The compose project the container belongs to, when the daemon says so. */
  project?: string;
  /** Unix ms of the daemon's own timestamp for the event. */
  at: number;
  /** The container's exit code, on `die`. */
  exitCode?: number;
}

/** The latest resource counters `docker stats` has streamed for one container. */
export interface ContainerResource {
  /** Cumulative CPU seconds, integrated from the stream's instantaneous percent. */
  cpuSeconds: number;
  rssBytes: number;
}

interface DockerCommand {
  file: string;
  args: string[];
}

type Listener = (event: ContainerEvent) => void;

/** Restart debounce, copied from JobSidecar: a stream that dies instantly must not loop. */
const MAX_RESTARTS = 5;
const RESTART_DELAY_MS = 500;
/** A `docker events` that exits this fast after a clean spawn never really watched. */
const START_GRACE_MS = 3_000;

export class DockerMonitor {
  private static instance?: DockerMonitor;

  static get(): DockerMonitor {
    DockerMonitor.instance ??= new DockerMonitor();
    return DockerMonitor.instance;
  }

  private readonly emitter = new EventEmitter();
  private command?: DockerCommand;
  private eventsChild?: ChildProcess;
  private statsChild?: ChildProcess;
  private buffer = "";
  private statusValue: WatchStatusLocal = "starting";
  private statusDetailValue?: string;
  private disposed = false;
  private started = false;
  private startPromise?: Promise<void>;
  private restarts = 0;
  private restartTimer?: NodeJS.Timeout;
  private readonly resources = new Map<string, ContainerResource & { at: number }>();

  get available(): boolean {
    return this.statusValue === "watching";
  }

  get status(): WatchStatusLocal {
    return this.statusValue;
  }

  get statusDetail(): string | undefined {
    return this.statusDetailValue;
  }

  onContainer(listener: Listener): () => void {
    this.emitter.on("container", listener);
    return () => this.emitter.off("container", listener);
  }

  onStatus(listener: (status: WatchStatusLocal, detail?: string) => void): () => void {
    this.emitter.on("status", listener);
    return () => this.emitter.off("status", listener);
  }

  /**
   * Resolve the docker CLI and open the event stream. Resolves when the stream
   * is live — or rejects when docker is absent, which the caller treats as
   * "no container watching on this machine", never as a session failure.
   */
  start(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error("docker monitor disposed"));
    if (!config.dockerEnabled) {
      this.setStatus("unavailable", "disabled (ABSENCE_DOCKER=0)");
      return Promise.reject(new Error("docker watching disabled"));
    }
    this.startPromise ??= this.startOnce().catch((error: unknown) => {
      this.startPromise = undefined;
      throw error;
    });
    return this.startPromise;
  }

  /**
   * Containers already running when Absence attaches. They have no command to
   * be attributed to; the session lays them as unattributed eggs so the panel
   * is not blind to work that predates it.
   */
  async listRunning(): Promise<Array<{ containerId: string; name: string; image: string }>> {
    const command = await this.command_(); // also the availability probe
    const { stdout } = await run(command.file, [...command.args, "ps", "--no-trunc", "--format", "{{json .}}"], {
      timeout: 15_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    const out: Array<{ containerId: string; name: string; image: string }> = [];
    for (const line of stdout.split("\n")) {
      const parsed = parseJsonObject(line);
      if (!parsed) continue;
      const id = stringOf(parsed, "ID") ?? stringOf(parsed, "Id");
      const names = stringOf(parsed, "Names") ?? stringOf(parsed, "Name");
      if (!id || !names) continue;
      out.push({
        containerId: id,
        name: names.split(",")[0] ?? names,
        image: stringOf(parsed, "Image") ?? "",
      });
    }
    return out;
  }

  /** The stats stream's latest counters for one container, when it has any. */
  resourceOf(containerId: string): ContainerResource | undefined {
    const entry = this.resources.get(containerId);
    if (!entry) return undefined;
    return { cpuSeconds: entry.cpuSeconds, rssBytes: entry.rssBytes };
  }

  dispose(): void {
    this.disposed = true;
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = undefined;
    this.eventsChild?.kill();
    this.statsChild?.kill();
    this.eventsChild = undefined;
    this.statsChild = undefined;
    this.setStatus("unavailable", "stopped");
    this.emitter.removeAllListeners();
    if (DockerMonitor.instance === this) DockerMonitor.instance = undefined;
  }

  // --------------------------------------------------------------------------

  private async startOnce(): Promise<void> {
    const command = await this.command_();
    this.spawnEvents(command);
  }

  /**
   * The docker CLI to drive, in spawn form. `ABSENCE_DOCKER_BIN` wins (it may
   * be a bare binary or a prefix such as `wsl docker`, split on whitespace);
   * otherwise a `docker` on PATH; on Windows finally a WSL distro's docker,
   * which is how Docker lives on a machine without Docker Desktop.
   */
  private async command_(): Promise<DockerCommand> {
    if (this.command) return this.command;
    const override = config.dockerBin?.trim();
    if (override) {
      const parts = override.split(/\s+/).filter(Boolean);
      this.command = { file: parts[0] ?? "docker", args: parts.slice(1) };
      return this.command;
    }
    try {
      await run("docker", ["version", "--format", "ok"], { timeout: 10_000 });
      this.command = { file: "docker", args: [] };
      return this.command;
    } catch {
      if (process.platform !== "win32") throw new Error("no docker CLI on PATH");
      // A WSL distro's daemon: the CLI is `wsl docker`. The probe answers only
      // when the daemon is actually up, so a stopped distro reads as absent.
      await run("wsl", ["docker", "version", "--format", "ok"], { timeout: 30_000 });
      this.command = { file: "wsl", args: ["docker"] };
      return this.command;
    }
  }

  private spawnEvents(command: DockerCommand): void {
    this.setStatus("starting", "docker events");
    const child = spawn(command.file, [...command.args, "events", "--format", "{{json .}}"], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    this.eventsChild = child;
    this.buffer = "";
    const spawnedAt = Date.now();

    child.stdout?.on("data", (chunk: Buffer) => {
      this.buffer += chunk.toString("utf8");
      let index: number;
      while ((index = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, index).replace(/\r$/, "");
        this.buffer = this.buffer.slice(index + 1);
        this.handleEventLine(line);
      }
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      process.stderr.write(`[docker] ${chunk.toString("utf8")}`);
    });

    child.on("error", (error) => {
      if (!this.started) {
        this.setStatus("unavailable", error.message);
      }
    });

    child.on("exit", () => {
      this.eventsChild = undefined;
      if (this.disposed) return;
      if (Date.now() - spawnedAt < START_GRACE_MS && !this.available) {
        // Died before reporting anything: most likely `docker events` itself
        // failed (no daemon, a CLI that predates --format). Report and stop.
        this.setStatus("unavailable", "docker events exited immediately");
        return;
      }
      this.scheduleRestart();
    });

    // The stream says nothing when it is merely healthy. Reaching this point
    // with a live child *is* the ready signal: any real failure surfaces as an
    // early exit, which the exit handler turns into a status.
    this.started = true;
    this.restarts = 0;
    this.setStatus("watching");
  }

  private handleEventLine(line: string): void {
    const parsed = parseJsonObject(line);
    if (!parsed) return;
    // Older daemons say `status`; current ones say `Action`. `Type` guards
    // against network/volume/image events sharing the stream.
    if (stringOf(parsed, "Type") !== "container") return;
    const action = (stringOf(parsed, "Action") ?? stringOf(parsed, "status") ?? "").toLowerCase();
    const actor = isRecord(parsed.Actor) ? parsed.Actor : undefined;
    const attributes = actor && isRecord(actor.Attributes) ? actor.Attributes : undefined;
    const containerId = stringOf(actor, "ID") ?? stringOf(parsed, "id");
    if (!containerId) return;
    const name = stringOf(attributes, "name") ?? stringOf(parsed, "from") ?? containerId.slice(0, 12);
    const image = stringOf(attributes, "image") ?? stringOf(parsed, "from") ?? "";
    const timeNano = numberOr(parsed, "timeNano");
    const at = timeNano ? Math.floor(timeNano / 1e6) : Date.now();

    if (action === "start" || action === "restart") {
      this.ensureStats();
      this.emitter.emit("container", {
        kind: "start",
        containerId,
        name,
        image,
        project: stringOf(attributes, "com.docker.compose.project"),
        at,
      } satisfies ContainerEvent);
      return;
    }
    if (action === "die" || action === "destroy") {
      const code = numberOr(attributes, "exitCode");
      this.emitter.emit("container", {
        kind: "exit",
        containerId,
        name,
        image,
        project: stringOf(attributes, "com.docker.compose.project"),
        at,
        exitCode: action === "die" && Number.isFinite(code) ? code : undefined,
      } satisfies ContainerEvent);
      // No counters will come for a dead container; drop the stale entry.
      this.resources.delete(containerId);
      return;
    }
  }

  /**
   * The stats stream is only worth its own process while something is actually
   * running; the first container start opens it, and it stops with the monitor.
   */
  private ensureStats(): void {
    if (this.statsChild || this.disposed || !this.command) return;
    const command = this.command;
    const child = spawn(
      command.file,
      [...command.args, "stats", "--no-trunc", "--format", "{{json .}}"],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    this.statsChild = child;
    let statsBuffer = "";

    child.stdout?.on("data", (chunk: Buffer) => {
      statsBuffer += chunk.toString("utf8");
      let index: number;
      while ((index = statsBuffer.indexOf("\n")) >= 0) {
        const line = statsBuffer.slice(0, index).replace(/\r$/, "");
        statsBuffer = statsBuffer.slice(index + 1);
        this.handleStatsLine(line);
      }
    });

    child.on("exit", () => {
      this.statsChild = undefined;
      // The stream ends when the daemon goes away; a later start reopens it.
    });
  }

  private handleStatsLine(line: string): void {
    const parsed = parseJsonObject(line);
    if (!parsed) return;
    const containerId = stringOf(parsed, "ID") ?? stringOf(parsed, "Container");
    const cpuPercent = percentOf(stringOf(parsed, "CPUPerc"));
    const memUsage = stringOf(parsed, "MemUsage");
    if (!containerId || cpuPercent === undefined || !memUsage) return;
    const rssBytes = memBytesOf(memUsage);

    const now = Date.now();
    const previous = this.resources.get(containerId);
    // The stream reports an instantaneous percent; the metrics pipeline wants a
    // cumulative counter. Integrate one percent at a time — honest to the
    // second, which is far below the 5s sampling grain the charts show.
    const dt = previous ? Math.min(120, Math.max(0, (now - previous.at) / 1000)) : 0;
    const cpuSeconds = (previous?.cpuSeconds ?? 0) + (cpuPercent / 100) * dt;
    this.resources.set(containerId, { cpuSeconds, rssBytes, at: now });
  }

  private scheduleRestart(): void {
    if (this.restartTimer !== undefined) return;
    if (this.restarts >= MAX_RESTARTS) {
      this.setStatus("unavailable", `docker events stopped after ${this.restarts} restarts`);
      return;
    }
    this.restarts += 1;
    this.setStatus("starting", "restarting docker events");
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined;
      if (this.disposed || !this.command) return;
      this.spawnEvents(this.command);
    }, RESTART_DELAY_MS);
  }

  private setStatus(status: WatchStatusLocal, detail?: string): void {
    const changed = status !== this.statusValue;
    this.statusValue = status;
    this.statusDetailValue = detail;
    if (changed || detail) this.emitter.emit("status", status, detail);
  }
}

type WatchStatusLocal = "starting" | "watching" | "unavailable";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  // `docker stats` sprinkles ANSI cursor sequences around its JSON lines even
  // when piped; `docker events` is clean. Strip them so both parse the same way.
  const trimmed = line
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "")
    .trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringOf(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberOr(record: Record<string, unknown> | undefined, key: string): number | undefined {
  const n = Number(record?.[key]);
  return Number.isFinite(n) ? n : undefined;
}

/** `"12.34%"` → 12.34. */
function percentOf(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : undefined;
}

/** `"4.5MiB / 3.84GiB"` → the usage half, in bytes. */
function memBytesOf(value: string): number {
  const usage = value.split("/")[0]?.trim() ?? "";
  const match = usage.match(/^([\d.]+)\s*(B|KiB|MiB|GiB|TiB|kB|KB|MB|GB|TB)$/i);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1] ?? "0");
  const unit = (match[2] ?? "B").toLowerCase();
  const scale: Record<string, number> = {
    b: 1,
    kb: 1000,
    kib: 1024,
    mb: 1e6,
    mib: 1024 ** 2,
    gb: 1e9,
    gib: 1024 ** 3,
    tb: 1e12,
    tib: 1024 ** 4,
  };
  return Math.max(0, amount * (scale[unit] ?? 1));
}
