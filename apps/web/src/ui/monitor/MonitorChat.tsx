import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAgentBusy } from "@absence/core";
import { buildPrompt, contextLabel } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";

/**
 * The input row: one line, always present, with the conversation unfolding
 * upward only when asked for.
 *
 * Deliberately not Classic's dock — Monitor's centre column is for reading
 * traces, so chat is a tool you reach for, not a surface you live in. The
 * thread is closed by default and its toggle is a 24px chip, not a header bar.
 */
export function MonitorChat() {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const removeContext = useChatStore((s) => s.removeContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const abort = useSessionStore((s) => s.abort);
  const observed = useIsObserved();

  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const threadRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const element = threadRef.current;
    if (element && open) element.scrollTop = element.scrollHeight;
  }, [messages, open]);

  const busy = isAgentBusy(status);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value && pending.length === 0) return;
    const prompt = buildPrompt(pending, value || "(content above)");
    setText("");
    clearContext();
    await sendPrompt(prompt);
  };

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
    <>
      {open ? (
        <div className="mon-thread" ref={threadRef}>
          {messages.length === 0 ? (
            <p style={{ fontSize: 12, color: "var(--mon-t3)" }}>
              {t("No messages yet — send the first prompt below.")}
            </p>
          ) : (
            messages.map((message) => (
              <div
                key={message.id}
                className={`mon-msg mon-msg--${message.role === "user" ? "user" : message.role === "system" ? "system" : "agent"}`}
              >
                <div className="mon-msg__role">
                  {message.role === "user" ? t("You") : message.role === "system" ? "ABSENCE" : t("Agent")}
                </div>
                <div className="mon-msg__body">{message.content}</div>
              </div>
            ))
          )}
        </div>
      ) : null}

      <form className="mon-chat" onSubmit={submit}>
        <button
          type="button"
          className="mon-chat__slash"
          title={t("Show the conversation")}
          aria-pressed={open}
          aria-label={t("Show the conversation")}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? "▾" : "▴"}
        </button>

        <div className="mon-chat__box">
          {pending.map((context, index) => (
            <span className="mon-ctx" key={`${context.label}-${index}`} title={contextLabel(context)}>
              <span>{contextLabel(context)}</span>
              <button type="button" onClick={() => removeContext(index)} title={t("Remove context")}>
                ×
              </button>
            </span>
          ))}
          <input
            ref={inputRef}
            className="mon-chat__input"
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={
              connected ? t("Ask the agent… — or / for commands") : t("connecting…")
            }
            disabled={!connected}
            aria-label={t("Ask the agent…")}
          />
        </div>

        {busy ? (
          <button type="button" className="mon-btn mon-btn--danger" style={{ height: 36 }} onClick={() => void abort()}>
            {t("Stop")}
          </button>
        ) : (
          <button
            type="submit"
            className="mon-btn mon-btn--pri"
            style={{ height: 36 }}
            disabled={!connected || (!text.trim() && pending.length === 0)}
          >
            {t("Send")}
          </button>
        )}
      </form>
    </>
  );
}
