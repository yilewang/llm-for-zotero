import {
  decodeDocumentActionState,
  decodeDocumentCoverageItem,
  decodePlanDocument,
  decodePlanDocumentOutbox,
} from "./decoders";
import type {
  DocumentActionState,
  DocumentCoverageItem,
  PlanDocument,
  PlanDocumentOutboxRecord,
} from "./types";
import { getPlannedDocumentOrigin } from "./types";
import {
  PLAN_DOCUMENT_GLOBAL_ASSETS_MAX_BYTES,
  type PlanDocumentAsset,
} from "./types";
import { sha256Bytes } from "../store/journalRecoveryBlobStore";
import { getZoteroAgentRuntimeRootDir } from "../skills/nativeSkillPaths";
import { joinLocalPath } from "../../utils/localPath";

export const PLAN_DOCUMENTS_TABLE = "llm_for_zotero_plan_documents";
export const PLAN_DOCUMENT_COVERAGE_TABLE =
  "llm_for_zotero_plan_document_coverage";
export const PLAN_DOCUMENT_ACTION_STATE_TABLE =
  "llm_for_zotero_plan_document_action_state";
export const PLAN_DOCUMENT_OUTBOX_TABLE = "llm_for_zotero_plan_document_outbox";
export const PLAN_DOCUMENT_OWNERS_TABLE = "llm_for_zotero_plan_document_owners";
export const PLAN_DOCUMENT_ASSETS_TABLE = "llm_for_zotero_plan_document_assets";
export const PLAN_DOCUMENT_ASSET_REFS_TABLE =
  "llm_for_zotero_plan_document_asset_refs";
export const PLAN_DOCUMENT_ASSET_CLEANUP_TABLE =
  "llm_for_zotero_plan_document_asset_cleanup";

type JsonRow = { payloadJson?: unknown };

