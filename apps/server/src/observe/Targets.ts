import fs from "node:fs";
import type { ObserveChannel, ObserveTargetRow } from "@absence/core";
import type { ObserveDiscoveryRow } from "./Discovery";
import type { ProxySessionInfo } from "../agents/acp/proxy";
import { findPiSession, pairDefaultSessions, piSessionRef, unboundPiCandidates } from "../process/ProcessScanner";
import { type ProcessTable } from "../process/ProcessTable";
import { processSnapshot } from "./processSource";
import { pidIdentity, samePidStart } from "./types";

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

/** The pid a transcript's agent is, when the evidence proves it. */
export interface TranscriptBinding {
  pid: number;
  startedAt: number;
}

/**
 * Which transcript each running pi process writes — the board's and the OS
 * channel's shared evidence.
 *
 * Three proofs, strongest first: `--session <file>` names the transcript on the
 * command line; `--session <id>` names the session, whose transcript carries
 * that id in its header; a bare `pi` is paired with the file it wrote (see
 * `pairDefaultSessions` — timing at startup, latest write after a resume). The
 * result is recomputed on every call; a process that resumed another session
 * mid-run must follow that file, not the one it started with.
 */
export function bindTranscriptProcesses(
  rows: readonly ObserveDiscoveryRow[],
  table: ProcessTable,
): { byFile: Map<string, TranscriptBinding>; boundPids: Set<number> } {
  const byFile = new Map<string, TranscriptBinding>();
  const boundPids = new Set<number>();
  // 1. The command line names the transcript file outright.
  for (const row of rows) {
    const info = findPiSession(table, row.file);
    if (info) {
      byFile.set(row.file, { pid: info.pid, startedAt: info.startedAt });
      boundPids.add(info.pid);
    }
  }

  // 2. `--session <id>`: a resume by identifier. The transcript's header
  // carries that id, so the row with the same externalId is this process's
  // file — no timing guess needed.
  const candidates = unboundPiCandidates(table).filter((info) => !boundPids.has(info.pid));
  for (const info of candidates) {
    const id = piSessionRef(info)?.id;
    if (id === undefined) continue;
    const row = rows.find(
      (candidate) => candidate.missing !== true && !byFile.has(candidate.file) && candidate.externalId === id,
    );
    if (!row) continue;
    byFile.set(row.file, { pid: info.pid, startedAt: info.startedAt });
    boundPids.add(info.pid);
  }

  // 3. Timing plus writes, for the processes still unbound.
  const pairableProcesses = candidates.filter((info) => !boundPids.has(info.pid));
  if (pairableProcesses.length === 0) return { byFile, boundPids };
  const pairable = rows
    .filter((row) => row.missing !== true && !byFile.has(row.file))
    .map((row) => {
      const times = fileTimes(row.file);
      return {
        file: row.file,
        createdAt: times.birth ?? row.lastActivityAt,
        // The file's own mtime, not the discovery row's: the row is bumped to
        // "now" while Absence merely reads a header, and pairing on that would
        // make every old transcript look freshly written at server start.
        lastActivityAt: times.modified ?? row.lastActivityAt,
        ...(row.projectPath !== undefined ? { cwd: row.projectPath } : {}),
      };
    });
  for (const [file, pid] of pairDefaultSessions(pairable, pairableProcesses)) {
    const info = table.get(pid);
    if (!info) continue;
    byFile.set(file, { pid, startedAt: info.startedAt });
    boundPids.add(pid);
  }
  return { byFile, boundPids };
}

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
  /**
   * Reads a transcript's first user prompt, for a running row's subtitle. Only
   * called for running transcript targets (a handful), so the head read stays
   * cheap; omitted in checks that need no prompt.
   */
  firstPromptOf?: (file: string) => Promise<string | undefined>;
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

  const now = Date.now();

  // A `pi` started without `--session` names no transcript on its command
  // line, so the only honest link between the process and the file it writes
  // is timing plus writes. `bindTranscriptProcesses` picks the file written
  // latest while the process ran — never a startup pairing the process has
  // since moved on from. A paired transcript becomes a single *running* target
  // that carries the conversation, instead of the conversation sitting alone
  // as an `idle` transcript beside a process-only row that shows no chat.
  const bound = table ? bindTranscriptProcesses(deps.transcriptRows, table) : undefined;
  const boundByFile = bound?.byFile ?? new Map<string, TranscriptBinding>();
  const boundPids = bound?.boundPids ?? new Set<number>();
  const targets: ObserveTargetRow[] = await Promise.all(
    deps.transcriptRows.map(async (row) => {
      const sessionId = deps.liveByExternal.get(row.externalId);
      const bound = boundByFile.get(row.file);
      const recent = now - row.lastActivityAt <= ACTIVE_WINDOW_MS;
      const channels: ObserveChannel[] = ["transcript", ...(bound !== undefined ? (["os"] as const) : [])];
      const liveness =
        row.missing === true
          ? ("missing" as const)
          : bound !== undefined
            ? ("running" as const)
            : recent
              ? ("idle" as const)
              : ("exited" as const);
      // Only running rows go on the board's left column, so only they pay for
      // reading the transcript's first prompt.
      const firstPrompt =
        liveness === "running" && deps.firstPromptOf !== undefined
          ? await deps.firstPromptOf(row.file).catch(() => undefined)
          : undefined;
      return {
        key: transcriptTargetKey(row.file),
        kind: "transcript" as const,
        agentKind: row.agentKind,
        ...(row.projectPath !== undefined ? { cwd: row.projectPath } : {}),
        ...(bound !== undefined ? { pid: bound.pid, pidStartedAt: bound.startedAt } : {}),
        transcriptFile: row.file,
        externalId: row.externalId,
        channels,
        liveness,
        lastActivityAt: row.lastActivityAt,
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(firstPrompt !== undefined ? { firstPrompt } : {}),
        watchable: row.missing !== true,
        ...(row.missing === true ? { reason: "the transcript file is gone" } : {}),
      };
    }),
  );

  // pi processes whose transcript is not named on the command line: a fresh
  // `pi` the user just started, or one resumed by session id. A process already
  // paired to a transcript above is represented by that running transcript
  // target — it is not listed a second time as an OS-only row, or the same
  // agent would appear twice on the board.
  if (table) {
    for (const info of unboundPiCandidates(table)) {
      if (boundPids.has(info.pid)) continue;
      targets.push({
        key: processTargetKey(info.pid, info.startedAt),
        kind: "process",
        agentKind: "pi",
        // The working directory is how a person tells two `pi` windows apart;
        // a bare `proc:<pid>@<start>` names nothing they can recognise.
        ...(info.cwd !== undefined && info.cwd.length > 0 ? { cwd: info.cwd } : {}),
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
 * The transcript file's birth and last-write times (epoch ms) — the pairing
 * anchors. One `stat` serves both; a missing file yields neither, and the
 * caller falls back to the discovery row's own timestamp.
 */
function fileTimes(file: string): { birth?: number; modified?: number } {
  try {
    const stat = fs.statSync(file);
    return {
      birth: stat.birthtimeMs > 0 ? stat.birthtimeMs : stat.mtimeMs || undefined,
      modified: stat.mtimeMs || undefined,
    };
  } catch {
    return {};
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
  return samePidStart(info.startedAt, startedAt);
}
