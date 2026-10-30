import { formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { CommandFact, ProcessFact, TimelineKind, TimelineNode } from "../../types/report";

/**
 * The run as lanes, not a list.
 *
 * A world line in the classic sense reads left to right for time, so each kind
 * of activity gets its own lane and each activity a block where it happened:
 * a thought is a point, a command is as long as it ran, an egg is a span from
 * laid to died. Blocks carry the evidence — clicking one picks the event behind
 * it, and the report's preview pane shows what that event actually was. The
 * guide line marks the pick, the way a scrubber marks a replay position.
 *
 * Everything here is derived from the engine's `TimelineNode`s plus the run's
 * command and process facts — no parsing, no guessing.
 */

export interface TimelinePick {
  eventId: string;
  node?: TimelineNode;
  /** Where the guide line stands, in ms from the run's start. */
  anchorMs: number;
  /** Guide label: `EDIT · 00:15`. */
  label: string;
}

const KIND_COLOR: Record<TimelineKind, string> = {
  start: "var(--ch-t3)",
  think: "var(--ch-think)",
  read: "var(--ch-read)",
  search: "var(--ch-search)",
  edit: "var(--ch-edit)",
  write: "#5a9a70",
  run: "var(--ch-run)",
  process: "var(--ch-egg)",
  observe: "#8a8780",
  error: "var(--ch-err)",
  end: "var(--ch-t3)",
};

/** The four lanes the mockup draws; `other` catches start / end / observe / error. */
const LANES: Array<{ id: string; label: string; kinds: TimelineKind[] }> = [
  { id: "think", label: "Think", kinds: ["think"] },
  { id: "knows", label: "Read · Search", kinds: ["read", "search"] },
  { id: "files", label: "Edit · Write", kinds: ["edit", "write"] },
  { id: "shell", label: "Shell", kinds: ["run"] },
];

const OTHER_KINDS: TimelineKind[] = ["start", "observe", "error", "end"];

interface Props {
  nodes: TimelineNode[];
  processes: ProcessFact[];
  commands: CommandFact[];
  /** The run's start, the origin every block is measured from. */
  startedAt: number;
  /** The run's length (ended-at or the newest activity), never below 1. */
  totalMs: number;
  selected?: TimelinePick;
  onPick: (pick: TimelinePick) => void;
}

export function ChartTimeline({ nodes, processes, commands, startedAt, totalMs, selected, onPick }: Props) {
  const t = useT();
  const span = Math.max(1, totalMs);

  const durationByEvent = new Map<string, number>();
  for (const command of commands) {
    if (command.eventId && command.durationMs !== undefined) durationByEvent.set(command.eventId, command.durationMs);
  }

  const pct = (ms: number) => Math.min(100, Math.max(0, (ms / span) * 100));

  const otherNodes = nodes.filter((node) => OTHER_KINDS.includes(node.kind));
  const eggs = processes.filter((process) => process.kind === "primary");
  const hasAnything = nodes.length > 0 || eggs.length > 0;

  const block = (node: TimelineNode) => {
    const left = pct(node.offsetMs);
    // A command that ran to the end of the run must not push its block past the
    // right edge: the width is the part of the timeline still in front of it.
    const width = Math.min(pct(durationByEvent.get(node.eventId) ?? 0), 100 - left);
    const isSelected = selected?.eventId === node.eventId;
    return (
      <button
        key={`${node.eventId}-${node.kind}`}
        type="button"
        title={`${t(node.action)} · ${node.subject} — ${formatOffset(node.offsetMs)}`}
        onClick={() =>
          onPick({
            eventId: node.eventId,
            node,
            anchorMs: node.offsetMs,
            label: `${t(node.action)} · ${formatOffset(node.offsetMs)}`,
          })
        }
        className={`chart-b${isSelected ? " chart-b--sel" : ""}`}
        style={{
          left: `${left}%`,
          width: width > 0 ? `max(${width}%, 6px)` : 6,
          background: KIND_COLOR[node.kind],
        }}
      />
    );
  };

  return (
    <div className="chart-lanes">
      {LANES.map((lane) => (
        <Row key={lane.id} label={t(lane.label)} blocks={nodes.filter((node) => lane.kinds.includes(node.kind)).map(block)} />
      ))}

      {/* Eggs are spans, not points: laid to died, or laid to now. */}
      <Row
        label={t("Eggs")}
        blocks={eggs.map((process) => {
          const offset = Math.max(0, process.startedAt - startedAt);
          const end = Math.max(offset, (process.exitedAt ?? startedAt + span) - startedAt);
          const left = pct(offset);
          const width = Math.min(pct(end - offset), 100 - left);
          const isSelected = selected?.eventId === process.evidence[0];
          return (
            <button
              key={`egg-${process.pid}`}
              type="button"
              title={`${process.name} · pid ${process.pid} — ${formatOffset(offset)}`}
              onClick={() =>
                onPick({
                  eventId: process.evidence[0] ?? "",
                  anchorMs: offset,
                  label: `${process.name} · ${formatOffset(offset)}`,
                })
              }
              className={`chart-b chart-b--egg${isSelected ? " chart-b--sel" : ""}`}
              style={{
                left: `${left}%`,
                width: `max(${width}%, 8px)`,
                minWidth: 8,
              }}
            />
          );
        })}
      />

      {otherNodes.length > 0 ? <Row label={t("Other")} blocks={otherNodes.map(block)} /> : null}

      {hasAnything ? (
        <>
          <div className="chart-axis">
            {Array.from({ length: 5 }, (_, index) => (
              <span key={index}>{formatOffset((span * index) / 4)}</span>
            ))}
          </div>
          {selected ? (
            <span className="chart-guide" style={{ left: `calc(84px + (100% - 84px) * ${pct(selected.anchorMs) / 100})` }}>
              <span>{selected.label}</span>
            </span>
          ) : null}
        </>
      ) : (
        <p className="chart-empty-note" style={{ gridColumn: "2" }}>
          {t("No events to draw yet.")}
        </p>
      )}
    </div>
  );
}

function Row({ label, blocks }: { label: string; blocks: React.ReactNode }) {
  return (
    <>
      <div className="chart-ll">{label}</div>
      <div className="chart-lt">{blocks}</div>
    </>
  );
}
