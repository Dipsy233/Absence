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
 * window (loaded with `?face=drip`) and owns the geometry: it keeps one fixed
 * ball on screen and derives the window from it every time this face reports a
 * size, so nothing here can drift.
 *
 * The shell also decides which way the panel grows from the ball ("left"/"right",
 * "down"/"up"). This face predicts that decision from the geometry the shell
 * hands it (same ball, same rule) and lays the pill out *before* it asks for the
 * resize — a direction that arrived afterwards would leave the ball at the
 * wrong end of the window for a frame, which reads as a flicker on every
 * expand and collapse.
 *
 * The ball is also the drag handle: a press asks the shell to grab it, and every
 * move afterwards tells the shell to re-place it under the cursor. Coordinates
 * never cross the bridge — the window slides under the pointer, so the shell
 * reads the cursor from the screen instead. A press that never travels more than
 * a few pixels still counts as a click that opens the card, so the pointer
 * capture is taken on the pill itself: the click then lands on the pill's own
 * handler instead of the wrapper, which would swallow it.
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
 * first `mouseleave` makes that crossing flicker. It also gives the strip its
 * 180ms retract (see drip.css) time to finish before the window closes in on
 * the ball, so the outgoing text is never cut off by the window's edge.
 */
const COLLAPSE_MS = 200;

/**
 * The shell's rule, restated (see `dripGrowFor` in apps/desktop/main.cjs): the
 * panel unfolds away from the nearer work-area edge and downwards, unless the
 * ball is too close to the bottom for the requested height. Both sides must
 * agree, or the ball would be placed for one direction and drawn for another.
 */
function growFor(
  geometry: DripGeometry | null,
  size: { width: number; height: number },
  fallback: DripGrow,
): DripGrow {
  if (!geometry) return fallback;
  const { ball, area, ballSize, inset } = geometry;
  const horizontal = ball.x + ballSize / 2 > area.x + area.width / 2 ? "left" : "right";
  const roomBelow = area.y + area.height - (ball.y + ballSize);
  const needed = size.height - ballSize - inset;
  const vertical = size.height <= ballSize + inset * 2 || roomBelow >= needed ? "down" : "up";
  return { horizontal, vertical };
}

