import fs from "node:fs";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import { config } from "./config";
import { projectRoutes } from "./api/projects";
import { sessionRoutes } from "./api/sessions";
import { wsRoutes } from "./websocket/ws";

async function main(): Promise<void> {
  const app = Fastify({ logger: { level: process.env.DAZE_LOG_LEVEL ?? "info" } });

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
