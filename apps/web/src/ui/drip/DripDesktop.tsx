import {
  useCallback,
  useLayoutEffect,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { DripUI } from "./DripUI";
import "./drip.css";

/**
 * The desktop build of Drip — the packaged app's floating ball.
 *
 * The shell gives this face its own frameless, transparent, always-on-top
 * window (loaded with `?face=drip`), so there is no Document
 * Picture-in-Picture here: the window is resized over IPC whenever the face
 * measures itself. The shell keeps the window's right edge fixed, so the ball
 * never moves on screen while the strip or the card unfolds to its left.
 *
 * A PiP window cannot resize on hover (it needs a click's gesture); this one
 * can, so hovering widens it enough to show the strip before anything is
 * clicked.
 *
 * The ball is also the drag handle: a press on the pill asks the shell to move
 * the window with the cursor. Pointer capture keeps the moves coming while the
 * window slides underneath the pointer, and a press that never travels more
 * than a few pixels still counts as a click and opens the card.
 */

/** The ball plus its 8px margins. */
const BALL = { width: 100, height: 100 };

/** Hover: the ball plus room for "run #7 · …", the event and the counters. */
const HOVER = { width: 340, height: 100 };

/** A press that travels farther than this is a drag, not a click. */
const DRAG_SLOP = 3;

export function DripDesktop() {
  const shell = window.absenceDesktop;
  const openRef = useRef(false);
  const hoverRef = useRef(false);
  /** The press in flight, if any. */
  const pressRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  /** Set on release so the click that follows a drag can be swallowed. */
  const swallowClickRef = useRef(false);

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

  /**
   * Apply a window size: tell the shell, and tell the PiP styles how wide the
   * window is (they size the strip as `window - 100px`, see drip.css).
   */
  const apply = useCallback(
    (size: { width: number; height: number }) => {
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

  const hover = useCallback(
    (on: boolean) => {
      hoverRef.current = on;
      // Once the card is open it owns the size until it closes.
      if (openRef.current) return;
      apply(on ? HOVER : BALL);
    },
    [apply],
  );

  /** Open Absence: the shell closes this window and brings the main one back. */
  const leave = useCallback(() => shell?.leaveDrip(), [shell]);

  const onPointerDownCapture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!shell || event.button !== 0) return;
      const target = event.target as Element | null;
      // Only the pill moves the window; the card and its composer stay put.
      if (!target?.closest(".drip-pill")) return;

      // A new press invalidates the previous gesture's swallow flag.
      swallowClickRef.current = false;
      pressRef.current = { x: event.screenX, y: event.screenY, moved: false };
      // Capture on the wrapper so the moves keep arriving while the window
      // slides under the pointer.
      event.currentTarget.setPointerCapture(event.pointerId);
      shell.startDripDrag();
    },
    [shell],
  );

  const onPointerMoveCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const press = pressRef.current;
    if (!press || press.moved) return;
    if (Math.abs(event.screenX - press.x) > DRAG_SLOP || Math.abs(event.screenY - press.y) > DRAG_SLOP) {
      press.moved = true;
    }
  }, []);

  const endPress = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const press = pressRef.current;
      if (!press) return;
      swallowClickRef.current = press.moved;
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

  return (
    <div
      className="drip-desktop"
      onPointerDownCapture={onPointerDownCapture}
      onPointerMoveCapture={onPointerMoveCapture}
      onPointerUpCapture={endPress}
      onPointerCancelCapture={endPress}
      onLostPointerCapture={onLostPointerCapture}
      onClickCapture={onClickCapture}
    >
      <DripUI pip anchor="right" onHover={hover} onLayout={resize} onOpenAbsence={leave} />
    </div>
  );
}
