import { useMemo } from "react";
import { formatBytes } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useSessionStore } from "../../stores/sessionStore";

import { useMetricsStore } from "../../stores/metricsStore";

import { AgentFolder } from "../../components/agent/AgentFolder";
import { AgentEggsPanel } from "../../components/eggs/AgentEggsPanel";
import { agentCpuCores, agentAverageCores, agentPoints, formatCores, formatPercent, hostCpuPercent, latestFrame } from "../../lib/metrics";
import { moodFor, statusLabel, type AgentVisualState } from "../../lib/agent";
import { useT } from "../../lib/i18n";
import { Avatar } from "../../components/agent/Avatar";
import { MediaAvatar } from "../../components/agent/MediaAvatar";
import { skinMediaFor, useAvatarSkinCoverage } from "../../lib/avatarSkin";
import { attentionTone, Chip, Dot, phaseWord, Spark, toneForStatus, useReasonText } from "./atoms";
import type { MonitorData } from "./useMonitorData";

/**
 * Right column: who is working, what it is worth in resources, what it knows,
 * and what it left running — the four things a person supervising a machine
 * wants within one glance, in that order of urgency.
 */
export function MonitorRight({ data }: { data: MonitorData }) {
  return (
    <div className="mon-col mon-col--right">
      <AgentHead data={data} />
      <Usage />
      <Attention data={data} />
      {/*
        Agent Folder and Agent Eggs are Classic's own panels, not a second
        reading of the same data. They already answer "which versions has it
        seen", "which process is still running", "show me that egg's metrics" -
        and the rail is the same rail, so reusing them keeps one behaviour
        instead of two that drift. `.mon-root` re-points their --desk-* tokens
        at this face's palette, so they land in Monitor's colours unchanged.
      */}
      <div className="mon-railpanels">
        <AgentFolder />
        <AgentEggsPanel />
      </div>
    </div>
  );
}

/* ── Who ────────────────────────────────────────────────────────────────── */

function AgentHead({ data }: { data: MonitorData }) {
  const t = useT();
  const status = useSessionStore((s) => s.agent.status);
  const model = useSessionStore((s) => s.agent.model);
  const coverage = useAvatarSkinCoverage();
  const visual: AgentVisualState = { status, mood: moodFor(status) };
  const media = skinMediaFor(coverage, status);
  const tone = toneForStatus(status);
  const phase = data.phase;

  return (
    <div className="mon-agent">
      {/*
        The character, framed the way the proposal frames it: a square tile on
        the left, the status beside it — not a full-width banner. The tile is a
        fixed 88px box, and the avatar inside is Classic's own `h-[184px]`
        block: the character is authored for that height, and it is what keeps
        the pose, props and idle animation identical to Classic's panel. The
        tile crops it (overflow hidden, aligned to the top) rather than
        rescaling it, because a rescaled WhaleBun is a different character.

        No `.whalebun-root` overrides here: an earlier version overrode the
        fit's transform and hid the props and fx, which is exactly why the
        animation stopped playing.
      */}
      <div className="mon-agent__tile" aria-hidden>
        <div className="mon-agent__tileinner">
          {media ? (
            <MediaAvatar visual={visual} src={media.src} video={media.video} />
          ) : (
            <Avatar visual={visual} />
          )}
        </div>
      </div>
      <div className="mon-agent__caption">
        <div className={`mon-agent__state mon-chip--${tone}`} style={{ background: "transparent", padding: 0 }}>
          <Dot tone={tone} />
          {t(statusLabel(status)).toUpperCase()}
          {phase ? <span style={{ color: "var(--mon-t3)" }}>· {t(phaseWord(phase))}</span> : null}
        </div>
        <div className="mon-agent__line" title={data.liveHeadline}>
          {data.liveHeadline ?? t("Idle — waiting for a task")}
        </div>
        <div className="mon-agent__sub">
          {model ?? "—"} · {data.run ? `#${data.run.index}` : t("no run")}
        </div>
      </div>
    </div>
  );
}

