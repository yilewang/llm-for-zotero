export type AgentQueuedInput = {
  id: number;
  text: string;
  createdAt: number;
  status: "queued" | "sending";
};

export type QueueEnqueueResult =
  | { enqueued: true; id: number }
  | { enqueued: false; reason: "empty" };

export type AgentQueuedInputsController = {
  enqueue: (text: string) => QueueEnqueueResult;
  dequeue: () => AgentQueuedInput | undefined;
  takeNextForSend: () => AgentQueuedInput | undefined;
  remove: (id: number) => boolean;
  steerToFront: (id: number) => boolean;
  list: () => AgentQueuedInput[];
  size: () => number;
  clear: () => void;
};

export function createAgentQueuedInputsController(): AgentQueuedInputsController {
  const queue: AgentQueuedInput[] = [];
  let nextId = 1;

  return {
    enqueue(text: string): QueueEnqueueResult {
      const normalized = text.trim();
      if (!normalized) {
        return { enqueued: false, reason: "empty" };
      }
      const entry: AgentQueuedInput = {
        id: nextId++,
        text: normalized,
        createdAt: Date.now(),
        status: "queued",
      };
      queue.push(entry);
      return { enqueued: true, id: entry.id };
    },

    dequeue(): AgentQueuedInput | undefined {
      return queue.shift();
    },

    takeNextForSend(): AgentQueuedInput | undefined {
      const next = queue.find((entry) => entry.status === "queued");
      if (!next) return undefined;
      next.status = "sending";
      return next;
    },

    remove(id: number): boolean {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      queue.splice(index, 1);
      return true;
    },

    steerToFront(id: number): boolean {
      const index = queue.findIndex((entry) => entry.id === id);
      if (index < 0) return false;
      if (index === 0) return true;
      const [entry] = queue.splice(index, 1);
      if (!entry) return false;
      queue.unshift(entry);
      return true;
    },

    list(): AgentQueuedInput[] {
      return queue.slice();
    },

    size(): number {
      return queue.length;
    },

    clear(): void {
      queue.length = 0;
    },
  };
}
