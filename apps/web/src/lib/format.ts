/** Small display helpers. */

export function formatClock(timestamp: number): string {
  const d = new Date(timestamp);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

export function formatTokens(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

export function formatContext(used: number | null | undefined, total: number | null | undefined): string {
  if (used === null || used === undefined || !total) return "—";
  return `${formatTokens(used)} / ${formatTokens(total)}`;
}

/** Absolute, forward-slash path for an event path relative to the project. */
export function absoluteProjectPath(projectPath: string, eventPath: string): string {
  const normalizedProject = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  if (/^([a-zA-Z]:|\/)/.test(eventPath)) return eventPath.replace(/\\/g, "/");
  return `${normalizedProject}/${eventPath.replace(/\\/g, "/")}`;
}
