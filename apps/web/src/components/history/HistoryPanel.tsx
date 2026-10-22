import { useEffect, useMemo, useRef } from "react";
import type { HistoryRun } from "../../types/history";
import { memoBuildHistory, runEvents } from "../../lib/history";
import { formatClock, formatOffset } from "../../lib/format";
import { useEvents, useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import { Panel } from "../Panel";

const STATUS_LABEL: Record<HistoryRun["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};

const STATUS_CLASS: Record<HistoryRun["status"], string> = {
  running: "text-desk-amber",
  completed: "text-desk-teal",
  interrupted: "text-desk-dim",
  error: "text-desk-ember",
};

/**
 * Left rail, middle: one row per run — prompt to completion/interruption.
 * Oldest first with the newest at the bottom, like a log.
 */
export function HistoryPanel() {
  const t = useT();
  const events = useEvents();
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const selectRun = useUiStore((s) => s.selectRun);
  const load = useReplayStore((s) => s.load);
  const observed = useIsObserved();
  const eventsHasMore = useSessionStore((s) => s.eventsHasMore);
  const loadingOlder = useSessionStore((s) => s.loadingOlder);
  const loadOlderEvents = useSessionStore((s) => s.loadOlderEvents);
  const bodyRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  const runs = useMemo(() => memoBuildHistory(events), [events]);

  /**
   * Run ids are positional (`run_1`, `run_2`, …), so prepending older runs
   * renumbers them. Keep the user's selection on the same run by matching its
   * opening time and prompt after the merge.
   */
  const loadOlder = async () => {
    const selected = runs.find((run) => run.id === selectedRunId);
    stickToBottom.current = false;
    await loadOlderEvents();
    if (!selected) return;
    const next = memoBuildHistory(useSessionStore.getState().events);
    const match = next.find(
      (run) => run.startedAt === selected.startedAt && run.prompt === selected.prompt,
    );
    if (match) selectRun(match.id);
  };

  // Follow new runs only while the user is at the bottom. Loading older runs
  // must not yank the list back to the newest one.
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
      {eventsHasMore ? (
        <button
          type="button"
          onClick={() => void loadOlder()}
          disabled={loadingOlder}
          className="mb-1.5 w-full rounded border border-desk-line px-2 py-1 text-[10px] uppercase tracking-wide text-desk-dim enabled:hover:border-desk-amber/60 enabled:hover:text-desk-amber disabled:opacity-40"
        >
          {loadingOlder ? t("loading…") : t("load older")}
        </button>
      ) : null}

      {runs.length === 0 ? (
        <p className="text-xs text-desk-dim">
          {observed
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
                        // The run's first events were trimmed out of the live
                        // window. The row stays (History is a log) and says so,
                        // rather than showing partial counts as the whole.
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
