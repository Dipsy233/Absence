import { AgentPanel } from "../agent/AgentPanel";
import { AgentFolder } from "../agent/AgentFolder";
import { AgentEggsPanel } from "../eggs/AgentEggsPanel";

/** Right rail: the agent's perspective — who it is, what it knows, what it left running. */
export function RightRail() {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <AgentPanel />
      <AgentFolder />
      <AgentEggsPanel />
    </div>
  );
}
