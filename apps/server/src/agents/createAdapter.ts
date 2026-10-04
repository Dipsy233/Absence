import type { AgentAdapter } from "./AgentAdapter";
import type { AgentKind } from "../config";
import { MockAdapter } from "./MockAdapter";
import { PiAdapter, type PiAdapterOptions } from "./PiAdapter";

/**
 * Adapter factory (read.md §7). Pi is the default; `mock` drives the same
 * DazeEvent stream without any credentials.
 */
export function createAdapter(kind: AgentKind, options: PiAdapterOptions): AgentAdapter {
  return kind === "pi" ? new PiAdapter(options) : new MockAdapter();
}
