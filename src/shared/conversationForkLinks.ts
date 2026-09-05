declare const Zotero: any;

import type { ConversationSystem } from "./types";
import {
  getConversationKeyLedgerEntry,
  isConversationKeyLedgerStoreInitialized,
} from "./conversationKeyLedger";

export type ConversationForkScopeKind = "global" | "paper";

export type ConversationForkLink = {
  targetConversationKey: number;
  targetInstanceID?: string;
  targetConversationID?: string;
  targetSystem: ConversationSystem;
  targetKind: ConversationForkScopeKind;
  sourceConversationKey: number;
  sourceInstanceID?: string;
  sourceConversationID?: string;
  sourceSystem: ConversationSystem;
  sourceKind: ConversationForkScopeKind;
  sourceLibraryID: number;
  sourcePaperItemID?: number;
  sourceAssistantTimestamp: number;
  targetAnchorAssistantTimestamp: number;
  createdAt: number;
};

const CONVERSATION_FORK_LINKS_TABLE = "llm_for_zotero_conversation_fork_links";
const CONVERSATION_FORK_LINKS_SOURCE_INDEX =
  "llm_for_zotero_conversation_fork_links_source_idx";

let initPromise: Promise<void> | null = null;

function isAlreadyExistingColumnError(error: unknown): boolean {
  return /duplicate column|already exists/i.test(
    String(error instanceof Error ? error.message : error || ""),
  );
}

function normalizePositiveInt(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): ConversationForkScopeKind | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeLink(value: ConversationForkLink): ConversationForkLink {
  const targetConversationKey = normalizePositiveInt(
    value.targetConversationKey,
  );
  const targetSystem = normalizeSystem(value.targetSystem);
  const targetKind = normalizeKind(value.targetKind);
  const sourceConversationKey = normalizePositiveInt(
    value.sourceConversationKey,
  );
  const sourceSystem = normalizeSystem(value.sourceSystem);
  const sourceKind = normalizeKind(value.sourceKind);
  const sourceLibraryID = normalizePositiveInt(value.sourceLibraryID);
  const sourcePaperItemID = normalizePositiveInt(value.sourcePaperItemID);
  const sourceAssistantTimestamp = normalizePositiveInt(
    value.sourceAssistantTimestamp,
  );
  const targetAnchorAssistantTimestamp = normalizePositiveInt(
    value.targetAnchorAssistantTimestamp,
  );
  const createdAt = normalizePositiveInt(value.createdAt) || Date.now();

  if (
    !targetConversationKey ||
    !targetSystem ||
    !targetKind ||
    !sourceConversationKey ||
    !sourceSystem ||
    !sourceKind ||
    !sourceLibraryID ||
    !sourceAssistantTimestamp ||
    !targetAnchorAssistantTimestamp
  ) {
    throw new Error("Invalid conversation fork link");
  }
  if (sourceKind === "paper" && !sourcePaperItemID) {
    throw new Error("Invalid paper conversation fork link");
  }

  return {
    targetConversationKey,
    targetInstanceID: normalizeString(value.targetInstanceID),
    targetConversationID: normalizeString(value.targetConversationID),
    targetSystem,
    targetKind,
    sourceConversationKey,
    sourceInstanceID: normalizeString(value.sourceInstanceID),
    sourceConversationID: normalizeString(value.sourceConversationID),
    sourceSystem,
    sourceKind,
    sourceLibraryID,
    sourcePaperItemID: sourcePaperItemID || undefined,
    sourceAssistantTimestamp,
    targetAnchorAssistantTimestamp,
    createdAt,
  };
}