/* ── Cost ───────────────────────────────────────────────────────────────── */

/**
 * CPU / memory for the asked-for scope: the whole agent, or one egg when one is
 * selected (the same selection Agent Eggs sets). Rings, not charts — the full
 * dashboard is one click away on the Stage.
 */
function Usage() {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const frames = useMetricsStore.getState().frames;
  const now = useNow(2000);

  const { cores, avgCores, memMiB, peakMiB, cpuSpark, memSpark, cpuCount, hostPercent } = useMemo(() => {
    const latest = latestFrame(frames);
    const cpuCountNow = latest?.host.cpuCount ?? 1;
    const points = agentPoints(frames);
    const spark = points.slice(-90).map((point, index, list) => {
      if (index === 0) return 0;
      const seconds = (point.ts - list[index - 1]!.ts) / 1000;
      return seconds > 0 ? Math.max(0, (point.cpuSeconds - list[index - 1]!.cpuSeconds) / seconds) : 0;
    });
    const mem = points.slice(-90).map((point) => point.rssBytes / (1024 * 1024));
    return {
      cores: agentCpuCores(frames),
      avgCores: agentAverageCores(frames, 5 * 60_000),
      memMiB: latest?.agent?.rssBytes ? latest.agent.rssBytes / (1024 * 1024) : (mem.at(-1) ?? 0),
      peakMiB: mem.length > 0 ? Math.max(...mem) : 0,
      cpuSpark: spark,
      memSpark: mem,
      cpuCount: cpuCountNow,
      hostPercent: hostCpuPercent(frames),
    };
  }, [frames, version, now, selectedEggPid]);

  if (frames.length === 0) {
    return (
      <div className="mon-met">
        <div>
          <div className="mon-cap">{t("CPU")}</div>
          <b>—</b>
          <small>{t("Waiting for the first sample…")}</small>
        </div>
        <div>
          <div className="mon-cap">{t("Memory")}</div>
          <b>—</b>
          <small>&nbsp;</small>
        </div>
      </div>
    );
  }

  return (
    <div className="mon-met">
      <div>
        <div className="mon-cap">{t("CPU")}</div>
        <b className="mon-chip--run">{formatPercent((cores / Math.max(1, cpuCount)) * 100)}</b>
        <small>
          {formatCores(cores)} {t("cores")} · {t("avg 5m")} {formatPercent((avgCores / Math.max(1, cpuCount)) * 100)}
        </small>
        <Spark values={cpuSpark} tone="run" />
      </div>
      <div>
        <div className="mon-cap">{t("Memory")}</div>
        <b className="mon-chip--egg">{formatBytes(memMiB * 1024 * 1024)}</b>
        <small>
          {t("peak")} {formatBytes(peakMiB * 1024 * 1024)} · {t("host")} {formatPercent(hostPercent)}
        </small>
        <Spark values={memSpark} tone="egg" />
      </div>
    </div>
  );
}

/* ── Attention ──────────────────────────────────────────────────────────── */

function Attention({ data }: { data: MonitorData }) {
  const t = useT();
  const reasonText = useReasonText();
  const { attention } = data;
  if (attention.level === "none" || attention.reasons.length === 0) return null;
  const tone = attentionTone(attention.level);
  return (
    <div className="mon-att" data-level={attention.level}>
      <div className="mon-att__h">
        <span className={`mon-chip mon-chip--${tone}`} style={{ height: 18, padding: "0 6px" }}>
          {t("attention").toUpperCase()}
        </span>
        <span>{t(attention.level)}</span>
      </div>
      <div className="mon-att__d">
        {attention.reasons.slice(0, 3).map((reason) => (
          <div key={reason}>• {reasonText(reason)}</div>
        ))}
      </div>
    </div>
  );
}

