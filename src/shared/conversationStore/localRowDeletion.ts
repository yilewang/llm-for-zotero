declare const Zotero: any;

import type { ConversationSystem } from "../types";
import {
  ConversationRetiredError,
  getConversationKeyLedgerEntry,
  isConversationKeyLedgerStoreInitialized,
  rememberConversationKeyRetired,
  retireConversationKeyInTransaction,
} from "../conversationKeyLedger";
import {
  deleteRegisteredConversationScopeInTransaction,
  initConversationRegistryStore,
} from "../conversationRegistry";
import {
  deleteConversationSearchIndexRowInTransaction,
  initConversationSearchIndexStore,
} from "../conversationSearchIndex";
import {
  deleteConversationForkLinksForInstanceInTransaction,
  initConversationForkLinksStore,
} from "../conversationForkLinks";
import {
  initRecentlyDeletedConversationTombstones,
  persistConversationInstanceTombstoneInTransaction,
} from "../../core/conversations/recentlyDeletedConversations";
import { deleteUsageEventsForConversationInTransaction } from "../../utils/usageStore";
import { clearOwnerAttachmentRefsInTransaction } from "../../utils/attachmentRefStore";
import { normalizeConversationKey } from "./keyNormalization";
import type { MessageConversationSelector } from "./messageConversationSelector";

/**
 * The deletion kernel every conversation store shares: the upstream store
 * (utils/chatStore.ts) and the runtime store (Claude Code, Codex).
 *
 * The three stores delete a conversation, and a turn of it, with the same
 * statements in the same order; only the table names, the store's name in an
 * error, and the store's own repair and refresh helpers differ.  A store
 * passes those as a `ConversationLocalRowStore`.  The SQL text is the text the
 * stores ran before the kernel, so a deletion runs the same statements.
 */
/** An agent purge that ran in the deletion transaction. */
export type ConversationAgentPurge = { rollback(): void };

export type ConversationLocalRowStore = {
  system: ConversationSystem;
  /** The store name in error messages ("upstream", "Claude", "Codex"). */
  storeLabel: string;
  messagesTable: string;
  isStoreConversationKey(conversationKey: number): boolean;
  repairRecoverableCatalogMessageConversationIDs(
    conversationKey: number,
  ): Promise<{ refused: number }>;
  resolveRepairingMessageConversationSelector(
    conversationKey: number,
    options: { destructive?: boolean },
  ): Promise<MessageConversationSelector>;
  /**
   * Deletes the agent rows of a conversation inside the deletion transaction.
   * Injected because the agent purge lives above this layer.  The returned
   * rollback undoes what the purge changed outside the database; the kernel
   * calls it when the deletion transaction fails.
   */
  clearAgentConversationRowsInTransaction(
    conversationKey: number,
  ): Promise<ConversationAgentPurge>;
  /** Refreshes the catalog summary inside the turn-deletion transaction. */
  refreshCatalogSummary(conversationKey: number): Promise<void>;
  /** Refreshes the search index after the turn-deletion transaction. */
  refreshSearchIndex(conversationKey: number): Promise<void>;
};

export type ConversationLocalRowDeletionIdentity = {
  instanceID?: string;
  conversationID?: string;
  onBeforeCommit?: () => Promise<void>;
  onCommit?: () => Promise<void>;
};

export async function preflightDeleteConversationLocalRows(
  store: ConversationLocalRowStore,
  conversationKey: number,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !store.isStoreConversationKey(normalizedKey)) return;
  const repair =
    await store.repairRecoverableCatalogMessageConversationIDs(normalizedKey);
  if (repair.refused > 0) {
    throw new Error(
      `Refused to delete ${store.storeLabel} conversation ${normalizedKey}: ambiguous stale message ids found.`,
    );
  }
  await store.resolveRepairingMessageConversationSelector(normalizedKey, {
    destructive: true,
  });
}

/**
 * Deletes every local row of one conversation in one transaction: messages,
 * agent rows, attachment refs, usage rows, the catalog row, fork links, the
 * registry scope, the search-index row, and retires the key.  `catalogTable`
 * names the catalog the conversation's row sits in (the upstream store has
 * two; a runtime store has one).
 */
