import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import type { DazeEvent } from "@daze/core";

interface TerminalStageProps {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  event?: DazeEvent;
}

export function TerminalStage({ command, stdout, stderr, exitCode, event }: TerminalStageProps) {
  const addContext = useChatStore((s) => s.addContext);

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0d0b]">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="text-desk-teal">$</span>
        <span className="truncate text-desk-ink" title={command}>
          {command}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className={["chip", exitCode === 0 ? "text-desk-teal" : "text-desk-ember"].join(" ")}>
            exit {exitCode}
          </span>
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title="Add this command to Chat"
            >
              + Chat
            </button>
          ) : null}
        </span>
      </div>
      <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-desk-ink/85">
        {stdout || "(no output)"}
        {stderr ? `\n${stderr}` : ""}
      </pre>
    </div>
  );
}
