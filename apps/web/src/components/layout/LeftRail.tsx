import { ActivityPanel } from "../activity/ActivityPanel";
import { FilePanel } from "../files/FilePanel";
import { HistoryPanel } from "../history/HistoryPanel";

/** Left rail: Files, History, Activity (bottom shows the selected run's actions). */
export function LeftRail() {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <FilePanel />
      <HistoryPanel />
      <ActivityPanel />
    </div>
  );
}
