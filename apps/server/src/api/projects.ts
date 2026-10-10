import fs from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { Project } from "@absence/core";
import { config } from "../config";
import { isIgnoredDir } from "../filesystem/FileTree";
import { toPosix } from "../util/paths";

/** GET /api/projects — directories under the configured root (read.md §31). */
export async function projectRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/projects", async (request): Promise<Project[]> => {
    const query = request.query as { root?: string } | undefined;
    const root = query?.root && query.root.trim() ? query.root : config.projectsRoot;

    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }

    const projects: Project[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".") || isIgnoredDir(entry.name)) continue;
      projects.push({ path: toPosix(path.join(root, entry.name)), name: entry.name });
    }
    projects.sort((a, b) => a.name.localeCompare(b.name));
    return projects;
  });
}
