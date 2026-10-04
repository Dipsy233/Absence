import { DiffEditor } from "@monaco-editor/react";
import { motion } from "framer-motion";
import { diffContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";

interface DiffStageProps {
  path: string;
  before: string;
  after: string;
  diff?: string;
  language: string;
  emptied?: boolean;
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

export function DiffStage({ path, before, after, diff, language, emptied = false }: DiffStageProps) {
  const addContext = useChatStore((s) => s.addContext);
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
          <button
            type="button"
            onClick={() => addContext(diffContext(path, diff ?? `${before}\n→\n${after}`))}
            className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
            title="Add this diff to Chat"
          >
            + Chat
          </button>
        </div>
        <motion.span
          className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-desk-amber to-transparent"
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 0] }}
          transition={{ duration: 1, ease: "easeInOut" }}
        />
      </div>
      <div className="min-h-0 flex-1">
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
        {emptied ? (
          <span className="text-desk-ember">Agent removed all content — the file still exists on disk.</span>
        ) : (
          <>Agent edited {path}</>
        )}
      </div>
    </motion.div>
  );
}
