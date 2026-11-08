import type * as monacoNs from "monaco-editor";
import { useState, useEffect } from "react";
import { loader } from "@monaco-editor/react";

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

type MonacoModule = typeof monacoNs;

/**
 * Monaco loads on demand.
 *
 * The editor (and its workers) weigh several megabytes — more than the rest of
 * the app — and only the file/diff panels need it, so the library lives in a
 * lazy chunk that `ensureMonaco()` pulls in the first time a consumer asks.
 * Until then `@monaco-editor/react`'s Editor must not mount (it would fall
 * back to a CDN): gate it behind `useMonacoReady()`.
 */
let monacoPromise: Promise<MonacoModule> | undefined;
let monacoReady = false;
/** The latest theme request, held until the library is actually here. */
let pendingTheme: { palette: Partial<DeskPalette>; dark: boolean } | undefined = { palette: {}, dark: true };

export function ensureMonaco(): Promise<MonacoModule> {
  monacoPromise ??= (async () => {
    const [monaco, editorWorker, jsonWorker, cssWorker, htmlWorker, tsWorker] = await Promise.all([
      import("monaco-editor"),
      import("monaco-editor/esm/vs/editor/editor.worker?worker"),
      import("monaco-editor/esm/vs/language/json/json.worker?worker"),
      import("monaco-editor/esm/vs/language/css/css.worker?worker"),
      import("monaco-editor/esm/vs/language/html/html.worker?worker"),
      import("monaco-editor/esm/vs/language/typescript/ts.worker?worker"),
    ]);

    // Bundle Monaco locally instead of loading it from a CDN.
    (self as unknown as { MonacoEnvironment: monacoNs.Environment }).MonacoEnvironment = {
      getWorker(_workerId: string, label: string) {
        if (label === "json") return new jsonWorker.default();
        if (label === "css" || label === "scss" || label === "less") return new cssWorker.default();
        if (label === "html" || label === "handlebars" || label === "razor") return new htmlWorker.default();
        if (label === "typescript" || label === "javascript") return new tsWorker.default();
        return new editorWorker.default();
      },
    };
    loader.config({ monaco });

    // The theme that was asked for while the chunk was still downloading.
    const theme = pendingTheme ?? { palette: {}, dark: true };
    pendingTheme = undefined;
    monacoReady = true;
    applyLoadedTheme(monaco, theme.palette, theme.dark);
    return monaco;
  })();
  return monacoPromise;
}

/** True once `ensureMonaco()` has finished; flips every `useMonacoReady`. */
export function isMonacoReady(): boolean {
  return monacoReady;
}

/**
 * Whether the lazy Monaco chunk is in. Editors mount only when this is true.
 * Kicks off the load itself, so a gated panel starts the download just by
 * being rendered.
 */
export function useMonacoReady(): boolean {
  const [ready, setReady] = useState(monacoReady);
  useEffect(() => {
    if (monacoReady) return;
    let live = true;
    void ensureMonaco().then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

// The code paper follows the face's `--mon-paper-*` tokens, and the *base*
// theme follows the colour scheme: the vs-dark token colours are designed for
// dark paper and are unreadable on light, so a light scheme re-bases on "vs".
function absenceTheme(p: DeskPalette, dark: boolean): monacoNs.editor.IStandaloneThemeData {
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

function applyLoadedTheme(
  monaco: MonacoModule,
  partial: Partial<DeskPalette>,
  dark: boolean,
): void {
  const full: DeskPalette = { ...DESK_PALETTE, ...partial };
  monaco.editor.defineTheme("absence", absenceTheme(full, dark));
  monaco.editor.setTheme("absence");
}

/**
 * Re-define the "absence" theme and refresh open editors.
 *
 * Every field is optional: the boot call passes nothing and gets the fixed
 * desk palette; App passes the four `--mon-paper-*` values it read off the
 * mounted face, plus `--mon-acc` for the active line number. Calls that land
 * before the lazy chunk has loaded are held and applied the moment it does,
 * so the first mounted editor always sees the current paper.
 */
export function applyMonacoTheme(p: Partial<DeskPalette> = {}, dark = true): void {
  if (!monacoReady) {
    pendingTheme = { palette: p, dark };
    void ensureMonaco();
    return;
  }
  void ensureMonaco().then((monaco) => applyLoadedTheme(monaco, p, dark));
}
