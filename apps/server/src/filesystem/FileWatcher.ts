import chokidar, { type FSWatcher } from "chokidar";
import { isIgnoredDir, isIgnoredFile } from "./FileTree";

export type FsChangeKind = "created" | "modified" | "deleted";

const WATCH_IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", "coverage", ".cache", ".turbo", ".vite"]);

/**
 * Watches a project directory (read.md §27). Agent tool events are not
 * enough: files also change through bash/sed/python, so we observe the
 * filesystem directly too.
 */
export class FileWatcher {
  private watcher?: FSWatcher;

  constructor(
    private readonly cwd: string,
    private readonly onChange: (kind: FsChangeKind, absolutePath: string) => void,
  ) {}

  start(): void {
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
  }

  async close(): Promise<void> {
    await this.watcher?.close();
    this.watcher = undefined;
  }
}

export { isIgnoredDir };
