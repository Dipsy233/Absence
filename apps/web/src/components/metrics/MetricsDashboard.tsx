import { useEffect, useMemo, useState } from "react";
import type { MetricSeries } from "@absence/core";
import { fetchMetrics } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import {
  chartFromRing,
  chartFromAgentRing,
  chartFromSeries,
  eggCpuCores,
  eggList,
  findEgg,
  formatBytes,
  formatCores,
  formatPercent,
  hostCpuPercent,
  hostMemoryPercent,
  latestFrame,
  type ChartSeries,
} from "../../lib/metrics";
import { TimeSeriesChart } from "./TimeSeriesChart";

type RangeId = "1m" | "5m" | "30m" | "1h" | "all";
type Tab = "graph" | "table";

const RANGES: Array<{ id: RangeId; label: string; ms: number; step: number; tickSeconds: number }> = [
  { id: "1m", label: "1m", ms: 60_000, step: 5_000, tickSeconds: 5 },
  { id: "5m", label: "5m", ms: 5 * 60_000, step: 5_000, tickSeconds: 30 },
  { id: "30m", label: "30m", ms: 30 * 60_000, step: 5_000, tickSeconds: 150 },
  { id: "1h", label: "1h", ms: 60 * 60_000, step: 5_000, tickSeconds: 300 },
  { id: "all", label: "all", ms: Number.MAX_SAFE_INTEGER, step: 5_000, tickSeconds: 300 },
];

const EMPTY: ChartSeries = { ts: [], cpuCores: [], rssMiB: [] };

/**
 * The full metrics dashboard: Prometheus's Graph page, in the desk's palette.
 *
 * Short ranges read the live ring (no request); longer ranges read the
 * persisted chunks from /api/sessions/:id/metrics, which is also how a
 * historical session or a replay sees its resource curve.
 */
