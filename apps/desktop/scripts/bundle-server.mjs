// Bundle the ABSENCE server for the packaged desktop app.
//
// The desktop shell runs the server *in-process*. In a checkout it just lets
// tsx load the TypeScript sources; a shipped app has no repo and no tsx, so we
// pre-compile the server (and @absence/core, which it imports as TypeScript) into
// one CommonJS file the Electron main process can `require` directly.
//
// Third-party packages stay external: `@earendil-works/pi-coding-agent` ships
// a .wasm asset and loads parts of itself dynamically, and the server's own
// dependencies (fastify, chokidar, …) are ordinary node_modules that are
// copied into the app as-is. Bundling only *our* code keeps the output small
// and avoids breaking anything with a dynamic loader.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// This script is apps/desktop/scripts → the repo root is two levels up.
const repoRoot = path.resolve(here, "..", "..", "..");

// The root node_modules may hold a foreign-platform esbuild binary (this repo
// is routinely used from WSL and Windows against the same checkout). esbuild
// reads ESBUILD_BINARY_PATH once, when its module loads, so this must run
// *before* the import below.
const platformPkg = { win32: "win32-x64", darwin: "darwin-x64", linux: "linux-x64" }[process.platform];
if (platformPkg) {
  const exe = process.platform === "win32" ? "esbuild.exe" : "bin/esbuild";
  for (const base of [
    path.join(repoRoot, "apps", "desktop", "node_modules"),
    path.join(repoRoot, "node_modules"),
  ]) {
    const candidate = path.join(base, "@esbuild", platformPkg, exe);
    if (fs.existsSync(candidate)) {
      process.env.ESBUILD_BINARY_PATH = candidate;
      break;
    }
  }
}

const { build } = await import("esbuild");

const outfile = path.join(repoRoot, "dist", "desktop", "build", "server.cjs");

await build({
  entryPoints: [path.join(repoRoot, "apps", "server", "src", "desktop-entry.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  sourcemap: false,
  logLevel: "info",
  // Everything that is not ABSENCE's own source: resolved at runtime from the
  // shipped node_modules / the package manager's hoisted tree. `@absence/core`
  // is our own TypeScript workspace package, so it is bundled, not external.
  packages: "external",
  alias: { "@absence/core": path.join(repoRoot, "packages", "core", "src", "index.ts") },
  // `import.meta.url` is used by config.ts and the native-helper path lookups;
  // a CJS bundle has no import.meta, so point it at the bundle file.
  define: {
    "import.meta.url": "__ABSENCE_BUNDLE_URL__",
  },
  banner: {
    js: [
      'const __ABSENCE_BUNDLE_URL__ = require("node:url").pathToFileURL(__filename).href;',
    ].join("\n"),
  },
});

console.log(`[bundle-server] wrote ${path.relative(repoRoot, outfile)}`);
