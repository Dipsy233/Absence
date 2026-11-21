import type { ContextState, AbsenceEvent } from "@absence/core";
import { BaseAdapter, type AgentStartResult } from "../agents/AgentAdapter";

/**
 * The adapter an observed session runs on: it drives nothing.
 *
 * An observed session still needs something on the `AgentAdapter` seam — the
 * session's event plumbing subscribes through it — so the transcript feed uses
 * this no-op instead of a real runtime client. `prompt`/`abort` are refused,
 * not ignored: an observed session must fail loudly if anything ever tries to
 * write to the agent through it, rather than quietly doing nothing.
 */
export class ObserveAdapter extends BaseAdapter {
  override readonly runtime = "observe";

  override async start(): Promise<AgentStartResult> {
    // No runtime to start; the model arrives later as transcript facts.
    return { model: "" };
  }

  override async prompt(): Promise<void> {
    throw new Error(
      "This session is observed, not driven — Absence only watches it. Send your prompts in the agent's own terminal.",
    );
  }

  override async abort(): Promise<void> {
    // Nothing to abort: no turn here was started by Absence.
  }

  override getContextUsage(): ContextState | undefined {
    return undefined;
  }

  override dispose(): void {}

  /**
   * The transcript feed's entry point. Events arrive pre-stamped with
   * `source`/`fidelity`; the session re-stamps only what is missing.
   */
  emitEvent(event: AbsenceEvent): void {
    this.emit(event);
  }
}
