import fs from "node:fs";
import type { ObserveChannel, ObserveTargetRow } from "@absence/core";
import type { ObserveDiscoveryRow } from "./Discovery";
import type { ProxySessionInfo } from "../agents/acp/proxy";
import { defaultPiCandidates, findPiSession, pairDefaultSessions } from "../process/ProcessScanner";
import { type ProcessTable } from "../process/ProcessTable";
import { processSnapshot } from "./processSource";
import { pidIdentity } from "./types";

/**
 * The board's target list — “what can I monitor here?”.
 *
 * Targets are *discovered*, not created. Building the list starts no session,
 * no watcher and no sampler: it is a transcript header the tail already parsed,
 * a pi process the signature match already found, a proxy the registry already
 * holds. Choosing one is what attaches it — see `watch.ts` / `watchOs.ts`.
 *
 * A target key is stable across restarts:
 *   - `transcript:<absolute file>` — the transcript file is the identity;
 *   - `proc:<pid>@<startedAtMs>`   — the pid *and* its start time (pids are
 *     reused by the OS, so the pair is the identity);
 *   - `proxy:<session id>`         — the proxy session id.
 */

/** A transcript touched this recently is plausibly still being written. */
const ACTIVE_WINDOW_MS = 10 * 60_000;

/** A pid's start time within this of the chosen one is the same process. */
const PID_START_SLACK_MS = 2_000;

export function transcriptTargetKey(file: string): string {
  return `transcript:${file}`;
}

export function proxyTargetKey(id: string): string {
  return `proxy:${id}`;
}

export function processTargetKey(pid: number, startedAt: number): string {
  return `proc:${pid}@${Math.max(0, Math.trunc(startedAt))}`;
}

