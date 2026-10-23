import { useMemo } from "react";
import { useMetricsStore } from "../../stores/metricsStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import {
  agentAverageCores,
  agentCpuCores,
  agentPoints,
  eggAverageCores,
  eggCpuCores,
  eggList,
  eggPoints,
  findEgg,
  formatBytes,
  formatCores,
  formatPercent,
  hostCpuPercent,
  latestFrame,
} from "../../lib/metrics";
import { Panel } from "../Panel";
import { Sparkline } from "./Sparkline";

/**
 * METRICS — the resource view of the eggs the agent laid.
 *
 * Compact on purpose: the right rail is 320px. It shows the selected egg's
 * current CPU / RSS, its session average, and a sparkline; clicking opens the
 * full Prometheus-style dashboard on the Stage.
 */
export function MetricsPanel() {
  const t = useT();
  // Subscribe to the version: the frame array is mutated in place.
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const openMetrics = useUiStore((s) => s.openMetrics);
  const toggleAgentOnStage = useUiStore((s) => s.toggleAgentOnStage);
  const frames = useMetricsStore.getState().frames;
  void version;

  const eggs = useMemo(() => eggList(frames), [frames, version]);
  const primary = useMemo(
    () => eggs.filter((egg) => egg.kind === "primary"),
    [eggs],
  );
  const running = useMemo(() => primary.filter((egg) => egg.status === "running"), [primary]);
  const selected = selectedEggPid !== undefined
    ? primary.find((egg) => egg.eggPid === selectedEggPid)
    : undefined;

  const latest = latestFrame(frames);
  const egg = selected ? findEgg(frames, selected.eggPid) : undefined;
  const points = selected ? eggPoints(frames, selected.eggPid) : agentPoints(frames);
  const instantCores = selected ? eggCpuCores(frames, selected.eggPid) : agentCpuCores(frames);
  const averageCores = selected
    ? eggAverageCores(frames, selected.eggPid, 5 * 60_000)
    : agentAverageCores(frames, 5 * 60_000);
  const cpuCount = latest?.host.cpuCount ?? 1;
  const cpuPercent = (instantCores / Math.max(1, cpuCount)) * 100;
  const hostPercent = hostCpuPercent(frames);
  const cpuSpark = points.slice(-150).map((point, index, list) => {
    if (index === 0) return 0;
    const seconds = (point.ts - list[index - 1]!.ts) / 1000;
    return seconds > 0 ? Math.max(0, (point.cpuSeconds - list[index - 1]!.cpuSeconds) / seconds) : 0;
  });
  const memSpark = points.slice(-150).map((point) => point.rssBytes / (1024 * 1024));
  const agentRssBytes = primary.reduce((sum, entry) => sum + entry.rssBytes, 0);
  const agentAvgRssBytes = primary.reduce((sum, entry) => sum + entry.avgRssBytesSession, 0);

  const top = running
    .map((entry) => ({ egg: entry, cores: eggCpuCores(frames, entry.eggPid) }))
    .sort((a, b) => b.cores - a.cores)
    .slice(0, 5);

  return (
    <Panel
      title={t("METRICS")}
      aside={
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            toggleAgentOnStage();
          }}
          title={t("Swap the agent and the metrics on the Stage")}
          className="rounded border border-desk-line px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-desk-dim hover:text-desk-ink"
        >
          ⇄
        </button>
      }
      className="shrink-0"
      bodyClassName="p-2"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={openMetrics}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") openMetrics();
        }}
        className="cursor-pointer"
      >
        {!latest ? (
          <p className="py-4 text-xs text-desk-dim">
            {t("Waiting for the first sample…")}
          </p>
        ) : (
          <>
            <div className="mb-1 flex items-baseline justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-desk-ink/90" title={selected?.name ?? t("Agent")}>
                {selected?.name ?? t("Agent")}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-desk-dim">
                {selected ? (egg?.status === "running" ? t("running") : t("exited")) + ` · pid ${selected.eggPid}` : t("whole agent")}
              </span>
            </div>

            <div className="flex items-baseline justify-between font-mono text-[10px] text-desk-dim">
              <span>{t("CPU")}</span>
              <span className="text-desk-amber">
                {formatPercent(cpuPercent)} · {formatCores(instantCores)} {t("cores")}
              </span>
            </div>
            <Sparkline values={cpuSpark} height={30} className="mt-0.5" />
            <div className="flex justify-between font-mono text-[9px] text-desk-dim/80">
              <span>
                {t("avg 5m")} {formatPercent((averageCores / Math.max(1, cpuCount)) * 100)}
              </span>
              <span>
                {t("session")} {formatPercent((((egg?.avgCpuCoresSession ?? 0) / Math.max(1, cpuCount)) * 100))}
              </span>
              <span>
                {t("host")} {formatPercent(hostPercent)}
              </span>
            </div>

            <div className="mt-2 flex items-baseline justify-between font-mono text-[10px] text-desk-dim">
              <span>{t("MEM")}</span>
              <span className="text-desk-teal">
                {formatBytes(selected ? egg?.rssBytes ?? 0 : agentRssBytes)}
                {latest.host.memTotalBytes > 0
                  ? ` · ${formatPercent(((selected ? egg?.rssBytes ?? 0 : agentRssBytes) / latest.host.memTotalBytes) * 100)}`
                  : ""}
              </span>
            </div>
            <Sparkline
              values={memSpark}
              height={26}
              stroke="rgb(var(--desk-teal))"
              fill="rgba(79, 179, 165, 0.12)"
              className="mt-0.5"
            />
            <div className="flex justify-between font-mono text-[9px] text-desk-dim/80">
              <span>
                {t("avg")} {formatBytes(selected ? egg?.avgRssBytesSession ?? 0 : agentAvgRssBytes)}
              </span>
              <span>
                {t("peak")} {formatBytes(Math.max(0, ...memSpark) * 1024 * 1024)}
              </span>
            </div>

            {top.length > 0 ? (
              <div className="mt-2 border-t border-desk-line/60 pt-1.5">
                <div className="mb-1 font-mono text-[9px] uppercase tracking-[0.12em] text-desk-dim/70">
                  {t("top by CPU")}
                </div>
                <ul className="space-y-0.5">
                  {top.map(({ egg: entry, cores }) => (
                    <li key={entry.eggPid}>
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          selectEgg(entry.eggPid);
                        }}
                        className={[
                          "flex w-full items-center gap-2 rounded px-1 py-0.5 text-left font-mono text-[10px]",
                          entry.eggPid === selected?.eggPid
                            ? "bg-desk-panel2 text-desk-ink"
                            : "text-desk-dim hover:bg-desk-panel2 hover:text-desk-ink",
                        ].join(" ")}
                      >
                        <span className="w-20 truncate">{entry.name}</span>
                        <span className="w-14 shrink-0 text-right text-desk-amber">
                          {formatPercent((cores / Math.max(1, cpuCount)) * 100)}
                        </span>
                        <span className="ml-auto h-1.5 w-16 overflow-hidden rounded-full bg-desk-panel2">
                          <span
                            className="block h-full rounded-full bg-desk-amber/70"
                            style={{ width: `${Math.min(100, (cores / Math.max(1, cpuCount)) * 100 * 4)}%` }}
                          />
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <div className="mt-1.5 text-right font-mono text-[9px] uppercase tracking-[0.12em] text-desk-dim/60">
              {t("open dashboard")} →
            </div>
          </>
        )}
      </div>
    </Panel>
  );
}
