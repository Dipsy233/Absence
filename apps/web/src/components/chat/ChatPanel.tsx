import { useEffect, useRef, useState, type FormEvent } from "react";
import { isAgentBusy } from "@daze/core";
import { buildPrompt } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";
import { Panel } from "../Panel";
import { ContextChip } from "./ContextChip";

export function ChatPanel() {
  const messages = useChatStore((s) => s.messages);
  const pending = useChatStore((s) => s.pending);
  const clearContext = useChatStore((s) => s.clearContext);
  const status = useSessionStore((s) => s.agent.status);
  const connected = useSessionStore((s) => s.connected);
  const sendPrompt = useSessionStore((s) => s.sendPrompt);
  const abort = useSessionStore((s) => s.abort);

  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages]);

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

  return (
    <Panel
      title="Chat"
      aside={busy ? <span className="text-desk-amber">working…</span> : <span className="text-desk-dim">ready</span>}
      className="min-h-0 flex-1"
      bodyClassName="flex flex-col p-0"
    >
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {messages.length === 0 ? (
          <p className="text-xs text-desk-dim">
            Ask the agent to do something. Attach context from Files, Activity or a selection.
          </p>
        ) : (
          messages.map((message) => (
            <div key={message.id}>
              <div className="label mb-0.5">{message.role === "user" ? "You" : "Agent"}</div>
              <div
                className={[
                  "whitespace-pre-wrap rounded px-2 py-1.5 text-xs leading-relaxed",
                  message.role === "user"
                    ? "bg-desk-panel2 text-desk-ink"
                    : "border border-desk-line bg-desk-bg text-desk-ink/90",
                ].join(" ")}
              >
                {message.content}
                {message.streaming ? <span className="ml-0.5 animate-pulse text-desk-amber">▍</span> : null}
              </div>
            </div>
          ))
        )}
      </div>

      {pending.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-1 border-t border-desk-line px-2 py-1.5">
          <span className="label">context</span>
          {pending.map((context, index) => (
            <ContextChip key={`${context.label}-${index}`} context={context} index={index} />
          ))}
        </div>
      ) : null}

      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-desk-line p-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={connected ? "Ask the agent…" : "connecting…"}
          disabled={!connected}
          className="min-w-0 flex-1 rounded border border-desk-line bg-desk-panel2 px-2 py-1.5 text-xs text-desk-ink outline-none placeholder:text-desk-dim/60 focus:border-desk-amber/70 disabled:opacity-50"
        />
        {busy ? (
          <button
            type="button"
            onClick={() => void abort()}
            className="shrink-0 rounded border border-desk-ember/60 px-3 py-1.5 text-xs text-desk-ember hover:bg-desk-ember/10"
          >
            Stop
          </button>
        ) : (
          <button
            type="submit"
            disabled={!connected || (!text.trim() && pending.length === 0)}
            className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-3 py-1.5 text-xs text-desk-ink hover:border-desk-amber/70 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </Panel>
  );
}
