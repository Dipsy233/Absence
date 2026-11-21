/**
 * Observation metadata — what makes a session *observed* rather than *driven*.
 *
 * A driven session (the legacy picker flow) spawns the agent through ACP and
 * talks to it. An observed session owns no agent: it watches a transcript the
 * agent software writes itself, plus the OS around the project. `observe` is
 * set exactly when the session must never be prompted, aborted or answered —
 * the write-back paths guard on it.
 */
export interface ObserveMeta {
  /** How the facts reach Absence. Phase 1 ships the transcript channel. */
  channel: "transcript";
  /** The agent software's own session id (Claude Code's `sessionId`, …). */
  externalId: string;
  /** The transcript file being tailed, when the channel has one. */
  transcriptFile?: string;
  /**
   * False for a transcript whose project is a wholesale scope (the user's
   * home directory itself, a drive root): the transcript facts are still
   * observed, but Absence starts no project tree or file watcher there —
   * watching a whole home is not observation, it is a hazard (junction
   * storms on Windows, a tree the size of the disk).
   */
  watchProject?: boolean;
}
