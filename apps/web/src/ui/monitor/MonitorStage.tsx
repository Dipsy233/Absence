import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useReplayItem, useStageView } from "../../hooks/useStage";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import { formatClock, formatOffset } from "../../lib/format";
import { runEvents } from "../../lib/history";
import { MonitorChat } from "./MonitorChat";
import { ChatThread } from "../../components/chat/ChatThread";
import { StageItemView } from "../../components/stage/StageItemView";
import { MetricsDashboard } from "../../components/metrics/MetricsDashboard";
import { StageItem } from "../../types/stage";
import { REPLAY_SPEEDS } from "../../types/replay";
import { Chip, TONE_FOR_KIND, type MonTone } from "../shared/atoms";
import { layoutTimeline } from "../../lib/timeline";
import { activityViews } from "./activityViews";
import type { MonitorData } from "../../hooks/useMonitorData";

/**
 * The pages the Stage can be showing.
 *
 * `metrics` and `chat` are the two *tabs* — pages of their own, which the reader
 * chooses. `activity` is everything else: the moment the feed is on, drawn as
 * whatever that moment *is* (a file, a diff, a command, a thought, an egg). It
 * is not a tab: it is what the column shows by default, and it is why there is
 * no File / Diff / Terminal strip any more — those were three ways of reading
 * one row, so they belong to the row's own rendering, not to a switcher the
 * reader has to drive before the content appears.
 */
type Page = "metrics" | "chat" | "activity";

/** Labels for the tabs that appear in the strip. */
const TAB_LABEL: Record<Exclude<Page, "activity">, string> = {
  metrics: "Metrics",
  chat: "Chat",
};

/** Tabs in the order they appear. */
const TAB_ORDER: Array<Exclude<Page, "activity">> = ["metrics", "chat"];

/**
 * Centre column: what the selected moment *is*, plus the run's world line and
 * the input row.
 *
 * Live, the page *follows* the agent: it is the newest activity of the run
 * (read02 §14). Clicking a row pins that
 * moment instead — the pin bar then states which activity everything is looking
 * at and offers the way back — so the screen never silently changes under a
 * reader who has chosen to stop and look. ⏎, the pin bar and the LIVE tab all
 * return to following.
 */
