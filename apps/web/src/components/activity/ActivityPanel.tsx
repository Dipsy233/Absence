import { useEffect, useMemo, useRef, useState } from "react";
import { memoBuildHistory, memoRunRows, pickRun, runEvents } from "../../lib/history";
import { useEvents, useSessionStore } from "../../stores/sessionStore";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved } from "../../stores/sessionStore";
import { useReplayStore } from "../../stores/replayStore";
import { useUiStore } from "../../stores/uiStore";
import { useSettingsStore } from "../../stores/settingsStore";
import { useT } from "../../lib/i18n";
import { Panel } from "../Panel";
import { ACTIVITY_ROW_HEIGHT, ActivityItem } from "./ActivityItem";

/** How many rows to render beyond the viewport, so fast scrolling is not blank. */
const OVERSCAN = 8;
/** Fallback viewport height before the first ResizeObserver callback. */
const INITIAL_VIEWPORT = 600;

/** Bottom-left: the actions of the selected run, with a Replay button. */
export function ActivityPanel() {
  const t = useT();
  const events = useEvents();
  const selectedRunId = useUiStore((s) => s.selectedRunId);
  const focusedEventId = useUiStore((s) => s.focusedEventId);
  const selectRun = useUiStore((s) => s.selectRun);
  const mode = useStageStore((s) => s.mode);
  const setMode = useStageStore((s) => s.setMode);
  const load = useReplayStore((s) => s.load);
  const replayTime = useReplayStore((s) => s.currentTime);
  const displaySetting = useSettingsStore((s) => s.displayInActivity);
  // An observed agent has no tool events: its processes *are* what it is doing,
  // so the setting that hides process rows cannot hide the only rows this
  // session has. Driving a runtime keeps the setting exactly as the user set it.
  const observed = useIsObserved();
  const displayInActivity = displaySetting || observed;
  const bodyRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: INITIAL_VIEWPORT });
  const stickToBottom = useRef(true);
  const lastRunId = useRef<string | undefined>(undefined);

  const runs = useMemo(() => memoBuildHistory(events), [events]);
  const run = pickRun(runs, selectedRunId);
  // Rows are maintained incrementally (see `memoRunRows`): a streamed token
  // converts one event, not the whole run.
  const rows = useMemo(
    () => (run ? memoRunRows(events, run, displayInActivity) : []),
    [events, run, displayInActivity],
  );

  // In replay the "current" row is the last one the cursor has passed: the
  // Stage is showing that event's content, so it is the row the panel should
  // mark. Computed here rather than in the row, because only the panel knows
  // which of the rows is last. `rows` is chronological, so the first row past
  // the cursor ends the scan.
  const replayRowId = useMemo(() => {
    if (mode !== "replay" || rows.length === 0) return undefined;
    // Rows are chronological; binary search for the last one at or before the
    // cursor instead of walking the whole run on every 80ms replay tick.
    let low = 0;
    let high = rows.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (rows[mid]!.event.timestamp <= replayTime) {
        found = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    return found >= 0 ? rows[found]!.id : undefined;
  }, [mode, rows, replayTime]);

  // Track the scroll container: the list renders only the rows around it.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    const update = () => {
      stickToBottom.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      setViewport({ scrollTop: element.scrollTop, height: element.clientHeight });
    };
    update();
    element.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => {
      element.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  // Follow new rows only when the user was already at the bottom; scrolling up
  // to read something must not be yanked away by the next token. Switching runs
  // starts at that run's newest row.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element) return;
    if (lastRunId.current !== run?.id) {
      lastRunId.current = run?.id;
      stickToBottom.current = true;
    }
    if (!stickToBottom.current) return;
    const frame = requestAnimationFrame(() => {
      element.scrollTop = element.scrollHeight;
      setViewport((current) => ({ ...current, scrollTop: element.scrollTop }));
    });
    return () => cancelAnimationFrame(frame);
  }, [rows.length, run?.id]);

  // A report link can target a row outside the mounted window; bring it in.
  useEffect(() => {
    if (!focusedEventId) return;
    const index = rows.findIndex((row) => row.id === focusedEventId);
    const element = bodyRef.current;
    if (index < 0 || !element) return;
    const top = index * ACTIVITY_ROW_HEIGHT;
    if (top < element.scrollTop || top + ACTIVITY_ROW_HEIGHT > element.scrollTop + element.clientHeight) {
      stickToBottom.current = false;
      element.scrollTop = Math.max(0, top - element.clientHeight / 2);
    }
  }, [focusedEventId, rows]);

  const totalHeight = rows.length * ACTIVITY_ROW_HEIGHT;
  // Clamp the window to the list: switching to a shorter run while scrolled
  // down must still render a row instead of an empty slice.
  const maxStart = Math.max(0, rows.length - 1);
  const start = Math.min(
    maxStart,
    Math.max(0, Math.floor(viewport.scrollTop / ACTIVITY_ROW_HEIGHT) - OVERSCAN),
  );
  const visibleCount = Math.ceil(viewport.height / ACTIVITY_ROW_HEIGHT) + OVERSCAN * 2;
  const end = Math.min(rows.length, start + visibleCount);
  const visibleRows = rows.slice(start, end);

  const enterReplay = () => {
    if (!run || rows.length === 0) return;
    // Pin the selection to the run being replayed so the report summarises the
    // same run instead of falling back to the newest one.
    selectRun(run.id);
    load(runEvents(events, run), { label: `#${run.index} · ${run.prompt}` });
    setMode("replay");
  };

  return (
    <Panel
      title={t("Activity")}
      aside={
        <span className="flex items-center gap-2">
          <span>{rows.length}</span>
          <button
            type="button"
            onClick={enterReplay}
            disabled={!run || rows.length === 0}
            className={[
              "rounded border px-1.5 py-0.5 text-[10px] normal-case tracking-normal",
              mode === "replay"
                ? "border-desk-amber/60 text-desk-amber"
                : "border-desk-line text-desk-dim enabled:hover:border-desk-amber/60 enabled:hover:text-desk-amber",
              "disabled:opacity-40",
            ].join(" ")}
            title={run ? t("Replay run #{index}", { index: run.index }) : t("Nothing to replay")}
          >
            {t("▶ replay")}
          </button>
        </span>
      }
      className="min-h-0 flex-1"
      bodyClassName="p-2"
      bodyRef={bodyRef}
    >
      {run ? (
        <div className="mb-1.5 flex items-baseline gap-2 border-b border-desk-line pb-1 text-[10px] text-desk-dim">
          <span className="font-mono">{t("run #{index}", { index: run.index })}</span>
          <span className="truncate" title={run.prompt}>
            {run.prompt}
          </span>
        </div>
      ) : null}

      {rows.length === 0 ? (
        <p className="text-xs text-desk-dim">
          {observed
            ? t("Nothing yet. An observed agent's processes and file changes appear here as they happen.")
            : t("Nothing yet. Send the agent a task.")}
        </p>
      ) : (
        <ul className="relative" style={{ height: totalHeight }}>
          {visibleRows.map((row, index) => (
            <ActivityItem
              key={row.id}
              row={row}
              replayCurrent={row.id === replayRowId}
              top={(start + index) * ACTIVITY_ROW_HEIGHT}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}
