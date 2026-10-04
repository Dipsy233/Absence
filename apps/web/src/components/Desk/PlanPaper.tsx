import { useDazeStore } from "../../stores/useDazeStore";
import { Panel } from "../Panel";

/** The plan as a piece of paper on the desk (read.md §22, §30). Display only. */
export function PlanPaper() {
  const plan = useDazeStore((s) => s.plan);

  return (
    <Panel title="Plan" aside={plan?.source} className="shrink-0">
      {plan && plan.items.length > 0 ? (
        <ul className="space-y-1.5">
          {plan.items.map((item, index) => (
            <li key={index} className="flex items-start gap-2 text-xs">
              <span className={item.done ? "text-desk-teal" : "text-desk-dim"}>
                {item.done ? "✓" : "○"}
              </span>
              <span className={item.done ? "text-desk-dim line-through" : "text-desk-ink"}>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-desk-dim">No plan yet. Add a TODO.md to the project and DAZE will show it.</p>
      )}
    </Panel>
  );
}
