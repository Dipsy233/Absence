import { useCallback, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";

interface FileReadViewProps {
  path: string;
  content: string;
  language: string;
  startLine?: number;
  endLine?: number;
  caption?: string;
  badge?: string;
}

export function FileReadView({ path, content, language, startLine, endLine, caption, badge }: FileReadViewProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const collectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);

  const applyDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!collectionRef.current) {
      collectionRef.current = editor.createDecorationsCollection([]);
    }
    const range =
      startLine && endLine && startLine > 0
        ? {
            range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
            options: {
              isWholeLine: true,
              className: "daze-line-hl",
              linesDecorationsClassName: "daze-line-badge",
            },
          }
        : null;
    collectionRef.current.set(range ? [range] : []);
  }, [startLine, endLine]);

  useEffect(() => {
    applyDecorations();
  }, [applyDecorations, content, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="truncate text-desk-ink" title={path}>
          {path}
        </span>
        <div className="flex items-center gap-2">
          {badge ? <span className="chip text-desk-teal">{badge}</span> : null}
          {startLine && endLine ? (
            <span className="text-desk-amber">
              {startLine}–{endLine}
            </span>
          ) : null}
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <Editor
          height="100%"
          language={language}
          value={content}
          theme="daze"
          loading={<div className="p-4 font-mono text-xs text-desk-dim">loading editor…</div>}
          onMount={(editor) => {
            editorRef.current = editor;
            applyDecorations();
          }}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: 12.5,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            padding: { top: 10, bottom: 10 },
            smoothScrolling: true,
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
          }}
        />
      </div>
      {caption ? (
        <div className="shrink-0 border-t border-desk-line px-3 py-1.5 text-center text-xs italic text-desk-dim">
          {caption}
        </div>
      ) : null}
    </div>
  );
}
