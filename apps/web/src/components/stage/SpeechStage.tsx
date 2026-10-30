import type { AbsenceEvent } from "@absence/core";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useT } from "../../lib/i18n";

interface SpeechStageProps {
  text: string;
  streaming?: boolean;
  event?: AbsenceEvent;
}

/**
 * The agent's reply (as opposed to its reasoning). Same surface as the thought
 * panel — plain prose, nothing behind it — but its own header word, so a page
 * that says "speaking" is the answer and a page that says "thinking" is the
 * working. While the reply streams the text grows in place, because the item id
 * is stable for the session (see eventToStageItem).
 */
export function SpeechStage({ text, streaming, event }: SpeechStageProps) {
  const t = useT();
  const addContext = useChatStore((s) => s.addContext);

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-dim">{t("speaking")}</span>
        {streaming ? <span className="animate-pulse text-desk-amber">▍</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-desk-dim">
          <span>{t("{n} chars", { n: text.length })}</span>
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title={t("Add this to Chat")}
            >
              {t("+ Chat")}
            </button>
          ) : null}
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-desk-ink/85">
        {text}
      </div>
    </div>
  );
}
