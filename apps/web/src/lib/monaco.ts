import * as monaco from "monaco-editor";
export interface DeskPalette {
  bg: string; panel: string; panel2: string; deep: string; line: string;
  ink: string; dim: string; accent: string; ember: string; teal: string;
  wood: string; woodLit: string;
}

/** The desk palette the UI boots with (the old color-theme presets are gone;
    the faces' own UI styles handle looks now). */
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

// A low-contrast theme that follows the desk's palette. Not defined at module
// load — main.tsx applies the stored theme, which defines "absence" before any
// editor mounts. Switching color themes re-defines and re-selects it.
function absenceTheme(p: DeskPalette): monaco.editor.IStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": p.panel,
      "editorGutter.background": p.panel,
      "editorLineNumber.foreground": p.woodLit,
      "editorLineNumber.activeForeground": p.accent,
      "editor.lineHighlightBackground": p.panel2,
      "diffEditor.insertedTextBackground": "#2f5d4a55",
      "diffEditor.removedTextBackground": "#6b3a3555",
    },
  };
}

/** Re-define the "absence" theme from a palette and refresh open editors. */
export function applyMonacoTheme(p: DeskPalette = DESK_PALETTE): void {
  monaco.editor.defineTheme("absence", absenceTheme(p));
  monaco.editor.setTheme("absence");
}

loader.config({ monaco });

export { monaco };
