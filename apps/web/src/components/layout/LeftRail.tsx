import { ActivityPanel } from "../activity/ActivityPanel";
import { FilePanel } from "../files/FilePanel";
import { ReplayPanel } from "../replay/ReplayPanel";

/** Left rail: Files, Activity, Replay (read02 §4.1). */
export function LeftRail() {
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <FilePanel />
      <ActivityPanel />
      <ReplayPanel />
    </div>
  );
}
