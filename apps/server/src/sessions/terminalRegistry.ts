import type { TerminalMirror } from "../sessions/TerminalMirror";

/**
 * Mirrors waiting to be adopted by an observe session, keyed by the pid of the
 * agent they belong to.
 *
 * This exists for one reason: the terminal mirror is a live object inside the
 * server process (it holds the PTY's data callback), while the session is
 * created over HTTP, whose body can only carry JSON. Rather than teaching the
 * API about PTYs, the CLI registers the mirror here just before it posts, and
 * the route takes it out again — the pid is the only thing both sides know.
 *
 * Scope is deliberately tiny: one process, one hand-over, take-once. An agent
 * Absence did not start never has an entry, which is exactly how the terminal
 * view knows to say "not visible" instead of showing a blank screen.
 */
const waiting = new Map<number, TerminalMirror>();

/** Register a mirror for `pid`. Called by the CLI before it posts the session. */
export function registerTerminalMirror(pid: number, mirror: TerminalMirror): void {
  waiting.set(pid, mirror);
}

/**
 * Take the mirror registered for `pid`, if any.
 *
 * Take-once: a second observe session for the same pid (a re-attach) must not
 * end up sharing a mirror that the first session will dispose.
 */
export function takeTerminalMirror(pid: number): TerminalMirror | undefined {
  const mirror = waiting.get(pid);
  if (mirror) waiting.delete(pid);
  return mirror;
}
