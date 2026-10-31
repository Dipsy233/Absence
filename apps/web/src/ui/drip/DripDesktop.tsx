import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DripUI } from "./DripUI";
import "./drip.css";

/**
 * The desktop build of Drip — the packaged app's floating ball.
 *
 * The shell gives this face its own frameless, transparent, always-on-top
 * window (loaded with `?face=drip`), and owns the geometry: it keeps a single
 * fixed ball on screen and derives the window from it every time this face
 * reports a new size. The face never learns the window's position, so nothing
 * here can drift — the shell also announces which way the panel grows
 * ("left"/"right", "down"/"up") and the pill is laid out to match.
 *
 * A PiP window cannot resize on hover (it needs a click's gesture); this one
 * can, so hovering widens it enough to show the strip before anything is
 * clicked.
 *
 * The ball is also the drag handle: a press asks the shell to grab the ball,
 * and every move afterwards tells it to re-place the ball under the cursor.
 * Coordinates never cross the bridge — the window slides under the pointer,
 * so the shell reads the cursor from the screen instead. A press that never
 * travels more than a few pixels still counts as a click and opens the card.
 */

/** The ball plus its 8px margins — the window at rest. */
const BALL = { width: 100, height: 100 };

/** Hover: the ball plus room for "run #7 · …", the event and the counters. */
const HOVER = { width: 340, height: 100 };

/** A press that travels farther than this is a drag, not a click. */
const DRAG_SLOP = 4;

/**
 * Hover-out waits this long before collapsing. The strip and the ball are one
 * surface but the pointer crosses their seam, and shrinking the window on the
 * first `mouseleave` makes that crossing flicker.
 */
const COLLAPSE_MS = 180;

export function DripDesktop() {
  const shell = window.absenceDesktop;
  const openRef = useRef(false);
  const hoverRef = useRef(false);
  /** The size currently applied, so the direction can be re-asked for later. */
  const sizeRef = useRef(BALL);
  /** The press in flight, if any. */
  const pressRef = useRef<{ x: number; y: number; dragging: boolean } | null>(null);
  /** Set on release so the click that follows a drag can be swallowed. */
  const swallowClickRef = useRef(false);
  /** The pending hover-out collapse, if any. */
  const collapseRef = useRef<number | null>(null);
  /** Which way the shell grows the window; the pill mirrors it. */
  const [grow, setGrow] = useState<DripGrow>({ horizontal: "left", vertical: "down" });

  // The shell's window is transparent, but index.css paints the page dark for
  // every face. Clear both backgrounds so only the ball and the card are seen.
  useLayoutEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.background;
    const prevBody = body.style.background;
    html.style.background = "transparent";
    body.style.background = "transparent";
    return () => {
      html.style.background = prevHtml;
      body.style.background = prevBody;
    };
  }, []);

  // The shell decides the direction (it may have done so before this face was
  // loaded), so ask once and follow every later change.
  useEffect(() => {
    if (!shell) return;
    let live = true;
    shell
      .dripGrow()
      .then((value) => {
        if (live && value) setGrow(value);
      })
      .catch(() => {
        // A shell that cannot answer keeps the neutral default.
      });
    const off = shell.onDripGrow((value) => setGrow(value));
    return () => {
      live = false;
      off();
    };
  }, [shell]);

  /**
   * Apply a window size: tell the shell, and tell the PiP styles how wide the
   * window is (they size the strip as `window - 100px`, see drip.css).
   */
  const apply = useCallback(
    (size: { width: number; height: number }) => {
      sizeRef.current = size;
      document.documentElement.style.setProperty("--drip-pip-w", `${size.width}px`);
      shell?.resizeDrip(size);
    },
    [shell],
  );

  /** Measured by the face: `null` closed, the card's box when open. */
  const resize = useCallback(
    (size: { width: number; height: number } | null) => {
      openRef.current = size !== null;
      // Closing under the pointer returns to the hover strip, not the bare
      // ball; the pointer is still there, so the text should still show.
      apply(size ?? (hoverRef.current ? HOVER : BALL));
    },
    [apply],
  );

  const clearCollapse = useCallback(() => {
    if (collapseRef.current === null) return;
    window.clearTimeout(collapseRef.current);
    collapseRef.current = null;
  }, []);

  useEffect(() => clearCollapse, [clearCollapse]);

  const hover = useCallback(
    (on: boolean) => {
      if (on) {
        clearCollapse();
        hoverRef.current = true;
        // Once the card is open it owns the size until it closes.
        if (!openRef.current) apply(HOVER);
        return;
      }
      hoverRef.current = false;
      if (openRef.current) return;
      clearCollapse();
      collapseRef.current = window.setTimeout(() => {
        collapseRef.current = null;
        if (hoverRef.current || openRef.current) return;
        apply(BALL);
      }, COLLAPSE_MS);
    },
    [apply, clearCollapse],
  );

  /** Open Absence: the shell closes this window and brings the main one back. */
  const leave = useCallback(() => shell?.leaveDrip(), [shell]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shell || event.button !== 0) return;
      const target = event.target as Element | null;
      // Only the ball moves the window; the card and its composer stay put.
      if (!target?.closest(".drip-pill")) return;

      // A new press invalidates the previous gesture's swallow flag.
      swallowClickRef.current = false;
      pressRef.current = { x: event.clientX, y: event.clientY, dragging: false };
      // Capture on the wrapper so the moves keep arriving while the window
      // slides under the pointer.
      event.currentTarget.setPointerCapture(event.pointerId);
      shell.startDripDrag();
    },
    [shell],
  );

  const onPointerMoveCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press) return;
      if (!press.dragging) {
        // The window has not moved yet, so these coordinates are still the
        // pointer's honest travel. Past the threshold the ball follows and the
        // renderer's coordinates stop meaning anything — which is why the
        // shell reads the cursor itself from here on.
        if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < DRAG_SLOP) return;
        press.dragging = true;
      }
      shell?.dragDrip();
    },
    [shell],
  );

  const finishPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press) return;
      swallowClickRef.current = press.dragging;
      pressRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      shell?.endDripDrag();
    },
    [shell],
  );

  const onClickCapture = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!swallowClickRef.current) return;
    // The click belongs to a drag: do not open the card with it.
    swallowClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  /**
   * Capture lost mid-press (the window was moved out from under Chromium's
   * capture, or focus went elsewhere): stop following the cursor, otherwise the
   * floating window would trail it forever.
   */
  const onLostPointerCapture = useCallback(() => {
    if (!pressRef.current) return;
    pressRef.current = null;
    swallowClickRef.current = true;
    shell?.endDripDrag();
  }, [shell]);

  // Losing focus ends the gesture too — a drag has no business continuing
  // after the shell has handed the window to another app.
  useEffect(() => {
    const onBlur = () => {
      if (!pressRef.current) return;
      pressRef.current = null;
      swallowClickRef.current = true;
      shell?.endDripDrag();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [shell]);

  return (
    <div
      className="drip-desktop"
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={finishPress}
      onPointerCancelCapture={finishPress}
      onLostPointerCapture={onLostPointerCapture}
      onClickCapture={onClickCapture}
    >
      <DripUI
        pip
        anchor={grow.horizontal === "left" ? "right" : "left"}
        vertical={grow.vertical}
        onHover={hover}
        onLayout={resize}
        onOpenAbsence={leave}
      />
    </div>
  );
}
