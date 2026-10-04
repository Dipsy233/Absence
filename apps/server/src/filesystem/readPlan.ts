import fs from "node:fs/promises";
import path from "node:path";
import type { Plan } from "@daze/core";

const PLAN_FILES = ["TODO.md", "PLAN.md", "TASKS.md", "todo.md", "plan.md"];

/**
 * Plan is display-only for v0.1 (read.md §30). We look for a markdown
 * checklist in the project root and surface it as-is.
 */
export async function readPlan(cwd: string): Promise<Plan | undefined> {
  for (const name of PLAN_FILES) {
    const full = path.join(cwd, name);
    let text: string;
    try {
      text = await fs.readFile(full, "utf-8");
    } catch {
      continue;
    }
    const items = parseChecklist(text);
    if (items.length > 0) {
      return { title: "PLAN", items, source: name };
    }
  }
  return undefined;
}

export function parseChecklist(markdown: string): { text: string; done: boolean }[] {
  const items: { text: string; done: boolean }[] = [];
  for (const line of markdown.split("\n")) {
    const match = /^\s*[-*]\s+\[( |x|X)\]\s+(.*\S)\s*$/.exec(line);
    if (match) {
      items.push({ text: match[2]!, done: match[1]!.toLowerCase() === "x" });
    }
  }
  return items;
}
