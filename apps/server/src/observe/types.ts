import os from "node:os";
import path from "node:path";

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
   *    itself, so this channel carries kernel-grade process attribution.
   */
  channel: "transcript" | "acp-proxy";
  /**
   * The agent-side identity of the observed conversation: the transcript's
   * session id, or the proxy session's own id. Idempotent attach keys on
   * (channel, externalId).
   */
  externalId: string;
  /** The transcript file being tailed, when the channel has one. */
  transcriptFile?: string;
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
