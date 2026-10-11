import { create } from "zustand";
import type { AgentStatus } from "@absence/core";

/* ══════════════════════════════════════════════════════════════════════════
   User settings — the configurable bits surfaced in the Settings dialog:
     • color theme
     • right-rail panel order (who sits at the top)
     • egg filter deny-list (names hidden from the Agent Eggs panel)
     • avatar skin (a skin JSON URL; see lib/avatarSkin.ts)

   Everything persists to localStorage under one key and is read back once at
   module load, so the store initialises already-configured.
   ══════════════════════════════════════════════════════════════════════════ */

const SETTINGS_KEY = "absence.settings";

/** The right rail's panels, in the order the user wants them stacked. */
export type RailPanelId = "agent" | "folder" | "eggs";

/** The left rail's panels, in the order the user wants them stacked. */
export type LeftPanelId = "files" | "history" | "activity";

const RAIL_PANEL_IDS: RailPanelId[] = ["agent", "folder", "eggs"];
const LEFT_PANEL_IDS: LeftPanelId[] = ["files", "history", "activity"];

export interface Settings {
  theme: "amber" | "blue" | "green";
  /** Right rail top → bottom. */
  railOrder: RailPanelId[];
  /** Left rail top → bottom. */
  leftOrder: LeftPanelId[];
  /**
   * Show the LAID/DIED process rows (Agent Eggs) in the Activity panel. Off
   * (the default) hides them so the panel reads as actions only; the eggs
   * themselves stay visible in the Agent Eggs panel either way.
   */
  displayInActivity: boolean;
  /**
   * Auto-collapse the chat history when the Stage shows a content page (file /
   * diff / terminal / report). Off (the default) keeps the chat exactly as the
   * user left it, so switching pages never hides the conversation.
   */
  collapseChatOnContent: boolean;
}

const DEFAULTS: Settings = {
  theme: "amber",
  railOrder: ["agent", "folder", "eggs"],
  leftOrder: ["files", "history", "activity"],
  displayInActivity: false,
  collapseChatOnContent: false,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      theme: parsed.theme ?? DEFAULTS.theme,
      // Keep only known ids; append anything missing so each rail always renders all panels.
      railOrder: normalizeIds(parsed.railOrder, RAIL_PANEL_IDS) as RailPanelId[],
      leftOrder: normalizeIds(parsed.leftOrder, LEFT_PANEL_IDS) as LeftPanelId[],
      displayInActivity: parsed.displayInActivity ?? DEFAULTS.displayInActivity,
      collapseChatOnContent: parsed.collapseChatOnContent ?? DEFAULTS.collapseChatOnContent,
    };
  } catch {
    return DEFAULTS;
  }
}

function normalizeIds(order: unknown, ids: string[]): string[] {
  const list = Array.isArray(order) ? order.filter((id): id is string => ids.includes(id)) : [];
  for (const id of ids) if (!list.includes(id)) list.push(id);
  return list;
}

function persist(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

interface SettingsStore extends Settings {
  setTheme: (theme: Settings["theme"]) => void;
  setRailOrder: (order: RailPanelId[]) => void;
  moveRailPanel: (id: RailPanelId, dir: "up" | "down") => void;
  setLeftOrder: (order: LeftPanelId[]) => void;
  moveLeftPanel: (id: LeftPanelId, dir: "up" | "down") => void;
  setDisplayInActivity: (value: boolean) => void;
  setCollapseChatOnContent: (value: boolean) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  ...load(),

  setTheme: (theme) => set((s) => persistIt(s, { theme })),
  setRailOrder: (railOrder) =>
    set((s) => persistIt(s, { railOrder: normalizeIds(railOrder, RAIL_PANEL_IDS) as RailPanelId[] })),
  moveRailPanel: (id, dir) => set((s) => ({ railOrder: movePanel(s.railOrder, id, dir) })),
  setLeftOrder: (leftOrder) =>
    set((s) => persistIt(s, { leftOrder: normalizeIds(leftOrder, LEFT_PANEL_IDS) as LeftPanelId[] })),
  moveLeftPanel: (id, dir) => set((s) => ({ leftOrder: movePanel(s.leftOrder, id, dir) })),
  setDisplayInActivity: (value) => set((s) => persistIt(s, { displayInActivity: value })),
  setCollapseChatOnContent: (value) => set((s) => persistIt(s, { collapseChatOnContent: value })),
  reset: () => set((s) => persistIt(s, DEFAULTS)),
}));

/** Swap `id` with its neighbour in `order`. */
function movePanel<T>(order: T[], id: T, dir: "up" | "down"): T[] {
  const next = [...order];
  const i = next.indexOf(id);
  const j = dir === "up" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= next.length) return order;
  [next[i], next[j]] = [next[j]!, next[i]!];
  return next;
}

/** Merge a patch, persist, and return the state for zustand's set. */
function persistIt(state: Settings, patch: Partial<Settings>): Partial<SettingsStore> {
  const next = { ...state, ...patch };
  persist({
    theme: next.theme,
    railOrder: next.railOrder,
    leftOrder: next.leftOrder,
    displayInActivity: next.displayInActivity,
    collapseChatOnContent: next.collapseChatOnContent,
  });
  return patch;
}

export type { AgentStatus };
