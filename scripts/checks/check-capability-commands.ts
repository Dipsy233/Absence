/**
 * Offline check of the `/` command surface: Absence forwards, the agent decides.
 *
 *   npx tsx scripts/checks/check-capability-commands.ts
 *
 * Pins the decoupling contract:
 *   - `/model`, `/skill`, `/skill:<name>` and `/mcp` reach the agent verbatim
 *     as prompt text — Absence no longer parses or implements them;
 *   - `/auth` remains the one ACP port action Absence performs;
 *   - the web palette hard-codes only `/auth` and otherwise lists exactly the
 *     commands the agent advertised.
 */
import { agentCommands, findCommand, matchCommands, mergeAgentCommands } from "../../apps/web/src/lib/commands";
import { mergeCommandSources } from "../../apps/server/src/agents/commandSources";
import { check, finish, section } from "./harness";

type Prompt = string;

/** A bare session instance: only the fields the command handlers touch. */
function makeSession(options: { authMethods?: Array<{ id: string; name: string }> } = {}) {
  const prompts: Prompt[] = [];
  const authenticated: string[] = [];
  const notices: string[] = [];
  const errors: string[] = [];
  const session = Object.create(AbsenceSession.prototype) as any;
  session.id = "sess_cmd";
  session.session = { projectPath: "." };
  session.handleEvent = (event: any) => {
    if (event.type === "message" && event.payload.role === "system") notices.push(event.payload.content);
    if (event.type === "error") errors.push(event.payload.message);
  };
  session.flushMeta = async () => undefined;
  session.scheduleState = () => undefined;
  session.adapter = {
    getAvailableCommands: () => [],
    isBusy: () => false,
    prompt: async (text: string) => {
      prompts.push(text);
    },
    getAuthMethods: () => options.authMethods ?? [],
    authenticate: async (methodId: string) => {
      authenticated.push(methodId);
    },
  };
  return { session, prompts, authenticated, notices, errors };
}

const { AbsenceSession } = await import("../../apps/server/src/sessions/SessionStore");

section("palette: only the ACP action is local");
{
  check("no /skill spec is hard-coded", findCommand("skill") === undefined);
  check("no /mcp spec is hard-coded", findCommand("mcp") === undefined);
  check("no /model spec is hard-coded", findCommand("model") === undefined);
  check("the palette is exactly /auth when the agent advertises nothing", mergeAgentCommands(undefined).map((c) => c.name).join(",") === "auth");

  const merged = mergeAgentCommands([
    { name: "compact", description: "agent compact" },
    { name: "mcp", description: "agent mcp" },
    { name: "skill", description: "agent skill" },
  ]);
  check(
    "advertised commands are added as free-text prompts",
    ["compact", "mcp", "skill"].every((name) => {
      const spec = findCommand(name, merged);
      return spec !== undefined && spec.kind === "text";
    }),
  );
  check("an agent cannot shadow /auth", findCommand("auth", merged)?.kind === "choice");
}

section("palette: the agent catalog is not filtered by a local list");
{
  const advertised = Array.from({ length: 40 }, (_, index) => ({
    name: `agent-command-${index}`,
    description: `command ${index} from the agent`,
  }));
  const catalog = agentCommands(advertised);
  check(
    "every advertised command is in the catalog",
    catalog.length === advertised.length &&
      catalog.every((command, index) => command.name === advertised[index]!.name),
    `${catalog.length}/${advertised.length}`,
  );
  check(
    "the palette also carries every one of them",
    advertised.every((spec) => findCommand(spec.name, mergeAgentCommands(advertised)) !== undefined),
  );
  check(
    "name filtering only matches, never removes",
    matchCommands(catalog, "agent-command-37").length === 1 &&
      matchCommands(catalog, "agent-command-37")[0]?.name === "agent-command-37",
  );
  check(
    "an unknown command still reaches the agent",
    mergeAgentCommands([{ name: "never-heard-of" }]).some((command) => command.name === "never-heard-of"),
  );
}

