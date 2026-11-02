/**
 * The proxy's read-only tap.
 *
 * It sits beside the forwarding path, never in it: the proxy forwards raw
 * lines first, then hands the *already parsed* message to this class. The tap
 * publishes `MonitorEvent`s tagged `source: "acp-proxy"`, records non-JSON
 * lines as diagnostics, and tracks agent→client permission requests so an
 * unanswered prompt is reported rather than answered.
 *
 * It never writes to either transport. There is deliberately no `send` here.
 */

import type { MonitorBus, MonitorEvent } from "@absence/core";
import { AcpMonitorProjector } from "../../../monitor/projector";
import { isJsonRpcId, type JsonRpcId, type JsonRpcMessage } from "../protocol/jsonrpc";

export type ProxyDirection = "client" | "agent";

export interface ProxyDiagnostic {
  kind: "malformed-line" | "unanswered-permission" | "tap-error";
  message: string;
  direction?: ProxyDirection;
  /** The raw line, for `malformed-line`; it is never modified or dropped. */
  line?: string;
  id?: JsonRpcId;
  method?: string;
  sessionId?: string;
}

export interface AcpProxyTapStats {
  clientMessages: number;
  agentMessages: number;
  malformedLines: number;
  events: number;
  permissionRequests: number;
  permissionAnswers: number;
  unansweredPermissions: number;
}

export interface AcpProxyTapOptions {
  cwd: string;
  /** Session id used when a message carries none (the proxy's own id). */
  fallbackSessionId: string;
  bus?: MonitorBus;
  now?: () => number;
  onEvent?: (event: MonitorEvent) => void;
  onDiagnostic?: (diagnostic: ProxyDiagnostic) => void;
}

interface PendingPermission {
  id: JsonRpcId;
  method: string;
  sessionId?: string;
  at: number;
}

export class AcpProxyTap {
  private readonly projectors = new Map<string, AcpMonitorProjector>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingTasks = new Set<Promise<void>>();
  private clientMessages = 0;
  private agentMessages = 0;
  private malformedLines = 0;
  private events = 0;
  private permissionRequests = 0;
  private permissionAnswers = 0;
  private unansweredAtClose = 0;
  private closed = false;

  constructor(private readonly options: AcpProxyTapOptions) {}

  /** A line leaving the client (or the agent); `parse` already failed. */
  ingestMalformed(direction: ProxyDirection, line: string): void {
    this.malformedLines += 1;
    this.diagnose({
      kind: "malformed-line",
      direction,
      line,
      message: `${direction} line is not JSON-RPC; forwarded verbatim and recorded only`,
    });
  }

  /** A message sent by the ACP client towards the agent. */
  ingestClientMessage(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.clientMessages += 1;

    // A response from the client is the only thing that can settle a
    // permission request. The tap merely notes it; it never creates one.
    if (!("method" in message)) {
      const key = idKey(message.id);
      if (key !== undefined && this.pendingPermissions.has(key)) {
        this.pendingPermissions.delete(key);
        this.permissionAnswers += 1;
      }
    }
  }

  /** A message sent by the agent towards the ACP client. */
  ingestAgentMessage(message: JsonRpcMessage): void {
    if (this.closed) return;
    this.agentMessages += 1;

    if ("method" in message) {
      if (
        message.method === "session/request_permission" &&
        "id" in message &&
        isJsonRpcId(message.id)
      ) {
        this.permissionRequests += 1;
        this.pendingPermissions.set(idKey(message.id)!, {
          id: message.id,
          method: message.method,
          sessionId: sessionIdOf(message.params),
          at: this.now(),
        });
      }

      if (message.method === "session/update") {
        const sessionId = sessionIdOf(message.params) ?? this.options.fallbackSessionId;
        this.project(sessionId, message.method, message.params);
      }
    }
  }

  /** Wait for every projection already scheduled (deterministic checks). */
  async drain(): Promise<void> {
    while (this.pendingTasks.size > 0) {
      await Promise.allSettled([...this.pendingTasks]);
    }
  }

  stats(): AcpProxyTapStats {
    return {
      clientMessages: this.clientMessages,
      agentMessages: this.agentMessages,
      malformedLines: this.malformedLines,
      events: this.events,
      permissionRequests: this.permissionRequests,
      permissionAnswers: this.permissionAnswers,
      unansweredPermissions: this.closed
        ? this.unansweredAtClose
        : this.pendingPermissions.size,
    };
  }

  /** Record every request the real client never answered, then stop. */
  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.unansweredAtClose = this.pendingPermissions.size;
    for (const pending of this.pendingPermissions.values()) {
      this.diagnose({
        kind: "unanswered-permission",
        id: pending.id,
        method: pending.method,
        sessionId: pending.sessionId,
        message: `${pending.method} (${idKey(pending.id)}) was never answered by the upstream client; proxy did not decide (${reason})`,
      });
    }
    this.pendingPermissions.clear();
    for (const projector of this.projectors.values()) projector.dispose();
    this.projectors.clear();
  }

  private project(sessionId: string, method: string, params: unknown): void {
    const task = (async () => {
      try {
        const projected = await this.projectorFor(sessionId).project(method, params);
        for (const event of projected) this.emit(event);
      } catch (error) {
        this.diagnose({
          kind: "tap-error",
          message: `tap projection failed: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    })();
    this.pendingTasks.add(task);
    void task.finally(() => this.pendingTasks.delete(task));
  }

  private emit(projected: MonitorEvent): void {
    if (this.closed) return;
    const event: MonitorEvent = { ...projected, source: "acp-proxy" };
    this.events += 1;
    try {
      this.options.bus?.publish(event);
    } catch (error) {
      this.diagnose({
        kind: "tap-error",
        message: `monitor bus rejected an event: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    try {
      this.options.onEvent?.(event);
    } catch {
      // A listener must not be able to break the proxy's observation.
    }
  }

  private projectorFor(sessionId: string): AcpMonitorProjector {
    let projector = this.projectors.get(sessionId);
    if (!projector) {
      projector = new AcpMonitorProjector({
        sessionId,
        cwd: this.options.cwd,
        now: this.options.now,
      });
      this.projectors.set(sessionId, projector);
    }
    return projector;
  }

  private diagnose(diagnostic: ProxyDiagnostic): void {
    try {
      this.options.onDiagnostic?.(diagnostic);
    } catch {
      // Diagnostics are best-effort; they must never disturb forwarding.
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}

/** JSON-RPC ids are strings or numbers; a Map key needs one namespace. */
function idKey(id: JsonRpcId): string | undefined {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return undefined;
}

function sessionIdOf(params: unknown): string | undefined {
  const sessionId = (params as { sessionId?: unknown } | undefined)?.sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}
