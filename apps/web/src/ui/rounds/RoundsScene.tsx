import { statusFromEvent } from "../../lib/events";
import { statusLabel } from "../../lib/agent";
import { useT } from "../../lib/i18n";
import { Avatar } from "../../components/agent/Avatar";
import { MediaAvatar } from "../../components/agent/MediaAvatar";
import { moodFor } from "../../lib/agent";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { useReplayStore } from "../../stores/replayStore";
import { useStageStore } from "../../stores/stageStore";
import type { RoundsData } from "./useRoundsData";

/**
 * The scene: the agent on its own stage, alone.
 *
 * The avatar never overlaps text — b.html's rule, and a hard one: the bubble
 * hangs above the figure, and both are siblings of the stage in a column, so
 * no amount of text can slide under the character. The bubble says what it is
 * doing *now* (the status word, then the one thing in its hands).
 *
 * The pose follows *what is on screen*, not the socket — Monitor's
 * `AgentHead` rule, reused rather than re-derived: in replay it
 * re-enacts the reconstructed run's status, on a pinned moment it re-enacts
 * the action that produced that moment, and only while following does it read
 * the live status. Otherwise the figure would be listening while the stage
 * clearly shows it mid-edit.
 *
 * Clicking the stage is "back to live" when a pin or a replay holds the view —
 * the same gesture as ⏎ everywhere else.
 */
export function RoundsScene({ data, onLive }: { data: RoundsData; onLive: () => void }) {
  const t = useT();
  const coverage = useAvatarSkinCoverage();
  const replayStatus = useReplayStore((s) => s.view?.agentStatus);
  const replaying = useStageStore((s) => s.mode === "replay");
  const pinnedStatus =
    !data.following && data.item?.event ? statusFromEvent(data.item.event) : undefined;
  const status = (replaying && replayStatus) || pinnedStatus || data.status;
  const visual = { status, mood: moodFor(status) };
  const media = skinMediaFor(coverage, status);
  const holding = !data.following;
  /** The big line exists only when there is a moment to speak about. */
  const line = data.item ? what(data.item, t) : null;

  return (
    <div className="rounds-scene" role="img" aria-label={t(statusLabel(status))}>
      <div
        className={`rounds-bubble${line ? "" : " rounds-bubble--empty"}`}
        data-holding={holding ? "true" : undefined}
      >
        <span className="rounds-bubble__s">
          {line ? (
            <>
              <i className="rounds-dot" data-tone={status} aria-hidden />
              {t(statusLabel(status)).toUpperCase()}
            </>
          ) : (
            t("Waiting for the first activity…")
          )}
        </span>
        {/* The second row is permanent: a moment arriving or leaving must not
            change the bubble's height, or the centred column re-centres and
            the character below it — and the whole scene — shifts. */}
        <span className="rounds-bubble__l" aria-hidden={!line}>
          {line ?? "\u00a0"}
        </span>
      </div>

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
