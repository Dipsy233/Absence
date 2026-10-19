import { isAgentBusy, type AgentStatus } from "@absence/core";
import { useT } from "../../lib/i18n";

/**
 * The default desk page (read02 §11, §34). Nothing draws here — the desk stays
 * a clean backdrop with just the caption floating on the Stage world.
 *
 * The caption is the one place Absence says, in words, what kind of session
 * this is: driving an agent it owns, or watching an agent that belongs to a
 * terminal somewhere else. The distinction matters to the person reading it —
 * no agent activity in the Activity panel means very different things.
 */
export function DeskStage({
  status,
  observedLabel,
}: {
  status: AgentStatus;
  /** Set when Absence only watches this agent (see SessionSource). */
  observedLabel?: string;
}) {
  const t = useT();
  const caption = observedLabel
    ? isAgentBusy(status)
      ? t("Watching {label} work. Its terminal is the one to type in.", { label: observedLabel })
      : t("Watching {label} — nothing it started is running.", { label: observedLabel })
    : isAgentBusy(status)
      ? t("The agent is working…")
      : t("The agent is listening.");

  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {caption}
      </p>
    </div>
  );
}
