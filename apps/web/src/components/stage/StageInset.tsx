import { AnimatePresence, motion } from "framer-motion";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { EXIT_MS } from "../../lib/terminalInset";
import { StageItemView } from "./StageItemView";

/**
 * The Stage's docked terminal inset — where MCP calls are shown.
 *
 * It is deliberately *not* a Stage page. An MCP call used to cover the whole
 * Stage body, opaque, and stay there until the next activity replaced it, which
 * meant watching a `filesystem` read hid the very file the agent was reading.
 * A call is a note beside the work, so it is docked above the chat bar: a small
 * terminal pane that sits next to whatever page is up, folds itself away a few
 * seconds after the call ends, and can be dismissed or pinned by hand.
 *
 * Layering: above the Stage pages, below the chat (z-50) so a full chat history
 * still wins, below the Absence Report (z-30/z-40 sits over the body) — the
 * report is a modal the user opened, a call should not float over it.
 */
export function StageInset({ paused = false }: { paused?: boolean }) {
  const inset = useSessionStore((s) => s.inset);
  const retractInset = useSessionStore((s) => s.retractInset);
  const addContext = useChatStore((s) => s.addContext);
  const openStage = useStageStore((s) => s.openStage);
  const reportOpen = useUiStore((s) => s.reportOpen);
  const item = inset.item;
  const mcp = item?.payload.kind === "terminal" ? item.payload.mcp : undefined;
  // An error stays until dismissed: it is the one MCP outcome worth keeping.
  const failed = item?.payload.kind === "terminal" && item.payload.exitCode !== 0;

  return (
    <AnimatePresence>
      {item ? (
        <motion.aside
          // Keyed on the item id, so a new call replaces the pane in place rather
          // than animating two cards at once; the same call's result keeps the key
          // and only swaps its content.
          key={item.id}
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: inset.phase === "closing" ? 0 : 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: EXIT_MS / 1000, ease: "easeOut" }}
          className={[
            "pointer-events-auto absolute inset-x-2 z-20 flex h-[13rem] flex-col overflow-hidden",
            "rounded-lg border shadow-[0_12px_32px_rgba(0,0,0,.4)] backdrop-blur-[3px]",
            failed ? "border-desk-ember/50 bg-desk-panel/92" : "border-desk-line/70 bg-desk-panel/90",
            reportOpen ? "hidden" : "",
          ].join(" ")}
          // Just above the chat bar, so the input row is never covered.
          style={{ bottom: "calc(var(--stage-chat-dock, 3.25rem) + 0.5rem)" }}
          aria-label={item.title}
        >
          <div className="flex shrink-0 items-center gap-2 border-b border-desk-line/60 px-2 py-1 font-mono text-[10px]">
            <span className="uppercase tracking-[0.15em] text-desk-lavender">mcp</span>
            <span className="truncate text-desk-dim" title={item.title}>
              {item.title.replace(/^mcp:\/\//, "")}
            </span>
            {mcp?.phase === "call" ? <span className="shrink-0 text-desk-dim">· in flight</span> : null}
            {mcp?.phase === "result" && !paused && !inset.pinned ? (
              // Say why it will disappear, so the retract does not feel arbitrary.
              <span className="shrink-0 text-desk-dim/70">· folds away</span>
            ) : null}
            <span className="ml-auto flex shrink-0 items-center gap-1.5">
              {item.event ? (
                <button
                  type="button"
                  onClick={() => addContext(eventContext(item.event!))}
                  className="rounded border border-desk-line px-1.5 py-0.5 text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
                  title="Add this call to Chat"
                >
                  + Chat
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => openStage(item)}
                className="rounded border border-desk-line px-1.5 py-0.5 text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
                title="Expand this call onto the Stage"
              >
                ⤢
              </button>
              <button
                type="button"
                onClick={retractInset}
                className="rounded border border-desk-line px-1.5 py-0.5 text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
                title="Fold this call away"
              >
                ✕
              </button>
            </span>
          </div>
          <div className="min-h-0 flex-1">
            <StageItemView item={item} />
          </div>
        </motion.aside>
      ) : null}
    </AnimatePresence>
  );
}
