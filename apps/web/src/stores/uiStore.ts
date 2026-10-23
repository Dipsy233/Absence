import { create } from "zustand";

const CHAT_HISTORY_KEY = "absence.chatHistoryOpen";

/** Remembered across visits (and refreshes) so the chat docks the way you left it. */
function readChatHistoryOpen(): boolean {
  try {
    return localStorage.getItem(CHAT_HISTORY_KEY) !== "0";
  } catch {
    return true;
  }
}

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
  /** Whether the Stage chat's history unfolds on the default page. Remembered. */
  chatHistoryOpen: boolean;
  /**
   * Swapped view: the agent becomes the Stage's default background (behind the
   * metrics dashboard) and the compact metrics panel moves into the top-right
   * slot. Toggled by clicking that panel.
   */
  agentOnStage: boolean;
  /**
   * ABSENCE mode: the metrics dashboard floats *in front of* the Stage's
   * content page as a translucent ghost, instead of behind it.
   */
  absenceMode: boolean;
  /** Whether the Absence Report overlay covers the Stage. Transient view state. */
  reportOpen: boolean;
  /** Whether the metrics dashboard covers the Stage (when not the default page). */
  metricsOpen: boolean;
  /** Event highlighted in the Activity panel after following a report link. */
  focusedEventId?: string;

  openMenu: (x: number, y: number, items: MenuItem[]) => void;
  closeMenu: () => void;
  setFilesView: (view: FilesView) => void;
  selectRun: (id?: string) => void;
  setChatHistoryOpen: (open: boolean) => void;
  toggleAgentOnStage: () => void;
  toggleAbsenceMode: () => void;
  toggleReport: () => void;
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
  chatHistoryOpen: readChatHistoryOpen(),
  agentOnStage: true,
  absenceMode: false,
  reportOpen: false,
  metricsOpen: false,
  focusedEventId: undefined,

  openMenu: (x, y, items) => set({ menu: { x, y, items } }),
  closeMenu: () => set({ menu: undefined }),
  setFilesView: (filesView) => set({ filesView }),
  selectRun: (selectedRunId) => set({ selectedRunId }),

  setChatHistoryOpen: (chatHistoryOpen) => {
    try {
      localStorage.setItem(CHAT_HISTORY_KEY, chatHistoryOpen ? "1" : "0");
    } catch {
      // ignore storage failures (private mode, etc.)
    }
    set({ chatHistoryOpen });
  },

  toggleAgentOnStage: () => set((s) => ({ agentOnStage: !s.agentOnStage })),

  toggleAbsenceMode: () => set((s) => ({ absenceMode: !s.absenceMode })),

  toggleReport: () => set((s) => ({ reportOpen: !s.reportOpen })),

  openMetrics: () => set({ metricsOpen: true }),
  closeMetrics: () => set({ metricsOpen: false }),
  toggleMetrics: () => set((s) => ({ metricsOpen: !s.metricsOpen })),

  focusEvent: (focusedEventId) => set({ focusedEventId }),

  // Deliberately keeps chatHistoryOpen: it is a user preference, not session state.
  reset: () =>
    set({
      menu: undefined,
      filesView: { kind: "tree" },
      selectedRunId: undefined,
      focusedEventId: undefined,
      metricsOpen: false,
      agentOnStage: true,
    }),
}));
