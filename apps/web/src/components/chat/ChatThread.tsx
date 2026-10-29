import { useEffect, useRef } from "react";
import type { ChatMessage } from "@absence/core";
import { useChatStore } from "../../stores/chatStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";
import { Markdown } from "../common/Markdown";

/* ══════════════════════════════════════════════════════════════════════════
   The conversation, as one implementation.

   Classic floats it over the Stage; Monitor reads it as a tab of the Stage.
   Both show the same messages the same way — role label, bubble, Markdown
   unless the reader asked for raw text — so the rendering lives here and the
   two faces only decide where the box goes.
   ══════════════════════════════════════════════════════════════════════════ */

export function ChatThread({ scrollRef, className }: { scrollRef?: React.RefObject<HTMLDivElement | null>; className?: string }) {
  const t = useT();
  const messages = useChatStore((s) => s.messages);
  const chatMarkdown = useSettingsStore((s) => s.chatMarkdown);
  const innerRef = useRef<HTMLDivElement>(null);

  // Follow the newest message, unless the reader scrolled up to read.
  const stick = useRef(true);
  useEffect(() => {
    const el = innerRef.current;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    const el = innerRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div
      ref={(node) => {
        innerRef.current = node;
        if (scrollRef) scrollRef.current = node;
      }}
      className={["min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2", className].filter(Boolean).join(" ")}
    >
      {messages.length === 0 ? (
        <p className="text-xs text-desk-dim">
          {t(
            "Ask the agent to do something, or type <slash> for commands. Attach context from Files, Activity or a selection.",
          )
            .split("<slash>")[0]}
          <span className="font-mono text-desk-amber">/</span>
          {t(
            "Ask the agent to do something, or type <slash> for commands. Attach context from Files, Activity or a selection.",
          )
            .split("<slash>")[1]}
        </p>
      ) : (
        messages.map((message: ChatMessage) => (
          <div key={message.id}>
            <div className="label mb-0.5">
              {message.role === "user" ? t("You") : message.role === "system" ? "ABSENCE" : t("Agent")}
            </div>
            <div
              className={[
                "rounded px-2 py-1.5 text-xs leading-relaxed",
                message.role === "user"
                  ? "whitespace-pre-wrap bg-desk-panel2 text-desk-ink"
                  : message.role === "system"
                    ? "whitespace-pre-wrap border border-desk-line/60 bg-desk-panel2/40 font-mono text-[11px] text-desk-dim"
                    : "border border-desk-line bg-desk-bg text-desk-ink/90",
              ].join(" ")}
            >
              {message.role === "assistant" && chatMarkdown ? (
                <Markdown text={message.content} streaming={message.streaming} />
              ) : (
                <>
                  <span className="whitespace-pre-wrap">{message.content}</span>
                  {message.streaming ? <span className="ml-0.5 animate-pulse text-desk-amber">▍</span> : null}
                </>
              )}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

/** The `md` / `raw` toggle for the conversation header. */
export function ChatMarkdownToggle() {
  const t = useT();
  const chatMarkdown = useSettingsStore((s) => s.chatMarkdown);
  const setChatMarkdown = useSettingsStore((s) => s.setChatMarkdown);
  return (
    <button
      type="button"
      onClick={() => setChatMarkdown(!chatMarkdown)}
      title={chatMarkdown ? t("Show the agent's replies as raw text") : t("Render the agent's replies as Markdown")}
      className={[
        "rounded px-1.5 py-0.5 font-mono text-[10px] hover:bg-desk-panel2",
        chatMarkdown ? "text-desk-teal" : "text-desk-dim hover:text-desk-ink",
      ].join(" ")}
    >
      {chatMarkdown ? t("md") : t("raw")}
    </button>
  );
}
