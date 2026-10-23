import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartSeries } from "../../lib/metrics";

interface TimeSeriesChartProps {
  data: ChartSeries;
  height?: number;
  label: string;
  metric: "cpu" | "mem";
  xTickSeconds: number;
  hostLabel: string;
}

export function TimeSeriesChart({
  data,
  height = 180,
  label,
  metric,
  xTickSeconds,
  hostLabel,
}: TimeSeriesChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const isCpu = metric === "cpu";
    const values = isCpu ? data.cpuCores : data.rssMiB;
    const hostValues = isCpu ? data.hostCpuPercent : data.hostMemMiB;
    const tooltip = tooltipRef.current;
    const options: uPlot.Options = {
      width: Math.max(240, host.clientWidth),
      height,
      series: [
        {},
        {
          label,
          stroke: isCpu ? "rgb(224, 163, 92)" : "rgb(79, 179, 165)",
          width: 1.8,
          points: { show: true, size: 5 },
        },
        {
          label: hostLabel,
          stroke: "rgba(190, 190, 190, 0.75)",
          dash: [5, 4],
          width: 1.2,
          points: { show: false },
        },
      ],
      axes: [
        {
          stroke: "rgb(139, 129, 117)",
          grid: { stroke: "rgba(255, 255, 255, 0.06)" },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
          splits: (_u, _axis, min, max) => {
            const first = Math.ceil(min / xTickSeconds) * xTickSeconds;
            const splits: number[] = [];
            for (let value = first; value <= max; value += xTickSeconds) splits.push(value);
            return splits;
          },
        },
        {
          stroke: isCpu ? "rgb(224, 163, 92)" : "rgb(79, 179, 165)",
          grid: { stroke: "rgba(255, 255, 255, 0.06)" },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
        },
      ],
      scales: {
        x: { time: true },
        y: {
          auto: true,
          range: (_u, min, max) => {
            const span = Math.max(1, max - min);
            return [Math.max(0, min - span * 0.08), max + span * 0.08];
          },
        },
      },
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: true },
      },
      hooks: {
        setCursor: [
          (chart) => {
            const index = chart.cursor.idx;
            if (!tooltip || index == null || index < 0 || index >= data.ts.length) {
              if (tooltip) tooltip.hidden = true;
              return;
            }
            const target = values[index];
            const machine = hostValues?.[index];
            const date = new Date(data.ts[index]! * 1000);
            tooltip.textContent = `${date.toLocaleTimeString()}  ${label}: ${formatValue(target, isCpu)}  ${hostLabel}: ${formatValue(machine, isCpu)}`;
            tooltip.hidden = false;
            const left = chart.valToPos(data.ts[index]!, "x");
            tooltip.style.left = `${Math.min(Math.max(4, left), host.clientWidth - tooltip.offsetWidth - 4)}px`;
          },
        ],
      },
      padding: [8, 8, 0, 8],
    };
    const chart = new uPlot(options, [
      data.ts,
      values.map((value) => (Number.isFinite(value) ? value : null)),
      (hostValues ?? []).map((value) => (Number.isFinite(value) ? value : null)),
    ] as uPlot.AlignedData, host);
    chartRef.current = chart;
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(240, host.clientWidth), height });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.destroy();
      chartRef.current = null;
    };
  }, [data, height, hostLabel, label, metric, xTickSeconds]);

  return (
    <div className="relative w-full">
      <div ref={hostRef} className="w-full" />
      <div
        ref={tooltipRef}
        hidden
        className="pointer-events-none absolute top-1 z-10 rounded border border-desk-line bg-desk-panel px-2 py-1 font-mono text-[10px] text-desk-ink shadow-lg"
      />
    </div>
  );
}

function formatValue(value: number | undefined, isCpu: boolean): string {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return `${value.toFixed(isCpu ? 2 : 1)} ${isCpu ? "%" : "MiB"}`;
}
