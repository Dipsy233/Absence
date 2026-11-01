import { useEffect, useMemo, useRef } from "react";
import { formatClock, formatOffset } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import type { ActivityRow } from "../../types/stage";
import { playingState, replayRowAt } from "../../lib/history";
import { Dot, TONE_FOR_ROW } from "../shared/atoms";
import type { RoundsData } from "./useRoundsData";
import { RUN_TONE, RUN_WORD } from "../shared/atoms";
import { useRideScroll } from "../shared/rideScroll";

/**
 * The story: the run's steps as a chain of cards, oldest first.
 *
 * One card per activity row — the same rows the Activity feed shows, read as a
 * narrative — and clicking a card rewinds to that step: pin it when live (the
 * whole face then holds that moment), scrub to it when a replay is on screen.
 * The current step lights up (`card now`); a dashed ghost trails the chain so
 * the story visibly continues.
 *
 * Like the feed, only *state re-reports* would deserve folding, and the fold
 * lives in the feed rather than here: the story is short by construction (one
 * card per act), and a rewind target that absorbed two reads would be a lie.
 */
export function RoundsStory({ data, onLive }: { data: RoundsData; onLive: () => void }) {
  const t = useT();
  const openStage = useStageStore((s) => s.openStage);
  const seek = useReplayStore((s) => s.seekTimestamp);
  const stageMode = useStageStore((s) => s.mode);
  const inReplay = stageMode === "replay";
  const replayTime = useReplayStore((s) => s.currentTime);
  const runStart = data.run?.startedAt;

  /** The card the clock is on: in replay the cursor's row id; live/pinned, the
      stage item's id (rows and items agree on it — see eventToStageItem). */
  const currentId = useMemo(() => {
    if (inReplay) {
      // The shared scan (lib/history) — the same rule Monitor's feed follows.
      return replayRowAt(data.rows, replayTime)?.id;
    }
    return data.item?.id;
  }, [inReplay, replayTime, data.rows, data.following, data.item]);

  const activate = (row: ActivityRow) => {
    if (inReplay) {
      seek(row.event.timestamp);
      return;
    }
    if (row.stageItem) openStage(row.stageItem);
  };

  /**
   * The stream, with the opening folded into one card.
   *
   * A run announces itself twice: the user's message opens it, then
   * `agent_start` names the model. Two START cards for one beginning read as
   * two runs, so the model becomes the meta line of the prompt's card. The run
   * ends on its own card — an END is how the reader sees the run stop.
   */
  const shown = useMemo(() => {
    void data.rowsVersion;
    const out: ActivityRow[] = [];
    let open: number | undefined;
    for (const row of data.rows) {
      if (row.action === "START") {
        if (open !== undefined) {
          out[open] = { ...out[open]!, secondary: row.primary };
          continue;
        }
        open = out.length;
      } else {
        open = undefined;
      }
      out.push(row);
    }
    return out;
  }, [data.rows, data.rowsVersion]);

  /**
   * What the story is doing with the run — the shared `playingState` rule
   * (lib/history), the same words Monitor's rail prints: a walking replay and
   * a pinned moment both read REPLAY.
   */
  const playing = playingState(data.following, data.item, inReplay);
  const playingTone = playing === "replay" ? "run" : "edit";

  /**
   * A story reads sideways, so the wheel reads sideways too: the wheel's
   * vertical delta scrolls the chain horizontally, the way every filmstrip
   * widget does.
   */
  const cardsRef = useRef<HTMLDivElement>(null);
  useRideScroll("bottom", cardsRef);
  useEffect(() => {
    const el = cardsRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      el.scrollLeft += event.deltaY;
      event.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  return (
    <div className="rounds-story">
      <div className="rounds-story__h">
        <span className={`rounds-story__play mon-chip--${playingTone}`} title={t("What the story is showing")}>
          <Dot tone={playingTone} />
          {t(playing).toUpperCase()}
        </span>
        {data.run ? (
          <span className="rounds-story__run">
            <i className="rounds-dot" data-tone={RUN_TONE[data.run.status]} aria-hidden />
            <span className="mon-mono">
              #{data.run.index} · {t(RUN_WORD[data.run.status])}
            </span>
          </span>
        ) : null}
        <span className="rounds-story__hint">{t("{n} steps", { n: shown.length })}</span>
        {data.run ? (
          <span className="rounds-story__counts mon-mono">
            R{data.run.counts.read} S{data.run.counts.search} E{data.run.counts.edit} ${data.run.counts.run}
          </span>
        ) : null}
        <span style={{ flex: 1 }} />
        {/* Always mounted: appearing and disappearing here would shove the
            whole header around on every live↔replay switch. Between states
            the button only fades, keeping its slot. */}
        <button
          type="button"
          className="rounds-ghostbtn"
          onClick={onLive}
          data-off={data.following ? "true" : undefined}
          tabIndex={data.following ? -1 : 0}
          aria-hidden={data.following}
        >
          {t("Back to live")}
        </button>
      </div>
      <div className="rounds-cards" ref={cardsRef}>
        {shown.length === 0 ? (
          <span className="rounds-story__empty">{t("Nothing yet. Send the agent a task.")}</span>
        ) : (
          shown.map((row, i) => {
            // A row is current only when the clock has a row to point at: with
            // nothing pinned (currentId undefined) an undefined-vs-undefined
            // comparison used to light up every stage-less row (START, END).
            const now = inReplay
              ? row.id === currentId
              : row.stageItem !== undefined && row.stageItem.id === currentId;
            return (
              <span key={row.id} className="rounds-cardpair">
                <button
                  type="button"
                  className="rounds-card"
                  data-now={now ? "true" : undefined}
                  data-dim={row.stageItem === undefined && !inReplay ? "true" : undefined}
                  onClick={() => activate(row)}
                  title={row.stageItem ? row.primary : `${row.action} · ${row.primary}`}
                >
                  <span
                    className={`rounds-chip rounds-chip--${TONE_FOR_ROW[row.tone] ?? "mute"} rounds-card__k`}
                  >
                    {row.action}
                  </span>
                  <span className="rounds-card__t">{row.primary}</span>
                  <span className="rounds-card__m">{row.secondary ?? ""}</span>
                  <span className="rounds-card__tm mon-mono">
                    {runStart !== undefined ? formatOffset(row.event.timestamp - runStart) : "—"}
                  </span>
                  <span className="rounds-card__at mon-mono">{formatClock(row.event.timestamp)}</span>
                </button>
                {i < shown.length - 1 ? <i className="rounds-conn" aria-hidden /> : null}
              </span>
            );
          })
        )}
      </div>
    </div>
  );
}

