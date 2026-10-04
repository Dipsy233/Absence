import { AgentPanel } from "../agent/AgentPanel";
import { AgentTable } from "../agent/AgentTable";
import { ChatPanel } from "../chat/ChatPanel";

/** Right rail: the agent's perspective — who it is, what it knows, and chat. */
export function RightRail() {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <AgentPanel />
      <AgentTable />
      <ChatPanel />
    </div>
  );
}
