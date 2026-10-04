import Editor from "@monaco-editor/react";

interface CodeViewProps {
  value: string;
  language: string;
}

/** A small read-only code preview for in-panel detail views. */
export function CodeView({ value, language }: CodeViewProps) {
  return (
    <Editor
      height="100%"
      language={language}
      value={value}
      theme="daze"
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
