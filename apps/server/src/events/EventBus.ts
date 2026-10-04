/**
 * The simplest possible event bus (read.md §10). No Redis, no Kafka, no
 * queues, no database — just a set of subscribers.
 */
export class EventBus<T> {
  private subscribers = new Set<(event: T) => void>();

  emit(event: T): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }

  subscribe(fn: (event: T) => void): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }
}
