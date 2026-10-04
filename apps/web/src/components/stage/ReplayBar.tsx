import { REPLAY_SPEEDS } from "../../types/replay";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useReplayClock } from "../../hooks/useReplay";
import { formatOffset } from "../../lib/format";

const BUTTON =
  "rounded border border-desk-line px-2 py-0.5 font-mono text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber";

/**
 * Playback controls live inside the Stage while replaying (read02 §22), so the
 * Stage is a self-contained replay surface.
 */
export function ReplayBar() {
  const status = useReplayStore((s) => s.status);
  const speed = useReplayStore((s) => s.speed);
  const label = useReplayStore((s) => s.label);
  const play = useReplayStore((s) => s.play);
  const pause = useReplayStore((s) => s.pause);
  const stop = useReplayStore((s) => s.stop);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const seekRatio = useReplayStore((s) => s.seekRatio);
  const stepForward = useReplayStore((s) => s.stepForward);
  const stepBackward = useReplayStore((s) => s.stepBackward);
  const goLive = useStageStore((s) => s.goLive);

  const clock = useReplayClock();

  return (
    <div className="shrink-0 border-t border-desk-line bg-desk-panel px-2 py-1.5">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-desk-dim" title={label ?? "replay"}>
          {label ?? "replay"}
        </span>
        <button type="button" className={BUTTON} onClick={stepBackward} title="Step backward">
          ◀
        </button>
        {status === "playing" ? (
          <button type="button" className={BUTTON} onClick={pause} title="Pause">
            ⏸
          </button>
        ) : (
          <button type="button" className={BUTTON} onClick={play} title="Play">
            ▶
          </button>
        )}
        <button type="button" className={BUTTON} onClick={stop} title="Jump to the end">
          ■
        </button>
        <button type="button" className={BUTTON} onClick={stepForward} title="Step forward">
          ▶|
        </button>
        <span className="shrink-0 font-mono text-[10px] text-desk-dim">
          {formatOffset(clock.currentTime - clock.start)} / {formatOffset(clock.duration)}
        </span>
        <button type="button" className={BUTTON} onClick={goLive} title="Leave replay">
          back to live
        </button>
      </div>

      <div className="mt-1 flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(clock.progress * 1000)}
          onChange={(event) => seekRatio(Number(event.target.value) / 1000)}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-desk-amber"
          aria-label="Replay position"
        />
        <div className="flex shrink-0 items-center gap-0.5">
          {REPLAY_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setSpeed(value)}
              className={[
                "rounded px-1 py-0.5 font-mono text-[10px]",
                speed === value ? "bg-desk-amber/15 text-desk-amber" : "text-desk-dim hover:text-desk-ink",
              ].join(" ")}
            >
              {value}x
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
