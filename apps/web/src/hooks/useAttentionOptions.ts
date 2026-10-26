import { useMemo } from "react";
import { useSettingsStore } from "../stores/settingsStore";
import type { ReportAttentionOptions } from "../types/report";

/**
 * The report's attention settings as the engine's options object.
 *
 * Every consumer (the report overlay, the chime hook) must pass the *same*
 * options or they disagree about when to interrupt: the overlay would show a
 * quiet run while the chime kept ringing. Keeping the mapping in one place is
 * also what stopped the three copies from drifting out of sync as reasons were
 * made configurable one at a time.
 *
 * The store is the source of truth; the engine's own defaults cover anything a
 * stale localStorage entry does not have.
 */
export function useAttentionOptions(): ReportAttentionOptions {
  const settings = useSettingsStore();
  return useMemo(
    () => ({
      commandFailThreshold: settings.commandFailThreshold,
      commandFailLevel: settings.commandFailLevel,
      commandStreakThreshold: settings.commandStreakThreshold,
      commandStreakLevel: settings.commandStreakLevel,
      activityStallThreshold: settings.activityStallThreshold,
      activityStallLevel: settings.activityStallLevel,
      agentStoppedLevel: settings.agentStoppedLevel,
      unresolvedErrorLevel: settings.unresolvedErrorLevel,
      processLeftRunningLevel: settings.processLeftRunningLevel,
      processLeftRunningMinSeconds: settings.processLeftRunningMinSeconds,
      processLeftRunningIgnore: settings.processLeftRunningIgnore,
      outsideChangeLevel: settings.outsideChangeLevel,
      outsideChangeIgnore: settings.outsideChangeIgnore,
      fileVersionLoopThreshold: settings.fileVersionLoopThreshold,
      fileVersionLoopLevel: settings.fileVersionLoopLevel,
      commandRetryLoopThreshold: settings.commandRetryLoopThreshold,
      commandRetryLoopLevel: settings.commandRetryLoopLevel,
    }),
    [
      settings.commandFailThreshold,
      settings.commandFailLevel,
      settings.commandStreakThreshold,
      settings.commandStreakLevel,
      settings.activityStallThreshold,
      settings.activityStallLevel,
      settings.agentStoppedLevel,
      settings.unresolvedErrorLevel,
      settings.processLeftRunningLevel,
      settings.processLeftRunningMinSeconds,
      settings.processLeftRunningIgnore,
      settings.outsideChangeLevel,
      settings.outsideChangeIgnore,
      settings.fileVersionLoopThreshold,
      settings.fileVersionLoopLevel,
      settings.commandRetryLoopThreshold,
      settings.commandRetryLoopLevel,
    ],
  );
}

/** The same options, read imperatively (for event handlers and refs). */
export function attentionOptionsNow(): ReportAttentionOptions {
  const s = useSettingsStore.getState();
  return {
    commandFailThreshold: s.commandFailThreshold,
    commandFailLevel: s.commandFailLevel,
    commandStreakThreshold: s.commandStreakThreshold,
    commandStreakLevel: s.commandStreakLevel,
    activityStallThreshold: s.activityStallThreshold,
    activityStallLevel: s.activityStallLevel,
    agentStoppedLevel: s.agentStoppedLevel,
    unresolvedErrorLevel: s.unresolvedErrorLevel,
    processLeftRunningLevel: s.processLeftRunningLevel,
    processLeftRunningMinSeconds: s.processLeftRunningMinSeconds,
    processLeftRunningIgnore: s.processLeftRunningIgnore,
    outsideChangeLevel: s.outsideChangeLevel,
    outsideChangeIgnore: s.outsideChangeIgnore,
    fileVersionLoopThreshold: s.fileVersionLoopThreshold,
    fileVersionLoopLevel: s.fileVersionLoopLevel,
    commandRetryLoopThreshold: s.commandRetryLoopThreshold,
    commandRetryLoopLevel: s.commandRetryLoopLevel,
  };
}
