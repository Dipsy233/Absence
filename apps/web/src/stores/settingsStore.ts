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
 * How loudly a report reason should ring the human-attention bell. `none`
 * keeps that reason off the report entirely (and, because the chime follows the
 * level, silent too).
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
  /**
   * Render the agent's replies as Markdown (headings, lists, code, tables). On
   * by default; off shows the raw text, which is what a reader wants when the
   * model writes something the parser cannot make sense of.
   */
  chatMarkdown: boolean;
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

  /* ── The reasons that used to be hard-coded ───────────────────────────── */

  /** `agent_stopped` — the run ended in error (default "high"). */
  agentStoppedLevel: CommandFailLevel;
  /** `unresolved_error` — a failure nothing recovered from (default "high"). */
  unresolvedErrorLevel: CommandFailLevel;
  /** `process_left_running` — an egg the agent laid is still alive (default "high"). */
  processLeftRunningLevel: CommandFailLevel;
  /** Only report a leftover egg that lived at least this long, in seconds (0 = any). */
  processLeftRunningMinSeconds: number;
  /** Names or command fragments (one per line) never reported as leftover eggs. */
  processLeftRunningIgnore: string[];
  /** `outside_change` — a watcher change outside the project root (default "low"). */
  outsideChangeLevel: CommandFailLevel;
  /** Path globs (one per line) whose outside changes are ignored. */
  outsideChangeIgnore: string[];
  /** How many times a path must revert before it is a `file_version_loop` (default 1). */
  fileVersionLoopThreshold: number;
  /** The attention level a file version loop raises (default "medium"). */
  fileVersionLoopLevel: CommandFailLevel;
  /** How many times one command must fail before it is a `command_retry_loop` (default 2). */
  commandRetryLoopThreshold: number;
  /** The attention level a command retry loop raises (default "medium"). */
  commandRetryLoopLevel: CommandFailLevel;

  /* ── Chimes ──────────────────────────────────────────────────────────── */

  /** Master switch for every chime (default on). */
  soundEnabled: boolean;
  /** Chime volume, 0–100 (default 80). */
  soundVolume: number;
  /**
   * Ring for a *low* attention change too (default off). Low is the level most
   * runs sit at for harmless reasons (a lockfile next door), so it is silent
   * until asked for.
   */
  soundLowAttention: boolean;
  /** Ring when a run finishes (default on). */
  soundComplete: boolean;
  /** Ring when the runtime blocks on an approval (default on). */
  soundApproval: boolean;
}

const DEFAULTS: Settings = {
  language: "en",
  theme: "amber",
  railOrder: ["agent", "folder", "eggs"],
  leftOrder: ["files", "history", "activity"],
  displayInActivity: false,
  collapseChatOnContent: false,
  chatMarkdown: true,
  commandFailThreshold: 5,
  commandFailLevel: "low",
  commandStreakThreshold: 3,
  commandStreakLevel: "medium",
  activityStallThreshold: 3600,
  activityStallLevel: "medium",
  agentStoppedLevel: "high",
  unresolvedErrorLevel: "high",
  processLeftRunningLevel: "high",
  processLeftRunningMinSeconds: 0,
  processLeftRunningIgnore: [],
  outsideChangeLevel: "low",
  outsideChangeIgnore: [],
  fileVersionLoopThreshold: 1,
  fileVersionLoopLevel: "medium",
  commandRetryLoopThreshold: 2,
  commandRetryLoopLevel: "medium",
  soundEnabled: true,
  soundVolume: 80,
  soundLowAttention: false,
  soundComplete: true,
  soundApproval: true,
};

/**
 * Normalise whatever a previous version wrote into a complete `Settings`.
 *
 * Exported and pure so the fallbacks can be pinned: every field has to survive
 * a missing, stale or junk value, and the per-field defaults matter — they are
 * what a cleared input box restores.
 */
