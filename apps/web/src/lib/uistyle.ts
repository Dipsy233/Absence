/* == UI styles: three complete looks x two color schemes. ==
   A style is a class on <html> (theme-nixie / theme-ink / theme-glass)
   remapping the face tokens in themes.css; a scheme (scheme-light /
   scheme-dark) is a second class flipping the style's own token set. Both
   persist separately: the scheme is its own option, not a property of the
   style. Each style declares the scheme it is designed around (ink is a
   paper look and starts light; the others start dark). */

export type UiStyleId = "nixie" | "ink" | "glass";

export const UI_STYLES: UiStyleId[] = ["nixie", "ink", "glass"];

export type ColorScheme = "dark" | "light";

export const SCHEMES: ColorScheme[] = ["dark", "light"];

/** The scheme a style is designed around. */
export function defaultScheme(style: UiStyleId): ColorScheme {
  return style === "ink" ? "light" : "dark";
}

const STYLE_KEY = "absence.uistyle";
const SCHEME_KEY = "absence.uistyle-scheme";

export function isUiStyle(value: unknown): value is UiStyleId { return typeof value === "string" && (UI_STYLES as string[]).includes(value); }
export function isScheme(value: unknown): value is ColorScheme { return value === "dark" || value === "light"; }

export function readStoredUiStyle(): UiStyleId {
  try {
    const parsed = JSON.parse(localStorage.getItem(STYLE_KEY) ?? "null");
    return isUiStyle(parsed) ? parsed : UI_STYLES[0] as UiStyleId;
  } catch { return UI_STYLES[0] as UiStyleId; }
}

export function storeUiStyle(style: UiStyleId): void {
  try { localStorage.setItem(STYLE_KEY, JSON.stringify(style)); } catch {}
}

/** null = follow the style's own default scheme. */
export function readStoredScheme(): ColorScheme | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(SCHEME_KEY) ?? "null");
    return isScheme(parsed) ? parsed : null;
  } catch { return null; }
}

export function storeScheme(scheme: ColorScheme | null): void {
  try {
    if (scheme === null) localStorage.removeItem(SCHEME_KEY);
    else localStorage.setItem(SCHEME_KEY, JSON.stringify(scheme));
  } catch {}
}
