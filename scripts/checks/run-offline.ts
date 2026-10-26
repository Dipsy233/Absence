/**
 * Runs every offline acceptance check (the ones CI runs) in one process.
 *   npm run check:offline
 *
 * Scripts are spawned, not imported: each check calls process.exit() at the
 * end, and a platform-specific script must never be pulled into an offline run.
 * The list lives here so a new check script is registered in exactly one place.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const tsx = process.platform === "win32" ? "tsx.cmd" : "tsx";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";
const runner = process.platform === "win32" ? [npx, "tsx"] : ["npx", "tsx"];

// Offline: no live server, no kernel observers, no elevated rights.
const OFFLINE = [
  "check-eggs.ts",
  "check-classify.ts",
  "check-report.ts",
  "check-chimes.ts",
  "check-settings.ts",
  "check-codex.ts",
  "check-codexshell.ts",
  "check-shellenv.ts",
  "check-execserver.ts",
  "check-fsdiff.ts",
  "check-storage.ts",
  "check-metrics.ts",
  "check-incremental.ts",
  "check-outside-attr.ts",
  "check-capabilities.ts",
  "check-mcp-events.ts",
  "check-observer.ts",
  "check-capability-commands.ts",
];

let failed = 0;
for (const script of OFFLINE) {
  console.log(`\n=== ${script} ===`);
  const r = spawnSync(runner[0]!, [...runner.slice(1), path.join(here, script)], {
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (r.status !== 0) failed++;
}

if (failed > 0) {
  console.error(`\n${failed} check script(s) failed.`);
  process.exit(1);
}
console.log("\nall offline checks passed.");
