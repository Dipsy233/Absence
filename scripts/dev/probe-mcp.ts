/**
 * Manual probe: does a Pi session created the way Absence creates it actually
 * connect the MCP servers from ~/.pi/agent/mcp.json?
 *
 *   npx tsx scripts/dev/probe-mcp.ts [projectDir]
 *
 * Prints the active/registered tool names before and after bindExtensions, so
 * a silent "no mcp__* tools" is visible instead of guessed at.
 */
import path from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";

const cwd = path.resolve(process.argv[2] ?? process.cwd());
const agentDir = getAgentDir();
console.log("cwd      :", cwd);
console.log("agentDir :", agentDir);

const loader = new DefaultResourceLoader({
  cwd,
  agentDir,
  extensionFactories: [
    createCodemodeExtension({ mode: "on" }),
    createToolSearchExtension(),
    createMcpExtension({ startupWaitMs: 15_000 }),
  ],
});
await loader.reload();
// Skills discovered by Absence are injected here too; the probe only needs the
// extensions, so no skillsOverride is passed.
console.log(
  "extensions loaded:",
  loader.getExtensions().extensions.map((e) => e.path),
);
console.log(
  "extension errors:",
  loader.getExtensions().errors.map((e) => `${e.path}: ${e.error}`),
);

const notes: string[] = [];
const { session } = await createAgentSession({
  cwd,
  sessionManager: SessionManager.inMemory(cwd),
  resourceLoader: loader,
});
session.subscribe((event) => {
  if (event.type === "error") notes.push(`error: ${String(event)}`);
  if (event.type === "agent_settled") notes.push("settled");
});

console.log("\nbefore bindExtensions:");
console.log("  active   :", session.getActiveToolNames().join(", "));
console.log("  all      :", session.getAllTools().map((t) => t.name).join(", ") || "(none)");

await session.bindExtensions({});
console.log("\nafter bindExtensions (servers connect on session_start, in the background):");

let last = "";
for (let i = 0; i < 30; i++) {
  const all = session.getAllTools().map((t) => t.name).sort();
  const mcp = all.filter((name) => name.startsWith("mcp__"));
  const line = `active=[${session.getActiveToolNames().sort().join(", ")}] mcp=${mcp.length}`;
  if (line !== last) {
    console.log(`  [+${i}s] ${line}`);
    last = line;
  }
  if (mcp.length > 0) {
    console.log("  mcp tools:", mcp.join(", "));
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}

console.log("\nfinal:");
console.log("  active   :", session.getActiveToolNames().join(", "));
console.log(
  "  mcp      :",
  session
    .getAllTools()
    .filter((t) => t.name.startsWith("mcp__"))
    .map((t) => `${t.name} (${t.exposure})`)
    .join(", ") || "(none)",
);
console.log("  notes    :", notes.join(" | ") || "(none)");
session.dispose();