export function MonitorStage({ data }: { data: MonitorData }) {
  const t = useT();
  const { mode, item } = useStageView();
  const replayItem = useReplayItem();
  const following = useStageStore((s) => s.following);
  const goLive = useStageStore((s) => s.goLive);
  const goMetrics = useStageStore((s) => s.goMetrics);
  const goChat = useStageStore((s) => s.goChat);

  /**
   * What the Stage is a page *of*.
   *
   * `useStageView` returns `following ? liveItem : activeItem`, and `liveItem`
   * is `sessionStore.currentAction`, which `clearsStage` empties on `agent_end`
   * and on the agent's own message. So "the agent is not doing anything right
   * now" arrives as `item === undefined`, and the column falls through to its
   * default page (METRICS / CHAT) instead of an empty sheet — which is why a
   * finished run rests on a page rather than on its last activity.
   *
   * Monitor previously took the *tail of the feed* as what to follow. A tail
   * never disappears — the last row of a finished run is still a row — so the
   * centre column stayed on the final activity of every run that had ended, and
   * no rule about run status could paper over that.
   */

  /**
   * Replay is a third clock, and the page has to follow it.
   *
   * `useStageView` answers for live and for a pin; in replay the store's
   * `currentTime` decides what is on screen (the shared `useReplayItem`), so a
   * playing replay walks the Stage through the run
   * activity by activity, in the run's own real timing. Without this the Stage
   * kept showing whatever was pinned when the replay started while the feed's
   * cursor moved on.
   */
  const replaying = mode === "replay";
  const replayTime = useReplayStore((s) => s.currentTime);

  /**
   * Resting.
   *
   * The store's `mode` has to agree with what is on screen, because the tab
   * strip, the pin bar and the rail's LIVE/REPLAY chip all read it. So when
   * following has nothing to follow — the run ended, or there is no run yet —
   * the store is moved to the resting page rather than the render quietly
   * substituting one. The effect keeps the two in step; the *rendering* rule
   * above still holds, so a reader who pins a row or opens METRICS gets
   * what they asked for.
   *
   *   a new run starts  → follow the work again
   *   the run ends      → rest on the page the reader chose last
   *                       (METRICS / CHAT; CHAT if they never chose)
   *   click a row       → pin that moment, whatever the run is doing
   *
   * "A new run starts" is decided by the run's *id*, never by the status flag
   * alone: `status === "running" && !following` is also true in the frame after
   * the reader clicks METRICS, and re-arming following there slammed the page
   * they had just asked for back to live. Re-arming only when the id changes
   * (or on first mount onto a run already in flight) is the same intent,
   * stated where it can only mean "this is a different run".
   */
  const runId = data.run?.id;
  const runStatus = data.run?.status;
  const goResting = useStageStore((s) => s.goResting);
  const lastRunId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (replaying) return;
    const started = runId !== undefined && runId !== lastRunId.current;
    lastRunId.current = runId;
    if (runStatus === "running") {
      if (started && !following) goLive();
      return;
    }
    if (following) goResting();
  }, [runId, runStatus, following, replaying, goResting, goLive]);

  const page = replaying ? replayItem : item;
  const showingMetrics = mode === "metrics";
  const showingChat = mode === "chat";
  // `active` stays the moment even while METRICS or CHAT is up: those two are
  // pages the reader opened, and closing one has to land back on the work that
  // was on screen before it — not on an empty sheet.
  const active = page;

  /**
   * What the sheet draws for the moment on screen.
   *
   * `activityViews` answers "which views of this row exist" — a read has FILE, an
   * edit has DIFF and FILE, a command has TERMINAL — and the row's own kind
   * decides which one is shown first: an edit is its diff, a read is its file,
   * a command is its terminal. A thought, an egg or an approval has no such
   * view, so it is drawn as its own card.
   *
   * There is no switcher over these: the tabs are METRICS and CHAT, which are
   * pages of the session rather than readings of one row. A row that can be
   * read two ways still can be — from the feed's own row, and the reader who
   * wants the other reading clicks the row (an edit's FILE is one click away on
   * the file list in the rail).
   */
  const views = useMemo(() => activityViews(active), [active]);
  const shownItem: StageItem | undefined =
    active === undefined
      ? undefined
      : active.type === "file" || active.type === "diff" || active.type === "terminal"
        ? active
        : (views[active.type] ?? active);

  /**
   * Which page the sheet is showing.
   *
   * METRICS and CHAT are pages the reader picked. `activity` is the moment the
   * feed is on — and when there is no moment, `activity` has nothing to draw.
   * The resting default page answers that instead of an empty sheet: an
   * "activity" page with no activity is not a page, it is a blank
   * column with a caption explaining that it is blank.
   *
   * So a live/pinned mode that has no item falls through to the resting page.
   * The store still says `mode: "live"` until the effect below moves it, which
   * is why this reads `restingPage` rather than trusting `mode` alone: during
   * the frame between "the run ended" and "the store settled", the column must
   * already show the page the reader is about to be left on.
   */
  const resting: Exclude<Page, "activity"> = useStageStore((s) => s.restingPage) ?? "chat";
  const tab: Page = showingMetrics
    ? "metrics"
    : showingChat
      ? "chat"
      : active === undefined && !replaying
        ? resting
        : "activity";

  const chooseTab = (next: Exclude<Page, "activity">) => {
    if (next === tab) {
      // Clicking the tab that is already up returns to the work: a tab is a way
      // *to* a page, and its own page is also the way back from it. When there
      // is no work to return to, `goLive` would land on the same page again —
      // the resting fallback — so it is a no-op either way, and the click still
      // means "show me the work" for the next run.
      goLive();
      return;
    }
    if (next === "metrics") goMetrics();
    else goChat();
  };

  /**
   * The header text for the current tab.
   *
   * METRICS is not a view of one activity, so it cannot be described by one:
   * it gets its own title instead of falling through to "waiting for the first
   * activity", which was a lie while the dashboard was right there showing
   * numbers. The default page (nothing pinned) still gets the live headline.
   */
  const header: StageHeader =
    tab === "metrics"
      ? {
          chip: <Chip tone="read">{t("METRICS")}</Chip>,
          chipText: t("METRICS"),
          title: t("Resource metrics"),
          sub: t("The whole agent or the selected egg — the metrics dashboard"),
          time: "—",
        }
      : tab === "chat"
        ? {
            chip: <Chip tone="mute">{t("CHAT")}</Chip>,
            chipText: t("CHAT"),
            title: t("Conversation"),
            sub: data.run ? `#${data.run.index} · ${data.run.prompt}` : t("No run yet"),
            time: "—",
          }
        : describe(shownItem, data, t, replaying);

  return (
    <div className="mon-stage">
      <div className="mon-stagehead">
        {header.chip}
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="mon-stagehead__title" title={header.title}>
            {header.title}
          </div>
          <div className="mon-stagehead__sub" title={header.sub}>
            {header.sub}
          </div>
        </div>

        <div className="mon-seg" role="tablist" aria-label={t("Stage view")}>
          {TAB_ORDER.map((entry) => (
            <button
              key={entry}
              type="button"
              role="tab"
              aria-selected={tab === entry}
              data-on={tab === entry ? "true" : undefined}
              onClick={() => chooseTab(entry)}
            >
              {t(TAB_LABEL[entry])}
            </button>
          ))}
        </div>

      </div>

      {/*
        The pin bar states *which moment* everything is looking at, so it only
        means something when a moment is pinned. METRICS and CHAT are pages of
        their own, not moments: they get no bar, and their tabs are the way back
        (a view tab returns to following).
      */}
      {replaying ? (
        // Replay has its own clock, so the bar reports it instead of a pin: the
        // moment on screen is wherever the cursor is, and ⏎ leaves the replay.
        <div className="mon-pinbar">
          <span className="mon-chip mon-chip--run" style={{ height: 18 }}>
            {t("REPLAY")}
          </span>
          <span>
            {t("Replaying — the page follows the run's own clock, {time} in", {
              // An offset into the run, not a wall clock: "00:05 in" is what a
              // scrubber shows, and the run's own timeline is what this bar is
              // reporting on.
              time: data.run ? formatOffset(Math.max(0, replayTime - data.run.startedAt)) : "—",
            })}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" className="mon-btn mon-btn--ghost" onClick={goLive}>
            {t("Back to live ⏎")}
          </button>
        </div>
      ) : !following && tab === "activity" && active ? (
        <div className="mon-pinbar">
          <span className="mon-chip mon-chip--edit" style={{ height: 18 }}>
            {header.chipText}
          </span>
          <span>{t("Pinned at {time} — every panel shows this moment", { time: header.time })}</span>
          <span style={{ flex: 1 }} />
          <button type="button" className="mon-btn mon-btn--ghost" onClick={goLive}>
            {t("Back to live ⏎")}
          </button>
        </div>
      ) : null}

      <div className="mon-stagebody">
        <div className="mon-sheet">
          {tab === "metrics" ? (
            // METRICS is the one tab that is not a view of the activity: it is
            // the metrics dashboard, the Stage's own default page, and it is
            // what you look at when the question is "what is this costing"
            // rather than "what did it do". The keyed wrapper is what makes the
            // page switch a *mount* — and so what powers it on (`.mon-flick`).
            // The activity view deliberately has no wrapper: it re-renders on
            // the agent's cadence and must never flicker.
            <div className="mon-flick mon-sheet__page" key="metrics">
              <MetricsDashboard embedded />
            </div>
          ) : tab === "chat" ? (
            // CHAT is the conversation, given the whole sheet: reading
            // what was said is a page, not a strip over the trace.
            <div className="mon-flick mon-sheet__page" key="chat">
              <ChatThread stamp />
            </div>
          ) : shownItem ? (
            <StageItemView key={shownItem.id} item={shownItem} />
          ) : (
            // Only replay can reach this: a live or pinned mode with no item
            // falls through to the resting page above, so the
            // column is never an empty sheet with a caption explaining itself.
            // A replay before the run's first stage event genuinely has nothing
            // to show, and saying so is the honest page.
            <div className="mon-sheet-empty">
              {t("Replay — before the first activity of this run")}
            </div>
          )}
        </div>
      </div>

      <Timeline data={data} />
      <MonitorChat />
    </div>
  );
}

