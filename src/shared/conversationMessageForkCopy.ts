declare const Zotero: any;

import {
  storedMessageDisplayOrderSql,
  storedMessageRoleOrderSql,
} from "./conversationMessageSql";
import {
  areConversationWritesFrozen,
  getConversationWriteGeneration,
  isConversationWriteGenerationCurrent,
} from "./conversationWriteFence";

export type ForkConversationMessagesResult = {
  copiedMessageCount: number;
  targetAnchorAssistantTimestamp: number;
};

export type ConversationMessageForkCopyConfig = {
  tableName: string;
  copyColumns: readonly string[];
  isValidConversationKey: (conversationKey: number) => boolean;
  resolveSourceSelector: (
    conversationKey: number,
  ) => Promise<{ whereSql: string; params: unknown[] }>;
  resolveTargetConversationID: (
    conversationKey: number,
  ) => Promise<string | null>;
  /** Immutable identity required by the catalog/message trigger when the
   * migrated schema is active. */
  resolveTargetInstanceID?: (conversationKey: number) => Promise<string | null>;
  assertSourceConversationLive?: (params: {
    conversationKey: number;
    instanceID?: string;
    conversationID?: string;
  }) => Promise<void>;
  refreshCatalogSummary: (conversationKey: number) => Promise<void>;
  refreshSearchIndex: (conversationKey: number) => Promise<void>;
  afterCopy?: (
    conversationKey: number,
    targetAnchorAssistantTimestamp: number,
  ) => Promise<void>;
};

type MessageCopyRow = Record<string, unknown>;

function normalizeConversationKey(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

function normalizeTimestamp(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

export function emptyForkConversationMessagesResult(): ForkConversationMessagesResult {
  return {
    copiedMessageCount: 0,
    targetAnchorAssistantTimestamp: 0,
  };
}

export async function copyConversationMessagesThroughAssistantAnchor(
  config: ConversationMessageForkCopyConfig,
  params: {
    sourceConversationKey: number;
    sourceInstanceID?: string;
    sourceConversationID?: string;
    targetConversationKey: number;
    throughAssistantTimestamp: number;
    timestampBase?: number;
  },
): Promise<ForkConversationMessagesResult> {
  const emptyResult = emptyForkConversationMessagesResult();
  const sourceKey = normalizeConversationKey(params.sourceConversationKey);
  const targetKey = normalizeConversationKey(params.targetConversationKey);
  if (
    !sourceKey ||
    !targetKey ||
    !config.isValidConversationKey(sourceKey) ||
    !config.isValidConversationKey(targetKey) ||
    sourceKey === targetKey
  ) {
    return emptyResult;
  }

  const throughAssistantTimestamp = normalizeTimestamp(
    params.throughAssistantTimestamp,
  );
  if (!throughAssistantTimestamp) return emptyResult;
  const sourceGeneration = getConversationWriteGeneration(sourceKey);
  if (areConversationWritesFrozen(sourceKey)) return emptyResult;

  const sourceSelector = await config.resolveSourceSelector(sourceKey);
  const anchorRows = (await Zotero.DB.queryAsync(
    `SELECT id, timestamp
     FROM ${config.tableName}
     WHERE ${sourceSelector.whereSql}
       AND role = 'assistant'
       AND timestamp = ?
     ORDER BY id DESC
     LIMIT 1`,
    [...sourceSelector.params, throughAssistantTimestamp],
  )) as Array<{ id?: unknown; timestamp?: unknown }> | undefined;
  const anchorRow = anchorRows?.[0];
  const anchorId = normalizeConversationKey(anchorRow?.id);
  const anchorTimestamp = normalizeTimestamp(anchorRow?.timestamp);
  if (!anchorId || !anchorTimestamp) return emptyResult;

  const roleOrderSql = storedMessageRoleOrderSql("role");
  const rows = (await Zotero.DB.queryAsync(
    `SELECT ${config.copyColumns.join(", ")}
     FROM ${config.tableName}
     WHERE ${sourceSelector.whereSql}
       AND (
         timestamp < ?
         OR (timestamp = ? AND ${roleOrderSql} < 1)
         OR (timestamp = ? AND ${roleOrderSql} = 1 AND id <= ?)
       )
     ORDER BY ${storedMessageDisplayOrderSql()}`,
    [
      ...sourceSelector.params,
      anchorTimestamp,
      anchorTimestamp,
      anchorTimestamp,
      anchorId,
    ],
  )) as MessageCopyRow[] | undefined;
  if (!rows?.length) return emptyResult;

  // Clear/deletion preserves the numeric key and ledger witness.  The source
  // generation is therefore the only boundary that distinguishes this
  // snapshot from content which was cleared while the SELECT was in flight.
  if (
    areConversationWritesFrozen(sourceKey) ||
    !isConversationWriteGenerationCurrent(sourceKey, sourceGeneration)
  ) {
    return emptyResult;
  }

  const targetConversationID =
    await config.resolveTargetConversationID(targetKey);
  if (!targetConversationID) return emptyResult;
  const targetInstanceID =
    (await config.resolveTargetInstanceID?.(targetKey)) || "";
  const timestampBase = normalizeTimestamp(params.timestampBase) || Date.now();
  const targetAnchorAssistantTimestamp = timestampBase + rows.length - 1;
  const insertColumns = [
    "conversation_id",
    "conversation_key",
    ...config.copyColumns,
    ...(targetInstanceID ? ["conversation_instance_id"] : []),
  ];
  const placeholders = insertColumns.map(() => "?").join(", ");

  await Zotero.DB.executeTransaction(async () => {
    if (
      areConversationWritesFrozen(sourceKey) ||
      !isConversationWriteGenerationCurrent(sourceKey, sourceGeneration)
    ) {
      throw new Error("Fork source conversation changed during copy");
    }
    await config.assertSourceConversationLive?.({
      conversationKey: sourceKey,
      instanceID: params.sourceInstanceID,
      conversationID: params.sourceConversationID,
    });
    for (const [index, row] of rows.entries()) {
      await Zotero.DB.queryAsync(
        `INSERT INTO ${config.tableName}
          (${insertColumns.join(", ")})
         VALUES (${placeholders})`,
        [
          targetConversationID,
          targetKey,
          ...config.copyColumns.map((column) =>
            column === "timestamp" ? timestampBase + index : row[column],
          ),
          ...(targetInstanceID ? [targetInstanceID] : []),
        ],
      );
    }
    await config.afterCopy?.(targetKey, targetAnchorAssistantTimestamp);
    await config.refreshCatalogSummary(targetKey);
  });
  await config.refreshSearchIndex(targetKey);
  return {
    copiedMessageCount: rows.length,
    targetAnchorAssistantTimestamp,
  };
}
