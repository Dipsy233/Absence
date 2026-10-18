import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  CodexTranscriptReader,
  detectAgent,
  PiTranscriptReader,
  type ParsedLine,
  type TranscriptAgent,
} from "./SessionLogReader";

/**
 * Watches an agent's own transcript file and reports what it records.
 *
 * Discovery, per agent, mirrors that agent's own layout — deliberately not
 * "scan every jsonl under a directory", because a transcript must be the
 * session we are watching, not one from last month:
 *
 *   Pi     ~/.pi/agent/sessions/<encoded-cwd>/<newest>.jsonl
 *   Codex  ~/.codex/sessions/YYYY/MM/DD/rollout-<newest>.jsonl
 *
 * Both agents append, one JSON object per line. Like the terminal mirror, the
 * file is watched by size rather than by filesystem events: a partial trailing
 * line is normal, and keeping the remainder is both simpler and correct.
 */
const POLL_MS = 500;
/** How often to look for a transcript that did not exist when the session began. */
const DISCOVERY_MS = 2_000;

export interface TranscriptSink {
  /** A tool call completed (arguments and result both known). */
  onCall(call: ParsedLine["calls"] extends (infer T)[] | undefined ? T : never): void;
  /** The agent declared which skills it can load. */
  onSkills(skills: NonNullable<ParsedLine["skills"]>): void;
}

/** Encode a project path the way Pi names its per-project session directory. */
export function piSessionDirFor(projectPath: string, agentDir = join(homedir(), ".pi", "agent")): string {
  const encoded = `--${projectPath.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", encoded);
}

/** The most recently modified `.jsonl` in a directory, or undefined. */
function newestJsonl(dir: string): string | undefined {
  try {
    let best: { path: string; mtime: number } | undefined;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const path = join(dir, entry.name);
      try {
        const mtime = statSync(path).mtimeMs;
        if (!best || mtime > best.mtime) best = { path, mtime };
      } catch {
        // A file that vanished mid-scan is not a candidate.
      }
    }
    return best?.path;
  } catch {
    return undefined;
  }
}

/** Descend `YYYY/MM/DD` looking for the newest rollout, without recursing blindly. */
function newestCodexRollout(root: string): string | undefined {
  const best = (dir: string, depth: number): { path: string; mtime: number } | undefined => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    let found: { path: string; mtime: number } | undefined;
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 3) {
        const deeper = best(path, depth + 1);
        if (deeper && (!found || deeper.mtime > found.mtime)) found = deeper;
      } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
        try {
          const mtime = statSync(path).mtimeMs;
          if (!found || mtime > found.mtime) found = { path, mtime };
        } catch {
          // Ignore a file we cannot stat.
        }
      }
    }
    return found;
  };
  return best(root, 0)?.path;
}

/** Where each agent keeps its transcripts, and how to find this session's. */
export function locateTranscript(agent: TranscriptAgent, projectPath: string): string | undefined {
  if (agent === "pi") return newestJsonl(piSessionDirFor(projectPath));
  return newestCodexRollout(join(homedir(), ".codex", "sessions"));
}

export class SessionLogTail {
  private offset = 0;
  private remainder = "";
  private timer?: ReturnType<typeof setTimeout>;
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private disposed = false;
  private path?: string;
  private agent?: TranscriptAgent;
  private readonly pi = new PiTranscriptReader();
  private readonly codex = new CodexTranscriptReader();

  /**
   * @param projectPath the workspace, used to find Pi's per-project directory.
   * @param onFile where to start from: a transcript that already exists holds
   *   calls from before this session, and replaying them would invent history.
   * @param hint the agent to look for; both are tried when unknown.
   */
  constructor(
    private readonly projectPath: string,
    private readonly sink: TranscriptSink,
    private readonly hint?: TranscriptAgent,
    private readonly explicitPath?: string,
  ) {}

  start(): void {
    this.discover(true);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.timer = undefined;
    this.discoveryTimer = undefined;
  }

  /** Which file is being read, for the report and for diagnostics. */
  get transcriptPath(): string | undefined {
    return this.path;
  }

  private discover(fresh: boolean): void {
    if (this.disposed) return;
    // An explicit path wins: the caller knows exactly which transcript to read.
    if (this.explicitPath) {
      this.path = this.explicitPath;
      this.offset = fresh ? this.sizeOf(this.path) : 0;
      this.remainder = "";
      this.tick();
      return;
    }
    const order: TranscriptAgent[] = this.hint ? [this.hint] : ["pi", "codex"];
    for (const agent of order) {
      const path = locateTranscript(agent, this.projectPath);
      if (!path || !existsSync(path)) continue;
      this.agent = agent;
      this.path = path;
      // Start at the end: everything written before this session began belongs
      // to an earlier run.
      this.offset = fresh ? this.sizeOf(path) : 0;
      this.remainder = "";
      this.tick();
      return;
    }
    // The agent may not have written anything yet; keep looking.
    this.scheduleDiscovery();
  }

  private sizeOf(path: string): number {
    try {
      return statSync(path).size;
    } catch {
      return 0;
    }
  }

  private scheduleDiscovery(): void {
    if (this.disposed || this.discoveryTimer !== undefined) return;
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      this.discover(true);
    }, DISCOVERY_MS);
  }

  private schedule(): void {
    if (this.disposed || this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, POLL_MS);
  }

  private tick(): void {
    if (this.disposed || !this.path) return;
    const size = this.sizeOf(this.path);
    if (size < this.offset) {
      // Truncated or replaced: no longer the file we were reading.
      this.offset = 0;
      this.remainder = "";
    }
    if (size > this.offset) {
      try {
        // Synchronous on purpose: a poll of a file that only grows on a tool
        // call reads a few kilobytes, and an ordered read keeps the pairing
        // between a call and its result intact.
        const chunk = readFileSync(this.path, { encoding: "utf8" });
        const text = chunk.slice(this.offset, size);
        this.offset = size;
        this.consume(this.remainder + text);
      } catch {
        // A failed read is a missed tick, not a reason to stop observing.
      }
    }
    this.schedule();
  }

  private consume(text: string): void {
    const lines = text.split("\n");
    // The last element is either empty (the chunk ended on a newline) or a
    // partial line; keep it until the rest arrives.
    this.remainder = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: unknown;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      const agent = this.agent ?? detectAgent(record);
      if (!agent) continue;
      const parsed = agent === "pi" ? this.pi.push(record) : this.codex.push(record);
      for (const call of parsed.calls ?? []) this.sink.onCall(call);
      if (parsed.skills && parsed.skills.length > 0) this.sink.onSkills(parsed.skills);
    }
  }
}
