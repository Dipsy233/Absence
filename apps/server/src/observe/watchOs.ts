import os from "node:os";
import path from "node:path";
import type { ObserveWatchResponse, ObserveWatchState } from "@absence/core";
import { putLease, type WatchLease } from "./leases";
import { registerProcessWatch, sessionUrl, type WatchDeps, type ProcessWatchHint, type WatchResult } from "./watch";
import { parseProcessKey, sameProcess } from "./Targets";
import { isNarrowScope, pidIdentity, type ObserveMeta } from "./types";
import { processSnapshot } from "./processSource";
import { piSessionFile } from "../process/ProcessScanner";
import { sessionStore } from "../sessions/SessionStore";

/**
 * The OS channel: watching a running agent process the user already started.
 *
 * This is the pure third-party path. The user runs pi in their own terminal,
 * exactly as before; Absence is never its parent and never its proxy. The user
 * picks the running process on the board, and Absence opens a session bound to
 * the pid *and its start time* (a recycled pid is a different process). Its
 * subtree is then followed at the kernel level — a dedicated Job Object on
 * Windows, the machine-wide eBPF stream on Linux (see
 * `ProcessWatcher.attachTargetedObserver`) — so eggs, exits and metrics are
 * event-accurate rather than sampled. Where no kernel observer can attach, it
 * degrades to the honest table sweep.
 *
 * When the chosen pi names its transcript on the command line
 * (`--session <file>`), the session also gains that transcript's conversation
 * (content facts) and its project scope (a real file tree), folded into the
 * same session rather than split in two.
 */

function programFiles(): string | undefined {
  return process.env.ProgramFiles;
}

/**
 * A neutral, narrow-enough path that carries no tree: the home directory is the
 * one path `isNarrowScope` already refuses to watch, so this degrades to
 * "facts only" without inventing a project. Used only when the process names no
 * transcript to derive a real project from.
 */
function fallbackScope(): { projectPath: string; watchProject: boolean } {
  const fallback = programFiles() ?? os.homedir();
  return { projectPath: os.homedir() || fallback, watchProject: false };
}

async function watchProcess(
  key: string,
  deps: WatchDeps,
  hint?: ProcessWatchHint,
): Promise<WatchResult | undefined> {
  const parsed = parseProcessKey(key);
  if (parsed === undefined) return undefined;
  const table = await processSnapshot().catch(() => undefined);
  if (table === undefined) return undefined;
  const info = table.get(parsed.pid);
  if (!sameProcess(info, parsed.pid, parsed.startedAt) || info === undefined) return undefined;

  // The transcript is known either from the process's own command line
  // (`--session <file>`) or from the caller's binding evidence — a default
  // `pi` writes one too, and the board already proved which one. Either way it
  // gives us the real project (the transcript header's own `cwd`, not the
  // session-file directory) and its conversation. Without it, stay honest:
  // facts only, no invented tree.
  const transcriptFile = hint?.transcriptFile ?? piSessionFile(info);
  let projectPath: string;
  let watchProject: boolean;
  if (transcriptFile !== undefined) {
    const row = await deps.discovery.inspect(transcriptFile);
    const cwd = row?.projectPath ?? path.dirname(transcriptFile);
    projectPath = cwd;
    watchProject = isNarrowScope(cwd);
  } else if (info.cwd !== undefined && info.cwd.length > 0) {
    // The process names no transcript, but the OS does know where it is
    // running. That directory is the honest scope: a board row and a panel that
    // say “E:\0down\DrawForth” are recognisable, while the home-directory
    // fallback named no project at all.
    projectPath = info.cwd;
    watchProject = isNarrowScope(info.cwd);
  } else {
    ({ projectPath, watchProject } = fallbackScope());
  }

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
  // Attribution: the watcher follows this pid's subtree and labels its
  // creations `os`/`exact`, exactly as a transcript session's bound pid does.
  session.declareRuntimePid(info.pid);

  // Fold the conversation in, when the process told us which transcript it
  // writes. This is the same upgrade a transcript-keyed watch performs — one
  // session, both channels, never two.
  if (transcriptFile !== undefined) {
    if (await deps.discovery.attachInto(transcriptFile, session)) {
      session.addObservationChannel("transcript");
    }
  }

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
    ...(transcriptFile !== undefined ? { file: transcriptFile } : {}),
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
