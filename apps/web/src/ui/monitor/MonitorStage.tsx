import { useEffect, useMemo, useState, type ReactElement } from "react";
import { isAgentBusy } from "@absence/core";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useReplayItem, useStageView } from "../../hooks/useStage";
import { useUiStore } from "../../stores/uiStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useIsObserved } from "../../stores/sessionStore";
import { useT } from "../../lib/i18n";
import { formatClock, formatOffset } from "../../lib/format";
import { runEvents } from "../../lib/history";
import { MonitorChat } from "./MonitorChat";
import { ChatThread } from "../../components/chat/ChatThread";
import { StageItemView } from "../../components/stage/StageItemView";
import { MetricsDashboard } from "../../components/metrics/MetricsDashboard";
import { StageItem } from "../../types/stage";
import type { PhaseType } from "../../types/report";
import { Chip, TONE_FOR_KIND, attentionTone, phaseWord, type MonTone } from "./atoms";
import { activityViews } from "./activityViews";
import type { MonitorData } from "./useMonitorData";

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
 * Live, the page *follows* the agent: it is the newest activity of the run, the
 * same thing Classic's Stage shows (read02 §14). Clicking a row pins that
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
  const openMetrics = useUiStore((s) => s.openMetrics);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);

  /**
   * What the Stage is a page *of*.
   *
   * Following (live) it is the newest activity in the run - the agent's own
   * tail - so the middle column moves with the agent instead of sitting on
   * "waiting for the first activity" while the feed fills up. Pinned, it is
   * the activity the reader clicked. METRICS and CHAT are pages of their own
   * and never show an activity, so neither is "the moment everything shows".
   */
  /**
   * Replay is a third clock, and the page has to follow it.
   *
   * `useStageView` answers for live and for a pin; in replay the store's
   * `currentTime` decides what is on screen (`useReplayItem`, the same hook
   * Classic's Stage uses), so a playing replay walks the Stage through the run
   * activity by activity, in the run's own real timing. Without this the Stage
   * kept showing whatever was pinned when the replay started while the feed's
   * cursor moved on.
   */
  const replaying = mode === "replay";
  const replayTime = useReplayStore((s) => s.currentTime);
  const page = replaying ? replayItem : following ? data.liveItem : item;
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

  /** Which page the sheet is showing. */
  const tab: Page = showingMetrics ? "metrics" : showingChat ? "chat" : "activity";

  const chooseTab = (next: Exclude<Page, "activity">) => {
    if (next === tab) {
      // Clicking the tab that is already up returns to the work: a tab is a way
      // *to* a page, and its own page is also the way back from it.
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
          sub: t("The whole agent or the selected egg — Classic's dashboard"),
          time: "—",
        }
      : tab === "chat"
        ? {
            chip: <Chip tone="mute">{t("CHAT")}</Chip>,
            chipText: t("CHAT"),
            title: t("Conversation"),
            sub: data.run ? `#${data.run.index} · ${data.run.prompt || t("(observed activity)")}` : t("No run yet"),
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
            // Classic's dashboard, the Stage's own default page, and it is what
            // you look at when the question is "what is this costing" rather
            // than "what did it do".
            <MetricsDashboard embedded />
          ) : tab === "chat" ? (
            // CHAT is Classic's conversation, given the whole sheet: reading
            // what was said is a page, not a strip over the trace.
            <ChatThread />
          ) : shownItem ? (
            <StageItemView key={shownItem.id} item={shownItem} />
          ) : (
            <DefaultPage data={data} onOpenEgg={() => openMetrics()} eggSelected={selectedEggPid !== undefined} />
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
    const phase = data.phase;
    // No activity to describe. Three different reasons, said differently, so
    // "waiting for the first activity" is not printed over a replay that is
    // simply before the first stage event of a finished run.
    const title = replaying
      ? t("Replay — before the first activity of this run")
      : data.liveHeadline ?? t("Waiting for the first activity…");
    return {
      chip: <Chip tone="mute">{t(phaseWord(phase)).toUpperCase()}</Chip>,
      chipText: t(phaseWord(phase)).toUpperCase(),
      title,
      sub: data.run ? `#${data.run.index} · ${data.run.prompt || t("(observed activity)")}` : t("No run yet"),
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
          payload.startLine !== undefined && payload.endLine !== undefined
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
 * The default page. Live, this says in one line what the agent is doing right
 * now and what it has produced so far — no avatar, no desk: the "监护" reading
 * of the same facts the right rail summarises.
 */
function DefaultPage({
  data,
  onOpenEgg,
  eggSelected,
}: {
  data: MonitorData;
  onOpenEgg: () => void;
  eggSelected: boolean;
}) {
  const t = useT();
  const observed = useIsObserved();
  const busy = data.busy;
  const facts = data.facts;
  if (!data.run) {
    return (
      <div className="mon-scroll mon-empty" style={{ padding: 24 }}>
        {observed
          ? t("Absence is watching this process; it never drives or stops it.")
          : t("Send the agent a task with the input row below.")}
      </div>
    );
  }
  const changed = (facts?.files.created.length ?? 0) + (facts?.files.modified.length ?? 0);
  const matters: Array<[string, string, string]> = [
    [t("Phase"), t(phaseWord(data.phase)), "mute"],
    [t("Files read"), String(facts?.counts.reads ?? 0), "read"],
    [t("Files changed"), String(changed), "edit"],
    [t("Commands"), String(facts?.commands.total ?? 0), "run"],
    [t("Errors"), String(facts?.errors.unresolved ?? 0), "err"],
    [t("Eggs left"), String(facts?.processes.runningAtEnd ?? 0), "egg"],
  ];
  return (
    <div className="mon-scroll">
      <div style={{ marginBottom: 14 }}>
        <div className="mon-cap">{busy ? t("Doing now") : t("Last activity")}</div>
        <div style={{ marginTop: 4, fontSize: 17, lineHeight: 1.35, color: "var(--mon-t)" }}>
          {data.liveHeadline ?? t("The run finished — open the Report for what it amounted to.")}
        </div>
        <div style={{ marginTop: 6, fontSize: 12.5, color: "var(--mon-t2)" }}>
          {`#${data.run.index} · ${data.run.prompt || t("(observed activity)")}`}
        </div>
      </div>

      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          marginBottom: 16,
        }}
      >
        {matters.map(([label, value, tone]) => (
          <div
            key={label}
            style={{ padding: "9px 11px", border: "1px solid var(--mon-bd)", borderRadius: 8, background: "var(--mon-s1)" }}
          >
            <div className="mon-cap">{label}</div>
            <div className={`mon-mono mon-chip--${tone as MonTone}`} style={{ marginTop: 2, fontSize: 19, fontWeight: 600 }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      {data.attention.level !== "none" && data.attention.reasons.length > 0 ? (
        <div style={{ marginBottom: 14, display: "flex", gap: 8, flexWrap: "wrap" }}>
          {data.attention.reasons.slice(0, 4).map((reason) => (
            <Chip key={reason} tone={attentionTone(data.attention.level)}>
              {t(reason.replace(/_/g, " "))}
            </Chip>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <button type="button" className="mon-btn" onClick={onOpenEgg} disabled={eggSelected}>
          {t("Open metrics")}
        </button>
      </div>
    </div>
  );
}

/**
 * The world line: one lane per kind, a block per activity, a cursor at the
 * pinned moment (or at the end, live). Clicking a block seeks the replay — the
 * same gesture as Classic's timeline, kept because it is the fastest way to
 * answer "when did that happen".
 */
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
  const inReplay = useStageStore((s) => s.mode === "replay");
  const following = useStageStore((s) => s.following);
  const goLive = useStageStore((s) => s.goLive);

  /**
   * Three lanes, one per *kind of activity*: reasoning, files, shell.
   *
   * The lanes are a reading of the Activity feed, so only activities belong on
   * them. An egg is not an activity — it is a process a command left behind,
   * reported again every time it changes. It has its own panel on the right;
   * putting it here would draw the same moment twice and make one daemon look
   * like a busy shell.
   */
  const lanes: Array<[string, string]> = useMemo(
    () => [
      ["think", t("Think")],
      ["files", t("Files")],
      ["shell", t("Shell")],
    ],
    [t],
  );

  const total = Math.max(1, nodes.at(-1)?.offsetMs ?? 0);

  /**
   * One block per activity, at its own offset.
   *
   * The timeline nodes carry a start and no end, so a block's width is the gap
   * to the next activity — the time that activity was the thing happening.
   * Capped (a long silence must not become a wall of colour) and floored (a
   * 40ms read must still be a visible mark, not a sub-pixel sliver).
   */
  const marks = useMemo(() => {
    const out: Array<{ lane: number; left: number; width: number; tone: MonTone; label: string; at: number }> = [];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i]!;
      // `laneFor` returns undefined for a node that is not one of the three
      // kinds of work (an egg, a lifecycle marker). Those get no block at all —
      // `findIndex` on undefined would otherwise match nothing and leave
      // `lane` at -1 only by accident.
      const laneId = laneFor(node.kind);
      if (laneId === undefined) continue;
      const lane = lanes.findIndex(([id]) => id === laneId);
      if (lane < 0) continue;
      // The next *activity*, not the next node: a run of egg updates between two
      // reads must not make the read look like it lasted a minute.
      let next: (typeof nodes)[number] | undefined;
      for (let j = i + 1; j < nodes.length; j++) {
        if (laneFor(nodes[j]!.kind) !== undefined) {
          next = nodes[j];
          break;
        }
      }
      const span = Math.max(0, (next ? next.offsetMs - node.offsetMs : total - node.offsetMs));
      out.push({
        lane,
        left: (node.offsetMs / total) * 100,
        width: Math.max(0.7, Math.min(28, (span / total) * 100)),
        tone: TONE_FOR_KIND[node.kind] ?? "mute",
        label: `${node.action} · ${node.subject} · ${formatOffset(node.offsetMs)}`,
        at: node.at,
      });
    }
    return out;
  }, [nodes, total, lanes]);

  /** Load the run into replay and land on `at`. */
  const seekTo = (at: number) => {
    if (!data.run) return;
    selectRun(data.run.id);
    load(runEvents(data.events, data.run), { label: `#${data.run.index} · ${data.run.prompt}` });
    useReplayStore.getState().seekTimestamp(at);
    setMode("replay");
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

  // Live, the cursor is the end of the line; in replay it is where the scrubber
  // is. A pinned page has no clock of its own, so the end is the honest place.
  const cursor = inReplay && data.run
    ? Math.min(1, Math.max(0, (replayTime - data.run.startedAt) / total))
    : 1;
  const cursorLabel = formatOffset(cursor * total);
  const trackHeight = lanes.length * LANE_H + 2;

  return (
    <div className="mon-tl">
      <div className="mon-tl__row">
        {/*
          Two buttons, not one toggle: play/pause the replay, and the way back
          to live. They are different acts — one moves the clock, the other
          leaves the mode — and a single button that means "play" here and
          "live" there is how a reader ends up in the wrong mode.
        */}
        <div className="mon-tl__controls" style={{ height: trackHeight }}>
          <button
            type="button"
            className="mon-tl__ctl"
            onClick={() => {
              if (!data.run) return;
              if (!inReplay) {
                seekTo(data.run.startedAt);
                play();
                return;
              }
              if (replayStatus === "playing") pause();
              else play();
            }}
            title={
              !inReplay
                ? t("Replay from the start")
                : replayStatus === "playing"
                  ? t("Pause")
                  : t("Play")
            }
            aria-label={
              !inReplay
                ? t("Replay from the start")
                : replayStatus === "playing"
                  ? t("Pause")
                  : t("Play")
            }
          >
            {inReplay && replayStatus === "playing" ? "⏸" : "▶"}
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
          {lanes.map(([id, label]) => (
            <span key={id} style={{ height: LANE_H }}>
              {label}
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
          {lanes.map(([id], index) => (
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
              style={{ top: TRACK_TOP - 4 + mark.lane * LANE_H, left: `${mark.left}%`, width: `${mark.width}%` }}
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

        <span className="mon-tl__speed mon-mono">{inReplay ? `${useReplayStore.getState().speed}×` : "1×"}</span>
      </div>
    </div>
  );
}

/**
 * Which lane an activity belongs on, or `undefined` when it is not an activity.
 *
 * The three lanes are a reading of the Activity feed, so only activities get a
 * block. `process` (an egg) is deliberately absent: it is a process a command
 * *left behind*, re-reported every time its child count changes — not something
 * the agent did in that instant. Lifecycle and error nodes are excluded for the
 * same reason.
 */
function laneFor(kind: string): string | undefined {
  switch (kind) {
    case "think":
      return "think";
    case "read":
    case "search":
    case "edit":
    case "write":
    case "observe":
      return "files";
    case "run":
      return "shell";
    default:
      return undefined;
  }
}
