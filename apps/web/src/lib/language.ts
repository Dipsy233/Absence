import type * as monaco from "monaco-editor";

/** Monaco language id from a file path (mirrors the server helper). */
export function languageFromPath(filePath: string): string {
  const name = filePath.toLowerCase();
  const ext = name.slice(name.lastIndexOf("."));
  const map: Record<string, string> = {
    ".ts": "typescript",
    ".tsx": "typescript",
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
    ".sh": "shell",
    ".toml": "ini",
    ".yml": "yaml",
    ".yaml": "yaml",
  };
  return map[ext] ?? "plaintext";
}

export type MonacoNamespace = typeof monaco;
