/**
 * Runs every offline acceptance check, in one process.
 *   npm run check:offline
 *
 * The check list lives in groups.ts (one registration point) — this runner
 * walks every group's offline checks in group order. Scripts are spawned, not
 * imported: each check calls process.exit() at the end, and a platform-specific
 * script must never be pulled into this run.
 *
 * What may be registered as an offline check: something that needs nothing but
 * Node — no kernel observer binary, no docker, no elevated rights, no
 * pre-started server. A check that boots its own server on an ephemeral port
 * with an isolated state dir belongs here too; that is the normal shape of the
 * session and metrics checks, and it is where their value is. What must stay
 * out (and lives in a group's `platform` list instead): anything that reads a
 * real kernel process table through `agentwatch`, drives docker, or expects a
 * server somebody else started.
 *
 * Running one area at a time is what `npm run check:group -- affected` is for;
 * this command is the full sweep CI runs.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS } from "./groups";

const here = path.dirname(fileURLToPath(import.meta.url));

const runner = process.platform === "win32" ? ["npx.cmd", "tsx"] : ["npx", "tsx"];

let failed = 0;
let ran = 0;
for (const group of GROUPS) {
  for (const entry of group.checks) {
    ran++;
    console.log(`\n=== ${entry.script}  [${group.name}] ===`);
    const r = spawnSync(runner[0]!, [...runner.slice(1), path.join(here, entry.script)], {
      stdio: "inherit",
      shell: process.platform === "win32",
      timeout: entry.timeout,
    });
    if (r.status !== 0) {
      failed++;
      if (r.signal) console.error(`${entry.script} timed out or was killed (${r.signal}) after ${entry.timeout}ms`);
    }
  }
}

if (ran === 0) {
  // groups.ts with no offline checks would silently pass — the one failure
  // mode a sweep must not have.
  console.error("\n0 offline checks registered — groups.ts registers nothing?");
  process.exit(1);
}

if (failed > 0) {
  console.error(`\n${failed} check script(s) failed.`);
  process.exit(1);
}
console.log(`\nall ${ran} offline checks passed.`);
