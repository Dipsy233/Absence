import fs from "node:fs";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config, configure, type DazeConfig } from "./config";
import { projectRoutes } from "./api/projects";
import { sessionRoutes } from "./api/sessions";
import { wsRoutes } from "./websocket/ws";
import { JobMonitor } from "./process/JobMonitor";

export interface StartServerOptions {
  /** Port to listen on. `0` lets the OS pick a free one (the desktop shell). */
  port?: number;
  host?: string;
  /** Suppress Fastify's request logging (the desktop shell logs to its own file). */
  quiet?: boolean;
  /** Additional config overrides, applied before the server starts listening. */
  config?: Partial<DazeConfig>;
}

export interface RunningServer {
  app: FastifyInstance;
  /** The port actually bound — resolves the `0`-for-any choice. */
  port: number;
  host: string;
  /** The URL the UI should load. */
  url: string;
  close(): Promise<void>;
}

/**
 * Build and start the Daze server. Used by both the CLI entry point below and
 * the Electron desktop shell, which runs the server in-process instead of
 * spawning a child — so the app has one lifecycle and no stray console window.
 */
export async function startServer(options: StartServerOptions = {}): Promise<RunningServer> {
  if (options.config) configure(options.config);

  const app = Fastify({ logger: options.quiet ? false : { level: process.env.DAZE_LOG_LEVEL ?? "info" } });

  // Start the kernel process observer before anything else is spawned. On
  // Windows this puts the server into a Job Object; on Linux it attaches eBPF
  // tracepoints. Either way the kernel then reports every process creation and
  // exit instead of us sampling for them, and the helper's own start does not
  // appear as a session's work. A failure is not fatal; sessions fall back to
  // polling and the UI says precision is degraded.
  try {
    await JobMonitor.get().start();
    const via = process.platform === "linux" ? "eBPF tracepoints" : "Job Object events";
    app.log.info(`process watching: kernel ${via}`);
  } catch (error) {
    app.log.warn(
      `process watching: falling back to polling (${error instanceof Error ? error.message : String(error)})`,
    );
  }

  await app.register(websocket);
  await app.register(projectRoutes);
  await app.register(sessionRoutes);
  await app.register(wsRoutes);

  // Serve the built web app when it exists (production / single-origin).
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist });
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? "";
      if (url.startsWith("/api") || url.startsWith("/ws")) {
        reply.code(404).send({ error: "not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  }

  const port = options.port ?? config.port;
  const host = options.host ?? config.host;
  await app.listen({ port, host });

  // With port 0 the OS chose one; read it back from the listening address.
  const address = app.server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const url = `http://${host}:${actualPort}`;

  app.log.info(`DAZE server listening on ${url} (agent=${config.defaultAgent})`);
  app.log.info(`projects root: ${config.projectsRoot}`);

  return {
    app,
    port: actualPort,
    host,
    url,
    close: () => app.close(),
  };
}

/** CLI entry: `tsx src/index.ts`. The server owns its own process here. */
async function main(): Promise<void> {
  await startServer();
}

// Only run the CLI path when this module is the entry point, so the desktop
// shell can import `startServer` without the server binding a port twice.
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (entry === import.meta.url) {
  main().catch((error) => {
    console.error("DAZE server failed to start:", error);
    process.exit(1);
  });
}
