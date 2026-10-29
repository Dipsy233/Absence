import { useMemo, useState } from "react";
import { formatBytes, formatDuration } from "../../lib/format";
import { useNow } from "../../hooks/useNow";
import { useSessionStore } from "../../stores/sessionStore";
import { useFileStore } from "../../stores/fileStore";
import { useStageStore } from "../../stores/stageStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useUiStore } from "../../stores/uiStore";
import { openKnownFile } from "../../lib/openFile";
import { eventToStageItem } from "../../lib/events";
import { primaryEggs, sortEggs, summarizeTools } from "../../lib/eggs";
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
      <KnownFiles />
      <Eggs />
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
      <div className="mon-agent__avatar">
        {media ? (
          <MediaAvatar visual={visual} src={media.src} video={media.video} />
        ) : (
          <Avatar visual={visual} />
        )}
      </div>
      <div style={{ minWidth: 0 }}>
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

/* ── What it knows ──────────────────────────────────────────────────────── */

/**
 * The agent's files, newest first, each expanded into the versions it has held.
 * The version chips are the point: `v0 read → v1 write → v2 edit` says at a
 * glance whether the agent has been back to a file, and which state is current.
 */
function KnownFiles() {
  const t = useT();
  const files = useFileStore((s) => s.files);
  const activeId = useStageStore((s) => s.activeItem?.id);
  const agentFile = useStageStore((s) => s.agentFile);
  const [expanded, setExpanded] = useState<string | undefined>(undefined);

  const rows = useMemo(
    () =>
      Object.values(files)
        .sort((a, b) => (b.lastModifiedAt ?? 0) - (a.lastModifiedAt ?? 0) || a.path.localeCompare(b.path))
        .slice(0, 40),
    [files],
  );

  const shownPath =
    activeId !== undefined && activeId === agentFile?.id && agentFile.payload.kind === "file"
      ? agentFile.payload.path
      : undefined;

  if (rows.length === 0) {
    return (
      <div>
        <div className="mon-sec">
          <span className="mon-cap">{t("Agent Folder")}</span>
          <span>{t("empty")}</span>
        </div>
        <p className="mon-fold">{t("The agent has not touched anything yet. Files appear here as it reads and edits them.")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mon-sec">
        <span className="mon-cap">{t("Agent Folder")}</span>
        <span>{t("{n} files it knows", { n: rows.length })}</span>
      </div>
      {rows.map((file) => {
        const open = expanded === file.path;
        const current = shownPath === file.path;
        const versions = file.history;
        return (
          <div key={file.path}>
            <button
              type="button"
              className="mon-file"
              data-on={current ? "true" : undefined}
              onClick={() => setExpanded(open ? undefined : file.path)}
              title={open ? t("Hide versions") : t("Show versions")}
            >
              <span className="mon-file__n" title={file.path}>
                {file.path}
              </span>
              <span className="mon-vers">
                {versions.slice(-3).map((entry) => (
                  <i
                    key={entry.version}
                    data-cur={entry.version === file.version ? "true" : undefined}
                    className={
                      entry.source === "read" ? "mon-chip--read" : entry.source === "edit" ? "mon-chip--edit" : "mon-chip--search"
                    }
                  >
                    v{entry.version}
                  </i>
                ))}
              </span>
              <span className="mon-mono" style={{ fontSize: 10.5, color: "var(--mon-t3)" }}>
                {formatBytes(file.content.length)}
              </span>
            </button>
            {open ? (
              <div style={{ padding: "2px 14px 8px 22px" }}>
                {[...versions].reverse().map((entry) => (
                  <button
                    key={entry.version}
                    type="button"
                    onClick={() => openKnownFile(file.path, entry.version)}
                    style={{
                      display: "flex",
                      width: "100%",
                      gap: 8,
                      padding: "3px 0",
                      border: 0,
                      background: "transparent",
                      textAlign: "left",
                      font: "11px var(--mon-mono)",
                      color: "var(--mon-t3)",
                    }}
                  >
                    <span style={{ width: 22 }}>v{entry.version}</span>
                    <span style={{ width: 34 }}>{entry.source}</span>
                    <span style={{ minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {entry.complete
                        ? t("whole file")
                        : entry.startLine !== undefined && entry.endLine !== undefined
                          ? t("lines {a}–{b}", { a: entry.startLine, b: entry.endLine })
                          : t("partial")}
                    </span>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

/* ── What it left running ───────────────────────────────────────────────── */

function Eggs() {
  const t = useT();
  const version = useSessionStore((s) => s.eggState.version);
  const retired = useSessionStore((s) => s.eggState.retired);
  const eggsMap = useSessionStore.getState().eggState.eggs;
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const openMetrics = useUiStore((s) => s.openMetrics);
  const openStage = useStageStore((s) => s.openStage);
  const now = useNow(1000);

  const sorted = useMemo(() => sortEggs(eggsMap), [eggsMap, version]);
  const eggs = useMemo(() => primaryEggs(sorted), [sorted]);
  const tools = useMemo(() => summarizeTools(sorted), [sorted]);
  const running = eggs.filter((egg) => egg.status === "running");

  if (eggs.length === 0 && retired === 0) {
    return (
      <div>
        <div className="mon-sec">
          <span className="mon-cap">{t("Agent Eggs")}</span>
          <span>{t("none")}</span>
        </div>
        <p className="mon-fold">{t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="mon-sec">
        <span className="mon-cap">{t("Agent Eggs")}</span>
        <span>{t("{r}/{a} running", { r: running.length, a: eggs.length })}</span>
      </div>
      {eggs.slice(0, 12).map((egg) => {
        const alive = egg.status === "running";
        const lived = (egg.exitedAt ?? now) - egg.startedAt;
        return (
          <div key={egg.pid} className="mon-egg" data-running={alive ? "true" : undefined}>
            <button
              type="button"
              onClick={() => {
                const item = eventToStageItem(egg.event);
                if (item) openStage(item);
              }}
              title={egg.commandLine}
              style={{ display: "block", width: "100%", border: 0, background: "transparent", textAlign: "left" }}
            >
              <span className="mon-egg__r1">
                <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
                  <Dot tone={alive ? "egg" : "mute"} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{egg.name}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 5, flex: "none" }}>
                  {alive ? <Chip tone="egg">CPU</Chip> : null}
                  <span style={{ fontSize: 11, color: "var(--mon-t3)" }}>pid {egg.pid}</span>
                </span>
              </span>
              <span className="mon-egg__r2">{egg.command || egg.commandLine}</span>
              <span className="mon-egg__r2">
                {alive ? t("running for") : t("lived")} {formatDuration(lived)}
                {egg.children > 0 ? ` · ${t("+{n} children", { n: egg.children })}` : ""}
              </span>
            </button>
            <div style={{ display: "flex", gap: 6, marginTop: 7 }}>
              <button
                type="button"
                className="mon-btn"
                style={{ height: 24, padding: "0 8px", fontSize: 11 }}
                onClick={() => {
                  selectEgg(selectedEggPid === egg.pid ? undefined : egg.pid);
                  openMetrics();
                }}
              >
                {t("Metrics")}
              </button>
            </div>
          </div>
        );
      })}
      {tools.count > 0 || retired > 0 ? (
        <p className="mon-fold">
          {tools.count > 0 ? t("folded {n} helpers: {names}", { n: tools.count, names: tools.names.join(", ") }) : null}
          {tools.count > 0 && retired > 0 ? " · " : null}
          {retired > 0 ? t("{n} older finished processes folded", { n: retired }) : null}
        </p>
      ) : null}
      {eggs.length > 12 ? <p className="mon-fold">{t("{n} more not shown", { n: eggs.length - 12 })}</p> : null}
    </div>
  );
}
