import { useEffect, useMemo, useRef } from "react";
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

   `layout="bubbles"` is Rounds' reading: the reader's messages sit on the
   right, the agent's on the left, and consecutive messages of one voice share
   a single rounded block whose seams are drawn between them.
   ══════════════════════════════════════════════════════════════════════════ */

/** One message's content, in either layout. */
function MessageBody({ message, markdown }: { message: ChatMessage; markdown: boolean }) {
  return message.role === "assistant" && markdown ? (
    <Markdown text={message.content} streaming={message.streaming} />
  ) : (
    <>
      <span className="whitespace-pre-wrap">{message.content}</span>
      {message.streaming ? <span className="ml-0.5 animate-pulse text-desk-amber">▍</span> : null}
    </>
  );
}

/** Consecutive messages from the same voice, one bubble block. */
type BubbleGroup = { role: ChatMessage["role"]; messages: ChatMessage[] };

export function ChatThread({
  scrollRef,
  className,
  layout = "plain",
}: {
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  className?: string;
  layout?: "plain" | "bubbles";
}) {
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

  const groups = useMemo(() => {
    const out: BubbleGroup[] = [];
    for (const message of messages) {
      const last = out[out.length - 1];
      if (last && last.role === message.role) last.messages.push(message);
      else out.push({ role: message.role, messages: [message] });
    }
    return out;
  }, [messages]);

  const who = (role: ChatMessage["role"]) =>
    role === "user" ? t("You") : role === "system" ? "ABSENCE" : t("Agent");

  return (
    <div
      ref={(node) => {
        innerRef.current = node;
        if (scrollRef) scrollRef.current = node;
      }}
      className={["min-h-0 flex-1 space-y-2 overflow-auto px-3 py-2", layout === "bubbles" ? "rounds-thread--bubbles" : "", className]
        .filter(Boolean)
        .join(" ")}
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
      ) : layout === "bubbles" ? (
        groups.map((group) => (
          <div key={group.messages[0]!.id} className={`rounds-bubblewrap rounds-bubblewrap--${group.role}`}>
            <span className="rounds-bubblewrap__who">{who(group.role)}</span>
            <div className="rounds-bubble">
              {group.messages.map((message, i) => (
                <div key={message.id} className="rounds-bubble__msg" data-seam={i > 0 ? "true" : undefined}>
                  <MessageBody message={message} markdown={chatMarkdown} />
                </div>
              ))}
            </div>
          </div>
        ))
      ) : (
        messages.map((message: ChatMessage) => (
          <div key={message.id}>
            <div className="label mb-0.5">{who(message.role)}</div>
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
              <MessageBody message={message} markdown={chatMarkdown} />
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
