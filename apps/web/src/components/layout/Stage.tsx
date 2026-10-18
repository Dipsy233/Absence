import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy } from "@absence/core";
import { focusFor, useReplayItem, useStageView } from "../../hooks/useStage";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { moodFor, type AgentVisualState } from "../../lib/agent";
import { statusFromEvent } from "../../lib/events";
import { insetItemAtCursor } from "../../lib/terminalInset";
import { useInsetLifetime } from "../../hooks/useInsetLifetime";
import { StageItemView } from "../stage/StageItemView";
import { StageInset } from "../stage/StageInset";
import { DeskStage } from "../stage/DeskStage";
import { StageToolbar } from "../stage/StageToolbar";
import { ReplayBar } from "../stage/ReplayBar";
import { StageWorld } from "../stage/StageWorld";
import { Avatar } from "../agent/Avatar";
import { MediaAvatar } from "../agent/MediaAvatar";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { StageChat } from "../chat/StageChat";
import { ReportOverlay } from "../stage/ReportOverlay";

/**
 * The Stage: where events become something you can look at (read02 §11).
 *
 * The desk world (StageWorld) is the Stage's *default page* and is normally
 * drawn as the background, with FILE / DIFF / TERMINAL / LIVE riding on top of
 * it as a slightly translucent sheet. ABSENCE mode (the toggle in the session bar)
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
  const absenceMode = useUiStore((s) => s.absenceMode);
  // Whether Absence only watches this agent (see useIsObserved). With an
  // observed agent, a run end is a fact we saw, not a state we set — the
  // status line says so.
  const observed = useIsObserved();
  const observedLabel = useSessionStore((s) =>
    s.source?.kind === "observe" ? s.source.label : undefined,
  );

  // The MCP inset's timers (hold after a call ends, then the fold-away). Lives
  // here, once, rather than in the dock itself, so re-mounting the pane never
  // restarts the countdown.
  useInsetLifetime();

  // In replay the dock shows the call at the cursor instead of the live one: a
  // recording must not spring a later call back onto the screen.
  const replayEvents = useReplayStore((s) => s.events);
  const replayTime = useReplayStore((s) => s.currentTime);
  const replayInset = useMemo(
    () => (mode === "replay" ? insetItemAtCursor(replayEvents, replayTime) : undefined),
    [mode, replayEvents, replayTime],
  );
  const pinInset = useSessionStore((s) => s.pinInset);
  const clearInset = useSessionStore((s) => s.retractInset);
  useEffect(() => {
    // A rewound call is shown as-is (pinned, no countdown); stepping past it —
    // or leaving replay — folds it away.
    if (replayInset) pinInset(replayInset);
    else if (mode === "replay") clearInset();
  }, [replayInset, mode, pinInset, clearInset]);

  // While replaying, the Stage shows the reconstructed state of the run — the
  // agent's status is part of that, so the avatar must not keep following the
  // live agent while the rest of the Stage is rewound (read02 §26–27).
  // A pinned item (an activity the user opened from the live stream) gets the
  // same treatment: the avatar re-enacts the action that produced it instead of
  // idling at whatever the live status happens to be.
  const status =
    ((mode === "replay" && replayStatus) ||
      (mode !== "replay" && mode !== "desk" && item?.event
        ? statusFromEvent(item.event)
        : undefined)) ?? liveStatus;

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
    content = <DeskStage status={status} observedLabel={observedLabel} />;
  }

  // ABSENCE mode only means something while a content page is up; on the default
  // desk page the world is already in front of nothing.
  const ghost = absenceMode && sheet;

  return (
    <section className="panel min-h-0 flex-1">
      <StageToolbar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* The world (desk or agent): the background by default; in ABSENCE mode a
              translucent, click-through ghost in front of the content sheet. It
              stays below the chat, which floats on top of everything (z-50). */}
          <div
            className={
              ghost
                ? "pointer-events-none absolute inset-0 z-10 isolate overflow-hidden opacity-60 transition-opacity duration-300"
                : "absolute inset-0 z-0 isolate overflow-hidden"
            }
          >
            {agentOnStage ? <AgentAvatar visual={visual} /> : <StageWorld focus={focus} />}
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
          ) : observed ? (
            // Not "LIVE": Absence is not driving anything. It is watching, and
            // the label names what it is watching.
            <span
              className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-teal"
              title="Absence is observing this process; it never drives or stops it"
            >
              ◇ OBSERVING{observedLabel ? ` ${observedLabel}` : ""}
            </span>
          ) : mode === "live" && isAgentBusy(status) ? (
            <span className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-teal">● LIVE</span>
          ) : null}

          {/* MCP calls dock here, above the chat and beside whatever page is up:
              an inset that never covers the Stage and retracts itself when the
              call is over. Hidden while the report covers the body. */}
          <StageInset paused={mode === "replay"} />

          {/* Chat floats over the Stage, above every page (file / diff / terminal /
              report). One input row, history only on the default page. */}
          <StageChat expanded={!sheet && mode !== "replay"} />

          {/* The Absence Report tab + overlay, below the chat so it never hides it. */}
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
 * In ABSENCE mode the ghost carries the translucency instead, so the page under it
 * is drawn opaque and stays readable through the 60% ghost above it.
 */
const SHEET =
  "absence-overlay absolute inset-x-2 top-2 bottom-14 overflow-hidden rounded-lg border border-desk-line/70 shadow-[0_18px_50px_rgba(0,0,0,.45)]";
const sheetClass = (ghost: boolean) =>
  ghost ? `${SHEET} bg-desk-panel` : `${SHEET} bg-desk-panel/85 backdrop-blur-[3px]`;

/** The Stage's avatar honours the uploaded skin, same as the Agent panel. */
function AgentAvatar({ visual }: { visual: AgentVisualState }) {
  const coverage = useAvatarSkinCoverage();
  const media = skinMediaFor(coverage, visual.status);
  if (media) return <MediaAvatar visual={visual} src={media.src} video={media.video} />;
  return <Avatar visual={visual} />;
}

function EmptyStage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {text}
      </p>
    </div>
  );
}
