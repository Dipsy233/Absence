import type { AttentionReason } from "../types/report";

/**
 * The one human sentence per attention reason — the single source for every
 * face that renders a verdict (the report overlay, the chart, the shared
 * atoms). Keys are the English sentences; call sites translate them through
 * the i18n table.
 */
export const ATTENTION_REASON_TEXT: Record<AttentionReason, string> = {
  command_failed: "A command failed",
  command_failure_streak: "Commands failed back-to-back — the agent may be flailing",
  activity_stalled: "No activity for a long time — something may be stuck",
  unresolved_error: "Unresolved error — no successful recovery detected",
  agent_waiting: "Agent is waiting",
  agent_stopped: "Agent stopped",
  no_progress: "No progress detected",
  external_change: "External file change observed",
  process_left_running: "A process the agent started is still running",
  outside_change: "A file outside the project was changed",
  file_version_loop: "File versions oscillated — the agent may have undone its own edit",
  command_retry_loop: "The same command failed repeatedly",
};