export function normalizeSettings(parsed: Partial<Settings>): Settings {
  return {
    language: parsed.language === "zh" ? "zh" : "en",
    theme: parsed.theme ?? DEFAULTS.theme,
    // Keep only known ids; append anything missing so each rail always renders all panels.
    railOrder: normalizeIds(parsed.railOrder, RAIL_PANEL_IDS) as RailPanelId[],
    leftOrder: normalizeIds(parsed.leftOrder, LEFT_PANEL_IDS) as LeftPanelId[],
    displayInActivity: parsed.displayInActivity ?? DEFAULTS.displayInActivity,
    collapseChatOnContent: parsed.collapseChatOnContent ?? DEFAULTS.collapseChatOnContent,
    chatMarkdown: parsed.chatMarkdown ?? DEFAULTS.chatMarkdown,
    commandFailThreshold: normalizeThreshold(parsed.commandFailThreshold, DEFAULTS.commandFailThreshold),
    commandFailLevel: normalizeLevel(parsed.commandFailLevel, DEFAULTS.commandFailLevel),
    commandStreakThreshold: normalizeThreshold(parsed.commandStreakThreshold, DEFAULTS.commandStreakThreshold),
    commandStreakLevel: normalizeLevel(parsed.commandStreakLevel, DEFAULTS.commandStreakLevel),
    activityStallThreshold: normalizeThreshold(parsed.activityStallThreshold, DEFAULTS.activityStallThreshold),
    activityStallLevel: normalizeLevel(parsed.activityStallLevel, DEFAULTS.activityStallLevel),
    agentStoppedLevel: normalizeLevel(parsed.agentStoppedLevel, DEFAULTS.agentStoppedLevel),
    unresolvedErrorLevel: normalizeLevel(parsed.unresolvedErrorLevel, DEFAULTS.unresolvedErrorLevel),
    processLeftRunningLevel: normalizeLevel(parsed.processLeftRunningLevel, DEFAULTS.processLeftRunningLevel),
    processLeftRunningMinSeconds: normalizeCount(parsed.processLeftRunningMinSeconds, DEFAULTS.processLeftRunningMinSeconds),
    processLeftRunningIgnore: normalizeList(parsed.processLeftRunningIgnore),
    outsideChangeLevel: normalizeLevel(parsed.outsideChangeLevel, DEFAULTS.outsideChangeLevel),
    outsideChangeIgnore: normalizeList(parsed.outsideChangeIgnore),
    fileVersionLoopThreshold: normalizeThreshold(parsed.fileVersionLoopThreshold, DEFAULTS.fileVersionLoopThreshold),
    fileVersionLoopLevel: normalizeLevel(parsed.fileVersionLoopLevel, DEFAULTS.fileVersionLoopLevel),
    commandRetryLoopThreshold: normalizeThreshold(parsed.commandRetryLoopThreshold, DEFAULTS.commandRetryLoopThreshold),
    commandRetryLoopLevel: normalizeLevel(parsed.commandRetryLoopLevel, DEFAULTS.commandRetryLoopLevel),
    soundEnabled: parsed.soundEnabled ?? DEFAULTS.soundEnabled,
    soundVolume: normalizeVolume(parsed.soundVolume),
    soundLowAttention: parsed.soundLowAttention ?? DEFAULTS.soundLowAttention,
    soundComplete: parsed.soundComplete ?? DEFAULTS.soundComplete,
    soundApproval: parsed.soundApproval ?? DEFAULTS.soundApproval,
  };
}

