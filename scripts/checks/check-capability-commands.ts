/**
 * Offline check of the `/skill` and `/mcp` chat commands.
 *
 *   npx tsx scripts/checks/check-capability-commands.ts
 *
 * These are the terminal-box replacements for the old Settings pane: Pi and
 * Codex both put skills and MCP behind a slash command, so Absence does too.
 * The surface is session-scoped on purpose, matching Pi's own `/mcp` (which
 * only offers login / logout / reconnect): adding, removing or toggling a
 * server edits the shared mcp.json, and every runtime keeps that outside the
 * session. The check covers the command registry, skill invocation routing,
 * `/mcp` list/reconnect wording against a fabricated capability list, and the
 * `pi mcp add` guidance in the empty-state. No server is ever dialled.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CapabilityState } from "@absence/core";
import { COMMANDS, findCommand, isSkillInvocation } from "../../apps/web/src/lib/commands";
import { check, finish, section } from "./harness";

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "absence-cmd-")));
const home = path.join(root, "home");
const project = path.join(root, "project");
fs.mkdirSync(project, { recursive: true });
const previousHome = process.env.HOME;
const previousProfile = process.env.USERPROFILE;
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.HOME = home;
process.env.USERPROFILE = home;
// Point Pi's agent dir inside the sandbox so writes never touch the real one.
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");

/** A throwaway project with one skill, so `/skill` has something to list. */
const skillDir = path.join(project, ".agents", "skills", "demo-skill");
fs.mkdirSync(skillDir, { recursive: true });
fs.writeFileSync(
  path.join(skillDir, "SKILL.md"),
  ["---", "name: demo-skill", "description: Demonstrates the skill command", "---", "", "body", ""].join("\n"),
  "utf8",
);

const {
  AbsenceSession,
} = await import("../../apps/server/src/sessions/SessionStore");

/** A bare session instance: only the fields the command handlers touch. */
function makeSession(capabilities?: CapabilityState) {
  const notices: string[] = [];
  const session = Object.create(AbsenceSession.prototype) as any;
  session.id = "sess_cmd";
  session.session = { projectPath: project };
  session.handleEvent = (event: any) => {
    if (event.type === "message" && event.payload.role === "system") notices.push(event.payload.content);
  };
  session.adapter = {
    getCapabilities: () => capabilities,
    isBusy: () => false,
    prompt: async (text: string) => {
      notices.push(`PROMPT:${text}`);
    },
  };
  return {
    session,
    async run(name: string, args = "") {
      notices.length = 0;
      await session.runCommand(name, args);
      return notices.join("\n");
    },
  };
}

function caps(mcp: CapabilityState["mcp"]): CapabilityState {
  return { skills: [], mcp, diagnostics: [] };
}

