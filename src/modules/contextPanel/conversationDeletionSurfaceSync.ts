import type { ConversationSystem } from "../../shared/types";
import type { PendingDeletionEvent } from "../../core/conversations/pendingDeletionStore";

export type ConversationDeletionSurfaceSnapshot = {
  conversationKey: number;
  instanceID?: string;
  kind: "global" | "paper";
  system: ConversationSystem;
};

export type ConversationDeletionSurfaceEntry = {
  conversationKey: number;
  instanceID?: string;
  conversationKind: "global" | "paper";
  system: ConversationSystem;
  // Recorded on the persisted entry for the queueing surface's own bookkeeping;
  // deliberately NOT an input to the decision below, which keys off this
  // surface's own `surrendered` state.
  wasActive?: boolean;
};

export type ConversationDeletionSurfaceAction =
  | { type: "none" }
  | { type: "leave"; remember: boolean }
  | { type: "restore" }
  | { type: "forget" };

// Surface reactions can await fresh-chat creation or history navigation. Keep
// each mounted surface's event reactions in notification order so a quick Undo
// cannot run before the queued deletion has recorded that the surface left.
export function createSerializedConversationDeletionEventQueue(): (
  task: () => Promise<void>,
) => Promise<void> {
  let chain: Promise<void> = Promise.resolve();
  return (task) => {
    const next = chain.then(task);
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * What one mounted surface (panel or standalone window) must do about a
 * conversation-deletion event. Every surface subscribes to the same store, so
 * this decision has to be made per surface rather than per deletion:
 *   - a surface showing the doomed chat leaves it, whoever queued the deletion;
 *   - only the surface that surrendered a chat goes back to it when the
 *     deletion is undone or abandoned — others keep their own place.
 */
export function resolveConversationDeletionSurfaceAction(params: {
  eventType: PendingDeletionEvent["type"];
  entry: ConversationDeletionSurfaceEntry;
  surface: ConversationDeletionSurfaceSnapshot | null;
  surrendered: boolean;
  // A "finalized" event whose intent was DROPPED (stale, or persisted without
  // an identity witness) means the conversation still exists. Treating it as a
  // deletion would evict the user from a live chat, so it resolves like the
  // other survival outcomes.
  dropped?: boolean;
}): ConversationDeletionSurfaceAction {
  const { entry, surface, surrendered } = params;
  // A quarantined or retrying intent remains hidden. There is no automatic
  // survival/restore outcome after the Undo window; only an explicit `undone`
  // event can return a surface to the conversation.
  const eventType = params.eventType;
  const showsEntry = Boolean(
    surface &&
    surface.conversationKey === entry.conversationKey &&
    (!entry.instanceID || surface.instanceID === entry.instanceID) &&
    surface.kind === entry.conversationKind &&
    surface.system === entry.system,
  );
  // Older persisted rows can still emit a compatibility "dropped" outcome.
  // It is not a deletion: keep a live surface in place, and return only a
  // surface that was explicitly moved off the conversation while the intent
  // was being evaluated. New coordinator paths never emit this outcome.
  if (params.dropped) {
    if (surrendered && !showsEntry) return { type: "restore" };
    return { type: "none" };
  }
  if (
    eventType === "queued" ||
    eventType === "committing" ||
    eventType === "quarantined" ||
    eventType === "finalize-failed"
  ) {
    return showsEntry ? { type: "leave", remember: true } : { type: "none" };
  }
  if (
    eventType === "local-deleted" ||
    eventType === "cleanup-pending" ||
    eventType === "completed" ||
    eventType === "finalized"
  ) {
    // The chat is gone for good: leave, but there is nothing to return to.
    if (showsEntry) return { type: "leave", remember: false };
    return surrendered ? { type: "forget" } : { type: "none" };
  }
  // "undone": the chat survived after explicit Undo. The gate is
  // `surrendered` — a property of THIS surface — not entry.wasActive, which
  // describes the surface that QUEUED the deletion. A surface that stepped off
  // the chat in reaction to someone else's deletion (the deleter had it
  // inactive, so wasActive is false) must still be taken back; gating on
  // wasActive stranded it on the blank chat it was pushed onto.
  if (surrendered && !showsEntry) return { type: "restore" };
  return surrendered ? { type: "forget" } : { type: "none" };
}
