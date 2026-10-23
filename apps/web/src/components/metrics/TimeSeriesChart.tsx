import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";
import type { ChartSeries } from "../../lib/metrics";

interface TimeSeriesChartProps {
  data: ChartSeries;
  height?: number;
  cpuLabel: string;
  memLabel: string;
}

/**
 * The full dashboard's chart. uPlot is a canvas time-series renderer: axes,
 * grid, cursor and two independent y scales for CPU (cores) and memory (MiB).
 */
export function TimeSeriesChart({ data, height = 260, cpuLabel, memLabel }: TimeSeriesChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<uPlot | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const options: uPlot.Options = {
      width: Math.max(240, host.clientWidth),
      height,
      series: [
        {},
        {
          label: cpuLabel,
          scale: "cpu",
          stroke: "rgb(224, 163, 92)",
          fill: "rgba(224, 163, 92, 0.10)",
          width: 1.6,
          points: { show: false },
        },
        {
          label: memLabel,
          scale: "mem",
          stroke: "rgb(79, 179, 165)",
          fill: "rgba(79, 179, 165, 0.08)",
          width: 1.4,
          points: { show: false },
        },
      ],
      axes: [
        {
          stroke: "rgb(139, 129, 117)",
          grid: { stroke: "rgba(255, 255, 255, 0.06)" },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
        },
        {
          scale: "cpu",
          stroke: "rgb(224, 163, 92)",
          grid: { stroke: "rgba(255, 255, 255, 0.06)" },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
        },
        {
          scale: "mem",
          side: 1,
          stroke: "rgb(79, 179, 165)",
          grid: { show: false },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
        },
      ],
      scales: {
        x: { time: true },
        // Both are absolute quantities, so start at zero: an idle process at
        // 0.00 cores should sit on the floor, not in the middle of a
        // meaningless 0.00–0.00 window.
        cpu: {
          auto: true,
          range: (_u, _min, max) => [0, Math.max(1, max * 1.1)],
        },
        mem: {
          auto: true,
          range: (_u, _min, max) => [0, Math.max(1, max * 1.1)],
        },
      },
      legend: { show: false },
      cursor: {
        drag: { x: true, y: false, setScale: true },
      },
      padding: [8, 8, 0, 8],
    };
    const chart = new uPlot(options, toData(data), host);
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
  }, [height, cpuLabel, memLabel]);

  useEffect(() => {
    chartRef.current?.setData(toData(data));
  }, [data]);

  return <div ref={hostRef} className="w-full" />;
}

function toData(data: ChartSeries): uPlot.AlignedData {
  // uPlot wants x in seconds; a missing CPU sample is a gap, not a zero.
  return [
    data.ts,
    data.cpuCores.map((value) => (Number.isFinite(value) ? value : null)),
    data.rssMiB.map((value) => (Number.isFinite(value) ? value : null)),
  ] as uPlot.AlignedData;
}
