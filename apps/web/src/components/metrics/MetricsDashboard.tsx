import { useEffect, useMemo, useState } from "react";
import type { HostMetricSeriesPoint, MetricSeries } from "@absence/core";
import { fetchMetrics } from "../../lib/api";
import { useSessionStore } from "../../stores/sessionStore";
import { useMetricsStore } from "../../stores/metricsStore";
import { useT } from "../../lib/i18n";
import { useNow } from "../../hooks/useNow";
import { formatDuration } from "../../lib/format";
import {
  RANGES,
  chartFromSeries,
  eggList,
  findEgg,
  formatBytes,
  formatCores,
  formatPercent,
  hostSeriesFromFrames,
  latestFrame,
  rangeStart,
  type ChartSeries,
  type RangeId,
  type SeriesPoint,
} from "../../lib/metrics";
import { TimeSeriesChart } from "./TimeSeriesChart";

type Tab = "graph" | "table";

/** At most this many x slots, so "all" over a day stays readable. */
const MAX_SLOTS = 720;

const EMPTY: ChartSeries = { ts: [], cpuCores: [], rssMiB: [] };

/**
 * The full metrics dashboard: Prometheus's Graph page, in the desk's palette.
 *
 * Every range reads both sources: the live ring (the newest samples, which have
 * not reached the 15s disk flush yet) is merged onto the persisted chunks. That
 * is why a session closed and reopened later still shows its curve — and why
 * the hours it was closed render as holes rather than a line.
 */
