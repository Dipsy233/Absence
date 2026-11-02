/**
 * The transparent ACP proxy.
 *
 * Its whole job is to join two `AcpTransport`s with a raw line channel and do
 * nothing else:
 *
 *   client ──raw line──► proxy ──raw line──► agent
 *   client ◄─raw line── proxy ◄─raw line── agent
 *
 * No request is answered, no id is allocated, no notification is synthesised
 * and no message is parsed for forwarding. On each side the parsed view is
 * offered to a read-only tap; a parse failure only produces a diagnostic, and
 * the line has already been forwarded by the raw listener.
 *
 * Lifecycle: either endpoint ending closes the other, `close()` is idempotent,
 * and the exit code of the agent is preserved rather than swallowed.
 */

import type { Unsubscribe } from "../protocol/transport";
import type { AcpProxyTransport } from "./transport";
import type { AcpProxyTap } from "./tap";

export type AcpProxySide = "client" | "agent" | "closed";

export interface AcpProxyExit {
  side: AcpProxySide;
  code: number | null;
  reason: string;
}

export interface AcpProxyOptions {
  client: AcpProxyTransport;
  agent: AcpProxyTransport;
  tap?: AcpProxyTap;
  /** Agent stderr is diagnostics, never protocol; defaults to this stderr. */
  onAgentStderr?: (chunk: string) => void;
  onDiagnostic?: (message: string, detail?: unknown) => void;
}

export class AcpProxy {
  private readonly client: AcpProxyTransport;
  private readonly agent: AcpProxyTransport;
  private readonly tap?: AcpProxyTap;
  private readonly disposers: Unsubscribe[] = [];
  private closed = false;
  private exit?: AcpProxyExit;
  private exitResolvers: Array<(exit: AcpProxyExit) => void> = [];

  constructor(private readonly options: AcpProxyOptions) {
    this.client = options.client;
    this.agent = options.agent;
    this.tap = options.tap;
    this.bind();
  }

  get pid(): number | undefined {
    return this.agent.pid;
  }

  isAlive(): boolean {
    return !this.closed && this.client.isAlive() && this.agent.isAlive();
  }

  waitForExit(): Promise<AcpProxyExit> {
    if (this.exit) return Promise.resolve(this.exit);
    return new Promise((resolve) => this.exitResolvers.push(resolve));
  }

  /**
   * Close both sides. Idempotent; the first reason wins. Safe to call from a
   * stream error handler — nothing here throws.
   */
  close(reason = "proxy closed", side: AcpProxySide = "closed", code: number | null = null): void {
    if (this.closed) return;
    this.closed = true;

    for (const dispose of this.disposers.splice(0)) {
      try {
        dispose();
      } catch {
        // unsubscribing is best-effort
      }
    }

    try {
      this.client.close();
    } catch {
      // already gone
    }
    try {
      this.agent.close();
    } catch {
      // already gone
    }
    try {
      this.tap?.close(reason);
    } catch {
      // observation must not fail the teardown
    }

    this.exit = { side, code, reason };
    const resolvers = this.exitResolvers.splice(0);
    for (const resolve of resolvers) resolve(this.exit);
  }

  // --------------------------------------------------------------------------

  private bind(): void {
    const { client, agent, tap } = this;

    // Raw lines are forwarded before the parsed tap sees them. Both listeners
    // run synchronously, in registration order, and neither can block the other.
    this.disposers.push(
      client.onLine((line) => this.forward("client", line)),
      agent.onLine((line) => this.forward("agent", line)),
      client.onMessage((message) => this.readOnly(() => tap?.ingestClientMessage(message))),
      agent.onMessage((message) => this.readOnly(() => tap?.ingestAgentMessage(message))),
      client.onMalformedLine((line) => this.readOnly(() => tap?.ingestMalformed("client", line))),
      agent.onMalformedLine((line) => this.readOnly(() => tap?.ingestMalformed("agent", line))),
      agent.onStderr((chunk) => this.writeStderr(chunk)),
      client.onError((error) => this.fail("client", "client stream error", error)),
      agent.onError((error) => this.fail("agent", "agent stream error", error)),
      client.onExit((code) => this.close("upstream client closed", "client", code)),
      agent.onExit((code) => this.close("agent process exited", "agent", code)),
    );
  }

  private forward(direction: "client" | "agent", line: string): void {
    if (this.closed) return;
    const target = direction === "client" ? this.agent : this.client;
    try {
      target.sendRaw(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.diagnostic(`failed to forward a ${direction} line`, message);
      this.close(`forwarding failed: ${message}`, direction === "client" ? "agent" : "client", null);
    }
  }

  private readOnly(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.diagnostic("tap failed", error instanceof Error ? error.message : String(error));
    }
  }

  private fail(side: AcpProxySide, message: string, error: unknown): void {
    if (this.closed) return;
    this.diagnostic(message, error);
    this.close(message, side, null);
  }

  private writeStderr(chunk: string): void {
    try {
      if (this.options.onAgentStderr) this.options.onAgentStderr(chunk);
      else process.stderr.write(chunk);
    } catch {
      // A dead stderr must not stop the wire.
    }
  }

  private diagnostic(message: string, detail?: unknown): void {
    try {
      this.options.onDiagnostic?.(message, detail);
    } catch {
      // Diagnostics are best-effort.
    }
  }
}
