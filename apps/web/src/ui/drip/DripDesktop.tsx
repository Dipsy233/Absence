import { useCallback, useLayoutEffect, useRef } from "react";
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
 */

/** The ball plus its 8px margins. */
const BALL = { width: 100, height: 100 };

/** Hover: the ball plus room for "run #7 · …", the event and the counters. */
const HOVER = { width: 340, height: 100 };

export function DripDesktop() {
  const shell = window.absenceDesktop;
  const openRef = useRef(false);
  const hoverRef = useRef(false);

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

  return (
    <DripUI
      pip
      anchor="right"
      onHover={hover}
      onLayout={resize}
      onOpenAbsence={leave}
    />
  );
}
