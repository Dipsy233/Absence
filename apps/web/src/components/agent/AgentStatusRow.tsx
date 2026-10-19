import { isAgentBusy, type AgentStatus } from "@absence/core";
import { statusLabel } from "../../lib/agent";
import { useT } from "../../lib/i18n";

/**
 * The status line under the avatar (and under TABLE while it lives in the panel
 * with the agent swapped onto the Stage): a dot plus the uppercased status, so
 * both faces of the panel read the same way.
 */
export function AgentStatusRow({ status }: { status: AgentStatus }) {
  const t = useT();
  return (
    <div className="flex shrink-0 items-center justify-center gap-2 pt-1">
      <span
        className={[
          "h-1.5 w-1.5 rounded-full",
          status === "error" ? "bg-desk-ember" : isAgentBusy(status) ? "bg-desk-teal" : "bg-desk-dim",
        ].join(" ")}
      />
      <span className="font-mono text-xs uppercase tracking-[0.2em] text-desk-dim">{t(statusLabel(status))}</span>
    </div>
  );
}
