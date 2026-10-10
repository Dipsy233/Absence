import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter } from "./PiAdapter";

/**
 * Adapter factory (read.md §7). Pi is the default; `mock` drives the same
 * AbsenceEvent stream without any credentials — and, like Pi, runs its shell
 * command for real so the process watcher has something to report.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  return kind === "pi" ? new PiAdapter(options) : new MockAdapter(options);
}
