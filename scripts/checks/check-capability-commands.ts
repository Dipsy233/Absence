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
import { findCommand, mergeAgentCommands } from "../../apps/web/src/lib/commands";
import { check, finish, section } from "./harness";

type Prompt = string;

/** A bare session instance: only the fields the command handlers touch. */
function makeSession(options: { authMethods?: Array<{ id: string; name: string }> } = {}) {
  const prompts: Prompt[] = [];
  const authenticated: string[] = [];
  const notices: string[] = [];
  const session = Object.create(AbsenceSession.prototype) as any;
  session.id = "sess_cmd";
  session.session = { projectPath: "." };
  session.handleEvent = (event: any) => {
    if (event.type === "message" && event.payload.role === "system") notices.push(event.payload.content);
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
  return { session, prompts, authenticated, notices };
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
