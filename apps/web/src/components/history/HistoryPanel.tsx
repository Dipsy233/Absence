import { useEffect, useRef } from "react";
import type { RunSummary } from "@absence/core";
import { formatClock, formatOffset } from "../../lib/format";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useRunsStore } from "../../stores/runsStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import { Panel } from "../Panel";

const STATUS_LABEL: Record<RunSummary["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};

const STATUS_CLASS: Record<RunSummary["status"], string> = {
  running: "text-desk-amber",
  completed: "text-desk-teal",
  interrupted: "text-desk-dim",
  error: "text-desk-ember",
};

/**
 * Left rail, middle: one row per run — prompt to completion/interruption.
 * Oldest first with the newest at the bottom, like a log.
 *
 * The rows come from the server's run index, not from the live event window.
 * That is what lets History show every run in the session without loading the
 * events: selecting one fetches only that run's Activity.
 */
export function HistoryPanel() {
  const t = useT();
  const sessionId = useSessionStore((s) => s.session?.id);
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const observed = useIsObserved();
  const runs = useRunsStore((s) => s.runs);
  const loading = useRunsStore((s) => s.loading);
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const requestedFor = useRef<string | undefined>(undefined);

  // A snapshot carries the run list, but a direct start/resume can mount this
  // panel before the socket snapshot arrives. Fetch once per session; a zero-run
  // session must not trigger an endless loading loop.
  useEffect(() => {
    if (!sessionId || requestedFor.current === sessionId) return;
    requestedFor.current = sessionId;
    if (runs.length === 0) void loadRuns(sessionId);
  }, [sessionId, runs.length, loadRuns]);

  // Follow new runs only while the user is at the bottom; reading an older run
  // must not be interrupted by the next one.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const onScroll = () => {
      stickToBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const element = bodyRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [runs.length]);

  return (
    <Panel
      title={t("History")}
      aside={t("{n} runs", { n: runs.length })}
      className="min-h-0 flex-1"
      bodyClassName="p-2"
      bodyRef={bodyRef}
    >
      {runs.length === 0 ? (
        <p className="text-xs text-desk-dim">
          {loading
            ? t("loading…")
            : observed
              ? t("No runs yet. A run starts when the observed agent does.")
              : t("No runs yet. Send the agent a task.")}
        </p>
      ) : (
        <ul className="space-y-1">
          {runs.map((run) => {
            const active = run.id === selectedRunId;
            const duration = (run.endedAt ?? Date.now()) - run.startedAt;
            return (
              <li key={run.id}>
                <div
                  className={[
                    "flex items-center rounded border",
                    active
                      ? "border-desk-amber/60 bg-desk-amber/10"
                      : "border-transparent hover:border-desk-line hover:bg-desk-panel2",
                  ].join(" ")}
                >
                  <button
                    type="button"
                    onClick={() => selectRun(run.id)}
                    className="min-w-0 flex-1 px-2 py-1.5 text-left"
                  >
                    <div className="flex items-baseline gap-2 font-mono text-[11px]">
                      <span className={active ? "text-desk-amber" : "text-desk-dim"}>#{run.index}</span>
                      <span className="text-desk-dim/70">{formatClock(run.startedAt)}</span>
                      <span className={STATUS_CLASS[run.status]}>{t(STATUS_LABEL[run.status])}</span>
                      {run.partial ? (
                        <span
                          className="text-desk-dim/70"
                          title={t(
                            "The beginning of this run is no longer in the live event window — its counts and the Stage cover only what is still loaded.",
                          )}
                        >
                          {t("partial")}
                        </span>
                      ) : null}
                      <span className="ml-auto text-desk-dim/70">{formatOffset(duration)}</span>
                    </div>
                    <div className="mt-0.5 truncate text-[11px] text-desk-ink/85" title={run.prompt}>
                      {run.prompt}
                    </div>
                    <div className="mt-0.5 flex gap-2 font-mono text-[10px] text-desk-dim">
                      <span title={t("files read")}>R{run.counts.read}</span>
                      <span title={t("searches")}>S{run.counts.search}</span>
                      <span title={t("files edited")}>E{run.counts.edit}</span>
                      <span title={t("files created")}>C{run.counts.created}</span>
                      <span title={t("commands run")}>$ {run.counts.run}</span>
                    </div>
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