function load(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULTS;
    return normalizeSettings(JSON.parse(raw) as Partial<Settings>);
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

/** Like `normalizeThreshold`, but zero is a legal value (0 = no minimum). */
function normalizeCount(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? Math.floor(value) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** A 0–100 volume, clamped; anything unusable falls back to the default. */
function normalizeVolume(value: unknown): number {
  const n = typeof value === "number" ? Math.round(value) : NaN;
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : DEFAULTS.soundVolume;
}

/** A string list, trimmed, with blanks and duplicates dropped. */
function normalizeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

const FAIL_LEVELS: CommandFailLevel[] = ["none", "low", "medium", "high"];

/**
 * A level, or `fallback` when the value is not one of them.
 *
 * The fallback is per field for the same reason the thresholds' is: a junk
 * `outsideChangeLevel` should restore low, not the failed-command default — and
 * the two differ, so sharing one silently changed what a corrupt entry meant.
 */
function normalizeLevel(value: unknown, fallback: CommandFailLevel): CommandFailLevel {
  return FAIL_LEVELS.includes(value as CommandFailLevel) ? (value as CommandFailLevel) : fallback;
}

function normalizeIds(order: unknown, ids: string[]): string[] {
  // De-duplicate as well as filter: a repeated id in a stale entry would render
  // the same panel twice and hide another.
  const list = Array.isArray(order)
    ? [...new Set(order.filter((id): id is string => typeof id === "string" && ids.includes(id)))]
    : [];
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
  setChatMarkdown: (value: boolean) => void;
  setCommandFailThreshold: (value: number) => void;
  setCommandFailLevel: (value: CommandFailLevel) => void;
  setCommandStreakThreshold: (value: number) => void;
  setCommandStreakLevel: (value: CommandFailLevel) => void;
  setActivityStallThreshold: (value: number) => void;
  setActivityStallLevel: (value: CommandFailLevel) => void;
  setAgentStoppedLevel: (value: CommandFailLevel) => void;
  setUnresolvedErrorLevel: (value: CommandFailLevel) => void;
  setProcessLeftRunningLevel: (value: CommandFailLevel) => void;
  setProcessLeftRunningMinSeconds: (value: number) => void;
  setProcessLeftRunningIgnore: (value: string[]) => void;
  setOutsideChangeLevel: (value: CommandFailLevel) => void;
  setOutsideChangeIgnore: (value: string[]) => void;
  setFileVersionLoopThreshold: (value: number) => void;
  setFileVersionLoopLevel: (value: CommandFailLevel) => void;
  setCommandRetryLoopThreshold: (value: number) => void;
  setCommandRetryLoopLevel: (value: CommandFailLevel) => void;
  setSoundEnabled: (value: boolean) => void;
  setSoundVolume: (value: number) => void;
  setSoundLowAttention: (value: boolean) => void;
  setSoundComplete: (value: boolean) => void;
  setSoundApproval: (value: boolean) => void;
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
  setChatMarkdown: (value) => set((s) => persistIt(s, { chatMarkdown: value })),
  setCommandFailThreshold: (value) =>
    set((s) => persistIt(s, { commandFailThreshold: normalizeThreshold(value, DEFAULTS.commandFailThreshold) })),
  setCommandFailLevel: (value) => set((s) => persistIt(s, { commandFailLevel: normalizeLevel(value, DEFAULTS.commandFailLevel) })),
  setCommandStreakThreshold: (value) =>
    set((s) => persistIt(s, { commandStreakThreshold: normalizeThreshold(value, DEFAULTS.commandStreakThreshold) })),
  setCommandStreakLevel: (value) => set((s) => persistIt(s, { commandStreakLevel: normalizeLevel(value, DEFAULTS.commandStreakLevel) })),
  setActivityStallThreshold: (value) =>
    set((s) => persistIt(s, { activityStallThreshold: normalizeThreshold(value, DEFAULTS.activityStallThreshold) })),
  setActivityStallLevel: (value) => set((s) => persistIt(s, { activityStallLevel: normalizeLevel(value, DEFAULTS.activityStallLevel) })),
  setAgentStoppedLevel: (value) => set((s) => persistIt(s, { agentStoppedLevel: normalizeLevel(value, DEFAULTS.agentStoppedLevel) })),
  setUnresolvedErrorLevel: (value) => set((s) => persistIt(s, { unresolvedErrorLevel: normalizeLevel(value, DEFAULTS.unresolvedErrorLevel) })),
  setProcessLeftRunningLevel: (value) =>
    set((s) => persistIt(s, { processLeftRunningLevel: normalizeLevel(value, DEFAULTS.processLeftRunningLevel) })),
  setProcessLeftRunningMinSeconds: (value) =>
    set((s) =>
      persistIt(s, {
        processLeftRunningMinSeconds: normalizeCount(value, DEFAULTS.processLeftRunningMinSeconds),
      }),
    ),
  setProcessLeftRunningIgnore: (value) =>
    set((s) => persistIt(s, { processLeftRunningIgnore: normalizeList(value) })),
  setOutsideChangeLevel: (value) => set((s) => persistIt(s, { outsideChangeLevel: normalizeLevel(value, DEFAULTS.outsideChangeLevel) })),
  setOutsideChangeIgnore: (value) => set((s) => persistIt(s, { outsideChangeIgnore: normalizeList(value) })),
  setFileVersionLoopThreshold: (value) =>
    set((s) => persistIt(s, { fileVersionLoopThreshold: normalizeThreshold(value, DEFAULTS.fileVersionLoopThreshold) })),
  setFileVersionLoopLevel: (value) => set((s) => persistIt(s, { fileVersionLoopLevel: normalizeLevel(value, DEFAULTS.fileVersionLoopLevel) })),
  setCommandRetryLoopThreshold: (value) =>
    set((s) =>
      persistIt(s, { commandRetryLoopThreshold: normalizeThreshold(value, DEFAULTS.commandRetryLoopThreshold) }),
    ),
  setCommandRetryLoopLevel: (value) => set((s) => persistIt(s, { commandRetryLoopLevel: normalizeLevel(value, DEFAULTS.commandRetryLoopLevel) })),
  setSoundEnabled: (value) => set((s) => persistIt(s, { soundEnabled: value })),
  setSoundVolume: (value) => set((s) => persistIt(s, { soundVolume: normalizeVolume(value) })),
  setSoundLowAttention: (value) => set((s) => persistIt(s, { soundLowAttention: value })),
  setSoundComplete: (value) => set((s) => persistIt(s, { soundComplete: value })),
  setSoundApproval: (value) => set((s) => persistIt(s, { soundApproval: value })),
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

/** The persisted keys — everything in Settings except the store's actions. */
const SETTING_KEYS = Object.keys(DEFAULTS) as (keyof Settings)[];

/**
 * Merge a patch, persist, and return the state for zustand's set.
 *
 * The persisted object is rebuilt from `SETTING_KEYS` rather than by hand: the
 * hand-written list had to be edited for every new setting and silently dropped
 * the whole field when it was forgotten.
 */
function persistIt(state: Settings, patch: Partial<Settings>): Partial<SettingsStore> {
  const next = { ...state, ...patch };
  const stored = {} as Settings;
  for (const key of SETTING_KEYS) {
    // Each key is looked up on the merged object, so the assignment is sound
    // even though TS cannot correlate the loop variable with the value type.
    (stored as unknown as Record<string, unknown>)[key] = next[key];
  }
  persist(stored);
  return patch;
}

export type { AgentStatus };
