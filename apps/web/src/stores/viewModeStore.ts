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
  reset: () => void;
}

export const useViewModeStore = create<ViewModeStore>((set) => ({
  mode: readStoredViewMode(),

  setMode: (mode) => {
    if (!viewModeSpec(mode).ready) return;
    storeViewMode(mode);
    set({ mode });
  },

  // A user preference: leaving a session (reset) must not change it.
  reset: () => {},
}));
