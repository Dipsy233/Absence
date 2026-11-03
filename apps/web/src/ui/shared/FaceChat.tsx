import type { FormEvent } from "react";
import { useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { ContextChip } from "../../components/chat/ContextChip";
import { ChatCommandPalette, SlashButton } from "../../components/chat/ChatCommandPalette";
import { useChatInput } from "../../components/chat/useChatInput";

/**
 * The chat input bar one face-independent way.
 *
 * It is one input shared by every chat face — the same state machine
 * (`useChatInput`), the same `/` palette, the same context chips, the same
 * three-button send/stop/run contract — because a command typed in any face
 * must behave exactly as it does everywhere else. What differs is only chrome,
 * so the chrome is the parameter: a `FaceChatSkin` of class names and the two
 * sentences the placeholder needs.
 *
 * MonitorChat and RoundsChat are thin wrappers over this; they exist so each
 * face's file still names its own bar.
 */
export interface FaceChatSkin {
  /** The `<form>`'s class. */
  form: string;
  /** The wrapper around the context chips and the input. */
  box: string;
  input: string;
  send: string;
  stop: string;
  /** Rounds draws the slash button inside the input box; Monitor before it. */
  slashInsideBox?: boolean;
  /** Glyph before the stop word ("■" in Rounds). */
  stopLead?: string;
  placeholder: string;
  ariaLabel: string;
}

export function FaceChat({ skin }: { skin: FaceChatSkin }) {
  const t = useT();
  const input = useChatInput();
  const { text, handleChange, handleKeyDown, inputRef, showPalette, commandMode, busy, connected, pending, submit } =
    input;
  const abort = useSessionStore((s) => s.abort);

  const slash = <SlashButton input={input} />;

  return (
    <form
      className={skin.form}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        void submit();
      }}
    >
      {showPalette ? <ChatCommandPalette input={input} /> : null}

      {skin.slashInsideBox ? null : slash}

      <div className={skin.box}>
        {skin.slashInsideBox ? slash : null}
        {pending.map((context, index) => (
          <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
        ))}
        <input
          ref={inputRef}
          className={skin.input}
          value={text}
          onChange={(event) => handleChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={connected ? (commandMode ? t("type a command…") : t(skin.placeholder)) : t("connecting…")}
          disabled={!connected}
          aria-label={t(skin.ariaLabel)}
        />
      </div>

      {commandMode ? (
        <button type="submit" className={skin.send} disabled={!connected}>
          {t("Run")}
        </button>
      ) : busy ? (
        <button type="button" className={skin.stop} onClick={() => void abort()}>
          {skin.stopLead}
          {t("Stop")}
        </button>
      ) : (
        <button type="submit" className={skin.send} disabled={!connected || !input.canSend}>
          {t("Send")}
        </button>
      )}
    </form>
  );
}