async function createDocumentsTable(tableName: string): Promise<void> {
  await Zotero.DB.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${tableName} (
      document_id TEXT PRIMARY KEY,
      origin_kind TEXT NOT NULL,
      plan_id TEXT,
      plan_revision INTEGER,
      execution_id TEXT,
      run_id TEXT,
      conversation_key INTEGER NOT NULL,
      parent_task_id TEXT,
      content_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`,
  );
}

async function migrateDocumentsTableV2(): Promise<void> {
  const columns = (await Zotero.DB.queryAsync(
    `PRAGMA table_info(${PLAN_DOCUMENTS_TABLE})`,
  )) as Array<{ name?: unknown }> | undefined;
  if ((columns || []).some((column) => column.name === "origin_kind")) return;
  const legacyTable = `${PLAN_DOCUMENTS_TABLE}_v1_migration`;
  await Zotero.DB.queryAsync(
    `ALTER TABLE ${PLAN_DOCUMENTS_TABLE} RENAME TO ${legacyTable}`,
  );
  await createDocumentsTable(PLAN_DOCUMENTS_TABLE);
  await Zotero.DB.queryAsync(
    `INSERT INTO ${PLAN_DOCUMENTS_TABLE}
      (document_id, origin_kind, plan_id, plan_revision, execution_id, run_id,
       conversation_key, parent_task_id, content_hash, payload_json, created_at)
     SELECT document_id, 'planned', plan_id, plan_revision, execution_id, NULL,
            conversation_key, parent_task_id, content_hash, payload_json, created_at
     FROM ${legacyTable}`,
  );
  await Zotero.DB.queryAsync(`DROP TABLE ${legacyTable}`);
}

function parse<T>(
  row: JsonRow | undefined,
  decoder: (value: unknown) => T,
): T | null {
  if (typeof row?.payloadJson !== "string") return null;
  return decoder(JSON.parse(row.payloadJson));
}

export async function initPlanDocumentStore(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    await createDocumentsTable(PLAN_DOCUMENTS_TABLE);
    await migrateDocumentsTableV2();
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_documents_conversation_idx
       ON ${PLAN_DOCUMENTS_TABLE} (conversation_key, created_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_documents_execution_idx
       ON ${PLAN_DOCUMENTS_TABLE} (execution_id, created_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_documents_run_idx
       ON ${PLAN_DOCUMENTS_TABLE} (run_id, created_at DESC)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_COVERAGE_TABLE} (
        document_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        library_id INTEGER NOT NULL,
        item_key TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        PRIMARY KEY (document_id, library_id, item_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_document_coverage_status_idx
       ON ${PLAN_DOCUMENT_COVERAGE_TABLE} (document_id, status, ordinal)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_ACTION_STATE_TABLE} (
        document_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_OUTBOX_TABLE} (
        outbox_id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL UNIQUE,
        conversation_key INTEGER NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_document_outbox_status_idx
       ON ${PLAN_DOCUMENT_OUTBOX_TABLE} (status, updated_at)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_OWNERS_TABLE} (
        document_id TEXT NOT NULL,
        conversation_key INTEGER NOT NULL,
        source_message_timestamp INTEGER NOT NULL,
        PRIMARY KEY (document_id, conversation_key)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_ASSETS_TABLE} (
        content_hash TEXT PRIMARY KEY,
        durable_path TEXT NOT NULL UNIQUE,
        byte_length INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_ASSET_REFS_TABLE} (
        document_id TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        asset_id TEXT NOT NULL,
        PRIMARY KEY (document_id, asset_id)
      )`,
    );
    await Zotero.DB.queryAsync(
      `CREATE INDEX IF NOT EXISTS llm_plan_document_asset_refs_hash_idx
       ON ${PLAN_DOCUMENT_ASSET_REFS_TABLE} (content_hash)`,
    );
    await Zotero.DB.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${PLAN_DOCUMENT_ASSET_CLEANUP_TABLE} (
        durable_path TEXT PRIMARY KEY,
        queued_at INTEGER NOT NULL
      )`,
    );
  });
  await sweepPlanDocumentStorage();
}

function documentAssetDirectory(): string {
  return joinLocalPath(getZoteroAgentRuntimeRootDir(), "plan-document-assets");
}

function assetExtension(mimeType: string): string {
  return (
    (
      {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
      } as Record<string, string>
    )[mimeType.toLowerCase()] || "bin"
  );
}

export async function materializePlanDocumentAssets(
  assets: readonly PlanDocumentAsset[],
): Promise<PlanDocumentAsset[]> {
  if (!assets.length) return [];
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (
    typeof io?.read !== "function" ||
    typeof io?.write !== "function" ||
    typeof io?.makeDirectory !== "function"
  ) {
    throw new Error("Durable document asset storage is unavailable");
  }
  const sizeRows = (await Zotero.DB.queryAsync(
    `SELECT COALESCE(SUM(byte_length), 0) AS totalBytes
     FROM ${PLAN_DOCUMENT_ASSETS_TABLE}`,
  )) as Array<{ totalBytes?: unknown }> | undefined;
  let totalBytes = Math.max(0, Number(sizeRows?.[0]?.totalBytes || 0));
  const directory = documentAssetDirectory();
  await io.makeDirectory(directory, {
    createAncestors: true,
    ignoreExisting: true,
  });
  const output: PlanDocumentAsset[] = [];
  for (const asset of assets) {
    const expected = asset.contentHash.replace(/^sha256:/, "").toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(expected)) {
      throw new Error(
        `Document asset ${asset.assetId} has an invalid SHA-256 hash`,
      );
    }
    const existingRows = (await Zotero.DB.queryAsync(
      `SELECT durable_path AS durablePath, byte_length AS byteLength
       FROM ${PLAN_DOCUMENT_ASSETS_TABLE} WHERE content_hash = ? LIMIT 1`,
      [`sha256:${expected}`],
    )) as Array<{ durablePath?: unknown; byteLength?: unknown }> | undefined;
    const existingPath =
      typeof existingRows?.[0]?.durablePath === "string"
        ? existingRows[0].durablePath
        : "";
    if (existingPath) {
      if (Number(existingRows?.[0]?.byteLength) !== asset.byteLength) {
        throw new Error(
          `Document asset ${asset.assetId} hash has conflicting size`,
        );
      }
      output.push({ ...asset, durablePath: existingPath });
      continue;
    }
    const source = await io.read(asset.durablePath);
    const bytes =
      source instanceof Uint8Array ? source : new Uint8Array(source);
    if (bytes.byteLength !== asset.byteLength) {
      throw new Error(
        `Document asset ${asset.assetId} size changed before finalization`,
      );
    }
    const actual = await sha256Bytes(bytes);
    if (actual !== expected) {
      throw new Error(
        `Document asset ${asset.assetId} failed SHA-256 validation`,
      );
    }
    if (totalBytes + bytes.byteLength > PLAN_DOCUMENT_GLOBAL_ASSETS_MAX_BYTES) {
      throw new Error(
        "Global plan-document assets exceed the 1 GiB safety quota",
      );
    }
    const durablePath = joinLocalPath(
      directory,
      `${expected}.${assetExtension(asset.mimeType)}`,
    );
    await io.write(durablePath, bytes, { tmpPath: `${durablePath}.tmp` });
    totalBytes += bytes.byteLength;
    output.push({ ...asset, contentHash: `sha256:${expected}`, durablePath });
  }
  return output;
}

export async function savePlanDocumentInTransaction(params: {
  document: PlanDocument;
  outbox: PlanDocumentOutboxRecord;
}): Promise<void> {
  const document = decodePlanDocument(params.document);
  const outbox = decodePlanDocumentOutbox(params.outbox);
  const storedDocument = { ...document, coverageItems: [] };
  const planned = getPlannedDocumentOrigin(document);
  const direct =
    document.version === 2 && document.origin.kind === "direct"
      ? document.origin
      : undefined;
  await Zotero.DB.queryAsync(
    `INSERT INTO ${PLAN_DOCUMENTS_TABLE}
     (document_id, origin_kind, plan_id, plan_revision, execution_id, run_id,
      conversation_key, parent_task_id, content_hash, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      document.documentId,
      planned ? "planned" : "direct",
      planned?.planId || null,
      planned?.planRevision ?? null,
      planned?.executionId || null,
      direct?.runId || null,
      document.conversationKey,
      planned?.parentTaskId || null,
      document.contentHash,
      JSON.stringify(storedDocument),
      document.createdAt,
    ],
  );
  for (let ordinal = 0; ordinal < document.coverageItems.length; ordinal += 1) {
    const item = document.coverageItems[ordinal];
    await Zotero.DB.queryAsync(
      `INSERT INTO ${PLAN_DOCUMENT_COVERAGE_TABLE}
       (document_id, ordinal, library_id, item_key, status, payload_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        document.documentId,
        ordinal,
        item.libraryID,
        item.itemKey,
        item.status,
        JSON.stringify(item),
      ],
    );
  }
  for (const asset of document.assets) {
    await Zotero.DB.queryAsync(
      `INSERT OR IGNORE INTO ${PLAN_DOCUMENT_ASSETS_TABLE}
       (content_hash, durable_path, byte_length, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [
        asset.contentHash,
        asset.durablePath,
        asset.byteLength,
        JSON.stringify(asset),
        document.createdAt,
      ],
    );
    await Zotero.DB.queryAsync(
      `INSERT INTO ${PLAN_DOCUMENT_ASSET_REFS_TABLE}
       (document_id, content_hash, asset_id) VALUES (?, ?, ?)`,
      [document.documentId, asset.contentHash, asset.assetId],
    );
  }
  await Zotero.DB.queryAsync(
    `INSERT INTO ${PLAN_DOCUMENT_OWNERS_TABLE}
     (document_id, conversation_key, source_message_timestamp)
     VALUES (?, ?, ?)`,
    [document.documentId, document.conversationKey, outbox.messageTimestamp],
  );
  await Zotero.DB.queryAsync(
    `INSERT INTO ${PLAN_DOCUMENT_OUTBOX_TABLE}
     (outbox_id, document_id, conversation_key, status, payload_json,
      created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      outbox.outboxId,
      outbox.documentId,
      outbox.conversationKey,
      outbox.status,
      JSON.stringify(outbox),
      outbox.createdAt,
      outbox.updatedAt,
    ],
  );
}

async function loadCoverageItems(
  documentId: string,
): Promise<DocumentCoverageItem[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_DOCUMENT_COVERAGE_TABLE}
     WHERE document_id = ? ORDER BY ordinal ASC`,
    [documentId],
  )) as JsonRow[] | undefined;
  return (rows || []).map((row) => {
    if (typeof row.payloadJson !== "string") {
      throw new Error("Document coverage row has no payload");
    }
    return decodeDocumentCoverageItem(JSON.parse(row.payloadJson));
  });
}

