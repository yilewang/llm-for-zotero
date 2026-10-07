/**
 * One notice for "the chat list changed": a conversation was created,
 * renamed, deleted, or got new turns (which moves it in the list and changes
 * its activity time and turn count).
 *
 * The conversation stores (utils/chatStore.ts for the API, and the shared
 * runtime store behind Claude Code and Codex) announce their own writes, so
 * every writer is covered: either chat surface, the agent API, background
 * runtime turns. Readers announce nothing.
 *
 * Subscribers are the chat panels' history lists (each sidebar panel's
 * history header and menu, and through the standalone panel's history hook
 * the window's conversation list). Every change made in one turn of the event
 * loop reaches each subscriber as one batch, after that turn ends;
 * subscribers coalesce further (one re-render per panel).
 */

export type ConversationCatalogChangeReason =
  | "created"
  | "renamed"
  | "deleted"
  | "turns";

export type ConversationCatalogChange = {
  reason: ConversationCatalogChangeReason;
  /** The conversation that changed, when the writer knows it. */
  conversationKey: number | null;
};

type Listener = (changes: readonly ConversationCatalogChange[]) => void;

const listeners = new Set<Listener>();
let pending: ConversationCatalogChange[] = [];
let deliveryScheduled = false;

function deliver(): void {
  deliveryScheduled = false;
  const batch = pending;
  pending = [];
  if (!batch.length) return;
  for (const listener of [...listeners]) {
    try {
      listener(batch);
    } catch {
      // One failing list must not keep the others stale.
    }
  }
}

export function notifyConversationCatalogChanged(
  reason: ConversationCatalogChangeReason,
  conversationKey?: number | null,
): void {
  if (!listeners.size) return;
  const key = Number(conversationKey);
  pending.push({
    reason,
    conversationKey: Number.isFinite(key) && key > 0 ? Math.floor(key) : null,
  });
  if (deliveryScheduled) return;
  deliveryScheduled = true;
  void Promise.resolve().then(deliver);
}

export function subscribeConversationCatalogChanges(
  listener: Listener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
