import { useEffect } from "react";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { useViewModeStore } from "../../stores/viewModeStore";
import { viewModeSpec } from "../../lib/viewMode";
import { FaceBar } from "../../components/layout/FaceBar";
import { MonitorLeft } from "./MonitorLeft";
import { MonitorStage } from "./MonitorStage";
import { MonitorRight } from "./MonitorRight";
import { useMonitorData } from "../../hooks/useMonitorData";
import type { ActivityRow } from "../../types/stage";
import "./monitor.css";

/**
 * MONITOR (机器监护) — the heavy face.
 *
 * Three columns, one screen: what the agent did (left), what it is looking at
 * (centre), who it is and what it costs (right). The avatar is a status light
 * in the corner, not the subject; the subject is the trace.
 *
 * Everything it draws comes from `useMonitorData`, so the phase, the attention
 * verdict and the rail's counters can never disagree about the same run.
 */
export function MonitorUI() {
  const data = useMonitorData();
  const mode = useViewModeStore((s) => s.mode);

  const openStage = useStageStore((s) => s.openStage);
  const goLive = useStageStore((s) => s.goLive);
  const selectRun = useUiStore((s) => s.selectRun);

  // The keyboard contract: ⏎ back to live. Deliberately absent from Classic,
  // which has its own toolbar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        goLive();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goLive]);
  const open = (row: ActivityRow) => {
    if (!row.stageItem) return;
    openStage(row.stageItem);
  };

  return (
    <div className="mon-root mon-shell">
      <FaceBar />

      <div className="mon-body">
        <MonitorLeft
          data={data}
          onOpen={open}
          onSelectRun={(id) => {
            selectRun(id);
            goLive();
          }}
        />
        <MonitorStage data={data} />
        <MonitorRight data={data} />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
