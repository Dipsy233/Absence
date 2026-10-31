/// <reference types="vite/client" />

/**
 * Drip's floating window is a fixed, transparent sheet the size of the work
 * area, so the ball is a position inside it rather than a window geometry.
 */
interface DripFrame {
  /** The ball's top-left inside the sheet, in CSS px. */
  bx: number;
  by: number;
  /** The sheet's size — the display's work area. */
  width: number;
  height: number;
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
    /**
     * Turn click-through off (`false`) while the pointer is over the ball or
     * the open panel, and back on (`true`) anywhere else.
     */
    setDripIgnore: (ignore: boolean) => void;
    /**
     * Drag the ball. The face only says when the gesture starts, moves and
     * ends; the shell reads the cursor itself and moves the ball.
     */
    startDripDrag: () => void;
    dragDrip: () => void;
    endDripDrag: () => void;
    /** Where the ball sits inside the sheet; `null` while no window exists. */
    dripBall: () => Promise<DripFrame | null>;
    onDripBall: (callback: (frame: DripFrame) => void) => () => void;
    /** The floating window closed; the main window is visible again. */
    onDripClosed: (callback: () => void) => () => void;
  };
}
