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
 * The desk world (StageWorld) is the Stage's *default page* and is normally
 * drawn as the background, with FILE / DIFF / TERMINAL / LIVE riding on top of
 * it as a slightly translucent sheet. DAZE mode (the toggle in the session bar)
 * flips that: the desk — or the agent, when swapped — floats *in front of* the
 * content as a translucent ghost, and the page underneath becomes the sheet.
 */
export function Stage() {
  const { item } = useStageView();
  const replayItem = useReplayItem();
  const mode = useStageStore((s) => s.mode);
  const liveStatus = useSessionStore((s) => s.agent.status);
  const replayStatus = useReplayStore((s) => s.view?.agentStatus);
  const agentOnStage = useUiStore((s) => s.agentOnStage);
  const dazeMode = useUiStore((s) => s.dazeMode);

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

  // DAZE mode only means something while a content page is up; on the default
  // desk page the world is already in front of nothing.
  const ghost = dazeMode && sheet;

  return (
    <section className="panel min-h-0 flex-1">
      <StageToolbar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* The world (desk or agent): the background by default; in DAZE mode a
              translucent, click-through ghost in front of the content sheet. It
              stays below the chat (z-20) and the report (z-30/z-40). */}
          <div
            className={
              ghost
                ? "pointer-events-none absolute inset-0 z-10 isolate overflow-hidden opacity-60 transition-opacity duration-300"
                : "absolute inset-0 z-0 isolate overflow-hidden"
            }
          >
            {agentOnStage ? <Avatar visual={visual} /> : <StageWorld focus={focus} />}
          </div>

          <div className={sheet ? sheetClass(ghost) : "absolute inset-0"}>
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
 * In DAZE mode the ghost carries the translucency instead, so the page under it
 * is drawn opaque and stays readable through the 60% ghost above it.
 */
const SHEET =
  "daze-overlay absolute inset-x-2 top-2 bottom-14 overflow-hidden rounded-lg border border-desk-line/70 shadow-[0_18px_50px_rgba(0,0,0,.45)]";
const sheetClass = (ghost: boolean) =>
  ghost ? `${SHEET} bg-desk-panel` : `${SHEET} bg-desk-panel/85 backdrop-blur-[3px]`;

function EmptyStage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {text}
      </p>
    </div>
  );
}
