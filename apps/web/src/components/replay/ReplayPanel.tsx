import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { Panel } from "../Panel";
import { ReplayControls } from "./ReplayControls";
import { ReplayTimeline } from "./ReplayTimeline";

export function ReplayPanel() {
  const status = useReplayStore((s) => s.status);
  const events = useReplayStore((s) => s.events);
  const mode = useStageStore((s) => s.mode);
  const setMode = useStageStore((s) => s.setMode);

  const aside =
    mode !== "replay" ? "off" : status === "playing" ? "playing" : status === "paused" ? "paused" : "ready";

  return (
    <Panel
      title="Replay"
      aside={aside}
      className="min-h-0 flex-1"
      bodyClassName="flex flex-col gap-2"
    >
      {mode !== "replay" ? (
        <button
          type="button"
          disabled={events.length === 0}
          onClick={() => setMode("replay")}
          className="self-start rounded border border-desk-line px-2 py-1 text-xs text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber disabled:opacity-40"
        >
          Enter replay
        </button>
      ) : (
        <button
          type="button"
          onClick={() => setMode("live")}
          className="self-start rounded border border-desk-line px-2 py-1 text-xs text-desk-dim hover:border-desk-teal/60 hover:text-desk-teal"
        >
          Back to live
        </button>
      )}

      <ReplayControls />
      <ReplayTimeline />
    </Panel>
  );
}
