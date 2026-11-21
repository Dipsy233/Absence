import type { AbsenceEvent } from "@absence/core";
import { useT } from "../../lib/i18n";

interface ThoughtStageProps {
  text: string;
  streaming?: boolean;
  event?: AbsenceEvent;
}

/**
 * The agent's reasoning (read02 §12). Thinking has no file or command behind it,
 * so the Stage shows it as plain prose — that is the whole content. While Pi
 * streams, the text grows in place instead of the panel re-mounting, because the
 * item id is stable for the session (see eventToStageItem).
 */
export function ThoughtStage({ text, streaming, event }: ThoughtStageProps) {
  const t = useT();

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-dim">{t("thinking")}</span>
        {streaming ? <span className="animate-pulse text-desk-amber">▍</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2 text-desk-dim">
          <span>{t("{n} chars", { n: text.length })}</span>
        </span>
      </div>
      <div className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 text-xs leading-relaxed text-desk-ink/85">
        {text.length > 0 ? text : t("(thinking…)")}
      </div>
    </div>
  );
}
