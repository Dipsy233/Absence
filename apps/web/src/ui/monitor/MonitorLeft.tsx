import { useEffect, useMemo, useRef, useState } from "react";
import { RunSummary } from "@absence/core";
import { formatClock, formatOffset } from "../../lib/format";
import { useRunsStore } from "../../stores/runsStore";
import { useUiStore } from "../../stores/uiStore";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { FilePanel } from "../../components/files/FilePanel";
import type { ActivityRow } from "../../types/stage";
import {
  Chip,
  Dot,
  TONE_FOR_ROW,
  attentionTone,
  phaseForRow,
  phaseIntent,
  phaseWord,
  type MonPhase,
  type MonTone,
} from "./atoms";
import type { MonitorData } from "./useMonitorData";

const STATUS_TONE: Record<RunSummary["status"], MonTone> = {
  running: "run",
  completed: "edit",
  interrupted: "mute",
  error: "err",
};

const STATUS_WORD: Record<RunSummary["status"], string> = {
  running: "running",
  completed: "done",
  interrupted: "stopped",
  error: "error",
};

/**
 * Left column: the run selector, then the selected run's actions as a feed.
 *
 * The feed is the whole of what the agent did, in order, with phase headers
 * where the observer's phase changed — the "机器监护" reading: everything the
 * machine sees, no avatar, no prose. Clicking a row puts that moment on the
 * Stage; clicking the one already on the Stage returns to the default page.
 */
/** The run block the header states: who is driving, which run, how it stands. */
export interface RunHead {
  runtime?: string;
  elapsed: string;
  tone: MonTone;
  title: string;
  observed: boolean;
  connected: boolean;
}

