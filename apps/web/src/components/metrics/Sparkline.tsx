interface SparklineProps {
  values: number[];
  width?: number;
  height?: number;
  stroke?: string;
  fill?: string;
  className?: string;
}

/** A tiny SVG sparkline for the 320px panel. No dependency, no axes. */
export function Sparkline({
  values,
  width = 280,
  height = 36,
  stroke = "rgb(var(--desk-accent))",
  fill = "rgba(224, 163, 92, 0.12)",
  className,
}: SparklineProps) {
  if (values.length < 2) {
    return <div className={className} style={{ height }} aria-hidden />;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return <div className={className} style={{ height }} aria-hidden />;
  if (max - min < 1e-9) {
    max += 1;
    min = Math.max(0, min - 1);
  }
  const stepX = width / Math.max(1, values.length - 1);
  const y = (value: number) => height - 2 - ((value - min) / (max - min)) * (height - 4);
  const points = values.map((value, index) => `${(index * stepX).toFixed(2)},${y(value).toFixed(2)}`);
  const line = `M${points.join(" L")}`;
  const area = `${line} L${width},${height} L0,${height} Z`;
  return (
    <svg
      className={className}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      style={{ width: "100%", height }}
      aria-hidden
    >
      <path d={area} fill={fill} stroke="none" />
      <path d={line} fill="none" stroke={stroke} strokeWidth={1.4} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
