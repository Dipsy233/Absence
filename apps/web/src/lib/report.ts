/**
 * The Absence Report engine now lives in `@absence/core` so the server, the
 * web client and CI all reduce a run the same way. This module re-exports the
 * shared engine under the path the web already imports.
 */
export {
  buildRunFacts,
  renderLive,
  renderRun,
  reasonLevel,
  eventPath,
  countDiff,
  firstLine,
  DEFAULT_COMMAND_FAIL_THRESHOLD,
  DEFAULT_COMMAND_STREAK_THRESHOLD,
  DEFAULT_ACTIVITY_STALL_THRESHOLD,
  DEFAULT_FILE_VERSION_LOOP_THRESHOLD,
  DEFAULT_COMMAND_RETRY_LOOP_THRESHOLD,
  DEFAULT_PROCESS_LEFT_RUNNING_LEVEL,
  DEFAULT_OUTSIDE_CHANGE_LEVEL,
  DEFAULT_FILE_VERSION_LOOP_LEVEL,
  DEFAULT_COMMAND_RETRY_LOOP_LEVEL,
} from "@absence/core";
