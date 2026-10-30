import { useMemo, useState } from "react";
import { formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";
import type { ProcessFact, TimelineKind, TimelineNode } from "../../types/report";

/**
 * The run's world line, read the way Monitor reads it.
 *
 * Not a row of cards: one track, three lanes of activity, and each activity a
 * mark at the moment it happened. A mark's width is the time it was the thing
 * happening — the gap to the next activity, capped so a long silence is not a
 * wall of colour and floored so a 40 ms read is still a mark. Eggs are the one
 * exception: they are spans, drawn from laid to died, because that is what a
 * process is.
 *
 * Lane geometry is absolute (`lane top = 8 + n*14`, `block top = 4 + n*14`)
 * because a block has to sit *on* the lane, which a flex column of rows cannot
 * do. Lanes with no marks are not drawn at all: a run that never reasoned
 * should not show an empty Think row.
 *
 * Picking a mark puts that event in the report's evidence pane and leaves a
 * head line where it happened, the way a scrubber holds a replay position.
 * Hovering the track previews the moment under the pointer.
 */

export interface TimelinePick {
  eventId: string;
  node?: TimelineNode;
  /** Where the head line stands, in ms from the run's start. */
  anchorMs: number;
  /** Head label: `EDIT · 00:15`. */
  label: string;
}

const LANE_H = 14;
const TRACK_TOP = 8;

/** Lane ids, in the order they are drawn. */
const LANES: Array<{ id: string; label: string }> = [
  { id: "think", label: "Think" },
  { id: "knows", label: "Read · Search" },
  { id: "files", label: "Edit · Write" },
  { id: "shell", label: "Shell" },
];

interface Props {
  nodes: TimelineNode[];
  processes: ProcessFact[];
  /** The run's start, the origin every block is measured from. */
  startedAt: number;
  /** The run's length (ended-at or the newest activity), never below 1. */
  totalMs: number;
  selected?: TimelinePick;
  onPick: (pick: TimelinePick) => void;
}

interface Mark {
  key: string;
  laneId: string;
  left: number;
  width: number;
  tone: TimelineKind | "egg";
  title: string;
  pick: TimelinePick;
}

/** Which lane an activity belongs on, or undefined when it draws no mark. */
function laneFor(kind: TimelineKind): string | undefined {
  switch (kind) {
    case "think":
      return "think";
    case "read":
    case "search":
      return "knows";
    case "edit":
    case "write":
      return "files";
    case "run":
      return "shell";
    default:
      return undefined;
  }
}

export function ChartTimeline({ nodes, processes, startedAt, totalMs, selected, onPick }: Props) {
  const t = useT();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const total = Math.max(1, totalMs);

  /**
   * For each node, the offset of the next *activity* — one reverse pass.
   * `NaN` marks the last activity, whose span runs to the end of the line.
   */
  const nextActivityOffsetMs = useMemo(() => {
    const next = new Array<number>(nodes.length).fill(Number.NaN);
    let seen = Number.NaN;
    for (let i = nodes.length - 1; i >= 0; i--) {
      next[i] = seen;
      if (laneFor(nodes[i]!.kind) !== undefined) seen = nodes[i]!.offsetMs;
    }
    return next;
  }, [nodes]);

  const marks = useMemo(() => {
    const out: Mark[] = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      const laneId = laneFor(node.kind);
      if (laneId === undefined) continue;
      const nextMs = nextActivityOffsetMs[i]!;
      const span = Number.isNaN(nextMs) ? total - node.offsetMs : nextMs - node.offsetMs;
      out.push({
        key: `n-${node.eventId}-${node.kind}`,
        laneId,
        left: (node.offsetMs / total) * 100,
        width: Math.max(0.7, Math.min(28, (span / total) * 100)),
        tone: node.kind,
        title: `${t(node.action)} · ${node.subject} · ${formatOffset(node.offsetMs)}`,
        pick: {
          eventId: node.eventId,
          node,
          anchorMs: node.offsetMs,
          label: `${t(node.action)} · ${formatOffset(node.offsetMs)}`,
        },
      });
    }

    const eggs = processes.filter((process) => process.kind === "primary");
    for (const process of eggs) {
      const offset = Math.max(0, process.startedAt - startedAt);
      const end = Math.max(offset, (process.exitedAt ?? startedAt + total) - startedAt);
      out.push({
        key: `p-${process.pid}`,
        laneId: "eggs",
        left: (offset / total) * 100,
        width: Math.min(100 - (offset / total) * 100, Math.max(0.7, ((end - offset) / total) * 100)),
        tone: "egg",
        title: `${process.name} · pid ${process.pid} · ${formatOffset(offset)}`,
        pick: {
          eventId: process.evidence[0] ?? "",
          anchorMs: offset,
          label: `${process.name} · ${formatOffset(offset)}`,
        },
      });
    }
    return out;
  }, [nodes, nextActivityOffsetMs, processes, startedAt, total, t]);

  const shownLanes = useMemo(
    () =>
      [
        ...LANES.filter((lane) => marks.some((mark) => mark.laneId === lane.id)),
        ...(marks.some((mark) => mark.laneId === "eggs") ? [{ id: "eggs", label: t("Eggs") }] : []),
      ],
    [marks, t],
  );
  const laneIndex = useMemo(() => new Map(shownLanes.map((lane, index) => [lane.id, index])), [shownLanes]);
  const trackHeight = shownLanes.length * LANE_H + 2;
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));

  if (marks.length === 0) {
    return <p className="chart-tl__empty">{t("No events to draw yet.")}</p>;
  }

  const head = selected ? percent(selected.anchorMs) : 100;

  return (
    <div className="chart-tl">
      <div className="chart-tl__body">
        <div className="chart-labels" style={{ height: trackHeight }}>
          {shownLanes.map((lane) => (
            <span key={lane.id} style={{ height: LANE_H }}>
              {t(lane.label)}
            </span>
          ))}
        </div>

        <div
          className="chart-track"
          style={{ height: trackHeight }}
          role="group"
          aria-label={t("Run timeline")}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHover(Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))));
          }}
          onMouseLeave={() => setHover(undefined)}
        >
          {shownLanes.map((lane, index) => (
            <span key={lane.id} className="chart-lane" style={{ top: TRACK_TOP + index * LANE_H }} aria-hidden />
          ))}

          {marks.map((mark) => (
            <button
              key={mark.key}
              type="button"
              title={mark.title}
              onClick={() => onPick(mark.pick)}
              className={[
                "chart-blk",
                `chart-blk--${mark.tone}`,
                selected?.eventId === mark.pick.eventId ? "chart-blk--sel" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              style={{
                top: TRACK_TOP - 4 + laneIndex.get(mark.laneId)! * LANE_H,
                left: `${mark.left}%`,
                width: `${mark.width}%`,
              }}
            />
          ))}

          {/* The moment under the pointer, under the real head: a click on a
              40ms mark is guesswork without it. */}
          {hover !== undefined ? (
            <span className="chart-ghost" style={{ left: `${hover * 100}%` }} aria-hidden>
              <span className="chart-ghost__label">{formatOffset(hover * total)}</span>
            </span>
          ) : null}

          {selected ? (
            <span className="chart-head" style={{ left: `${head}%` }} aria-hidden>
              <span className="chart-head__label">{selected.label}</span>
            </span>
          ) : (
            <span className="chart-livehead" aria-hidden />
          )}
        </div>
      </div>

      <div className="chart-axis-row">
        <span className="chart-axis-spacer" aria-hidden />
        <div className="chart-axis">
          {Array.from({ length: 5 }, (_, index) => (
            <span key={index}>{formatOffset((total * index) / 4)}</span>
          ))}
        </div>
      </div>
    </div>
  );
}
