/**
 * The agent's terminal, mirrored — Layer 1 of docs/decoupling.md.
 *
 * An observed agent is somebody else's program. It already has a terminal; the
 * only thing Absence may do with it is *look*. This is the looking:
 *
 *   agent ──PTY──► its real TTY (colours, TUI, keys all work as before)
 *             └──► the same bytes, copied here
 *
 * Three rules, each of which comes from a failure mode:
 *
 * 1. **Never block the agent.** The mirror writes into a ring buffer and drops
 *    the oldest output when nobody is reading. An agent that floods its
 *    terminal must not be slowed down by the fact that we are watching.
 * 2. **Never interpret.** The bytes are ANSI and cursor motion. Absence does
 *    not parse them, does not strip them, does not turn them into events. The
 *    moment it does, it is coupled to a specific agent's output format — the
 *    exact coupling this branch exists to remove.
 * 3. **Bounded.** A session that runs for hours cannot grow this without
 *    limit. Only the tail is kept, and the same tail is what a late subscriber
 *    is handed.
 *
 * The bytes are *not* AbsenceEvents. A CLI redrawing a spinner emits hundreds of
 * writes a second; routing that through the event stream would flush the
 * History window in seconds and make the Report unreadable.
 */

/** How much scrollback to keep. Enough for a full screen plus history. */
const RING_BYTES = 256 * 1024;
/** How often a subscriber is flushed, so a burst is one message, not hundreds. */
const FLUSH_MS = 60;

export type TerminalListener = (chunk: string) => void;

/**
 * The mirrored terminal of one session.
 *
 * `push` is called from the PTY's data callback, which is a hot path: it
 * appends to a buffer and schedules a flush. Subscribers get at most one
 * message per `FLUSH_MS`, joined, so a redraw is a handful of frames rather
 * than a thousand sockets writes.
 */
export class TerminalMirror {
  private ring = "";
  /** Bytes dropped since the last flush, so the UI can say it fell behind. */
  private dropped = 0;
  private pending: string[] = [];
  private listeners = new Set<TerminalListener>();
  private timer?: ReturnType<typeof setTimeout>;
  /** True once the process has ended; late subscribers get the final tail. */
  private ended = false;

  /** Append output from the agent. Never throws, never blocks. */
  push(chunk: string): void {
    if (!chunk) return;
    this.ring += chunk;
    if (this.ring.length > RING_BYTES) {
      // Drop from the front, on a line boundary when one is close by: slicing
      // mid-escape-sequence would leave the next reader with a broken code.
      const cut = this.ring.length - RING_BYTES;
      const newline = this.ring.indexOf(String.fromCharCode(10), cut);
      const at = newline !== -1 && newline - cut < 4096 ? newline + 1 : cut;
      this.dropped += at;
      this.ring = this.ring.slice(at);
    }
    if (this.listeners.size === 0) return;
    this.pending.push(chunk);
    this.schedule();
  }

  /** The agent exited. No more output; subscribers keep the tail and are told. */
  end(): void {
    this.ended = true;
    this.flush();
  }

  get finished(): boolean {
    return this.ended;
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  /** Everything still held, for a client that connects mid-run. */
  tail(): string {
    return this.ring;
  }

  /**
   * Subscribe. The callback receives joined output, at most once per flush.
   * A late subscriber is handed the tail first, so a reconnect does not start
   * from a blank screen.
   */
  subscribe(listener: TerminalListener): () => void {
    this.listeners.add(listener);
    if (this.ring.length > 0) listener(this.ring);
    return () => {
      this.listeners.delete(listener);
    };
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.listeners.clear();
    this.pending = [];
    this.ring = "";
  }

  private schedule(): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_MS);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const chunk = this.pending.join("");
    this.pending = [];
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        // One dead subscriber must not stop the others.
      }
    }
  }
}
