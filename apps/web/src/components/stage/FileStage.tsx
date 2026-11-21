import { useCallback, useEffect, useRef } from "react";
import Editor from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { formatBytes } from "../../lib/format";
import { useMonacoReady } from "../../lib/monaco";
import { useT } from "../../lib/i18n";

interface FileStageProps {
  path: string;
  content: string;
  language: string;
  /** Highlight range, in original file coordinates. */
  startLine?: number;
  endLine?: number;
  /** False when no range was reported: never fake a highlight. */
  rangeKnown?: boolean;
  /** Original line number of the first displayed line (1 = whole file). */
  lineOffset?: number;
  caption?: string;
  badge?: string;
  badgeTone?: "normal" | "warn";
  /** False when the host's own title bar already carries path, size and range
      (Rounds' windows): the editor keeps the caption, not a second toolbar. */
  showToolbar?: boolean;
}

export function FileStage({
  path,
  content,
  language,
  startLine,
  endLine,
  rangeKnown,
  lineOffset = 0,
  caption,
  badge,
  badgeTone = "normal",
  showToolbar = true,
}: FileStageProps) {
  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const collectionRef = useRef<Monaco.editor.IEditorDecorationsCollection | null>(null);
  // Monaco is a lazy chunk; hold the editor's own loading state until it lands,
  // so @monaco-editor/react never reaches for a CDN.
  const monacoReady = useMonacoReady();
  const t = useT();

  const applyDecorations = useCallback(() => {
    const editor = editorRef.current;
    if (!editor) return;
    if (!collectionRef.current) collectionRef.current = editor.createDecorationsCollection([]);

    const localStart = startLine !== undefined ? startLine - lineOffset : undefined;
    const localEnd = endLine !== undefined ? endLine - lineOffset : undefined;
    const hasRange =
      rangeKnown !== false &&
      localStart !== undefined &&
      localEnd !== undefined &&
      localStart >= 1 &&
      localEnd >= localStart;

    collectionRef.current.set(
      hasRange
        ? [
            {
              range: {
                startLineNumber: localStart,
                startColumn: 1,
                endLineNumber: localEnd,
                endColumn: 1,
              },
              options: {
                isWholeLine: true,
                className: "absence-line-hl",
                linesDecorationsClassName: "absence-line-badge",
              },
            },
          ]
        : [],
    );

    if (hasRange) editor.revealLineInCenterIfOutsideViewport(localStart);
  }, [startLine, endLine, rangeKnown, lineOffset]);

  useEffect(() => {
    applyDecorations();
  }, [applyDecorations, content, path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {showToolbar ? (
        <div className="flex shrink-0 items-center justify-between gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
          <span className="truncate text-desk-ink" title={path}>
            {path}
          </span>
          <div className="flex items-center gap-2">
            {badge ? (
              <span className={["chip", badgeTone === "warn" ? "text-desk-ember" : "text-desk-teal"].join(" ")}>
                {badge}
              </span>
            ) : null}
            <span className="text-desk-dim">{formatBytes(content.length)}</span>
            {rangeKnown === false ? (
              <span className="text-desk-dim" title={t("The agent did not report which lines it read")}>
                {t("range unknown")}
              </span>
            ) : startLine !== undefined && endLine !== undefined ? (
              <span className="text-desk-amber">
                {startLine}–{endLine}
              </span>
            ) : (
              <span className="text-desk-dim">{t("{n} lines", { n: content.split("\n").length })}</span>
            )}
          </div>
        </div>
      ) : null}
      <div className="min-h-0 flex-1">
        {!monacoReady ? (
          <div className="p-4 font-mono text-xs text-desk-dim">{t("loading editor…")}</div>
        ) : (
        <Editor
          height="100%"
          language={language}
          value={content}
          theme="absence"
          loading={<div className="p-4 font-mono text-xs text-desk-dim">{t("loading editor…")}</div>}
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
            lineNumbers: lineOffset > 0 ? (line) => String(line + lineOffset) : "on",
            scrollBeyondLastLine: false,
            renderLineHighlight: "none",
            contextmenu: true,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
            padding: { top: 10, bottom: 10 },
            smoothScrolling: true,
            scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
          }}
        />
        )}
      </div>
      {caption ? (
        <div className="shrink-0 border-t border-desk-line px-3 py-1.5 text-center text-xs italic text-desk-dim">
          {caption}
        </div>
      ) : null}
    </div>
  );
}
