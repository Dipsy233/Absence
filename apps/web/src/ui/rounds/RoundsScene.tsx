import { statusLabel } from "../../lib/agent";
import { useT } from "../../lib/i18n";
import { Avatar } from "../../components/agent/Avatar";
import { MediaAvatar } from "../../components/agent/MediaAvatar";
import { moodFor } from "../../lib/agent";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import type { RoundsData } from "./useRoundsData";

/**
 * The scene: the agent on its own stage, alone.
 *
 * The avatar never overlaps text — b.html's rule, and a hard one: the bubble
 * hangs above the figure, the thought line sits below it, and both are
 * siblings of the stage in a column, so no amount of text can slide under the
 * character. The bubble says what it is doing *now* (the status word, then the
 * one thing in its hands); the thought line quotes the latest reasoning.
 *
 * Clicking the stage is "back to live" when a pin or a replay holds the view —
 * the same gesture as ⏎ everywhere else.
 */
export function RoundsScene({ data, onLive }: { data: RoundsData; onLive: () => void }) {
  const t = useT();
  const coverage = useAvatarSkinCoverage();
  const status = data.status;
  const visual = { status, mood: moodFor(status) };
  const media = skinMediaFor(coverage, status);
  const holding = !data.following;

  return (
    <div className="rounds-scene" role="img" aria-label={t(statusLabel(status))}>
      {data.item ? (
        <div className="rounds-bubble" data-holding={holding ? "true" : undefined}>
          <span className="rounds-bubble__s">
            <i className="rounds-dot" data-tone={status} aria-hidden />
            {t(statusLabel(status)).toUpperCase()}
          </span>
          <span className="rounds-bubble__l">{what(data.item, t)}</span>
        </div>
      ) : (
        <div className="rounds-bubble rounds-bubble--empty">
          <span className="rounds-bubble__s">{t("Waiting for the first activity…")}</span>
        </div>
      )}

      <button
        type="button"
        className="rounds-stage"
        onClick={holding ? onLive : undefined}
        disabled={!holding}
        title={holding ? t("Back to live") : undefined}
      >
        {media ? (
          <MediaAvatar visual={visual} src={media.src} video={media.video} />
        ) : (
          <Avatar visual={visual} />
        )}
        <span className="rounds-shadow" aria-hidden />
      </button>

      {data.thinking ? (
        <p className="rounds-thought">
          <b>{t("THINKING")}</b>
          <span title={data.thinking}>{data.thinking}</span>
        </p>
      ) : null}
    </div>
  );
}

/** One verb + one subject for the bubble's big line. */
function what(
  item: NonNullable<RoundsData["item"]>,
  t: (key: string, params?: Record<string, string | number>) => string,
): string {
  const p = item.payload;
  switch (p.kind) {
    case "file":
      return t("Reading {x}", { x: p.path });
    case "diff":
      return t("Editing {x}", { x: p.path });
    case "terminal":
      return p.mcp ? `${p.mcp.server} › ${p.mcp.tool}` : t("Running {x}", { x: p.command || "(shell)" });
    case "thought":
      return t("Reasoning");
    case "process":
      return t("Watching {x}", { x: p.name });
    case "approval":
      return t("Waiting for you");
    default:
      return item.title;
  }
}
