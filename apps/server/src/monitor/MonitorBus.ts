import type { MonitorBus, MonitorEvent } from "@absence/core";

/**
 * The only junction between observers and the session/UI layers.
 *
 * A bus owns no interpretation: it forwards whatever a projector published.
 * Subscribing returns an unsubscribe function, and a listener is removed
 * safely even if it unsubscribes during delivery.
 */
export class InMemoryMonitorBus implements MonitorBus {
  private readonly listeners = new Set<(event: MonitorEvent) => void>();

  publish(event: MonitorEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  subscribe(listener: (event: MonitorEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

export function createMonitorBus(): MonitorBus {
  return new InMemoryMonitorBus();
}