export function MonitorLeft({
  data,
  onOpen,
  onSelectRun,
  run: head,
}: {
  data: MonitorData;
  onOpen: (row: ActivityRow) => void;
  onSelectRun: (id?: string) => void;
  run: RunHead;
}) {
  const t = useT();
  const runs = useRunsStore((s) => s.runs);
  const loadRuns = useRunsStore((s) => s.loadRuns);
  const sessionId = useSessionStore((s) => s.session?.id);
  const activeEventId = useStageStore((s) => s.activeItem?.source?.eventId);
  const following = useStageStore((s) => s.following);
  const focusedEventId = useUiStore((s) => s.focusedEventId);
  const observed = useIsObserved();

  const [menuOpen, setMenuOpen] = useState(false);
  /** Activity (what the agent did) or Files (the whole project, your view). */
  const [view, setView] = useState<"activity" | "files">("activity");
  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // A snapshot carries the run list, but a resumed session can mount before it
  // arrives; one fetch per session is enough and a zero-run session is not a
  // reason to loop.
  const requested = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!sessionId || requested.current === sessionId) return;
    requested.current = sessionId;
    if (runs.length === 0) void loadRuns(sessionId);
  }, [sessionId, runs.length, loadRuns]);

  useEffect(() => {
    const element = feedRef.current;
    if (!element) return;
    const onScroll = () => {
      stickToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 40;
    };
    element.addEventListener("scroll", onScroll, { passive: true });
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  // A new row follows the bottom only while the reader was already there.
  useEffect(() => {
    const element = feedRef.current;
    if (element && stickToBottom.current) element.scrollTop = element.scrollHeight;
  }, [data.rows.length, data.run?.id]);

  // A focused row (from anywhere in the face) is scrolled into view.
  useEffect(() => {
    if (!focusedEventId) return;
    const element = feedRef.current?.querySelector<HTMLElement>(`[data-event="${CSS.escape(focusedEventId)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [focusedEventId, data.rows]);

  /**
   * The feed as drawn: rows grouped under the phase that was current when they
   * happened, with consecutive repeats folded.
   *
   * A `process` event is a state update, not an act: one long-lived command
   * re-reports every time its child count moves, which put fourteen identical
   * RUN rows in a row. Folding happens here rather than in the row builder so
   * Activity's own list (and the report) keep every event — only this reading
   * of them is compressed, and the count says so.
   */
  const groups = useMemo(() => {
    type Feed = { row: ActivityRow; count: number };
    const out: Array<{ id: string; phase?: MonPhase; rows: Feed[] }> = [];
    for (const row of data.rows) {
      // The kind comes from the row itself (see `phaseForRow`), so a divider
      // only appears where the kind of work actually changes — and a shell row
      // can never be filed under "reading files".
      const phase = phaseForRow(row);
      let group = out[out.length - 1];
      if (phase && group?.phase !== phase) {
        group = { id: `p_${row.id}`, phase, rows: [] };
        out.push(group);
      } else if (!group) {
        group = { id: `h_${row.id}`, rows: [] };
        out.push(group);
      }
      // Fold only *state re-reports of one thing*: the same action, the same
      // subject, the same stage card. Required because a `process` event is an
      // update (the child count moves), not a new act. The Stage item id is part
      // of the key so two different `npm test` runs are never merged, and
      // RUN vs EXIT stay separate — they are the same command's two ends, and
      // collapsing them would lose the fact that it finished.
      const previous = group.rows[group.rows.length - 1];
      if (
        previous &&
        previous.row.action === row.action &&
        previous.row.primary === row.primary &&
        previous.row.stageItem?.id === row.stageItem?.id
      ) {
        previous.row = row;
        previous.count += 1;
        continue;
      }
      group.rows.push({ row, count: 1 });
    }
    return out;
  }, [data.rows]);

  /**
   * The run's two boundaries, pinned above and below the scrolling feed.
   *
   * They are the only rows that answer "where does this start and end", and
   * scrolling a long run used to lose both — you could not tell whether you
   * were looking at the first activity or the four-hundredth. They are taken
   * out of the stream (the fold above skips them) so they cannot appear twice.
   */
  const startRow = data.rows.find((row) => row.action === "START");
  const endRow = [...data.rows].reverse().find((row) => row.action === "END");
  const bodyRows = useMemo(
    () =>
      groups
        .map((group) => ({
          ...group,
          rows: group.rows.filter(({ row }) => row.action !== "START" && row.action !== "END"),
        }))
        .filter((group) => group.rows.length > 0),
    [groups],
  );

  const run = data.run;
  /**
   * What the feed actually shows: rows plus the repeats they fold. The plain
   * row count would read as "16 activities" next to a run the server says has
   * 40 — a fold that hides 24 events has to say so, or the number lies.
   */
  const shownCount = groups.reduce(
    (total, group) => total + group.rows.reduce((sum, entry) => sum + entry.count, 0),
    0,
  );

  return (
    <div className="mon-col mon-col--left">
      <div className="mon-lefthead">
        {/* Which runtime is driving, which run, how it stands, how long it has
            been going — stated here because this is the column the run is read
            in. One unit: "#1 done" without "pi" or "00:01:23" is a fragment. */}
        <div className="mon-runblock" title={head.title}>
          {head.runtime ? <span className="mon-runblock__runtime mon-mono">{head.runtime}</span> : null}
          <span className="mon-runblock__sep" aria-hidden />
          <Chip tone={head.tone}>
            <Dot tone={head.tone} />
            {run ? `${t("Run")} #${run.index} · ${t(STATUS_WORD[run.status])}` : t("no run")}
          </Chip>
          <span className="mon-runblock__time mon-mono">{head.elapsed}</span>
          {head.observed ? <Chip tone="read">{t("OBSERVING")}</Chip> : null}
          {head.connected ? null : (
            <Chip tone="err">
              <Dot tone="err" />
              {t("offline")}
            </Chip>
          )}
        </div>

        {/* Two views of one column: what the agent did, and the project it did
            it to. The right rail is the *agent's* files, so the project tree
            has to live here or the user cannot reach it at all. */}
        <div className="mon-seg" role="tablist" aria-label={t("Left panel")}>
          <button
            type="button"
            role="tab"
            aria-selected={view === "activity"}
            data-on={view === "activity" ? "true" : undefined}
            onClick={() => setView("activity")}
          >
            {t("Activity")}
            <em>{data.rows.length}</em>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={view === "files"}
            data-on={view === "files" ? "true" : undefined}
            onClick={() => setView("files")}
          >
            {t("Files")}
            <em>{t("{n} seen", { n: data.facts?.files.read.length ?? 0 })}</em>
          </button>
        </div>

        <div style={{ position: "relative" }}>
          <button
            type="button"
            className="mon-runsel"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            title={runs.length > 1 ? t("Switch run") : t("The run Activity is showing")}
          >
            <Dot tone={run ? STATUS_TONE[run.status] : "mute"} />
            <span className="mon-runsel__q">
              {run ? `#${run.index} ${run.prompt || t("(observed activity)")}` : t("No run yet")}
            </span>
            <span className="mon-runsel__c">
              {run ? `R${run.counts.read} S${run.counts.search} E${run.counts.edit} $${run.counts.run}` : "—"}
            </span>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" />
            </svg>
          </button>

          {menuOpen ? (
            <ul
              className="mon-nodrag"
              style={{
                position: "absolute",
                zIndex: 20,
                top: "calc(100% + 4px)",
                left: 0,
                right: 0,
                maxHeight: 260,
                overflowY: "auto",
                padding: 4,
                border: "1px solid var(--mon-bd2)",
                borderRadius: 8,
                background: "var(--mon-s2)",
                boxShadow: "0 12px 30px rgba(0,0,0,.5)",
              }}
            >
              {[...runs].reverse().map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onSelectRun(entry.id);
                      setMenuOpen(false);
                    }}
                    style={{
                      display: "block",
                      width: "100%",
                      padding: "6px 8px",
                      border: 0,
                      borderRadius: 6,
                      background: entry.id === run?.id ? "var(--mon-s3)" : "transparent",
                      textAlign: "left",
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <Dot tone={STATUS_TONE[entry.status]} />
                      <span className="mon-mono" style={{ fontSize: 11, color: "var(--mon-t3)" }}>
                        #{entry.index}
                      </span>
                      <span className="mon-mono" style={{ marginLeft: "auto", fontSize: 11, color: "var(--mon-t3)" }}>
                        {formatClock(entry.startedAt)}
                      </span>
                    </span>
                    <span
                      style={{
                        display: "block",
                        marginTop: 2,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontSize: 12,
                        color: "var(--mon-t2)",
                      }}
                    >
                      {entry.prompt || t("(observed activity)")}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {view === "files" ? (
        <div className="mon-feed" style={{ padding: 8 }}>
          <FilePanel />
        </div>
      ) : (
      <>
      {startRow ? (
        <div className="mon-anchor">
          <FeedRow row={startRow} runStart={run?.startedAt} anchor focusEventId={focusedEventId} />
        </div>
      ) : null}

      <div className="mon-feed" ref={feedRef}>
        {data.loading && data.rows.length === 0 ? (
          <p className="mon-empty">{t("loading…")}</p>
        ) : data.rows.length === 0 ? (
          <p className="mon-empty">
            {observed
              ? t("Nothing yet. An observed agent's processes and file changes appear here as they happen.")
              : t("Nothing yet. Send the agent a task.")}
          </p>
        ) : (
          bodyRows.map((group) => (
            <div key={group.id}>
              {group.phase ? (
                // No colour, no accent: a divider separates two kinds of work,
                // it is not a status. The intent words are what make it useful
                // ("Investigating · reading files"), so the reader never has to
                // guess what the phase name means.
                <div className="mon-phase">
                  <span className="mon-phase__name">{t(phaseWord(group.phase))}</span>
                  <span className="mon-phase__intent">{t(phaseIntent(group.phase))}</span>
                </div>
              ) : null}
              {group.rows.map(({ row, count }) => (
                <FeedRow
                  key={row.id}
                  row={row}
                  count={count}
                  runStart={run?.startedAt}
                  current={!following && row.stageItem?.source?.eventId === activeEventId}
                  focused={row.id === focusedEventId}
                  onOpen={onOpen}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {endRow ? (
        <div className="mon-anchor">
          <FeedRow row={endRow} runStart={run?.startedAt} anchor focusEventId={focusedEventId} />
        </div>
      ) : null}
      </>
      )}

      <div
        className="mon-fold"
        style={{ borderTop: "1px solid var(--mon-bd)", display: "flex", gap: 8, alignItems: "center" }}
      >
        <Chip tone={run ? STATUS_TONE[run.status] : "mute"}>{run ? t(STATUS_WORD[run.status]) : t("idle")}</Chip>
        <span className="mon-mono" style={{ fontSize: 11 }}>
          {head.elapsed}
        </span>
        {run?.partial ? <span style={{ fontSize: 11 }}>{t("partial")}</span> : null}
        <span style={{ marginLeft: "auto", fontSize: 11 }}>
          {t("{n} activities", { n: shownCount })}
        </span>
      </div>
    </div>
  );
}

function FeedRow({
  row,
  runStart,
  count = 1,
  current,
  focused,
  focusEventId,
  anchor = false,
  onOpen,
}: {
  row: ActivityRow;
  /** The run's start: every row is stamped relative to it, so a long run does
   *  not read as a wall clock spanning hours. */
  runStart?: number;
  /** How many consecutive identical actions this row stands for (≥1). */
  count?: number;
  current?: boolean;
  /** Explicit focus, for the anchored strips (which have no `onOpen`). */
  focusEventId?: string;
  /** Pinned to the top/bottom of the feed rather than scrolling with it. */
  anchor?: boolean;
  focused?: boolean;
  onOpen?: (row: ActivityRow) => void;
}) {
  const t = useT();
  const tone = TONE_FOR_ROW[row.tone];
  const openable = row.stageItem !== undefined;
  return (
    <button
      type="button"
      className={anchor ? "mon-ev mon-ev--anchor" : "mon-ev"}
      data-event={row.id}
      data-selected={current || focused || focusEventId === row.id ? "true" : undefined}
      data-dim={!anchor && !openable ? "true" : undefined}
      onClick={() => openable && onOpen?.(row)}
      title={openable ? row.primary : `${row.action} · ${row.primary}`}
      aria-current={current ? "true" : undefined}
    >
      <Chip tone={tone} className="mon-ev__tag" title={count > 1 ? t("{n} updates, shown as one", { n: count }) : undefined}>
        {row.action}
        {count > 1 ? <span style={{ opacity: 0.75 }}>×{count}</span> : null}
      </Chip>
      <span
        className={["mon-ev__primary", tone === "think" || row.tone === "lifecycle" ? "mon-ev__primary--text" : ""].join(" ")}
      >
        {row.primary}
      </span>
      <span className="mon-ev__times">
        <span className="mon-ev__rel">
          {runStart !== undefined ? formatOffset(row.event.timestamp - runStart) : "—"}
        </span>
        {/* The wall clock, right under the offset: "00:06 into the run" answers
         *  "how long did this take", "14:32:07" answers "when was this". Both
         *  questions get asked of the same row. */}
        <span className="mon-ev__clock">{formatClock(row.event.timestamp)}</span>
      </span>
      {row.secondary ? <span className="mon-ev__meta">{row.secondary}</span> : null}
    </button>
  );
}
