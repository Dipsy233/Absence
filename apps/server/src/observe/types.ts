import os from "node:os";
import path from "node:path";
import type { ObserveChannel } from "@absence/core";

/**
 * Observation metadata — what makes a session *observed* rather than *driven*.
 *
 * An observed session owns no agent conversation: facts arrive read-only from
 * an observation channel and are pushed into the same event pipeline a driven
 * session uses. `observe` is set exactly when the session must never be
 * prompted, aborted or answered — the write-back paths guard on it.
 */
export interface ObserveMeta {
  /**
   * How the facts reach Absence:
   *  - `transcript` — a tail following the transcript file the agent software
   *    writes on its own (see observe/Discovery.ts);
   *  - `acp-proxy`  — the byte-level ACP proxy tap, when a real ACP client is
   *    pointed at Absence (see agents/acp/proxy/). The proxy spawned the agent
   *    itself, so this channel carries kernel-grade process attribution;
   *  - `os`         — OS observation only: the user chose a running process
   *    that has no content channel. It may be *upgraded* later: when a
   *    transcript proves to belong to the same pid, the session gains the
   *    transcript channel without becoming a different session.
   */
  channel: ObserveChannel;
  /**
   * The agent-side identity of the observed conversation: the transcript's
   * session id, the proxy session's own id, or `pid:<pid>@<startedAtMs>` for a
   * process-only watch. Idempotent attach keys on (channel, externalId).
   */
  externalId: string;
  /** The transcript file being tailed, when the channel has one. */
  transcriptFile?: string;
  /**
   * The process this observation is bound to, when one is bound: the proxy's
   * spawned agent, or the pid the user chose for an OS-only watch.
   */
  pid?: number;
  /**
   * The process start time (epoch ms) that goes with `pid`. A pid is reused by
   * the OS; the pair is the identity, so a recycled pid is never mistaken for
   * the agent this session was watching.
   */
  pidStartedAt?: number;
  /**
   * The channels that currently feed this session, strongest first. Absence
   * may upgrade an OS-only watch to include the transcript channel; the event
   * stream's per-event `source` stays the authority on where each fact came
   * from.
   */
  channels?: ObserveChannel[];
  /**
   * False for a session whose project is a wholesale scope (the user's home
   * directory itself, a drive root): the observed facts still arrive, but
   * Absence starts no project tree or file watcher there — watching a whole
   * home is not observation, it is a hazard (junction storms on Windows, a
   * tree the size of the disk).
   */
  watchProject?: boolean;
}

/**
 * True when the path is a project-sized scope worth watching: not the user's
 * home directory itself and not a drive root. Everything else gets observed
 * facts only (see `ObserveMeta.watchProject`).
 */
export function isNarrowScope(projectPath: string): boolean {
  const resolved = path.resolve(projectPath);
  const parsed = path.parse(resolved);
  if (parsed.root === resolved) return false;
  if (resolved === path.resolve(os.homedir())) return false;
  return true;
}

/** The identity an OS-only watch records for a pid (immune to pid reuse). */
export function pidIdentity(pid: number, startedAt: number): string {
  return `pid:${pid}@${Math.max(0, Math.trunc(startedAt))}`;
}
