/** Minimal publish/subscribe bus used to decouple core state from the UI. */
export class EventBus {
  #handlers = new Map();

  on(type, handler) {
    if (!this.#handlers.has(type)) this.#handlers.set(type, new Set());
    this.#handlers.get(type).add(handler);
    return () => this.off(type, handler);
  }

  off(type, handler) {
    this.#handlers.get(type)?.delete(handler);
  }

  emit(type, detail) {
    this.#handlers.get(type)?.forEach((handler) => {
      try {
        handler(detail);
      } catch (err) {
        console.error(`[bus] handler for "${type}" failed`, err);
      }
    });
  }
}

export const bus = new EventBus();
