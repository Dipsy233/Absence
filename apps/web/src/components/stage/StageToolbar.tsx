import type { StageItemType } from "../../types/stage";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";

/**
 * Three groups (read02 §13):
 *   left   — the user's view (whole file from the project tree, diffs, replay)
 *   centre — back to the default page (METRICS)
 *   right  — the agent's view (its terminal, the file it has in context, live)
 */
export function StageToolbar() {
  const t = useT();
  const mode = useStageStore((s) => s.mode);
  const activeId = useStageStore((s) => s.activeItem?.id);
  const lastByType = useStageStore((s) => s.lastByType);
  const userFile = useStageStore((s) => s.userFile);
  const agentFile = useStageStore((s) => s.agentFile);
  const showType = useStageStore((s) => s.showType);
  const showUserFile = useStageStore((s) => s.showUserFile);
  const showAgentFile = useStageStore((s) => s.showAgentFile);
  const setMode = useStageStore((s) => s.setMode);
  const goMetrics = useStageStore((s) => s.goMetrics);
  const replayReady = useReplayStore((s) => s.events.length > 0);
  const agentOnStage = useUiStore((s) => s.agentOnStage);
  const toggleAgentOnStage = useUiStore((s) => s.toggleAgentOnStage);

  const buttonClass = (active: boolean, enabled: boolean) =>
    [
      "rounded px-2 py-1 font-mono text-[10px] tracking-[0.12em] transition-colors",
      active
        ? "bg-desk-panel2 text-desk-amber"
        : enabled
          ? "text-desk-dim hover:text-desk-ink"
          : "cursor-not-allowed text-desk-dim/30",
    ].join(" ");

  const itemButton = (type: StageItemType, label: string) => (
    <button
      key={type}
      type="button"
      disabled={lastByType[type] === undefined}
      onClick={() => showType(type)}
      className={buttonClass(mode === type && activeId === lastByType[type]?.id, lastByType[type] !== undefined)}
    >
      {t(label)}
    </button>
  );

  return (
    <div className="relative flex shrink-0 items-center gap-1 border-b border-desk-line px-2 py-1.5">
      {/* user perspective */}
      <button
        type="button"
        disabled={!userFile}
        onClick={showUserFile}
        title={t("The whole file you opened from the project tree")}
        className={buttonClass(mode === "file" && activeId !== undefined && activeId === userFile?.id, !!userFile)}
      >
        {t("FILE")}
      </button>
      {itemButton("diff", "DIFF")}
      <button
        type="button"
        disabled={!replayReady}
        onClick={() => setMode("replay")}
        className={buttonClass(mode === "replay", replayReady)}
      >
        {t("REPLAY")}
      </button>

      {/* centre — back to the default page for the current Stage background */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <button
          type="button"
          onClick={agentOnStage ? toggleAgentOnStage : goMetrics}
          title={t(agentOnStage ? "Back to the agent — the default page" : "Back to the metrics — the default page")}
          className={buttonClass(mode === "metrics", true)}
        >
          {agentOnStage ? t("Agent").toUpperCase() : t("METRICS")}
        </button>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {/* agent perspective */}
        {itemButton("terminal", "TERMINAL")}
        <button
          type="button"
          disabled={!agentFile}
          onClick={showAgentFile}
          title={t("The content the agent has in context")}
          className={buttonClass(
            mode === "file" && activeId !== undefined && activeId === agentFile?.id,
            !!agentFile,
          )}
        >
          {t("FILE")}
        </button>
        <button type="button" onClick={() => setMode("live")} className={buttonClass(mode === "live", true)}>
          {t("LIVE")}
        </button>
      </div>
    </div>
  );
}
