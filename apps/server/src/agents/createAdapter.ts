import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter } from "./PiAdapter";
import { CodexAdapter } from "./CodexAdapter";
import { DshAdapter } from "./DshAdapter";
import { buildAdapter, registerAdapter } from "./registry";

/**
 * The shipped runtimes, registered like any other plugin (see registry.ts).
 *
 * Pi is the default; `codex` drives the Codex CLI via its SDK; `dsh` drives
 * DeepSeek Harness (DSH) through its ACP server; `mock` drives the same
 * AbsenceEvent stream without any credentials — and, like Pi, runs its shell
 * command for real so the process watcher has something to report.
 *
 * Importing this module is what makes those four drivable. Nothing else in the
 * server depends on it, so an embedding host that only wants observation can
 * skip it entirely and still start, watch and render sessions.
 */
registerAdapter("pi", (options: AdapterOptions) => new PiAdapter(options));
registerAdapter("codex", (options: AdapterOptions) => new CodexAdapter(options));
registerAdapter("dsh", (options: AdapterOptions) => new DshAdapter(options));
registerAdapter("mock", (options: AdapterOptions) => new MockAdapter(options));

/**
 * Build the adapter for a runtime kind.
 *
 * Throws only when nothing is registered — the caller (AbsenceSession) turns
 * that into a clear "cannot drive this runtime" error rather than a crash.
 */
export function createAdapter(kind: AgentKind, options: AdapterOptions): AgentAdapter {
  const adapter = buildAdapter(kind, options);
  if (!adapter) {
    throw new Error(
      `No adapter is registered for runtime "${kind}". It can still be observed — see docs/decoupling.md.`,
    );
  }
  return adapter;
}
