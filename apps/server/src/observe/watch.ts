import type { ObserveChannel, ObserveWatchResponse, ObserveWatchState } from "@absence/core";
import type { DiscoveryService } from "./Discovery";
import { deleteLease, deleteLeasesForSession, listLeases, putLease, touchLease, type WatchLease } from "./leases";
import { proxySessions } from "../agents/acp/proxy";
import { findPiSession } from "../process/ProcessScanner";
import { processSnapshot } from "./processSource";
import { processTargetKey, bindTranscriptProcesses } from "./Targets";
import { sessionStore } from "../sessions/SessionStore";
import type { ObserveMeta } from "./types";

/**
 * Choosing a target, and the lifetime that follows.
 *
 * `watch()` is the one action the board performs: it resolves a target key to
 * the observation channel that can feed it, attaches the session (idempotent
 * per (channel, externalId)), and records a lease. Nothing is spawned and
 * nothing is prompted — the agent keeps running in its own terminal.
 *
 * The lease answers “I closed the tab, am I still monitoring?”: yes.
 * `restoreLeases()` re-attaches at boot, and `SessionStore.archiveIdle` keeps a
 * leased session far longer than a merely auto-attached transcript.
 */

export interface WatchDeps {
  discovery: DiscoveryService;
}

/**
 * What a caller already knows about the process behind a target.
 *
 * A default `pi` (started with `-c` or the resume picker) names no transcript
 * on its command line, so the OS channel cannot find the conversation on its
 * own. The board already proved which file this pid writes — pass it along,
 * or the session opens with no facts at all.
 */
export interface ProcessWatchHint {
  transcriptFile?: string;
}

export interface WatchResult extends ObserveWatchResponse {
  /** The lease that now holds it (for diagnostics/tests). */
  lease: WatchLease;
}

function transcriptFileOf(key: string): string | undefined {
  const prefix = "transcript:";
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined;
}

function proxyIdOf(key: string): string | undefined {
  const prefix = "proxy:";
  return key.startsWith(prefix) && key.length > prefix.length ? key.slice(prefix.length) : undefined;
}

/** Where a lease's session is watched, for a CLI to print one line. */
export function sessionUrl(sessionId: string): string {
  return `/s/${encodeURIComponent(sessionId)}`;
}

/**
 * The running process that writes this transcript, if there is one.
 *
 * Same evidence the board used to call the row `running`: a unique pi process
 * naming this exact `--session` path, or a default `pi` paired with the file
 * it last wrote (`bindTranscriptProcesses`). Recomputing it here is what keeps
 * the click and the row in agreement — a process that resumed another session
 * mid-run is followed on the file it writes now, not the one it started with.
 * When there is no such process (the agent exited, or the file is an archive),
 * the transcript is history and is replayed instead.
 */
async function boundRunningPid(
  file: string,
  deps: WatchDeps,
): Promise<{ pid: number; startedAt: number } | undefined> {
  const table = await processSnapshot().catch(() => undefined);
  if (table === undefined) return undefined;
  return bindTranscriptProcesses(deps.discovery.list(), table).byFile.get(file);
}

/**
 * Attach a lease's session, whatever it takes.
 *
 * Four ways in, strongest first: an OS lease goes back to the pid the user
 * chose (finding it, or reopening its archive) and folds the transcript in;
 * a transcript lease uses the tail, then the archive by identity; a proxy lease
 * only needs the store. Called both when a watch is created and when the leases
 * are restored at boot — the same code, so the two paths cannot drift.
 */
