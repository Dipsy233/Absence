/**
 * The runtime-neutral agent session contract.
 *
 * This is the only surface the session layer and the UI may depend on. ACP
 * agents and legacy adapters all land here; none of them leaks a product's
 * private protocol or tool vocabulary past this boundary.
 * See docs/architecture.md and the ACP+ architecture map.
 */
import type { AuthMethodInfo } from "./types";
import type { MonitorEvent } from "./monitor";

/** Re-exported here so this module is the one place the contract is read. */
export type AgentCommandInfo = import("./types").AgentCommandInfo;

/** ACP prompt content, reduced to blocks Absence can forward without judging. */
export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "resource_link"; uri: string; name?: string; mimeType?: string }
  | { type: "resource"; uri: string; mimeType?: string; text?: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string };

/** One ACP `StopReason`. Legacy adapters settle with `end_turn`. */
export type StopReason =
  | "end_turn"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "cancelled";

/**
 * The answer a UI gives to an agent's permission request.
 *
 * This is the *only* permission decision the contract accepts: a choice the
 * user made (`selected` + `optionId`), or a cancelled turn. There is no
 * "auto accept/decline" entry and no parsing of an agent's private decision
 * vocabulary. Absence forwards the UI's choice; the agent decides what it means.
 */
export type PermissionAnswer =
  | { outcome: "selected"; optionId: string }
  | { outcome: "cancelled" };

/** Everything an adapter needs to open a session. */
export interface AgentStartContext {
  sessionId: string;
  cwd: string;
  model?: string;
  /** Opaque handle from a previous `AgentSessionInfo.resumeHandle`. */
  resumeHandle?: string;
  /**
   * @deprecated Legacy name for `resumeHandle`, kept only while the temporary
   * legacy adapters compile. New code must use `resumeHandle`.
   */
  sessionFile?: string;
}

/** What an adapter reports once it is ready to accept prompts. */
export interface AgentSessionInfo {
  model: string;
  /** The agent's own session id, when it exposes one. */
  runtimeSessionId?: string;
  /** Opaque handle to reopen this conversation (`session/load` / `session/resume`). */
  resumeHandle?: string;
  /** True when the requested runtime was unavailable and Absence degraded. */
  degraded?: boolean;
}

export interface PromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export interface AuthCapabilities {
  logout: boolean;
}

export interface McpCapabilities {
  http: boolean;
  sse: boolean;
}

/** Where a session's behaviour comes from, at the contract level. */
export type AgentPortSource =
  | "acp-client"
  | "acp-proxy"
  | "legacy-adapter";

/**
 * Agent capabilities, normalised so the UI renders from data instead of
 * branching on a runtime name. Values omitted by the agent become `false`.
 */
export interface AgentCapabilitiesSnapshot {
  protocolVersion: number;
  loadSession: boolean;
  resumeSession: boolean;
  closeSession: boolean;
  prompt: PromptCapabilities;
  auth: AuthCapabilities;
  mcp: McpCapabilities;
  source: AgentPortSource;
}

/** One selectable value of a config option. */
export interface ConfigOptionChoice {
  value: string;
  name?: string;
  description?: string;
}

/** One group of selectable values (`options` may be nested in ACP). */
export interface ConfigOptionGroup {
  group: string;
  name?: string;
  options: ConfigOptionChoice[];
}

/** ACP config values are strings, except boolean options. */
export type ConfigOptionValue = string | boolean;

/** One session-level selector (model, mode, thought level, …). */
export interface ConfigOptionSnapshot {
  id: string;
  name: string;
  description?: string;
  /** `model` / `mode` / `thought_level`, or an agent-defined category. */
  category?: string;
  /** ACP's select/boolean, or an agent-defined type. */
  type?: "select" | "boolean" | (string & {});
  currentValue: ConfigOptionValue;
  options?: Array<ConfigOptionChoice | ConfigOptionGroup>;
}

export interface AuthSnapshot {
  /** True when the agent is blocked until `authenticate` succeeds. */
  required: boolean;
  methods: AuthMethodInfo[];
}

/**
 * The port a session drives — the complete "action surface" between the UI and
 * an agent.
 *
 * Every user action (prompt, stop, permission answer, config change, login) is
 * forwarded through this port and answered by the agent; Absence provides the
 * interface and the forwarding layer, never the decision. Implementations do
 * not implement an agent's `/` commands, shell, MCP/skill configuration or
 * approval policy, and do not parse a product's private protocol vocabulary.
 * A `session/request_permission` is surfaced to the UI and its answer is sent
 * back verbatim; there is no auto-accept/decline path in this contract. Any
 * automatic approval policy a host may offer is a UI preference outside the
 * contract, never an `AgentSessionPort` decision.
 *
 * A legacy adapter is reached through the temporary compatibility shim in
 * `apps/server/src/agents/AgentAdapter.ts`; P5 deletes that shim and every
 * legacy adapter behind it.
 */
export interface AgentSessionPort {
  readonly runtime: string;

  start(ctx: AgentStartContext): Promise<AgentSessionInfo>;

  /**
   * Forward a prompt as content blocks. `/` commands go through here too:
   * the agent owns their meaning, Absence never pre-parses them.
   * The returned stop reason is the agent's own response.
   */
  prompt(blocks: PromptBlock[]): Promise<StopReason>;

  /**
   * Ask the agent to stop the active turn. By protocol invariant, every
   * pending permission request belonging to that turn is answered
   * `cancelled` — a transport requirement, not a decision Absence makes.
   */
  cancel(): Promise<void>;

  /** Release the session; the agent owns its own process lifetime. */
  close(): Promise<void>;

  /**
   * Every agent request/notification, including permission prompts (carried
   * as `approval` events), reaches the UI through this stream. The UI answers
   * a permission through `respondPermission`, never by letting Absence decide.
   */
  subscribe(listener: (event: MonitorEvent) => void): () => void;

  /** Read-only capabilities from `initialize` / `session/new`. */
  capabilities(): AgentCapabilitiesSnapshot;

  /** Read-only selectors the agent itself exposes (model, mode, …). */
  configOptions(): ConfigOptionSnapshot[];
  /** Ask the agent to apply a value; the agent's response is authoritative. */
  setConfigOption(id: string, value: ConfigOptionValue): Promise<void>;

  /** Read-only `/` commands the agent advertised, not Absence's own commands. */
  commands(): AgentCommandInfo[];

  /** Read-only authentication state advertised by the agent. */
  auth(): AuthSnapshot;
  authenticate(methodId: string): Promise<void>;

  /**
   * Surface a permission request to the UI and forward the user's answer
   * verbatim as the ACP `session/request_permission` outcome. No automatic
   * decision, no interpretation of the agent's option kinds beyond echoing
   * the option id the user selected.
   */
  respondPermission(requestId: string, answer: PermissionAnswer): Promise<void>;
}
