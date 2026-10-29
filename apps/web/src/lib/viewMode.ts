/**
 * The four UI faces, named after hospital work.
 *
 * Absence shows one thing — an agent at work — but the right *shape* for that
 * depends on why you are looking:
 *
 *   Rounds  查房陪诊 — light, the avatar leads; you follow it around.
 *   Monitor 机器监护 — heavy, information leads; you read the traces.
 *   Chart   病历报告 — the run is over; you read what it amounted to.
 *   Drip    输液     — almost nothing; a floating card while you do other work.
 *
 * Classic is not one of them: it is the pre-split UI, kept so the branch can
 * always fall back to a known-good layout.
 */
export type ViewMode = "classic" | "rounds" | "monitor" | "chart" | "drip";

export interface ViewModeSpec {
  id: ViewMode;
  /** The hospital word, shown as the mode's name. */
  name: string;
  /** The Chinese term it is named after. */
  zh: string;
  /** What this face optimises for, in one line. */
  intent: string;
  /** False while a face is still being built (its button is disabled). */
  ready: boolean;
}

export const VIEW_MODES: ViewModeSpec[] = [
  { id: "rounds", name: "Rounds", zh: "查房陪诊", intent: "Light — the agent leads, you follow", ready: false },
  { id: "monitor", name: "Monitor", zh: "机器监护", intent: "Heavy — every trace on one screen", ready: true },
  { id: "chart", name: "Chart", zh: "病历报告", intent: "The run is over — read what it amounted to", ready: false },
  { id: "drip", name: "Drip", zh: "输液", intent: "Almost nothing — a floating card, always on top", ready: false },
  { id: "classic", name: "Classic", zh: "旧版", intent: "The pre-split layout", ready: true },
];

const STORAGE_KEY = "absence.viewMode";

/** Modes with a switcher entry (classic is appended to the list above). */
export const SWITCHABLE_MODES: ViewMode[] = ["rounds", "monitor", "chart", "drip", "classic"];

export function isViewMode(value: unknown): value is ViewMode {
  return SWITCHABLE_MODES.includes(value as ViewMode);
}

export function readStoredViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return isViewMode(raw) ? raw : "monitor";
  } catch {
    return "monitor";
  }
}

export function storeViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}

/** The spec for a mode (never undefined: unknown ids fall back to Monitor). */
export function viewModeSpec(mode: ViewMode): ViewModeSpec {
  return VIEW_MODES.find((entry) => entry.id === mode) ?? VIEW_MODES[1]!;
}
