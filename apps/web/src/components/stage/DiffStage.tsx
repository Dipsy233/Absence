import { motion } from "framer-motion";
import { diffContext } from "../../lib/context";
import { unifiedDiff } from "../../lib/diff";
import { useChatStore } from "../../stores/chatStore";

interface DiffStageProps {
  path: string;
  before: string;
  after: string;
  diff?: string;
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

/** Colour one line of a unified diff. */
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "text-desk-dim";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-desk-dim";
  if (line.startsWith("+")) return "bg-desk-teal/10 text-desk-teal";
  if (line.startsWith("-")) return "bg-desk-ember/10 text-desk-ember";
  return "text-desk-ink/70";
}

/**
 * A read-only unified diff.
 *
 * Deliberately NOT a Monaco diff editor: in Monaco's inline view the deleted
 * original lines are injected as view zones with their own line-number margin,
 * which reads as a second gutter plus a ghost of the old file. Rendering the
 * unified diff text directly is unambiguous.
 */
export function DiffStage({ path, before, after, diff, emptied = false }: DiffStageProps) {
  const addContext = useChatStore((s) => s.addContext);
  // Prefer the run's own diff (Pi annotates it with line numbers); if it is
  // missing, generate a standard unified diff from the two versions.
  const text = (diff ?? "").trim().length > 0 ? (diff as string) : unifiedDiff(before, after, path, path);
  const { added, removed } = countChanges(text);
  const lines = text.split("\n");

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

      <div className="min-h-0 flex-1 overflow-auto bg-[#0f0d0b]/40 py-2 font-mono text-xs leading-relaxed">
        {lines.map((line, index) => (
          <div key={index} className={`whitespace-pre px-3 ${diffLineClass(line)}`}>
            {line || " "}
          </div>
        ))}
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