export async function loadPlanDocument(
  documentId: string,
): Promise<PlanDocument | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_DOCUMENTS_TABLE}
     WHERE document_id = ? LIMIT 1`,
    [documentId],
  )) as JsonRow[] | undefined;
  const document = parse(rows?.[0], decodePlanDocument);
  if (!document) return null;
  return { ...document, coverageItems: await loadCoverageItems(documentId) };
}

export async function loadLatestPlanDocumentForExecution(
  executionId: string,
): Promise<PlanDocument | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT document_id AS documentId FROM ${PLAN_DOCUMENTS_TABLE}
     WHERE execution_id = ? ORDER BY created_at DESC LIMIT 1`,
    [executionId],
  )) as Array<{ documentId?: unknown }> | undefined;
  const documentId =
    typeof rows?.[0]?.documentId === "string" ? rows[0].documentId : "";
  return documentId ? loadPlanDocument(documentId) : null;
}

export async function loadLatestDocumentForRun(
  runId: string,
): Promise<PlanDocument | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT document_id AS documentId FROM ${PLAN_DOCUMENTS_TABLE}
     WHERE run_id = ? ORDER BY created_at DESC LIMIT 1`,
    [runId],
  )) as Array<{ documentId?: unknown }> | undefined;
  const documentId =
    typeof rows?.[0]?.documentId === "string" ? rows[0].documentId : "";
  return documentId ? loadPlanDocument(documentId) : null;
}

export async function nextPlanDocumentVersion(params: {
  planId: string;
  planRevision: number;
}): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS maxVersion
     FROM ${PLAN_DOCUMENTS_TABLE}
     WHERE plan_id = ? AND plan_revision = ?`,
    [params.planId, params.planRevision],
  )) as Array<{ maxVersion?: unknown }>;
  return Math.max(0, Number(rows?.[0]?.maxVersion || 0)) + 1;
}

