/**
 * ACP lifecycle / honesty checks that do not fit the parallel mock suite.
 *
 *   npx tsx scripts/checks/check-acp-lifecycle.ts
 *
 * Pins:
 *   - file_read rangeKnown when the agent omitted locations.line;
 *   - command exitCode from rawOutput, and exitCodeKnown when it did not;
 *   - snippet file_edit reconstruction from rawInput + disk;
 *   - agent `/` command forwarding policy, and the web palette merge;
 *   - ACP authenticate: deferred session, readable failures, resume after auth;
 *   - abort watchdog for an agent that ignores session/cancel;
 *   - registry sync parsing, temp cache write, and offline failure handling.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AbsenceEvent } from "@absence/core";
import { check, finish, section } from "./harness";

process.env.ABSENCE_ACP_ABORT_TIMEOUT_MS = "300";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureAgent = path.join(repoRoot, "scripts", "checks", "fixtures", "acp-test-agent.mjs");

function profileFor(mode: string, id = `test-${mode}`) {
  return {
    id,
    label: `Test ACP ${mode}`,
    source: "fixture" as const,
    launch: {
      command: process.execPath,
      args: [fixtureAgent],
      env: { ABSENCE_ACP_TEST_MODE: mode },
    },
  };
}

async function tempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "absence-acp-check-"));
}

async function main(): Promise<void> {
  // Load after the abort timeout env is set: the adapter reads it at import time.
  const { AcpAdapter } = await import("../../apps/server/src/agents/acp/AcpAdapter");
  const { AcpToolMapper } = await import("../../apps/server/src/agents/acp/AcpToolMapper");
  const { mergeAgentCommands, findCommand } = await import("../../apps/web/src/lib/commands");
  const { formatAgentCommand, shouldForwardAgentCommand } = await import(
    "../../apps/server/src/agents/slashCommands"
  );
  const { parseRegistryEntries, registryProfiles, syncRegistry } = await import(
    "../../apps/server/src/agents/acp/AgentCatalog"
  );

  section("rangeKnown: no locations.line is not a precise range");
  {
    const dir = await tempDir();
    await fs.writeFile(path.join(dir, "src.txt"), "alpha\nbeta\ngamma\n");
    const mapper = new AcpToolMapper(dir);
    const unknown = await mapper.mapCompleted({
      toolCallId: "r1",
      name: "Read",
      kind: "read",
      rawInput: { path: "src.txt" },
      content: [{ type: "content", content: { type: "text", text: "alpha" } }],
    });
    const read = unknown.find((event) => event.type === "file_read");
    check(
      "an omitted locations.line marks rangeKnown=false",
      read?.type === "file_read" && read.payload.rangeKnown === false,
      read ? JSON.stringify(read.payload) : "no file_read",
    );
    check(
      "the fallback range is 1..content lines",
      read?.type === "file_read" && read.payload.startLine === 1 && read.payload.endLine === 1,
    );

    const known = await mapper.mapCompleted({
      toolCallId: "r2",
      name: "Read",
      kind: "read",
      rawInput: { path: "src.txt" },
      locations: [{ path: "src.txt", line: 2 }],
      content: [{ type: "content", content: { type: "text", text: "beta" } }],
    });
    const knownRead = known.find((event) => event.type === "file_read");
    check(
      "a reported line keeps the range precise",
      knownRead?.type === "file_read" &&
        knownRead.payload.rangeKnown === undefined &&
        knownRead.payload.startLine === 2,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("exitCode: rawOutput wins; absence is marked unknown");
  {
    const dir = await tempDir();
    const mapper = new AcpToolMapper(dir);
    const withCode = await mapper.mapCompleted({
      toolCallId: "c1",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "node -e process.exit(3)" },
      rawOutput: { exitCode: 3 },
    });
    const command = withCode.find((event) => event.type === "command");
    check(
      "rawOutput.exitCode 3 is reported",
      command?.type === "command" &&
        command.payload.exitCode === 3 &&
        command.payload.exitCodeKnown === undefined,
      command?.type === "command" ? JSON.stringify(command.payload) : "no command",
    );

    const nested = await mapper.mapCompleted({
      toolCallId: "c2",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "node -e process.exit(7)" },
      rawOutput: { result: { exit_code: "7" } },
    });
    const nestedCommand = nested.find((event) => event.type === "command");
    check(
      "a nested string exit code is parsed",
      nestedCommand?.type === "command" && nestedCommand.payload.exitCode === 7,
    );

    const unknown = await mapper.mapCompleted({
      toolCallId: "c3",
      name: "Run",
      kind: "execute",
      status: "failed",
      rawInput: { command: "fails without a code" },
    });
    const unknownCommand = unknown.find((event) => event.type === "command");
    check(
      "no rawOutput → fallback 1 but exitCodeKnown=false",
      unknownCommand?.type === "command" &&
        unknownCommand.payload.exitCode === 1 &&
        unknownCommand.payload.exitCodeKnown === false,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("file_edit: a snippet diff becomes the whole file");
  {
    const dir = await tempDir();
    const file = path.join(dir, "main.ts");
    const disk = "export function main() {\n  return 0;\n}\n";
    await fs.writeFile(file, disk);
    const mapper = new AcpToolMapper(dir);
    const events = await mapper.mapCompleted({
      toolCallId: "e1",
      name: "Update main.ts",
      kind: "edit",
      rawInput: { path: "main.ts", old_string: "return 0;", new_string: "return 1;" },
      content: [{ type: "diff", path: "main.ts", oldText: "return 0;", newText: "return 1;" }],
    });
    const edit = events.find((event) => event.type === "file_edit");
    check(
      "before is reconstructed from the full file, not the snippet",
      edit?.type === "file_edit" && edit.payload.before === disk,
      edit?.type === "file_edit" ? JSON.stringify(edit.payload.before) : "no file_edit",
    );
    check(
      "after is the full edited file",
      edit?.type === "file_edit" && edit.payload.after.includes("return 1;") && edit.payload.after.includes("main()"),
    );
    check(
      "a reconstructed edit is not marked fullContent=false",
      edit?.type === "file_edit" && edit.payload.fullContent === undefined,
    );
    await fs.rm(dir, { recursive: true, force: true });
  }

  section("slash commands: agent commands forward, Absence commands do not");
  {
    const commands = [
      { name: "compact", description: "agent compact" },
      { name: "custom-fix", description: "agent custom" },
      { name: "mcp", description: "agent mcp" },
      { name: "model", description: "agent model" },
    ];
    check("an advertised compact forwards", shouldForwardAgentCommand("compact", commands));
    check("an advertised custom command forwards", shouldForwardAgentCommand("custom-fix", commands));
    check("an advertised /mcp forwards", shouldForwardAgentCommand("mcp", commands));
    check(" /model stays Absence-owned", !shouldForwardAgentCommand("model", commands));
    check("an unadvertised command is not sent blindly", !shouldForwardAgentCommand("nope", commands));
    check("Pi/Codex (no list) keep their local commands", !shouldForwardAgentCommand("compact", undefined));
    check("the forwarded line preserves arguments", formatAgentCommand("custom-fix", " --fast ") === "/custom-fix --fast");

    const merged = mergeAgentCommands(commands);
    const custom = findCommand("custom-fix", merged);
    check("the web palette contains the agent command", custom?.kind === "text", custom?.description);
    const model = findCommand("model", merged);
    check(
      "the palette keeps Absence's /model spec",
      model?.description === "Switch the model" && model.kind === "choice",
      model?.description,
    );
    check(
      "a Pi/Codex palette has no agent commands",
      mergeAgentCommands(undefined).length === mergeAgentCommands([]).length,
    );
  }

  section("authenticate: deferred session, readable failures, then usable");
  {
    const adapter = new AcpAdapter(profileFor("auth"));
    const events: AbsenceEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start({ sessionId: "auth-check", cwd: repoRoot });
    check("start survives auth_required", adapter.isAuthRequired(), JSON.stringify(adapter.getAuthMethods()));
    check("the advertised method is surfaced", adapter.getAuthMethods()[0]?.id === "test-login");
    check("no session id before auth", adapter.getSessionFile() === undefined);

    let blocked = "";
    try {
      await adapter.prompt("hello");
    } catch (error) {
      blocked = error instanceof Error ? error.message : String(error);
    }
    check("prompt explains the required /auth", /requires authentication/i.test(blocked) && /\/auth/i.test(blocked), blocked);

    let unknown = "";
    try {
      await adapter.authenticate("wrong-method");
    } catch (error) {
      unknown = error instanceof Error ? error.message : String(error);
    }
    check("an unknown method lists the available ids", /Unknown authentication method/.test(unknown) && /test-login/.test(unknown), unknown);

    await adapter.authenticate("test-login");
    check("auth clears authRequired", !adapter.isAuthRequired());
    check("auth created the deferred session", adapter.getSessionFile() === "test-session");
    await adapter.prompt("hello");
    check(
      "the authenticated session runs a turn",
      events.some((event) => event.type === "message" && event.payload.role === "assistant" && event.payload.content.includes("test agent")),
    );
    check("the turn ended normally", events.some((event) => event.type === "agent_end" && event.payload.reason === "completed"));
    adapter.dispose();
  }

  section("denied execute: never executed, no exit status");
  {
    const adapter = new AcpAdapter(profileFor("deny"));
    const events: AbsenceEvent[] = [];
    adapter.subscribe((event) => {
      events.push(event);
      if (event.type === "approval") {
        const payload = event.payload as { id: string; options: Array<{ value: string }> };
        const reject = payload.options.find((option) => option.value === "reject-once");
        void adapter.respondApproval(payload.id, reject?.value ?? "reject-once");
      }
    });
    await adapter.start({ sessionId: "deny-check", cwd: repoRoot });
    await adapter.prompt("deny this command");
    const command = events.find((event) => event.type === "command");
    check(
      "the denied attempt is a command event",
      command?.type === "command",
    );
    check(
      "it carries permissionDenied=true",
      command?.type === "command" && command.payload.permissionDenied === true,
      command?.type === "command" ? JSON.stringify(command.payload) : "no command",
    );
    check(
      "its exit code is marked unknown, not a real status",
      command?.type === "command" &&
        command.payload.exitCodeKnown === false &&
        command.payload.exitCode === 1,
    );
    check(
      "the denial text is retained as stderr",
      command?.type === "command" && command.payload.stderr.includes("Permission denied"),
    );
    check("the denied command laid no process", !events.some((event) => event.type === "process"));
    check("the failed tool is still reported", events.some((event) => event.type === "tool_end" && event.payload.isError === true));
    check("no error event is added", !events.some((event) => event.type === "error"));
    adapter.dispose();
  }

  section("abort watchdog: an agent that ignores cancel cannot hang the run");
  {
    const adapter = new AcpAdapter(profileFor("hang"));
    const events: AbsenceEvent[] = [];
    adapter.subscribe((event) => events.push(event));
    await adapter.start({ sessionId: "hang-check", cwd: repoRoot });
    const run = adapter.prompt("hang please");
    await new Promise((resolve) => setTimeout(resolve, 120));
    await adapter.abort();
    await run;
    check("the run settles as aborted", events.some((event) => event.type === "agent_end" && event.payload.reason === "aborted"));
    check("no error row is added on top of the abort", !events.some((event) => event.type === "error"));
    check("the adapter is not busy after the watchdog", !adapter.isBusy());
    check("the hung connection was closed", adapter.getSessionFile() === undefined);
    adapter.dispose();
  }

  section("registry: sync writes a usable cache, offline fails readably");
  {
    const body = {
      agents: [
        {
          id: "test-acp-agent",
          name: "Test ACP Agent",
          distribution: { npx: { package: "test-acp-package" } },
        },
      ],
    };
    const dir = await tempDir();
    const count = await syncRegistry({
      dir,
      url: "https://example.invalid/registry.json",
      fetcher: async () => new Response(JSON.stringify(body), { status: 200 }),
    });
    check("one registry entry is written", count === 1, String(count));
    const cachePath = path.join(dir, "registry.json");
    check("the cache file exists", (await fs.stat(cachePath)).isFile());
    check(
      "the cached entry becomes a launch profile",
      registryProfiles(cachePath)[0]?.launch.command === "npx" &&
        registryProfiles(cachePath)[0]?.launch.args?.[1] === "test-acp-package",
    );
    check(
      "the pure parser skips an entry with no distribution",
      parseRegistryEntries({ agents: [{ id: "no-launch", name: "No Launch" }] }).length === 0,
    );

    let offline = "";
    try {
      await syncRegistry({
        dir,
        fetcher: async () => {
          throw new Error("getaddrinfo ENOTFOUND");
        },
      });
    } catch (error) {
      offline = error instanceof Error ? error.message : String(error);
    }
    check("offline is explained, not swallowed", /unreachable/i.test(offline) && /registry/i.test(offline), offline);
    check("the previous cache is still intact after a failure", (await fs.stat(cachePath)).isFile());
    await fs.rm(dir, { recursive: true, force: true });
  }

  finish("acp-lifecycle");
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
