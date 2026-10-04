import { create } from "zustand";

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Render a divider instead of a button. */
  separator?: boolean;
}

export type FilesView =
  | { kind: "tree" }
  | { kind: "detail"; path: string }
  | { kind: "history"; path: string; from?: number; to?: number };

interface UiStore {
  menu?: { x: number; y: number; items: MenuItem[] };
  filesView: FilesView;

  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  setFilesView: (view: FilesView) => void;
  reset: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  menu: undefined,
  filesView: { kind: "tree" },

  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: undefined }),
  setFilesView: (filesView) => set({ filesView }),
  reset: () => set({ menu: undefined, filesView: { kind: "tree" } }),
}));
