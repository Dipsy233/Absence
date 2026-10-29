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
    case "thought":
      return "thought";
    case "process":
      return "process";
    case "approval":
      return "approval";
    default:
      return "metrics";
  }
}

interface StageStore {
  mode: StageMode;
  /** True while the Stage follows the live agent action. */
  following: boolean;
  activeItem?: StageItem;
  /** The most recent item of each kind; drives DIFF / TERMINAL availability. */
  lastByType: Partial<Record<StageItemType, StageItem>>;

  /**
   * The two FILE slots are deliberately independent:
   *   userFile  — the whole file the user opened from the project tree
   *   agentFile — the content the agent actually has in context
   */
  userFile?: StageItem;
  agentFile?: StageItem;

  /** Record an item without changing what is on screen (live agent actions). */
  noteItem: (item: StageItem) => void;
  /** Pin an item and show it. */
  openStage: (item: StageItem) => void;
  openUserFile: (item: StageItem) => void;
  openAgentFile: (item: StageItem) => void;
  showType: (type: StageItemType) => void;
  showUserFile: () => void;
  showAgentFile: () => void;
  setMode: (mode: StageMode) => void;
  goLive: () => void;
  /** Back to the default metrics page. */
  goMetrics: () => void;
  /** Show the conversation as the Stage's page. */
  goChat: () => void;
  /**
   * The page the reader last chose for the Stage when nothing is pinned
   * (METRICS or CHAT), or undefined for "just follow the work".
   *
   * Classic's Stage has the same idea: when a run ends, the Stage goes back to
   * whatever default page the reader had picked — the metrics desk, or the
   * agent — instead of dumping them on the last activity of a finished run.
   */
  restingPage?: "metrics" | "chat";
  /** Go back to the resting page, or to following if the reader never chose one. */
  goResting: () => void;
  reset: () => void;
}

export const useStageStore = create<StageStore>((set, get) => ({
  mode: "live",
  following: true,
  activeItem: undefined,
  lastByType: {},
  userFile: undefined,
  agentFile: undefined,

  noteItem: (item) =>
    set((state) => ({
      lastByType: { ...state.lastByType, [item.type]: item },
      ...(item.type === "file" ? { agentFile: item } : {}),
    })),

  openStage: (item) =>
    set((state) => {
      if (state.activeItem?.id === item.id && state.mode === modeForItem(item)) {
        return { mode: "live", following: true };
      }
      return {
        lastByType: { ...state.lastByType, [item.type]: item },
        ...(item.type === "file" ? { agentFile: item } : {}),
        activeItem: item,
        mode: modeForItem(item),
        following: false,
      };
    }),

  openUserFile: (item) =>
    set((state) =>
      state.mode === "file" &&
      state.activeItem === state.userFile &&
      state.userFile?.source?.path !== undefined &&
      state.userFile.source.path === item.source?.path
        ? { mode: "live", following: true, activeItem: undefined }
        : { userFile: item, activeItem: item, mode: "file", following: false },
    ),

  openAgentFile: (item) =>
    set((state) => {
      const current = state.agentFile?.payload;
      const next = item.payload;
      const sameFileView =
        current?.kind === "file" &&
        next.kind === "file" &&
        current.version === next.version &&
        current.content === next.content;
      return state.mode === "file" &&
        state.activeItem === state.agentFile &&
        state.agentFile?.source?.path !== undefined &&
        state.agentFile.source.path === item.source?.path &&
        sameFileView
        ? { mode: "live", following: true, activeItem: undefined }
        : {
            agentFile: item,
            lastByType: { ...state.lastByType, file: item },
            activeItem: item,
            mode: "file",
            following: false,
          };
    }),

  showType: (type) => {
    const item = get().lastByType[type];
    if (!item) return;
    if (get().activeItem?.id === item.id && get().mode === modeForItem(item)) {
      get().goLive();
      return;
    }
    set({ activeItem: item, mode: modeForItem(item), following: false });
  },

  showUserFile: () => {
    const item = get().userFile;
    if (!item) return;
    if (get().activeItem?.id === item.id && get().mode === "file") {
      get().goLive();
      return;
    }
    set({ activeItem: item, mode: "file", following: false });
  },

  showAgentFile: () => {
    const item = get().agentFile;
    if (!item) return;
    if (get().activeItem?.id === item.id && get().mode === "file") {
      get().goLive();
      return;
    }
    set({ activeItem: item, mode: "file", following: false });
  },

  setMode: (mode) =>
    set((state) =>
      mode !== "live" && state.mode === mode
        ? { mode: "live", following: true }
        : mode === "live"
          ? { mode, following: true }
          : { mode, following: false },
    ),

  goLive: () => set({ mode: "live", following: true, activeItem: undefined }),

  goMetrics: () => set({ mode: "metrics", following: false, activeItem: undefined, restingPage: "metrics" }),

  // Chat is a page, not a pin: it is not a view of one activity, so it is
  // entered the same way METRICS is — deliberately without an `activeItem`,
  // which is what the pin bar reads to describe "the moment everything shows".
  goChat: () => set({ mode: "chat", following: false, activeItem: undefined, restingPage: "chat" }),

  /**
   * Where the Stage goes when a run ends.
   *
   * A finished run has no "now" to follow, so following is not an option: the
   * Stage rests on the page the reader chose last (METRICS or CHAT), and a
   * reader who never chose one gets CHAT — the conversation is what a finished
   * run leaves behind, and it is the page that answers "what did it say".
   */
  goResting: () => {
    const page = get().restingPage ?? "chat";
    set({ mode: page, following: false, activeItem: undefined });
  },

  reset: () =>
    set({
      mode: "live",
      following: true,
      activeItem: undefined,
      lastByType: {},
      userFile: undefined,
      agentFile: undefined,
      restingPage: undefined,
    }),
}));
