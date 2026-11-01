/**
 * Runs check groups — the whole suite is too slow to run on every change, so
 * the groups in groups.ts map source paths to the checks that exercise them.
 *   npm run check:group -- <group> [<group> …]   named groups
 *   npm run check:group -- affected              only groups owning changed files
 *   npm run check:group -- affected --base <ref> against a base ref instead of HEAD
 *   npm run check:group -- list                  what exists, and what each owns
 *   npm run check:group -- affected --all        …including platform checks
 *
 * "affected" diffs `git diff --name-only` (staged + unstaged + HEAD by default,
 * or against --base) and runs every group whose paths match. A change that
 * matches no group (a README, a screenshot) prints that typecheck/build cover
 * it and exits 0 — the check scripts are for logic, the typecheck is for
 * everything else. Checks spawn one process each, exactly like check:offline.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, allChecks, type CheckGroup, type CheckEntry } from "./groups";

const here = path.dirname(fileURLToPath(import.meta.url));
const runner = process.platform === "win32" ? ["npx.cmd", "tsx"] : ["npx", "tsx"];

/* ── args ──────────────────────────────────────────────────────────────── */

const args = process.argv.slice(2);
const withFlag = (flag: string) => {
  const i = args.indexOf(flag);
  if (i === -1) return undefined;
  args.splice(i, 1);
  return args.splice(i, 1)[0];
};
const includePlatform = args.includes("--all");
if (includePlatform) args.splice(args.indexOf("--all"), 1);
const base = withFlag("--base");
const commands = args.filter((a) => !a.startsWith("-"));

/* ── path matching ─────────────────────────────────────────────────────── */

/** Glob → RegExp: `**` spans path segments, `*` spans one. */
function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*");
  return new RegExp(`^${source}$`);
}

function groupMatches(group: CheckGroup, changed: Set<string>): string[] {
  const own = group.paths.map(globToRegExp);
  // A group's own check scripts belong to it implicitly: touching the script
  // runs the script.
  const scripts = new Set(
    [...group.checks, ...(group.platform ?? [])].map((c) => `scripts/checks/${c.script}`),
  );
  const hits = [...changed].filter(
    (file) => own.some((re) => re.test(file)) || scripts.has(file),
  );
  return hits;
}

function changedFiles(): Set<string> {
  const spec = base ? `${base}...HEAD` : "HEAD";
  const diff = spawnSync("git", ["diff", "--name-only", spec], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const untracked = spawnSync("git", ["ls-files", "--others", "--exclude-standard"], {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const files = [
    ...(diff.stdout ?? "").split(/\r?\n/),
    ...(untracked.stdout ?? "").split(/\r?\n/),
  ]
    .map((f) => f.trim().replace(/\\/g, "/"))
    .filter((f) => f.length > 0);
  return new Set(files);
}

/* ── selection ─────────────────────────────────────────────────────────── */

function pickGroups(): { group: CheckGroup; hits: string[] }[] {
  if (commands[0] === "affected") {
    const changed = changedFiles();
    if (changed.size === 0) {
      console.log("no changed files (committed tree, no diff vs HEAD) — nothing to run.");
      return [];
    }
    const picked = GROUPS.map((group) => ({ group, hits: groupMatches(group, changed) })).filter(
      ({ hits }) => hits.length > 0,
    );
    if (picked.length === 0) {
      console.log(
        `${changed.size} changed file(s) match no check group — typecheck and the web build cover them. Nothing to run.`,
      );
    }
    return picked;
  }
  const names = commands.length > 0 ? commands : ["list"];
  if (names[0] === "list") {
    list();
    process.exit(0);
  }
  const unknown = names.filter((n) => !GROUPS.some((g) => g.name === n));
  if (unknown.length > 0) {
    console.error(`unknown group(s): ${unknown.join(", ")}`);
    console.error(`known groups: ${GROUPS.map((g) => g.name).join(", ")}`);
    process.exit(1);
  }
  return GROUPS.filter((g) => names.includes(g.name)).map((group) => ({ group, hits: [] }));
}

function list(): void {
  console.log("check groups (scripts/checks/groups.ts is the single registry):\n");
  for (const group of GROUPS) {
    const offline = group.checks.map((c) => c.script.replace("check-", "").replace(".ts", ""));
    const platform = (group.platform ?? []).map((c) => c.script.replace("check-", "").replace(".ts", ""));
    console.log(`  ${group.name.padEnd(10)} ${group.label}`);
    console.log(`  ${" ".padEnd(10)} offline: ${offline.join(", ") || "—"}`);
    if (platform.length > 0) console.log(`  ${" ".padEnd(10)} platform (manual): ${platform.join(", ")}`);
    console.log("");
  }
  const all = allChecks();
  const manual = all.filter((c) => c.platform);
  console.log(
    `${all.length - manual.length} offline checks in ${GROUPS.length} groups; ${manual.length} platform checks stay manual: ` +
      manual.map((c) => c.script).join(", "),
  );
}

/* ── run ───────────────────────────────────────────────────────────────── */

const picked = pickGroups();

// One script can sit in several groups (overlap is deliberate); within one
// invocation it runs once.
const queue = new Map<string, CheckEntry & { groups: string[] }>();
for (const { group } of picked) {
  for (const entry of group.checks) {
    const existing = queue.get(entry.script);
    if (existing) existing.groups.push(group.name);
    else queue.set(entry.script, { ...entry, groups: [group.name] });
  }
  if (includePlatform) {
    for (const entry of group.platform ?? []) {
      const existing = queue.get(entry.script);
      if (existing) existing.groups.push(group.name);
      else queue.set(entry.script, { ...entry, groups: [group.name] });
    }
  }
}

let failed = 0;
for (const [script, entry] of queue) {
  console.log(`\n=== ${script}  [${entry.groups.join(", ")}] ===`);
  const r = spawnSync(runner[0]!, [...runner.slice(1), path.join(here, script)], {
    stdio: "inherit",
    shell: process.platform === "win32",
    timeout: entry.timeout,
  });
  if (r.status !== 0) {
    failed++;
    if (r.signal) console.error(`${script} timed out or was killed (${r.signal}) after ${entry.timeout}ms`);
  }
}

if (picked.length === 0 && queue.size === 0) {
  // "affected" with no matching group already explained itself; exit clean so
  // it can sit in a pre-commit hook.
  process.exit(0);
}

if (failed > 0) {
  console.error(`\n${failed} check script(s) failed.`);
  process.exit(1);
}
console.log(`\n${queue.size} check script(s) passed across ${picked.length} group(s).`);
