import type { AbsenceEvent } from "@absence/core";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useT } from "../../lib/i18n";

interface ErrorStageProps {
  message: string;
  event?: AbsenceEvent;
}

/**
 * An error reported by the agent or its adapter.
 *
 * It is plain prose like a reply, but its own header word and colour: an error
 * must read as a failure, not as something the agent said. The text is shown
 * verbatim — Absence does not shorten or interpret an agent's error.
 */
export function ErrorStage({ message, event }: ErrorStageProps) {
  const t = useT();
  const addContext = useChatStore((s) => s.addContext);

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-ember">{t("error")}</span>
        <span className="ml-auto flex shrink-0 items-center gap-2 text-desk-dim">
          <span>{t("{n} chars", { n: message.length })}</span>
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
        {message}
      </div>
    </div>
  );
}
