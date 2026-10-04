import fs from "node:fs/promises";
import path from "node:path";
import type { FileTreeNode } from "@daze/core";
import { toPosix } from "../util/paths";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".vite",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

const IGNORED_FILE_RE =
  /(\.lock$|\.min\.(js|css)$|\.map$|\.png$|\.jpe?g$|\.gif$|\.webp$|\.ico$|\.pdf$|\.zip$|\.gz$|\.wasm$|\.woff2?$|\.ttf$)/i;

const CODE_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".kt",
  ".c",
  ".h",
  ".cpp",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".json",
  ".md",
  ".css",
  ".scss",
  ".html",
  ".vue",
  ".svelte",
  ".sh",
  ".toml",
  ".yml",
  ".yaml",
]);

export function isIgnoredDir(name: string): boolean {
  return IGNORED_DIRS.has(name);
}

export function isIgnoredFile(name: string): boolean {
  return IGNORED_FILE_RE.test(name);
}

export async function readFileSafe(absolutePath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(absolutePath);
    // Treat binaries as unreadable.
    if (buf.includes(0)) return null;
    return buf.toString("utf-8");
  } catch {
    return null;
  }
}

export interface BuildTreeOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export async function buildTree(root: string, options: BuildTreeOptions = {}): Promise<FileTreeNode> {
  const maxDepth = options.maxDepth ?? 6;
  let budget = options.maxEntries ?? 4000;

  async function walk(dir: string, depth: number): Promise<FileTreeNode[]> {
    if (depth > maxDepth || budget <= 0) return [];
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const dirs: FileTreeNode[] = [];
    const files: FileTreeNode[] = [];
    for (const entry of entries) {
      if (budget-- <= 0) break;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        dirs.push({
          name: entry.name,
          path: toPosix(full),
          type: "directory",
          children: await walk(full, depth + 1),
        });
      } else if (entry.isFile()) {
        if (isIgnoredFile(entry.name)) continue;
        files.push({ name: entry.name, path: toPosix(full), type: "file" });
      }
    }
    const byName = (a: FileTreeNode, b: FileTreeNode) => a.name.localeCompare(b.name);
    dirs.sort(byName);
    files.sort(byName);
    return [...dirs, ...files];
  }

  return {
    name: path.basename(root) || root,
    path: toPosix(root),
    type: "directory",
    children: await walk(root, 0),
  };
}

/** Relative paths of code-ish files, breadth-first, newest-ish first. */
export async function scanCodeFiles(root: string, limit = 40): Promise<string[]> {
  const results: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (queue.length > 0 && results.length < limit) {
    const current = queue.shift()!;
    if (current.depth > 4) continue;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (results.length >= limit) break;
      const full = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name)) continue;
        queue.push({ dir: full, depth: current.depth + 1 });
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXT.has(ext) && !isIgnoredFile(entry.name)) {
          results.push(toPosix(path.relative(root, full)));
        }
      }
    }
  }
  return results;
}
