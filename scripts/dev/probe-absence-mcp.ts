/**
 * Manual probe through Absence's own adapter:
 *
 *   npx tsx scripts/dev/probe-absence-mcp.ts <projectDir>
 *
 * Creates a real PiAdapter exactly as SessionStore does, starts it, and prints
 * what the session reports: active tools, registered tools, and the capability
 * state the Settings pane reads. This is the end-to-end check for "Absence
 * cannot connect to MCP" — the isolated Pi probe (probe-mcp.ts) shows whether
 * Pi can do it at all.
 */
import path from "node:path";
import { PiAdapter } from "../../apps/server/src/agents/PiAdapter";
import { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";
import { config } from "../../apps/server/src/config";

const cwd = path.resolve(process.argv[2] ?? process.cwd());
console.log("cwd    :", cwd);
console.log("piBin  :", config.piBin ?? "(resolved by PiBin)");
console.log("piTools:", (config.piTools?.join(",") ?? "(unset — Pi defaultTools)"));
console.log("mcp    :", config.mcpEnabled);

const watcher = new ProcessWatcher({ onProcess: () => {} });
const adapter = new PiAdapter({ tools: config.piTools, processWatcher: watcher });

adapter.subscribe((event) => {
  if (event.type === "error") console.log("  [event error]", event.payload.message);
});

try {
  const result = await adapter.start({ sessionId: "probe", cwd });
  console.log("\nstarted, model:", result.model);

  for (let i = 0; i <= 20; i++) {
    const state = adapter.getCapabilities?.();
    const server = state?.mcp.find((entry) => entry.name === "filesystem");
    console.log(
      `  [+${i}s] mcp servers=${state?.mcp.length ?? 0}` +
        ` | filesystem connected=${server?.connected} tools=${server?.toolCount} declared=${server?.declared}` +
        ` | skills=${state?.skills.length ?? 0}`,
    );
    if (server?.toolCount && server.toolCount > 0) break;
    await new Promise((r) => setTimeout(r, 1000));
  }

  const state = adapter.getCapabilities?.();
  console.log("\ndiagnostics:", state?.diagnostics);
} catch (error) {
  console.error("\nstart failed:", error instanceof Error ? error.message : error);
} finally {
  adapter.dispose();
  watcher.stop();
  process.exit(0);
}
