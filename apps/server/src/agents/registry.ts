import type { AdapterOptions, AgentAdapter } from "./AgentAdapter";

/**
 * The runtime registry — how a plugin becomes an adapter.
 *
 * Absence's built-in runtimes are registered through exactly the same door a
 * third party would use. There is no privileged list: the registry is seeded in
 * `agents/index.ts` with the shipped adapters, and `registerAdapter` lets an
 * embedding host (or a future plugin loader) add more without touching this
 * file or `createAdapter`.
 *
 * The point is not extensibility for its own sake. It is that the coupling to a
 * specific agent's internals becomes *opt-in and replaceable*: when Pi ships a
 * breaking change, one entry in the registry is wrong, not the application.
 * See docs/decoupling.md.
 */
export type AdapterFactory = (options: AdapterOptions) => AgentAdapter;

const factories = new Map<string, AdapterFactory>();

/** Make `kind` available to `createAdapter`. Re-registering replaces. */
export function registerAdapter(kind: string, factory: AdapterFactory): void {
  factories.set(kind, factory);
}

/** The kinds that currently have an adapter. */
export function registeredRuntimes(): string[] {
  return [...factories.keys()];
}

export function hasAdapter(kind: string): boolean {
  return factories.has(kind);
}

/**
 * Build an adapter, or undefined when nothing is registered for `kind`.
 *
 * Undefined is a real answer, not an error: it is what lets the session layer
 * say "this agent cannot be driven, observe it instead" rather than throwing.
 */
export function buildAdapter(kind: string, options: AdapterOptions): AgentAdapter | undefined {
  const factory = factories.get(kind);
  return factory ? factory(options) : undefined;
}