/** Parse a `proc:<pid>@<startedAt>` key. */
export function parseProcessKey(key: string): { pid: number; startedAt: number } | undefined {
  const match = /^proc:(\d+)@(\d+)$/.exec(key);
  if (!match) return undefined;
  const pid = Number(match[1]);
  const startedAt = Number(match[2]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  return { pid, startedAt: Number.isSafeInteger(startedAt) ? startedAt : 0 };
}

export interface BuildTargetsDeps {
  transcriptRows: readonly ObserveDiscoveryRow[];
  proxyRows: readonly ProxySessionInfo[];
  /** When the watched session already exists (channel transcript), by externalId. */
  liveByExternal: ReadonlyMap<string, string>;
  /** The process table; injectable for checks. */
  snapshot?: () => Promise<ProcessTable>;
}

/**
 * Build the whole target list.
 *
 * One process-table sweep (the strongest source) is used twice: to give each
 * transcript target its bound pid (`--session <file>` evidence), and to list
 * pi processes that have no transcript of their own (a default `pi` writing a
 * brand-new session) as OS-only targets.
 */
export async function buildTargets(deps: BuildTargetsDeps): Promise<ObserveTargetRow[]> {
  let table: ProcessTable | undefined;
  try {
    table = await (deps.snapshot ?? processSnapshot)();
  } catch {
    // A failed table read is missing evidence, not an empty machine: transcript
    // targets still list, just without a proven pid.
    table = undefined;
  }

  const boundByFile = new Map<string, { pid: number; startedAt: number }>();
  const boundPids = new Set<number>();
  if (table) {
    for (const row of deps.transcriptRows) {
      const info = findPiSession(table, row.file);
      if (info) {
        boundByFile.set(row.file, { pid: info.pid, startedAt: info.startedAt });
        boundPids.add(info.pid);
      }
    }
  }

  // A `pi` started without `--session` names no transcript on its command
  // line, so the only honest link between the process and the file it writes
  // is timing. Pair a running default-`pi` process with the transcript created
  // just as it started (unambiguous 1:1 only — see `pairDefaultSessions`). A
  // paired transcript becomes a single *running* target that carries the
  // conversation, instead of the conversation sitting alone as an `idle`
  // transcript beside a process-only row that shows no chat.
  const pairedByFile = new Map<string, { pid: number; startedAt: number }>();
  const pairedPids = new Set<number>();
  if (table) {
    const candidates = defaultPiCandidates(table).filter((info) => !boundPids.has(info.pid));
    if (candidates.length > 0) {
      const pairable = deps.transcriptRows
        .filter((row) => row.missing !== true && !boundByFile.has(row.file))
        .map((row) => ({ file: row.file, createdAt: fileBirth(row.file, row.lastActivityAt) }));
      for (const [file, pid] of pairDefaultSessions(pairable, candidates)) {
        const info = table.get(pid);
        if (info) {
          pairedByFile.set(file, { pid, startedAt: info.startedAt });
          pairedPids.add(pid);
        }
      }
    }
  }

  const now = Date.now();
  const targets: ObserveTargetRow[] = deps.transcriptRows.map((row) => {
    const sessionId = deps.liveByExternal.get(row.externalId);
    const bound = boundByFile.get(row.file) ?? pairedByFile.get(row.file);
    const recent = now - row.lastActivityAt <= ACTIVE_WINDOW_MS;
    const channels: ObserveChannel[] = ["transcript", ...(bound !== undefined ? (["os"] as const) : [])];
    return {
      key: transcriptTargetKey(row.file),
      kind: "transcript" as const,
      agentKind: row.agentKind,
      ...(row.projectPath !== undefined ? { cwd: row.projectPath } : {}),
      ...(bound !== undefined ? { pid: bound.pid, pidStartedAt: bound.startedAt } : {}),
      transcriptFile: row.file,
      externalId: row.externalId,
      channels,
      liveness:
        row.missing === true
          ? ("missing" as const)
          : bound !== undefined
            ? ("running" as const)
            : recent
              ? ("idle" as const)
              : ("exited" as const),
      lastActivityAt: row.lastActivityAt,
      ...(sessionId !== undefined ? { sessionId } : {}),
      watchable: row.missing !== true,
      ...(row.missing === true ? { reason: "the transcript file is gone" } : {}),
    };
  });

  // pi processes with no transcript of their own: a fresh `pi` the user just
  // started. A process already paired to a transcript above is represented by
  // that running transcript target — it is not listed a second time as an
  // OS-only row, or the same agent would appear twice on the board.
  if (table) {
    for (const info of defaultPiCandidates(table)) {
      if (boundPids.has(info.pid) || pairedPids.has(info.pid)) continue;
      targets.push({
        key: processTargetKey(info.pid, info.startedAt),
        kind: "process",
        agentKind: "pi",
        pid: info.pid,
        pidStartedAt: info.startedAt,
        channels: ["os"],
        liveness: "running",
        lastActivityAt: info.startedAt || now,
        watchable: true,
      });
    }
  }

  for (const row of deps.proxyRows) {
    targets.push({
      key: proxyTargetKey(row.id),
      kind: "proxy",
      agentKind: row.label,
      cwd: row.cwd,
      ...(row.pid !== undefined ? { pid: row.pid } : {}),
      channels: ["acp-proxy"],
      liveness: row.status === "running" ? "running" : "exited",
      lastActivityAt: row.closedAt ?? row.createdAt,
      ...(row.sessionId !== undefined ? { sessionId: row.sessionId } : {}),
      watchable: row.sessionId !== undefined,
      ...(row.sessionId === undefined ? { reason: "the agent has not spawned yet" } : {}),
    });
  }

  const priority: Record<ObserveTargetRow["liveness"], number> = {
    running: 0,
    idle: 1,
    exited: 2,
    missing: 3,
  };
  targets.sort(
    (a, b) =>
      priority[a.liveness] - priority[b.liveness] ||
      b.lastActivityAt - a.lastActivityAt ||
      a.key.localeCompare(b.key),
  );
  return targets;
}

/** The pid identity a process target records (immune to pid reuse). */
export { pidIdentity };

/**
 * The transcript file's birth time (epoch ms) — the pairing anchor.
 *
 * Falls back to the row's last activity when the filesystem cannot report a
 * birth time, so a platform without it degrades to “roughly when we saw it”
 * rather than crashing the whole target build.
 */
function fileBirth(file: string, fallback: number): number {
  try {
    const stat = fs.statSync(file);
    return stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs || fallback;
  } catch {
    return fallback;
  }
}

/** True when a table row is the same process a `proc:` key names. */
export function sameProcess(
  info: { pid: number; startedAt: number } | undefined,
  pid: number,
  startedAt: number,
): boolean {
  if (info === undefined || info.pid !== pid) return false;
  if (startedAt <= 0) return true;
  return Math.abs(info.startedAt - startedAt) <= PID_START_SLACK_MS;
}
