import { useMemo, useState } from "react";
import { formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { layoutTimeline } from "../../lib/timeline";
import type { TimelineTrack } from "../../lib/timeline";
import type { TimelineNode } from "../../types/report";

/**
 * The run's world line, read the way Monitor reads it.
 *
 * Not a row of cards: one track per kind of work — the model's reasoning and
 * words, the tools it called, the shell commands it ran — and each activity a
 * mark at the moment it happened. A mark's width is the time it was the thing
 * happening on its own track, capped so a long silence is not a wall of colour
 * and floored so a 40 ms read is still a mark.
 *
 * Track membership, bucketing and geometry live in `lib/timeline`; this
 * component only draws what the layout hands it, so adding or removing a track
 * never changes the other tracks' rendering.
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

interface Props {
  /** The run's world line, already split into its tracks. */
  tracks: TimelineTrack[];
  /** The run's length (ended-at or the newest activity), never below 1. */
  totalMs: number;
  selected?: TimelinePick;
  onPick: (pick: TimelinePick) => void;
}

export function ChartTimeline({ tracks, totalMs, selected, onPick }: Props) {
  const t = useT();
  const [hover, setHover] = useState<number | undefined>(undefined);
  const total = Math.max(1, totalMs);

  const layout = useMemo(() => layoutTimeline(tracks, total), [tracks, total]);
  const shownTracks = layout.tracks;
  const marks = layout.marks;
  const laneIndex = useMemo(
    () => new Map(shownTracks.map((track, index) => [track.id, index])),
    [shownTracks],
  );
  const trackHeight = shownTracks.length * LANE_H + 2;
  const percent = (ms: number) => Math.min(100, Math.max(0, (ms / total) * 100));

  if (marks.length === 0) {
    return <p className="chart-tl__empty">{t("No events to draw yet.")}</p>;
  }

  const head = selected ? percent(selected.anchorMs) : 100;

  return (
    <div className="chart-tl">
      <div className="chart-tl__body">
        <div className="chart-labels" style={{ height: trackHeight }}>
          {shownTracks.map((track) => (
            <span key={track.id} style={{ height: LANE_H }}>
              {t(track.label)}
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
          {shownTracks.map((track, index) => (
            <span key={track.id} className="chart-lane" style={{ top: TRACK_TOP + index * LANE_H }} aria-hidden />
          ))}

          {marks.map((mark) => {
            const node = mark.node;
            return (
              <button
                key={`n-${node.eventId}-${node.kind}`}
                type="button"
                title={`${t(node.action)} · ${node.subject} · ${formatOffset(node.offsetMs)}`}
                onClick={() =>
                  onPick({
                    eventId: node.eventId,
                    node,
                    anchorMs: node.offsetMs,
                    label: `${t(node.action)} · ${formatOffset(node.offsetMs)}`,
                  })
                }
                className={[
                  "chart-blk",
                  `chart-blk--${node.kind}`,
                  selected?.eventId === node.eventId ? "chart-blk--sel" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                style={{
                  top: TRACK_TOP - 4 + laneIndex.get(mark.trackId)! * LANE_H,
                  left: `${mark.left}%`,
                  width: `${mark.width}%`,
                }}
              />
            );
          })}

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
