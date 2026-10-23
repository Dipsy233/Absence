import { moodFor, type AgentVisualState } from "../../lib/agent";
import { useSessionStore } from "../../stores/sessionStore";
import { Avatar } from "./Avatar";
import { MediaAvatar } from "./MediaAvatar";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { Panel } from "../Panel";
import { useT } from "../../lib/i18n";

/**
 * Agent status driven purely by the event stream (read02 §31–32).
 *
 * The metrics view lives in the Stage now (its default page); this panel is
 * always the agent's face.
 */
export function AgentPanel() {
  const t = useT();
  const status = useSessionStore((s) => s.agent.status);
  const model = useSessionStore((s) => s.agent.model);

  const visual: AgentVisualState = { status, mood: moodFor(status) };

  // Personalized skin wins per status: a status with an uploaded file shows
  // that media; statuses without one fall back to the built-in WhaleBun.
  const coverage = useAvatarSkinCoverage();
  const media = skinMediaFor(coverage, status);
  const avatar = media ? (
    <MediaAvatar visual={visual} src={media.src} video={media.video} />
  ) : (
    <Avatar visual={visual} />
  );

  return (
    <Panel title={t("Agent")} aside={model} className="shrink-0" bodyClassName="p-2">
      <div className="h-[184px]">{avatar}</div>
    </Panel>
  );
}
