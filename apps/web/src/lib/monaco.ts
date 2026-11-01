import * as monaco from "monaco-editor";
export interface DeskPalette {
  bg: string; panel: string; panel2: string; deep: string; line: string;
  ink: string; dim: string; accent: string; ember: string; teal: string;
  wood: string; woodLit: string;
}

/**
 * The boot palette, used until the UI style's own paper tokens are read (see
 * applyMonacoTheme — App re-applies from `--mon-paper-*` on every style and
 * scheme change, so this only covers the first frames).
 */
export const DESK_PALETTE: DeskPalette = {
  bg: "#141210", panel: "#1b1815", panel2: "#211d19", deep: "#0f0d0b",
  line: "#2e2822", ink: "#efe7db", dim: "#9a8f80", accent: "#e0a458",
  ember: "#c56b3f", teal: "#5fa8a0", wood: "#3a332c", woodLit: "#4a4139",
};
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import jsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import cssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import htmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import tsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";
import { loader } from "@monaco-editor/react";

// Bundle Monaco locally instead of loading it from a CDN.
(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string) {
    if (label === "json") return new jsonWorker();
    if (label === "css" || label === "scss" || label === "less") return new cssWorker();
    if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker();
    if (label === "typescript" || label === "javascript") return new tsWorker();
    return new editorWorker();
  },
};

// The code paper follows the face's `--mon-paper-*` tokens, and the *base*
// theme follows the colour scheme: the vs-dark token colours are designed for
// dark paper and are unreadable on light, so a light scheme re-bases on "vs".
// Not defined at module load — main.tsx applies the boot palette, and App
// re-defines and re-selects on every style and scheme change.
function absenceTheme(p: DeskPalette, dark: boolean): monaco.editor.IStandaloneThemeData {
  return {
    base: dark ? "vs-dark" : "vs",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": p.panel,
      "editorGutter.background": p.panel,
      "editor.foreground": p.ink,
      "editorLineNumber.foreground": p.woodLit,
      "editorLineNumber.activeForeground": p.accent,
      "editor.lineHighlightBackground": p.panel2,
      "diffEditor.insertedTextBackground": dark ? "#2f5d4a55" : "#2f8a5a3d",
      "diffEditor.removedTextBackground": dark ? "#6b3a3555" : "#c050403d",
    },
  };
}

/**
 * Re-define the "absence" theme and refresh open editors.
 *
 * Every field is optional: the boot call passes nothing and gets the fixed
 * desk palette; App passes the four `--mon-paper-*` values it read off the
 * mounted face, plus `--mon-acc` for the active line number.
 */
export function applyMonacoTheme(p: Partial<DeskPalette> = {}, dark = true): void {
  const full: DeskPalette = { ...DESK_PALETTE, ...p };
  monaco.editor.defineTheme("absence", absenceTheme(full, dark));
  monaco.editor.setTheme("absence");
}

loader.config({ monaco });

export { monaco };