function rowToForkLink(row: Record<string, unknown> | undefined | null) {
  if (!row) return null;
  const targetSystem = normalizeSystem(row.targetSystem);
  const targetKind = normalizeKind(row.targetKind);
  const sourceSystem = normalizeSystem(row.sourceSystem);
  const sourceKind = normalizeKind(row.sourceKind);
  if (!targetSystem || !targetKind || !sourceSystem || !sourceKind) {
    return null;
  }
  const targetConversationKey = normalizePositiveInt(row.targetConversationKey);
  const sourceConversationKey = normalizePositiveInt(row.sourceConversationKey);
  const sourceLibraryID = normalizePositiveInt(row.sourceLibraryID);
  const sourceAssistantTimestamp = normalizePositiveInt(
    row.sourceAssistantTimestamp,
  );
  const targetAnchorAssistantTimestamp = normalizePositiveInt(
    row.targetAnchorAssistantTimestamp,
  );
  const createdAt = normalizePositiveInt(row.createdAt);
  if (
    !targetConversationKey ||
    !sourceConversationKey ||
    !sourceLibraryID ||
    !sourceAssistantTimestamp ||
    !targetAnchorAssistantTimestamp ||
    !createdAt
  ) {
    return null;
  }
  return {
    targetConversationKey,
    targetInstanceID: normalizeString(row.targetInstanceID),
    targetConversationID: normalizeString(row.targetConversationID),
    targetSystem,
    targetKind,
    sourceConversationKey,
    sourceInstanceID: normalizeString(row.sourceInstanceID),
    sourceConversationID: normalizeString(row.sourceConversationID),
    sourceSystem,
    sourceKind,
    sourceLibraryID,
    sourcePaperItemID: normalizePositiveInt(row.sourcePaperItemID) || undefined,
    sourceAssistantTimestamp,
    targetAnchorAssistantTimestamp,
    createdAt,
  } satisfies ConversationForkLink;
}

export async function initConversationForkLinksStore(): Promise<void> {
  if (initPromise) {
    await initPromise;
    return;
  }
  initPromise = Zotero.DB.executeTransaction(async () => {
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CONVERSATION_FORK_LINKS_TABLE} (
        target_conversation_key INTEGER PRIMARY KEY,
        target_instance_id TEXT,
        target_conversation_id TEXT,
        target_system TEXT NOT NULL,
        target_kind TEXT NOT NULL,
        source_conversation_key INTEGER NOT NULL,
        source_instance_id TEXT,
        source_conversation_id TEXT,
        source_system TEXT NOT NULL,
        source_kind TEXT NOT NULL,
        source_library_id INTEGER NOT NULL,
        source_paper_item_id INTEGER,
        source_assistant_timestamp INTEGER NOT NULL,
        target_anchor_assistant_timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    for (const definition of [
      "target_instance_id TEXT",
      "source_instance_id TEXT",
    ]) {
      try {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${CONVERSATION_FORK_LINKS_TABLE} ADD COLUMN ${definition}`,
        );
      } catch (error) {
        if (!isAlreadyExistingColumnError(error)) throw error;
        // Existing installations already have the column.
      }
    }
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS ${CONVERSATION_FORK_LINKS_SOURCE_INDEX}
       ON ${CONVERSATION_FORK_LINKS_TABLE}
         (source_system, source_conversation_key)`,
    );
  });
  try {
    await initPromise;
  } catch (error) {
    initPromise = null;
    throw error;
  }
}

export async function recordConversationForkLink(
  value: ConversationForkLink,
): Promise<ConversationForkLink> {
  const link = normalizeLink(value);
  await initConversationForkLinksStore();
  const ledgerInitialized = isConversationKeyLedgerStoreInitialized();
  const write = async (): Promise<void> => {
    for (const witness of [
      {
        key: link.targetConversationKey,
        instanceID: link.targetInstanceID,
        conversationID: link.targetConversationID,
        label: "target",
      },
      {
        key: link.sourceConversationKey,
        instanceID: link.sourceInstanceID,
        conversationID: link.sourceConversationID,
        label: "source",
      },
    ]) {
      if (!witness.instanceID) {
        if (!ledgerInitialized) continue;
        throw new Error(
          `Cannot record fork link: ${witness.label} identity witness is required`,
        );
      }
      const ledgerEntry = await getConversationKeyLedgerEntry(witness.key);
      if (!ledgerInitialized) continue;
      if (
        !ledgerEntry ||
        ledgerEntry.retiredAt ||
        ledgerEntry.instanceID !== witness.instanceID ||
        (witness.conversationID &&
          ledgerEntry.conversationID !== witness.conversationID)
      ) {
        throw new Error(
          `Cannot record fork link: ${witness.label} identity is not live`,
        );
      }
    }
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${CONVERSATION_FORK_LINKS_TABLE}
      (target_conversation_key,
       target_instance_id,
       target_conversation_id,
       target_system,
       target_kind,
       source_conversation_key,
       source_instance_id,
       source_conversation_id,
       source_system,
       source_kind,
       source_library_id,
       source_paper_item_id,
       source_assistant_timestamp,
       target_anchor_assistant_timestamp,
       created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        link.targetConversationKey,
        link.targetInstanceID || null,
        link.targetConversationID || null,
        link.targetSystem,
        link.targetKind,
        link.sourceConversationKey,
        link.sourceInstanceID || null,
        link.sourceConversationID || null,
        link.sourceSystem,
        link.sourceKind,
        link.sourceLibraryID,
        link.sourcePaperItemID || null,
        link.sourceAssistantTimestamp,
        link.targetAnchorAssistantTimestamp,
        link.createdAt,
      ],
    );
  };
  if (typeof Zotero.DB.executeTransaction === "function") {
    await Zotero.DB.executeTransaction(write);
  } else {
    await write();
  }
  return link;
}

