import { AGENT_STATUSES, moodFor, statusLabel, type AgentVisualState } from "../../lib/agent";
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
      <div className="h-[172px]">
        <Avatar visual={visual} />
      </div>

      <ul className="mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5 border-t border-desk-line pt-2">
        {AGENT_STATUSES.map((candidate) => (
          <li
            key={candidate}
            className={[
              "text-[10px] uppercase tracking-wide",
              candidate === status ? "text-desk-amber" : "text-desk-dim",
            ].join(" ")}
          >
            {statusLabel(candidate)}
          </li>
        ))}
      </ul>
    </Panel>
  );
}
