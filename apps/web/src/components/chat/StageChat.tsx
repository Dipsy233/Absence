import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useUiStore } from "../../stores/uiStore";
import { useSessionStore } from "../../stores/sessionStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";
import { ContextChip } from "./ContextChip";
import { ChatCommandPalette, SlashButton } from "./ChatCommandPalette";
import { ChatMarkdownToggle, ChatThread } from "./ChatThread";
import { useChatInput } from "./useChatInput";

/**
 * Chat docked at the bottom of the Stage (read02 §30). It floats over the Stage
 * instead of taking layout space, so the middle never shrinks: it is always one
 * input row, and the history unfolds upward as a translucent layer — at most 30%
 * of the Stage by default, with an arrow to blow it up to full height. Whether
 * it is unfolded is remembered, and by default it stays put across pages; the
 * "collapse on content" setting (Settings → APPEARANCE) makes a content page
 * fold it away instead.
 *
 * The input is also a small terminal: a `/` at the start switches to command
 * mode, where a `/` button and a filterable palette (above the input) run Pi
 * commands. Anything else is an ordinary prompt.
 *
 * The state machine is `useChatInput` and the pieces are `ChatThread` /
 * `ChatCommandPalette` — shared with Monitor, so both faces type the same.
 */
export function StageChat({ expanded }: { expanded: boolean }) {
  const t = useT();
  const input = useChatInput();
  const {
    text,
    handleChange,
    handleKeyDown,
    inputRef,
    showPalette,
    commandMode,
    busy,
    connected,
    observed,
    pending,
    submit,
  } = input;

  const abort = useSessionStore((s) => s.abort);
  const [full, setFull] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  const historyOpen = useUiStore((s) => s.chatHistoryOpen);
  const setHistoryOpen = useUiStore((s) => s.setChatHistoryOpen);
  const collapseChatOnContent = useSettingsStore((s) => s.collapseChatOnContent);
  // `expanded` marks the Stage's default (desk) page. By default the chat stays
  // put no matter which page is up; only the "collapse on content" setting makes
  // a content page fold the history away.
  // An observed agent's conversation is worth showing by default: it is the only
  // thing on the Stage that says what the agent is thinking about. The user's own
  // preference still wins when they explicitly hide it.
  const showHistory = observed ? historyOpen : historyOpen && (expanded || !collapseChatOnContent);

  useEffect(() => {
    // A content page resets the "full height" state only when the setting asks
    // the chat to make way for it; otherwise the dock is left untouched.
    if (!expanded && collapseChatOnContent) setFull(false);
  }, [expanded, collapseChatOnContent]);

  return (
    <div className="pointer-events-none absolute inset-0 z-50 flex flex-col justify-end">
      <AnimatePresence initial={false}>
        {showHistory ? (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 10 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className={[
              "pointer-events-auto mx-2 mb-1 flex min-h-0 flex-col overflow-hidden rounded-lg border border-desk-line/70",
              "bg-desk-panel/85 shadow-[0_18px_50px_rgba(0,0,0,.45)] backdrop-blur-[3px]",
              full ? "max-h-[calc(100%-4rem)]" : "max-h-[30%]",
            ].join(" ")}
          >
            <div className="flex shrink-0 items-center justify-between border-b border-desk-line/70 px-2 py-1">
              <span className="label">{t("Chat")}</span>
              <div className="flex items-center gap-1">
                <ChatMarkdownToggle />
                <button
                  type="button"
                  onClick={() => setFull((value) => !value)}
                  title={full ? t("Collapse the history") : t("Expand the full history")}
                  className="rounded px-1.5 py-0.5 font-mono text-[10px] text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink"
                >
                  {full ? t("▼ collapse") : t("▲ expand")}
                </button>
              </div>
            </div>
            <ChatThread scrollRef={scrollRef} />
          </motion.div>
        ) : null}
      </AnimatePresence>

      {observed ? (
        <div className="pointer-events-auto mx-2 mb-2 flex items-center gap-2 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 font-mono text-[10px] text-desk-dim backdrop-blur-[3px]">
          <span className="rounded border border-desk-line px-1.5 py-0.5 uppercase tracking-[0.12em] text-desk-teal">
            {t("observing")}
          </span>
          <span className="min-w-0 flex-1 truncate">
            {t("Absence is watching this agent's terminal. Prompt it there — here it only shows what it does.")}
          </span>
        </div>
      ) : pending.length > 0 ? (
        <div className="pointer-events-auto mx-2 mb-1 flex flex-wrap items-center gap-1 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 backdrop-blur-[3px]">
          <span className="label">{t("context")}</span>
          {pending.map((context, index) => (
            <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
          ))}
        </div>
      ) : null}

      {observed ? null : (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
          className="pointer-events-auto relative mx-2 mb-2 flex items-center gap-2 rounded-lg border border-desk-line/70 bg-desk-panel/85 px-2 py-1.5 shadow-[0_12px_36px_rgba(0,0,0,.4)] backdrop-blur-[3px]"
        >
          {showPalette ? <ChatCommandPalette input={input} /> : null}

          <SlashButton input={input} />

          <button
            type="button"
            onClick={() => setHistoryOpen(!historyOpen)}
            disabled={!expanded && collapseChatOnContent}
            title={historyOpen ? t("Hide the conversation — keep just the input row") : t("Show the conversation")}
            className="shrink-0 rounded border border-desk-line px-1.5 py-1 font-mono text-[10px] text-desk-dim transition-colors hover:border-desk-amber/60 hover:text-desk-amber disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:border-desk-line disabled:hover:text-desk-dim"
          >
            {historyOpen ? t("▾ hide") : t("▴ chat")}
          </button>

          <input
            ref={inputRef}
            value={text}
            onChange={(event) => handleChange(event.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              connected ? (commandMode ? t("type a command…") : t("Ask the agent…")) : t("connecting…")
            }
            disabled={!connected}
            className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-2 py-1.5 font-mono text-xs text-desk-ink outline-none placeholder:text-desk-dim/60 focus:border-desk-amber/70 disabled:opacity-50"
          />

          {commandMode ? (
            <button
              type="submit"
              disabled={!connected}
              className="shrink-0 rounded border border-desk-amber/60 bg-desk-panel2 px-3 py-1.5 text-xs text-desk-amber hover:bg-desk-amber/10 disabled:opacity-40"
            >
              {t("Run")}
            </button>
          ) : busy ? (
            <button
              type="button"
              onClick={() => void abort()}
              className="shrink-0 rounded border border-desk-ember/60 px-3 py-1.5 text-xs text-desk-ember hover:bg-desk-ember/10"
            >
              {t("Stop")}
            </button>
          ) : (
            <button
              type="submit"
              disabled={!connected || !input.canSend}
              className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-3 py-1.5 text-xs text-desk-ink hover:border-desk-amber/70 disabled:opacity-40"
            >
              {t("Send")}
            </button>
          )}
        </form>
      )}
    </div>
  );
}
