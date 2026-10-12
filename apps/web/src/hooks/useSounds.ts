import { useEffect, useRef } from "react";
import type { AbsenceEvent } from "@absence/core";
import { isAgentBusy } from "@absence/core";
import type { AttentionLevel } from "../types/report";
import { useSessionStore } from "../stores/sessionStore";
import { playApproval, playAttention, playComplete, startSoundCoveragePolling } from "../lib/sounds";
import { memoBuildHistory } from "../lib/history";
import { buildRunFacts, renderLive } from "../lib/report";
import { useSettingsStore } from "../stores/settingsStore";

/**
 * Absence's voice, such as it is: three chimes hooked onto the event stream.
 *
 * - **attention change** — the live Human-attention level moved across a
 *   threshold (into, or out of, medium/high). Driven from a live reduction of
 *   the current run, not from the report overlay, so it works while the report
 *   is closed.
 * - **approval waiting** — the runtime raised an approval prompt and is blocked
 *   on the user's decision. Rung once per approval id, because the agent cannot
 *   make progress without an answer and the user may be looking elsewhere.
 * - **run complete** — `agent_end` after activity: the agent has a reply.
 *
 * Silent until the user interacts with the page (the browser's autoplay
 * policy), which is the right default: sound arrives only for sessions you
 * have already touched.
 */
export function useSounds(): void {
  const events = useSessionStore((s) => s.events);
  const status = useSessionStore((s) => s.agent.status);
  const prevAttention = useRef<AttentionLevel>("none");
  const hadActivity = useRef(false);
  const voicedApprovals = useRef<Set<string>>(new Set());

  // Poll which events the active custom sound set covers, so uploaded chimes
  // play instead of the synthesised ones without a reload.
  useEffect(() => {
    startSoundCoveragePolling();
  }, []);

  useEffect(() => {
    const last = events[events.length - 1];

    // A pending approval is the one thing the user must act on, so it rings
    // regardless of where the run stands. Replays and re-renders re-deliver the
    // same event, so the id set keeps it to one chime per prompt.
    if (last?.type === "approval" && !voicedApprovals.current.has(last.payload.id)) {
      voicedApprovals.current.add(last.payload.id);
      playApproval();
    }

    if (last?.type === "agent_start") {
      hadActivity.current = false;
      voicedApprovals.current.clear();
    }
    if (last && last.type !== "agent_start" && last.type !== "agent_end") hadActivity.current = true;
    if (last?.type === "agent_end") {
      if (hadActivity.current && last.payload.reason !== "aborted") playComplete();
      hadActivity.current = false;
      prevAttention.current = "none";
      return;
    }
    if (!last) return;

    // The live attention level of the newest run, computed over its slice only.
    // Same engine the report uses, just re-run as events arrive.
    const level = liveAttentionLevel(events);
    if (
      level !== prevAttention.current &&
      (level === "medium" || level === "high" || prevAttention.current === "high")
    ) {
      playAttention(level === "high" ? "high" : "medium");
    }
    prevAttention.current = level;
  }, [events, status]);
}

/** Re-derive the live attention level for the newest run. */
function liveAttentionLevel(events: AbsenceEvent[]): AttentionLevel {
  if (events.length === 0) return "none";
  const runs = memoBuildHistory(events);
  const run = runs[runs.length - 1];
  if (!run || run.status !== "running") return "none";
  const facts = buildRunFacts(events, run);
  const busy = isAgentBusy(useSessionStore.getState().agent.status);
  const { commandFailThreshold, commandFailLevel, commandStreakThreshold, commandStreakLevel, activityStallThreshold, activityStallLevel } =
    useSettingsStore.getState();
  return renderLive(
    facts,
    { busy },
    {
      commandFailThreshold,
      commandFailLevel,
      commandStreakThreshold,
      commandStreakLevel,
      activityStallThreshold,
      activityStallLevel,
    },
  ).attention.level;
}
