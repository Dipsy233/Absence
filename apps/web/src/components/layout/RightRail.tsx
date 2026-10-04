import { AgentPanel } from "../agent/AgentPanel";
import { ChatPanel } from "../chat/ChatPanel";
import { PlanPanel } from "../desk/PlanPanel";

/** Right rail: Agent, Plan, Chat (read02 §4.3). */
export function RightRail() {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <AgentPanel />
      <PlanPanel />
      <ChatPanel />
    </div>
  );
}