export async function deleteConversationLocalRows(
  store: ConversationLocalRowStore,
  conversationKey: number,
  catalogTableFor: (normalizedKey: number) => string,
  identity?: ConversationLocalRowDeletionIdentity,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !store.isStoreConversationKey(normalizedKey)) return;
  let ledgerAvailable = isConversationKeyLedgerStoreInitialized();
  let ledgerEntry;
  if (ledgerAvailable) {
    try {
      ledgerEntry = await getConversationKeyLedgerEntry(normalizedKey);
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
      ledgerAvailable = false;
    }
  }
  if (ledgerAvailable && !ledgerEntry) {
    throw new ConversationRetiredError(
      normalizedKey,
      identity?.instanceID || "",
    );
  }
  if (
    ledgerEntry?.retiredAt &&
    identity?.instanceID !== ledgerEntry.instanceID
  ) {
    throw new ConversationRetiredError(
      normalizedKey,
      identity?.instanceID || "",
    );
  }
  if (
    ledgerEntry &&
    identity?.instanceID &&
    identity.instanceID !== ledgerEntry.instanceID
  ) {
    throw new Error(
      `Refused to delete ${store.storeLabel} conversation ${normalizedKey}: identity mismatch`,
    );
  }
  const deletionIdentity = ledgerEntry
    ? { ...(identity || {}), instanceID: ledgerEntry.instanceID }
    : identity;
  await preflightDeleteConversationLocalRows(store, normalizedKey);
  const catalogTable = catalogTableFor(normalizedKey);
  const selector = await store.resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  const catalogIdentityClause = deletionIdentity?.instanceID
    ? `AND conversation_instance_id = ?`
    : "";
  const catalogIdentityParams = deletionIdentity?.instanceID
    ? [deletionIdentity.instanceID]
    : [];
  const messageIdentityClause = deletionIdentity?.instanceID
    ? `AND EXISTS (
         SELECT 1
         FROM ${catalogTable} c
         WHERE c.conversation_key = ?
           AND c.conversation_instance_id = ?
       )`
    : "";
  const messageIdentityParams = deletionIdentity?.instanceID
    ? [normalizedKey, deletionIdentity.instanceID]
    : [];
  await initConversationForkLinksStore();
  await initConversationRegistryStore();
  await initConversationSearchIndexStore();
  await initRecentlyDeletedConversationTombstones();
  // The agent purge also marks the conversation's runs as deleted, outside
  // the database; a failed transaction must undo that mark with its rows.
  let agentPurge: ConversationAgentPurge | undefined;
  await Zotero.DB.executeTransaction(async () => {
    if (deletionIdentity?.instanceID) {
      const witnessRows = (await Zotero.DB.queryAsync(
        `SELECT 1 AS present
         FROM ${catalogTable}
         WHERE conversation_key = ?
           ${catalogIdentityClause}
         LIMIT 1`,
        [normalizedKey, ...catalogIdentityParams],
      )) as Array<{ present?: unknown }> | undefined;
      if (!witnessRows?.length) {
        throw new Error(
          `Refused to delete ${store.storeLabel} conversation ${normalizedKey}: catalog identity changed`,
        );
      }
    }
    await Zotero.DB.queryAsync(
      `DELETE FROM ${store.messagesTable}
       WHERE ${selector.whereSql}
         ${messageIdentityClause}
         ${deletionIdentity?.conversationID ? "AND conversation_id = ?" : ""}`,
      deletionIdentity?.conversationID
        ? [
            ...selector.params,
            ...messageIdentityParams,
            deletionIdentity.conversationID,
          ]
        : [...selector.params, ...messageIdentityParams],
    );
    agentPurge =
      await store.clearAgentConversationRowsInTransaction(normalizedKey);
    await clearOwnerAttachmentRefsInTransaction("conversation", normalizedKey);
    // A deleted conversation leaves no usage rows behind: the local usage
    // ledger is scoped to conversations the user can still see.
    await deleteUsageEventsForConversationInTransaction(normalizedKey);
    await Zotero.DB.queryAsync(
      `DELETE FROM ${catalogTable}
       WHERE conversation_key = ?
         ${catalogIdentityClause}`,
      [normalizedKey, ...catalogIdentityParams],
    );
    await deleteConversationForkLinksForInstanceInTransaction({
      conversationKey: normalizedKey,
      conversationID: deletionIdentity?.conversationID,
      system: store.system,
    });
    if (deletionIdentity?.instanceID) {
      await deleteRegisteredConversationScopeInTransaction(
        deletionIdentity.instanceID,
        normalizedKey,
        deletionIdentity.conversationID,
        store.system,
      );
    }
    if (deletionIdentity?.instanceID) {
      await persistConversationInstanceTombstoneInTransaction({
        conversationKey: normalizedKey,
        instanceID: deletionIdentity.instanceID,
        conversationID: deletionIdentity.conversationID,
      });
    }
    await deleteConversationSearchIndexRowInTransaction({
      system: store.system,
      conversationKey: normalizedKey,
    });
    if (ledgerAvailable && deletionIdentity?.instanceID) {
      await retireConversationKeyInTransaction({
        conversationKey: normalizedKey,
        instanceID: deletionIdentity.instanceID,
      });
    }
    await deletionIdentity?.onBeforeCommit?.();
    await deletionIdentity?.onCommit?.();
  }).catch((error: unknown) => {
    agentPurge?.rollback();
    throw error;
  });
  if (deletionIdentity?.instanceID) {
    rememberConversationKeyRetired(normalizedKey);
  }
}

