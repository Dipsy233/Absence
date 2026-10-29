import { useViewModeStore } from "../../stores/viewModeStore";
import { VIEW_MODES } from "../../lib/viewMode";
import { useT } from "../../lib/i18n";

/**
 * The face switcher, in Classic's session bar.
 *
 * Monitor has the same control in its own header; Classic needs one too, or a
 * user who landed in Classic (the stored default before this branch) could not
 * reach any of the new faces. Same store, same disabled-until-ready rule.
 */
export function ViewModeSwitch({ compact = false }: { compact?: boolean }) {
  const t = useT();
  const mode = useViewModeStore((s) => s.mode);
  const setMode = useViewModeStore((s) => s.setMode);

  return (
    <div
      className="flex shrink-0 items-center gap-0.5 rounded border border-desk-line bg-desk-bg p-0.5"
      role="group"
      aria-label={t("Interface mode")}
    >
      {VIEW_MODES.map((entry) => (
        <button
          key={entry.id}
          type="button"
          aria-pressed={mode === entry.id}
          disabled={!entry.ready}
          onClick={() => setMode(entry.id)}
          title={`${entry.name} · ${entry.zh} — ${entry.intent}`}
          className={[
            "flex items-center gap-1 rounded px-1.5 font-mono text-[10px] leading-5 transition-colors",
            mode === entry.id
              ? "bg-desk-panel2 font-semibold text-desk-ink"
              : "text-desk-dim enabled:hover:bg-desk-panel2 enabled:hover:text-desk-ink",
            "disabled:cursor-not-allowed disabled:opacity-35",
          ].join(" ")}
        >
          {compact ? entry.name.slice(0, 3) : entry.name}
          {compact ? null : <span className="text-[9px] text-desk-dim/70">{entry.zh}</span>}
        </button>
      ))}
    </div>
  );
}
