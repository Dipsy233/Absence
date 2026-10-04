import * as monaco from "monaco-editor";
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

// A warm, low-contrast theme that matches the desk.
monaco.editor.defineTheme("daze", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1b1815",
    "editorGutter.background": "#1b1815",
    "editorLineNumber.foreground": "#4a4139",
    "editorLineNumber.activeForeground": "#e0a458",
    "editor.lineHighlightBackground": "#211d19",
    "diffEditor.insertedTextBackground": "#2f5d4a55",
    "diffEditor.removedTextBackground": "#6b3a3555",
  },
});

loader.config({ monaco });

export { monaco };