/**
 * Deletes one turn (its user and assistant rows) by row id, or else by the
 * latest row of that role at the turn's timestamp, then refreshes the catalog
 * summary and drops the search-index row inside the same transaction.
 */
export async function deleteConversationTurnMessages(
  store: ConversationLocalRowStore,
  conversationKey: number,
  userTimestamp: number,
  assistantTimestamp: number,
  userMessageID?: number,
  assistantMessageID?: number,
  onBeforeCommit?: () => Promise<void>,
): Promise<void> {
  const normalizedKey = normalizeConversationKey(conversationKey);
  if (!normalizedKey || !store.isStoreConversationKey(normalizedKey)) return;
  const normalizedUserTimestamp = Number.isFinite(userTimestamp)
    ? Math.floor(userTimestamp)
    : 0;
  const normalizedAssistantTimestamp = Number.isFinite(assistantTimestamp)
    ? Math.floor(assistantTimestamp)
    : 0;
  if (normalizedUserTimestamp <= 0 || normalizedAssistantTimestamp <= 0) return;
  const normalizedUserMessageID =
    Number.isFinite(Number(userMessageID)) && Number(userMessageID) > 0
      ? Math.floor(Number(userMessageID))
      : 0;
  const normalizedAssistantMessageID =
    Number.isFinite(Number(assistantMessageID)) &&
    Number(assistantMessageID) > 0
      ? Math.floor(Number(assistantMessageID))
      : 0;

  const messagesTable = store.messagesTable;
  const selector = await store.resolveRepairingMessageConversationSelector(
    normalizedKey,
    {
      destructive: true,
    },
  );
  const searchIndexReady = await initConversationSearchIndexStore();
  await Zotero.DB.executeTransaction(async () => {
    if (normalizedUserMessageID > 0) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${messagesTable}
         WHERE id = ? AND ${selector.whereSql} AND role = 'user'`,
        [normalizedUserMessageID, ...selector.params],
      );
    } else {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${messagesTable}
         WHERE id = (
           SELECT id
           FROM ${messagesTable}
           WHERE ${selector.whereSql}
             AND role = 'user'
             AND timestamp = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
        [...selector.params, normalizedUserTimestamp],
      );
    }
    if (normalizedAssistantMessageID > 0) {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${messagesTable}
         WHERE id = ? AND ${selector.whereSql} AND role = 'assistant'`,
        [normalizedAssistantMessageID, ...selector.params],
      );
    } else {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${messagesTable}
         WHERE id = (
           SELECT id
           FROM ${messagesTable}
           WHERE ${selector.whereSql}
             AND role = 'assistant'
             AND timestamp = ?
           ORDER BY id DESC
           LIMIT 1
         )`,
        [...selector.params, normalizedAssistantTimestamp],
      );
    }
    await store.refreshCatalogSummary(normalizedKey);
    if (searchIndexReady) {
      await deleteConversationSearchIndexRowInTransaction({
        system: store.system,
        conversationKey: normalizedKey,
      });
    }
    await onBeforeCommit?.();
  });
  await store.refreshSearchIndex(normalizedKey);
}
