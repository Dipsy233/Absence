import os from "node:os";
import type { ObserveWatchResponse, ObserveWatchState } from "@absence/core";
import { putLease, type WatchLease } from "./leases";
import { registerProcessWatch, sessionUrl, type WatchDeps, type WatchResult } from "./watch";
import { parseProcessKey, sameProcess } from "./Targets";
import { pidIdentity, type ObserveMeta } from "./types";
import { processSnapshot } from "./processSource";
import { sessionStore } from "../sessions/SessionStore";

/**
 * The OS-only channel: watching a process Absence cannot read a transcript of.
 *
 * This is the “server has no desktop, so just monitor this agent process”
 * path. The user picks a running agent; Absence opens a session bound to the
 * pid *and its start time* (a recycled pid is a different process), then
 * follows its subtree by polling the process table — the agent is not a
 * descendant of the server, so the Job Object never sees it. Eggs, metrics and
 * the files the agent touches in its project all land through the normal
 * pipeline; there is simply no conversation content, because there is no
 * transcript to read.
 *
 * It can be upgraded: if a transcript later proves to belong to the same pid,
 * the same session gains the transcript channel (see `watch.ts`'s transcript
 * path and `Discovery.attachInto`) rather than becoming a second session.
 */

function programFiles(): string | undefined {
  return process.env.ProgramFiles;
}

/**
 * A best-effort project scope for an OS-only watch.
 *
 * The process table carries no cwd (Windows' table and `ps -eo args` alike),
 * so the project is only ever inferable from the command line, and guessing
 * wrong would point the file watcher at the whole disk. Absence therefore
 * records no project scope here: the session shows processes, metrics and the
 * files the agent itself reports — never a tree it invented. `watchProject:
 * false` is exactly that statement.
 */
function scopeForProcess(): { projectPath: string; watchProject: boolean } {
  // A neutral, narrow-enough path that carries no tree: the home directory is
  // the one path `isNarrowScope` already refuses to watch, so this degrades to
  // "facts only" without inventing a project.
  const fallback = programFiles() ?? os.homedir();
  return { projectPath: os.homedir() || fallback, watchProject: false };
}

async function watchProcess(key: string, deps: WatchDeps): Promise<WatchResult | undefined> {
  // `deps` is unused for the OS path (no discovery tail to consult) but kept so
  // the resolver has the same shape as the others.
  void deps;
  const parsed = parseProcessKey(key);
  if (parsed === undefined) return undefined;
  const table = await processSnapshot().catch(() => undefined);
  if (table === undefined) return undefined;
  const info = table.get(parsed.pid);
  if (!sameProcess(info, parsed.pid, parsed.startedAt) || info === undefined) return undefined;

  const { projectPath, watchProject } = scopeForProcess();
  const observe: ObserveMeta = {
    channel: "os",
    externalId: pidIdentity(info.pid, info.startedAt),
    pid: info.pid,
    pidStartedAt: info.startedAt,
    channels: ["os"],
    watchProject,
  };
  const session = await sessionStore.createObserved(projectPath, "pi", observe);
  session.setMonitorLease(true);
  // Attribution: the poll loop follows this pid's subtree and labels its
  // creations `os`/`exact`, exactly as a transcript session's bound pid does.
  session.declareRuntimePid(info.pid);

  const now = Date.now();
  const lease: WatchLease = {
    targetKey: key,
    sessionId: session.id,
    channel: "os",
    externalId: observe.externalId,
    pid: info.pid,
    pidStartedAt: info.startedAt,
    projectPath,
    agentKind: "pi",
    createdAt: now,
    lastSeenAt: now,
  };
  putLease(lease);

  const state: ObserveWatchState = "watching";
  const response: WatchResult = { sessionId: session.id, url: sessionUrl(session.id), state, lease };
  return response;
}

/** Register the OS resolver with the watch service on import. */
export function installOsWatch(): void {
  registerProcessWatch(watchProcess);
}

export type { ObserveWatchResponse };
