import { useEffect, useState } from "react";
import { useT } from "../../lib/i18n";

/**
 * The desktop shell's self-rendered window controls (min / max / close),
 * replacing the native title bar (frame: false in apps/desktop/main.cjs).
 * Rendered only inside Electron — `window.absenceDesktop` is undefined in a
 * plain browser tab, so the web app shows nothing. Close goes through the
 * shell's close handler, which hides to the tray; real quit stays in the
 * tray menu.
 */
export function WindowControls() {
  const t = useT();
  const [maximized, setMaximized] = useState(false);
  const shell = window.absenceDesktop;

  useEffect(() => {
    if (!shell) return;
    let mounted = true;
    void shell.isMaximized().then((value) => mounted && setMaximized(value));
    const unsubscribe = shell.onMaximizedChanged((value) => setMaximized(value));
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [shell]);

  if (!shell) return null;

  const base = "flex h-full w-11 items-center justify-center text-desk-dim transition-colors";
  return (
    <div className="absence-nodrag flex h-8 shrink-0 items-stretch">
      <button
        type="button"
        title={t("Minimize")}
        onClick={() => shell.minimize()}
        className={`${base} hover:bg-desk-panel2 hover:text-desk-ink`}
      >
        {/* a minus drawn at mid-height, matching the native glyph's weight */}
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <line x1="0" y1="5" x2="10" y2="5" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
      <button
        type="button"
        title={maximized ? t("Restore") : t("Maximize")}
        onClick={() => shell.toggleMaximize()}
        className={`${base} hover:bg-desk-panel2 hover:text-desk-ink`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          {maximized ? (
            <>
              <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" fill="none" />
              <path d="M2.5 2.5 V0.5 H9.5 V7.5 H7.5" stroke="currentColor" strokeWidth="1" fill="none" />
            </>
          ) : (
            <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" />
          )}
        </svg>
      </button>
      <button
        type="button"
        title={t("Close (hides to tray)")}
        onClick={() => shell.close()}
        className={`${base} hover:bg-[#c0392b] hover:text-white`}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <line x1="0" y1="0" x2="10" y2="10" stroke="currentColor" strokeWidth="1" />
          <line x1="10" y1="0" x2="0" y2="10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
