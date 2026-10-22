import chokidar, { type FSWatcher } from "chokidar";
import path from "node:path";
import os from "node:os";
import { isIgnoredDir, isIgnoredFile } from "./FileTree";

export type FsChangeKind = "created" | "modified" | "deleted";

const WATCH_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".cache", ".turbo", ".vite"]);

/**
 * The project's parent directory, watched so the agent cannot quietly edit
 * files *outside* the project. Only when the parent is a reasonable size — a
 * workspace folder, not the home directory or a drive root, which would sweep
 * the whole machine in. The parent's other children are watched shallowly
 * (depth 2) so an `E:​\..\other-project\src\x.ts` edit is still seen.
 */
export function outsideWatchRoot(projectPath: string): string | undefined {
  const parent = path.dirname(path.resolve(projectPath));
  const root = path.parse(parent).root;
  // Too big to watch: the home directory itself, or a drive root.
  if (parent === os.homedir() || parent === root) return undefined;
  return parent;
}

/**
 * Watches a project directory (read.md §27). Agent tool events are not
 * enough: files also change through bash/sed/python, so we observe the
 * filesystem directly too.
 */
export class FileWatcher {
  private watcher?: FSWatcher;
  /** Second watcher over the project's parent, for changes outside the project. */
  private outside?: FSWatcher;

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

  async close(): Promise<void> {
    await this.watcher?.close();
    await this.outside?.close();
    this.watcher = undefined;
    this.outside = undefined;
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
