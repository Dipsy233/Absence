import { AnimatePresence, motion } from "framer-motion";
import { isAgentBusy } from "@daze/core";
import { useReplayItem, useStageView } from "../../hooks/useStage";
import { useStageStore } from "../../stores/stageStore";
import { useSessionStore } from "../../stores/sessionStore";
import { StageItemView } from "../stage/StageItemView";
import { DeskStage } from "../stage/DeskStage";
import { StageToolbar } from "../stage/StageToolbar";
import { ReplayBar } from "../stage/ReplayBar";

/** The Stage: where events become something you can look at (read02 §11). */
export function Stage() {
  const { item } = useStageView();
  const replayItem = useReplayItem();
  const mode = useStageStore((s) => s.mode);
  const status = useSessionStore((s) => s.agent.status);
  const plan = useSessionStore((s) => s.plan);

  let body: React.ReactNode;
  let key: string;

  if (mode === "replay") {
    key = `replay:${replayItem?.id ?? "none"}`;
    body = replayItem ? <StageItemView item={replayItem} /> : <EmptyStage text="Press ▶ to replay this run." />;
  } else if (mode === "desk") {
    // TABLE: the default page, regardless of what is pinned.
    key = "desk";
    body = <DeskStage plan={plan} status={status} />;
  } else if (item) {
    key = item.id;
    body = <StageItemView item={item} />;
  } else {
    key = "desk";
    body = <DeskStage plan={plan} status={status} />;
  }

  return (
    <section className="panel min-h-0 flex-1">
      <StageToolbar />

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            <motion.div
              key={key}
              className="h-full"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15, ease: "easeOut" }}
            >
              {body}
            </motion.div>
          </AnimatePresence>

          {mode === "replay" ? (
            <span className="chip pointer-events-none absolute right-3 top-2 text-desk-amber">REPLAY</span>
          ) : mode === "live" && isAgentBusy(status) ? (
            <span className="chip pointer-events-none absolute right-3 top-2 text-desk-teal">● LIVE</span>
          ) : null}
        </div>

        {/* Outside the animated area so dragging the scrubber is never interrupted. */}
        {mode === "replay" ? <ReplayBar /> : null}
      </div>
    </section>
  );
}

function EmptyStage({ text }: { text: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-xs italic text-desk-dim">{text}</p>
    </div>
  );
}