export async function getConversationForkLink(
  targetConversationKey: number,
): Promise<ConversationForkLink | null> {
  const normalizedKey = normalizePositiveInt(targetConversationKey);
  if (!normalizedKey) return null;
  await initConversationForkLinksStore();
  const rows = (await Zotero.DB.queryAsync(
    `SELECT target_conversation_key AS targetConversationKey,
            target_instance_id AS targetInstanceID,
            target_conversation_id AS targetConversationID,
            target_system AS targetSystem,
            target_kind AS targetKind,
            source_conversation_key AS sourceConversationKey,
            source_instance_id AS sourceInstanceID,
            source_conversation_id AS sourceConversationID,
            source_system AS sourceSystem,
            source_kind AS sourceKind,
            source_library_id AS sourceLibraryID,
            source_paper_item_id AS sourcePaperItemID,
            source_assistant_timestamp AS sourceAssistantTimestamp,
            target_anchor_assistant_timestamp AS targetAnchorAssistantTimestamp,
            created_at AS createdAt
     FROM ${CONVERSATION_FORK_LINKS_TABLE}
     WHERE target_conversation_key = ?
     LIMIT 1`,
    [normalizedKey],
  )) as Record<string, unknown>[] | undefined;
  return rowToForkLink(rows?.[0]);
}

export async function deleteConversationForkLink(
  targetConversationKey: number,
): Promise<void> {
  const normalizedKey = normalizePositiveInt(targetConversationKey);
  if (!normalizedKey) return;
  await initConversationForkLinksStore();
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CONVERSATION_FORK_LINKS_TABLE}
     WHERE target_conversation_key = ?`,
    [normalizedKey],
  );
}

/** Remove provenance edges touching the deleted instance on either side. */
export async function deleteConversationForkLinksForInstance(params: {
  conversationKey: number;
  system: ConversationSystem;
  conversationID?: string;
}): Promise<void> {
  const normalizedKey = normalizePositiveInt(params.conversationKey);
  const conversationID = normalizeString(params.conversationID);
  if (!normalizedKey) return;
  await initConversationForkLinksStore();
  await deleteConversationForkLinksForInstanceInTransaction({
    ...params,
    conversationKey: normalizedKey,
    conversationID,
  });
}

/**
 * Delete provenance edges without opening a nested transaction.
 *
 * Callers that already own the Zotero DB transaction use this primitive so a
 * catalog/message failure rolls back the edge deletion as well.
 */
export async function deleteConversationForkLinksForInstanceInTransaction(params: {
  conversationKey: number;
  system: ConversationSystem;
  conversationID?: string;
}): Promise<void> {
  const normalizedKey = normalizePositiveInt(params.conversationKey);
  const conversationID = normalizeString(params.conversationID);
  if (!normalizedKey) return;
  const targetKeyClause = conversationID
    ? "(target_conversation_id = ? OR (target_conversation_id IS NULL AND target_system = ? AND target_conversation_key = ?))"
    : "(target_system = ? AND target_conversation_key = ?)";
  const sourceKeyClause = conversationID
    ? "(source_conversation_id = ? OR (source_conversation_id IS NULL AND source_system = ? AND source_conversation_key = ?))"
    : "(source_system = ? AND source_conversation_key = ?)";
  await Zotero.DB.queryAsync(
    `DELETE FROM ${CONVERSATION_FORK_LINKS_TABLE}
     WHERE ${targetKeyClause}
        OR ${sourceKeyClause}`,
    conversationID
      ? [
          conversationID,
          params.system,
          normalizedKey,
          conversationID,
          params.system,
          normalizedKey,
        ]
      : [params.system, normalizedKey, params.system, normalizedKey],
  );
}