export async function loadPlanDocumentOutbox(
  documentId: string,
): Promise<PlanDocumentOutboxRecord | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_DOCUMENT_OUTBOX_TABLE}
     WHERE document_id = ? LIMIT 1`,
    [documentId],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodePlanDocumentOutbox);
}

export async function listPendingPlanDocumentOutbox(
  conversationKey: number,
): Promise<PlanDocumentOutboxRecord[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_DOCUMENT_OUTBOX_TABLE}
     WHERE conversation_key = ? AND status = 'pending'
     ORDER BY created_at ASC`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodePlanDocumentOutbox))
    .filter((entry): entry is PlanDocumentOutboxRecord => Boolean(entry));
}

export async function listPlanDocumentOutboxForConversation(
  conversationKey: number,
): Promise<PlanDocumentOutboxRecord[]> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson FROM ${PLAN_DOCUMENT_OUTBOX_TABLE}
     WHERE conversation_key = ? ORDER BY created_at DESC`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as JsonRow[] | undefined;
  return (rows || [])
    .map((row) => parse(row, decodePlanDocumentOutbox))
    .filter((entry): entry is PlanDocumentOutboxRecord => Boolean(entry));
}

export async function markPlanDocumentDelivered(params: {
  documentId: string;
  deliveredAt?: number;
  messageTimestamp?: number;
}): Promise<PlanDocumentOutboxRecord | null> {
  const existing = await loadPlanDocumentOutbox(params.documentId);
  if (!existing) return null;
  if (existing.status === "delivered") return existing;
  const deliveredAt = params.deliveredAt ?? Date.now();
  const updated: PlanDocumentOutboxRecord = {
    ...existing,
    messageTimestamp: Number.isFinite(params.messageTimestamp)
      ? Math.floor(Number(params.messageTimestamp))
      : existing.messageTimestamp,
    status: "delivered",
    attemptCount: existing.attemptCount + 1,
    lastError: undefined,
    deliveredAt,
    updatedAt: deliveredAt,
  };
  await Zotero.DB.queryAsync(
    `UPDATE ${PLAN_DOCUMENT_OUTBOX_TABLE}
     SET status = ?, payload_json = ?, updated_at = ? WHERE document_id = ?`,
    [
      updated.status,
      JSON.stringify(updated),
      updated.updatedAt,
      params.documentId,
    ],
  );
  if (Number.isFinite(params.messageTimestamp)) {
    await Zotero.DB.queryAsync(
      `UPDATE ${PLAN_DOCUMENT_OWNERS_TABLE}
       SET source_message_timestamp = ?
       WHERE document_id = ? AND conversation_key = ?`,
      [
        Math.floor(Number(params.messageTimestamp)),
        existing.documentId,
        existing.conversationKey,
      ],
    );
  }
  return updated;
}

/** Merge an action's fields with current state in a short, database-only transaction. */
export async function updateDocumentActionState(
  documentId: string,
  update: (current: DocumentActionState) => DocumentActionState,
): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    const current = (await loadDocumentActionState(documentId)) || {
      version: 1 as const,
      documentId,
      updatedAt: Date.now(),
    };
    const next = decodeDocumentActionState(update(current));
    if (next.documentId !== documentId)
      throw new Error(
        "A document action update cannot change its document identity.",
      );
    await Zotero.DB.queryAsync(
      `INSERT OR REPLACE INTO ${PLAN_DOCUMENT_ACTION_STATE_TABLE}
       (document_id, payload_json, updated_at) VALUES (?, ?, ?)`,
      [documentId, JSON.stringify(next), next.updatedAt],
    );
  });
}

export async function loadDocumentActionState(
  documentId: string,
): Promise<DocumentActionState | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT payload_json AS payloadJson
     FROM ${PLAN_DOCUMENT_ACTION_STATE_TABLE}
     WHERE document_id = ? LIMIT 1`,
    [documentId],
  )) as JsonRow[] | undefined;
  return parse(rows?.[0], decodeDocumentActionState);
}

