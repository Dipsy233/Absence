import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy } from "@daze/core";
import { focusFor, useReplayItem, useStageView } from "../../hooks/useStage";
import { useStageStore } from "../../stores/stageStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { moodFor, type AgentVisualState } from "../../lib/agent";
import { StageItemView } from "../stage/StageItemView";
import { DeskStage } from "../stage/DeskStage";
import { StageToolbar } from "../stage/StageToolbar";
import { ReplayBar } from "../stage/ReplayBar";
import { StageWorld } from "../stage/StageWorld";
import { Avatar } from "../agent/Avatar";
import { StageChat } from "../chat/StageChat";
import { ReportOverlay } from "../stage/ReportOverlay";

/**
 * The Stage: where events become something you can look at (read02 §11).
 *
 * The desk world (StageWorld) is the Stage's *default page* and is always drawn
 * as the background. FILE / DIFF / TERMINAL / LIVE ride on top of it as a
 * slightly translucent sheet, so the desk stays visible underneath.
 */
export function Stage() {
  const { item } = useStageView();
  const replayItem = useReplayItem();
  const mode = useStageStore((s) => s.mode);
  const liveStatus = useSessionStore((s) => s.agent.status);
  const replayStatus = useReplayStore((s) => s.view?.agentStatus);
  const agentOnStage = useUiStore((s) => s.agentOnStage);

  // While replaying, the Stage shows the reconstructed state of the run — the
  // agent's status is part of that, so the avatar must not keep following the
  // live agent while the rest of the Stage is rewound (read02 §26–27).
  const status = mode === "replay" && replayStatus ? replayStatus : liveStatus;

  const focus = focusFor(mode, status, replayItem);
  const visual: AgentVisualState = { status, mood: moodFor(status) };

  let key: string;
  let content: React.ReactNode;
  let sheet: boolean;

  if (mode === "replay") {
    key = `replay:${replayItem?.id ?? "none"}`;
    sheet = !!replayItem;
    content = replayItem ? <StageItemView item={replayItem} /> : <EmptyStage text="Press ▶ to replay this run." />;
  } else if (mode !== "desk" && item) {
    key = item.id;
    sheet = true;
    content = <StageItemView item={item} />;
  } else {
    // TABLE: the default page, regardless of what is pinned.
    key = "desk";
    sheet = false;
    content = <DeskStage status={status} />;
  }

  return (
    <section className="panel min-h-0 flex-1">
      <StageToolbar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* The default page background: the desk world, or — when swapped —
              the agent. Every other view is a translucent sheet on top. */}
          {agentOnStage ? (
            <div className="absolute inset-0 z-0 isolate overflow-hidden">
              <Avatar visual={visual} />
            </div>
          ) : (
            <StageWorld focus={focus} />
          )}

          <div className={sheet ? SHEET : "absolute inset-0"}>
            <AnimatePresence mode="wait">
              <motion.div
                key={key}
                className="h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </div>

          {mode === "replay" ? (
            <span className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-amber">REPLAY</span>
          ) : mode === "live" && isAgentBusy(status) ? (
            <span className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-teal">● LIVE</span>
          ) : null}

          {/* Chat floats over the Stage — one input row, history only on the default page. */}
          <StageChat expanded={!sheet && mode !== "replay"} />

          {/* The Daze Report tab + overlay, above the chat (z-30/z-40). */}
          <ReportOverlay />
        </div>

        {/* Outside the animated area so dragging the scrubber is never interrupted. */}
        {mode === "replay" ? <ReplayBar /> : null}
      </div>
    </section>
  );
}

/**
 * The translucent sheet FILE / DIFF / TERMINAL / LIVE sit on. The frame itself
 * does not fade, so live content crossfading inside never reveals the world.
 */
const SHEET =
  "daze-overlay absolute inset-x-2 top-2 bottom-14 overflow-hidden rounded-lg border border-desk-line/70 bg-desk-panel/85 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]";

function EmptyStage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {text}
      </p>
    </div>
  );
}
