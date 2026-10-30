import { useEffect, useRef, useState } from "react";
import { formatClock } from "../../lib/format";
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
 * Everything it draws comes from `useRoundsData`, one derivation over the
 * same stores and pure libraries the other faces read — no second server
 * contract, no forked engine.
 */

/** One size for every top-level window; another for every child window. */
const TOP_SIZE = { w: 440, h: 430 };
const CHILD_SIZE = { w: 580, h: 470 };

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
   * The agent's own window: whenever the current action is something worth
   * showing (a file, a diff, a terminal), a window pops up with it. A new
   * action pops it again; ✕ dismisses this action's window only. Thinking
   * stays on the scene's thought line — it is not an "operation".
   */
  const [dismissed, setDismissed] = useState<string | undefined>(undefined);
  const itemId = data.item?.id;
  useEffect(() => {
    if (itemId) setDismissed((d) => (d === itemId ? d : undefined));
  }, [itemId]);
  const actionKind = data.item?.payload.kind;
  const actionWorthy =
    actionKind === "file" || actionKind === "diff" || actionKind === "terminal" || actionKind === "approval";
  const showAction = actionWorthy && dismissed !== itemId;
  const dismissAction = () => setDismissed(itemId);

  /** The action window's title: the subject of the action, in one line. */
  const actionTitle =
    data.item?.payload.kind === "file"
      ? data.item.payload.path
      : data.item?.payload.kind === "diff"
        ? data.item.payload.path
        : (data.item?.title ?? "");

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
          <ChatThread className="rounds-wallpaper__thread" />
        </div>

        <RoundsScene data={data} onLive={goLive} />

        <RoundsStory data={data} onLive={goLive} />

        <RoundsChat />

        {showAction && data.item ? (
          <RoundsWindow
            key={`action-${itemId}`}
            title={actionTitle}
            initial={{ x: 470, y: 60 }}
            size={CHILD_SIZE}
            z={zmap["action"] ?? 2}
            onFocus={() => focus("action")}
            onClose={dismissAction}
          >
            {data.item.payload.kind === "file" ? (
              <RoundsPeek item={data.item} />
            ) : (
              <div className="rounds-win__stage">
                <StageItemView item={data.item} />
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
            <DockBody data={data} panel={panel} onOpenEggMetrics={openEggMetrics} />
          </RoundsWindow>
        ))}

        {metricsWins.map(({ pid, name }, index) => (
          <RoundsWindow
            key={`metrics-${pid}`}
            title={`${name} · ${t("Metrics")}`}
            initial={{ x: 130 + index * 36, y: 110 + index * 30 }}
            size={CHILD_SIZE}
            z={zmap[`metrics-${pid}`] ?? 1}
            onFocus={() => focus(`metrics-${pid}`)}
            onClose={() => setMetricsWins((wins) => wins.filter((w) => w.pid !== pid))}
          >
            <div className="rounds-win__stage">
              <MetricsDashboard embedded />
            </div>
          </RoundsWindow>
        ))}

        <RoundsDock data={data} open={dockWins} setPanel={toggleDock} />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
