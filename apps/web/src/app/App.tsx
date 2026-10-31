import { useEffect } from "react";
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
import { RoundsUI } from "../ui/rounds/RoundsUI";
import { ChartUI } from "../ui/chart/ChartUI";
import { DripPipHost } from "../ui/drip/DripPip";
import { DripDesktop } from "../ui/drip/DripDesktop";

/**
 * The desktop shell opens Drip as a second window: it loads this same app with
 * `?face=drip&session=<id>`, and that window draws only the floating ball.
 * Both values are fixed for the life of a window, so they are read once.
 */
const DRIP_PARAMS = new URLSearchParams(window.location.search);
const DRIP_WINDOW = DRIP_PARAMS.get("face") === "drip";
const DRIP_SESSION = DRIP_PARAMS.get("session") ?? undefined;

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
  // Inside the desktop shell the session bar is the frameless window's title
  // bar, so it must sit flush with the top edge.
  const desktop = Boolean(window.absenceDesktop);
  /**
   * Desktop Drip's launcher window: the shell hides it as soon as the floating
   * window is up, so its socket is closed here. Otherwise the hidden window
   * would ring a second time and compete with the visible one for the session.
   */
  const dripLauncher = desktop && mode === "drip" && !DRIP_WINDOW;

  useSessionSocket(DRIP_WINDOW ? DRIP_SESSION : dripLauncher ? undefined : session?.id);
  useSounds();

  useEffect(() => {
    if (!dripLauncher || !session?.id) return;
    window.absenceDesktop?.openDrip(session.id);
  }, [dripLauncher, session?.id]);

  // Closing the floating window (Open Absence, Alt+F4, or a load failure)
  // brings the main window back; its face must leave Drip too.
  useEffect(() => {
    if (!desktop || DRIP_WINDOW) return;
    return window.absenceDesktop?.onDripClosed(() => useViewModeStore.getState().exitDrip());
  }, [desktop]);

  if (DRIP_WINDOW) {
    return <DripDesktop />;
  }

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

  if (mode === "rounds") {
    return (
      <>
        <RoundsUI />
        <ContextMenu />
      </>
    );
  }

  if (mode === "chart") {
    return (
      <>
        <ChartUI />
        <ContextMenu />
      </>
    );
  }

  if (mode === "drip") {
    // The desktop shell gives Drip its own always-on-top window and hides this
    // one (see the launcher effect above), so nothing is left to draw here.
    // A browser tab cannot stay on top of other tabs; the browser build moves
    // the face into a Document Picture-in-Picture window and empties the tab.
    if (desktop) return null;
    return (
      <>
        <DripPipHost />
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