export function MetricsDashboard({ embedded = false }: { embedded?: boolean }) {
  const t = useT();
  const version = useMetricsStore((s) => s.version);
  const selectedEggPid = useMetricsStore((s) => s.selectedEggPid);
  const selectEgg = useMetricsStore((s) => s.selectEgg);
  const session = useSessionStore((s) => s.session);
  const eggVersion = useSessionStore((s) => s.eggState.version);
  const frames = useMetricsStore.getState().frames;
  const now = useNow(1000);
  void version;

  const [rangeId, setRangeId] = useState<RangeId>("5m");
  const [tab, setTab] = useState<Tab>("graph");
  const [remote, setRemote] = useState<RemoteMetrics | undefined>(undefined);
  const [loading, setLoading] = useState(false);

  const eggs = useMemo(() => eggList(frames), [frames, version]);
  const primary = useMemo(() => eggs.filter((egg) => egg.kind === "primary"), [eggs]);
  const selected =
    selectedEggPid !== undefined ? primary.find((egg) => egg.eggPid === selectedEggPid) : undefined;

  const range = RANGES.find((entry) => entry.id === rangeId) ?? RANGES[1]!;
  // Each range is its own window, floored to its own step so it only moves when
  // the clock crosses a step boundary (reading Date.now() every render would
  // change the request URL constantly and refetch in a loop).
  //
  // Only "all" anchors to the session's start. "30m" and "1h" used to as well,
  // which made them collapse onto the same short window as "1m" whenever the
  // session was younger than the range — the chart looked identical no matter
  // which one was picked.
  const sessionStart = session?.startedAt;
  const nowSlot = Math.floor(now / range.step) * range.step;
  const rangeFrom =
    range.id === "all" ? (sessionStart ?? nowSlot - 60 * 60_000) : nowSlot - range.ms;

  // The persisted chunks are the backbone of every range; the ring only adds the
  // samples the 15s flush has not written yet.
  useEffect(() => {
    if (!session) {
      setRemote(undefined);
      return;
    }
    let cancelled = false;
    setLoading(true);
    const wanted = selectedEggPid;
    const load = () => {
      fetchMetrics(session.id, {
        from: rangeFrom,
        to: Date.now(),
        step: range.step,
        eggPid: wanted,
      })
        .then((response) => {
          if (cancelled) return;
          setRemote({
            series:
              wanted !== undefined
                ? response.series.find((entry) => entry.eggPid === wanted)
                : aggregateAgentSeries(response.series),
            host: response.host,
          });
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
  }, [selectedEggPid, session?.id, rangeFrom, range.step]);


  const chart = useMemo(() => {
    // Raw points, so the two sources can be merged before the rate is derived.
    const merged = mergePoints(
      remote?.series?.points ?? [],
      liveRawPoints(frames, selected?.eggPid),
    );
    const hostPoints = remote?.host ?? [];
    if (merged.length === 0 && hostPoints.length === 0) return EMPTY;

    // The axis is a uniform grid across the data, so a silence between two
    // samples is a hole, not a straight line. A bounded range also starts at its
    // own beginning, so "the last 5 minutes" is five minutes wide even when the
    // agent only got busy 30s ago.
    const times = [...merged.map((point) => point.ts), ...hostPoints.map((point) => point.ts)];
    const spanFrom = rangeFrom;
    const spanTo = Math.max(...times, Date.now());
    const step = Math.max(range.step, Math.ceil((spanTo - spanFrom) / MAX_SLOTS / 1000) * 1000);
    const axis = slotAxis(spanFrom, spanTo, step);

    const series: MetricSeries = {
      eggPid: selected?.eggPid ?? 0,
      name: selected?.name ?? "Agent",
      kind: selected ? "primary" : "agent",
      status: selected?.status ?? remote?.series?.status ?? "running",
      points: merged.map((point) => ({ ...point, rssMaxBytes: point.rssBytes })),
      avgCpuCoresSession: remote?.series?.avgCpuCoresSession ?? 0,
      avgRssBytesSession: remote?.series?.avgRssBytesSession ?? 0,
      firstTs: merged.length > 0 ? merged[0]!.ts : 0,
      lastTs: merged.length > 0 ? merged[merged.length - 1]!.ts : 0,
    };
    const base = chartFromSeries(series, axis, hostPoints);
    if (frames.length === 0) return base;
    // The ring is fresher than the last disk flush; let it win where it has a value.
    const ringHost = hostSeriesFromFrames(axis, frames);
    return {
      ...base,
      hostCpuPercent: prefer(ringHost.hostCpuPercent, base.hostCpuPercent),
      hostMemMiB: prefer(ringHost.hostMemMiB, base.hostMemMiB),
    };
  }, [selected, frames, version, remote, range.step, rangeFrom]);

  const latest = latestFrame(frames);
  const agent = latest?.agent;
  const cpuCount = latest?.host.cpuCount ?? 1;

  // Stat helpers: nulls are holes, not zeroes, and must not drag an average down.
  const cpuValues = chart.cpuCores.filter((value): value is number => value !== null);
  const memValues = chart.rssMiB.filter((value): value is number => value !== null);
  const currentCores = lastDefined(chart.cpuCores);
  const currentMem = lastDefined(chart.rssMiB);
  const avgCores = cpuValues.length > 0 ? cpuValues.reduce((sum, value) => sum + value, 0) / cpuValues.length : 0;
  const maxCores = cpuValues.length > 0 ? Math.max(...cpuValues) : 0;
  const avgMem = memValues.length > 0 ? memValues.reduce((sum, value) => sum + value, 0) / memValues.length : 0;
  const maxMem = memValues.length > 0 ? Math.max(...memValues) : 0;
  const hostCpuNow = lastDefined(chart.hostCpuPercent ?? []);
  const hostMemNowMiB = lastDefined(chart.hostMemMiB ?? []);
  const memTotalBytes =
    latest?.host.memTotalBytes ??
    (remote?.host ?? []).reduce((value, point) => Math.max(value, point.memTotalBytes), 0);

  // The observed process: the selected egg, or the agent's whole tree.
  const egg = selected ? findEgg(frames, selected.eggPid) : undefined;
  const observationName = selected?.name ?? agent?.name ?? "Agent";
  /**
   * How long the observed process has been (or was) alive — its own lifetime,
   * not how long Absence has been watching.
   *
   * For an egg that is the process it spawned:
   * started at `startedAt`, stops at `exitedAt`. A python script the agent
   * started therefore counts up while it runs and freezes the moment it ends,
   * which is the only definition that answers "how long did that process run?".
   * The whole agent's tree has no single lifetime, so it falls back to the visit.
   */
  /**
   * The selected egg's record, read straight from the store.
   *
   * The selector must return a *stable* value: zustand v5 compares snapshots by
   * identity, and this used to build a fresh `{startedAt, exitedAt, status}`
   * object on every call — which React saw as "the store changed on every
   * render", so selecting an egg and opening METRICS put the dashboard into an
   * infinite re-render loop ("Maximum update depth exceeded"). Returning the
   * egg itself is stable; the derived numbers are computed below.
   */
  const observedEgg = useSessionStore((s) => (selected ? s.eggState.eggs.get(selected.eggPid) : undefined));
  const observedLifetime = observedEgg
    ? { startedAt: observedEgg.startedAt, exitedAt: observedEgg.exitedAt, status: observedEgg.status }
    : undefined;
  void eggVersion;
  const observationDuration = observedLifetime
    ? Math.max(0, (observedLifetime.exitedAt ?? now) - observedLifetime.startedAt)
    : 0;
  const observationRunning = observedLifetime ? observedLifetime.status === "running" : false;
  // Every process this agent spawned in the session: live eggs plus the ones the
  // watcher retired to keep the live view bounded. Tools count — they were spawned.
  const spawned = useSessionStore((s) => s.eggState.eggs.size + s.eggState.retired);
  /**
   * Time actually spent in this session.
   *
   * Dwell time, not wall time since creation: leaving the project and coming
   * back later continues the clock instead of counting the hours in between
   * (the server accrues it; see `Session.dwellMs`).
   */
  const sessionDuration = session
    ? Math.max(0, (session.dwellMs ?? 0) + (session.openedAt ? now - session.openedAt : 0))
    : 0;

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
                {entry.id}
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
            {/* Row 1: the agent's CPU, and what the machine was doing. */}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat
                label={t("CPU now")}
                value={formatPercent(percentOfCores(currentCores, cpuCount))}
                detail={`${formatCores(currentCores)} ${t("cores")}`}
                accent="amber"
              />
              <Stat
                label={t("CPU avg")}
                value={formatPercent(percentOfCores(avgCores, cpuCount))}
                detail={`${formatCores(avgCores)} ${t("cores")}`}
                accent="amber"
              />
              <Stat
                label={t("CPU max")}
                value={formatPercent(percentOfCores(maxCores, cpuCount))}
                detail={`${formatCores(maxCores)} ${t("cores")}`}
                accent="amber"
              />
              <Stat
                label={t("host CPU now")}
                value={formatPercent(hostCpuNow ?? 0)}
                detail={cpuCount > 0 ? t("{n} cores", { n: cpuCount }) : ""}
                accent="dim"
              />
            </div>

            {/* Row 2: the agent's memory, and the machine's. */}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat
                label={t("MEM now")}
                value={formatBytes(currentMem * 1024 * 1024)}
                detail={
                  memTotalBytes > 0
                    ? `${formatPercent(((currentMem * 1024 * 1024) / memTotalBytes) * 100)} ${t("of host")}`
                    : ""
                }
                accent="teal"
              />
              <Stat
                label={t("MEM avg")}
                value={formatBytes(avgMem * 1024 * 1024)}
                detail={memTotalBytes > 0 ? `${formatPercent((avgMem * 1024 * 1024 / memTotalBytes) * 100)} ${t("of host")}` : ""}
                accent="teal"
              />
              <Stat
                label={t("MEM peak")}
                value={formatBytes(maxMem * 1024 * 1024)}
                detail={memTotalBytes > 0 ? `${formatPercent((maxMem * 1024 * 1024 / memTotalBytes) * 100)} ${t("of host")}` : ""}
                accent="teal"
              />
              <Stat
                label={t("host MEM now")}
                value={formatBytes(hostMemNowMiB * 1024 * 1024)}
                detail={
                  memTotalBytes > 0
                    ? `${formatPercent((hostMemNowMiB * 1024 * 1024 / memTotalBytes) * 100)} ${t("of host")}`
                    : ""
                }
                accent="dim"
              />
            </div>

            {/* Row 3: what is being observed, and for how long. */}
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <Stat label={t("observed process")} value={observationName} detail={selected ? `pid ${selected.eggPid}` : t("whole agent")} accent="ink" />
              <Stat
                label={t("observed for")}
                value={observationDuration > 0 ? formatDuration(observationDuration) : "—"}
                detail={selected ? (observationRunning ? t("running") : t("exited")) : t("whole agent")}
                accent="ink"
              />
              <Stat label={t("spawned processes")} value={String(spawned)} detail={t("this session")} accent="ink" />
              <Stat
                label={t("session duration")}
                value={sessionDuration > 0 ? formatDuration(sessionDuration) : "—"}
                detail={t("time spent in this session")}
                accent="ink"
              />
            </div>

            <div className="rounded border border-desk-line bg-desk-panel2/40 p-2">
              <div className="mb-1 flex items-center gap-3 font-mono text-[10px] text-desk-dim">
                <span className="text-desk-dim/80">
                  <span className="text-desk-amber">▬</span> {t("this process")}
                </span>
                <span className="text-desk-dim/80">
                  <span className="text-desk-ink/60">┄</span> {t("whole machine")}
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
          </div>
        ) : (
          <MetricTable
            eggs={primary}
            frames={frames}
            remote={remote?.series}
            selectedEggPid={selected?.eggPid}
            onSelect={selectEgg}
            cpuCount={cpuCount}
          />
        )}
      </div>
    </div>
  );
}