interface StageHeader {
  chip: ReactElement;
  chipText: string;
  title: string;
  sub: string;
  time: string;
}

/** What to call the page: a verb, a subject, and the line under it. */
function describe(
  item: StageItem | undefined,
  data: MonitorData,
  t: (key: string, params?: Record<string, string | number>) => string,
  /** True while a replay is on screen (see the no-activity branch). */
  replaying = false,
): StageHeader {
  const time = item ? formatClock(item.createdAt) : "—";
  if (!item) {
    // No activity to describe. This is a *page*, not a moment, so the chip says
    // which page — never the phase. `Investigating` / `Executing` /
    // `Implementing` belong to the activity feed's group dividers, where they
    // classify rows; a header chip that borrowed one of them announced a
    // classification for a screen that has no rows on it.
    return {
      chip: <Chip tone="mute">{t("IDLE")}</Chip>,
      chipText: t("IDLE"),
      title: replaying
        ? t("Replay — before the first activity of this run")
        : data.liveHeadline ?? t("Waiting for the first activity…"),
      sub: data.run ? `#${data.run.index} · ${data.run.prompt}` : t("No run yet"),
      time,
    };
  }
  const payload = item.payload;
  switch (payload.kind) {
    case "diff":
      return {
        chip: <Chip tone="edit">{t("DIFF")}</Chip>,
        chipText: t("DIFF"),
        title: payload.path,
        sub: t("The agent's change — before and after"),
        time,
      };
    case "file":
      return {
        chip: <Chip tone="read">{t("FILE")}</Chip>,
        chipText: t("FILE"),
        title: payload.path,
        sub:
          payload.rangeKnown === false
            ? t("range unknown in context")
            : payload.startLine !== undefined && payload.endLine !== undefined
              ? t("lines {a}–{b} in context", { a: payload.startLine, b: payload.endLine })
              : (payload.caption ?? t("In the agent's context")),
        time,
      };
    case "terminal":
      return {
        chip: <Chip tone={payload.exitCode === 0 ? "run" : "err"}>{payload.mcp ? "MCP" : t("RUN")}</Chip>,
        chipText: payload.mcp ? "MCP" : t("RUN"),
        title: payload.command || "(shell)",
        sub: payload.mcp
          ? `${payload.mcp.server} › ${payload.mcp.tool}`
          : t("exit {code}", { code: payload.exitCode }),
        time,
      };
    case "thought":
      return {
        chip: <Chip tone="think">{t("THINK")}</Chip>,
        chipText: t("THINK"),
        title: t("Reasoning"),
        sub: payload.streaming ? t("still streaming…") : t("{n} chars", { n: payload.text.length }),
        time,
      };
    case "error":
      return {
        chip: <Chip tone="err">{t("ERROR")}</Chip>,
        chipText: t("ERROR"),
        title: item.title,
        sub: t("{n} chars", { n: payload.message.length }),
        time,
      };
    case "process":
      return {
        chip: <Chip tone="egg">{t("EGG")}</Chip>,
        chipText: t("EGG"),
        title: payload.name,
        sub: `pid ${payload.pid} · ${payload.status === "running" ? t("running") : t("exited")}`,
        time,
      };
    case "approval":
      return {
        chip: <Chip tone="run">{t("APPROVE?")}</Chip>,
        chipText: t("APPROVE?"),
        title: payload.title,
        sub: t("the agent is waiting"),
        time,
      };
    default:
      return {
        chip: <Chip tone="mute">{t("ACTIVITY")}</Chip>,
        chipText: t("ACTIVITY"),
        title: item.title,
        sub: "",
        time,
      };
  }
}

