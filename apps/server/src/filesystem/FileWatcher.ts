import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import os from "node:os";
import { isIgnoredDir, isIgnoredFile } from "./FileTree";

export type FsChangeKind = "created" | "modified" | "deleted";

const WATCH_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".cache", ".turbo", ".vite"]);

/** How many external directories and target files may be watched at once. */
const MAX_EXTERNAL_DIRS = 32;
const MAX_EXTERNAL_PATHS = 128;

/** Default lifetime of an on-demand external watch (a tool/command claim). */
export const EXTERNAL_WATCH_TTL_MS = 15_000;

/**
 * Why on-demand instead of a permanent broad watcher.
 *
 * The project itself is watched recursively because every file in it matters.
 * Outside the project only the paths this session has *named* can be its work:
 * a tool reported them, or a command line mentioned them. Those paths get a
 * small non-recursive watcher on their parent directory for a bounded lifetime,
 * then the watcher is closed. Watching the home directory or a drive root
 * permanently would report every other agent's work and cost far more than it
 * tells us.
 */
interface ExternalEntry {
  watcher: FSWatcher;
  /** Absolute file paths inside this directory that are of interest. */
  targets: Map<
    string,
    {
      onChange: (kind: FsChangeKind, absolutePath: string) => void;
      timer: ReturnType<typeof setTimeout>;
      registeredAt: number;
    }
  >;
  lastUsed: number;
}

/**
 * The project's parent directory, watched so the agent cannot quietly edit
 * files *outside* the project. Only when the parent is a reasonable size — a
 * workspace folder, not the home directory or a drive root, which would sweep
 * the whole machine in. The parent's other children are watched shallowly
 * (depth 2) so an `E:​\..\other-project\src\x.ts` edit is still seen.
 *
 * This remains the cheap default for sibling projects. Paths beyond this
 * shallow root are covered on demand (`watchExternalFile`).
 */
export function outsideWatchRoot(projectPath: string): string | undefined {
  const parent = path.dirname(path.resolve(projectPath));
  const root = path.parse(parent).root;
  // Too big to watch: the home directory itself, or a drive root.
  if (parent === os.homedir() || parent === root) return undefined;
  return parent;
}

/**
 * Watches a project directory and a bounded set of named outside paths
 * (read.md §27). Agent tool events are not enough: files also change through
 * bash/sed/python, so we observe the filesystem directly too.
 */
export class FileWatcher {
  private watcher?: FSWatcher;
  /** Second watcher over the project's parent, for changes outside the project. */
  private outside?: FSWatcher;
  /** On-demand non-recursive watchers for named paths outside the parent. */
  private readonly external = new Map<string, ExternalEntry>();

  constructor(
    private readonly cwd: string,
    private readonly onChange: (kind: FsChangeKind, absolutePath: string) => void,
    private readonly onOutsideChange?: (kind: FsChangeKind, absolutePath: string) => void,
  ) {}

  /**
   * Start watching and resolve once chokidar has finished its initial scan.
   *
   * `ignoreInitial` means no events are emitted for existing files, but a write
   * that lands before the scan completes is still missed. Awaiting `ready` makes
   * "the session has started" mean "changes from now on are observed", which is
   * what callers (and the fsdiff check) assume.
   */
  async start(): Promise<void> {
    this.watcher = chokidar.watch(this.cwd, {
      ignoreInitial: true,
      depth: 8,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      ignored: (candidate: string) => {
        const base = candidate.split(/[\\/]/).pop() ?? candidate;
        return WATCH_IGNORE_DIRS.has(base) || isIgnoredFile(base);
      },
    });

    this.watcher.on("add", (p) => this.onChange("created", p));
    this.watcher.on("change", (p) => this.onChange("modified", p));
    this.watcher.on("unlink", (p) => this.onChange("deleted", p));

    // Outside the project: the parent directory minus the project itself,
    // shallow. A change there is rare and worth a human's attention — the agent
    // has no business writing outside the workspace it was given.
    const outsideRoot = outsideWatchRoot(this.cwd);
    if (this.onOutsideChange && outsideRoot) {
      const projectAbs = path.resolve(this.cwd);
      this.outside = chokidar.watch(outsideRoot, {
        ignoreInitial: true,
        depth: 2,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
        ignored: (candidate: string) => {
          const abs = path.resolve(candidate);
          if (abs === projectAbs || abs.startsWith(projectAbs + path.sep)) return true;
          const base = candidate.split(/[\\/]/).pop() ?? candidate;
          return WATCH_IGNORE_DIRS.has(base) || isIgnoredFile(base) || isIgnoredDir(base);
        },
      });
      this.outside.on("add", (p) => this.onOutsideChange!("created", p));
      this.outside.on("change", (p) => this.onOutsideChange!("modified", p));
      this.outside.on("unlink", (p) => this.onOutsideChange!("deleted", p));
    }

    await Promise.all([whenReady(this.watcher), whenReady(this.outside)]);
  }

