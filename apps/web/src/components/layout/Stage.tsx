import { useEffect, useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy } from "@absence/core";
import { useReplayItem, useStageView } from "../../hooks/useStage";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { statusFromEvent } from "../../lib/events";
import { useT } from "../../lib/i18n";
import { StageItemView } from "../stage/StageItemView";
import { StageToolbar } from "../stage/StageToolbar";
import { ReplayBar } from "../stage/ReplayBar";
import { StageChat } from "../chat/StageChat";
import { ReportOverlay } from "../stage/ReportOverlay";
import { MetricsDashboard } from "../metrics/MetricsDashboard";

/**
 * The Stage: where events become something you can look at (read02 §11).
 *
 * The metrics dashboard is the Stage's *default page*: the eggs' resource view
 * lives where the desk world used to, drawn as the background, with FILE /
 * DIFF / TERMINAL / LIVE riding on top of it as a slightly translucent sheet.
 * ABSENCE mode (the toggle in the session bar) flips that: the dashboard
 * floats *in front of* the content as a translucent ghost, and the page
 * underneath becomes the sheet.
 */
export function Stage() {
  const { item } = useStageView();
  const t = useT();
  const replayItem = useReplayItem();
  const mode = useStageStore((s) => s.mode);
  const liveStatus = useSessionStore((s) => s.agent.status);
  const replayStatus = useReplayStore((s) => s.view?.agentStatus);
  const metricsOpen = useUiStore((s) => s.metricsOpen);
  const absenceMode = useUiStore((s) => s.absenceMode);
  // Whether Absence only watches this agent (see useIsObserved). With an
  // observed agent, a run end is a fact we saw, not a state we set — the
  // status line says so.
  const observed = useIsObserved();
  const observedLabel = useSessionStore((s) =>
    s.source?.kind === "observe" ? s.source.label : undefined,
  );

  // While replaying, the Stage shows the reconstructed state of the run — the
  // agent's status is part of that, so the avatar must not keep following the
  // live agent while the rest of the Stage is rewound (read02 §26–27).
  // A pinned item (an activity the user opened from the live stream) gets the
  // same treatment: the avatar re-enacts the action that produced it instead of
  // idling at whatever the live status happens to be.
  // live agent while the rest of the Stage is rewound (read02 §26–27).
  // A pinned item (an activity the user opened from the live stream) gets the
  // same treatment: the avatar re-enacts the action that produced it instead of
  // idling at whatever the live status happens to be.
  const status =
    ((mode === "replay" && replayStatus) ||
      (mode !== "replay" && mode !== "metrics" && item?.event
        ? statusFromEvent(item.event)
        : undefined)) ?? liveStatus;

  let key: string;
  let content: React.ReactNode;
  let sheet: boolean;

  if (mode === "replay") {
    key = `replay:${replayItem?.id ?? "none"}`;
    sheet = !!replayItem;
    content = replayItem ? <StageItemView item={replayItem} /> : <EmptyStage text="Press ▶ to replay this run." />;
  } else if (mode !== "metrics" && item) {
    key = item.id;
    sheet = true;
    content = <StageItemView item={item} />;
  } else {
    // METRICS: the default page, regardless of what is pinned.
    key = "metrics";
    sheet = false;
    content = <MetricsDashboard embedded />;
  }

  // ABSENCE mode only means something while a content page is up; on the default
  // desk page the world is already in front of nothing.
  const ghost = absenceMode && sheet;

  return (
    <section className="panel min-h-0 flex-1">
      <StageToolbar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          {/* The metrics dashboard: the background by default; in ABSENCE mode a
              translucent, click-through ghost in front of the content sheet. It
              stays below the chat, which floats on top of everything (z-50). */}
          <div
            className={
              ghost
                ? "pointer-events-none absolute inset-0 z-10 isolate overflow-hidden opacity-60 transition-opacity duration-300"
                : "absolute inset-0 z-0 isolate overflow-hidden"
            }
          >
            <MetricsDashboard embedded />
          </div>

          {/* The sheet frame: a persistent layer so an outgoing page always fades
              out *inside* the sheet while the frame itself eases between the
              inset sheet geometry and the full-bleed desk page. Switching the
              container class instead would make the outgoing page jump to
              full-bleed for the length of its exit fade (read02 §11). */}
          <motion.div
            className="absence-overlay absolute isolate overflow-hidden rounded-lg border"
            initial={false}
            animate={{
              left: sheet ? SHEET_INSET : 0,
              right: sheet ? SHEET_INSET : 0,
              top: sheet ? SHEET_INSET : 0,
              bottom: sheet ? SHEET_BOTTOM : 0,
              borderColor: sheet ? `rgba(${LINE_RGB},0.7)` : `rgba(${LINE_RGB},0)`,
              boxShadow: sheet ? "0 18px 50px rgba(0,0,0,.45)" : "0 0 0 0 rgba(0,0,0,0)",
            }}
            transition={{ duration: 0.15, ease: "easeOut" }}
          >
            {/* Sheet tint and blur live on their own layers so they can fade with
                the frame instead of popping between the two page kinds. In
                ABSENCE mode the tint is opaque — the ghost carries the
                translucency instead. */}
            <motion.div
              className="absolute inset-0 bg-desk-panel"
              initial={false}
              animate={{ opacity: sheet ? (ghost ? 1 : 0.85) : 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            />
            <motion.div
              className="absolute inset-0 backdrop-blur-[3px]"
              initial={false}
              animate={{ opacity: sheet && !ghost ? 1 : 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            />
            <AnimatePresence mode="wait">
              <motion.div
                key={key}
                className="relative h-full"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: "easeOut" }}
              >
                {content}
              </motion.div>
            </AnimatePresence>
          </motion.div>

          {mode === "replay" ? (
            <span className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-amber">{t("REPLAY")}</span>
          ) : observed ? (
            // Not "LIVE": Absence is not driving anything. It is watching, and
            // the label names what it is watching.
            <span
              className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-teal"
              title={t("Absence is observing this process; it never drives or stops it")}
            >
              {t("◇ OBSERVING")}
              {observedLabel ? ` ${observedLabel}` : ""}
            </span>
          ) : mode === "live" && isAgentBusy(status) ? (
            <span className="chip pointer-events-none absolute right-3 top-2 z-10 text-desk-teal">{t("● LIVE")}</span>
          ) : null}

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
 * The sheet frame's geometry (read02 §11): `inset-x-2 top-2 bottom-14` in px,
 * mirrored by the frame's animate values so desk ↔ sheet transitions ease
 * instead of jumping. The frame itself does not fade while sheet pages swap
 * inside it, so live content crossfading never reveals the world.
 */
const SHEET_INSET = 8; // inset-x-2 / top-2
const SHEET_BOTTOM = 56; // bottom-14 (3.5rem)
const LINE_RGB = "46, 40, 34"; // --desk-line, for the animatable border colour

function EmptyStage({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {t(text)}
      </p>
    </div>
  );
}
