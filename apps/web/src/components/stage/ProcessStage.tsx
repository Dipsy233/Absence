import type { DazeEvent } from "@daze/core";
import { eventContext } from "../../lib/context";
import { formatOffset } from "../../lib/format";
import { useChatStore } from "../../stores/chatStore";

interface ProcessStageProps {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  status: "running" | "exited";
  children: number;
  command?: string;
  startedAt: number;
  exitedAt?: number;
  event?: DazeEvent;
}

/**
 * One egg on the Stage (v0.3): a process the agent laid and left behind.
 *
 * Read-only by design — Daze reports what is running, it never kills it. This is
 * the one place where "the agent started a server" can be stated as an observed
 * fact: a process that outlived the shell command that spawned it.
 */
export function ProcessStage({
  pid,
  ppid,
  name,
  commandLine,
  status,
  children,
  command,
  startedAt,
  exitedAt,
  event,
}: ProcessStageProps) {
  const addContext = useChatStore((s) => s.addContext);
  const lived = (exitedAt ?? Date.now()) - startedAt;
  const alive = status === "running";

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0f0d0b]/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className={["chip", alive ? "text-desk-teal" : "text-desk-dim"].join(" ")}>{status}</span>
        <span className="truncate text-desk-ink" title={name}>
          {name}
        </span>
        <span className="shrink-0 text-desk-dim">pid {pid}</span>
        {children > 0 ? (
          <span className="shrink-0 text-desk-dim">
            +{children} child{children === 1 ? "" : "ren"}
          </span>
        ) : null}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-desk-dim">
            {alive ? "alive for" : "lived"} {formatOffset(lived)}
          </span>
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title="Add this process to Chat"
            >
              + Chat
            </button>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs leading-relaxed text-desk-ink/85">
        <div className="mb-2 text-desk-dim">ppid {ppid}</div>
        <div className="whitespace-pre-wrap break-words">{commandLine || "(no command line)"}</div>
        {command ? (
          <div className="mt-3 border-t border-desk-line/70 pt-2 text-desk-dim">
            laid by <span className="text-desk-amber">{command}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
