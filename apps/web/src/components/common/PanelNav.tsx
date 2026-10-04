import type { ReactNode } from "react";

interface PanelNavProps {
  title: string;
  onBack?: () => void;
  subtitle?: string;
  right?: ReactNode;
}

/** A lightweight in-panel header used when drilling into detail (read02 §6). */
export function PanelNav({ title, onBack, subtitle, right }: PanelNavProps) {
  return (
    <div className="mb-2 flex items-center gap-2 border-b border-desk-line pb-2">
      {onBack ? (
        <button
          type="button"
          onClick={onBack}
          className="shrink-0 rounded border border-desk-line px-1.5 py-0.5 text-xs text-desk-dim hover:border-desk-amber/60 hover:text-desk-amber"
          title="Back"
        >
          ←
        </button>
      ) : null}
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-xs text-desk-ink" title={title}>
          {title}
        </div>
        {subtitle ? <div className="truncate text-[10px] text-desk-dim">{subtitle}</div> : null}
      </div>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}
