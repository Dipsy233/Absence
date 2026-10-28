/**
 * Runs every acceptance check that CI can run, in one process.
 *   npm run check:offline
 *
 * Scripts are spawned, not imported: each check calls process.exit() at the
 * end, and a platform-specific script must never be pulled into this run.
 * The list lives here so a new check script is registered in exactly one place.
 *
 * What may go in this list: a check that needs nothing but Node — no kernel
 * observer binary, no docker, no elevated rights, no pre-started server. A
 * check that boots its own server on an ephemeral port with an isolated state
 * dir belongs here too; that is the normal shape of the session and metrics
 * checks, and it is where their value is. What must stay out: anything that
 * reads a real kernel process table through `agentwatch`, drives docker, or
 * expects a server somebody else started.
 *
 * Each entry may set its own timeout; the session/metrics checks start a real
 * server and sleep through real sampling windows, so they are measured in tens
 * of seconds rather than milliseconds.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const runner = process.platform === "win32" ? ["npx.cmd", "tsx"] : ["npx", "tsx"];

/** [script, timeout ms] — a generous default, raised where a server is booted. */
const CHECKS: Array<[string, number]> = [
  // Pure: fake process tables and event arrays, nothing spawned.
  ["check-eggs.ts", 60_000],
  ["check-classify.ts", 60_000],
  ["check-report.ts", 60_000],
  ["check-markdown.ts", 60_000],
  ["check-chimes.ts", 60_000],
  ["check-settings.ts", 60_000],
  ["check-codex.ts", 60_000],
  ["check-codexshell.ts", 60_000],
  ["check-shellenv.ts", 60_000],
  ["check-fsdiff.ts", 60_000],
  ["check-outside-attr.ts", 60_000],
  ["check-capabilities.ts", 120_000],
  ["check-capability-commands.ts", 60_000],
  ["check-mcp-events.ts", 60_000],
  ["check-observer.ts", 120_000],

  // Isolated I/O: a throwaway state dir, never the user's archive.
  ["check-storage.ts", 120_000],
  ["check-metrics.ts", 120_000],
  ["check-metrics-persist.ts", 120_000],
  ["check-metrics-ranges.ts", 60_000],
  ["check-incremental.ts", 180_000],

  // A protocol over a loopback socket the check starts itself.
  ["check-execserver.ts", 120_000],

  // Each boots its own server on an ephemeral port and kills it again.
  // These read process eggs through the snapshot fallback when no kernel
  // observer is present, which is the case on a CI runner.
  ["check-lifecycle.ts", 120_000],
  ["check-history.ts", 300_000],
  ["check-session-dwell.ts", 180_000],
  ["check-session-close.ts", 180_000],
  ["check-metrics-restart.ts", 180_000],
  ["check-observed-lifetime.ts", 180_000],
];

let failed = 0;
for (const [script, timeout] of CHECKS) {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(runner[0]!, [...runner.slice(1), path.join(here, script)], {
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout,
  });
  if (r.status !== 0) {
    failed++;
    if (r.signal) console.error(`${script} timed out or was killed (${r.signal}) after ${timeout}ms`);
  }
}

if (failed > 0) {
  console.error(`\n${failed} check script(s) failed.`);
  process.exit(1);
}
console.log("\nall offline checks passed.");
