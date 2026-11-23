/**
 * `absence ls | observe | open | unwatch` — the headless server's client side.
 *
 * These are thin clients over the running server's HTTP API, so a machine with
 * no desktop can still drive the observer from a shell (and paste the printed
 * `/s/<id>` URL into a browser on another machine). They never read the
 * server's memory or a local archive: the server is the single source of truth,
 * whether it is on this host or across an SSH tunnel.
 *
 * The base URL is `--server`, else `ABSENCE_URL`, else `http://127.0.0.1:PORT`.
 * The token is `--token`, else `ABSENCE_TOKEN` (required when the server was
 * started on a non-loopback host).
 */
import type { ObserveTargetRow, ObserveWatchResponse } from "@absence/core";
import { config } from "./config";

export interface ClientOptions {
  baseUrl: string;
  token?: string;
}

/** Resolve the server base URL + token from flags and env. */
export function resolveClient(args: { server?: string; token?: string }): ClientOptions {
  const baseUrl =
    args.server ?? process.env.ABSENCE_URL ?? `http://127.0.0.1:${process.env.PORT ?? config.port}`;
  const token = args.token ?? process.env.ABSENCE_TOKEN;
  return { baseUrl: baseUrl.replace(/\/$/, ""), ...(token ? { token } : {}) };
}

/** Append the token as a query param — the one credential the API accepts on a URL. */
function withToken(path: string, token?: string): string {
  if (!token) return path;
  const separator = path.includes("?") ? "&" : "?";
  return `${path}${separator}token=${encodeURIComponent(token)}`;
}

async function request<T>(opts: ClientOptions, method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${opts.baseUrl}${withToken(path, opts.token)}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(opts.token ? { "x-absence-token": opts.token } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let parsed: unknown;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const detail =
      parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : text.trim() || `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return parsed as T;
}

export async function listTargets(opts: ClientOptions): Promise<ObserveTargetRow[]> {
  const body = await request<{ targets: ObserveTargetRow[] }>(opts, "GET", "/api/observe/targets");
  return body.targets;
}

export async function watchTarget(opts: ClientOptions, key: string): Promise<ObserveWatchResponse> {
  return request<ObserveWatchResponse>(opts, "POST", "/api/observe/watch", { key });
}

export async function unwatchSession(opts: ClientOptions, sessionId: string): Promise<void> {
  await request<unknown>(opts, "POST", "/api/observe/unwatch", { sessionId });
}

/** The absolute panel URL for a session on this server. */
export function panelUrl(opts: ClientOptions, sessionId: string): string {
  const url = `${opts.baseUrl}/s/${encodeURIComponent(sessionId)}`;
  return opts.token ? `${url}?token=${encodeURIComponent(opts.token)}` : url;
}

/** One line per target for a terminal. */
export function formatTarget(row: ObserveTargetRow): string {
  const channels = row.channels.join("+");
  const where = row.cwd ?? row.transcriptFile ?? "";
  const pid = row.pid !== undefined ? ` pid=${row.pid}` : "";
  const watched = row.sessionId !== undefined ? " (watching)" : "";
  const reason = !row.watchable && row.reason ? ` — ${row.reason}` : "";
  return `${row.liveness.padEnd(7)} ${row.agentKind.padEnd(6)} ${channels.padEnd(16)} ${row.key}${pid} ${where}${watched}${reason}`.trimEnd();
}

/**
 * Pick the target a selector names.
 *
 * Selectors are tried strongest-first and never guess: `--pid` alone is
 * refused when two rows name that pid, and `--cwd` is refused when several
 * different processes live there. An ambiguous selector is a mistake the user
 * can fix; a wrong pick is a monitor on the wrong agent.
 */
export function selectTarget(
  rows: ObserveTargetRow[],
  selector: { pid?: number; file?: string; cwd?: string; latest?: boolean },
): ObserveTargetRow {
  const watchable = rows.filter((row) => row.watchable);
  if (selector.pid !== undefined) {
    const matches = watchable.filter((row) => row.pid === selector.pid);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`pid ${selector.pid} names ${matches.length} targets; use --session or the board`);
    throw new Error(`no watchable target has pid ${selector.pid} — is the agent running and past the first scan?`);
  }
  if (selector.file !== undefined) {
    const match = watchable.find((row) => row.transcriptFile === selector.file);
    if (match) return match;
    throw new Error(`no watchable transcript names ${selector.file}`);
  }
  if (selector.cwd !== undefined) {
    const normalise = (value: string) => value.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
    const matches = watchable.filter((row) => row.cwd !== undefined && normalise(row.cwd) === normalise(selector.cwd!));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error(`${matches.length} targets work in ${selector.cwd}; name one with --pid or --session`);
    throw new Error(`no watchable target works in ${selector.cwd}`);
  }
  if (selector.latest === true) {
    const recent = [...watchable].sort((a, b) => b.lastActivityAt - a.lastActivityAt)[0];
    if (recent) return recent;
    throw new Error("no watchable targets right now");
  }
  throw new Error("choose a target with --pid, --session, --cwd or --latest");
}
