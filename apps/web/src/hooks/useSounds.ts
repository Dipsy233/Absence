import { useEffect, useRef } from "react";
import type { AbsenceEvent } from "@absence/core";
import { isAgentBusy } from "@absence/core";
import type { AttentionLevel } from "../types/report";
import { useEvents, useSessionStore } from "../stores/sessionStore";
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
  const events = useEvents();
  const status = useSessionStore((s) => s.agent.status);
  const prevAttention = useRef<AttentionLevel>("none");
  const hadActivity = useRef(false);
  const voicedApprovals = useRef<Set<string>>(new Set());
  /** When the attention clamp last ran, so the reduction is not run per token. */
  const lastAttentionAt = useRef(0);
  const attentionTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

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
      lastAttentionAt.current = 0;
      return;
    }
    if (!last) return;

    if (!attentionMayHaveChanged(last)) return;

    // `buildRunFacts` walks the run's slice, so running it on every streamed
    // token is the largest per-event cost in the UI. Clamp it to at most twice
    // a second: an attention level does not need token resolution, and the
    // trailing call makes sure the last event still gets judged.
    const ATTENTION_INTERVAL_MS = 500;
    const judge = () => {
      attentionTimer.current = undefined;
      lastAttentionAt.current = Date.now();
      const level = liveAttentionLevel(useSessionStore.getState().events);
      if (
        level !== prevAttention.current &&
        (level === "medium" || level === "high" || prevAttention.current === "high")
      ) {
        playAttention(level === "high" ? "high" : "medium");
      }
      prevAttention.current = level;
    };
    const since = Date.now() - lastAttentionAt.current;
    if (since >= ATTENTION_INTERVAL_MS) {
      if (attentionTimer.current !== undefined) clearTimeout(attentionTimer.current);
      judge();
    } else if (attentionTimer.current === undefined) {
      attentionTimer.current = setTimeout(judge, ATTENTION_INTERVAL_MS - since);
    }
  }, [events, status]);

  // A pending timer holds the newest event, so it still runs after unmount is
  // not needed — but leaving it armed across a session switch would judge the
  // wrong stream. Clear it on teardown.
  useEffect(
    () => () => {
      if (attentionTimer.current !== undefined) clearTimeout(attentionTimer.current);
    },
    [],
  );
}

/**
 * Which events can move the live attention level. Streaming text, thoughts and
 * process churn cannot: the level is derived from commands, failures, file
 * writes and how long the run has been quiet. Skipping the rest keeps the
 * reduction off the hot path of token-by-token delivery.
 */
function attentionMayHaveChanged(event: AbsenceEvent): boolean {
  switch (event.type) {
    case "command":
    case "tool_end":
    case "file_write":
    case "file_edit":
    case "error":
      return true;
    default:
      return false;
  }
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
