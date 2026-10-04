import { useSessionStore } from "../../stores/sessionStore";
import { Panel } from "../Panel";

/** The plan as a piece of paper on the desk. Display only (read02 §30). */
export function PlanPanel() {
  const plan = useSessionStore((s) => s.plan);

  return (
    <Panel title="Plan" aside={plan?.source} className="shrink-0" bodyClassName="p-2">
      {plan && plan.items.length > 0 ? (
        <ul className="space-y-1">
          {plan.items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-[11px]">
              <span className={item.done ? "text-desk-teal" : "text-desk-dim"}>{item.done ? "✓" : "○"}</span>
              <span className={item.done ? "text-desk-dim line-through" : "text-desk-ink"}>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[11px] text-desk-dim">No plan. Add a TODO.md and DAZE will show it.</p>
      )}
    </Panel>
  );
}
