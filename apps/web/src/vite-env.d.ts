/// <reference types="vite/client" />

/**
 * How the desktop Drip window grows from its ball: the shell picks the
 * direction nearest the middle of the screen, and the face lays the pill out
 * to match so the ball never jumps when the window resizes.
 */
interface DripGrow {
  horizontal: "left" | "right";
  vertical: "down" | "up";
}

/**
 * Where the ball is and how much room its screen offers. The face re-derives
 * `DripGrow` from this so the pill can be laid out in the same tick as a resize.
 */
interface DripGeometry {
  /** The ball's top-left, in the same screen coordinates `setBounds` uses. */
  ball: { x: number; y: number };
  /** The work area of the display the ball sits on. */
  area: { x: number; y: number; width: number; height: number };
  /** The ball's diameter, as the shell draws it. */
  ballSize: number;
  /** The transparent margin the face leaves around the ball. */
  inset: number;
}

/**
 * Bridge exposed by the desktop shell's preload (apps/desktop/preload.cjs).
 * Undefined in a plain browser tab — WindowControls keys off its presence.
 */
interface Window {
  absenceDesktop?: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
    /** Desktop Drip: open its floating window for this session and hide this one. */
    openDrip: (sessionId: string) => void;
    /** Close the floating window and restore the main one (Open Absence). */
    leaveDrip: () => void;
    /** Resize the floating window; `{ width: 100, height: 100 }` is the ball. */
    resizeDrip: (size: { width: number; height: number }) => void;
    /**
     * Drag the floating window. The face only says when the gesture starts,
     * moves and ends; the shell reads the cursor itself and moves the ball.
     */
    startDripDrag: () => void;
    dragDrip: () => void;
    endDripDrag: () => void;
    /** Which way the window grows from the ball; the face lays the pill out to match. */
    dripGrow: () => Promise<DripGrow | null>;
    onDripGrow: (callback: (grow: DripGrow) => void) => () => void;
    /** The ball's screen position; `null` while no floating window exists. */
    dripGeometry: () => Promise<DripGeometry | null>;
    /** The floating window closed; the main window is visible again. */
    onDripClosed: (callback: () => void) => () => void;
  };
}
