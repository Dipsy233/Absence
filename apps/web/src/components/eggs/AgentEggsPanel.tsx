import { useMemo, useState } from "react";
import { eventToStageItem } from "../../lib/events";
import { formatOffset } from "../../lib/format";
import {
  buildEggs,
  countEggs,
  filterEggs,
  primaryEggs,
  summarizeTools,
  type Egg,
  type EggFilter,
} from "../../lib/eggs";
import { useSessionStore } from "../../stores/sessionStore";
import { useStageStore } from "../../stores/stageStore";
import { Panel } from "../Panel";

const FILTERS: EggFilter[] = ["running", "dead", "all"];

/**
 * Agent Eggs (v0.3): the processes the agent laid and left behind.
 *
 * Read-only on purpose — Daze reports what is running, it never kills an egg.
 * An egg is a process that outlived the shell command that spawned it, so a
 * command that simply finished is not an egg; a dev server it started is.
 *
 * Helpers — the `cat`, `grep` and `sleep` a command ran along the way — are not
 * listed. The classifier decides that from what a process *is*, not what it is
 * named; the count below is the only trace they leave here, and the raw records
 * stay in the event stream for the Report.
 */
export function AgentEggsPanel() {
  const events = useSessionStore((s) => s.events);
  const openStage = useStageStore((s) => s.openStage);
  const activeItemId = useStageStore((s) => s.activeItem?.id);
  const [filter, setFilter] = useState<EggFilter>("running");

  const eggs = useMemo(() => primaryEggs(buildEggs(events)), [events]);
  const tools = useMemo(() => summarizeTools(buildEggs(events)), [events]);
  const counts = countEggs(eggs);
  const shown = filterEggs(eggs, filter);

  const open = (egg: Egg) => {
    const item = eventToStageItem(egg.event);
    if (item) openStage(item);
  };

  return (
    <Panel
      title="Agent Eggs"
      aside={counts.all > 0 ? `${counts.running}/${counts.all} running` : "none"}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
    >
      <div className="mb-2 flex gap-1">
        {FILTERS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setFilter(option)}
            className={[
              "rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide transition-colors",
              filter === option
                ? "border-desk-amber/70 bg-desk-amber/10 text-desk-amber"
                : "border-desk-line bg-desk-panel2 text-desk-dim hover:text-desk-ink",
            ].join(" ")}
          >
            {option}
            <span className="ml-1 normal-case text-desk-dim">
              {option === "running" ? counts.running : option === "dead" ? counts.dead : counts.all}
            </span>
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="text-xs text-desk-dim">
          {eggs.length === 0
            ? "No eggs yet. An egg is a process the agent left running — a dev server, a watcher."
            : "Nothing here. Try another filter."}
        </p>
      ) : (
        <ul className="space-y-1">
          {shown.map((egg) => {
            // Match on the pid-stable card id (see eventToStageItem): the egg's
            // latest event changes as it updates, but the card's id does not, so
            // the highlight survives a running → exited transition.
            const selected = `process_${egg.pid}` === activeItemId;
            return (
              <li key={egg.pid}>
                <button
                  type="button"
                  onClick={() => open(egg)}
                  title={`Open pid ${egg.pid} on the Stage`}
                  aria-current={selected ? "true" : undefined}
                  className={[
                    "block w-full rounded border-l-2 px-1.5 py-1 text-left font-mono text-[11px] leading-tight",
                    selected
                      ? "border-l-desk-amber bg-desk-panel2"
                      : "border-l-transparent hover:bg-desk-panel2",
                  ].join(" ")}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span
                      className={[
                        "h-1.5 w-1.5 shrink-0 self-center rounded-full",
                        egg.status === "running" ? "bg-desk-teal" : "bg-desk-dim",
                      ].join(" ")}
                    />
                    <span className="truncate text-desk-ink/90" title={egg.name}>
                      {egg.name}
                    </span>
                    <span className="ml-auto shrink-0 text-desk-dim">pid {egg.pid}</span>
                  </span>
                  <span className="block truncate pl-3 text-desk-dim" title={egg.commandLine}>
                    {egg.commandLine || egg.command || ""}
                  </span>
                  <span className="block pl-3 text-[10px] text-desk-dim/80">
                    {egg.status === "running" ? "running for" : "lived"}{" "}
                    {formatOffset((egg.exitedAt ?? Date.now()) - egg.startedAt)}
                    {egg.children > 0 ? ` · +${egg.children} child${egg.children === 1 ? "" : "ren"}` : ""}
                    {egg.kindReason ? ` · ${egg.kindReason}` : ""}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      {tools.count > 0 ? (
        <p
          className="mt-2 border-t border-desk-line/60 pt-1.5 font-mono text-[10px] text-desk-dim"
          title={tools.names.join(", ")}
        >
          folded {tools.count} helper{tools.count === 1 ? "" : "s"}
          {tools.names.length > 0 ? `: ${tools.names.join(", ")}` : ""}
          {tools.running > 0 ? ` (${tools.running} still running)` : ""}
        </p>
      ) : null}
    </Panel>
  );
}
