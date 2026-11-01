import { useEffect, useMemo, useRef, useState } from "react";
import { formatClock, formatOffset } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useRunsStore } from "../../stores/runsStore";
import { useUiStore } from "../../stores/uiStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { FilePanel } from "../../components/files/FilePanel";
import { AttentionList } from "../../components/attention/AttentionNotice";
import { attentionRecords, type AttentionNotice } from "../../hooks/useAttentionNotices";
import { useAttentionOptions } from "../../hooks/useAttentionOptions";
import { useChatStore } from "../../stores/chatStore";
import { eventContext } from "../../lib/context";
import { Nixie } from "../shared/Nixie";
import { feedAnchors, groupFeedRows, replayRowAt, stripFeedAnchors } from "../../lib/history";
import type { ActivityRow } from "../../types/stage";
import {
  Chip,
  Dot,
  RUN_TONE,
  RUN_WORD,
  TONE_FOR_ROW,
  phaseIntent,
  phaseWord,
  type MonTone,
} from "../shared/atoms";
import type { MonitorData } from "../../hooks/useMonitorData";
import { useRideScroll } from "../shared/rideScroll";


/**
 * Left column: the run selector, then the selected run's actions as a feed.
 *
 * The feed is the whole of what the agent did, in order, with phase headers
 * where the observer's phase changed — the "机器监护" reading: everything the
 * machine sees, no avatar, no prose. Clicking a row puts that moment on the
 * Stage; clicking the one already on the Stage returns to the default page.
 */
