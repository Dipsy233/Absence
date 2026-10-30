import { create } from "zustand";
import { readStoredViewMode, storeViewMode, viewModeSpec, type ViewMode } from "../lib/viewMode";

/**
 * Which face of the UI is showing. A user preference, like the theme: it
 * survives reloads, and switching it never touches the session.
 *
 * A mode whose face is not built yet is refused here as well as disabled in the
 * switcher, so a stale localStorage value can never leave the app blank.
 */
interface ViewModeStore {
  mode: ViewMode;
  setMode: (mode: ViewMode) => void;
  /** Leave Drip and hand the tab back to the last face that was showing. */
  exitDrip: () => void;
  reset: () => void;
}

export const useViewModeStore = create<ViewModeStore>((set) => ({
  mode: readStoredViewMode(),

  setMode: (mode) => {
    if (!viewModeSpec(mode).ready) return;
    // Drip is not a page: it is a floating window opened on top of the last
    // face, and the browser closes that window with the tab that opened it.
    // Persisting `drip` would make every fresh visit to the port boot into a
    // tab that immediately hands itself over to a pop-up, so the stored mode
    // always stays on the last real face — which is also the mode `exitDrip`
    // restores.
    if (mode !== "drip") storeViewMode(mode);
    set({ mode });
  },

  exitDrip: () => set({ mode: readStoredViewMode() }),

  // A user preference: leaving a session (reset) must not change it.
  reset: () => {},
}));
