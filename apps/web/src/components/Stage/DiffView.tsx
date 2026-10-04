import { DiffEditor } from "@monaco-editor/react";
import { motion } from "framer-motion";

interface DiffViewProps {
  path: string;
  before: string;
  after: string;
  diff?: string;
  language: string;
}

export function DiffView({ path, before, after, diff, language }: DiffViewProps) {
  const { added, removed } = countChanges(diff ?? "");
  const hasText = before.length > 0 || after.length > 0;

  return (
    <motion.div
      className="flex h-full min-h-0 flex-col"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, ease: "easeOut" }}
    >
      <div className="relative flex shrink-0 items-center justify-between border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="truncate text-desk-ink" title={path}>
          {path}
        </span>
        <div className="flex items-center gap-3">
          <span className="text-desk-teal">+{added}</span>
          <span className="text-desk-ember">-{removed}</span>
        </div>
        {/* a slow sweep so the eye can catch the change */}
        <motion.span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-desk-amber to-transparent"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 1, ease: "easeInOut" }}
        />
      </div>
      <div className="relative min-h-0 flex-1">
        {hasText ? (
          <DiffEditor
            height="100%"
            language={language}
            original={before}
            modified={after}
            theme="daze"
            loading={<div className="p-4 font-mono text-xs text-desk-dim">loading diff…</div>}
            options={{
              readOnly: true,
              renderSideBySide: false,
              minimap: { enabled: false },
              fontSize: 12.5,
              scrollBeyondLastLine: false,
              renderOverviewRuler: false,
              folding: false,
              glyphMargin: false,
              lineNumbersMinChars: 3,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
              padding: { top: 10, bottom: 10 },
              scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
            }}
          />
        ) : (
          <pre className="h-full overflow-auto whitespace-pre-wrap p-3 font-mono text-xs text-desk-ink/85">
            {diff || "No diff available."}
          </pre>
        )}
      </div>
      <div className="shrink-0 border-t border-desk-line px-3 py-1.5 text-center text-xs italic text-desk-dim">
        Agent edited {path}
      </div>
    </motion.div>
  );
}

function countChanges(diff: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) added++;
    else if (line.startsWith("-")) removed++;
  }
  return { added, removed };
}
