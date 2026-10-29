import { useEffect, useMemo, useState, type ReactElement } from "react";
import { isAgentBusy } from "@absence/core";
import { useStageStore } from "../../stores/stageStore";
import { useReplayStore } from "../../stores/replayStore";
import { useStageView } from "../../hooks/useStage";
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
import { activityViews, type ActivityViews } from "./activityViews";
import type { MonitorData } from "./useMonitorData";

/**
 * `card` is not a tab you can click: it is "this activity's own card" — a
 * thought, an egg, an approval. Those are not a file, a diff or a command, so
 * they light no tab and the sheet shows the card itself.
 */
type Tab = "file" | "diff" | "terminal" | "metrics" | "chat" | "card";

/** Labels for the tabs that actually appear in the strip (`card` has none). */
const TAB_LABEL: Record<Exclude<Tab, "card">, string> = {
  file: "File",
  diff: "Diff",
  terminal: "Terminal",
  metrics: "Metrics",
  chat: "Chat",
};

/** Tabs in the order they appear. */
const TAB_ORDER: Array<Exclude<Tab, "card">> = ["file", "diff", "terminal", "metrics", "chat"];

/**
 * Which view of the pinned activity the reader is looking at.
 *
 * Local, not a store field: it is a reading position within one activity, so it
 * resets whenever the activity changes — carrying "DIFF" over to a command that
 * has no diff is how a tab ends up lit while showing nothing.
 */