/**
 * The run's world line, drawn the way the proposal draws it: one hairline track
 * per lane, an 8px block per activity at its own offset, and a cursor line with
 * the moment printed above it.
 *
 * Geometry is absolute on purpose (a lane is a 1px line at `top: 8 + n*14`, a
 * block sits at `top: 4 + n*14`), because a flex column of rows cannot put a
 * block *on* the line — the whole point of the strip is that activities read as
 * marks on a single timeline, not as rows in a list.
 */
const LANE_H = 14;
const TRACK_TOP = 8;

function Timeline({ data }: { data: MonitorData }) {
  const t = useT();
  const nodes = data.facts?.timeline ?? [];
  const selectRun = useUiStore((s) => s.selectRun);
  const load = useReplayStore((s) => s.load);
  const setMode = useStageStore((s) => s.setMode);
  const replayTime = useReplayStore((s) => s.currentTime);
  const replayStatus = useReplayStore((s) => s.status);
  const play = useReplayStore((s) => s.play);
  const pause = useReplayStore((s) => s.pause);
  // Subscribed, not `getState()`: the speed chip is read during render, and a
  // speed changed elsewhere (or by the chip itself) has to re-render it.
  const speed = useReplayStore((s) => s.speed);
  const setSpeed = useReplayStore((s) => s.setSpeed);
  const stepForward = useReplayStore((s) => s.stepForward);
  const stepBackward = useReplayStore((s) => s.stepBackward);
  const inReplay = useStageStore((s) => s.mode === "replay");
  const following = useStageStore((s) => s.following);
  const goLive = useStageStore((s) => s.goLive);
  // The pinned item — subscribed before the early returns below: a hook's
  // place in the order is fixed on the first render, and the empty-run exits
  // would otherwise skip it and crash the moment nodes appeared.
  const activeItem = useStageStore((s) => s.activeItem);

  const total = Math.max(1, nodes.at(-1)?.offsetMs ?? 0);

  /**
   * The three tracks — the model, the tools it called, the shell — bucketed
   * and laid out by `lib/timeline`, independently of each other.
   *
   * Only activities belong on the strip: lifecycle markers, eggs and OS
   * observations have no track of their own. An egg is a process a command left
   * behind, reported again every time it changes; the rail's Agent Eggs panel
   * is where it lives, and drawing it here would make one daemon look like a
   * busy shell.
   */
  const layout = useMemo(
    () => layoutTimeline(data.tracks, total),
    [data.tracks, total],
  );

  /**
   * One block per activity, at its own offset. A block's width is the gap to
   * the next activity *on the same track*, computed by the layout: a silent
   * model track must not stretch a shell mark.
   *
   * Blocks carry their track's id, not an index: which tracks exist is decided
   * by the registry, and empty tracks are already dropped by the layout.
   */
  const marks = useMemo(
    () =>
      layout.marks.map((mark) => ({
        laneId: mark.trackId,
        left: mark.left,
        width: mark.width,
        tone: (TONE_FOR_KIND[mark.node.kind] ?? "mute") as MonTone,
        label: `${mark.node.action} · ${mark.node.subject} · ${formatOffset(mark.node.offsetMs)}`,
        at: mark.node.at,
      })),
    [layout],
  );

  const shownLanes = useMemo(
    () => layout.tracks.map((track) => [track.id, track.label] as const),
    [layout],
  );
  const laneIndex = useMemo(
    () => new Map(shownLanes.map(([id], index) => [id, index])),
    [shownLanes],
  );

  /** Load the run into replay and land on `at`. */
  const seekTo = (at: number) => {
    if (!data.run) return;
    selectRun(data.run.id);
    load(runEvents(data.events, data.run), { label: `#${data.run.index} · ${data.run.prompt}` });
    useReplayStore.getState().seekTimestamp(at);
    setMode("replay");
  };

  /**
   * Re-load the replay store when the run has grown past what it holds.
   * The staleness check and the position/playing-state restore live in the
   * store (`refresh`) — they are facts about its own snapshot.
   */
  const ensureReplayFresh = () => {
    if (!data.run) return;
    useReplayStore
      .getState()
      .refresh(runEvents(data.events, data.run), `#${data.run.index} · ${data.run.prompt}`);
  };

  /**
   * A click on the track seeks — it never returns to live.
   *
   * Scrubbing *is* a replay gesture, so the first click has to enter replay
   * (there is no cursor to move in live mode). Once in replay, every click only
   * moves the cursor: leaving replay is the ▶/■ pair's job (and ⏎), so a reader
   * who clicks three times to land on a moment does not get thrown back to the
   * live tail on the second click.
   */
  const seekRatio = (ratio: number) => {
    if (!data.run) return;
    const at = data.run.startedAt + Math.min(1, Math.max(0, ratio)) * total;
    if (inReplay) {
      ensureReplayFresh();
      useReplayStore.getState().seekTimestamp(at);
      return;
    }
    seekTo(at);
  };

  /**
   * The ghost: where the cursor *would* land, drawn under the pointer while it
   * is over the track. Clicking a thin strip to hit a 40ms moment is guesswork
   * without it — the reader needs to see the target before committing.
   */
  const [hover, setHover] = useState<number | undefined>(undefined);
  const hoverLabel = hover !== undefined ? formatOffset(hover * total) : "";

  if (nodes.length === 0) {
    return (
      <div className="mon-tl">
        <span className="mon-cap">{t("Timeline")}</span>
        <span className="mon-tl__empty">{t("Nothing on the world line yet.")}</span>
      </div>
    );
  }

  if (marks.length === 0) {
    // The run exists but every node is a re-report: the lanes would all be
    // bare, so say what the strip is waiting for instead of drawing it empty.
    return (
      <div className="mon-tl">
        <span className="mon-cap">{t("Timeline")}</span>
        <span className="mon-tl__empty">{t("Only process updates so far — no model, tool or shell activity.")}</span>
      </div>
    );
  }

  // The cursor's position: in replay it is where the scrubber is; on a pinned
  // page it is the pinned moment — the page shows that instant, so the line
  // must point at it, not silently rest at the end; only a page with no clock
  // of its own (METRICS, CHAT) leaves the cursor at the live edge.
  const pinnedAt =
    !following && !inReplay && activeItem?.event ? activeItem.event.timestamp : undefined;
  const cursor = data.run
    ? inReplay
      ? Math.min(1, Math.max(0, (replayTime - data.run.startedAt) / total))
      : pinnedAt !== undefined
        ? Math.min(1, Math.max(0, (pinnedAt - data.run.startedAt) / total))
        : 1
    : 1;
  const cursorLabel = formatOffset(cursor * total);
  const trackHeight = shownLanes.length * LANE_H + 2;

  return (
    <div className="mon-tl">
      <div className="mon-tl__row">
        {/*
          Replay's controls, all on the left in two rows: step and play on the
          top row, speed and live on the bottom. The strip is a player — live
          is its playing state, and both a step and a pause leave it holding a
          moment (a paused replay), which the ▶ then continues.
        */}
        <div className="mon-tl__controls" style={{ height: trackHeight }}>
          <button
            type="button"
            className="mon-tl__ctl"
            disabled={!data.run}
            onClick={() => {
              if (!data.run) return;
              if (!inReplay) {
                // Stepping back from live holds the previous activity: load
                // the replay paused at the live edge, then one step back.
                selectRun(data.run.id);
                load(runEvents(data.events, data.run), {
                  startAtEnd: true,
                  label: `#${data.run.index} · ${data.run.prompt}`,
                });
                useReplayStore.getState().stepBackward();
                setMode("replay");
                return;
              }
              ensureReplayFresh();
              stepBackward();
            }}
            title={t("One activity back")}
            aria-label={t("One activity back")}
          >
            ‹
          </button>
          <button
            type="button"
            className="mon-tl__ctl mon-tl__ctl--play"
            disabled={!data.run}
            onClick={() => {
              if (!data.run) return;
              if (!inReplay) {
                // Live is the player's playing state, so its button pauses:
                // hold the view at the live edge as a paused replay, which the
                // clock can then be walked or played from.
                selectRun(data.run.id);
                load(runEvents(data.events, data.run), {
                  startAtEnd: true,
                  label: `#${data.run.index} · ${data.run.prompt}`,
                });
                setMode("replay");
                return;
              }
              if (replayStatus === "playing") pause();
              else play();
            }}
            title={
              !inReplay
                ? t("Pause")
                : replayStatus === "playing"
                  ? t("Pause")
                  : t("Play")
            }
            aria-label={
              !inReplay
                ? t("Pause")
                : replayStatus === "playing"
                  ? t("Pause")
                  : t("Play")
            }
          >
            {!inReplay || replayStatus === "playing" ? "⏸" : "▶"}
          </button>
          <button
            type="button"
            className="mon-tl__ctl"
            disabled={!inReplay}
            onClick={() => {
              ensureReplayFresh();
              stepForward();
            }}
            title={t("One activity forward")}
            aria-label={t("One activity forward")}
          >
            ›
          </button>
          <button
            type="button"
            className="mon-tl__ctl mon-tl__ctl--speed mon-mono"
            disabled={!inReplay}
            onClick={() => setSpeed(REPLAY_SPEEDS[(REPLAY_SPEEDS.indexOf(speed) + 1) % REPLAY_SPEEDS.length]!)}
            title={inReplay ? t("Replay speed — click to change") : t("Replay speed")}
            aria-label={t("Replay speed")}
          >
            {speed}×
          </button>
          <button
            type="button"
            className="mon-tl__ctl"
            data-live={following ? "true" : undefined}
            onClick={goLive}
            disabled={following}
            title={t("Back to live")}
            aria-label={t("Back to live")}
          >
            ◉
          </button>
        </div>

        <div className="mon-tl__labels" style={{ height: trackHeight }}>
          {shownLanes.map(([id, label]) => (
            <span key={id} style={{ height: LANE_H }}>
              {t(label)}
            </span>
          ))}
        </div>

        <div
          className="mon-tl__track"
          style={{ height: trackHeight }}
          role="group"
          aria-label={t("Run timeline")}
          onClick={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            seekRatio((event.clientX - rect.left) / Math.max(1, rect.width));
          }}
          onMouseMove={(event) => {
            const rect = event.currentTarget.getBoundingClientRect();
            setHover(Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width))));
          }}
          onMouseLeave={() => setHover(undefined)}
        >
          {shownLanes.map(([id], index) => (
            <span
              key={id}
              className="mon-tl__lane"
              style={{ top: TRACK_TOP + index * LANE_H }}
              aria-hidden
            />
          ))}
          {marks.map((mark, index) => (
            <span
              key={index}
              className={`mon-tl__blk mon-chip--${mark.tone}`}
              style={{
                top: TRACK_TOP - 4 + laneIndex.get(mark.laneId)! * LANE_H,
                left: `${mark.left}%`,
                width: `${mark.width}%`,
              }}
              title={mark.label}
            />
          ))}
          {/*
            The ghost sits *under* the real cursor: it is the pointer's position
            projected onto the run, with its own moment printed, and it never
            replaces the head (which is where the replay actually is).
          */}
          {hover !== undefined ? (
            <span className="mon-tl__ghost" style={{ left: `${hover * 100}%` }} aria-hidden>
              <span className="mon-tl__ghost-label">{hoverLabel}</span>
            </span>
          ) : null}
          <span className="mon-tl__head" style={{ left: `${cursor * 100}%` }} aria-hidden>
            <span className="mon-tl__head-label">{cursorLabel}</span>
          </span>
          {/* The live edge: where the run actually ended, which is where the
              cursor sits while nothing is pinned. */}
          {cursor >= 0.999 ? <span className="mon-tl__livehead" aria-hidden /> : null}
        </div>
      </div>
    </div>
  );
}