async function attachLease(lease: WatchLease, deps: WatchDeps): Promise<void> {
  if (lease.channel === "acp-proxy") {
    sessionStore.get(lease.sessionId)?.setMonitorLease(true);
    return;
  }
  // An OS lease is the pid, not the file: re-attaching through the transcript
  // first would open a second, transcript-keyed session and leave the chosen
  // OS one orphaned. Try the process again (which also folds the transcript
  // into the *same* session); fall through when it has exited.
  if (lease.channel === "os" && lease.pid !== undefined && lease.pidStartedAt !== undefined) {
    const procKey = processTargetKey(lease.pid, lease.pidStartedAt);
    const hint = lease.file !== undefined ? { transcriptFile: lease.file } : undefined;
    const result = await watchProcessTarget(procKey, deps, hint);
    if (result !== undefined) {
      // The lease keeps its own key; the pid-keyed one was only the way in.
      deleteLease(procKey);
      putLease({ ...result.lease, targetKey: lease.targetKey });
      return;
    }
  }
  if (lease.channel === "transcript" && lease.file !== undefined) {
    const row = await deps.discovery.attach(lease.file);
    if (row?.sessionId !== undefined) {
      sessionStore.get(row.sessionId)?.setMonitorLease(true);
      touchLease(lease.targetKey);
      return;
    }
  }
  // The tail does not know the file yet (chokidar's add events are async), or
  // the file is gone for good. The archive is still the conversation's record:
  // reopen it by identity, and the tail (if it ever appears) will only warm.
  const observe: ObserveMeta = {
    channel: lease.channel,
    externalId: lease.externalId,
    ...(lease.file !== undefined ? { transcriptFile: lease.file } : {}),
    ...(lease.pid !== undefined ? { pid: lease.pid } : {}),
    ...(lease.pidStartedAt !== undefined ? { pidStartedAt: lease.pidStartedAt } : {}),
    ...(lease.channel === "os"
      ? {
          channels: ["os"] as ObserveChannel[],
          // A transcript gives the session a real project; only a bare process
          // has no tree to watch.
          ...(lease.file === undefined ? { watchProject: false } : {}),
        }
      : {}),
  };
  const session = await sessionStore.createObserved(
    lease.projectPath ?? lease.file ?? process.cwd(),
    lease.agentKind ?? "unknown",
    observe,
  );
  session.setMonitorLease(true);
  // An upgraded OS-only watch was also fed a transcript: resume that feed too,
  // so the reopened session keeps receiving content facts, not just processes.
  if (lease.channel === "os" && lease.file !== undefined) {
    if (await deps.discovery.attachInto(lease.file, session)) session.addObservationChannel("transcript");
  }
  touchLease(lease.targetKey);
}

/**
 * Watch one target. Returns undefined when the key names nothing this host can
 * observe (a stale link, a transcript that vanished, a proxy with no agent).
 */
export async function watchTarget(key: string, deps: WatchDeps): Promise<WatchResult | undefined> {
  const file = transcriptFileOf(key);
  if (file !== undefined) {
    const row = await deps.discovery.inspect(file);
    if (row === undefined) return undefined;
    const now = Date.now();

    // If the transcript's agent is running right now, watch it with kernel
    // precision: delegate to the OS channel, which binds the pid (a dedicated
    // Job Object on Windows) and folds this transcript's conversation in. The
    // user keeps running pi in their own terminal; we simply picked the exact
    // process behind this file. An exited/archived transcript falls through to
    // a plain transcript session (history replay).
    const boundPid = await boundRunningPid(file, deps);
    if (boundPid !== undefined) {
      const procKey = processTargetKey(boundPid.pid, boundPid.startedAt);
      const osResult = await watchProcessTarget(procKey, deps, { transcriptFile: file });
      if (osResult !== undefined) {
        // Re-file the lease under the transcript key so the board's row and
        // unwatch-by-key address the same session, and a restart re-attaches
        // the transcript identity exactly once (not a second, pid-keyed one).
        deleteLease(procKey);
        const lease: WatchLease = { ...osResult.lease, targetKey: key };
        putLease(lease);
        return { ...osResult, lease };
      }
    }

    // Upgrade first: if the user was already watching this agent as an OS-only
    // process, fold the transcript into *that* session rather than opening a
    // second one for the same agent. The proof is the process table.
    const upgraded = await upgradeIntoOsSession(file, row.externalId, deps);
    if (upgraded !== undefined) {
      const lease: WatchLease = {
        targetKey: key,
        sessionId: upgraded.id,
        // The session's primary channel stays "os"; the file is kept so a
        // restart resumes the transcript feed into the same session.
        channel: "os",
        externalId: upgraded.observe?.externalId ?? row.externalId,
        file,
        ...(upgraded.observe?.pid !== undefined ? { pid: upgraded.observe.pid } : {}),
        ...(upgraded.observe?.pidStartedAt !== undefined ? { pidStartedAt: upgraded.observe.pidStartedAt } : {}),
        ...(row.projectPath !== undefined ? { projectPath: row.projectPath } : {}),
        agentKind: row.agentKind,
        createdAt: now,
        lastSeenAt: now,
      };
      putLease(lease);
      upgraded.setMonitorLease(true);
      return { sessionId: upgraded.id, url: sessionUrl(upgraded.id), state: "watching", lease };
    }

    const attached = await deps.discovery.attach(file);
    if (attached?.sessionId === undefined) return undefined;
    const lease: WatchLease = {
      targetKey: key,
      sessionId: attached.sessionId,
      channel: "transcript",
      externalId: attached.externalId,
      file,
      ...(attached.projectPath !== undefined ? { projectPath: attached.projectPath } : {}),
      agentKind: attached.agentKind,
      createdAt: now,
      lastSeenAt: now,
    };
    putLease(lease);
    // The attach may have produced a session the idle sweep already retired (a
    // transcript whose last fact is old); the lease reopens it.
    await attachLease(lease, deps);
    return {
      sessionId: lease.sessionId,
      url: sessionUrl(lease.sessionId),
      state: attached.missing === true ? "missing" : "watching",
      lease,
    };
  }

  const proxyId = proxyIdOf(key);
  if (proxyId !== undefined) {
    const info = proxySessions.get(proxyId);
    if (info?.sessionId === undefined) return undefined;
    const now = Date.now();
    const lease: WatchLease = {
      targetKey: key,
      sessionId: info.sessionId,
      channel: "acp-proxy",
      externalId: info.sessionId,
      ...(info.pid !== undefined ? { pid: info.pid } : {}),
      projectPath: info.cwd,
      agentKind: info.label,
      createdAt: now,
      lastSeenAt: now,
    };
    putLease(lease);
    await attachLease(lease, deps);
    return {
      sessionId: lease.sessionId,
      url: sessionUrl(lease.sessionId),
      state: info.status === "running" ? "watching" : "exited",
      lease,
    };
  }

  // A process target (`proc:<pid>@<startedAt>`) is the OS-only channel; see
  // watchOs.ts. Kept out of this file so the transcript and proxy paths do not
  // depend on the process table.
  return watchProcessTarget(key, deps);
}

