import type { AbsenceEvent } from "@absence/core";

/**
 * One process the agent laid (v0.3). Folded from the session's `process` events,
 * so this is the *current* state of an egg rather than its history.
 */
export interface Egg {
  pid: number;
  ppid: number;
  name: string;
  commandLine: string;
  status: "running" | "exited";
  /** When Absence first saw it alive. */
  startedAt: number;
  exitedAt?: number;
  /** Descendants rolled into this egg. */
  children: number;
  /** The shell command that laid it. */
  command?: string;
  /** Primary (worth tracking) or tool (a helper, folded into a count). */
  kind: "primary" | "tool";
  /** Why it was classified that way. */
  kindReason?: string;
  /** The event that last described it — what a click opens. */
  event: AbsenceEvent;
}

/**
 * An egg is laid once and then updates in place (running → exited), so the panel
 * shows state and not a log. Newest first.
 *
 * A process the classifier called a `tool` is kept here — the raw record is
 * never thrown away — but the panel folds it into a count rather than listing
 * it. That is what keeps a command's `cat`, `grep` and `sleep` from burying the
 * one daemon it actually started.
 */
export function buildEggs(events: AbsenceEvent[]): Egg[] {
  const byPid = new Map<number, Egg>();
  for (const event of events) {
    if (event.type !== "process") continue;
    const { pid, ppid, name, commandLine, status, startedAt, exitedAt, children, command, kind, kindReason } =
      event.payload;
    byPid.set(pid, {
      pid,
      ppid,
      name,
      commandLine,
      status,
      startedAt,
      exitedAt,
      children,
      command,
      kind: kind ?? "primary",
      kindReason,
      event,
    });
  }
  return [...byPid.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** The eggs worth showing individually: everything the classifier called primary. */
export function primaryEggs(eggs: Egg[]): Egg[] {
  return eggs.filter((egg) => egg.kind === "primary");
}

/** The folded helpers: how many tools ran, and their most recent names. */
export interface ToolSummary {
  count: number;
  running: number;
  /** Distinct names, most frequent first, capped for display. */
  names: string[];
}

export function summarizeTools(eggs: Egg[]): ToolSummary {
  const tools = eggs.filter((egg) => egg.kind === "tool");
  const frequency = new Map<string, number>();
  let running = 0;
  for (const tool of tools) {
    if (tool.status === "running") running += 1;
    frequency.set(tool.name, (frequency.get(tool.name) ?? 0) + 1);
  }
  const names = [...frequency.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name)
    .slice(0, 6);
  return { count: tools.length, running, names };
}

export type EggFilter = "running" | "dead" | "all";

export function filterEggs(eggs: Egg[], filter: EggFilter): Egg[] {
  if (filter === "all") return eggs;
  return eggs.filter((egg) => (filter === "running" ? egg.status === "running" : egg.status === "exited"));
}

export interface EggCounts {
  running: number;
  dead: number;
  all: number;
}

export function countEggs(eggs: Egg[]): EggCounts {
  let running = 0;
  for (const egg of eggs) {
    if (egg.status === "running") running += 1;
  }
  return { running, dead: eggs.length - running, all: eggs.length };
}
