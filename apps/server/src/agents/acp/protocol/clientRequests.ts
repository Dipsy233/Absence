/**
 * Agent→client request routing.
 *
 * ACP lets the agent call back into the client for permission prompts, file
 * access and terminals. Absence declares none of the fs/terminal capabilities,
 * so the correct answer to those callbacks is a JSON-RPC "method not found"
 * naming the missing capability — never silence, and never a made-up result.
 */

import type { AcpClientCapabilities } from "./types";

export type ClientRequestKind =
  | "permission"
  | "fs-read"
  | "fs-write"
  | "terminal"
  | "unknown";

export interface ClientRequestRoute {
  readonly kind: ClientRequestKind;
  readonly supported: boolean;
  /** Human-readable reason when unsupported; sent as the JSON-RPC message. */
  readonly reason?: string;
}

export function classifyClientRequest(
  method: string,
  capabilities: AcpClientCapabilities = {},
): ClientRequestRoute {
  switch (method) {
    case "session/request_permission":
      return { kind: "permission", supported: true };

    case "fs/read_text_file":
      return capabilities.fs?.readTextFile === true
        ? { kind: "fs-read", supported: true }
        : {
            kind: "fs-read",
            supported: false,
            reason: `ACP request "${method}" requires the fs.readTextFile client capability, which Absence did not declare.`,
          };

    case "fs/write_text_file":
      return capabilities.fs?.writeTextFile === true
        ? { kind: "fs-write", supported: true }
        : {
            kind: "fs-write",
            supported: false,
            reason: `ACP request "${method}" requires the fs.writeTextFile client capability, which Absence did not declare.`,
          };

    case "terminal/create":
    case "terminal/output":
    case "terminal/wait_for_exit":
    case "terminal/kill":
    case "terminal/release":
      return capabilities.terminal === true
        ? { kind: "terminal", supported: true }
        : {
            kind: "terminal",
            supported: false,
            reason: `ACP request "${method}" requires the terminal client capability, which Absence did not declare.`,
          };

    default:
      return {
        kind: "unknown",
        supported: false,
        reason: `ACP client request "${method}" is not implemented by Absence.`,
      };
  }
}
