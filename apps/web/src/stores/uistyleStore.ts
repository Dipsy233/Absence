import { create } from "zustand";
import {
  readStoredScheme,
  readStoredUiStyle,
  storeScheme,
  storeUiStyle,
  type ColorScheme,
  type UiStyleId,
} from "../lib/uistyle";

/* Which of the three complete looks the UI renders in, and which of its two
   color schemes. Both survive reloads and never touch the session; the
   scheme stores an override — null follows the style's own default. */
interface UiStyleStore {
  uiStyle: UiStyleId;
  schemeOverride: ColorScheme | null;
  setUiStyle: (style: UiStyleId) => void;
  setScheme: (scheme: ColorScheme | null) => void;
}

export const useUiStyleStore = create<UiStyleStore>((set) => ({
  uiStyle: readStoredUiStyle(),
  schemeOverride: readStoredScheme(),

  setUiStyle: (uiStyle) => {
    storeUiStyle(uiStyle);
    set({ uiStyle });
  },

  setScheme: (schemeOverride) => {
    storeScheme(schemeOverride);
    set({ schemeOverride });
  },
}));
