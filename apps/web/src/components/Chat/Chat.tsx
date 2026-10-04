import { useEffect, useRef, useState, type FormEvent } from "react";
import { useDazeStore } from "../../stores/useDazeStore";
import { Panel } from "../Panel";

export function Chat() {
  const chat = useDazeStore((s) => s.chat);
  const status = useDazeStore((s) => s.agent.status);
  const connected = useDazeStore((s) => s.connected);
  const sendPrompt = useDazeStore((s) => s.sendPrompt);
  const abort = useDazeStore((s) => s.abort);

  const [text, setText] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [chat]);

  const busy = status !== "idle";

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = text.trim();
    if (!value) return;
    setText("");
    await sendPrompt(value);
  };

  return (
    <Panel
      title="Chat"
      aside={busy ? <span className="text-desk-amber">working…</span> : <span className="text-desk-dim">ready</span>}
      className="min-h-0 flex-1"
      bodyClassName="flex flex-col gap-2 p-0"
    >
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-3 overflow-auto p-3">
        {chat.length === 0 ? (
          <p className="text-xs text-desk-dim">Ask the agent to do something.</p>
        ) : (
          chat.map((message) => (
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

      <form onSubmit={submit} className="flex shrink-0 items-center gap-2 border-t border-desk-line p-2">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
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
            disabled={!connected || !text.trim()}
            className="shrink-0 rounded border border-desk-line bg-desk-panel2 px-3 py-1.5 text-xs text-desk-ink hover:border-desk-amber/70 disabled:opacity-40"
          >
            Send
          </button>
        )}
      </form>
    </Panel>
  );
}
