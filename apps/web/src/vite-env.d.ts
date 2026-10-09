/// <reference types="vite/client" />

/**
 * Bridge exposed by the desktop shell's preload (apps/desktop/preload.cjs).
 * Undefined in a plain browser tab — WindowControls keys off its presence.
 */
interface Window {
  dazeDesktop?: {
    minimize: () => void;
    toggleMaximize: () => void;
    close: () => void;
    isMaximized: () => Promise<boolean>;
    onMaximizedChanged: (callback: (maximized: boolean) => void) => () => void;
  };
}
