/* ══════════════════════════════════════════════════════════════════════════
   UI styles — the three complete looks the faces render in (Nixie / Ink /
   Glass). Distinct from lib/theme.ts, which is the desk palette (the color
   theme inside Settings); a UI style is a class on <html> that remaps the
   face tokens in themes.css and switches style-specific features (the
   Nixie arrival tubes, the handwriting faces, the frosted panels).

   `null` means the neutral baseline. Storage is separate from the desk
   palette's key, and a stale value falls back to null.
   ══════════════════════════════════════════════════════════════════════════ */

export type UiStyleId = "glass" | "nixie" | "ink" | "light" | "dark";

export const UI_STYLES: UiStyleId[] = ["glass", "nixie", "ink", "light", "dark"];

/** The look a fresh install boots into. */
export const DEFAULT_UI_STYLE: UiStyleId = "glass";

const STORAGE_KEY = "absence.uistyle";

export function isUiStyle(value: unknown): value is UiStyleId {
  return typeof value === "string" && (UI_STYLES as string[]).includes(value);
}

export function readStoredUiStyle(): UiStyleId {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw === null ? null : JSON.parse(raw);
    return isUiStyle(parsed) ? parsed : DEFAULT_UI_STYLE;
  } catch {
    return DEFAULT_UI_STYLE;
  }
}

export function storeUiStyle(style: UiStyleId): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(style));
  } catch {
    /* private mode etc. — the style just doesn't survive the reload */
  }
}
