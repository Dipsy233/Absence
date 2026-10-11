import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter } from "./PiAdapter";
import { CodexAdapter } from "./CodexAdapter";

/**
 * Adapter factory (read.md §7). Pi is the default; `codex` drives the Codex CLI
 * via its SDK; `mock` drives the same AbsenceEvent stream without any
 * credentials — and, like Pi, runs its shell command for real so the process
 * watcher has something to report.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  switch (kind) {
    case "codex":
      return new CodexAdapter(options);
    case "mock":
      return new MockAdapter(options);
    default:
      return new PiAdapter(options);
  }
}