export function MetricsDashboard({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const session = useSessionStore((s) => s.session);
  const frames = useMetricsStore.getState().frames;
  void version;

  const [rangeId, setRangeId] = useState<RangeId>("1m");
  const [tab, setTab] = useState<Tab>("graph");
  const [remote, setRemote] = useState<MetricSeries | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const eggs = useMemo(() => eggList(frames), [frames, version]);
  const primary = useMemo(() => eggs.filter((egg) => egg.kind === "primary"), [eggs]);
  const selected =
    selectedEggPid !== undefined ? primary.find((egg) => egg.eggPid === selectedEggPid) : undefined;

  const range = RANGES.find((entry) => entry.id === rangeId) ?? RANGES[1]!;
  // The ring only knows this session's live frames. A historical session (or a
  // range longer than the ring) must read SQLite instead.
  const useRing = (range.id === "1m" || range.id === "5m") && frames.length > 0;
  const sessionStart = session?.startedAt ?? Date.now() - 60 * 60_000;

  // Long ranges and historical sessions come from SQLite. Refresh periodically
  // while the dashboard is open so a live session's curve keeps moving.
  useEffect(() => {
    if (useRing || !session) {
      setRemote(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const wanted = selectedEggPid;
    const load = () => {
      fetchMetrics(session.id, {
        from: range.id === "all" || range.id === "30m" ? sessionStart : Date.now() - range.ms,
        to: Date.now(),
        step: range.step,
        eggPid: wanted,
      })
        .then((response) => {
          if (cancelled) return;
          const series =
            wanted !== undefined
              ? response.series.find((entry) => entry.eggPid === wanted)
              : aggregateAgentSeries(response.series);
          setRemote(series);
        })
        .catch(() => {
          if (!cancelled) setRemote(undefined);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, 5_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [useRing, selectedEggPid, session?.id, range.id, range.ms, range.step, sessionStart]);

  const chart = useMemo(() => {
    if (useRing) {
      const points = selected ? chartFromRing(frames, selected.eggPid) : chartFromAgentRing(frames);
      if (range.id === "30m") return points;
      const cutoff = selected?.status === "exited" && points.ts.length > 0
        ? points.ts[points.ts.length - 1]! * 1000 - range.ms
        : Date.now() - range.ms;
      const keep = points.ts.map((ts) => ts * 1000 >= cutoff);
      return {
        ts: points.ts.filter((_, index) => keep[index]),
        cpuCores: points.cpuCores.filter((_, index) => keep[index]),
        rssMiB: points.rssMiB.filter((_, index) => keep[index]),
      };
    }
    return remote ? chartFromSeries(remote, range.step) : EMPTY;
  }, [selected, useRing, frames, version, remote, range.id, range.ms, range.step]);

  const latest = latestFrame(frames);
  const egg = selected ? findEgg(frames, selected.eggPid) : undefined;
  const agent = latest?.agent;
  const cpuCount = latest?.host.cpuCount ?? 1;

  const agentAvgCpu = agent?.avgCpuCoresSession ?? primary.reduce((sum, entry) => sum + entry.avgCpuCoresSession, 0);
  const agentAvgMem = agent?.avgRssBytesSession ?? primary.reduce((sum, entry) => sum + entry.avgRssBytesSession, 0);
  const sessionAvgCpu = selected?.avgCpuCoresSession ?? remote?.avgCpuCoresSession ?? agentAvgCpu;
  const sessionAvgMem = selected?.avgRssBytesSession ?? remote?.avgRssBytesSession ?? agentAvgMem;
  const processCount = selected ? egg?.processCount ?? 0 : agent?.processCount ?? primary.reduce((sum, entry) => sum + entry.processCount, 0);
  const eggStatus = selected ? egg?.status ?? remote?.status : undefined;
  const currentCores = chart.cpuCores[chart.cpuCores.length - 1] ?? 0;
  const currentMem = chart.rssMiB[chart.rssMiB.length - 1] ?? 0;
  const avgCores =
    chart.cpuCores.length > 0
      ? chart.cpuCores.reduce((sum, value) => sum + value, 0) / chart.cpuCores.length
      : 0;
  const maxCores = chart.cpuCores.length > 0 ? Math.max(...chart.cpuCores) : 0;
  const minCores = chart.cpuCores.length > 0 ? Math.min(...chart.cpuCores) : 0;
  const avgMem =
    chart.rssMiB.length > 0
      ? chart.rssMiB.reduce((sum, value) => sum + value, 0) / chart.rssMiB.length
      : 0;
  const maxMem = chart.rssMiB.length > 0 ? Math.max(...chart.rssMiB) : 0;

  return (
    <div
      className={[
        "flex flex-col",
        // Embedded is the Stage's default page: it fills the stage area behind
        // the content sheets. Overlay mode covers them, above the report.
        embedded
          ? "h-full w-full bg-desk-panel"
          : "absolute inset-x-0 top-0 bottom-14 z-30 bg-desk-panel/95 backdrop-blur-[3px]",
      ].join(" ")}
    >
      <div className="flex shrink-0 items-start gap-3 border-b border-desk-line/60 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-[12px] font-semibold text-desk-amber">
            {selected?.name ?? t("Agent")}
          </div>
          {selected ? <div className="font-mono text-[9px] text-desk-dim">pid {selected.eggPid}</div> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <select
            value={rangeId}
            onChange={(event) => setRangeId(event.target.value as RangeId)}
            aria-label="Metrics time range"
            className="rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[10px] text-desk-dim focus:border-desk-amber/60 focus:outline-none"
          >
            {RANGES.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-0.5">
            {(["graph", "table"] as Tab[]).map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => setTab(entry)}
                className={[
                  "rounded px-1.5 py-1 font-mono text-[9px] uppercase",
                  tab === entry ? "bg-desk-panel2 text-desk-amber" : "text-desk-dim hover:text-desk-ink",
                ].join(" ")}
              >
                {t(entry === "graph" ? "Graph" : "Table")}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {!latest && !remote ? (
          <p className="py-8 text-center text-xs text-desk-dim">
            {t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}
          </p>
        ) : tab === "graph" ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat
                label={t("CPU now")}
                value={`${formatPercent((currentCores / Math.max(1, cpuCount)) * 100)}`}
                detail={`${formatCores(currentCores)} ${t("cores")}`}
                accent="amber"
              />
              <Stat
                label={t("MEM now")}
                value={formatBytes(currentMem * 1024 * 1024)}
                detail={latest ? `${formatPercent(((currentMem * 1024 * 1024) / latest.host.memTotalBytes) * 100)} ${t("of host")}` : ""}
                accent="teal"
              />
              <Stat
                label={t("CPU avg / max")}
                value={formatPercent((avgCores / Math.max(1, cpuCount)) * 100)}
                detail={`${formatCores(maxCores)} ${t("max cores")} · ${formatCores(minCores)} ${t("min")}`}
                accent="amber"
              />
              <Stat
                label={t("MEM avg / peak")}
                value={formatBytes(avgMem * 1024 * 1024)}
                detail={`${formatBytes(maxMem * 1024 * 1024)} ${t("peak")}`}
                accent="teal"
              />
            </div>

            <div className="rounded border border-desk-line bg-desk-panel2/40 p-2">
              <div className="mb-1 flex items-center gap-3 font-mono text-[10px] text-desk-dim">
                <span className="ml-auto">
                  {t("host")} {formatPercent(hostCpuPercent(frames))} CPU · {formatPercent(hostMemoryPercent(frames))} MEM
                </span>
              </div>
              {chart.ts.length < 1 ? (
                <div className="flex h-[220px] items-center justify-center text-xs text-desk-dim">
                  {loading ? t("loading…") : t("Waiting for the first sample…")}
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <TimeSeriesChart data={chart} height={150} label={t("CPU")} metric="cpu" hostLabel={t("host")} xTickSeconds={range.tickSeconds} />
                  <TimeSeriesChart data={chart} height={150} label={t("MEM")} metric="mem" hostLabel={t("host")} xTickSeconds={range.tickSeconds} />
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2 font-mono text-[10px] text-desk-dim sm:grid-cols-4">
              <span>
                {t("session avg CPU")}:{" "}
                <span className="text-desk-amber">
                  {formatPercent((sessionAvgCpu / Math.max(1, cpuCount)) * 100)}
                </span>
              </span>
              <span>
                {t("session avg MEM")}:{" "}
                <span className="text-desk-teal">{formatBytes(sessionAvgMem)}</span>
              </span>
              <span>
                {t("processes")}: {processCount}
              </span>
              <span>
                {t("status")}: {selected ? (eggStatus === "running" ? t("running") : t("exited")) : t("Agent")}
              </span>
            </div>
          </div>
        ) : (
          <MetricTable
            eggs={primary}
            frames={frames}
            remote={remote}
            selectedEggPid={selected?.eggPid}
            onSelect={selectEgg}
            cpuCount={cpuCount}
          />
        )}
      </div>
    </div>
  );
}

function aggregateAgentSeries(series: MetricSeries[]): MetricSeries | undefined {
  const agent = series.find((entry) => entry.kind === "agent");
  if (agent) return agent;
  const primary = series.filter((entry) => entry.kind === "primary");
  if (primary.length === 0) return undefined;
  const timestamps = [...new Set(primary.flatMap((entry) => entry.points.map((point) => point.ts)))].sort(
    (a, b) => a - b,
  );
  const points = new Map<number, { cpuSeconds: number; rssBytes: number; rssMaxBytes: number }>();
  for (const ts of timestamps) {
    let cpuSeconds = 0;
    let rssBytes = 0;
    let rssMaxBytes = 0;
    for (const entry of primary) {
      let latest: MetricSeries["points"][number] | undefined;
      for (const point of entry.points) {
        if (point.ts > ts) break;
        latest = point;
      }
      if (!latest) continue;
      cpuSeconds += latest.cpuSeconds;
      if (entry.status === "running" || ts <= entry.lastTs) {
        rssBytes += latest.rssBytes;
        rssMaxBytes += latest.rssMaxBytes;
      }
    }
    points.set(ts, { cpuSeconds, rssBytes, rssMaxBytes });
  }
  return {
    eggPid: 0,
    name: "Agent",
    kind: "primary",
    status: primary.some((entry) => entry.status === "running") ? "running" : "exited",
    points: [...points.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ts, point]) => ({ ts, ...point })),
    avgCpuCoresSession: primary.reduce((sum, entry) => sum + entry.avgCpuCoresSession, 0),
    avgRssBytesSession: primary.reduce((sum, entry) => sum + entry.avgRssBytesSession, 0),
    firstTs: Math.min(...primary.map((entry) => entry.firstTs)),
    lastTs: Math.max(...primary.map((entry) => entry.lastTs)),
  };
}

function Stat({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string;
  detail: string;
  accent: "amber" | "teal";
}) {
  return (
    <div className="rounded border border-desk-line bg-desk-panel2/40 px-2 py-1.5">
      <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-desk-dim/70">{label}</div>
      <div
        className={[
          "mt-0.5 font-mono text-lg leading-tight",
          accent === "amber" ? "text-desk-amber" : "text-desk-teal",
        ].join(" ")}
      >
        {value}
      </div>
      <div className="truncate font-mono text-[9px] text-desk-dim/70">{detail}</div>
    </div>
  );
}

function MetricTable({
  eggs,
  frames,
  remote,
  selectedEggPid,
  onSelect,
  cpuCount,
}: {
  eggs: ReturnType<typeof eggList>;
  frames: ReturnType<typeof useMetricsStore.getState>["frames"];
  remote?: MetricSeries;
  selectedEggPid?: number;
  onSelect: (eggPid?: number) => void;
  cpuCount: number;
}) {
  const t = useT();
  if (eggs.length === 0 && remote) {
    const last = remote.points[remote.points.length - 1];
    const first = remote.points[0];
    const seconds = last && first ? (last.ts - first.ts) / 1000 : 0;
    const cores = last && first && seconds > 0 ? Math.max(0, (last.cpuSeconds - first.cpuSeconds) / seconds) : 0;
    return (
      <table className="w-full border-collapse font-mono text-[10px]">
        <thead>
          <tr className="text-left text-desk-dim/70">
            <th className="border-b border-desk-line px-1 py-1 font-normal">{t("egg")}</th>
            <th className="border-b border-desk-line px-1 py-1 font-normal">pid</th>
            <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("CPU now")}</th>
            <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("session avg CPU")}</th>
            <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("MEM now")}</th>
            <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("session avg MEM")}</th>
            <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("status")}</th>
          </tr>
        </thead>
        <tbody>
          <tr className="bg-desk-panel2 text-desk-ink">
            <td className="border-b border-desk-line/40 px-1 py-1">{remote.name}</td>
            <td className="border-b border-desk-line/40 px-1 py-1">{remote.eggPid}</td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right text-desk-amber">
              {formatPercent((cores / Math.max(1, cpuCount)) * 100)}
            </td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right">
              {formatPercent((remote.avgCpuCoresSession / Math.max(1, cpuCount)) * 100)}
            </td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right text-desk-teal">
              {formatBytes(last?.rssBytes ?? 0)}
            </td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right">
              {formatBytes(remote.avgRssBytesSession)}
            </td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right">
              {remote.status === "running" ? t("running") : t("exited")}
            </td>
          </tr>
        </tbody>
      </table>
    );
  }
  return (
    <table className="w-full border-collapse font-mono text-[10px]">
      <thead>
        <tr className="text-left text-desk-dim/70">
          <th className="border-b border-desk-line px-1 py-1 font-normal">{t("egg")}</th>
          <th className="border-b border-desk-line px-1 py-1 font-normal">pid</th>
          <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("CPU now")}</th>
          <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("session avg CPU")}</th>
          <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("MEM now")}</th>
          <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("session avg MEM")}</th>
          <th className="border-b border-desk-line px-1 py-1 text-right font-normal">{t("status")}</th>
        </tr>
      </thead>
      <tbody>
        {eggs.map((egg) => {
          const cores = eggCpuCores(frames, egg.eggPid);
          return (
            <tr
              key={egg.eggPid}
              onClick={() => onSelect(egg.eggPid)}
              className={[
                "cursor-pointer",
                egg.eggPid === selectedEggPid ? "bg-desk-panel2 text-desk-ink" : "text-desk-dim hover:bg-desk-panel2",
              ].join(" ")}
            >
              <td className="border-b border-desk-line/40 px-1 py-1">{egg.name}</td>
              <td className="border-b border-desk-line/40 px-1 py-1">{egg.eggPid}</td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right text-desk-amber">
                {formatPercent((cores / Math.max(1, cpuCount)) * 100)}
              </td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right">
                {formatPercent(((egg.avgCpuCoresSession / Math.max(1, cpuCount)) * 100))}
              </td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right text-desk-teal">
                {formatBytes(egg.rssBytes)}
              </td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right">
                {formatBytes(egg.avgRssBytesSession)}
              </td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right">
                {egg.status === "running" ? t("running") : t("exited")}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
