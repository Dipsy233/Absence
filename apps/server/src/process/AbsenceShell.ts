import { randomUUID } from "node:crypto";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import type { ProcessWatcher } from "./ProcessWatcher";

export interface AbsenceShell {
  bash: BashOperations;
  powershell: BashOperations;
}

/**
 * Absence's shell: Pi still runs the command, but through this boundary (v0.3).
 *
 * We wrap Pi's own local operations instead of spawning the shell ourselves, so
 * everything that makes Pi's shell tools what they are — Git Bash resolution on
 * Windows, timeouts, abort, output streaming, detached-child tracking — stays
 * Pi's and cannot drift.
 *
 * What we add is the *window* (when a command ran — the evidence ProcessWatcher
 * works from) and a unique marker at the head of the command. Every process Pi
 * spawns for that command carries the marker in its command line, so the shell
 * and the launcher around it can be recognised exactly, instead of being guessed
 * from a name or a parent. A `#` comment produces no output and is valid in bash
 * and PowerShell alike.
 *
 * That marker is what lets ProcessWatcher tell "the shell Absence drove" from "a
 * shell the agent started itself (`bash daemon.sh`)" — two things that look
 * identical from the outside, and that no pid probe can separate: Git Bash
 * reports `$PPID` as 1, and Pi's setup shell is gone before the first sample.
 *
 * Pi is imported lazily: a `mock` session should never pay for loading it.
 */
export async function createAbsenceShell(watcher: ProcessWatcher): Promise<AbsenceShell> {
  const { createLocalBashOperations, createLocalPowerShellOperations } = await import(
    "@earendil-works/pi-coding-agent"
  );
  return {
    bash: watch(createLocalBashOperations(), watcher),
    powershell: watch(createLocalPowerShellOperations(), watcher),
  };
}

function watch(operations: BashOperations, watcher: ProcessWatcher): BashOperations {
  return {
    exec: async (command, cwd, exec) => {
      // The command text and its working directory are the strongest signal for
      // classifying what this command lays, so both go to the watcher up front.
      const id = watcher.begin(command, cwd);
      const marker = `absence-${randomUUID().slice(0, 8)}`;
      watcher.noteMarker(marker);
      try {
        return await operations.exec(`# ${marker}\n${command}`, cwd, exec);
      } finally {
        // Returns immediately: the evidence is gathered off to the side.
        watcher.end(id);
      }
    },
  };
}