/**
 * Fold a transcript into an existing OS-only session, when they are the same
 * agent.
 *
 * The user may have started by watching a bare `pi` process (`proc:` target),
 * then the transcript it writes shows up. Refusing to merge would show the
 * same agent twice. The proof is the process table: the transcript is named on
 * the command line (`--session <file>`), and that pid is the one the OS session
 * is bound to. On that proof the transcript's facts are delivered into the OS
 * session (backfill + live) and the session records both channels.
 */
async function upgradeIntoOsSession(
  file: string,
  transcriptExternalId: string,
  deps: WatchDeps,
): Promise<import("../sessions/SessionStore").AbsenceSession | undefined> {
  const osSessions = sessionStore
    .list()
    .filter((session) => session.observe?.channel === "os" && session.observe.pid !== undefined);
  if (osSessions.length === 0) return undefined;
  const table = await processSnapshot().catch(() => undefined);
  if (table === undefined) return undefined;
  const info = findPiSession(table, file);
  if (info === undefined) return undefined;
  const match = osSessions.find((session) => session.observe?.pid === info.pid);
  if (match === undefined) return undefined;
  // The existing transcript-keyed session (if any) is a duplicate of this one.
  const duplicate = sessionStore
    .list()
    .find((session) => session.observe?.channel === "transcript" && session.observe.externalId === transcriptExternalId);
  if (duplicate !== undefined && duplicate.id !== match.id) {
    await sessionStore.remove(duplicate.id).catch(() => undefined);
  }
  if (await deps.discovery.attachInto(file, match)) match.addObservationChannel("transcript");
  return match;
}

/** Placeholder seam, replaced by watchOs.ts's implementation at import time. */
let watchProcessTarget: (
  key: string,
  deps: WatchDeps,
  hint?: ProcessWatchHint,
) => Promise<WatchResult | undefined> = async () => undefined;

/** The OS-only channel registers its resolver here (see watchOs.ts). */
export function registerProcessWatch(
  resolver: (key: string, deps: WatchDeps, hint?: ProcessWatchHint) => Promise<WatchResult | undefined>,
): void {
  watchProcessTarget = resolver;
}

/**
 * Stop monitoring a session. The archive stays readable and History can open
 * it; only the lease (the “keep watching” promise) is dropped.
 */
export function unwatchSession(sessionId: string): boolean {
  const removed = deleteLeasesForSession(sessionId) > 0;
  sessionStore.get(sessionId)?.setMonitorLease(false);
  return removed;
}

/** Stop monitoring a target key (the CLI's symmetric form). */
export function unwatchTarget(key: string): boolean {
  const lease = listLeases().find((row) => row.targetKey === key);
  const removed = deleteLease(key);
  if (lease) sessionStore.get(lease.sessionId)?.setMonitorLease(false);
  return removed;
}

/** True when a session is held by any lease. */
export function hasLeaseForSession(sessionId: string): boolean {
  return listLeases().some((row) => row.sessionId === sessionId);
}

/**
 * Re-attach every lease at boot, so a panel that was being watched before the
 * restart is still being watched — without waiting for the transcript to move.
 * A proxy lease is skipped: its agent belonged to the previous proxy process.
 */
export async function restoreLeases(deps: WatchDeps): Promise<void> {
  for (const lease of listLeases()) {
    if (lease.channel === "acp-proxy") continue;
    try {
      await attachLease(lease, deps);
    } catch (error) {
      console.error(`[absence] could not restore watch lease ${lease.targetKey}:`, error);
    }
  }
}

/** Re-export the channel type so callers can build a lease without importing core twice. */
export type { ObserveChannel };
