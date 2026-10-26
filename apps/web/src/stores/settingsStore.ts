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

/**
 * How loudly failed commands should ring the report's human-attention bell:
 * the `command_failed` reason only fires once at least `commandFailThreshold`
 * commands have failed in one run, and then at `commandFailLevel`. `none`
 * keeps the reason off the report entirely.
 */
export type CommandFailLevel = "none" | "low" | "medium" | "high";

export interface Settings {
  /** UI language: English or Chinese (see lib/i18n.ts). */
  language: "en" | "zh";
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
  /** Minimum failed commands in one run before the report warns (default 5). */
  commandFailThreshold: number;
  /** The attention level a command-failure warning raises (default "low"). */
  commandFailLevel: CommandFailLevel;
  /** Minimum back-to-back failures in one run before the streak warning fires (default 3). */
  commandStreakThreshold: number;
  /** The attention level a failure-streak warning raises (default "medium"). */
  commandStreakLevel: CommandFailLevel;
  /** Seconds without any activity before the stall warning fires (default 3600). */
  activityStallThreshold: number;
  /** The attention level a stall warning raises (default "medium"). */
  activityStallLevel: CommandFailLevel;
}

const DEFAULTS: Settings = {
  language: "en",
  theme: "amber",
  railOrder: ["agent", "folder", "eggs"],
  leftOrder: ["files", "history", "activity"],
  displayInActivity: false,
  collapseChatOnContent: false,
  commandFailThreshold: 5,
  commandFailLevel: "low",
  commandStreakThreshold: 3,
  commandStreakLevel: "medium",
  activityStallThreshold: 3600,
  activityStallLevel: "medium",
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    return {
      language: parsed.language === "zh" ? "zh" : "en",
      theme: parsed.theme ?? DEFAULTS.theme,
      // Keep only known ids; append anything missing so each rail always renders all panels.
      railOrder: normalizeIds(parsed.railOrder, RAIL_PANEL_IDS) as RailPanelId[],
      leftOrder: normalizeIds(parsed.leftOrder, LEFT_PANEL_IDS) as LeftPanelId[],
      displayInActivity: parsed.displayInActivity ?? DEFAULTS.displayInActivity,
      collapseChatOnContent: parsed.collapseChatOnContent ?? DEFAULTS.collapseChatOnContent,
      commandFailThreshold: normalizeThreshold(parsed.commandFailThreshold, DEFAULTS.commandFailThreshold),
      commandFailLevel: normalizeLevel(parsed.commandFailLevel),
      commandStreakThreshold: normalizeThreshold(parsed.commandStreakThreshold, DEFAULTS.commandStreakThreshold),
      commandStreakLevel: normalizeLevel(parsed.commandStreakLevel),
      activityStallThreshold: normalizeThreshold(parsed.activityStallThreshold, DEFAULTS.activityStallThreshold),
      activityStallLevel: normalizeLevel(parsed.activityStallLevel),
    };
  } catch {
    return DEFAULTS;
  }
}

/**
 * A positive integer threshold, or `fallback` when the value is unusable.
 *
 * The fallback is per field on purpose: sharing one default made clearing the
 * stall field restore 5 *seconds* (the failed-command default) instead of
 * 3600, and clearing the streak field restore 5 instead of 3.
 */
function normalizeThreshold(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const FAIL_LEVELS: CommandFailLevel[] = ["none", "low", "medium", "high"];

function normalizeLevel(value: unknown): CommandFailLevel {
  return FAIL_LEVELS.includes(value as CommandFailLevel) ? (value as CommandFailLevel) : DEFAULTS.commandFailLevel;
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
  setLanguage: (language: Settings["language"]) => void;
  setTheme: (theme: Settings["theme"]) => void;
  setRailOrder: (order: RailPanelId[]) => void;
  moveRailPanel: (id: RailPanelId, dir: "up" | "down") => void;
  setLeftOrder: (order: LeftPanelId[]) => void;
  moveLeftPanel: (id: LeftPanelId, dir: "up" | "down") => void;
  setDisplayInActivity: (value: boolean) => void;
  setCollapseChatOnContent: (value: boolean) => void;
  setCommandFailThreshold: (value: number) => void;
  setCommandFailLevel: (value: CommandFailLevel) => void;
  setCommandStreakThreshold: (value: number) => void;
  setCommandStreakLevel: (value: CommandFailLevel) => void;
  setActivityStallThreshold: (value: number) => void;
  setActivityStallLevel: (value: CommandFailLevel) => void;
  reset: () => void;
}

export const useSettingsStore = create<SettingsStore>((set) => ({
  ...load(),

  setLanguage: (language) => set((s) => persistIt(s, { language })),
  setTheme: (theme) => set((s) => persistIt(s, { theme })),
  setRailOrder: (railOrder) =>
    set((s) => persistIt(s, { railOrder: normalizeIds(railOrder, RAIL_PANEL_IDS) as RailPanelId[] })),
  moveRailPanel: (id, dir) => set((s) => persistIt(s, { railOrder: movePanel(s.railOrder, id, dir) })),
  setLeftOrder: (leftOrder) =>
    set((s) => persistIt(s, { leftOrder: normalizeIds(leftOrder, LEFT_PANEL_IDS) as LeftPanelId[] })),
  moveLeftPanel: (id, dir) => set((s) => persistIt(s, { leftOrder: movePanel(s.leftOrder, id, dir) })),
  setDisplayInActivity: (value) => set((s) => persistIt(s, { displayInActivity: value })),
  setCollapseChatOnContent: (value) => set((s) => persistIt(s, { collapseChatOnContent: value })),
  setCommandFailThreshold: (value) =>
    set((s) => persistIt(s, { commandFailThreshold: normalizeThreshold(value, DEFAULTS.commandFailThreshold) })),
  setCommandFailLevel: (value) => set((s) => persistIt(s, { commandFailLevel: normalizeLevel(value) })),
  setCommandStreakThreshold: (value) =>
    set((s) => persistIt(s, { commandStreakThreshold: normalizeThreshold(value, DEFAULTS.commandStreakThreshold) })),
  setCommandStreakLevel: (value) => set((s) => persistIt(s, { commandStreakLevel: normalizeLevel(value) })),
  setActivityStallThreshold: (value) =>
    set((s) => persistIt(s, { activityStallThreshold: normalizeThreshold(value, DEFAULTS.activityStallThreshold) })),
  setActivityStallLevel: (value) => set((s) => persistIt(s, { activityStallLevel: normalizeLevel(value) })),
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
    language: next.language,
    theme: next.theme,
    railOrder: next.railOrder,
    leftOrder: next.leftOrder,
    displayInActivity: next.displayInActivity,
    collapseChatOnContent: next.collapseChatOnContent,
    commandFailThreshold: next.commandFailThreshold,
    commandFailLevel: next.commandFailLevel,
    commandStreakThreshold: next.commandStreakThreshold,
    commandStreakLevel: next.commandStreakLevel,
    activityStallThreshold: next.activityStallThreshold,
    activityStallLevel: next.activityStallLevel,
  });
  return patch;
}

export type { AgentStatus };