function useActivityView(
  views: ActivityViews,
  /** The view this activity *is*, or undefined when it is not one of them. */
  own: Tab | undefined,
  /** What to fall back to when the activity has no view of its own. */
  fallback: Tab,
): [Tab, (next: Tab) => void] {
  const [chosen, setChosen] = useState<Tab | undefined>(undefined);
  const key = own ?? "none";
  const [forKey, setForKey] = useState(key);
  if (forKey !== key) {
    // Deriving state from a prop change during render (React's documented
    // alternative to an effect): a new activity starts on its own view.
    setForKey(key);
    setChosen(undefined);
  }
  if (!own) return [fallback, setChosen];
  const wanted = chosen && views[chosen as "file" | "diff" | "terminal"] ? chosen : own;
  return [wanted, setChosen];
}

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
  const page = following ? data.liveItem : item;
  const showingMetrics = mode === "metrics";
  const showingChat = mode === "chat";
  // `active` stays the live tail even while a global page is up: the view tabs
  // are still *about* that activity, so leaving CHAT for TERMINAL has something
  // to show instead of landing on an empty sheet.
  const active = page;

  /**
   * The three activity views, derived from the activity the Stage is on.
   *
   * Not `lastByType` alone — that answered "the last diff anywhere in the run",
   * so clicking a `file_read` could leave an unrelated edit from ten activities
   * ago on screen. A tab here first tries to read *this* moment: a read has
   * FILE, an edit has DIFF and FILE, a command has TERMINAL.
   *
   * But a moment is often only one kind of thing (a thought is neither a file
   * nor a command), and disabling the other tabs made the Stage a page you
   * cannot navigate while following a live agent — the reader had to wait for
   * the agent to happen to run a command to look at the last one. So a tab the
   * moment cannot be read as falls back to the newest item of that kind in the
   * run (`lastByType`, which `useStageView` keeps fed), and the header says so
   * ("… · from 00:06") rather than silently showing a different moment.
   */
  const own = useMemo(() => activityViews(active), [active]);
  const lastByType = useStageStore((s) => s.lastByType);

  const views = useMemo(() => {
    // A *pinned* moment is a pin: it shows what that activity was, and the tabs
    // it cannot be read as stay disabled. Borrowing another moment is only for
    // following, where the page is a moving target and "the newest command"
    // still means "the run I am watching".
    if (!following) return own;
    const out = { ...own } as ActivityViews;
    for (const kind of ["file", "diff", "terminal"] as const) {
      if (out[kind]) continue;
      const item = lastByType[kind];
      if (!item) continue;
      out[kind] = activityViews(item)[kind];
    }
    return out;
  }, [own, lastByType, following]);

  /**
   * The tab this activity *is*.
   *
   * A thought, an egg and an approval are not one of the three views: they get
   * no lit tab (the sheet shows the card itself), which is why this returns
   * undefined for them instead of forcing TERMINAL — a pinned reasoning card
   * used to read "Terminal * (disabled)", which claims a view it does not have.
   */
  const ownKind: Tab | undefined =
    active?.type === "file" || active?.type === "diff" || active?.type === "terminal" ? active.type : undefined;
  // `ownKind` alone decides which view is up while the Stage follows or shows a
  // pinned moment; METRICS / CHAT are what the *mode* says, so they are read
  // from the store rather than folded into the same derivation — folding them
  // in made a returning tab pick up the mode from the previous render.
  // An activity with no view of its own (a thought, an egg, an approval) has no
  // lit tab: the card itself is the page, so it falls back to `card` — never to
  // another tab, which would claim a view this moment does not have.
  const [viewTab, setViewTab] = useActivityView(views, ownKind, active ? "card" : "metrics");
  const tab: Tab = showingMetrics ? "metrics" : showingChat ? "chat" : viewTab;
  const setTab = setViewTab;

  const chooseTab = (next: Tab) => {
    if (next === "metrics") {
      goMetrics();
      return;
    }
    if (next === "chat") {
      goChat();
      return;
    }
    // Clicking the tab that is already up is a no-op: Monitor's page is a pin,
    // so a tab is a way *to* a page, never a toggle away from it (⏎ / the pin
    // bar are the way back).
    if (next === tab) return;
    // Leaving METRICS or CHAT for a view tab means "show me the work again":
    // those two pages are not a pin, so there is no moment to fall back to.
    if (tab === "metrics" || tab === "chat") goLive();
    setTab(next);
  };

  const available: Record<Tab, boolean> = {
    file: views.file !== undefined,
    diff: views.diff !== undefined,
    terminal: views.terminal !== undefined,
    metrics: true,
    chat: true,
    // Not a tab in the strip: the card is what the sheet shows when nothing
    // else applies, so it is "available" exactly when there is a card.
    card: active !== undefined,
  };

  const shownItem =
    tab === "metrics" || tab === "chat"
      ? undefined
      : tab === "card"
        ? active
        : (views[tab as "file" | "diff" | "terminal"] ?? views[ownKind as "file" | "diff" | "terminal"] ?? active);

  /**
   * Whether the page is showing a *different* moment than the one selected.
   *
   * The fallback above is useful but it must not lie: if the reader is pinned
   * on a thought and TERMINAL shows the command from four minutes ago, the
   * header has to say which moment it came from.
   */
  const borrowed =
    tab !== "metrics" &&
    tab !== "chat" &&
    tab !== "card" &&
    active !== undefined &&
    shownItem !== undefined &&
    shownItem.id !== active.id
      ? shownItem
      : undefined;

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
        : (() => {
            const described = describe(shownItem, data, t);
            if (!borrowed) return described;
            return {
              ...described,
              sub: `${described.sub} \u00b7 ${t("from {time}", { time: formatClock(borrowed.createdAt) })}`,
            };
          })();

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
              disabled={!available[entry]}
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
      {!following && !showingMetrics && !showingChat && active ? (
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
): StageHeader {
  const time = item ? formatClock(item.createdAt) : "—";
  if (!item) {
    const phase = data.phase;
    return {
      chip: <Chip tone="mute">{t(phaseWord(phase)).toUpperCase()}</Chip>,
      chipText: t(phaseWord(phase)).toUpperCase(),
      title: data.liveHeadline ?? t("Waiting for the first activity…"),
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

  const seekRatio = (ratio: number) => seekTo(data.run!.startedAt + Math.min(1, Math.max(0, ratio)) * total);

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
        <button
          type="button"
          className="mon-tl__play"
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
          title={inReplay && replayStatus === "playing" ? t("Pause") : t("Replay from the start")}
          aria-label={inReplay && replayStatus === "playing" ? t("Pause") : t("Replay from the start")}
          // Same height as the track: the glyph then centres on the middle lane
          // instead of sitting at the top of the strip.
          style={{ height: trackHeight }}
        >
          {inReplay && replayStatus === "playing" ? "⏸" : "▶"}
        </button>

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
