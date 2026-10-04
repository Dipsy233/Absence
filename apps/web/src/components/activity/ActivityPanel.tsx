import { useMemo } from "react";
import type { ActivityRow } from "../../types/stage";
import { useSessionStore } from "../../stores/sessionStore";
import { eventToActivityRow } from "../../lib/events";
import { Panel } from "../Panel";
import { ActivityItem } from "./ActivityItem";

export function ActivityPanel() {
  const events = useSessionStore((s) => s.events);

  const rows = useMemo(
    () => events.map(eventToActivityRow).filter((row): row is ActivityRow => row !== undefined),
    [events],
  );

  return (
    <Panel title="Activity" aside={`${rows.length}`} className="min-h-0 flex-1">
      {rows.length === 0 ? (
        <p className="text-xs text-desk-dim">Nothing yet. Send the agent a task.</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <ActivityItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </Panel>
  );
}
