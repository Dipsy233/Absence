/**
 * acp-probe — drive a scripted ACP agent and print what Absence captured.
 *
 *   npx tsx scripts/dev/acp-probe.ts scripts/acp-fixture/scenarios/claude-code.json
 *   npx tsx scripts/dev/acp-probe.ts qwen-code          # by name, from scenarios/
 *
 * This is the trigger tool for the capture pipeline: no model, no credentials.
 * It prints one line per AbsenceEvent, then a summary of the first-class events
 * (file_read / file_write / file_edit / command / search / mcp) and the
 * ProcessWatcher windows that were opened and closed.
 *
 * Any real ACP agent can be driven the same way by pointing `ABSENCE_ACP_BIN`
 * at it — the probe is about the protocol, not the fixture.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AbsenceEvent } from "@absence/core";
import { AcpAdapter } from "../../apps/server/src/agents/acp/AcpAdapter";
import { fixtureProfile } from "../../apps/server/src/agents/acp/profiles";
import type { ProcessWatcher } from "../../apps/server/src/process/ProcessWatcher";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const scenarioDir = path.join(repoRoot, "scripts", "acp-fixture", "scenarios");

const arg = process.argv[2] ?? "claude-code";
const scenarioPath = fs.existsSync(arg) ? path.resolve(arg) : path.join(scenarioDir, `${arg}.json`);
if (!fs.existsSync(scenarioPath)) {
  console.error(`no scenario: ${scenarioPath}`);
  process.exit(1);
}
const prompt = process.argv[3] ?? "please fix the return value";

const windows: string[] = [];
const watcher = {
  beginSession: () => {},
  begin: (command: string) => {
    windows.push(`begin  ${command}`);
    return windows.length;
  },
  end: (id: number) => {
    windows.push(`end    #${id}`);
  },
} as unknown as ProcessWatcher;

const scenario = JSON.parse(fs.readFileSync(scenarioPath, "utf8")) as { agent?: string };
const adapter = new AcpAdapter(fixtureProfile(scenarioPath, scenario.agent ?? "acp-fixture"), {
  processWatcher: watcher,
});

const events: AbsenceEvent[] = [];
adapter.subscribe((event) => {
  events.push(event);
  if (event.type === "approval") {
    const payload = event.payload as { id: string; title: string; options: Array<{ value: string; label: string }> };
    console.log(`\n  ? approval: ${payload.title} → ${payload.options.map((o) => o.label).join(" / ")} (auto: first)`);
    void adapter.respondApproval(payload.id, payload.options[0]?.value ?? "allow-once");
  }
});

await adapter.start({ sessionId: "acp-probe", cwd: repoRoot });
console.log(`model: ${(await adapter.listModels()).find((option) => option.active)?.value}`);
await adapter.prompt(prompt);

console.log(`\n${events.length} events:`);
for (const event of events) {
  const payload = event.payload as Record<string, unknown>;
  const hint =
    event.type === "command"
      ? ` ${payload.command} (exit ${payload.exitCode})`
      : event.type === "file_read" || event.type === "file_write" || event.type === "file_edit"
        ? ` ${payload.path}`
        : event.type === "search"
          ? ` ${payload.query} → ${payload.matches}`
          : event.type === "mcp"
            ? ` ${payload.server} › ${payload.tool}`
            : event.type === "message"
              ? ` ${String(payload.content ?? "").slice(0, 60)}`
              : "";
  console.log(`  ${event.type}${hint}`);
}

console.log(`\nwatcher windows:\n  ${windows.join("\n  ") || "(none)"}`);
console.log(`agent commands: ${adapter.getAvailableCommands().map((c) => `/${c.name}`).join(" ") || "(none)"}`);
const usage = adapter.getContextUsage();
console.log(`usage: ${usage ? `${usage.used}/${usage.total}` : "(none)"}`);

adapter.dispose();
process.exit(0);
