import { useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useFileStore } from "../../stores/fileStore";
import type { StageItem } from "../../types/stage";

/**
 * The action window's body for a file: the code the agent is looking at, with
 * one honest line above it — how far through the file the read reached.
 *
 * The payload's content *is* the agent's context (the slice it read), so the
 * body renders exactly that; the progress bar answers the question the slice
 * alone cannot — "how much of the file is this?" — by comparing the read's end
 * line against the file's full length from the Agent Folder store.
 */
export function RoundsPeek({ item }: { item: StageItem }) {
  const t = useT();
  const files = useFileStore((s) => s.files);

  const { total, from, to } = useMemo(() => {
    if (item.payload.kind !== "file") return { total: 0, from: 0, to: 0 };
    const p = item.payload;
    const contentLines = p.content.length === 0 ? 0 : p.content.split("\n").length;
    const stored = files[p.path];
    const storedLines = stored ? stored.content.split("\n").length : 0;
    const start = p.rangeKnown === false ? 1 : p.startLine ?? p.lineOffset ?? 1;
    const end = p.rangeKnown === false ? contentLines : p.endLine ?? start + contentLines - 1;
    return { total: Math.max(storedLines, end, contentLines), from: start, to: end };
  }, [item, files]);

  if (item.payload.kind !== "file") return null;
  const p = item.payload;
  const lines = p.content.length === 0 ? [] : p.content.split("\n");
  const fraction = total > 0 ? Math.min(1, to / total) : 1;

  return (
    <div className="rounds-peek">
      <div className="rounds-peek__head">
        <span className="rounds-chip rounds-chip--read">READ</span>
        <span className="rounds-peek__n" title={p.path}>
          {p.path}
        </span>
        <span className="rounds-peek__hint">{t("Agent's view")}</span>
      </div>

      <div className="rounds-peek__bar">
        <span>{t("in context")}</span>
        <span className="rounds-peek__track" aria-hidden>
          <span className="rounds-peek__fill" style={{ width: `${Math.max(2, fraction * 100)}%` }} />
        </span>
        <span className="mon-mono">{t("{a}–{b} / {n} lines", { a: from, b: to, n: total })}</span>
      </div>

      <div className="rounds-peek__code mon-mono" role="figure" aria-label={p.path}>
        {lines.map((line, index) => (
          <div key={index} className="rounds-peek__line">
            <span className="rounds-peek__ln">{from + index}</span>
            <span className="rounds-peek__src">{line || " "}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
