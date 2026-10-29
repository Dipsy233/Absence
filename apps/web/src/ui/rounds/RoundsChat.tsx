import { FormEvent } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { ContextChip } from "../../components/chat/ContextChip";
import { ChatCommandPalette, SlashButton } from "../../components/chat/ChatCommandPalette";
import { useChatInput } from "../../components/chat/useChatInput";

/**
 * The input bar: the same input as every other face — the same state machine
 * (`useChatInput`), the same `/` palette, the same context chips — with
 * Rounds' chrome: one rounded line under the story, and a stop button that is
 * the row's only filled element while the agent runs.
 */
export function RoundsChat() {
  const t = useT();
  const input = useChatInput();
  const { text, handleChange, handleKeyDown, inputRef, showPalette, commandMode, busy, connected, observed, pending, submit } =
    input;
  const abort = useSessionStore((s) => s.abort);

  if (observed) {
    return (
      <div className="rounds-chat">
        <span className="rounds-chip rounds-chip--read">{t("observing")}</span>
        <span className="rounds-chat__note">
          {t("Absence is watching this agent's terminal. Prompt it there — here it only shows what it does.")}
        </span>
      </div>
    );
  }

  return (
    <form
      className="rounds-chat"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      {showPalette ? <ChatCommandPalette input={input} /> : null}

      <div className="rounds-inp">
        <SlashButton input={input} />
        {pending.map((context, index) => (
          <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
        ))}
        <input
          ref={inputRef}
          className="rounds-inp__input"
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={
            connected
              ? commandMode
                ? t("type a command…")
                : t("Say something to the agent…")
              : t("connecting…")
          }
          disabled={!connected}
          aria-label={t("Say something to the agent…")}
        />
      </div>

      {commandMode ? (
        <button type="submit" className="rounds-send" disabled={!connected}>
          {t("Run")}
        </button>
      ) : busy ? (
        <button type="button" className="rounds-stop" onClick={() => void abort()}>
          ■ {t("Stop")}
        </button>
      ) : (
        <button type="submit" className="rounds-send" disabled={!connected || !input.canSend}>
          {t("Send")}
        </button>
      )}
    </form>
  );
}
