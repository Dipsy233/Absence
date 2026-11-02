#!/usr/bin/env node
/** A short-lived helper used by the mock agent's process-tree scenario. */
const sleepMs = Number(process.argv[2] ?? 30);
const label = process.argv[3] ?? "tick";
setTimeout(() => {
  process.stdout.write(`tick ${label} done\n`);
}, Math.max(0, sleepMs));
