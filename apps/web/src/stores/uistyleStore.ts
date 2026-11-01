import { create } from "zustand";
import { readStoredUiStyle, storeUiStyle, type UiStyleId } from "../lib/uistyle";

/**
 * Which of the three complete styles the UI renders in (null = the neutral
 * baseline). A user preference, like the view mode: it survives reloads and
 * never touches the session.
 */
interface UiStyleStore {
  uiStyle: UiStyleId;
  setUiStyle: (style: UiStyleId) => void;
}

export const useUiStyleStore = create<UiStyleStore>((set) => ({
  uiStyle: readStoredUiStyle(),

  setUiStyle: (uiStyle) => {
    storeUiStyle(uiStyle);
    set({ uiStyle });
  },
}));