interface RemoteMetrics {
  series?: MetricSeries;
  host: HostMetricSeriesPoint[];
}

/** The newest non-null value, or 0 when the chart has nothing yet. */
function lastDefined(values: Array<number | null>): number {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value !== null && value !== undefined && Number.isFinite(value)) return value;
  }
  return 0;
}

function percentOfCores(cores: number, cpuCount: number): number {
  return (cores / Math.max(1, cpuCount)) * 100;
}

/** Ring host values where they exist, the persisted ones elsewhere. */
function prefer(
  fresher: Array<number | null> | undefined,
  older: Array<number | null> | undefined,
): Array<number | null> {
  const length = Math.max(fresher?.length ?? 0, older?.length ?? 0);
  const out: Array<number | null> = [];
  for (let i = 0; i < length; i++) {
    const value = fresher?.[i];
    out.push(value ?? older?.[i] ?? null);
  }
  return out;
}

/**
 * The x axis: a uniform grid over the range, so a missing slot is a real hole.
 * A grid over a very wide "all" span would be enormous, so the step is chosen to
 * keep the slot count bounded.
 */
function slotAxis(from: number, to: number, step: number): number[] {
  const axis: number[] = [];
  for (let ts = Math.ceil(from / step) * step; ts <= to; ts += step) axis.push(ts);
  if (axis.length === 0) axis.push(to);
  return axis;
}

