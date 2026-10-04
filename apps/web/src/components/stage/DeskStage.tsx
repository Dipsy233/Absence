import type { AgentStatus, Plan } from "@daze/core";

interface DeskStageProps {
  plan?: Plan;
  status: AgentStatus;
}

/**
 * The desk the agent sits at (read02 §11, §34). v0.2 is a quiet placeholder —
 * the full 2D desk lands in v0.3 — but the plan is a real object on it.
 */
export function DeskStage({ plan, status }: DeskStageProps) {
  const caption = status === "completed" ? "The agent has finished." : "The agent is sitting quietly.";

  return (
    <div className="flex h-full min-h-0 flex-col items-center justify-center gap-6 text-desk-dim">
      <div className="relative">
        <div className="h-24 w-40 rounded-md border border-desk-line bg-desk-panel2 shadow-inner">
          <div className="m-2 flex h-[calc(100%-16px)] items-center justify-center rounded bg-[#0f0d0b] font-mono text-[10px] text-desk-dim/60">
            DAZE
          </div>
        </div>
        <div className="mx-auto h-3 w-12 rounded-b border-x border-b border-desk-line bg-desk-panel2" />
        <div className="mx-auto h-1.5 w-24 rounded-b bg-desk-line" />
      </div>

      {plan && plan.items.length > 0 ? (
        <div className="w-[240px] rotate-[-1.2deg] rounded bg-[#efe7db] p-3 text-[#3a332c] shadow-lg">
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.2em] text-[#9a8f80]">
            {plan.title ?? "PLAN"}
          </div>
          <ul className="space-y-1">
            {plan.items.map((item, index) => (
              <li key={index} className="flex items-start gap-1.5 text-[11px] leading-tight">
                <span className={item.done ? "text-[#5fa8a0]" : "text-[#9a8f80]"}>{item.done ? "✓" : "○"}</span>
                <span className={item.done ? "line-through opacity-60" : ""}>{item.text}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-xs italic">{caption}</p>
    </div>
  );
}
