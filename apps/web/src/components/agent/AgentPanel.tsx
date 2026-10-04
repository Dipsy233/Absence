import { moodFor, type AgentVisualState } from "../../lib/agent";
import { useSessionStore } from "../../stores/sessionStore";
import { Avatar } from "./Avatar";
import { Panel } from "../Panel";

/** Agent status driven purely by the event stream (read02 §31–32). */
export function AgentPanel() {
  const status = useSessionStore((s) => s.agent.status);
  const model = useSessionStore((s) => s.agent.model);

  const visual: AgentVisualState = { status, mood: moodFor(status) };

  return (
    <Panel title="Agent" aside={model} className="shrink-0" bodyClassName="p-2">
      <div className="h-[184px]">
        <Avatar visual={visual} />
      </div>
    </Panel>
  );
}
