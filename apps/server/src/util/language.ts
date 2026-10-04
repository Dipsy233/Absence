import path from "node:path";

/** Map a file path to a Monaco language id. */
export function languageFromPath(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mts": "typescript",
    ".cts": "typescript",
    ".js": "javascript",
    ".jsx": "javascript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".py": "python",
    ".rb": "ruby",
    ".go": "go",
    ".rs": "rust",
    ".java": "java",
    ".kt": "kotlin",
    ".c": "c",
    ".h": "c",
    ".cpp": "cpp",
    ".hpp": "cpp",
    ".cs": "csharp",
    ".php": "php",
    ".swift": "swift",
    ".json": "json",
    ".md": "markdown",
    ".css": "css",
    ".scss": "scss",
    ".html": "html",
    ".vue": "html",
    ".svelte": "html",
    ".sh": "shell",
    ".bash": "shell",
    ".zsh": "shell",
    ".toml": "ini",
    ".yml": "yaml",
    ".yaml": "yaml",
  };
  return map[ext] ?? "plaintext";
}
