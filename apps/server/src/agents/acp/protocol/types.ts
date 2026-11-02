/** Raw ACP shapes shared by the connection and the capability normalizer. */

export interface AcpClientInfo {
  name: string;
  version: string;
}

/** What this client can do for the agent; both fields default to "nothing". */
export interface AcpClientCapabilities {
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
}

export interface AcpAgentInfo {
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/**
 * `initialize` response. `sessionCapabilities` is tolerated at the top level
 * because some adapters place it there even though the spec nests it under
 * `agentCapabilities`.
 */
export interface AcpInitializeResult {
  protocolVersion?: number;
  agentCapabilities?: Record<string, unknown>;
  sessionCapabilities?: Record<string, unknown>;
  agentInfo?: AcpAgentInfo;
  authMethods?: unknown[];
}

/** One selectable config option, as ACP reports it (model, mode, thought level…). */
export interface AcpConfigOption {
  id: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: unknown;
  options?: Array<
    | { value: string; name?: string; description?: string }
    | { group: string; name?: string; options?: Array<{ value: string; name?: string; description?: string }> }
  >;
}

export interface AcpSessionResult {
  sessionId: string;
  configOptions?: AcpConfigOption[];
}
