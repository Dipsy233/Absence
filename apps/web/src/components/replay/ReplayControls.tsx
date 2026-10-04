import { REPLAY_SPEEDS } from "../../types/replay";
import { useReplayStore } from "../../stores/replayStore";
import { useReplayClock } from "../../hooks/useReplay";
import { formatOffset } from "../../lib/format";

export function ReplayControls() {
  const status = useReplayStore((s) => s.status);
  const speed = useReplayStore((s) => s.speed);
  const play = useReplayStore((s) => s.play);
  const pause = useReplayStore((s) => s.pause);
  const stop = useReplayStore((s) => s.stop);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const stepForward = useReplayStore((s) => s.stepForward);
  const stepBackward = useReplayStore((s) => s.stepBackward);
  const clock = useReplayClock();

  const button =
    "rounded border border-desk-line px-1.5 py-0.5 font-mono text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber";

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1">
        <button type="button" className={button} onClick={stepBackward} title="Step backward">
          ◀
        </button>
        {status === "playing" ? (
          <button type="button" className={button} onClick={pause} title="Pause">
            ⏸
          </button>
        ) : (
          <button type="button" className={button} onClick={play} title="Play">
            ▶
          </button>
        )}
        <button type="button" className={button} onClick={stop} title="Stop and return to live">
          ■
        </button>
        <button type="button" className={button} onClick={stepForward} title="Step forward">
          ▶|
        </button>
        <span className="ml-auto font-mono text-[10px] text-desk-dim">
          {formatOffset(clock.currentTime - clock.start)} / {formatOffset(clock.duration)}
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        {REPLAY_SPEEDS.map((value) => (
          <button
            key={value}
            type="button"
            onClick={() => setSpeed(value)}
            className={[
              "rounded px-1.5 py-0.5 font-mono text-[10px]",
              speed === value
                ? "bg-desk-amber/15 text-desk-amber"
                : "text-desk-dim hover:text-desk-ink",
            ].join(" ")}
          >
            {value}x
          </button>
        ))}
      </div>
    </div>
  );
}
