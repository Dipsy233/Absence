import { spawn, spawnSync } from "node:child_process";
import type { TranscriptSourceProfile } from "./transcriptSources";

/**
 * The auxiliary launcher: open the user's own terminal running the agent.
 *
 * This is the "只 spawn,不驱动" seam from the refactor plan (§2.8): Absence
 * starts a terminal application whose command line runs the agent — a fresh
 * `pi`, or `pi --session <file>` to continue a transcript — and then walks
 * away. It never speaks to the agent, never reads its credentials, never
 * wraps or shims anything: the conversation belongs to the user, and
 * observation still rides the transcript channel exactly as when the user
 * opened the terminal themselves. A launched resume is even attributed
 * precisely, because `--session <file>` is the same command-line evidence
 * ProcessScanner binds by.
 *
 * The launch spec lives on the transcript source profile (`launch`), so
 * supporting another agent later is profile data, not a new code path.
 */

/** Quote for the child shell's benefit. */
function shellQuote(value: string): string {
  return `"${value.replace(/"/g, "")}"`;
}

/** The command line the terminal runs: fresh, or continuing a transcript. */
export function agentLineOf(profile: TranscriptSourceProfile, resumeFile?: string): string {
  const launch = profile.launch;
  if (!launch) throw new Error(`source "${profile.id}" has no launch spec`);
  const args = resumeFile !== undefined ? (launch.resume?.(resumeFile) ?? []) : (launch.args ?? []);
  return [launch.command, ...args].join(" ");
}

/**
 * Spawn the platform terminal. Resolves when the terminal application took
 * the command line; rejects when none could be started. The child is detached
 * and its stdio ignored: its lifetime is the user's, not Absence's.
 */
export function launchTerminal(
  profile: TranscriptSourceProfile,
  cwd: string,
  resumeFile?: string,
): Promise<void> {
  const line = agentLineOf(profile, resumeFile);
  if (process.platform === "win32") {
    // `start` takes a title (its first quoted word) and /D sets the working
    // directory, so no `cd` chaining is needed; `cmd /k` keeps the window up
    // to show what the agent printed after it exits.
    return detached("cmd.exe", ["/c", `start "pi" /D "${cwd}" cmd /k ${line}`], {
      windowsVerbatimArguments: true,
    });
  }
  if (process.platform === "darwin") {
    return detached("osascript", [
      "-e",
      `tell application "Terminal" to do script "cd ${shellQuote(cwd)} && ${line}"`,
    ]);
  }
  // Linux: the `-e` convention covers the common terminals; the first one on
  // PATH wins (checked synchronously — this is a one-off user action).
  for (const terminal of ["x-terminal-emulator", "gnome-terminal", "konsole", "xfce4-terminal", "xterm"]) {
    const probe = spawnSync("which", [terminal], { timeout: 2000 });
    if (probe.status !== 0) continue;
    return detached(terminal, ["-e", `sh -c 'cd ${shellQuote(cwd)} && ${line}'`]);
  }
  return Promise.reject(new Error("no terminal application found on PATH"));
}

function detached(file: string, args: string[], options: { windowsVerbatimArguments?: boolean } = {}): Promise<void> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(file, args, {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
        ...(options.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    // A spawn error (the binary vanished between the probe and the spawn, a
    // race with the user closing everything) surfaces here; success is assumed
    // once the process is handed the line — the terminal owns the rest.
    child.once("error", (error) => reject(error));
    child.unref();
    resolve();
  });
}
