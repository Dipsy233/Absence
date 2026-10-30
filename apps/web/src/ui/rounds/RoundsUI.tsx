import { useEffect, useRef, useState } from "react";
import { formatClock } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../lib/i18n";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { leaveSession } from "../../stores/reset";
import { VIEW_MODES, viewModeSpec } from "../../lib/viewMode";
import { useViewModeStore } from "../../stores/viewModeStore";
import { WindowControls } from "../../components/common/WindowControls";
import { ChatThread } from "../../components/chat/ChatThread";
import { StageItemView } from "../../components/stage/StageItemView";
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
 * The proposal's spirit (b.html): the character on its own stage, the story
 * underneath, and everything else as *windows on a desktop*. The right side's
 * wallpaper is the conversation itself — a transparent chat; whenever the
 * agent does something, a window pops up showing it (the file in view, with
 * its progress bar); the dock's icons are shortcuts that open draggable
 * floating windows. Egg toasts are deliberately absent for now.
 *
 * Everything it draws comes from `useRoundsData`, one derivation over the
 * same stores and pure libraries the other faces read — no second server
 * contract, no forked engine.
 */
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
  const desktop = Boolean(window.absenceDesktop);

  /** Open dock windows, in open order (later windows stack on top). */
  const [dockWins, setDockWins] = useState<DockPanel[]>([]);
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

  /**
   * The agent's own window: whenever the current action is something worth
   * showing (a file, a diff, a terminal), a window pops up with it. A new
   * action pops it again; ✕ dismisses this action's window only. Thinking
   * stays on the scene's thought line, and egg updates live in the dock —
   * neither is an "operation" the reader needs a window for.
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

      <div className="rounds-main">
        <div className="rounds-left">
          <RoundsScene data={data} onLive={goLive} />
          <RoundsStory data={data} onLive={goLive} />
        </div>

        {/*
          The desktop: the conversation is the wallpaper (transparent, so the
          moving ambience shows through), and the windows — the agent's own
          action window and the dock's shortcuts — float above it.
        */}
        <div className="rounds-right">
          <div className="rounds-wallpaper">
            <ChatThread className="rounds-wallpaper__thread" />
            <RoundsChat />
          </div>

          {showAction && data.item ? (
            <RoundsWindow
              key={`action-${itemId}`}
              title={actionTitle}
              initial={{ x: 60, y: 48 }}
              width={500}
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
              initial={{ x: 40 + index * 34, y: 36 + index * 30 }}
              width={420}
              z={zmap[panel] ?? 1}
              onFocus={() => focus(panel)}
              onClose={() => toggleDock(panel)}
            >
              <DockBody data={data} panel={panel} />
            </RoundsWindow>
          ))}
        </div>

        <RoundsDock data={data} open={dockWins} setPanel={toggleDock} />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
