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
  /** History run selected in the left rail; drives the Activity filter. */
  selectedRunId?: string;
  /** Whether the metrics dashboard covers the Stage (when not the default page). */
  metricsOpen: boolean;
  /** Event highlighted in the Activity panel after following a report link. */
  focusedEventId?: string;

  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  setFilesView: (view: FilesView) => void;
  selectRun: (id?: string) => void;
  openMetrics: () => void;
  closeMetrics: () => void;
  toggleMetrics: () => void;
  focusEvent: (id?: string) => void;
  reset: () => void;
}

export const useUiStore = create<UiStore>((set) => ({
  menu: undefined,
  filesView: { kind: "tree" },
  selectedRunId: undefined,
  metricsOpen: false,
  focusedEventId: undefined,

  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: undefined }),
  setFilesView: (filesView) => set({ filesView }),
  selectRun: (selectedRunId) => set({ selectedRunId, focusedEventId: undefined }),

  openMetrics: () => set({ metricsOpen: true }),
  closeMetrics: () => set({ metricsOpen: false }),
  toggleMetrics: () => set((s) => ({ metricsOpen: !s.metricsOpen })),

  focusEvent: (focusedEventId) => set({ focusedEventId }),

  reset: () =>
    set({
      menu: undefined,
      filesView: { kind: "tree" },
      selectedRunId: undefined,
      focusedEventId: undefined,
      metricsOpen: false,
    }),
}));
