import type { DazeEvent } from "@daze/core";
import { useDazeStore } from "../../stores/useDazeStore";
import { Panel } from "../Panel";
import { formatClock } from "../../lib/format";

interface Row {
  key: string;
  time: string;
  action: string;
  primary: string;
  secondary?: string;
  tone: "read" | "edit" | "run" | "lifecycle" | "error";
}

function toRow(event: DazeEvent): Row {
  const time = formatClock(event.timestamp);
  switch (event.type) {
    case "file_read":
      return {
        key: event.id,
        time,
        action: "READ",
        primary: event.payload.path,
        secondary: `${event.payload.startLine}–${event.payload.endLine}`,
        tone: "read",
      };
    case "file_write":
      return { key: event.id, time, action: "WRITE", primary: event.payload.path, tone: "edit" };
    case "file_edit":
      return { key: event.id, time, action: "EDIT", primary: event.payload.path, tone: "edit" };
    case "file_change":
      return {
        key: event.id,
        time,
        action: event.payload.kind.toUpperCase(),
        primary: event.payload.path,
        tone: "edit",
      };
    case "command":
      return {
        key: event.id,
        time,
        action: "RUN",
        primary: event.payload.command,
        secondary: `exit ${event.payload.exitCode}`,
        tone: "run",
      };
    case "agent_start":
      return { key: event.id, time, action: "START", primary: event.payload.model, tone: "lifecycle" };
    case "agent_end":
      return { key: event.id, time, action: "END", primary: event.payload.reason, tone: "lifecycle" };
    case "error":
      return { key: event.id, time, action: "ERROR", primary: event.payload.message, tone: "error" };
    default:
      return { key: event.id, time, action: event.type.toUpperCase(), primary: "", tone: "lifecycle" };
  }
}

const TONE_CLASS: Record<Row["tone"], string> = {
  read: "text-desk-teal",
  edit: "text-desk-amber",
  run: "text-desk-ink",
  lifecycle: "text-desk-dim",
  error: "text-desk-ember",
};

export function Activity() {
  const activity = useDazeStore((s) => s.activity);
  const rows = activity.slice().reverse().map(toRow);

  return (
    <Panel title="Activity" aside={`${activity.length}`} className="min-h-0 flex-1">
      {rows.length === 0 ? (
        <p className="text-xs text-desk-dim">Nothing yet. Send the agent a task.</p>
      ) : (
        <ul className="space-y-1.5">
          {rows.map((row) => (
            <li key={row.key} className="font-mono text-[11px] leading-tight">
              <div className="flex items-baseline gap-2">
                <span className="text-desk-dim/70">{row.time}</span>
                <span className={["font-semibold", TONE_CLASS[row.tone]].join(" ")}>{row.action}</span>
                {row.secondary ? <span className="text-desk-dim">{row.secondary}</span> : null}
              </div>
              <div className="truncate pl-[68px] text-desk-ink/80" title={row.primary}>
                {row.primary}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
