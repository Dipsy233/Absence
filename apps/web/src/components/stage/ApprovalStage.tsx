import { useState, type MouseEvent } from "react";
import type { ApprovalOption, AbsenceEvent } from "@absence/core";
import { eventContext } from "../../lib/context";
import { useChatStore } from "../../stores/chatStore";
import { useSessionStore } from "../../stores/sessionStore";

interface ApprovalStageProps {
  approvalId: string;
  approvalKind: string;
  title: string;
  detail: string;
  reason?: string;
  cwd?: string;
  options: ApprovalOption[];
  event?: AbsenceEvent;
}

/**
 * The Stage view of a runtime approval prompt (Codex's
 * `item/…/requestApproval`). The agent is paused on this decision, so the card
 * shows the request *verbatim* and the exact choices the runtime offered — the
 * user approves what the runtime is actually about to do, not a paraphrase.
 *
 * An approval is not forced onto the Stage: it arrives as an ordinary
 * `APPROVE?` activity row, and this view opens when the user clicks it (or
 * navigates to it).
 *
 * Read-only until a button is pressed: picking an option posts the decision to
 * the server, which unblocks the runtime request. The card then shows the
 * chosen answer and stops accepting clicks.
 */
export function ApprovalStage({
  approvalId,
  approvalKind,
  title,
  detail,
  reason,
  cwd,
  options,
  event,
}: ApprovalStageProps) {
  const respondApproval = useSessionStore((s) => s.respondApproval);
  const addContext = useChatStore((s) => s.addContext);
  const [chosen, setChosen] = useState<string>();
  const [busy, setBusy] = useState(false);

  const decide = async (option: ApprovalOption, interactiveEvent: MouseEvent) => {
    interactiveEvent.stopPropagation();
    if (chosen !== undefined || busy) return;
    setBusy(true);
    try {
      await respondApproval(approvalId, option.value);
      setChosen(option.value);
    } finally {
      setBusy(false);
    }
  };

  const toneClass = (tone: ApprovalOption["tone"], isChosen: boolean): string => {
    const base =
      "rounded border px-3 py-1.5 font-mono text-[11px] tracking-wide transition-colors disabled:cursor-default";
    if (isChosen) return `${base} border-desk-amber bg-desk-amber/15 text-desk-amber`;
    switch (tone) {
      case "accept":
      case "accept-session":
        return `${base} border-desk-teal/60 text-desk-teal hover:bg-desk-teal/15`;
      case "decline":
      case "cancel":
        return `${base} border-desk-red/60 text-desk-red hover:bg-desk-red/15`;
      default:
        return `${base} border-desk-line text-desk-dim hover:text-desk-ink`;
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-amber">{approvalKind.replace(/_/g, " ")}</span>
        <span className="truncate text-desk-ink" title={title}>
          {title}
        </span>
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-desk-dim">the agent is waiting</span>
          {event ? (
            <button
              type="button"
              onClick={() => addContext(eventContext(event))}
              className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
              title="Add this approval to Chat"
            >
              + Chat
            </button>
          ) : null}
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {reason ? (
          <div className="mb-2 font-mono text-xs text-desk-amber/90">{reason}</div>
        ) : null}
        <pre className="whitespace-pre-wrap break-words rounded border border-desk-line/70 bg-desk-deep/60 p-3 font-mono text-xs leading-relaxed text-desk-ink/90">
          {detail}
        </pre>
        {cwd ? <div className="mt-2 font-mono text-[10px] text-desk-dim">cwd {cwd}</div> : null}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-desk-line px-3 py-2">
        {options.map((option) => {
          const isChosen = chosen === option.value;
          return (
            <button
              key={option.value}
              type="button"
              disabled={chosen !== undefined || busy}
              onClick={(mouseEvent) => void decide(option, mouseEvent)}
              className={toneClass(option.tone, isChosen)}
            >
              {option.label}
            </button>
          );
        })}
        {chosen !== undefined ? (
          <span className="ml-auto font-mono text-[10px] text-desk-dim">answered: {chosen}</span>
        ) : null}
      </div>
    </div>
  );
}
