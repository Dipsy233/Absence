import { useEffect } from "react";
import { formatClock, formatContext, formatTokens } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../lib/i18n";
import { useStageStore } from "../../stores/stageStore";
import { useUiStore } from "../../stores/uiStore";
import { useViewModeStore } from "../../stores/viewModeStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { leaveSession } from "../../stores/reset";
import { VIEW_MODES, viewModeSpec } from "../../lib/viewMode";
import { WindowControls } from "../../components/common/WindowControls";
import { Chip, Dot, attentionTone, type MonTone } from "./atoms";
import { MonitorLeft } from "./MonitorLeft";
import { MonitorStage } from "./MonitorStage";
import { MonitorRight } from "./MonitorRight";
import { useMonitorData } from "./useMonitorData";
import type { ActivityRow } from "../../types/stage";
import "./monitor.css";
/**
 * MONITOR (机器监护) — the heavy face.
 *
 * Three columns, one screen: what the agent did (left), what it is looking at
 * (centre), who it is and what it costs (right). The avatar is a status light
 * in the corner, not the subject; the subject is the trace.
 *
 * Everything it draws comes from `useMonitorData`, so the phase, the attention
 * verdict and the rail's counters can never disagree about the same run.
 */
export function MonitorUI() {
  const t = useT();
  useNow(1000);
  const data = useMonitorData();
  const session = useSessionStore((s) => s.session);
  const connected = useSessionStore((s) => s.connected);
  const context = useSessionStore((s) => s.context);
  const observed = useIsObserved();
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);

  const openStage = useStageStore((s) => s.openStage);
  const goLive = useStageStore((s) => s.goLive);
  const toggleReport = useUiStore((s) => s.toggleReport);
  const selectRun = useUiStore((s) => s.selectRun);

  // The keyboard contract: ⏎ back to live, ⌘/Ctrl+R the report. Both are
  // deliberately absent from Classic, which has its own toolbar.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        goLive();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "r") {
        event.preventDefault();
        toggleReport();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goLive, toggleReport]);
  const open = (row: ActivityRow) => {
    if (!row.stageItem) return;
    openStage(row.stageItem);
  };

  const used = context?.used ?? null;
  const total = context?.total ?? null;
  const percent = used !== null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const attentionToneNow = attentionTone(data.attention.level);
  const runTone: MonTone =
    data.run?.status === "running" ? "run" : data.run?.status === "error" ? "err" : data.run ? "edit" : "mute";

  const desktop = Boolean(window.absenceDesktop);

  return (
    <div className="mon-root mon-shell">
      <header className={`mon-bar${desktop ? " mon-drag" : ""}`}>
        <span className="mon-logo">ABSENCE</span>
        <span className="mon-mono" style={{ fontSize: 12, color: "var(--mon-t3)" }}>
          {formatClock(Date.now())}
        </span>

        <span
          className="mon-mono"
          style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontSize: 12, color: "var(--mon-t2)" }}
          title={session?.projectPath}
        >
          {session?.projectPath ?? t("no session")}
        </span>

        <div className="mon-modes" role="group" aria-label={t("Interface mode")}>
          {VIEW_MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              aria-pressed={mode === entry.id}
              disabled={!entry.ready}
              onClick={() => setMode(entry.id)}
              title={`${entry.name} · ${entry.zh} — ${entry.intent}`}
            >
              {entry.name}
              <em>{entry.zh}</em>
            </button>
          ))}
        </div>

        {data.run ? (
          <Chip tone={runTone}>
            <Dot tone={runTone} />
            {`#${data.run.index}`}
            {data.run.status === "running" ? ` · ${t("live")}` : ""}
          </Chip>
        ) : null}

        {data.attention.level !== "none" ? (
          <Chip tone={attentionToneNow} title={t("Human attention")}>
            {t("attention").toUpperCase()} · {t(data.attention.level)}
          </Chip>
        ) : null}

        {observed ? (
          <Chip tone="read">{t("OBSERVING")}</Chip>
        ) : (
          <Chip tone={connected ? "edit" : "err"}>
            <Dot tone={connected ? "edit" : "err"} />
            {connected ? t("live") : t("offline")}
          </Chip>
        )}

        <div className="mon-nodrag" style={{ display: "flex", alignItems: "center", gap: 7 }} title={t("context usage")}>
          <span className="mon-mono" style={{ fontSize: 11, color: "var(--mon-t3)" }}>
            {formatContext(used, total)}
          </span>
          <span style={{ width: 72, height: 5, borderRadius: 3, background: "var(--mon-s3)", overflow: "hidden" }}>
            <span style={{ display: "block", height: "100%", width: `${percent}%`, background: "var(--mon-acc)" }} />
          </span>
          <span className="mon-mono" style={{ fontSize: 10.5, color: "var(--mon-t3)" }}>
            {formatTokens(total)}
          </span>
        </div>

        <button type="button" className="mon-btn mon-btn--ghost mon-nodrag" onClick={() => void leaveSession()}>
          {t("change")}
        </button>

        <WindowControls />
      </header>

      <div className="mon-body">
        <MonitorLeft
          data={data}
          onOpen={open}
          onSelectRun={(id) => {
            selectRun(id);
            goLive();
          }}
        />
        <MonitorStage data={data} />
        <MonitorRight data={data} />
      </div>

      <p className="sr-only">{viewModeSpec(mode).intent}</p>
    </div>
  );
}
