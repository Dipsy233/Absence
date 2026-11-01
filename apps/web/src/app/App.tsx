import { useEffect } from "react";
import { useSessionSocket } from "../hooks/useSessionSocket";
import { useSounds } from "../hooks/useSounds";
import { useSessionStore } from "../stores/sessionStore";
import { useViewModeStore } from "../stores/viewModeStore";
import { ContextMenu } from "../components/common/ContextMenu";
import { ProjectPicker } from "../components/ProjectPicker/ProjectPicker";
import { MonitorUI } from "../ui/monitor/MonitorUI";
import { RoundsUI } from "../ui/rounds/RoundsUI";
import { ChartUI } from "../ui/chart/ChartUI";
import { DripPipHost } from "../ui/drip/DripPip";
import { DripDesktop } from "../ui/drip/DripDesktop";
import { FaceRise } from "../ui/shared/FaceRise";

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
 *   no session        → the project picker
 *   a ready face      → that face
 *   anything else     → Monitor, the default face
 *
 * The socket and the chimes are wired here and not per face, so switching the
 * interface never drops the connection or re-rings a run's chimes.
 */
export default function App() {
  const session = useSessionStore((s) => s.session);
  const mode = useViewModeStore((s) => s.mode);
  /** Drip is a switch over the current face, not a face of its own. */
  const drip = useViewModeStore((s) => s.drip);
  // Inside the desktop shell the face's top bar is the frameless window's
  // title bar, so its drag region must sit flush with the top edge.
  const desktop = Boolean(window.absenceDesktop);

  useSessionSocket(DRIP_WINDOW ? DRIP_SESSION : session?.id);
  // The floating window has its own session and its own chimes; muting the face
  // underneath keeps every event from ringing twice while Drip is up.
  useSounds(!(desktop && drip));

  // The desktop shell opens Drip as a second always-on-top window. The face
  // underneath stays open and live — turning the switch off closes only the
  // floating window.
  useEffect(() => {
    if (!desktop || DRIP_WINDOW) return;
    if (drip && session?.id) window.absenceDesktop?.openDrip(session.id);
    else window.absenceDesktop?.leaveDrip();
  }, [desktop, drip, session?.id]);

  // Closing the floating window (Open Absence, Alt+F4, or a load failure) turns
  // the toggle back off, so the bar never claims Drip is up when it is not.
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

  /** The browser build's Drip: a Document PiP window over the tab's face. */
  const pip = !desktop && drip ? <DripPipHost /> : null;

  if (mode === "monitor") {
    return (
      <>
        <FaceRise>
          <MonitorUI />
        </FaceRise>
        <ContextMenu />
        {pip}
      </>
    );
  }

  if (mode === "rounds") {
    return (
      <>
        <FaceRise>
          <RoundsUI />
        </FaceRise>
        <ContextMenu />
        {pip}
      </>
    );
  }

  if (mode === "chart") {
    return (
      <>
        <FaceRise>
          <ChartUI />
        </FaceRise>
        <ContextMenu />
        {pip}
      </>
    );
  }

  // Monitor is the default face — a fresh visit boots into it, and it is the
  // fallthrough for any mode that has no branch of its own (drip, which is a
  // toggle and never a stored mode).
  return (
    <>
      <FaceRise>
          <MonitorUI />
        </FaceRise>
      <ContextMenu />
      {pip}
    </>
  );
}