  /**
   * Watch one named file outside the project's tree, for a bounded time.
   *
   * The watcher is on the file's parent directory, non-recursive, so any number
   * of named files in the same directory share one watcher. Only events whose
   * resolved path equals the registered target are delivered; the rest of the
   * directory is ignored. The returned release function (or the TTL) removes
   * the target, and the directory watcher closes when its last target goes.
   *
   * Failure (permissions, a vanished directory) is swallowed: no watch means no
   * outside event, never a full-disk polling fallback.
   */
  watchExternalFile(
    absolutePath: string,
    onChange: (kind: FsChangeKind, absolutePath: string) => void,
    ttlMs = EXTERNAL_WATCH_TTL_MS,
  ): () => void {
    if (!this.onOutsideChange) return () => {};
    const target = path.resolve(absolutePath);
    const dir = path.dirname(target);
    let entry = this.external.get(dir);
    if (!entry) {
      if (this.external.size >= MAX_EXTERNAL_DIRS) this.evictOldestDirectory();
      try {
        const watcher = chokidar.watch(dir, {
          ignoreInitial: true,
          depth: 0,
          awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
        });
        entry = { watcher, targets: new Map(), lastUsed: Date.now() };
        watcher.on("add", (p) => this.routeExternal(dir, "created", p));
        watcher.on("change", (p) => this.routeExternal(dir, "modified", p));
        watcher.on("unlink", (p) => this.routeExternal(dir, "deleted", p));
        watcher.on("error", () => {
          // The watch degrades to no outside events; the session stays usable.
        });
        this.external.set(dir, entry);
      } catch {
        return () => {};
      }
    }
    entry.lastUsed = Date.now();
    if (this.totalExternalTargets() >= MAX_EXTERNAL_PATHS && !entry.targets.has(target)) {
      this.evictOldestTarget();
    }
    const previous = entry.targets.get(target);
    if (previous) clearTimeout(previous.timer);
    const timer = setTimeout(() => this.releaseExternal(dir, target), Math.max(100, ttlMs));
    timer.unref?.();
    entry.targets.set(target, { onChange, timer, registeredAt: Date.now() });
    return () => this.releaseExternal(dir, target);
  }

  /** Live registrations, for the regression check and diagnostics. */
  externalStats(): { dirs: number; paths: number } {
    return { dirs: this.external.size, paths: this.totalExternalTargets() };
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    await this.outside?.close();
    this.watcher = undefined;
    this.outside = undefined;
    for (const entry of this.external.values()) {
      for (const target of entry.targets.values()) clearTimeout(target.timer);
      await entry.watcher.close().catch(() => undefined);
    }
    this.external.clear();
  }

  private routeExternal(dir: string, kind: FsChangeKind, candidate: string): void {
    const entry = this.external.get(dir);
    if (!entry) return;
    const target = path.resolve(candidate);
    const listener = entry.targets.get(target);
    if (!listener) return;
    entry.lastUsed = Date.now();
    listener.onChange(kind, target);
  }

  private releaseExternal(dir: string, target: string): void {
    const entry = this.external.get(dir);
    if (!entry) return;
    const listener = entry.targets.get(target);
    if (listener) clearTimeout(listener.timer);
    entry.targets.delete(target);
    if (entry.targets.size > 0) return;
    this.external.delete(dir);
    void entry.watcher.close().catch(() => undefined);
  }

  private evictOldestDirectory(): void {
    let oldest: string | undefined;
    let at = Infinity;
    for (const [dir, entry] of this.external) {
      if (entry.lastUsed < at) {
        at = entry.lastUsed;
        oldest = dir;
      }
    }
    if (oldest === undefined) return;
    const entry = this.external.get(oldest);
    if (!entry) return;
    for (const target of entry.targets.values()) clearTimeout(target.timer);
    this.external.delete(oldest);
    void entry.watcher.close().catch(() => undefined);
  }

  private evictOldestTarget(): void {
    let oldestDir: string | undefined;
    let oldestTarget: string | undefined;
    let at = Infinity;
    for (const [dir, entry] of this.external) {
      for (const [target, listener] of entry.targets) {
        if (listener.registeredAt < at) {
          at = listener.registeredAt;
          oldestDir = dir;
          oldestTarget = target;
        }
      }
    }
    if (oldestDir !== undefined && oldestTarget !== undefined) {
      this.releaseExternal(oldestDir, oldestTarget);
    }
  }

  private totalExternalTargets(): number {
    let count = 0;
    for (const entry of this.external.values()) count += entry.targets.size;
    return count;
  }
}

/** Resolve when a chokidar watcher has completed its initial scan. */
function whenReady(watcher: FSWatcher | undefined): Promise<void> {
  if (!watcher) return Promise.resolve();
  return new Promise((resolve) => {
    // `error` also resolves: a watcher that cannot start must not wedge the
    // session, and the rest of Absence degrades to tool events as before.
    watcher.once("ready", () => resolve());
    watcher.once("error", () => resolve());
  });
}

export { isIgnoredDir };