export async function addPlanDocumentOwner(params: {
  documentId: string;
  conversationKey: number;
  sourceMessageTimestamp: number;
}): Promise<void> {
  await Zotero.DB.queryAsync(
    `INSERT OR IGNORE INTO ${PLAN_DOCUMENT_OWNERS_TABLE}
     (document_id, conversation_key, source_message_timestamp)
     VALUES (?, ?, ?)`,
    [params.documentId, params.conversationKey, params.sourceMessageTimestamp],
  );
}

export async function loadDocumentIdForMessageOwner(params: {
  conversationKey: number;
  sourceMessageTimestamp: number;
}): Promise<string | null> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT document_id AS documentId
     FROM ${PLAN_DOCUMENT_OWNERS_TABLE}
     WHERE conversation_key = ? AND source_message_timestamp = ?
     ORDER BY document_id DESC LIMIT 1`,
    [params.conversationKey, params.sourceMessageTimestamp],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ documentId?: unknown }> | undefined;
  const documentId = rows?.[0]?.documentId;
  return typeof documentId === "string" && documentId.trim()
    ? documentId.trim()
    : null;
}

export async function copyPlanDocumentOwnersForFork(params: {
  sourceConversationKey: number;
  targetConversationKey: number;
  throughAssistantTimestamp: number;
  sourceAssistantTimestamps: readonly number[];
  targetAssistantTimestamps: readonly number[];
}): Promise<number> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT owners.document_id AS documentId,
            owners.source_message_timestamp AS sourceMessageTimestamp
     FROM ${PLAN_DOCUMENT_OWNERS_TABLE} owners
     JOIN ${PLAN_DOCUMENT_OUTBOX_TABLE} outbox
       ON outbox.document_id = owners.document_id
     WHERE owners.conversation_key = ?
       AND owners.source_message_timestamp <= ?
       AND outbox.status = 'delivered'
     ORDER BY owners.source_message_timestamp ASC`,
    [params.sourceConversationKey, params.throughAssistantTimestamp],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{
    documentId?: unknown;
    sourceMessageTimestamp?: unknown;
  }>;
  let copied = 0;
  for (const row of rows) {
    const documentId = typeof row.documentId === "string" ? row.documentId : "";
    const sourceTimestamp = Number(row.sourceMessageTimestamp);
    const index = params.sourceAssistantTimestamps.indexOf(sourceTimestamp);
    const targetTimestamp = params.targetAssistantTimestamps[index];
    if (!documentId || index < 0 || !Number.isFinite(targetTimestamp)) continue;
    await addPlanDocumentOwner({
      documentId,
      conversationKey: params.targetConversationKey,
      sourceMessageTimestamp: targetTimestamp,
    });
    copied += 1;
  }
  return copied;
}

