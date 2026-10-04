import { useCallback, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { formatBytes } from "../../lib/format";
import { fileContext, selectionContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";

interface FileStageProps {
  path: string;
  content: string;
  language: string;
  startLine?: number;
  endLine?: number;
  caption?: string;
  badge?: string;
  badgeTone?: "normal" | "warn";
}

export function FileStage({
  path,
  content,
  language,
  startLine,
  endLine,
  caption,
  badge,
  badgeTone = "normal",
}: FileStageProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const collectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  const addContext = useChatStore((s) => s.addContext);

  const applyDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!collectionRef.current) collectionRef.current = editor.createDecorationsCollection([]);
    const decoration =
      startLine && endLine && startLine > 0
        ? [
            {
              range: { startLineNumber: startLine, startColumn: 1, endLineNumber: endLine, endColumn: 1 },
              options: {
                isWholeLine: true,
                className: "daze-line-hl",
                linesDecorationsClassName: "daze-line-badge",
              },
            },
          ]
        : [];
    collectionRef.current.set(decoration);
    if (startLine) editor.revealLineInCenterIfOutsideViewport(startLine);
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
          {badge ? (
            <span className={["chip", badgeTone === "warn" ? "text-desk-ember" : "text-desk-teal"].join(" ")}>
              {badge}
            </span>
          ) : null}
          {badge ? <span className="text-desk-dim">{formatBytes(content.length)}</span> : null}
          {startLine && endLine ? (
            <span className="text-desk-amber">
              {startLine}–{endLine}
            </span>
          ) : null}
          <button
            type="button"
            onClick={() => addContext(fileContext(path, content))}
            className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
            title="Add this file to Chat"
          >
            + Chat
          </button>
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
            editor.addAction({
              id: "daze.addSelectionToChat",
              label: "Add selection to Chat",
              contextMenuGroupId: "z_daze",
              contextMenuOrder: 1,
              run: (instance) => {
                const model = instance.getModel();
                const selection = instance.getSelection();
                if (!model || !selection || selection.isEmpty()) return;
                const text = model.getValueInRange(selection);
                if (!text.trim()) return;
                addContext(selectionContext(path, selection.startLineNumber, selection.endLineNumber, text));
              },
            });
            editor.addAction({
              id: "daze.addFileToChat",
              label: "Add file to Chat",
              contextMenuGroupId: "z_daze",
              contextMenuOrder: 2,
              run: () => addContext(fileContext(path, content)),
            });
          }}
          options={{
            readOnly: true,
            domReadOnly: true,
            minimap: { enabled: false },
            fontSize: 12.5,
            lineNumbersMinChars: 3,
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            contextmenu: true,
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
