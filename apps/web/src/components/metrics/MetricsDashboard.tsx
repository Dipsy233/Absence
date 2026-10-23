import { useEffect, useMemo, useState } from "react";
import type { MetricSeries } from "@absence/core";
import { fetchMetrics } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useUiStore } from "../../stores/uiStore";
import { useT } from "../../lib/i18n";
import {
  chartFromRing,
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

type RangeId = "1m" | "5m" | "10m" | "15m" | "1h" | "session";
type Tab = "graph" | "table";

const RANGES: Array<{ id: RangeId; label: string; ms: number; step: number }> = [
  { id: "1m", label: "1m", ms: 60_000, step: 2_000 },
  { id: "5m", label: "5m", ms: 5 * 60_000, step: 2_000 },
  { id: "10m", label: "10m", ms: 10 * 60_000, step: 2_000 },
  { id: "15m", label: "15m", ms: 15 * 60_000, step: 5_000 },
  { id: "1h", label: "1h", ms: 60 * 60_000, step: 10_000 },
  { id: "session", label: "session", ms: Number.MAX_SAFE_INTEGER, step: 60_000 },
];

const EMPTY: ChartSeries = { ts: [], cpuCores: [], rssMiB: [] };

/**
 * The full metrics dashboard: Prometheus's Graph page, in the desk's palette.
 *
 * Short ranges read the live ring (no request); longer ranges read the
 * persisted chunks from /api/sessions/:id/metrics, which is also how a
 * historical session or a replay sees its resource curve.
 */
export function MetricsDashboard() {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const closeMetrics = useUiStore((s) => s.closeMetrics);
  const session = useSessionStore((s) => s.session);
  const frames = useMetricsStore.getState().frames;
  void version;

  const [rangeId, setRangeId] = useState<RangeId>("5m");
  const [tab, setTab] = useState<Tab>("graph");
  const [remote, setRemote] = useState<MetricSeries | undefined>(undefined);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  const eggs = useMemo(() => eggList(frames), [frames, version]);
  const primary = useMemo(() => eggs.filter((egg) => egg.kind === "primary"), [eggs]);
  const running = useMemo(() => primary.filter((egg) => egg.status === "running"), [primary]);
  const selected =
    (selectedEggPid !== undefined ? primary.find((egg) => egg.eggPid === selectedEggPid) : undefined) ??
    running
      .map((egg) => ({ egg, cores: eggCpuCores(frames, egg.eggPid) }))
      .sort((a, b) => b.cores - a.cores)[0]?.egg;

  useEffect(() => {
    if (selectedEggPid === undefined && selected) selectEgg(selected.eggPid);
  }, [selectedEggPid, selected, selectEgg]);

  const range = RANGES.find((entry) => entry.id === rangeId) ?? RANGES[1]!;
  // The ring only knows this session's live frames. A historical session (or a
  // range longer than the ring) must read SQLite instead.
  const useRing = range.ms <= 10 * 60_000 && frames.length > 0 && selected !== undefined;
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
    const wanted = selected?.eggPid;
    const load = () => {
      fetchMetrics(session.id, {
        from: range.id === "session" ? sessionStart : Date.now() - range.ms,
        to: Date.now(),
        step: range.step,
        eggPid: wanted,
      })
        .then((response) => {
          if (cancelled) return;
          // With no live egg selected (a historical session), pick the busiest
          // primary series and follow it.
          const series =
            (wanted !== undefined
              ? response.series.find((entry) => entry.eggPid === wanted)
              : undefined) ??
            response.series
              .filter((entry) => entry.kind === "primary")
              .sort((a, b) => b.avgCpuCoresSession - a.avgCpuCoresSession)[0] ??
            response.series[0];
          setRemote(series);
          if (wanted === undefined && series) selectEgg(series.eggPid);
        })
        .catch(() => {
          if (!cancelled) setRemote(undefined);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const timer = setInterval(load, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [useRing, selected?.eggPid, session?.id, range.id, range.ms, range.step, sessionStart, refresh, selectEgg]);

  const chart = useMemo(() => {
    if (useRing) return selected ? chartFromRing(frames, selected.eggPid) : EMPTY;
    return remote ? chartFromSeries(remote, range.step) : EMPTY;
  }, [selected, useRing, frames, version, remote, range.step]);

  const latest = latestFrame(frames);
  const egg = selected ? findEgg(frames, selected.eggPid) : undefined;
  const cpuCount = latest?.host.cpuCount ?? 1;
  const sessionAvgCpu = egg?.avgCpuCoresSession ?? remote?.avgCpuCoresSession ?? 0;
  const sessionAvgMem = egg?.avgRssBytesSession ?? remote?.avgRssBytesSession ?? 0;
  const processCount = egg?.processCount ?? 0;
  const eggStatus = egg?.status ?? remote?.status;
  const options =
    primary.length > 0
      ? primary
      : remote
        ? [{ eggPid: remote.eggPid, name: remote.name, status: remote.status }]
        : [];
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
    <div className="absolute inset-x-0 top-0 bottom-14 z-30 flex flex-col bg-desk-panel/95 backdrop-blur-[3px]">
      <header className="flex shrink-0 items-center gap-2 border-b border-desk-line px-3 py-1.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-desk-amber">
          {t("METRICS")}
        </span>
        <span className="font-mono text-[10px] text-desk-dim">
          {latest ? (latest.precision === "exact" ? t("exact") : t("sampled")) : "—"}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setRefresh((value) => value + 1)}
            title={t("Refresh")}
            className="rounded border border-desk-line px-2 py-0.5 font-mono text-[10px] text-desk-dim hover:text-desk-ink"
          >
            ↻
          </button>
          <button
            type="button"
            onClick={closeMetrics}
            title={t("Close the metrics dashboard")}
            className="rounded border border-desk-line px-2 py-0.5 font-mono text-[10px] text-desk-dim hover:text-desk-ink"
          >
            ✕
          </button>
        </div>
      </header>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-desk-line/60 px-3 py-1.5">
        <select
          value={selected?.eggPid ?? remote?.eggPid ?? ""}
          onChange={(event) => selectEgg(Number(event.target.value) || undefined)}
          className="max-w-[220px] rounded border border-desk-line bg-desk-panel2 px-2 py-1 font-mono text-[11px] text-desk-ink focus:border-desk-amber/60 focus:outline-none"
        >
          {options.length === 0 ? <option value="">{t("no eggs")}</option> : null}
          {options.map((entry) => (
            <option key={entry.eggPid} value={entry.eggPid}>
              {entry.name} · {entry.eggPid} {entry.status === "exited" ? `(${t("exited")})` : ""}
            </option>
          ))}
        </select>

        <div className="flex items-center gap-0.5">
          {RANGES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              onClick={() => setRangeId(entry.id)}
              className={[
                "rounded px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                rangeId === entry.id
                  ? "bg-desk-panel2 text-desk-amber"
                  : "text-desk-dim hover:text-desk-ink",
              ].join(" ")}
            >
              {entry.id === "session" ? t("session") : entry.label}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-0.5">
          {(["graph", "table"] as Tab[]).map((entry) => (
            <button
              key={entry}
              type="button"
              onClick={() => setTab(entry)}
              className={[
                "rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wide",
                tab === entry ? "bg-desk-panel2 text-desk-amber" : "text-desk-dim hover:text-desk-ink",
              ].join(" ")}
            >
              {t(entry === "graph" ? "Graph" : "Table")}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-3">
        {options.length === 0 && !remote ? (
          <p className="text-xs text-desk-dim">{t("No eggs yet. An egg is a process the agent left running — a dev server, a watcher.")}</p>
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
                <span className="text-desk-amber">■ {t("CPU")} ({t("cores")})</span>
                <span className="text-desk-teal">■ {t("MEM")} (MiB)</span>
                <span className="ml-auto">
                  {t("host")} {formatPercent(hostCpuPercent(frames))} CPU · {formatPercent(hostMemoryPercent(frames))} MEM
                </span>
              </div>
              {chart.ts.length < 2 ? (
                <div className="flex h-[220px] items-center justify-center text-xs text-desk-dim">
                  {loading ? t("loading…") : t("Waiting for the first sample…")}
                </div>
              ) : (
                <TimeSeriesChart
                  data={chart}
                  height={220}
                  cpuLabel={t("CPU")}
                  memLabel={t("MEM")}
                />
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
                {t("status")}: {eggStatus === "running" ? t("running") : t("exited")}
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