async function deleteUnownedPlanDocumentInTransaction(
  documentId: string,
): Promise<void> {
  const remaining = (await Zotero.DB.queryAsync(
    `SELECT COUNT(*) AS count FROM ${PLAN_DOCUMENT_OWNERS_TABLE}
     WHERE document_id = ?`,
    [documentId],
  )) as Array<{ count?: unknown }>;
  if (Number(remaining?.[0]?.count || 0) > 0) return;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENT_ACTION_STATE_TABLE} WHERE document_id = ?`,
    [documentId],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENT_OUTBOX_TABLE} WHERE document_id = ?`,
    [documentId],
  );
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENT_COVERAGE_TABLE} WHERE document_id = ?`,
    [documentId],
  );
  const assetRows = (await Zotero.DB.queryAsync(
    `SELECT assets.content_hash AS contentHash,
            assets.durable_path AS durablePath
     FROM ${PLAN_DOCUMENT_ASSETS_TABLE} assets
     JOIN ${PLAN_DOCUMENT_ASSET_REFS_TABLE} refs
       ON refs.content_hash = assets.content_hash
     WHERE refs.document_id = ?`,
    [documentId],
  )) as Array<{ contentHash?: unknown; durablePath?: unknown }> | undefined;
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENT_ASSET_REFS_TABLE} WHERE document_id = ?`,
    [documentId],
  );
  for (const asset of assetRows || []) {
    const contentHash =
      typeof asset.contentHash === "string" ? asset.contentHash : "";
    const durablePath =
      typeof asset.durablePath === "string" ? asset.durablePath : "";
    if (!contentHash || !durablePath) continue;
    const refs = (await Zotero.DB.queryAsync(
      `SELECT COUNT(*) AS count FROM ${PLAN_DOCUMENT_ASSET_REFS_TABLE}
       WHERE content_hash = ?`,
      [contentHash],
    )) as Array<{ count?: unknown }> | undefined;
    if (Number(refs?.[0]?.count || 0) > 0) continue;
    await Zotero.DB.queryAsync(
      `DELETE FROM ${PLAN_DOCUMENT_ASSETS_TABLE} WHERE content_hash = ?`,
      [contentHash],
    );
    await Zotero.DB.queryAsync(
      `INSERT OR IGNORE INTO ${PLAN_DOCUMENT_ASSET_CLEANUP_TABLE}
       (durable_path, queued_at) VALUES (?, ?)`,
      [durablePath, Date.now()],
    );
  }
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENTS_TABLE} WHERE document_id = ?`,
    [documentId],
  );
}

export async function clearPlanDocumentConversationRowsInTransaction(
  conversationKey: number,
): Promise<void> {
  const rows = (await Zotero.DB.queryAsync(
    `SELECT document_id AS documentId FROM ${PLAN_DOCUMENT_OWNERS_TABLE}
     WHERE conversation_key = ?`,
    [conversationKey],
  ).catch((error) => {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  })) as Array<{ documentId?: unknown }>;
  const documentIds = rows
    .map((row) => (typeof row.documentId === "string" ? row.documentId : ""))
    .filter(Boolean);
  await Zotero.DB.queryAsync(
    `DELETE FROM ${PLAN_DOCUMENT_OWNERS_TABLE} WHERE conversation_key = ?`,
    [conversationKey],
  );
  for (const documentId of documentIds) {
    await deleteUnownedPlanDocumentInTransaction(documentId);
  }
}

export async function sweepPlanDocumentStorage(): Promise<void> {
  await Zotero.DB.executeTransaction(async () => {
    for (const [table, predicate] of [
      [
        PLAN_DOCUMENT_ACTION_STATE_TABLE,
        "document_id NOT IN (SELECT document_id FROM " +
          PLAN_DOCUMENTS_TABLE +
          ")",
      ],
      [
        PLAN_DOCUMENT_OUTBOX_TABLE,
        "document_id NOT IN (SELECT document_id FROM " +
          PLAN_DOCUMENTS_TABLE +
          ")",
      ],
      [
        PLAN_DOCUMENT_COVERAGE_TABLE,
        "document_id NOT IN (SELECT document_id FROM " +
          PLAN_DOCUMENTS_TABLE +
          ")",
      ],
      [
        PLAN_DOCUMENT_ASSET_REFS_TABLE,
        "document_id NOT IN (SELECT document_id FROM " +
          PLAN_DOCUMENTS_TABLE +
          ")",
      ],
      [
        PLAN_DOCUMENT_OWNERS_TABLE,
        "document_id NOT IN (SELECT document_id FROM " +
          PLAN_DOCUMENTS_TABLE +
          ")",
      ],
    ] as const) {
      await Zotero.DB.queryAsync(`DELETE FROM ${table} WHERE ${predicate}`);
    }
    const unowned = (await Zotero.DB.queryAsync(
      `SELECT document_id AS documentId FROM ${PLAN_DOCUMENTS_TABLE}
       WHERE document_id NOT IN (
         SELECT document_id FROM ${PLAN_DOCUMENT_OWNERS_TABLE}
       )`,
    )) as Array<{ documentId?: unknown }> | undefined;
    for (const row of unowned || []) {
      if (typeof row.documentId === "string") {
        await deleteUnownedPlanDocumentInTransaction(row.documentId);
      }
    }
    const orphanedAssets = (await Zotero.DB.queryAsync(
      `SELECT content_hash AS contentHash, durable_path AS durablePath
       FROM ${PLAN_DOCUMENT_ASSETS_TABLE}
       WHERE content_hash NOT IN (
         SELECT content_hash FROM ${PLAN_DOCUMENT_ASSET_REFS_TABLE}
       )`,
    )) as Array<{ contentHash?: unknown; durablePath?: unknown }> | undefined;
    for (const row of orphanedAssets || []) {
      const contentHash =
        typeof row.contentHash === "string" ? row.contentHash : "";
      const durablePath =
        typeof row.durablePath === "string" ? row.durablePath : "";
      if (!contentHash) continue;
      await Zotero.DB.queryAsync(
        `DELETE FROM ${PLAN_DOCUMENT_ASSETS_TABLE} WHERE content_hash = ?`,
        [contentHash],
      );
      if (durablePath) {
        await Zotero.DB.queryAsync(
          `INSERT OR IGNORE INTO ${PLAN_DOCUMENT_ASSET_CLEANUP_TABLE}
           (durable_path, queued_at) VALUES (?, ?)`,
          [durablePath, Date.now()],
        );
      }
    }
  });
  const io = (globalThis as unknown as { IOUtils?: any }).IOUtils;
  if (typeof io?.remove !== "function") return;
  const queued = (await Zotero.DB.queryAsync(
    `SELECT durable_path AS durablePath
     FROM ${PLAN_DOCUMENT_ASSET_CLEANUP_TABLE}`,
  ).catch(() => [])) as Array<{ durablePath?: unknown }>;
  for (const row of queued) {
    const path = typeof row.durablePath === "string" ? row.durablePath : "";
    if (!path) continue;
    try {
      await io.remove(path, { ignoreAbsent: true });
      await Zotero.DB.queryAsync(
        `DELETE FROM ${PLAN_DOCUMENT_ASSET_CLEANUP_TABLE}
         WHERE durable_path = ?`,
        [path],
      );
    } catch (error) {
      ztoolkit.log("LLM: Failed to clean plan document asset", error);
    }
  }
  if (typeof io?.getChildren !== "function") return;
  const directory = documentAssetDirectory();
  let children: string[] = [];
  try {
    children = await io.getChildren(directory);
  } catch {
    return;
  }
  const referencedRows = (await Zotero.DB.queryAsync(
    `SELECT durable_path AS durablePath FROM ${PLAN_DOCUMENT_ASSETS_TABLE}`,
  )) as Array<{ durablePath?: unknown }> | undefined;
  const referenced = new Set(
    (referencedRows || [])
      .map((row) =>
        typeof row.durablePath === "string" ? row.durablePath : "",
      )
      .filter(Boolean),
  );
  for (const path of children) {
    if (!referenced.has(path) || path.endsWith(".tmp")) {
      await io.remove(path, { ignoreAbsent: true }).catch(() => {});
    }
  }
}
