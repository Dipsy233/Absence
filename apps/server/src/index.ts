import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config";
import { projectRoutes } from "./api/projects";
import { sessionRoutes } from "./api/sessions";
import { wsRoutes } from "./websocket/ws";
import { JobMonitor } from "./process/JobMonitor";

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.DAZE_LOG_LEVEL ?? "info" } });

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

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`DAZE server listening on http://${config.host}:${config.port} (agent=${config.defaultAgent})`);
  app.log.info(`projects root: ${config.projectsRoot}`);
}

main().catch((error) => {
  console.error("DAZE server failed to start:", error);
  process.exit(1);
});
