import { moodFor, type AgentVisualState } from "../../lib/agent";
import { useSessionStore } from "../../stores/sessionStore";
import { useUiStore } from "../../stores/uiStore";
import { Avatar } from "./Avatar";
import { MediaAvatar } from "./MediaAvatar";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { Panel } from "../Panel";
import { MetricsPanel } from "../metrics/MetricsPanel";
import { useT } from "../../lib/i18n";

/**
 * Agent status driven purely by the event stream (read02 §31–32).
 *
 * Clicking the panel swaps the two: the agent becomes the Stage's default
 * background and the compact metrics panel moves in here (and back).
 */
export function AgentPanel() {
  const t = useT();
  const status = useSessionStore((s) => s.agent.status);
  const model = useSessionStore((s) => s.agent.model);
  const agentOnStage = useUiStore((s) => s.agentOnStage);
  const toggleAgentOnStage = useUiStore((s) => s.toggleAgentOnStage);

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

  if (agentOnStage) {
    return <MetricsPanel />;
  }

  return (
    <Panel
      title={t("Agent")}
      aside={model}
      className="shrink-0 cursor-pointer"
      bodyClassName="p-2"
      onClick={toggleAgentOnStage}
    >
      <div className="h-[184px]">{avatar}</div>
    </Panel>
  );
}
