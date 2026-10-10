import { useNow } from "../../hooks/useNow";
import { formatClock, formatContext } from "../../lib/format";
import { THEMES, THEME_IDS } from "../../lib/theme";
import { WindowControls } from "../common/WindowControls";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { resetAllStores } from "../../stores/reset";

/** The session bar across the top (read02 §4). Inside the desktop shell it
 * doubles as the frameless window's title bar: drag region + window controls. */
export function SessionBar() {
  useNow(1000);
  const session = useSessionStore((s) => s.session);
  const context = useSessionStore((s) => s.context);
  const connected = useSessionStore((s) => s.connected);
  const absenceMode = useUiStore((s) => s.absenceMode);
  const toggleAbsenceMode = useUiStore((s) => s.toggleAbsenceMode);
  const theme = useUiStore((s) => s.theme);
  const cycleTheme = useUiStore((s) => s.cycleTheme);
  const desktop = Boolean(window.absenceDesktop);

  if (!session) return null;

  const used = context?.used ?? null;
  const total = context?.total ?? null;
  const percent = used !== null && total ? Math.min(100, Math.round((used / total) * 100)) : 0;

  return (
    <header
      className={[
        "relative flex shrink-0 items-center gap-3 overflow-hidden border border-desk-line bg-desk-panel px-3",
        desktop ? "absence-drag rounded-none border-t-0 border-r-0 border-l-0 pr-0" : "py-2 rounded-lg",
      ].join(" ")}
    >
      <span className="shrink-0 font-mono text-lg leading-none tracking-tight text-desk-ink">ABSENCE</span>
      <span className="shrink-0 font-mono text-xs text-desk-dim">{formatClock(Date.now())}</span>

      <span className="chip shrink-0">{session.id}</span>

      <span className="min-w-0 flex-1 truncate font-mono text-xs text-desk-ink/80" title={session.projectPath}>
        {session.projectPath}
      </span>

      {/* Dead centre of the bar: the ABSENCE-mode toggle. Ghosts the desk world over the
          Stage's content page while it is on. */}
      <div className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center">
        <button
          type="button"
          onClick={toggleAbsenceMode}
          title="Float the desk over the Stage's content page as a translucent ghost"
          className={[
            "pointer-events-auto rounded border px-2 py-0.5 font-mono text-[11px] tracking-widest transition-colors",
            absenceMode
              ? "border-desk-amber bg-desk-amber/10 text-desk-amber shadow-[0_0_12px_rgba(0,0,0,.3)]"
              : "border-desk-line text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber",
          ].join(" ")}
        >
          ABSENCE
        </button>
      </div>

      <span className="hidden shrink-0 font-mono text-xs text-desk-dim md:inline" title="model">
        {session.model ?? "—"}
      </span>

      <div className="hidden shrink-0 items-center gap-2 lg:flex" title="context usage">
        <span className="font-mono text-[11px] text-desk-dim">{formatContext(used, total)}</span>
        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-desk-panel2">
          <div
            className="h-full rounded-full bg-gradient-to-r from-desk-teal to-desk-amber transition-all duration-500"
            style={{ width: `${percent}%` }}
          />
        </div>
      </div>

      {session.degraded ? (
        <span className="shrink-0 rounded border border-desk-ember/50 bg-desk-ember/10 px-1.5 py-0.5 text-[10px] text-desk-ember">
          degraded · mock
        </span>
      ) : null}

      <span className={["shrink-0 font-mono text-[11px]", connected ? "text-desk-teal" : "text-desk-ember"].join(" ")}>
        {connected ? "live" : "offline"}
      </span>

      {/* Color theme cycler: amber → blue → green. The dot shows the current
          theme's accent. */}
      <button
        type="button"
        onClick={cycleTheme}
        title={`Color theme: ${theme} (click for ${THEME_IDS[(THEME_IDS.indexOf(theme) + 1) % THEME_IDS.length]})`}
        className="flex shrink-0 items-center gap-1.5 rounded border border-desk-line px-2 py-0.5 font-mono text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
      >
        <span
          aria-hidden
          className="h-2 w-2 rounded-full"
          style={{ background: THEMES[theme].accent }}
        />
        {theme}
      </button>

      <button
        type="button"
        onClick={resetAllStores}
        className="shrink-0 rounded border border-desk-line px-2 py-0.5 text-[11px] text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
        title="Close this session and pick another project"
      >
        change
      </button>

      <WindowControls />
    </header>
  );
}