export function DripDesktop() {
  const shell = window.absenceDesktop;
  const openRef = useRef(false);
  const hoverRef = useRef(false);
  /** The size currently applied, so the layout can be re-derived later. */
  const sizeRef = useRef(BALL);
  /** Where the ball and its work area were when the size was last applied. */
  const geometryRef = useRef<DripGeometry | null>(null);
  /** The direction last applied; only rendered state changes when it flips. */
  const growRef = useRef<DripGrow>({ horizontal: "left", vertical: "down" });
  /** The press in flight, if any. */
  const pressRef = useRef<{ x: number; y: number; dragging: boolean; pill: HTMLElement } | null>(null);
  /** Set on release so the click that follows a drag can be swallowed. */
  const swallowClickRef = useRef(false);
  /** The pending hover-out collapse, if any. */
  const collapseRef = useRef<number | null>(null);
  /** The pending frame that stretches the strip, if any. */
  const frameRef = useRef<number | null>(null);
  /** Whether the strip is stretched (hovered or open); drives the CSS transition. */
  const [expanded, setExpanded] = useState(false);
  const [grow, setGrow] = useState<DripGrow>(growRef.current);

  // The shell's window is transparent, and index.css paints the page dark for
  // every face. The class keeps html, body and #root clear (see drip.css) —
  // an opaque page would show as a rectangle behind the ball.
  useLayoutEffect(() => {
    const html = document.documentElement;
    html.classList.add("drip-transparent");
    return () => html.classList.remove("drip-transparent");
  }, []);

  const setGrowIfChanged = useCallback((value: DripGrow) => {
    const prev = growRef.current;
    if (prev.horizontal === value.horizontal && prev.vertical === value.vertical) return;
    growRef.current = value;
    setGrow(value);
  }, []);

  /**
   * Apply a window size: pick the direction first, then tell the shell and the
   * PiP styles (which size the strip as `window - 100px`, see drip.css).
   */
  const apply = useCallback(
    (size: { width: number; height: number }) => {
      sizeRef.current = size;
      setGrowIfChanged(growFor(geometryRef.current, size, growRef.current));
      document.documentElement.style.setProperty("--drip-pip-w", `${size.width}px`);
      shell?.resizeDrip(size);
    },
    [shell, setGrowIfChanged],
  );

  /** Re-read the ball's screen position, then re-place for the current size. */
  const refreshGeometry = useCallback(() => {
    if (!shell) return;
    shell
      .dripGeometry()
      .then((value) => {
        if (!value) return;
        geometryRef.current = value;
        // Same size, possibly a different side: the shell places the window
        // from the geometry too, so both end up agreeing.
        apply(sizeRef.current);
      })
      .catch(() => {
        // A shell that cannot answer keeps the last geometry it reported.
      });
  }, [shell, apply]);

  useEffect(() => {
    if (!shell) return;
    refreshGeometry();
    const off = shell.onDripGrow((value) => setGrowIfChanged(value));
    return off;
  }, [shell, refreshGeometry, setGrowIfChanged]);

  /** Measured by the face: `null` closed, the card's box when open. */
  const resize = useCallback(
    (size: { width: number; height: number } | null) => {
      openRef.current = size !== null;
      // Closing under the pointer returns to the hover strip, not the bare
      // ball; the pointer is still there, so the text should still show.
      apply(size ?? (hoverRef.current ? HOVER : BALL));
      setExpanded(size !== null || hoverRef.current);
    },
    [apply],
  );

  const clearCollapse = useCallback(() => {
    if (collapseRef.current === null) return;
    window.clearTimeout(collapseRef.current);
    collapseRef.current = null;
  }, []);

  /** Drop the pending stretch, if the pointer left before it landed. */
  const clearStretch = useCallback(() => {
    if (frameRef.current === null) return;
    window.cancelAnimationFrame(frameRef.current);
    frameRef.current = null;
  }, []);

  /**
   * Stretch the strip on the next frame, not in this tick.
   *
   * The shell resizes the window over IPC, so the extra width only exists a
   * frame later. Stretching into the old, ball-sized window would clip the
   * text against its edge on the way out; waiting a frame means the strip
   * always slides into a window that has room for it.
   */
  const stretch = useCallback(() => {
    clearStretch();
    frameRef.current = window.requestAnimationFrame(() => {
      frameRef.current = null;
      setExpanded(true);
    });
  }, [clearStretch]);

  useEffect(
    () => () => {
      clearCollapse();
      clearStretch();
    },
    [clearCollapse, clearStretch],
  );

  const hover = useCallback(
    (on: boolean) => {
      // A press owns the size until it ends: pointer capture retargets the
      // boundary events, and a stray "leave" must not shrink the window out
      // from under a drag.
      if (pressRef.current) return;
      if (on) {
        clearCollapse();
        hoverRef.current = true;
        if (!openRef.current) {
          apply(HOVER);
          stretch();
        }
        return;
      }
      hoverRef.current = false;
      if (openRef.current) return;
      clearCollapse();
      clearStretch();
      // Retract the strip now, shrink the window once it is back inside the
      // ball — the other way round would cut the outgoing text in half.
      setExpanded(false);
      collapseRef.current = window.setTimeout(() => {
        collapseRef.current = null;
        if (hoverRef.current || openRef.current) return;
        apply(BALL);
      }, COLLAPSE_MS);
    },
    [apply, stretch, clearCollapse, clearStretch],
  );

  /** Open Absence: the shell closes this window and brings the main one back. */
  const leave = useCallback(() => shell?.leaveDrip(), [shell]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shell || event.button !== 0) return;
      const pill = (event.target as Element | null)?.closest(".drip-pill");
      if (!(pill instanceof HTMLElement)) return;

      // A new press invalidates the previous gesture's swallow flag.
      swallowClickRef.current = false;
      pressRef.current = { x: event.clientX, y: event.clientY, dragging: false, pill };
      // Capture on the pill, not on the wrapper: with capture the click that
      // follows a press is delivered to the capturing element, and only the
      // pill's own handler knows how to open the card.
      pill.setPointerCapture(event.pointerId);
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
      if (press.pill.hasPointerCapture(event.pointerId)) {
        press.pill.releasePointerCapture(event.pointerId);
      }
      shell?.endDripDrag();
      // The ball may have moved; the panel's side is decided from where it is.
      refreshGeometry();
    },
    [shell, refreshGeometry],
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
    refreshGeometry();
  }, [shell, refreshGeometry]);

  // Losing focus ends the gesture too — a drag has no business continuing
  // after the shell has handed the window to another app.
  useEffect(() => {
    const onBlur = () => {
      if (!pressRef.current) return;
      pressRef.current = null;
      swallowClickRef.current = true;
      shell?.endDripDrag();
      refreshGeometry();
    };
    window.addEventListener("blur", onBlur);
    return () => window.removeEventListener("blur", onBlur);
  }, [shell, refreshGeometry]);

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
        expanded={expanded}
        onHover={hover}
        onLayout={resize}
        onOpenAbsence={leave}
      />
    </div>
  );
}
