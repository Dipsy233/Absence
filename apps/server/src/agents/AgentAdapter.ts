import {
  createEvent,
  type ContextState,
  type DazeEvent,
  type DazeEventPayloadMap,
  type DazeEventType,
} from "@daze/core";

/**
 * The runtime-agnostic boundary (read.md §7).
 *
 * Every agent runtime — Pi today, anything later — is reduced to this
 * interface. The rest of Daze only ever sees DazeEvent.
 */
export interface AgentStartContext {
  sessionId: string;
  cwd: string;
  model?: string;
}

export interface AgentStartResult {
  model: string;
  /** True when the requested runtime was unavailable and we degraded. */
  degraded?: boolean;
}

export interface AgentAdapter {
  readonly runtime: string;
  start(ctx: AgentStartContext): Promise<AgentStartResult>;
  /** Resolves when the run finishes (matches Pi's prompt semantics). */
  prompt(text: string): Promise<void>;
  abort(): Promise<void>;
  subscribe(fn: (event: DazeEvent) => void): () => void;
  /** Context window usage, or undefined when the runtime cannot report it. */
  getContextUsage(): ContextState | undefined;
  dispose(): void;
}

/** Base class with subscriber plumbing shared by adapters. */
export abstract class BaseAdapter implements AgentAdapter {
  abstract readonly runtime: string;
  protected sessionId = "";
  protected cwd = "";
  private subscribers = new Set<(event: DazeEvent) => void>();

  abstract start(ctx: AgentStartContext): Promise<AgentStartResult>;
  abstract prompt(text: string): Promise<void>;
  abstract abort(): Promise<void>;
  abstract getContextUsage(): ContextState | undefined;
  abstract dispose(): void;

  subscribe(fn: (event: DazeEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  protected emit(event: DazeEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  /** Emit a DazeEvent for this session, with the payload type checked. */
  protected emitDaze<K extends DazeEventType>(type: K, payload: DazeEventPayloadMap[K]): void {
    this.emit(createEvent(this.sessionId, type, payload));
  }
}
