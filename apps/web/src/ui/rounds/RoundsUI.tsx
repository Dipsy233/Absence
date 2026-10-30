import { useRef, useState } from "react";
import { isAgentBusy } from "@absence/core";
import { formatBytes, formatClock } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../lib/i18n";
import { useStageStore } from "../../stores/stageStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { leaveSession } from "../../stores/reset";
import { VIEW_MODES, viewModeSpec } from "../../lib/viewMode";
import { useViewModeStore } from "../../stores/viewModeStore";
import { WindowControls } from "../../components/common/WindowControls";
import { ChatThread } from "../../components/chat/ChatThread";
import { StageItemView } from "../../components/stage/StageItemView";
import { MetricsDashboard } from "../../components/metrics/MetricsDashboard";
import { knownFileItem, userFileItem } from "../../lib/openFile";
import type { ActivityRow, StageItem } from "../../types/stage";
import { Chip, Dot } from "../monitor/atoms";
import { useRoundsData } from "./useRoundsData";
import { RoundsScene } from "./RoundsScene";
import { RoundsPeek } from "./RoundsPeek";
import { RoundsStory } from "./RoundsStory";
import { RoundsChat } from "./RoundsChat";
import { RoundsDock, DockBody, WINDOW_TITLE, type DockPanel } from "./RoundsDock";
import { RoundsWindow } from "./RoundsWindow";
import "./rounds.css";
import "../monitor/monitor.css";

/**
 * ROUNDS (查房陪诊) — the light face, as a desktop.
 *
 * The whole area *is* a desktop: the ambience moves behind everything, the
 * conversation is the wallpaper (a transparent chat floating over it like a
 * lyrics overlay, on the right and above the story), the character stands on
 * the left, and windows open on top of it all. The dock's icons are
 * shortcuts — Files, Folder, Eggs, Run — each opening a floating window of
 * the one uniform sibling size; windows opened *from inside* a window (a
 * file's content, one egg's metrics) share the child size; both resize by
 * their corner handle. The agent's own actions pop their window too. Egg
 * toasts are deliberately absent for now.
 *
 * Files and Agent Folder are the reader's own browsers: what they click opens
 * a file window and nothing else — the Stage keeps following (or keeps its
 * pin), because reading a file must not move the run out from under the
 * reader.
 *
 * Everything it draws comes from `useRoundsData`, one derivation over the
 * same stores and pure libraries the other faces read — no second server
 * contract, no forked engine.
 */

/** One size for every top-level window; another for every child window. */
const TOP_SIZE = { w: 440, h: 430 };
const CHILD_SIZE = { w: 580, h: 470 };

/**
 * Level one opens on the left, near the shortcuts that spawn it; a child —
 * a file's content, an egg's metrics, the live page — opens at the conversation
 * overlay's top-left corner (`.rounds-wallpaper`: 46% of the width, 76px off
 * the right edge), the part of the desktop still free. Each further window
 * steps toward the lower right, so a stack reads as a stack.
 */
function childSpot(index: number): { x: number; y: number } {
  return {
    x: Math.max(60, Math.round(window.innerWidth * 0.54) - 76 + index * 24),
    y: 10 + index * 26,
  };
}

/**
 * The title bar carries what a stage toolbar would: the file, the version when
 * it is one, the size, and the line range (the whole file's when the content
 * is not a slice). A long path truncates; the hover title still has all of it.
 */
function fileWindowTitle(item: StageItem): string {
  const payload = item.payload;
  if (payload.kind !== "file") return item.title;

  const parts = [payload.path];
  if (payload.version !== undefined) parts.push(`v${payload.version}`);
  parts.push(formatBytes(payload.content.length));
  parts.push(
    payload.startLine !== undefined && payload.endLine !== undefined
      ? `${payload.startLine}–${payload.endLine}`
      : `1–${payload.content.split("\n").length}`,
  );
  if (payload.badge) parts.push(payload.badge);
  return parts.join(" · ");
}

/** The event window's title: the subject of the event, in one line. */
function itemTitle(item: StageItem): string {
  const payload = item.payload;
  if (payload.kind === "file" || payload.kind === "diff") return payload.path;
  if (payload.kind === "thought") return "Thinking";
  if (payload.kind === "speech") return "Reply";
  return item.title;
}

/** The newest event in the stream that has something to put on a page. */
function newestItem(rows: ActivityRow[]): StageItem | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    const item = rows[i]!.stageItem;
    if (item) return item;
  }
  return undefined;
}

