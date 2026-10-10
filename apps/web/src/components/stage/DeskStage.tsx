import { isAgentBusy, type AgentStatus } from "@absence/core";

/**
 * The default desk page (read02 §11, §34). Nothing draws here — the desk stays
 * a clean backdrop with just the caption floating on the Stage world.
 */
export function DeskStage({ status }: { status: AgentStatus }) {
  const caption = isAgentBusy(status) ? "The agent is working…" : "The agent is listening.";

  return (
    <div className="flex h-full items-center justify-center">
      <p className="rounded-full bg-black/35 px-3 py-1 text-xs italic text-desk-ink/80 backdrop-blur-[2px]">
        {caption}
      </p>
    </div>
  );
}
