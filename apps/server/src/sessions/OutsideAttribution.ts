import { toPosix } from "../util/paths";

/**
 * Which outside file changes belong to the agent.
 *
 * The filesystem watcher also watches the project's parent directory (shallow),
 * so an agent that quietly edits a file outside its own project is still seen.
 * But a parent directory holds *sibling projects*, and those have agents of
 * their own: with two agents working side by side, every edit one of them makes
 * lands in the other's watcher too. Reporting it there would be a lie about
 * what the observed agent did — its Activity would fill with another agent's
 * work.
 *
 * So attribution is earned: a path counts as the agent's only when the agent
 * itself recently wrote through a tool Absence could see — an adapter
 * `file_write`/`file_edit` when driving, a transcript tool call when observing.
 * A change on such a path is the agent's echo; anything else is somebody else's
 * work and is not reported. A shell write outside the project (`sed -i` on a
 * temp file) is therefore not echoed as a `file_change` — the run row already
 * shows the command that carried it.
 */
export class OutsideAttribution {
  private readonly writtenAt = new Map<string, number>();

  constructor(private readonly windowMs: number) {}

  /** The agent wrote (or deleted) this absolute path through a tool. */
  note(absolutePath: string, at = Date.now()): void {
    this.writtenAt.set(key(absolutePath), at);
    if (this.writtenAt.size > 256) {
      for (const [key, value] of this.writtenAt) {
        if (at - value > this.windowMs) this.writtenAt.delete(key);
      }
    }
  }

  /** True when a change on this path can be read as the agent's doing. */
  owns(absolutePath: string, now = Date.now()): boolean {
    const at = this.writtenAt.get(key(absolutePath));
    return at !== undefined && now - at <= this.windowMs;
  }

  /**
   * Spend the attribution: the watcher just echoed the agent's own write, so
   * the record is done. What remains of this path's window shrinks to a short
   * tail — long enough for the write's own trailing watcher events (a create
   * followed by a flush, an editor's second save) to still count as one
   * write, short enough that a sibling agent's later edit of the same file
   * cannot ride the rest of the window as this agent's doing.
   */
  demote(absolutePath: string, now = Date.now()): void {
    const at = this.writtenAt.get(key(absolutePath));
    if (at === undefined) return;
    this.writtenAt.set(key(absolutePath), now - this.windowMs + ECHO_TAIL_MS);
  }
}

/** How long a claimed echo stays attributable, for its own duplicate events. */
const ECHO_TAIL_MS = 5_000;

/** Paths are matched case-insensitively and in posix form: Windows watchers
 * report the same file through either separator or casing. */
function key(absolutePath: string): string {
  return toPosix(absolutePath).toLowerCase();
}
