import type { ApprovalOption } from "@absence/core";
import { useT } from "../../lib/i18n";

interface ApprovalStageProps {
  approvalId: string;
  approvalKind: string;
  title: string;
  detail: string;
  reason?: string;
  cwd?: string;
  options: ApprovalOption[];
}

/**
 * The Stage view of a permission request, read-only.
 *
 * Absence never answers for the user: the card shows the request *verbatim*
 * and the exact choices the runtime offered, and — through the follow-up
 * events on the same approval id — what was actually answered and by whom.
 * The answer happens wherever the agent really lives (the editor client for a
 * proxied session, the agent's own terminal UI otherwise); this card's job is
 * to make the question and its outcome visible, not to stand in for them.
 *
 * An approval is not forced onto the Stage: it arrives as an ordinary
 * `APPROVE?` activity row, and this view opens when the user clicks it (or
 * navigates to it).
 */
export function ApprovalStage({
  approvalKind,
  title,
  detail,
  reason,
  cwd,
  options,
}: ApprovalStageProps) {
  const t = useT();

  return (
    <div className="flex h-full min-h-0 flex-col bg-desk-deep/50">
      <div className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-2 font-mono text-xs">
        <span className="chip text-desk-amber">{approvalKind.replace(/_/g, " ")}</span>
        <span className="truncate text-desk-ink" title={title}>
          {title}
        </span>
        <span className="ml-auto shrink-0 text-desk-dim">{t("observed — answered elsewhere")}</span>
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
        {options.map((option) => (
          <span
            key={option.value}
            className={`rounded border px-3 py-1.5 font-mono text-[11px] tracking-wide ${
              option.tone === "decline" || option.tone === "cancel"
                ? "border-desk-red/60 text-desk-red"
                : option.tone === "accept" || option.tone === "accept-session"
                  ? "border-desk-teal/60 text-desk-teal"
                  : "border-desk-line text-desk-dim"
            }`}
          >
            {option.label}
          </span>
        ))}
        <span className="ml-auto font-mono text-[10px] text-desk-dim">
          {t("Absence only watches — the choice belongs to the agent's own client.")}
        </span>
      </div>
    </div>
  );
}
