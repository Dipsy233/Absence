import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSounds } from "../hooks/useSounds";
import { useSessionStore } from "../stores/sessionStore";
import { useViewModeStore } from "../stores/viewModeStore";
import { ContextMenu } from "../components/common/ContextMenu";
import { LeftRail } from "../components/layout/LeftRail";
import { RightRail } from "../components/layout/RightRail";
import { SessionBar } from "../components/layout/SessionBar";
import { Stage } from "../components/layout/Stage";
import { ProjectPicker } from "../components/ProjectPicker/ProjectPicker";
import { MonitorUI } from "../ui/monitor/MonitorUI";

/**
 * The shell. Three things decide what it renders:
 *
 *   no session      → the project picker
 *   a face is ready → that face (Monitor today; Rounds / Chart / Drip next)
 *   otherwise       → Classic, the pre-split layout
 *
 * The socket and the chimes are wired here and not per face, so switching the
 * interface never drops the connection or re-rings a run's chimes.
 */
export default function App() {
  const session = useSessionStore((s) => s.session);
  const mode = useViewModeStore((s) => s.mode);
  useSessionSocket(session?.id);
  useSounds();
  // Inside the desktop shell the session bar is the frameless window's title
  // bar, so it must sit flush with the top edge.
  const desktop = Boolean(window.absenceDesktop);

  if (!session) {
    return (
      <>
        <ProjectPicker />
        <ContextMenu />
      </>
    );
  }

  if (mode === "monitor") {
    return (
      <>
        <MonitorUI />
        <ContextMenu />
      </>
    );
  }

  return (
    <div className={["grid h-full grid-rows-[auto_minmax(0,1fr)] gap-2", desktop ? "px-2 pb-2 pt-0" : "p-2"].join(" ")}>
      <SessionBar />
      <div className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)_320px] gap-2">
        <LeftRail />
        <Stage />
        <RightRail />
      </div>
      <ContextMenu />
    </div>
  );
}
