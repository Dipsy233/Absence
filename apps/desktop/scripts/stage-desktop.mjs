// Stage everything the packaged desktop app needs, under dist/desktop/build/.
//
// The app runs the server in-process, so "everything it needs" is:
//   dist/desktop/build/server.cjs        DAZE's compiled server + core (no runtime tsx)
//   dist/desktop/build/node_modules      only the server's *production* deps
//   dist/web                             the built UI (copied by electron-builder)
//   native/agentwatch*                   the process-observer helpers
//
// We install the production dependencies into the staging directory rather
// than filtering the repo's 360 MB root node_modules, which mixes platforms
// (this checkout is used from both WSL and Windows). A clean `npm install
// --omit=dev` gets exactly the server's runtime closure for the *host* the
// package is built on, which is the platform the package runs on.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// This script is apps/desktop/scripts → the repo root is three levels up.
const repoRoot = path.resolve(here, "..", "..", "..");
const buildDir = path.join(repoRoot, "dist", "desktop", "build");
const stageDir = path.join(buildDir, "stage");

// 1. Bundle DAZE's own server (also rewrites build/server.cjs).
console.log("[stage] bundling the server ...");
execFileSync(process.execPath, [path.join(here, "bundle-server.mjs")], { stdio: "inherit" });

// 2. Install the server's production dependencies into a scratch package, then
//    move them under build/node_modules for electron-builder to copy.
console.log("[stage] installing production dependencies ...");
fs.rmSync(stageDir, { recursive: true, force: true });
fs.mkdirSync(stageDir, { recursive: true });

const serverPkg = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "apps", "server", "package.json"), "utf8"),
);
// `@daze/core` is bundled into server.cjs, so it must not be resolved from
// node_modules at runtime. Everything else the server requires is external.
const deps = { ...serverPkg.dependencies };
delete deps["@daze/core"];

fs.writeFileSync(
  path.join(stageDir, "package.json"),
  JSON.stringify({ name: "daze-server-deps", private: true, dependencies: deps }, null, 2),
);

// npm is a shell script on POSIX and a batch file on Windows. Run it through
// the system shell explicitly on Windows rather than passing `shell: true`
// (which concatenates arguments without escaping).
const npmCmd =
  process.platform === "win32"
    ? { file: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", "npm", "install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"] }
    : { file: "npm", args: ["install", "--omit=dev", "--no-audit", "--no-fund", "--ignore-scripts"] };
execFileSync(npmCmd.file, npmCmd.args, { cwd: stageDir, stdio: "inherit" });

// 3. Move node_modules into place and drop the scratch files.
const target = path.join(buildDir, "node_modules");
fs.rmSync(target, { recursive: true, force: true });
fs.renameSync(path.join(stageDir, "node_modules"), target);
fs.rmSync(stageDir, { recursive: true, force: true });

// 4. Make sure the native helpers actually exist before electron-builder looks
//    for them, so a missing one is a clear message here rather than a confusing
//    builder error.
const helpers = [
  path.join(repoRoot, "native", "agentwatch", "agentwatch.exe"),
  path.join(repoRoot, "native", "agentwatch-linux", "agentwatch-linux"),
];
for (const helper of helpers) {
  if (!fs.existsSync(helper)) {
    console.warn(`[stage] warning: native helper missing: ${path.relative(repoRoot, helper)}`);
  }
}

const size = (dir) => {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) total += size(p);
    else total += fs.statSync(p).size;
  }
  return total;
};
console.log(`[stage] node_modules: ${(size(target) / 1024 / 1024).toFixed(1)} MB`);
console.log("[stage] done");
