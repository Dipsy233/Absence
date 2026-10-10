import { AgentPanel } from "../agent/AgentPanel";
import { AgentFolder } from "../agent/AgentFolder";
import { AgentEggsPanel } from "../eggs/AgentEggsPanel";
import { useSettingsStore, type RailPanelId } from "../../stores/settingsStore";

const PANELS: Record<RailPanelId, () => React.ReactElement> = {
  agent: AgentPanel,
  folder: AgentFolder,
  eggs: AgentEggsPanel,
};

/** Right rail: the agent's perspective — who it is, what it knows, what it left
 * running. Stacking order is user-configurable in the Settings dialog. */
export function RightRail() {
  const railOrder = useSettingsStore((s) => s.railOrder);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {railOrder.map((id) => {
        const Panel = PANELS[id];
        return <Panel key={id} />;
      })}
    </div>
  );
}
