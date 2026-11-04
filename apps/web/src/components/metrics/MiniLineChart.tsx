import { useEffect, useRef } from "react";
import uPlot from "uplot";
import "uplot/dist/uPlot.min.css";

/**
 * A thin, generic line chart — the uPlot skeleton TimeSeriesChart uses, with
 * the series lifted into props so a page can draw any set of lines over one
 * time axis. TimeSeriesChart stays as-is: it owns the CPU/memory series shapes
 * the live dashboard depends on, and this one serves aggregate pages where the
 * series are computed per render.
 */
export interface MiniSeries {
  label: string;
  /** A concrete colour string (canvas cannot resolve CSS variables). */
  color: string;
  /** One value per timestamp; null leaves a hole, it is never drawn as 0. */
  values: Array<number | null>;
}

interface MiniLineChartProps {
  /** Unix seconds, one per column — the same axis every series shares. */
  ts: number[];
  series: MiniSeries[];
  height?: number;
}

export function MiniLineChart({ ts, series, height = 160 }: MiniLineChartProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const tooltip = tooltipRef.current;
    const options: uPlot.Options = {
      width: Math.max(240, host.clientWidth),
      height,
      series: [
        {},
        ...series.map((entry) => ({
          label: entry.label,
          stroke: entry.color,
          width: 1.8,
          points: { show: ts.length <= 48 },
          spanGaps: false,
        })),
      ],
      axes: [
        {
          stroke: "rgb(139, 129, 117)",
          grid: { stroke: "rgba(255, 255, 255, 0.06)" },
          ticks: { stroke: "rgba(255, 255, 255, 0.12)" },
          font: "10px ui-monospace, monospace",
        },
        {
          stroke: "rgb(139, 129, 117)",
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
            if (!tooltip || index == null || index < 0 || index >= ts.length) {
              if (tooltip) tooltip.hidden = true;
              return;
            }
            const parts = series.map((entry) => {
              const value = entry.values[index];
              return `${entry.label}: ${typeof value === "number" && Number.isFinite(value) ? value : "—"}`;
            });
            const date = new Date(ts[index]! * 1000);
            tooltip.textContent = `${date.toLocaleString()}  ${parts.join("  ")}`;
            tooltip.hidden = false;
            const left = chart.valToPos(ts[index]!, "x");
            tooltip.style.left = `${Math.min(Math.max(4, left), host.clientWidth - tooltip.offsetWidth - 4)}px`;
          },
        ],
      },
      padding: [8, 8, 0, 8],
    };
    const data = [
      ts,
      ...series.map((entry) =>
        entry.values.map((value) => (typeof value === "number" && Number.isFinite(value) ? value : null)),
      ),
    ] as uPlot.AlignedData;
    const chart = new uPlot(options, data, host);
    const observer = new ResizeObserver(() => {
      chart.setSize({ width: Math.max(240, host.clientWidth), height });
    });
    observer.observe(host);
    return () => {
      observer.disconnect();
      chart.destroy();
    };
  }, [ts, series, height]);

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