try {
  section("registry: both commands are in the input palace");
  check("/skill is registered", findCommand("skill") !== undefined);
  check("/mcp is registered", findCommand("mcp") !== undefined);
  check(
    "/mcp lists its subcommands",
    (findCommand("mcp")?.staticOptions ?? []).map((option) => option.value).join(",") ===
      "list,reconnect",
  );
  check("config edits are not offered in-session", (findCommand("mcp")?.staticOptions ?? []).every(
    (option) => !["add", "remove", "enable", "disable"].includes(option.value),
  ));
  check("/skill takes free text", findCommand("skill")?.kind === "text");

  section("/skill:<name> is a prompt, not a command");
  check("the invocation form is recognised", isSkillInvocation("/skill:demo-skill fix it"));
  check("a bare /skill is not an invocation", !isSkillInvocation("/skill demo-skill"));
  check("another command is not mistaken for one", !isSkillInvocation("/mcp list"));

  section("/skill lists, and /skill <name> invokes through the runtime");
  {
    const { run } = makeSession(undefined);
    const list = await run("skill");
    check("lists the discovered skill", list.includes("demo-skill"), list);
    check("shows the scope", list.includes("(project)"), list);
    check("shows how to load it", list.includes("/skill:demo-skill"), list);

    const invoked = await run("skill", "demo-skill please 检查一下");
    check(
      "a known name becomes a skill prompt",
      invoked.includes("PROMPT:/skill:demo-skill please 检查一下"),
      invoked,
    );
    check("and reports that it loaded", invoked.includes('Loaded skill "demo-skill"'), invoked);

    const filtered = await run("skill", "nope");
    check("an unknown name says so and lists what exists", filtered.includes("No skill matches"), filtered);
  }

  section("/mcp: the list reads state, tools and exposure");
  {
    const sample = caps([
      { name: "filesystem", type: "stdio", enabled: true, connected: true, toolCount: 14, exposure: "direct" },
      {
        name: "db",
        type: "stdio",
        enabled: true,
        connected: true,
        toolCount: 2,
        exposure: "codemode",
        declared: false,
      },
      { name: "off", type: "http", enabled: false },
      { name: "broken", type: "stdio", enabled: true, connected: false },
    ]);
    const { run } = makeSession(sample);
    const list = await run("mcp");
    check("connected server with tools", list.includes("filesystem: connected, 14 tools (direct)"), list);
    check(
      "an indirect server says how it is reached",
      list.includes("db: connected, 2 tools (codemode) — reachable via codemode/tool_search"),
      list,
    );
    check("a disabled server reads as disabled", list.includes("off: disabled"), list);
    check(
      "a server that is not connected says when it retries",
      list.includes("broken: not connected, reconnects on next call"),
      list,
    );
    const alias = await run("mcp", "list");
    check("/mcp list is the same as /mcp", alias === list);
  }

  section("/mcp: no servers configured");
  {
    const { run } = makeSession(caps([]));
    const empty = await run("mcp");
    check("says so", empty.includes("No MCP servers configured"), empty);
    check("and shows how to add one", empty.includes("pi mcp add <name> --"), empty);
  }

  section("/mcp: config changes are pointed at the runtimes' own tools");
  {
    const { run } = makeSession(caps([]));
    for (const attempt of ["add fs -- echo hi", "remove fs", "enable fs", "disable fs"]) {
      const answer = await run("mcp", attempt);
      check(
        `/mcp ${attempt.split(" ")[0]} refuses in-session`,
        answer.includes("Usage:") || answer.includes("mcp add"),
        answer.slice(0, 120),
      );
    }
    const empty = await run("mcp");
    check(
      "the empty state names pi mcp add / codex mcp add",
      empty.includes("pi mcp add") && empty.includes("codex mcp add"),
      empty,
    );
    check(
      "and says reconnect picks it up",
      empty.includes("/mcp reconnect"),
      empty,
    );
  }

  section("/mcp: reconnect and usage");
  {
    const sample = caps([
      { name: "fs", type: "stdio", enabled: true, connected: false },
      { name: "off", type: "stdio", enabled: false },
    ]);
    let reloads = 0;
    const { session, run } = makeSession(sample);
    (session.adapter as any).reloadExtensions = async () => {
      reloads += 1;
    };
    const reconnected = await run("mcp", "reconnect");
    check("reconnect picks an enabled server when unnamed", reloads === 1, String(reloads));
    check("and describes the state after", reconnected.includes('Reconnected "fs"'), reconnected);

    const unknown = await run("mcp", "reconnect ghost");
    check("an unknown server is named back", unknown.includes('No MCP server named "ghost"'), unknown);

    const usage = await run("mcp", "add");
    check("a missing argument shows the syntax", usage.startsWith("Usage:"), usage);

    const nonsense = await run("mcp", "frobnicate");
    check("an unknown action shows the syntax", nonsense.startsWith("Usage:"), nonsense);
  }
} finally {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousProfile;
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(root, { recursive: true, force: true });
}

finish("capability command checks");
