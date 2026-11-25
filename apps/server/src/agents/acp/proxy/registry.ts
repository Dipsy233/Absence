/**
 * Proxy session lifecycle.
 *
 * A session owns one client transport, one agent process and one tap. The CLI
 * starts sessions over its own stdio; the HTTP API starts them over a
 * localhost socket so a client can attach after `POST /api/acp-proxy/sessions`
 * has returned its endpoint. Both paths share the same `AcpProxy`.
 */

import { randomUUID } from "node:crypto";
import { createServer, type Server, type Socket } from "node:net";
import path from "node:path";
import type { AbsenceEvent, MonitorBus, MonitorEvent } from "@absence/core";
import { createMonitorBus } from "../../../monitor/MonitorBus";
import { isNarrowScope } from "../../../observe/types";
import type { AbsenceSession, SessionStore } from "../../../sessions/SessionStore";
import { AcpProxy, type AcpProxyExit } from "./proxy";
import type { AcpProxyTapStats, ProxyDiagnostic } from "./tap";
import { AcpProxyTap } from "./tap";
import {
  createAgentTransport,
  createProcessTransport,
  createStreamTransport,
  type AcpProxyTransport,
} from "./transport";

export interface ProxyLaunchRequest {
  /** The agent command: `[command, ...args]`. */
  command: string[];
  /** The directory the agent works in. */
  cwd?: string;
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  label?: string;
}

export interface ProxyEndpoint {
  host: string;
  port: number;
}

export type ProxySessionStatus = "waiting" | "running" | "closed" | "failed";

export interface ProxySessionInfo {
  id: string;
  label: string;
  command: string[];
  cwd: string;
  /**
   * The Absence session this proxy persists into, when the observer subsystem
   * is on. The tap's projected facts land there — SQLite, run index, WS — so
   * a proxied turn survives the server restarting.
   */
  sessionId?: string;
  /** How the upstream client attached: process stdio, or a TCP socket. */
  transport: "stdio" | "tcp";
  status: ProxySessionStatus;
  createdAt: number;
  closedAt?: number;
  pid?: number;
  exitCode?: number | null;
  endpoint?: ProxyEndpoint;
  stats: AcpProxyTapStats;
  diagnostics: string[];
  error?: string;
}

export interface ProxySessionHandle {
  readonly id: string;
  info(): ProxySessionInfo;
  waitForExit(): Promise<AcpProxyExit>;
  close(reason?: string): void;
}

const EMPTY_STATS: AcpProxyTapStats = {
  clientMessages: 0,
  agentMessages: 0,
  malformedLines: 0,
  events: 0,
  permissionRequests: 0,
  permissionAnswers: 0,
  unansweredPermissions: 0,
};

class ProxySession implements ProxySessionHandle {
  readonly id = randomUUID();

  private readonly state: ProxySessionInfo;
  private readonly exitPromise: Promise<AcpProxyExit>;
  private resolveExit: (exit: AcpProxyExit) => void = () => {};
  private exitResolved = false;
  private closed = false;

  private proxy?: AcpProxy;
  private tap?: AcpProxyTap;
  private client?: AcpProxyTransport;
  private listener?: Server;

  constructor(
    private readonly request: ProxyLaunchRequest,
    private readonly bus: MonitorBus,
    private readonly store?: SessionStore,
  ) {
    const cwd = path.resolve(request.cwd ?? process.cwd());
    this.state = {
      id: this.id,
      label: request.label ?? request.command[0] ?? "agent",
      command: [...request.command],
      cwd,
      transport: "stdio",
      status: "waiting",
      createdAt: Date.now(),
      stats: EMPTY_STATS,
      diagnostics: [],
    };
    this.exitPromise = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
  }

  info(): ProxySessionInfo {
    return {
      ...this.state,
      command: [...this.state.command],
      stats: this.tap?.stats() ?? EMPTY_STATS,
      diagnostics: [...this.state.diagnostics],
      endpoint: this.state.endpoint ? { ...this.state.endpoint } : undefined,
    };
  }

  waitForExit(): Promise<AcpProxyExit> {
    return this.exitPromise;
  }

