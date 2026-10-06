// Conversation lifecycle steps shared by the item panel's history controller
// and the standalone window. Each helper owns the part both surfaces must do
// identically; every per-surface guard stays an explicit option so the call
// site shows what that surface checks.

import type { ConversationSystem } from "../../shared/types";
import { conversationRepository } from "../../core/conversations/repository";
import {
  pendingDeletionStore,
  type PendingConversationDeletionEntry,
  type PendingDeletionEvent,
} from "../../core/conversations/pendingDeletionStore";
import {
  hasConversationDeletionTombstoneForKey,
  isConversationInstanceRecentlyDeleted,
  markConversationInstanceRecentlyDeleted,
} from "../../core/conversations/recentlyDeletedConversations";
import {
  canCommitConversationRename,
  type ConversationRenameIdentity,
} from "./conversationRenameEligibility";

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

/**
 * Commit a title the user typed after the rename dialog closed. The row must
 * still be the same live conversation both before and after the catalog
 * read; the write carries the generation captured before the dialog, so a
 * deletion or a fresh write in between drops it. The panel-only guards are
 * options: the standalone window passes none of them today. Returns true once
 * the title write ran; a failed write throws to the caller.
 */
export async function commitConversationRename<Entry>(params: {
  target: ConversationRenameIdentity;
  title: string;
  expectedGeneration: number;
  findCurrentEntry: () => Entry | null | undefined;
  toIdentity: (entry: Entry) => ConversationRenameIdentity;
  /** Panel: the row itself is flagged as pending deletion. */
  isEntryPendingDelete?: (entry: Entry) => boolean;
  /** Panel: the row's source item was deleted. */
  isOrphan?: (entry: Entry) => boolean;
  /** Panel: a response is generating in the target conversation. */
  isRequestPending?: (conversationKey: number) => boolean;
  /** Panel: the panel still owns this operation after the catalog read. */
  isStillCurrent?: () => boolean;
}): Promise<boolean> {
  const { target } = params;
  const canCommit = (): boolean => {
    const currentEntry = params.findCurrentEntry();
    return canCommitConversationRename({
      target,
      current: currentEntry ? params.toIdentity(currentEntry) : null,
      pendingDelete:
        Boolean(currentEntry && params.isEntryPendingDelete?.(currentEntry)) ||
        pendingDeletionStore.isConversationPendingDeletion(
          target.conversationKey,
        ),
      orphan:
        currentEntry && params.isOrphan ? params.isOrphan(currentEntry) : false,
      requestPending: params.isRequestPending
        ? params.isRequestPending(target.conversationKey)
        : false,
    });
  };
  if (!canCommit()) return false;
  const summary = await conversationRepository.getCatalogEntry(target);
  if (params.isStillCurrent && !params.isStillCurrent()) return false;
  if (!summary || summary.kind !== target.kind || !canCommit()) return false;
  await conversationRepository.setCatalogTitle({
    ...target,
    expectedGeneration: params.expectedGeneration,
    title: params.title,
  });
  return true;
}

/** What the surface knows about the conversation it is about to delete. */
export type ConversationDeletionIntent = {
  conversationKind: "global" | "paper";
  /** Used only when the identity witness carries no conversation ID. */
  conversationID?: string;
  conversationKey: number;
  libraryID: number;
  system: ConversationSystem;
  paperItemID?: number;
  providerSessionId?: string;
  title: string;
  wasActive: boolean;
};

export type WitnessedConversationDeletionResult =
  | { status: "refused" }
  | { status: "failed" }
  | { status: "queued"; entry: PendingConversationDeletionEntry };

/**
 * Capture the catalog row's identity witness, then queue the durable deletion
 * intent with it. Keys are recycled, so the witness is the only value that
 * lets the finalizer prove it still deletes this conversation; a missing
 * witness is persisted as a durable intent and moves to identity quarantine
 * after the Undo window.
 *
 * finalCheck runs after the witness read. No await separates it from
 * queueConversationDeletion, which freezes writes synchronously at the
 * durable intent boundary. A surface without a final check passes none.
 */
export async function queueWitnessedConversationDeletion(params: {
  intent: ConversationDeletionIntent;
  finalCheck?: () => boolean;
}): Promise<WitnessedConversationDeletionResult> {
  const { intent } = params;
  const identityWitness =
    await conversationRepository.getCatalogIdentityWitness({
      system: intent.system,
      kind: intent.conversationKind,
      conversationKey: intent.conversationKey,
    });
  if (params.finalCheck && !params.finalCheck()) return { status: "refused" };
  const queued = await pendingDeletionStore.queueConversationDeletion({
    conversationKind: intent.conversationKind,
    instanceID: identityWitness?.instanceID || "",
    conversationID: identityWitness?.conversationID || intent.conversationID,
    catalogCreatedAt: identityWitness?.catalogCreatedAt || 0,
    conversationKey: intent.conversationKey,
    libraryID: intent.libraryID,
    system: intent.system,
    paperItemID: intent.paperItemID,
    providerSessionId: intent.providerSessionId,
    title: intent.title,
    wasActive: intent.wasActive,
  });
  return queued ? { status: "queued", entry: queued } : { status: "failed" };
}
