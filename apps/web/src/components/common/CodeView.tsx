import Editor from "@monaco-editor/react";
import { useMonacoReady } from "../../lib/monaco";

interface CodeViewProps {
  value: string;
  language: string;
}

/** A small read-only code preview for in-panel detail views. */
export function CodeView({ value, language }: CodeViewProps) {
  // Monaco is a lazy chunk; mounting the editor before it lands would send
  // @monaco-editor/react off to a CDN. Hold the existing loading state instead.
  const monacoReady = useMonacoReady();
  if (!monacoReady) {
    return <div className="p-2 font-mono text-[10px] text-desk-dim">loading…</div>;
  }
  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="absence"
      loading={<div className="p-2 font-mono text-[10px] text-desk-dim">loading…</div>}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 11.5,
        lineNumbersMinChars: 3,
        scrollBeyondLastLine: false,
        renderLineHighlight: "none",
        overviewRulerLanes: 0,
        folding: false,
        glyphMargin: false,
        wordWrap: "off",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
        padding: { top: 6, bottom: 6 },
        scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
      }}
    />
  );
}