  /** Start over the caller's stdio (the `absence proxy` CLI path). */
  activate(client: AcpProxyTransport): void {
    if (this.closed) {
      client.close();
      return;
    }
    this.client = client;
    this.state.transport = "stdio";
    void this.startAgent(client);
  }

  /** Accept the first socket as the client; later arrivals are refused. */
  acceptSocket(socket: Socket): void {
    if (this.closed || this.proxy) {
      socket.destroy();
      return;
    }
    socket.on("error", () => {
      // The transport reports errors; a bare socket must not crash the server.
    });
    const client = createStreamTransport({
      input: socket,
      output: socket,
      label: "acp client socket",
      dispose: () => {
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      },
    });
    void this.startAgent(client);
  }

  listen(host: string, port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer((socket) => this.acceptSocket(socket));
      this.listener = server;
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", (error) => this.recordDiagnostic(`socket error: ${error.message}`));
        const address = server.address();
        const actualPort = typeof address === "object" && address !== null ? address.port : port;
        this.state.transport = "tcp";
        this.state.endpoint = { host, port: actualPort };
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    });
  }

  close(reason = "proxy session closed"): void {
    if (this.closed) return;
    this.closed = true;
    this.state.status = "closed";
    this.state.closedAt = Date.now();

    if (this.listener) {
      try {
        this.listener.close();
      } catch {
        // not listening any more
      }
      this.listener = undefined;
    }

    if (this.proxy) {
      this.proxy.close(reason);
      return;
    }
    try {
      this.client?.close();
    } catch {
      // already gone
    }
    this.finish({ side: "closed", code: null, reason });
  }

  // --------------------------------------------------------------------------

  private async startAgent(client: AcpProxyTransport): Promise<void> {
    const command = this.request.command[0]!;
    const args = this.request.command.slice(1);
    // The observed session is the proxy's persistence. It exists before the
    // agent spawns so the marker environment variable can name it: the Windows
    // Job observer then attributes the agent's whole process tree to this
    // session exactly, and the tap's facts land in SQLite and on the WS.
    // Attaching must never stand between the client and its agent — a failed
    // attach degrades to a transient proxy, diagnosed honestly.
    let absence: AbsenceSession | undefined;
    if (this.store) {
      try {
        absence = await this.attachAbsence();
      } catch (error) {
        this.recordDiagnostic(
          `observed session unavailable, proxy persists nothing: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (this.closed) {
      absence?.dispose();
      client.close();
      return;
    }
    const env = absence
      ? { ...this.request.env, ABSENCE_SESSION_ID: absence.id }
      : this.request.env;
    let agent: AcpProxyTransport;
    try {
      agent = createAgentTransport({ command, args }, this.state.cwd, env ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.state.status = "failed";
      this.state.error = message;
      this.recordDiagnostic(`failed to start agent: ${message}`);
      try {
        client.close();
      } catch {
        // already gone
      }
      this.finish({ side: "agent", code: null, reason: message });
      return;
    }

    this.tap = new AcpProxyTap({
      cwd: this.state.cwd,
      fallbackSessionId: this.id,
      bus: this.bus,
      // Command windows ride the observed session's watcher, so eggs and
      // container attribution work here exactly as for a driven session.
      ...(absence ? { commandWindow: absence.processWindows() } : {}),
      ...(absence ? { onEvent: (event: MonitorEvent) => this.feedAbsence(absence, event) } : {}),
      onDiagnostic: (diagnostic) => this.recordDiagnostic(diagnostic.message, diagnostic),
    });

    this.proxy = new AcpProxy({
      client,
      agent,
      tap: this.tap,
      onDiagnostic: (message) => this.recordDiagnostic(message),
    });

    // The agent pid completes the attribution pair: from here the kernel
    // stream accepts marked events as this session's own.
    absence?.declareRuntimePid(this.proxy.pid);

    this.state.status = "running";
    this.state.pid = this.proxy.pid;
    void this.proxy.waitForExit().then((exit) => this.finish(exit));
  }

  /**
   * Create (or find) the observed session this proxy persists into. The proxy
   * session id is the external identity, so identity is idempotent per
   * (channel, externalId) like every other observed channel.
   */
  private async attachAbsence(): Promise<AbsenceSession> {
    if (!this.store) throw new Error("no session store attached");
    const kind = this.request.label?.trim() || path.basename(commandExecutable(this.request.command)) || "acp-agent";
    const session = await this.store.createObserved(this.state.cwd, kind, {
      channel: "acp-proxy",
      externalId: this.id,
      // A proxy pointed at a wholesale scope (the home directory, a drive
      // root) gets facts only, exactly like a transcript that names one.
      ...(isNarrowScope(this.state.cwd) ? {} : { watchProject: false }),
    });
    this.state.sessionId = session.id;
    return session;
  }

  /** One projected fact from the tap, flattened into the session pipeline. */
  private feedAbsence(absence: AbsenceSession, event: MonitorEvent): void {
    const bridged: AbsenceEvent = {
      ...event.event,
      at: event.at,
      source: event.source,
      fidelity: event.fidelity,
      sessionId: absence.id,
    };
    absence.ingestObservation(bridged);
  }

  private finish(exit: AcpProxyExit): void {
    if (this.exitResolved) return;
    this.exitResolved = true;
    this.closed = true;
    this.state.status = this.state.status === "failed" ? "failed" : "closed";
    this.state.closedAt = Date.now();
    this.state.exitCode = exit.code;
    if (this.listener) {
      try {
        this.listener.close();
      } catch {
        // not listening any more
      }
      this.listener = undefined;
    }
    this.resolveExit(exit);
  }

  private recordDiagnostic(message: string, diagnostic?: ProxyDiagnostic): void {
    const entry = diagnostic?.direction ? `[${diagnostic.direction}] ${message}` : message;
    if (this.state.diagnostics.length >= 50) this.state.diagnostics.shift();
    this.state.diagnostics.push(entry);
    if (diagnostic?.kind === "malformed-line" && diagnostic.line !== undefined) {
      // The raw line was forwarded unchanged; keep it visible for operators.
      if (this.state.diagnostics.length >= 50) this.state.diagnostics.shift();
      this.state.diagnostics.push(`  ${diagnostic.line}`);
    }
  }
}

function commandExecutable(command: readonly string[]): string {
  return path.basename(command[0] ?? "");
}

export class ProxySessions {
  private readonly sessions = new Map<string, ProxySession>();
  private store?: SessionStore;

  constructor(readonly bus: MonitorBus = createMonitorBus()) {}

  /**
   * The session store a proxy persists into, wired at server assembly. When
   * none is attached (checks, `ABSENCE_OBSERVE=0`), a proxy stays what it was
   * before the observer existed: a byte-forwarder whose facts are transient.
   */
  useSessionStore(store: SessionStore | undefined): void {
    this.store = store;
  }

  /** Start a proxy over the caller's stdio. */
  startStdio(
    request: ProxyLaunchRequest,
    client: AcpProxyTransport = createProcessTransport(),
  ): ProxySessionHandle {
    const session = new ProxySession(request, this.bus, this.store);
    this.sessions.set(session.id, session);
    session.activate(client);
    return session;
  }

  /** Start a proxy and listen for one client over a localhost socket. */
  async startTcp(
    request: ProxyLaunchRequest,
    options: { host?: string; port?: number } = {},
  ): Promise<ProxySessionHandle> {
    const session = new ProxySession(request, this.bus, this.store);
    await session.listen(options.host ?? "127.0.0.1", options.port ?? 0);
    this.sessions.set(session.id, session);
    return session;
  }

  list(): ProxySessionInfo[] {
    return [...this.sessions.values()].map((session) => session.info());
  }

  get(id: string): ProxySessionInfo | undefined {
    return this.sessions.get(id)?.info();
  }

  close(id: string, reason?: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.close(reason);
    return true;
  }

  closeAll(reason?: string): void {
    for (const session of this.sessions.values()) session.close(reason);
  }
}

export const proxySessions = new ProxySessions();
