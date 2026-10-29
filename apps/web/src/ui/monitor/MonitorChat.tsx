import { FormEvent } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { ContextChip } from "../../components/chat/ContextChip";
import { ChatCommandPalette, SlashButton } from "../../components/chat/ChatCommandPalette";
import { useChatInput } from "../../components/chat/useChatInput";

/**
 * The input row: one line, always present.
 *
 * It is the same input as Classic's dock — the same state machine
 * (`useChatInput`), the same `/` overlay and the same context chips — because a
 * command typed here must behave exactly as it does there. What differs is the
 * chrome: Monitor reads traces in the centre column, so the conversation is a
 * *tab* of the Stage rather than a layer over it, and this bar therefore has no
 * expand toggle. Typing `/` still opens the palette above the line.
 */
export function MonitorChat() {
  const t = useT();
  const input = useChatInput();
  const { text, handleChange, handleKeyDown, inputRef, showPalette, commandMode, busy, connected, observed, pending, submit } =
    input;
  const abort = useSessionStore((s) => s.abort);

  if (observed) {
    return (
      <div className="mon-chat">
        <span className="mon-chip mon-chip--read" style={{ height: 26 }}>
          {t("observing")}
        </span>
        <span style={{ fontSize: 12, color: "var(--mon-t3)" }}>
          {t("Absence is watching this agent's terminal. Prompt it there — here it only shows what it does.")}
        </span>
      </div>
    );
  }

  return (
    <form
      className="mon-chat"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      {showPalette ? <ChatCommandPalette input={input} /> : null}

      <SlashButton input={input} />

      <div className="mon-chat__box">
        {pending.map((context, index) => (
          <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
        ))}
        <input
          ref={inputRef}
          className="mon-chat__input"
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            connected
              ? commandMode
                ? t("type a command…")
                : t("Ask about this moment, or / for commands")
              : t("connecting…")
          }
          disabled={!connected}
          aria-label={t("Ask the agent…")}
        />
      </div>

      {commandMode ? (
        <button type="submit" className="mon-btn mon-btn--pri mon-chat__send" disabled={!connected}>
          {t("Run")}
        </button>
      ) : busy ? (
        <button type="button" className="mon-btn mon-btn--danger mon-chat__send" onClick={() => void abort()}>
          {t("Stop")}
        </button>
      ) : (
        <button type="submit" className="mon-btn mon-btn--pri mon-chat__send" disabled={!connected || !input.canSend}>
          {t("Send")}
        </button>
      )}
    </form>
  );
}