/** Raw ring points for the chart's rates, for one egg or the whole agent. */
function liveRawPoints(
  frames: ReturnType<typeof useMetricsStore.getState>["frames"],
  eggPid: number | undefined,
): Array<{ ts: number; cpuSeconds: number; rssBytes: number }> {
  const points: Array<{ ts: number; cpuSeconds: number; rssBytes: number }> = [];
  if (eggPid !== undefined) {
    for (const frame of frames) {
      const egg = frame.eggs.find((entry) => entry.eggPid === eggPid);
      if (egg) points.push({ ts: frame.ts, cpuSeconds: egg.cpuSeconds, rssBytes: egg.rssBytes });
    }
    return points;
  }
  for (const frame of frames) {
    const egg = frame.agent;
    if (egg) points.push({ ts: frame.ts, cpuSeconds: egg.cpuSeconds, rssBytes: egg.rssBytes });
  }
  return points;
}

/**
 * Persisted points with the live ring's tail appended.
 *
 * A reopened session's ring starts empty and fills forward; the disk holds the
 * history. Later points win on a shared timestamp, which is what makes the
 * boundary between "already flushed" and "still only in memory" seamless.
 */
function mergePoints(
  stored: Array<{ ts: number; cpuSeconds: number; rssBytes: number }>,
  live: SeriesPoint[],
): SeriesPoint[] {
  const byTs = new Map<number, SeriesPoint>();
  for (const point of stored) byTs.set(point.ts, point);
  for (const point of live) byTs.set(point.ts, point);
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
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
  detail?: string;
  accent: "amber" | "teal" | "ink" | "dim";
}) {
  const tone =
    accent === "amber"
      ? "text-desk-amber"
      : accent === "teal"
        ? "text-desk-teal"
        : accent === "dim"
          ? "text-desk-dim"
          : "text-desk-ink/90";
  return (
    <div className="min-w-0 rounded border border-desk-line bg-desk-panel2/40 px-2 py-1.5">
      <div className="truncate font-mono text-[9px] uppercase tracking-[0.14em] text-desk-dim/70">{label}</div>
      <div className={["mt-0.5 truncate font-mono text-lg leading-tight", tone].join(" ")} title={value}>
        {value}
      </div>
      <div className="truncate font-mono text-[9px] text-desk-dim/70">{detail ?? ""}</div>
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
              {formatPercent(percentOfCores(cores, cpuCount))}
            </td>
            <td className="border-b border-desk-line/40 px-1 py-1 text-right">
              {formatPercent(percentOfCores(remote.avgCpuCoresSession, cpuCount))}
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
          const cores = coresFor(frames, egg.eggPid);
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
                {formatPercent(percentOfCores(cores, cpuCount))}
              </td>
              <td className="border-b border-desk-line/40 px-1 py-1 text-right">
                {formatPercent(percentOfCores(egg.avgCpuCoresSession, cpuCount))}
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

/** Instantaneous cores for one egg in the table, from its last two samples. */
function coresFor(frames: ReturnType<typeof useMetricsStore.getState>["frames"], eggPid: number): number {
  const points: Array<{ ts: number; cpuSeconds: number }> = [];
  for (const frame of frames) {
    const egg = frame.eggs.find((entry) => entry.eggPid === eggPid);
    if (egg) points.push({ ts: frame.ts, cpuSeconds: egg.cpuSeconds });
  }
  if (points.length < 2) return 0;
  const last = points[points.length - 1]!;
  const previous = points[points.length - 2]!;
  const seconds = (last.ts - previous.ts) / 1000;
  return seconds > 0 ? Math.max(0, (last.cpuSeconds - previous.cpuSeconds) / seconds) : 0;
}
