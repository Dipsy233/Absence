import path from "node:path";
import type { ProcInfo, ProcessTable } from "./ProcessTable";

/** Command-line evidence only: never inspect credentials or mutate an agent. */
export function piSessionFile(info: ProcInfo): string | undefined {
  const args = info.commandLine.match(/"[^"]*"|'[^']*'|[^\s]+/g)?.map((arg) =>
    arg.replace(/^(["'])(.*)\1$/, "$2"),
  ) ?? [];
  // Require the executable/entrypoint signature, not a mention inside a shell command.
  const executable = (args[0] ?? "").replace(/\\/g, "/").split("/").pop()?.toLowerCase();
  const entry = (args[1] ?? "").replace(/\\/g, "/");
  const isPi = executable === "pi" || executable === "pi.exe" ||
    ((executable === "node" || executable === "node.exe") &&
      /\/@(?:mariozechner|earendil-works)\/pi-coding-agent\/dist\/cli\.js$/i.test(entry));
  if (!isPi) return undefined;
  const index = args.indexOf("--session");
  const file = index >= 0 ? args[index + 1] : args.find((arg) => arg.startsWith("--session="))?.slice(10);
  // Relative paths need the process cwd, which the portable table cannot prove.
  return file && path.isAbsolute(file) ? file : undefined;
}

/** Ambiguity is absence of attribution, never a first-match guess. */
export function findPiSession(table: ProcessTable, transcriptFile: string): ProcInfo | undefined {
  const normalize = (file: string) => {
    const resolved = path.resolve(file);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const matches = [...table.values()].filter((info) => {
    const file = piSessionFile(info);
    return file !== undefined && normalize(file) === normalize(transcriptFile);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** Parent-first traversal, bounded even for malformed cyclic tables. */
export function attributedTree(table: ProcessTable, root: number): ProcInfo[] {
  const seen = new Set([root]);
  const result: ProcInfo[] = [];
  for (let index = 0, queue = [root]; index < queue.length; index++) {
    for (const info of table.values()) {
      if (info.ppid !== queue[index] || seen.has(info.pid)) continue;
      seen.add(info.pid);
      queue.push(info.pid);
      result.push(info);
    }
  }
  return result;
}
