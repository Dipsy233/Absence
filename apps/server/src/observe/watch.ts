import type { ObserveChannel, ObserveWatchResponse, ObserveWatchState } from "@absence/core";
import type { DiscoveryService } from "./Discovery";
import { deleteLease, deleteLeasesForSession, listLeases, putLease, touchLease, type WatchLease } from "./leases";
import { proxySessions } from "../agents/acp/proxy";
import { findPiSession } from "../process/ProcessScanner";
import { processSnapshot } from "./processSource";
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
 * Attach a lease's session, whatever it takes.
 *
 * Three ways in, strongest first: the tail already knows the file (a live
 * observation), the archive already has the conversation (re-attach by
 * identity), or the session is a proxy's own. Called both when a watch is
 * created and when the leases are restored at boot — the same code, so the two
 * paths cannot drift.
 */
async function attachLease(lease: WatchLease, deps: WatchDeps): Promise<void> {
  if (lease.channel === "acp-proxy") {
    sessionStore.get(lease.sessionId)?.setMonitorLease(true);
    return;
  }
  if (lease.file !== undefined) {
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
    ...(lease.channel === "os" ? { channels: ["os"] as ObserveChannel[], watchProject: false } : {}),
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
let watchProcessTarget: (key: string, deps: WatchDeps) => Promise<WatchResult | undefined> = async () => undefined;

/** The OS-only channel registers its resolver here (see watchOs.ts). */
export function registerProcessWatch(
  resolver: (key: string, deps: WatchDeps) => Promise<WatchResult | undefined>,
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
