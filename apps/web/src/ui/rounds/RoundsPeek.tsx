import { useMemo } from "react";
import { useT } from "../../lib/i18n";
import { useFileStore } from "../../stores/fileStore";
import type { RoundsData } from "./useRoundsData";

/**
 * The peek: the code the agent is looking at, with one honest line above it —
 * how far through the file the read reached.
 *
 * The payload's content *is* the agent's context (the slice it read), so the
 * body renders exactly that; the progress bar answers the question the slice
 * alone cannot — "how much of the file is this?" — by comparing the read's end
 * line against the file's full length from the Agent Folder store (the same
 * copies the folder panel shows). A file the folder has never seen reads as a
 * full bar: unknown total, so "all of what it has" is the honest answer.
 */
export function RoundsPeek({ data }: { data: RoundsData }) {
  const t = useT();
  const files = useFileStore((s) => s.files);
  const item = data.peek;

  const { total, from, to } = useMemo(() => {
    if (!item || item.payload.kind !== "file") return { total: 0, from: 0, to: 0 };
    const p = item.payload;
    const contentLines = p.content.length === 0 ? 0 : p.content.split("\n").length;
    const stored = files[p.path];
    const storedLines = stored ? (stored.content.split("\n").length ?? 0) : 0;
    const start = p.startLine ?? p.lineOffset ?? 1;
    const end = p.endLine ?? start + contentLines - 1;
    return { total: Math.max(storedLines, end, contentLines), from: start, to: end };
  }, [item, files]);

  if (!item || item.payload.kind !== "file") {
    return (
      <div className="rounds-peek">
        <div className="rounds-peek__head">
          <span className="rounds-chip rounds-chip--read">READ</span>
          <span className="rounds-peek__n">{t("No file in view")}</span>
        </div>
        <p className="rounds-peek__empty">{t("The agent is not reading a file right now. The last read appears here.")}</p>
      </div>
    );
  }

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
        <span className="mon-mono">
          {t("{a}–{b} / {n} lines", { a: from, b: to, n: total })}
        </span>
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
