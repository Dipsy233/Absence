/**
 * Outstanding client→agent requests, keyed by JSON-RPC id.
 *
 * Split out so the dispatcher can be reused by a proxy: it owns id allocation,
 * response correlation and the "reject everything on shutdown" rule without
 * knowing anything about ACP methods.
 */

import type { JsonRpcId } from "./jsonrpc";

interface Entry {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export interface PendingRequest {
  readonly id: number;
  readonly method: string;
  readonly promise: Promise<unknown>;
}

export class PendingRequests {
  private nextId = 1;
  private readonly entries = new Map<string, Entry>();

  /** Allocate an id and register the promise before the frame is written. */
  create(method: string): PendingRequest {
    const id = this.nextId++;
    let resolve!: (value: unknown) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<unknown>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.entries.set(String(id), { method, resolve, reject });
    return { id, method, promise };
  }

  /** Remove a request; the caller settles the returned entry. */
  take(id: JsonRpcId): Entry | undefined {
    const key = String(id);
    const entry = this.entries.get(key);
    if (entry) this.entries.delete(key);
    return entry;
  }

  /** Drop a request that could not be written (so it is not left dangling). */
  discard(id: JsonRpcId): void {
    this.entries.delete(String(id));
  }

  /**
   * Reject every in-flight request with the same cancellation-class error.
   * Idempotent: after the first call the map is empty.
   */
  rejectAll(error: Error): void {
    const entries = [...this.entries.values()];
    this.entries.clear();
    for (const entry of entries) entry.reject(error);
  }

  get size(): number {
    return this.entries.size;
  }
}
