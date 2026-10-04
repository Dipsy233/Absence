import type { DazeEvent } from "@daze/core";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";

interface SearchStageProps {
  tool: string;
  query: string;
  scope?: string;
  matches: number;
  output: string;
  event?: DazeEvent;
}

/** SEARCH → the matches list (read02 §45 Constraint 3). */
export function SearchStage({ tool, query, scope, matches, output, event }: SearchStageProps) {
  const addContext = useChatStore((s) => s.addContext);
  const lines = output.split("\n").filter((line) => line.trim().length > 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-teal">{tool}</span>
        <span className="truncate text-desk-ink" title={query}>
          {query}
        </span>
        {scope ? <span className="shrink-0 text-desk-dim">in {scope}</span> : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="chip text-desk-amber">{matches} hits</span>
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
            >
              + Chat
            </button>
          ) : null}
        </span>
      </div>
      {lines.length === 0 ? (
        <div className="p-3 text-xs italic text-desk-dim">No matches.</div>
      ) : (
        <ul className="min-h-0 flex-1 overflow-auto p-2 font-mono text-xs">
          {lines.map((line, index) => (
            <li
              key={index}
              className="truncate rounded px-2 py-1 text-desk-ink/85 hover:bg-desk-panel2"
              title={line}
            >
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
