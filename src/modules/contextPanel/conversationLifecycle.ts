// Conversation lifecycle steps shared by the item panel's history controller
// and the standalone window. Each helper owns the part both surfaces must do
// identically; every per-surface guard stays an explicit option so the call
// site shows what that surface checks.

import type { ConversationSystem } from "../../shared/types";
import { conversationRepository } from "../../core/conversations/repository";
import { pendingDeletionStore } from "../../core/conversations/pendingDeletionStore";
import {
  hasConversationDeletionTombstoneForKey,
  isConversationInstanceRecentlyDeleted,
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
