import { openDatabase } from "../sessions/storage/db";
import type { ObserveChannel } from "@absence/core";

/**
 * Monitor leases — “I chose this, keep watching it”.
 *
 * A lease is the user's explicit selection on the observation board (or from
 * `absence observe`). It is the difference between *discovered* and *watched*:
 *
 *   - discovered — a transcript the tail saw, a process the scanner matched.
 *     Cheap, no session, no watcher; the board lists it and nothing else.
 *   - leased     — a session the user asked to monitor. It survives the tab
 *     closing, the address bar changing, and a server restart (the lease table
 *     is what `restoreLeases()` re-attaches at boot), and the idle sweep keeps
 *     it far longer than a merely auto-attached transcript.
 *
 * Stopping a monitor deletes the row; the archive stays and History can open
 * it. Nothing here deletes facts.
 */
export interface WatchLease {
  /** Stable target key the board/CLI used (`transcript:<file>`, `proc:…`). */
  targetKey: string;
  sessionId: string;
  channel: ObserveChannel;
  externalId: string;
  file?: string;
  pid?: number;
  pidStartedAt?: number;
  projectPath?: string;
  agentKind?: string;
  createdAt: number;
  lastSeenAt: number;
}

type SqlRow = Record<string, unknown>;

function rowToLease(row: SqlRow): WatchLease | undefined {
  const targetKey = typeof row.target_key === "string" ? row.target_key : undefined;
  const sessionId = typeof row.session_id === "string" ? row.session_id : undefined;
  if (!targetKey || !sessionId) return undefined;
  return {
    targetKey,
    sessionId,
    channel: String(row.channel ?? "transcript") as ObserveChannel,
    externalId: String(row.external_id ?? ""),
    ...(typeof row.file === "string" && row.file.length > 0 ? { file: row.file } : {}),
    ...(typeof row.pid === "number" ? { pid: row.pid } : {}),
    ...(typeof row.pid_started_at === "number" ? { pidStartedAt: row.pid_started_at } : {}),
    ...(typeof row.project_path === "string" && row.project_path.length > 0
      ? { projectPath: row.project_path }
      : {}),
    ...(typeof row.agent_kind === "string" && row.agent_kind.length > 0 ? { agentKind: row.agent_kind } : {}),
    createdAt: Number(row.created_at ?? 0),
    lastSeenAt: Number(row.last_seen_at ?? 0),
  };
}

export function listLeases(): WatchLease[] {
  try {
    const rows = openDatabase().prepare("SELECT * FROM watch_leases ORDER BY created_at ASC").all() as SqlRow[];
    return rows.map(rowToLease).filter((lease): lease is WatchLease => lease !== undefined);
  } catch (error) {
    console.error("[absence] watch lease read failed:", error);
    return [];
  }
}

export function getLease(targetKey: string): WatchLease | undefined {
  try {
    const row = openDatabase()
      .prepare("SELECT * FROM watch_leases WHERE target_key = ?")
      .get(targetKey) as SqlRow | undefined;
    return row ? rowToLease(row) : undefined;
  } catch (error) {
    console.error("[absence] watch lease read failed:", error);
    return undefined;
  }
}

export function findLeaseBySession(sessionId: string): WatchLease | undefined {
  try {
    const row = openDatabase()
      .prepare("SELECT * FROM watch_leases WHERE session_id = ? ORDER BY created_at ASC LIMIT 1")
      .get(sessionId) as SqlRow | undefined;
    return row ? rowToLease(row) : undefined;
  } catch (error) {
    console.error("[absence] watch lease read failed:", error);
    return undefined;
  }
}

/** Create or refresh the lease for a target. Re-watching refreshes, never duplicates. */
export function putLease(lease: WatchLease): void {
  try {
    openDatabase()
      .prepare(
        `
        INSERT INTO watch_leases
          (target_key, session_id, channel, external_id, file, pid, pid_started_at,
           project_path, agent_kind, created_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(target_key) DO UPDATE SET
          session_id     = excluded.session_id,
          channel        = excluded.channel,
          external_id    = excluded.external_id,
          file           = excluded.file,
          pid            = excluded.pid,
          pid_started_at = excluded.pid_started_at,
          project_path   = excluded.project_path,
          agent_kind     = excluded.agent_kind,
          last_seen_at   = excluded.last_seen_at
      `,
      )
      .run(
        lease.targetKey,
        lease.sessionId,
        lease.channel,
        lease.externalId,
        lease.file ?? null,
        lease.pid ?? null,
        lease.pidStartedAt ?? null,
        lease.projectPath ?? null,
        lease.agentKind ?? null,
        lease.createdAt,
        lease.lastSeenAt,
      );
  } catch (error) {
    console.error("[absence] watch lease write failed:", error);
  }
}

/** Note that a lease is still being honoured (diagnostics and the idle sweep). */
export function touchLease(targetKey: string, at = Date.now()): void {
  try {
    openDatabase().prepare("UPDATE watch_leases SET last_seen_at = ? WHERE target_key = ?").run(at, targetKey);
  } catch (error) {
    console.error("[absence] watch lease touch failed:", error);
  }
}

/** Stop monitoring a target. The archive is untouched. */
export function deleteLease(targetKey: string): boolean {
  try {
    const result = openDatabase().prepare("DELETE FROM watch_leases WHERE target_key = ?").run(targetKey);
    return Number(result.changes) > 0;
  } catch (error) {
    console.error("[absence] watch lease delete failed:", error);
    return false;
  }
}

/** Stop monitoring by session id (the panel's “stop”, whichever key it was). */
export function deleteLeasesForSession(sessionId: string): number {
  try {
    const result = openDatabase().prepare("DELETE FROM watch_leases WHERE session_id = ?").run(sessionId);
    return Number(result.changes);
  } catch (error) {
    console.error("[absence] watch lease delete failed:", error);
    return 0;
  }
}
