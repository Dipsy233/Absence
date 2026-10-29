import { useState } from "react";
import { formatClock } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../lib/i18n";
import { useStageStore } from "../../stores/stageStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { leaveSession } from "../../stores/reset";
import { VIEW_MODES, viewModeSpec } from "../../lib/viewMode";
import { useViewModeStore } from "../../stores/viewModeStore";
import { WindowControls } from "../../components/common/WindowControls";
import { Chip, Dot } from "../monitor/atoms";
import { useRoundsData } from "./useRoundsData";
import { RoundsScene } from "./RoundsScene";
import { RoundsPeek } from "./RoundsPeek";
import { RoundsStory } from "./RoundsStory";
import { RoundsChat } from "./RoundsChat";
import { RoundsDock, RoundsDrawer, type DockPanel } from "./RoundsDock";
import "./rounds.css";
import "../monitor/monitor.css";

/**
 * ROUNDS (查房陪诊) — the light face: the agent leads, you follow.
 *
 * The proposal's shape (b.html): the character on its own stage — never under
 * text — with a bubble saying what it is doing and a quiet line quoting its
 * thought; the code it is looking at on the right with a progress bar for how
 * far the read reached; the run's steps as a story of cards underneath, each
 * clickable to rewind; and everything else folded into an icon dock on the
 * right edge that expands a stage over the peek.
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
  const [dock, setDock] = useState<DockPanel | undefined>(undefined);
  const desktop = Boolean(window.absenceDesktop);

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
          {data.run
            ? `#${data.run.index} — ${data.run.prompt || t("(observed activity)")}`
            : t("No run yet")}
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
          <RoundsChat />
        </div>

        <div className="rounds-right">
          {dock ? <RoundsDrawer data={data} panel={dock} onClose={() => setDock(undefined)} /> : null}
          <RoundsPeek data={data} />
        </div>

        <RoundsDock data={data} panel={dock} setPanel={setDock} />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
