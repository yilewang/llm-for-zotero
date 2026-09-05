import { recordJournalObservation } from "../agent/store/changeJournal";
import { getActiveMutationActionId } from "./mutationActionContext";

export type ZoteroChangeEvent = Readonly<{
  event: string;
  type: string;
  ids: readonly (string | number)[];
  extraData: Readonly<Record<string, unknown>>;
  receivedAt: number;
}>;

export type ZoteroChangeListener = (
  change: ZoteroChangeEvent,
) => void | Promise<void>;

/**
 * One interpretation boundary for Zotero.Notifier events.
 *
 * Hooks only dispatch. Consumers subscribe here, so the library index and
 * journal audit see the same normalized event stream in the same order.
 */
export class ZoteroChangeDispatcher {
  private readonly listeners = new Map<string, ZoteroChangeListener>();
  private tail: Promise<void> = Promise.resolve();

  subscribe(id: string, listener: ZoteroChangeListener): () => void {
    this.listeners.set(id, listener);
    return () => {
      if (this.listeners.get(id) === listener) this.listeners.delete(id);
    };
  }

  dispatch(input: {
    event: string;
    type: string;
    ids?: Array<string | number>;
    extraData?: Record<string, unknown>;
  }): Promise<void> {
    const change: ZoteroChangeEvent = Object.freeze({
      event: String(input.event || ""),
      type: String(input.type || ""),
      ids: Object.freeze([...(input.ids || [])]),
      extraData: Object.freeze({ ...(input.extraData || {}) }),
      receivedAt: Date.now(),
    });
    const actionId = getActiveMutationActionId() || undefined;
    const run = async (): Promise<void> => {
      if (actionId) {
        await recordJournalObservation({
          actionId,
          event: change.event,
          objectType: change.type,
          objectIds: [...change.ids],
          extra: change.extraData,
          now: change.receivedAt,
        }).catch((error) => {
          globalThis.Zotero?.debug?.(
            `[llm-for-zotero] Could not persist notifier observation: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
      for (const listener of this.listeners.values()) {
        try {
          await listener(change);
        } catch (error) {
          globalThis.Zotero?.debug?.(
            `[llm-for-zotero] Change listener failed for ${change.type}:${change.event}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    };
    this.tail = this.tail.then(run, run);
    return this.tail;
  }

  async flush(): Promise<void> {
    await this.tail;
  }

  clearForTests(): void {
    this.listeners.clear();
    this.tail = Promise.resolve();
  }
}

export const zoteroChangeDispatcher = new ZoteroChangeDispatcher();
