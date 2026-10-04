import { create } from "zustand";
import type { StageItem, StageItemType, StageMode } from "../types/stage";

function modeForItem(item: StageItem): StageMode {
  switch (item.type) {
    case "file":
      return "file";
    case "diff":
      return "diff";
    case "terminal":
      return "terminal";
    default:
      return "desk";
  }
}

interface StageStore {
  mode: StageMode;
  /** True while the Stage follows the live agent action. */
  following: boolean;
  activeItem?: StageItem;
  /**
   * The most recent item of each kind. The mode buttons read from this, and it
   * is fed by both live actions and explicit opens — otherwise a mode button
   * would stay disabled until you happened to open something by hand.
   */
  lastByType: Partial<Record<StageItemType, StageItem>>;

  /** Record an item without changing what is on screen (live actions). */
  noteItem: (item: StageItem) => void;
  /** Pin an item and show it. */
  openStage: (item: StageItem) => void;
  showType: (type: StageItemType) => void;
  setMode: (mode: StageMode) => void;
  goLive: () => void;
  reset: () => void;
}

const EMPTY = {
  mode: "live" as StageMode,
  following: true,
  activeItem: undefined,
  lastByType: {} as Partial<Record<StageItemType, StageItem>>,
};

export const useStageStore = create<StageStore>((set, get) => ({
  mode: EMPTY.mode,
  following: EMPTY.following,
  activeItem: undefined,
  lastByType: {},

  noteItem: (item) => set({ lastByType: { ...get().lastByType, [item.type]: item } }),

  openStage: (item) =>
    set({
      lastByType: { ...get().lastByType, [item.type]: item },
      activeItem: item,
      mode: modeForItem(item),
      following: false,
    }),

  showType: (type) => {
    const item = get().lastByType[type];
    if (!item) return;
    set({ activeItem: item, mode: modeForItem(item), following: false });
  },

  setMode: (mode) => set(mode === "live" ? { mode, following: true } : { mode, following: false }),

  goLive: () => set({ mode: "live", following: true }),

  reset: () => set({ mode: EMPTY.mode, following: EMPTY.following, activeItem: undefined, lastByType: {} }),
}));
