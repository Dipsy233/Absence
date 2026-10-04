import { create } from "zustand";

/** Small UI-only state that isn't part of the observed session. */
interface UiStore {
  selectedPath?: string;
  selectFile: (path?: string) => void;
}

export const useUiStore = create<UiStore>((set) => ({
  selectedPath: undefined,
  selectFile: (path) => set({ selectedPath: path }),
}));
