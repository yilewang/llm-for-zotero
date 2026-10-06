// Conversation lifecycle steps shared by the item panel's history controller
// and the standalone window. Each helper owns the part both surfaces must do
// identically; every per-surface guard stays an explicit option so the call
// site shows what that surface checks.

import type { ConversationSystem } from "../../shared/types";
import { conversationRepository } from "../../core/conversations/repository";
import {
  pendingDeletionStore,
  type PendingDeletionEvent,
} from "../../core/conversations/pendingDeletionStore";
import {
  hasConversationDeletionTombstoneForKey,
  isConversationInstanceRecentlyDeleted,
  markConversationInstanceRecentlyDeleted,
} from "../../core/conversations/recentlyDeletedConversations";

export type ConversationSeedTarget = {
  system: ConversationSystem;
  conversationKey: number;
  kind: "global" | "paper";
  libraryID?: number;
  paperItemID?: number;
};

/**
 * Ambient "keep the mounted conversation listed" seeding must never bring back
 * a conversation queued for deletion, an instance whose deletion just
 * committed, or a witnessless key that a durable tombstone retired. Deliberate
 * navigation calls ensureCatalogEntry directly and does not ask this.
 */
export async function shouldSeedConversationCatalogEntry(
  target: ConversationSeedTarget,
): Promise<boolean> {
  if (
    pendingDeletionStore.isConversationPendingDeletion(target.conversationKey)
  ) {
    return false;
  }
  const identityWitness =
    await conversationRepository.getCatalogIdentityWitness(target);
  if (
    identityWitness?.instanceID &&
    isConversationInstanceRecentlyDeleted(
      target.conversationKey,
      identityWitness.instanceID,
    )
  ) {
    return false;
  }
  if (
    !identityWitness &&
    (await hasConversationDeletionTombstoneForKey(target.conversationKey))
  ) {
    return false;
  }
  return true;
}

/**
 * The store drops a conversation's entry before it notifies, so this
 * tombstone is the only thing that keeps the seeding paths from bringing the
 * deleted key back. Only a REAL deletion tombstones the key: a dropped intent
 * leaves the conversation alive and it must stay seedable. Each surface calls
 * this at its own point in its event handling. Returns true when it marked.
 */
export function markCommittedConversationDeletionTombstone(
  event: PendingDeletionEvent,
): boolean {
  const entry = event.entry;
  if (entry.kind !== "conversation") return false;
  if (
    (event.type === "completed" || event.type === "finalized") &&
    !event.dropped &&
    entry.instanceID
  ) {
    markConversationInstanceRecentlyDeleted(
      entry.conversationKey,
      entry.instanceID,
      Date.now(),
      entry.identityDigest,
    );
    return true;
  }
  return false;
}
