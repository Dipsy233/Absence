import type { ObserveTargetRow } from "@absence/core";
import type { ObserveDiscoveryRow } from "./Discovery";
import type { ProxySessionInfo } from "../agents/acp/proxy";

/**
 * The board's target list — “what can I monitor here?”.
 *
 * Targets are *discovered*, not created. Building the list starts no session,
 * no watcher and no sampler: it is a transcript header the tail already parsed,
 * a proxy the registry already holds, or (later) a process-table signature
 * match. Choosing one is what attaches it — see `watch.ts`.
 *
 * A target key is stable across restarts:
 *   - `transcript:<absolute file>` — the transcript file is the identity;
 *   - `proc:<pid>@<startedAtMs>`   — the pid *and* its start time (pids are
 *     reused by the OS, so the pair is the identity);
 *   - `proxy:<session id>`         — the proxy session id.
 */

/** A transcript touched this recently is plausibly still being written. */
const ACTIVE_WINDOW_MS = 10 * 60_000;

export function transcriptTargetKey(file: string): string {
  return `transcript:${file}`;
}

export function proxyTargetKey(id: string): string {
  return `proxy:${id}`;
}

/**
 * Transcript targets.
 *
 * Liveness is the transcript's own evidence, and says so: a recently written
 * file is `idle` (nothing is proving a live process), a stale one is `exited`
 * (the agent most plausibly stopped writing), a vanished one is `missing`.
 * Process truth arrives with the process scan, which is the stronger source
 * when both describe the same conversation.
 */
export function transcriptTargets(
  rows: readonly ObserveDiscoveryRow[],
  liveByExternal: ReadonlyMap<string, string>,
  now = Date.now(),
): ObserveTargetRow[] {
  return rows.map((row) => {
    const sessionId = liveByExternal.get(row.externalId);
    const recent = now - row.lastActivityAt <= ACTIVE_WINDOW_MS;
    return {
      key: transcriptTargetKey(row.file),
      kind: "transcript" as const,
      agentKind: row.agentKind,
      ...(row.projectPath !== undefined ? { cwd: row.projectPath } : {}),
      transcriptFile: row.file,
      externalId: row.externalId,
      channels: ["transcript" as const],
      liveness: row.missing === true ? ("missing" as const) : recent ? ("idle" as const) : ("exited" as const),
      lastActivityAt: row.lastActivityAt,
      ...(sessionId !== undefined ? { sessionId } : {}),
      watchable: row.missing !== true,
      ...(row.missing === true ? { reason: "the transcript file is gone" } : {}),
    };
  });
}

/** Proxy targets: the ACP proxy already spawned its agent, so a session exists. */
export function proxyTargets(rows: readonly ProxySessionInfo[]): ObserveTargetRow[] {
  return rows.map((row) => ({
    key: proxyTargetKey(row.id),
    kind: "proxy" as const,
    agentKind: row.label,
    cwd: row.cwd,
    ...(row.pid !== undefined ? { pid: row.pid } : {}),
    channels: ["acp-proxy" as const],
    liveness: row.status === "running" ? ("running" as const) : ("exited" as const),
    lastActivityAt: row.closedAt ?? row.createdAt,
    ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
    watchable: row.sessionId !== undefined,
    ...(row.sessionId === undefined ? { reason: "the agent has not spawned yet" } : {}),
  }));
}
