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

/** mm:ss for replay offsets (read02 §21). */
export function formatOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

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
