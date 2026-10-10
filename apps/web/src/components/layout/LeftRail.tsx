import { ActivityPanel } from "../activity/ActivityPanel";
import { FilePanel } from "../files/FilePanel";
import { HistoryPanel } from "../history/HistoryPanel";
import { useSettingsStore, type LeftPanelId } from "../../stores/settingsStore";

const PANELS: Record<LeftPanelId, () => React.ReactElement> = {
  files: FilePanel,
  history: HistoryPanel,
  activity: ActivityPanel,
};

/** Left rail: Files, History, Activity — stacking order is user-configurable
 * in the Settings dialog. */
export function LeftRail() {
  const leftOrder = useSettingsStore((s) => s.leftOrder);
  return (
    <div className="flex min-h-0 flex-col gap-2">
      {leftOrder.map((id) => {
        const Panel = PANELS[id];
        return <Panel key={id} />;
      })}
    </div>
  );
}