section("command sources: adapter declarations merge generically");
{
  const agentA = mergeCommandSources([
    { id: "acp", commands: () => [{ name: "compact", description: "agent A compact" }] },
  ]);
  const agentB = mergeCommandSources([
    { id: "acp", commands: () => [{ name: "deploy", description: "agent B deploy" }] },
    { id: "runtime", commands: () => [{ name: "lint", description: "agent B runtime lint" }] },
  ]);
  check(
    "each agent keeps its own advertised set",
    findCommand("compact", mergeAgentCommands(agentA)) !== undefined &&
      findCommand("deploy", mergeAgentCommands(agentB)) !== undefined,
  );
  check(
    "supplemental sources are merged with the ACP source",
    findCommand("lint", mergeAgentCommands(agentB)) !== undefined,
  );
  const duplicate = mergeCommandSources([
    { id: "acp", commands: () => [{ name: "shared", description: "from acp" }] },
    { id: "runtime", commands: () => [{ name: "shared", description: "from runtime" }] },
  ]);
  check("the protocol source owns a duplicate name", duplicate[0]?.description === "from acp");
  const blank = mergeCommandSources([
    { id: "runtime", commands: () => [{ name: "  " }, { name: "kept" }] },
  ]);
  check("only empty names are skipped", blank.map((command) => command.name).join(",") === "kept");
}

section("unknown commands reach the agent and its rejection is preserved");
{
  const { session, prompts } = makeSession();
  await session.runCommand("unknown-agent-command", "--flag");
  check("a named unknown command is forwarded", prompts.at(-1) === "/unknown-agent-command --flag", prompts.at(-1));

  const failing = makeSession();
  failing.session.adapter.prompt = async () => {
    throw new Error("agent rejected /unknown-agent-command");
  };
  failing.session.prompt("/unknown-agent-command");
  await new Promise((resolve) => setTimeout(resolve, 0));
  check(
    "the agent's rejection is not swallowed",
    failing.errors.at(-1) === "agent rejected /unknown-agent-command",
    failing.errors.join(" | "),
  );
}

section("/model, /skill, /mcp and /skill:<name> are forwarded verbatim");
{
  const { session, prompts } = makeSession();
  await session.runCommand("model", "openai/gpt-5");
  check(" /model becomes a prompt", prompts.at(-1) === "/model openai/gpt-5", prompts.at(-1));

  await session.runCommand("skill", "demo please check");
  check(" /skill becomes a prompt", prompts.at(-1) === "/skill demo please check", prompts.at(-1));

  session.forwardCommand("/skill:demo-skill fix it");
  check(" /skill:<name> is a prompt", prompts.at(-1) === "/skill:demo-skill fix it", prompts.at(-1));

  await session.runCommand("mcp", "list");
  check(" /mcp becomes a prompt", prompts.at(-1) === "/mcp list", prompts.at(-1));

  session.forwardCommand("/unknown-agent-command --flag");
  check("an unknown slash line is not dropped", prompts.at(-1) === "/unknown-agent-command --flag", prompts.at(-1));
}

section("/auth stays an ACP action");
{
  const { session, prompts, authenticated, notices } = makeSession({
    authMethods: [{ id: "test-login", name: "Test" }],
  });
  await session.runCommand("auth", "test-login");
  check("/auth calls the port's authenticate", authenticated.join(",") === "test-login", authenticated.join(","));
  check("/auth is not also sent as a prompt", prompts.length === 0, prompts.join(" | "));

  const bare = makeSession({ authMethods: [{ id: "test-login", name: "Test" }] });
  await bare.session.runCommand("auth", "");
  check(
    "a bare /auth lists the advertised methods",
    bare.notices.at(-1)?.includes("test-login") === true,
    bare.notices.at(-1),
  );
}

finish("command forwarding checks");
