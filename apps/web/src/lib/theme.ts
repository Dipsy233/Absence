import { applyMonacoTheme } from "./monaco";

/**
 * Color themes. Every desk palette slot lives in a CSS custom property so the
 * whole UI — Tailwind classes, the SVG desk world, Monaco — re-derives from one
 * place. Vars are stored as bare "R G B" channel triples so Tailwind's opacity
 * modifiers (`bg-desk-panel/85`) and plain CSS (`rgb(var(--desk-accent) / .12)`)
 * both work.
 */
export type ThemeId = "amber" | "blue" | "green";

export interface DeskPalette {
  /** Deepest background (window, room). */
  bg: string;
  /** Panel chrome; also the desk surface gradient's bottom stop. */
  panel: string;
  /** Raised panel fill (chips, screens' surroundings). */
  panel2: string;
  /** Near-black under-layer behind terminal/diff/replay sheets. */
  deep: string;
  /** Hairline borders; also the desk gradient's top stop. */
  line: string;
  /** Top stop of the desk surface gradient (a lit wood/leather tone). */
  surfaceTop: string;
  /** Primary text; also the paper sheet. */
  ink: string;
  /** Secondary text and writing strokes. */
  dim: string;
  /** Accent: highlights, cursor, wake screen. */
  accent: string;
  /** Warm/error tone: degraded badges, offline, failures. */
  ember: string;
  /** Cool companion tone: live dot, screen glow, gradients. */
  teal: string;
  /** Wood-tone fill: keyboard keys, pen body, scrollbar thumb. */
  wood: string;
  /** Lit variant of wood: pressed keys, scrollbar thumb hover. */
  woodLit: string;
  /** Top stop of the monitor's screen gradient. */
  screenTop: string;
  /** Coffee: liquid, lid highlights stay physical across themes. */
  coffee: string;
  coffeeLid: string;
  coffeeLidDark: string;
}

const AMBER: DeskPalette = {
  bg: "#141210",
  panel: "#1b1815",
  panel2: "#211d19",
  deep: "#0f0d0b",
  line: "#2e2822",
  surfaceTop: "#2a221c",
  ink: "#efe7db",
  dim: "#9a8f80",
  accent: "#e0a458",
  ember: "#c56b3f",
  teal: "#5fa8a0",
  wood: "#3a332c",
  woodLit: "#4a4139",
  screenTop: "#16201e",
  coffee: "#553a29",
  coffeeLid: "#cfc7b8",
  coffeeLidDark: "#bdb3a2",
};

const BLUE: DeskPalette = {
  ...AMBER,
  bg: "#10141b",
  panel: "#141a24",
  panel2: "#19212e",
  deep: "#0a0d13",
  line: "#26303f",
  surfaceTop: "#1f2a3a",
  ink: "#e3eaf3",
  dim: "#8496ab",
  accent: "#5fa8d8",
  ember: "#cf7055",
  teal: "#56b8c4",
  wood: "#2a3547",
  woodLit: "#3c4a60",
  screenTop: "#111c2b",
};

const GREEN: DeskPalette = {
  ...AMBER,
  bg: "#101510",
  panel: "#151c14",
  panel2: "#1a2217",
  deep: "#0a0e09",
  line: "#27331f",
  surfaceTop: "#202c17",
  ink: "#e7efe2",
  dim: "#8a9c82",
  accent: "#8cb85a",
  ember: "#c9793f",
  teal: "#58a893",
  wood: "#2e3a26",
  woodLit: "#425234",
  screenTop: "#131f11",
};

export const THEMES: Record<ThemeId, DeskPalette> = {
  amber: AMBER,
  blue: BLUE,
  green: GREEN,
};

export const THEME_IDS: ThemeId[] = ["amber", "blue", "green"];

const STORAGE_KEY = "absence.theme";

/** Palette slot → CSS var suffix. */
const VAR_SLOTS: Array<[keyof DeskPalette, string]> = [
  ["bg", "bg"],
  ["panel", "panel"],
  ["panel2", "panel2"],
  ["deep", "deep"],
  ["line", "line"],
  ["surfaceTop", "surface-top"],
  ["ink", "ink"],
  ["dim", "dim"],
  ["accent", "accent"],
  ["ember", "ember"],
  ["teal", "teal"],
  ["wood", "wood"],
  ["woodLit", "wood-lit"],
  ["screenTop", "screen-top"],
  ["coffee", "coffee"],
  ["coffeeLid", "coffee-lid"],
  ["coffeeLidDark", "coffee-lid-dark"],
];

function hexToChannels(hex: string): string {
  const n = hex.replace("#", "");
  const full = n.length === 3 ? n.split("").map((c) => c + c).join("") : n;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `${r} ${g} ${b}`;
}

/** Apply a theme to the document and Monaco. Safe to call repeatedly. */
export function applyTheme(id: ThemeId): void {
  const palette = THEMES[id] ?? AMBER;
  const root = document.documentElement;
  for (const [slot, name] of VAR_SLOTS) {
    root.style.setProperty(`--desk-${name}`, hexToChannels(palette[slot]));
  }
  applyMonacoTheme(palette);
}

export function readStoredTheme(): ThemeId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw && THEME_IDS.includes(raw as ThemeId) ? (raw as ThemeId) : "amber";
  } catch {
    return "amber";
  }
}

export function storeTheme(id: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, id);
  } catch {
    // ignore storage failures (private mode, etc.)
  }
}
