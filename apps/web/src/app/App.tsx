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
import { InkBoil } from "../ui/shared/InkBoil";
import { defaultScheme, UI_STYLES } from "../lib/uistyle";
import { applyMonacoTheme, DESK_PALETTE } from "../lib/monaco";
import { useUiStyleStore } from "../stores/uistyleStore";

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

  // The UI style is a class on <html>: themes.css remaps the face tokens
  // under it, every face and the drip window read the same palette.
  const uiStyle = useUiStyleStore((s) => s.uiStyle);
  const schemeOverride = useUiStyleStore((s) => s.schemeOverride);
  useEffect(() => {
    const el = document.documentElement;
    el.classList.remove(...UI_STYLES.map((id) => `theme-${id}`));
    el.classList.remove("scheme-light", "scheme-dark");
    el.classList.add(`theme-${uiStyle}`);
    // The scheme flips the style's own token set; an override wins over the
    // scheme the style was designed around.
    const scheme = schemeOverride ?? defaultScheme(uiStyle);
    el.classList.add(`scheme-${scheme}`);
  }, [uiStyle, schemeOverride]);

  // The text paper (Monaco's editor surface) cannot read CSS variables, so
  // the four --mon-paper-* values are read off the mounted face and fed to
  // the editor's theme here — on every style, scheme and face change. The
  // syntax colours follow the scheme's base theme (vs vs vs-dark); only the
  // paper is ours. `session` and `mode` are dependencies because the face
  // (and with it a .mon-root to read the tokens from) may not exist yet when
  // the style changes over the project picker.
  useEffect(() => {
    const scheme = schemeOverride ?? defaultScheme(uiStyle);
    const host = document.querySelector(".mon-root") ?? document.body;
    const cs = getComputedStyle(host);
    const read = (name: string, fallback: string) => (cs.getPropertyValue(name) || fallback).trim();
    applyMonacoTheme(
      {
        bg: read("--mon-paper", DESK_PALETTE.panel),
        panel: read("--mon-paper", DESK_PALETTE.panel),
        panel2: read("--mon-paper-2", DESK_PALETTE.panel2),
        line: read("--mon-paper-2", DESK_PALETTE.line),
        ink: read("--mon-paper-t", DESK_PALETTE.ink),
        dim: read("--mon-paper-dim", DESK_PALETTE.dim),
        accent: read("--mon-acc", DESK_PALETTE.accent),
        woodLit: read("--mon-paper-dim", DESK_PALETTE.woodLit),
      },
      scheme === "dark",
    );
  }, [uiStyle, schemeOverride, session, mode]);

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
  /** The ink theme's line-boil filter source — one hidden SVG for the app. */
  const boil = <InkBoil />;

  if (mode === "monitor") {
    return (
      <>
        <FaceRise>
          <MonitorUI />
        </FaceRise>
        <ContextMenu />
        {boil}
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
        {boil}
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
        {boil}
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
      {boil}
      {pip}
    </>
  );
}
