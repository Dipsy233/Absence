import { useState } from "react";
import { formatClock, formatContext, formatTokens } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useT } from "../../lib/i18n";
import { VIEW_MODES } from "../../lib/viewMode";
import { useViewModeStore } from "../../stores/viewModeStore";
import { useIsObserved, useSessionStore } from "../../stores/sessionStore";
import { leaveSession } from "../../stores/reset";
import { WindowControls } from "../common/WindowControls";
import { SettingsDialog } from "../common/SettingsDialog";
import { DripBagIcon } from "../common/DripBagIcon";
import { Chip, Dot } from "../../ui/shared/atoms";
import { Nixie } from "../../ui/shared/Nixie";
import "../../ui/shared/shared.css";
import "../../ui/shared/themes.css";
import { useUiStyleStore } from "../../stores/uistyleStore";

/**
 * The one top bar of the faces — Monitor's bar, worn by Rounds and Chart too.
 *
 * A face is a page; the bar is the window. It says which session this is
 * (`runtime · session id`), where it works (the project path), what the bar
 * itself controls (the face switcher, Drip, the context budget, the connection,
 * Change, the window buttons) — and nothing about the run. The run belongs to
 * the face: Rounds puts it on the desktop, Monitor in the rail, Chart in its
 * hero. Sharing the bar is what makes switching faces feel like turning a page
 * rather than changing programs.
 *
 * Drip is a toggle here, not a face: a small circle left of the switcher.
 * On, it floats over the face in its own always-on-top window; off, that
 * window goes away. The face underneath is never closed or replaced.
 */
export function FaceBar() {
  const t = useT();
  const now = useNow(1000);
  const session = useSessionStore((s) => s.session);
  const connected = useSessionStore((s) => s.connected);
  const context = useSessionStore((s) => s.context);
  const observed = useIsObserved();
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);
  const drip = useViewModeStore((s) => s.drip);
  const toggleDrip = useViewModeStore((s) => s.toggleDrip);
  const desktop = Boolean(window.absenceDesktop);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const used = context?.used ?? null;
  const total = context?.total ?? null;
  const percent = used !== null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return (
    <>
      <header className={`mon-bar${desktop ? " mon-drag" : ""}`}>
      <span className="mon-logo">ABSENCE</span>
      <span className="mon-mono" style={{ fontSize: 12, color: "var(--mon-t3)" }}>
        {/* `now`, not `Date.now()`: the component re-renders once a second
            through useNow, but a fresh Date.now() in JSX alone still froze the
            read at whatever the first render saw. */}
        {formatClock(now)}
      </span>

      {/* The attached terminal and the session id — the handle you quote when
          pointing someone (or a report) at what you are watching. It sits
          before the project path: which session, then where it works. */}
      {session ? (
        <div className="mon-termcard mon-nodrag" title={t("Connected terminal and session id")}>
          <span className="mon-termcard__term">{session.agentRuntime}</span>
          <span className="mon-termcard__sep" aria-hidden />
          <span className="mon-termcard__sid mon-mono">{session.id}</span>
        </div>
      ) : null}

      <span className="mon-mono mon-bar__path" title={session?.projectPath}>
        {session?.projectPath ?? t("no session")}
      </span>

      {/* Everything from here on is pushed to the right edge. */}
      <span className="mon-bar__spacer" aria-hidden />

      {/* Drip: a widget switch, not a destination. It sits immediately left of
          the face switcher because it floats over the face rather than
          replacing it. */}
      <button
        type="button"
        aria-pressed={drip}
        onClick={toggleDrip}
        className="mon-drip mon-nodrag"
        title={drip ? t("Drip is on — click to hide it") : t("Drip is off — click to float it")}
      >
        {/* The IV bag itself, ported whole from the standalone page
            (E:/dd/1.html): on fills it — liquid rises, the surface waves,
            bubbles leave the outlet — off drains it. The drawing lives in
            DripBagIcon; the animation, keyed off this button's aria-pressed,
            in shared.css. */}
        <DripBagIcon />
      </button>

      <div className="mon-modes" role="group" aria-label={t("Interface mode")}>
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

      <div className="mon-nodrag" style={{ display: "flex", alignItems: "center", gap: 7 }} title={t("context usage")}>
        {/* The used-tokens figure arrives whenever the streaming run spends
            more context: the digits land, the meter is structure. */}
        <span className="mon-mono" style={{ fontSize: 11, color: "var(--mon-t3)" }}>
          <Nixie value={formatContext(used, total)} />
        </span>
        <span style={{ width: 72, height: 5, borderRadius: 3, background: "var(--mon-s3)", overflow: "hidden" }}>
          <span style={{ display: "block", height: "100%", width: `${percent}%`, background: "var(--mon-acc)" }} />
        </span>
        <span className="mon-ctx-meter__total mon-mono" style={{ fontSize: 10.5, color: "var(--mon-t3)" }}>
          {formatTokens(total)}
        </span>
      </div>

      {/* The connection — "online", deliberately not "live": LIVE is the
          centre column's clock word, and the two must not collide. */}
      <Chip tone={connected ? "edit" : "err"} title={connected ? t("online") : t("offline")}>
        <Dot tone={connected ? "edit" : "err"} />
        {connected ? t("online") : t("offline")}
      </Chip>

      {/* Settings. The dialog renders as the header's sibling, inside the
          face root — the face's `--desk-*` bridge re-points the dialog's
          classes at this face's palette, and being outside the bar keeps it
          clear of the drag region. */}
      <button
        type="button"
        className="mon-btn mon-btn--ghost mon-nodrag"
        onClick={() => setSettingsOpen(true)}
        title={t("Settings")}
        aria-label={t("Settings")}
        aria-haspopup="dialog"
      >
        <span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>
          ⚙
        </span>
      </button>

      <button type="button" className="mon-btn mon-btn--ghost mon-nodrag" onClick={() => void leaveSession()}>
        {t("change")}
      </button>

      <WindowControls />
    </header>

    <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
  </>
  );
}
