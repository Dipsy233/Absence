import { useDazeStore } from "../../stores/useDazeStore";
import { useNow } from "../../hooks/useNow";
import { Panel } from "../Panel";
import { formatClock, formatContext, formatTokens } from "../../lib/format";

export function SessionInfo() {
  useNow(1000);
  const session = useDazeStore((s) => s.session);
  const context = useDazeStore((s) => s.context);
  const connected = useDazeStore((s) => s.connected);
  const reset = useDazeStore((s) => s.reset);

  if (!session) return null;

  const used = context?.used ?? null;
  const total = context?.total ?? null;
  const percent = used !== null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return (
    <Panel
      title="Session"
      aside={
        <span className="flex items-center gap-2">
          <span className={connected ? "text-desk-teal" : "text-desk-ember"}>
            {connected ? "live" : "offline"}
          </span>
          <button
            type="button"
            onClick={() => reset()}
            className="rounded border border-desk-line px-1.5 py-0.5 text-[10px] normal-case tracking-normal text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
            title="Close this session and pick another project"
          >
            change
          </button>
        </span>
      }
      className="shrink-0"
    >
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-2xl tracking-tight text-desk-ink">DAZE</span>
        <span className="font-mono text-xs text-desk-dim">{formatClock(Date.now())}</span>
      </div>
      {session.degraded ? (
        <div className="mt-2 rounded border border-desk-ember/50 bg-desk-ember/10 px-2 py-1 text-[11px] text-desk-ember">
          Pi unavailable — running the mock runtime.
        </div>
      ) : null}

      <dl className="mt-4 space-y-3">
        <Field label="session" value={session.id} mono />
        <Field label="project" value={session.projectPath} mono title={session.projectPath} />
        <Field label="model" value={session.model ?? "—"} />
        <Field label="runtime" value={session.agentRuntime} />
        <div>
          <div className="label">context</div>
          <div className="mt-1 flex items-center gap-2">
            <span className="font-mono text-xs text-desk-ink">{formatContext(used, total)}</span>
          </div>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-desk-panel2">
            <div
              className="h-full rounded-full bg-gradient-to-r from-desk-teal to-desk-amber transition-all duration-500"
              style={{ width: `${percent}%` }}
            />
          </div>
          {used !== null && total ? (
            <div className="mt-1 text-right font-mono text-[10px] text-desk-dim">
              {formatTokens(used)} used
            </div>
          ) : null}
        </div>
      </dl>
    </Panel>
  );
}

function Field({ label, value, mono, title }: { label: string; value: string; mono?: boolean; title?: string }) {
  return (
    <div>
      <div className="label">{label}</div>
      <div
        className={["mt-0.5 truncate", mono ? "font-mono text-xs" : "text-sm", "text-desk-ink"].join(" ")}
        title={title ?? value}
      >
        {value}
      </div>
    </div>
  );
}
