#!/usr/bin/env node
/**
 * Spawns a grandchild and a very short-lived helper, then stays alive long
 * enough for Absence's observer to see the whole subtree.
 *
 * The point of this shape is the Job Object: a `node` child that itself starts
 * `node` grandchildren is exactly the case a per-command process shim would
 * miss if it only watched direct children.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const node = process.execPath;
const args = process.argv.slice(2);
const valueOf = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
};

const totalMs = valueOf("ms", 2500);
const grandchildMs = valueOf("grandchild", 1600);
const briefMs = valueOf("brief", 25);

const grandchild = spawn(node, [path.join(here, "tick.mjs"), String(grandchildMs), "grandchild"], {
  stdio: "ignore",
  windowsHide: true,
});
const brief = spawn(node, [path.join(here, "tick.mjs"), String(briefMs), "brief-helper"], {
  stdio: "ignore",
  windowsHide: true,
});

process.stdout.write(`tree parent=${process.pid} grandchild=${grandchild.pid} brief=${brief.pid}\n`);

const stop = setTimeout(() => {
  for (const child of [grandchild, brief]) {
    try {
      child.kill();
    } catch {
      // already gone
    }
  }
  process.stdout.write("tree done\n");
  process.exit(0);
}, Math.max(0, totalMs));
stop.unref?.();
