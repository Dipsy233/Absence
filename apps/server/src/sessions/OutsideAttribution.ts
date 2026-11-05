import { toPosix } from "../util/paths";

/**
 * Which outside file changes belong to the agent.
 *
 * A change outside the project is only the observed agent's when the agent
 * itself reported work on that exact path. The watch may be the permanent
 * parent-directory watcher or an on-demand watcher opened because a tool or
 * command named the path; attribution does not care which one saw the event.
 * Two signals make that safe:
 *
 *  - **Time.** The claim lapses after a window (120 s for a tool-reported write,
 *    shorter when the path was only named by a command).
 *  - **Content.** A tool write carries the content it produced. The watcher's
 *    later event carries the content actually on disk. If the two differ, the
 *    change was somebody else's (a sibling agent saving the same shared file),
 *    however close it arrived. This is the same idea as the in-project echo
 *    check, applied outside.
 *
 * Shell writes outside the project are not covered by content matching (the
 * command declares no content); they are given a short window instead. The
 * run row already shows the command that carried the write.
 */
export interface OutsideClaim {
  at: number;
  /** What the agent said it wrote. Undefined means "time only" (command-named). */
  content?: string | null;
  /** How long this claim stays live; defaults to the watcher's window. */
  windowMs?: number;
}

export class OutsideAttribution {
  private readonly writtenAt = new Map<string, OutsideClaim>();

  constructor(private readonly windowMs: number) {}

  /** The agent reported a write (or a command named this path). */
  note(
    absolutePath: string,
    at = Date.now(),
    content?: string | null,
    windowMs?: number,
  ): void {
    this.writtenAt.set(key(absolutePath), {
      at,
      ...(content !== undefined ? { content } : {}),
      ...(windowMs !== undefined ? { windowMs } : {}),
    });
    if (this.writtenAt.size > 256) {
      for (const [path, claim] of this.writtenAt) {
        if (at - claim.at > (claim.windowMs ?? this.windowMs)) this.writtenAt.delete(path);
      }
    }
  }

  /** True while the path has a live claim (cheap; no disk read). */
  has(absolutePath: string, now = Date.now()): boolean {
    const claim = this.writtenAt.get(key(absolutePath));
    if (claim === undefined) return false;
    return now - claim.at <= (claim.windowMs ?? this.windowMs);
  }

  /**
   * True when a change on this path can be read as the agent's doing.
   *
   * `content` is what the watcher found on disk. When the claim carries the
   * agent's reported content, a different value on disk is somebody else's
   * write and this returns false.
   */
  owns(absolutePath: string, now = Date.now(), content?: string | null): boolean {
    const claim = this.writtenAt.get(key(absolutePath));
    if (claim === undefined) return false;
    if (now - claim.at > (claim.windowMs ?? this.windowMs)) return false;
    if (claim.content === undefined) return true;
    if (content === undefined) return false;
    return claim.content === content;
  }

  /**
   * Spend the attribution: the watcher just echoed the agent's own write. The
   * remaining claim shrinks to a short tail so the write's own duplicate events
   * (create then flush) still count, while a sibling's later edit of the same
   * path cannot ride the rest of the window.
   */
  demote(absolutePath: string, now = Date.now()): void {
    const claim = this.writtenAt.get(key(absolutePath));
    if (claim === undefined) return;
    const window = claim.windowMs ?? this.windowMs;
    this.writtenAt.set(key(absolutePath), {
      at: now - window + ECHO_TAIL_MS,
      ...(claim.content !== undefined ? { content: claim.content } : {}),
      ...(claim.windowMs !== undefined ? { windowMs: claim.windowMs } : {}),
    });
  }
}

/** How long a claimed echo stays attributable, for its own duplicate events. */
const ECHO_TAIL_MS = 1_000;

/** Paths are matched case-insensitively and in posix form: Windows watchers
 * report the same file through either separator or casing. */
function key(absolutePath: string): string {
  return toPosix(absolutePath).toLowerCase();
}