export function MonitorLeft({
  data,
  onOpen,
  onSelectRun,
}: {
  data: MonitorData;
  onOpen: (row: ActivityRow) => void;
  onSelectRun: (id?: string) => void;
}) {
  const t = useT();
  const runs = useRunsStore((s) => s.runs);
  const sessionId = useSessionStore((s) => s.session?.id);
  const activeEventId = useStageStore((s) => s.activeItem?.source?.eventId);
  const following = useStageStore((s) => s.following);
  /**
   * While following, the row the Stage is showing is the one behind
   * `currentAction` — the agent's *current* action, not the newest row of the
   * feed. Once the agent speaks or the run ends, `clearsStage` empties it and
   * the Stage rests on a page, so this highlight disappears with it. A feed
   * tail could never do that: the last row of a finished run is still a row.
   */
  const liveEventId = following ? data.liveEventId : undefined;

  /**
   * In replay the highlighted row is the one the cursor has passed — the
   * activity the Stage is showing right now — not a pinned item (replay pins
   * its own view) and not the live tail. This is the replay highlight's rule,
   * and it is why the feed's highlight
   * walks down the run while a replay plays.
   *
   * Rows are chronological, so the answer is the last row at or before the
   * cursor; a binary search keeps it cheap on the 80ms replay tick.
   */
  const stageMode = useStageStore((s) => s.mode);
  const replayTime = useReplayStore((s) => s.currentTime);
  const replayRowId = useMemo(() => {
    if (stageMode !== "replay") return undefined;
    // The shared binary scan (lib/history): the last row at or before the cursor.
    return replayRowAt(data.rows, replayTime)?.id;
  }, [stageMode, data.rows, data.rowsVersion, replayTime]);
  const focusedEventId = useUiStore((s) => s.focusedEventId);
  const focusEvent = useUiStore((s) => s.focusEvent);
  const observed = useIsObserved();

  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  /**
   * A dropdown that only closes when you pick something is a trap: the usual
   * ways out — click elsewhere, press Esc — are what ContextMenu already
   * honours, so this one does too.
   */
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [menuOpen]);
  /** Activity (what the agent did), Files (the project itself), Attention (what needs a human). */
  const [view, setView] = useState<"activity" | "files" | "attention">("activity");
  const attentionOptions = useAttentionOptions();
  /**
   * Read the run's attention the way Activity is read: from the persisted run,
   * not from what happened to arrive while this page was open — so a historical
   * run still lists what it needed a human for. The popup cards (Rounds) are the
   * only thing that reacts to a reason being *new*.
   */
  const notices = useMemo(
    () => attentionRecords(data.attention, data.facts, data.rows, attentionOptions),
    [data.attention, data.facts, data.rows, data.rowsVersion, attentionOptions],
  );
  const feedRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  /* The one border-riding scrollbar for now — the Activity feed's thumb
     sits on the divider between this column and the Stage. */
  useRideScroll("right", feedRef);
  const filesFeedRef = useRideScroll<HTMLDivElement>();
  const attentionFeedRef = useRideScroll<HTMLDivElement>();

  // A snapshot carries the run list, but a resumed session can mount before it
  // arrives. The guarded fetch lives in the store (`ensureLoaded`) — idempotent
  // per session, so the effect can just follow the session id.
  const ensureLoaded = useRunsStore((s) => s.ensureLoaded);
  useEffect(() => {
    ensureLoaded(sessionId);
  }, [sessionId, ensureLoaded]);

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
  }, [focusedEventId, data.rows, view]);

  /**
   * In replay the highlighted row must stay on screen as the cursor walks down
   * the run — that is the whole point of the highlight. A virtualised list
   * would get this by scrolling to the cursor; the feed is a plain
   * scroll container, so it scrolls itself. `block: "nearest"` means a row
   * already in view is not moved, so this does not fight a reader who scrolled
   * to read around the cursor.
   *
   * It also stops the feed's own "stick to the bottom" behaviour from dragging
   * the reader away from the cursor on the next streamed event.
   */
  useEffect(() => {
    if (!replayRowId) return;
    const element = feedRef.current?.querySelector<HTMLElement>(`[data-event="${CSS.escape(replayRowId)}"]`);
    element?.scrollIntoView({ block: "nearest" });
  }, [replayRowId]);

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
  // The grouping, the fold and the anchors are lib/history derivations now —
  // one reading view, not rules painted into this component. `rowsVersion`,
  // not `data.rows`, is the dependency: the array is the same object across
  // updates (see `memoRunRows`), so depending on it froze the feed at its
  // first render and every activity appeared only when the run ended.
  const groups = useMemo(() => groupFeedRows(data.rows), [data.rows, data.rowsVersion]);
  const anchors = useMemo(() => feedAnchors(data.rows), [data.rows, data.rowsVersion]);
  const bodyRows = useMemo(() => stripFeedAnchors(groups), [groups]);

  /**
   * The run's two boundaries, pinned above and below the scrolling feed.
   *
   * They are the only rows that answer "where does this start and end", and
   * scrolling a long run used to lose both — you could not tell whether you
   * were looking at the first activity or the four-hundredth. They are taken
   * out of the stream (the fold above skips them) so they cannot appear twice.
   */
  const { start: startRow, end: endRow } = anchors;

  const run = data.run;
  // A live run's duration has to move when nothing else changes, so this
  // component keeps its own second hand instead of riding on event renders.
  const now = useNow(1000);
  const elapsed = run ? formatOffset((run.endedAt ?? now) - run.startedAt) : "—";
  /**
   * What the feed actually shows: rows plus the repeats they fold, without the
   * two anchors. START and END are pinned above and below the feed, out of the
   * stream, so counting them here would promise an activity the list does not
   * have — and disagree with the Activity tab's count of real rows.
   */
  const shownCount = bodyRows.reduce(
    (total, group) => total + group.rows.reduce((sum, entry) => sum + entry.count, 0),
    0,
  );

  /**
   * A notice click: its event on the Stage, and the feed scrolled to that row.
   * It leaves the Attention tab first, because the thing the notice points at
   * lives in Activity — a jump that stayed in the list would not be a jump.
   */
  const openNotice = (notice: AttentionNotice) => {
    if (!notice.eventId) return;
    setView("activity");
    focusEvent(notice.eventId);
    const row = data.rows.find((entry) => entry.id === notice.eventId);
    if (row?.stageItem) onOpen(row);
  };

  return (
    <div className="mon-col mon-col--left">
      <div className="mon-lefthead">
        {/* Three views of one column: what the agent did, the project it did it
            to, and what it is asking a human to look at. The right rail is the
            *agent's* files, so the project tree has to live here or the user
            cannot reach it at all. */}
        <div className="mon-seg mon-seg--fill" role="tablist" aria-label={t("Left panel")}>
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
          <button
            type="button"
            role="tab"
            aria-selected={view === "attention"}
            data-on={view === "attention" ? "true" : undefined}
            onClick={() => setView("attention")}
            title={t("What the run needs a human for")}
          >
            {t("Attention")}
            <em>{notices.length}</em>
          </button>
        </div>

        <div className="mon-runselwrap" ref={menuRef}>
          <button
            type="button"
            className="mon-runsel"
            onClick={() => setMenuOpen((open) => !open)}
            aria-expanded={menuOpen}
            title={runs.length > 1 ? t("Switch run") : t("The run Activity is showing")}
          >
            <Dot tone={run ? RUN_TONE[run.status] : "mute"} />
            <span className="mon-runsel__q">
              {/* The run's state lives here, not in the rail's agent head: this
                  is where the reader picks between rounds, so this is where
                  "which round, how did it end" is answered. */}
              {run ? `#${run.index} · ${t(RUN_WORD[run.status])} — ${run.prompt || t("(observed activity)")}` : t("No run yet")}
            </span>
            <span className="mon-runsel__c">
              {/* The count line arrives rather than changes: the live run's
                  numbers scramble in place for half a second, then land. */}
              {run ? (
                <Nixie
                  value={`R${run.counts.read} S${run.counts.search} E${run.counts.edit} $${run.counts.run}`}
                 
                />
              ) : (
                "—"
              )}
            </span>
            <svg width="11" height="11" viewBox="0 0 12 12" aria-hidden>
              <path d="M2 4l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" />
            </svg>
          </button>

          {menuOpen ? (
            <ul className="mon-runmenu mon-nodrag mon-slimscroll">
              {[...runs].reverse().map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="mon-runmenu__item"
                    data-current={entry.id === run?.id ? "true" : undefined}
                    onClick={() => {
                      onSelectRun(entry.id);
                      setMenuOpen(false);
                    }}
                  >
                    <span className="mon-runmenu__row">
                      <Dot tone={RUN_TONE[entry.status]} />
                      <span className="mon-runmenu__index">
                        #{entry.index} · {t(RUN_WORD[entry.status])}
                      </span>
                      {/* How much of the session one round is: the store's
                          sequence range is inclusive, so this is every event
                          the run holds, not just the tool counts below it. */}
                      <span className="mon-runmenu__events mon-mono">
                        {t("{n} events", { n: entry.toSeq - entry.fromSeq + 1 })}
                      </span>
                      <span className="mon-runmenu__times">
                        {/* Right side, three lines: how long the round ran (or
                            is running), when it started, and what it did — the
                            questions "how much", "when" and "which tools", in
                            the order they're asked. */}
                        <span className="mon-runmenu__duration mon-mono">
                          {formatOffset((entry.endedAt ?? now) - entry.startedAt)}
                        </span>
                        <span className="mon-runmenu__clock mon-mono">{formatClock(entry.startedAt)}</span>
                        <span className="mon-runmenu__counts mon-mono">
                          R{entry.counts.read} S{entry.counts.search} E{entry.counts.edit} ${entry.counts.run}
                        </span>
                      </span>
                    </span>
                    <span className="mon-runmenu__prompt">{entry.prompt || t("(observed activity)")}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>

      {view === "files" ? (
        <div className="mon-feed" ref={filesFeedRef} style={{ padding: 8 }}>
          <FilePanel />
        </div>
      ) : view === "attention" ? (
        <div className="mon-feed" ref={attentionFeedRef} style={{ padding: 8 }}>
          <AttentionList notices={notices} onOpen={openNotice} />
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
                  current={
                    stageMode === "replay"
                      ? row.id === replayRowId
                      : following
                        ? row.stageItem?.source?.eventId !== undefined && row.stageItem.source.eventId === liveEventId
                        : activeEventId !== undefined && row.stageItem?.source?.eventId === activeEventId
                  }
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
        <Chip tone={run ? RUN_TONE[run.status] : "mute"}>{run ? t(RUN_WORD[run.status]) : t("idle")}</Chip>
        <span className="mon-mono" style={{ fontSize: 11 }}>
          {elapsed}
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
  const openMenu = useUiStore((s) => s.openMenu);
  const addContext = useChatStore((s) => s.addContext);
  const inReplay = useStageStore((s) => s.mode === "replay");
  const seek = useReplayStore((s) => s.seekTimestamp);
  const tone = TONE_FOR_ROW[row.tone];
  const openable = row.stageItem !== undefined;
  /**
   * In replay a click is a scrub, not a pin. Pinning inside a replay would
   * fight the clock: the reader
   * would open a moment while the cursor kept moving past it.
   */
  const activate = () => {
    if (inReplay) {
      seek(row.event.timestamp);
      return;
    }
    if (openable) onOpen?.(row);
  };
  return (
    <button
      type="button"
      className={anchor ? "mon-ev mon-ev--anchor" : "mon-ev"}
      data-event={row.id}
      data-selected={current || focused || focusEventId === row.id ? "true" : undefined}
      data-dim={!anchor && !openable && !inReplay ? "true" : undefined}
      onClick={activate}
      onContextMenu={(event) => {
        event.preventDefault();
        openMenu(event.clientX, event.clientY, [
          {
            label: inReplay ? t("Scrub to this event") : t("Open in Stage"),
            disabled: !inReplay && !openable,
            onSelect: activate,
          },
          { label: t("Add event to Chat"), onSelect: () => addContext(eventContext(row.event)) },
        ]);
      }}
      title={inReplay ? t("Scrub to this event") : openable ? row.primary : `${row.action} · ${row.primary}`}
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
