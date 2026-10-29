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

export function formatBytes(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0 B";
  if (count < 1024) return `${count} B`;
  if (count < 1024 * 1024) return `${(count / 1024).toFixed(count < 10 * 1024 ? 1 : 0)} kB`;
  return `${(count / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A duration as a clock: `MM:SS`, or `H:MM:SS` once it passes an hour.
 *
 * The hours matter: `minutes` used to be unbounded, so a run that lasted two
 * hours printed `120:33` — which reads as a broken clock, not as a long run.
 * Every caller (replay offsets, the report's timeline, a process's lifetime, a
 * run's duration) is a *span*, so rolling into hours is right for all of them.
 * Zero-padded under an hour, because these are compared down a column.
 */
export function formatOffset(ms: number): string {
  // `Math.max(0, NaN)` is NaN, so an unmeasurable span (a run with no end yet,
  // a clock that was never set) would print `NaN:NaN`. Clamp it to zero here
  // once, for every caller.
  const total = Number.isFinite(ms) ? Math.max(0, Math.floor(ms / 1000)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/**
 * A span of time, for how long a process ran.
 *
 * The same clock as `formatOffset` — one formatter, so "how long was this
 * process alive" and "how far into the run was this" can never disagree about
 * what `1:02:03` means.
 */
export const formatDuration = formatOffset;

/** "12s ago" style relative time. */
export function formatAgo(timestamp: number | undefined, now = Date.now()): string {
  if (!timestamp) return "never";
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
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

/** Reverse of absoluteProjectPath: absolute posix path → project-relative. */
export function relativeTo(projectPath: string, absolute: string): string {
  const root = projectPath.replace(/\\/g, "/").replace(/\/$/, "");
  const path = absolute.replace(/\\/g, "/");
  return path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
}
