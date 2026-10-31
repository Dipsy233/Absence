/// <reference types="vite/client" />

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
    /** The floating window closed; the main window is visible again. */
    onDripClosed: (callback: () => void) => () => void;
  };
}