export function RoundsUI() {
  const t = useT();
  const now = useNow(1000);
  const data = useRoundsData();
  const session = useSessionStore((s) => s.session);
  const connected = useSessionStore((s) => s.connected);
  const observed = useIsObserved();
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  const goLive = useStageStore((s) => s.goLive);
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const desktop = Boolean(window.absenceDesktop);

  /** Open dock windows, in open order (later windows stack on top). */
  const [dockWins, setDockWins] = useState<DockPanel[]>([]);
  /** Per-egg metrics windows (children of the Eggs window). */
  const [metricsWins, setMetricsWins] = useState<Array<{ pid: number; name: string }>>([]);
  /** Window stacking: each focus bumps the window above the others. */
  const [zmap, setZmap] = useState<Record<string, number>>({});
  const ztop = useRef(1);
  const focus = (id: string) => setZmap((m) => ({ ...m, [id]: ++ztop.current }));

  const toggleDock = (panel: DockPanel) => {
    setDockWins((wins) => {
      if (wins.includes(panel)) return wins.filter((w) => w !== panel);
      focus(panel);
      return [...wins, panel];
    });
  };

  const openEggMetrics = (pid: number, name: string) => {
    selectEgg(pid);
    setMetricsWins((wins) => (wins.some((w) => w.pid === pid) ? wins : [...wins, { pid, name }]));
    focus(`metrics-${pid}`);
  };

  /**
   * The reader's files, opened from the dock's windows. Identity is the content
   * itself — `disk:path` for the whole file, `v3:path` for one recorded version
   * — so v0 and v3 sit side by side instead of replacing each other, and the
   * whole file never replaces a version. Nothing here is written to the stage
   * store: opening a file is reading, not pinning.
   */
  const [fileWins, setFileWins] = useState<Array<{ id: string; item: StageItem }>>([]);

  const showFileWindow = (id: string, item: StageItem) => {
    setFileWins((wins) => (wins.some((w) => w.id === id) ? wins : [...wins, { id, item }]));
    focus(id);
  };

  const openFileWindow = (path: string) => {
    void userFileItem(path).then((item) => showFileWindow(`disk:${path}`, item));
  };

  const openVersionWindow = (path: string, version?: number) => {
    const item = knownFileItem(path, version);
    if (!item || item.payload.kind !== "file") return;
    showFileWindow(`v${item.payload.version}:${path}`, item);
  };

  /**
   * One of a run's events, opened from the Run window. Identity is the item,
   * so clicking the same event again brings its window forward instead of
   * opening a second one — and a still-growing answer updates its page in place.
   */
  const [eventWins, setEventWins] = useState<Array<{ id: string; item: StageItem }>>([]);

  const openEventWindow = (item: StageItem) => {
    setEventWins((wins) =>
      wins.some((w) => w.id === item.id)
        ? wins.map((w) => (w.id === item.id ? { id: w.id, item } : w))
        : [...wins, { id: item.id, item }],
    );
    focus(`event-${item.id}`);
  };

  /**
   * The live activity window: while the agent is actually working, its newest
   * event gets its own page, the way Classic's Stage and Monitor's centre pop
   * the current event. One window is kept and its content replaced — never one
   * per event — and only events that have something to show move it: a tool
   * row or a run boundary leaves the last page standing.
   *
   * It does not live on screen: the dock's Activity shortcut is its switch and
   * its ✕ is the same switch off. Nor does it appear while pinned or replaying
   * (the reader chose that view) or once the agent settles — the page belongs
   * to the run, not to the desktop.
   *
   * What it draws is the newest row's own item, not the Stage's pin, so nothing
   * here touches the stage store.
   */
  const [liveOn, setLiveOn] = useState(true);
  const live = liveOn && data.mode === "live" && data.following && isAgentBusy(data.status);
  const liveItem = live ? newestItem(data.rows) : undefined;

  return (
    <div className="mon-root rounds-root mon-shell">
      <header className={`rounds-top${desktop ? " mon-drag" : ""}`}>
        <span className="mon-logo">ABSENCE</span>
        <span className="mon-mono rounds-top__clock">{formatClock(now)}</span>

        {session ? (
          <div className="mon-termcard mon-nodrag" title={t("Connected terminal and session id")}>
            <span className="mon-termcard__term">{session.agentRuntime}</span>
            <span className="mon-termcard__sep" aria-hidden />
            <span className="mon-termcard__sid mon-mono">{session.id}</span>
          </div>
        ) : null}

        <span className="rounds-top__run" title={data.run?.prompt}>
          {data.run ? `#${data.run.index} — ${data.run.prompt || t("(observed activity)")}` : t("No run yet")}
        </span>

        <span className="mon-bar__spacer" aria-hidden />

        <div className="mon-modes mon-nodrag" role="group" aria-label={t("Interface mode")}>
          {VIEW_MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={mode === entry.id}
              disabled={!entry.ready}
              onClick={() => setMode(entry.id)}
              title={`${entry.name} — ${entry.intent}`}
            >
              {entry.name}
            </button>
          ))}
        </div>

        {observed ? <Chip tone="read">{t("OBSERVING")}</Chip> : null}

        <Chip tone={connected ? "edit" : "err"} title={connected ? t("online") : t("offline")}>
          <Dot tone={connected ? "edit" : "err"} />
          {connected ? t("online") : t("offline")}
        </Chip>

        <button type="button" className="mon-btn mon-btn--ghost mon-nodrag" onClick={() => void leaveSession()}>
          {t("change")}
        </button>

        <WindowControls />
      </header>

      {/*
        The desktop, one relative canvas: the conversation floats on the right
        and above the story like a lyrics overlay; the character stands on the
        left; the story runs the full width under both; windows open on top.
      */}
      <div className="rounds-main">
        <div className="rounds-wallpaper">
          <ChatThread className="rounds-wallpaper__thread" layout="bubbles" />
        </div>

        <RoundsScene data={data} onLive={goLive} />

        <RoundsStory data={data} onLive={goLive} />

        <RoundsChat />

        {liveItem ? (
          <RoundsWindow
            key="activity"
            accent="live"
            title={itemTitle(liveItem)}
            initial={childSpot(0)}
            size={CHILD_SIZE}
            z={zmap.activity ?? 2}
            onFocus={() => focus("activity")}
            onClose={() => setLiveOn(false)}
          >
            {liveItem.payload.kind === "file" ? (
              <RoundsPeek item={liveItem} />
            ) : (
              <div className="rounds-win__stage">
                <StageItemView item={liveItem} />
              </div>
            )}
          </RoundsWindow>
        ) : null}

        {dockWins.map((panel, index) => (
          <RoundsWindow
            key={panel}
            title={t(WINDOW_TITLE[panel])}
            initial={{ x: 60 + index * 36, y: 40 + index * 30 }}
            size={TOP_SIZE}
            z={zmap[panel] ?? 1}
            onFocus={() => focus(panel)}
            onClose={() => toggleDock(panel)}
          >
            <DockBody
              data={data}
              panel={panel}
              onOpenEggMetrics={openEggMetrics}
              onOpenFile={openFileWindow}
              onOpenVersion={openVersionWindow}
              onOpenEvent={openEventWindow}
            />
          </RoundsWindow>
        ))}

        {fileWins.map(({ id, item }, index) => (
          <RoundsWindow
            key={id}
            title={fileWindowTitle(item)}
            initial={childSpot(index)}
            size={CHILD_SIZE}
            z={zmap[id] ?? 1}
            onFocus={() => focus(id)}
            onClose={() => setFileWins((wins) => wins.filter((w) => w.id !== id))}
          >
            <div className="rounds-win__stage">
              <StageItemView item={item} showToolbar={false} />
            </div>
          </RoundsWindow>
        ))}

        {eventWins.map(({ id, item }, index) => (
          <RoundsWindow
            key={`event-${id}`}
            title={itemTitle(item)}
            initial={childSpot(index)}
            size={CHILD_SIZE}
            z={zmap[`event-${id}`] ?? 1}
            onFocus={() => focus(`event-${id}`)}
            onClose={() => setEventWins((wins) => wins.filter((w) => w.id !== id))}
          >
            {item.payload.kind === "file" ? (
              <RoundsPeek item={item} />
            ) : (
              <div className="rounds-win__stage">
                <StageItemView item={item} />
              </div>
            )}
          </RoundsWindow>
        ))}

        {metricsWins.map(({ pid, name }, index) => (
          <RoundsWindow
            key={`metrics-${pid}`}
            title={`${name} · ${t("Metrics")}`}
            initial={childSpot(index)}
            size={CHILD_SIZE}
            z={zmap[`metrics-${pid}`] ?? 1}
            onFocus={() => focus(`metrics-${pid}`)}
            onClose={() => setMetricsWins((wins) => wins.filter((w) => w.pid !== pid))}
          >
            <div className="rounds-win__stage">
              <MetricsDashboard embedded eggPid={pid} />
            </div>
          </RoundsWindow>
        ))}

        <RoundsDock
          data={data}
          open={dockWins}
          live={liveOn}
          setPanel={toggleDock}
          onToggleLive={() => setLiveOn((on) => !on)}
        />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
