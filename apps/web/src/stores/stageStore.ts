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
    case "search":
      return "search";
    case "plan":
      return "desk";
    default:
      return "desk";
  }
}

interface StageStore {
  mode: StageMode;
  /** True while the Stage follows the live agent action. */
  following: boolean;
  activeItem?: StageItem;
  /** Navigation stack (read02 §40) so opening detail never loses your place. */
  navStack: StageItem[];
  navIndex: number;

  openStage: (item: StageItem) => void;
  replaceStage: (item: StageItem) => void;
  closeStage: () => void;
  setMode: (mode: StageMode) => void;
  /** Show the most recent item of a kind without pushing onto the stack. */
  showType: (type: StageItemType) => void;
  hasItemOfType: (type: StageItemType) => boolean;
  goLive: () => void;
  goBack: () => void;
  goForward: () => void;
  reset: () => void;
}

const EMPTY = {
  mode: "live" as StageMode,
  following: true,
  activeItem: undefined,
  navStack: [] as StageItem[],
  navIndex: -1,
};

export const useStageStore = create<StageStore>((set, get) => ({
  ...EMPTY,

  openStage: (item) => {
    const { navStack, navIndex } = get();
    const stack = [...navStack.slice(0, navIndex + 1), item];
    set({
      navStack: stack,
      navIndex: stack.length - 1,
      activeItem: item,
      mode: modeForItem(item),
      following: false,
    });
  },

  /** Swap the current entry without growing the stack (e.g. picking another version). */
  replaceStage: (item) => {
    const { navStack, navIndex } = get();
    const stack = [...navStack];
    if (navIndex >= 0) stack[navIndex] = item;
    else stack.push(item);
    set({
      navStack: stack,
      navIndex: stack.length - 1,
      activeItem: item,
      mode: modeForItem(item),
      following: false,
    });
  },

  closeStage: () => set({ following: true, mode: "live" }),

  setMode: (mode) => {
    if (mode === "live") set({ mode, following: true });
    else set({ mode, following: false });
  },

  showType: (type) => {
    const { navStack, navIndex } = get();
    for (let i = navIndex; i >= 0; i--) {
      const item = navStack[i]!;
      if (item.type === type) {
        set({ activeItem: item, mode: modeForItem(item), following: false });
        return;
      }
    }
  },

  hasItemOfType: (type) => {
    const { navStack, navIndex } = get();
    for (let i = navIndex; i >= 0; i--) {
      if (navStack[i]!.type === type) return true;
    }
    return false;
  },

  goLive: () => set({ mode: "live", following: true }),

  goBack: () => {
    const { navStack, navIndex } = get();
    if (navIndex <= 0) return;
    const next = navIndex - 1;
    const item = navStack[next]!;
    set({ navIndex: next, activeItem: item, mode: modeForItem(item), following: false });
  },

  goForward: () => {
    const { navStack, navIndex } = get();
    if (navIndex >= navStack.length - 1) return;
    const next = navIndex + 1;
    const item = navStack[next]!;
    set({ navIndex: next, activeItem: item, mode: modeForItem(item), following: false });
  },

  reset: () => set({ ...EMPTY, navStack: [] }),
}));
