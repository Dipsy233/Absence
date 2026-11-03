// Bundle the ABSENCE server for the packaged desktop app.
//
// The desktop shell runs the server *in-process*. In a checkout it just lets
// tsx load the TypeScript sources; a shipped app has no repo and no tsx, so we
// pre-compile the server (and @absence/core, which it imports as TypeScript) into
// one CommonJS file the Electron main process can `require` directly.
//
// Third-party packages stay external: the server's own dependencies (fastify,
// chokidar, …) are ordinary node_modules that are copied into the app
// as-is, and some of them load native or lazily-required pieces that bundling
// would break. Bundling only *our* code keeps the output small and avoids
// breaking anything with a dynamic loader.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
// This script is apps/desktop/scripts → the repo root is two levels up.
const repoRoot = path.resolve(here, "..", "..", "..");

// The root node_modules may hold a foreign-platform esbuild binary (a checkout
// shared between platforms). esbuild
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

const outfile = path.join(repoRoot, "dist", "desktop", "build", "server.cjs");
// `ToolRules.load` resolves `./toolRules.json` beside `import.meta.url`, which
// the banner above points at server.cjs. A shipped app has no apps/server/src,
// so the data table must be copied next to the bundle; otherwise it silently
// falls back to the in-code FALLBACK table.
const toolRulesSource = path.join(repoRoot, "apps", "server", "src", "agents", "acp", "toolRules.json");
const toolRulesDest = path.join(repoRoot, "dist", "desktop", "build", "toolRules.json");

// Only ABSENCE's own source goes into the bundle (third-party packages stay
// external), so the bundle is up to date when no source file is newer than it.
// `stage` runs this script again after the .bat already ran it, and `pack`/
// `dist` run `stage` too - this check turns those repeat passes into no-ops.
const newerThan = (p, time) => {
  const st = fs.statSync(p);
  if (st.isFile()) return st.mtimeMs > time;
  for (const entry of fs.readdirSync(p)) {
    if (newerThan(path.join(p, entry), time)) return true;
  }
  return false;
};

const bundleUpToDate = () => {
  if (!fs.existsSync(outfile)) return false;
  const outTime = fs.statSync(outfile).mtimeMs;
  const roots = [
    path.join(repoRoot, "apps", "server", "src"),
    path.join(repoRoot, "packages", "core", "src"),
    // A change to this script changes the output, so it counts as a source.
    path.join(here, "bundle-server.mjs"),
  ];
  return !roots.some((root) => newerThan(root, outTime));
};

if (bundleUpToDate()) {
  console.log("[bundle-server] server.cjs is up to date - skipping esbuild");
} else {
  const { build } = await import("esbuild");

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
}

// Copy on every run (including the up-to-date path): it is tiny, and a bundle
// that predates the rules file would otherwise keep the old/missing table.
if (fs.existsSync(toolRulesSource)) {
  fs.mkdirSync(path.dirname(toolRulesDest), { recursive: true });
  fs.copyFileSync(toolRulesSource, toolRulesDest);
  console.log(`[bundle-server] staged ${path.relative(repoRoot, toolRulesDest)}`);
} else {
  console.warn("[bundle-server] warning: toolRules.json missing; packaged builds will use FALLBACK");
}
