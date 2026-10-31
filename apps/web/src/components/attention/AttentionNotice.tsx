import { formatClock } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { useReasonText } from "../../ui/monitor/atoms";
import type { AttentionNotice as Notice } from "../../hooks/useAttentionNotices";
import "./attention.css";

/**
 * The run asking for a human, drawn twice: as cards over Rounds' desktop, as a
 * list inside Monitor's left column. Both read one `AttentionNotice` (see
 * `useAttentionNotices`), so the two faces cannot disagree about what just
 * happened — only about how it looks.
 *
 * The level is the card's whole signal: the stripe, the tint and the word in
 * the header all come from it, and the word is the one a reader can act on
 * ("High" means now).
 */

const LEVEL_WORD: Record<Notice["level"], string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
};

/** Rounds: floating cards in the top-left corner, newest at the top. */
export function AttentionStack({
  notices,
  onOpen,
  onDismiss,
  onDismissAll,
}: {
  notices: Notice[];
  onOpen: (notice: Notice) => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
}) {
  const t = useT();
  const reasonText = useReasonText();
  if (notices.length === 0) return null;

  return (
    <div className="att-stack" role="region" aria-label={t("Attention")}>
      <div className="att-stack__head">
        <span className="att-stack__title">
          {t("Attention")}
          <em>{notices.length}</em>
        </span>
        <button type="button" className="att-stack__all" onClick={onDismissAll}>
          {t("Dismiss all")}
        </button>
      </div>

      {notices.map((notice) => (
        <article key={notice.id} className={`att-card att-card--${notice.level}`}>
          <header className="att-card__head">
            <span className="att-card__level">{t(LEVEL_WORD[notice.level])}</span>
            <span className="att-card__time">{formatClock(notice.at)}</span>
            <button
              type="button"
              className="att-card__x"
              aria-label={t("Dismiss")}
              title={t("Dismiss")}
              onClick={() => onDismiss(notice.id)}
            >
              ×
            </button>
          </header>
          <button
            type="button"
            className="att-card__body"
            disabled={!notice.eventId}
            title={notice.detail ? `${reasonText(notice.reason)} — ${notice.detail}` : undefined}
            onClick={() => onOpen(notice)}
          >
            <span className="att-card__reason">{reasonText(notice.reason)}</span>
            {notice.detail ? <span className="att-card__detail">{notice.detail}</span> : null}
          </button>
        </article>
      ))}
    </div>
  );
}

/**
 * Monitor: the run's attention as feed rows in the left column's third tab.
 * This is the persisted record, not the popup stack — every reason the run
 * raised, including the ones raised before this page was open, so a historical
 * run shows what it needed a human for. Nothing here is dismissible: dismissing
 * a record would only hide it until the next derivation.
 */
export function AttentionList({
  notices,
  onOpen,
}: {
  notices: Notice[];
  onOpen: (notice: Notice) => void;
}) {
  const t = useT();
  const reasonText = useReasonText();

  return (
    <div className="att-list">
      <div className="att-list__head">
        <span className="att-list__count">{t("{n} items", { n: notices.length })}</span>
      </div>

      {notices.length === 0 ? (
        <p className="mon-empty">
          {t("Nothing needs you right now. A run that asks for a human — a failed command, a stuck process, a loop — appears here.")}
        </p>
      ) : (
        notices.map((notice) => (
          <button
            key={notice.id}
            type="button"
            className={`att-row att-row--${notice.level}`}
            disabled={!notice.eventId}
            onClick={() => onOpen(notice)}
          >
            <span className="att-row__meta">
              <span className="att-row__level">{t(LEVEL_WORD[notice.level])}</span>
              <span className="att-row__clock">{formatClock(notice.at)}</span>
            </span>
            <span className="att-row__reason">{reasonText(notice.reason)}</span>
            {notice.detail ? <span className="att-row__detail">{notice.detail}</span> : null}
          </button>
        ))
      )}
    </div>
  );
}
