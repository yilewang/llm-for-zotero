// Runtime and durable tombstones for conversation instances whose local
// deletion committed. Numeric keys are permanently retired; the immutable
// instance identity is retained as the durable tombstone boundary. The
// short-lived numeric map below exists only for legacy UI compatibility.

export const RECENTLY_DELETED_CONVERSATION_TTL_MS = 60_000;
export const CONVERSATION_DELETION_TOMBSTONES_TABLE =
  "llm_for_zotero_conversation_deletion_tombstones";

const tombstones = new Map<number, number>();
const instanceTombstones = new Map<string, number>();
let tombstoneStoreInitialized = false;

export function conversationInstanceIdentityDigest(params: {
  conversationKey: number;
  instanceID: string;
  conversationID?: string;
}): string {
  const source = `${params.instanceID.trim()}|${normalizeKey(params.conversationKey)}|${String(params.conversationID || "").trim()}`;
  let hash = 2166136261;
  let secondary = 0x9e3779b9;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
    secondary ^= hash + Math.imul(i + 1, 0x45d9f3b);
    secondary = Math.imul(secondary, 2246822519);
  }
  return `id-${(hash >>> 0).toString(16)}-${(secondary >>> 0).toString(16)}-${source.length.toString(16)}`;
}

function getDb(): {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
} | null {
  return ((globalThis as { Zotero?: { DB?: { queryAsync?: unknown } } }).Zotero
    ?.DB || null) as {
    queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  } | null;
}

function normalizeKey(conversationKey: number): number {
  return Number.isFinite(conversationKey) && conversationKey > 0
    ? Math.floor(conversationKey)
    : 0;
}

function prune(now: number): void {
  for (const [key, deletedAt] of Array.from(tombstones.entries())) {
    if (now - deletedAt >= RECENTLY_DELETED_CONVERSATION_TTL_MS) {
      tombstones.delete(key);
    }
  }
}

export function markConversationRecentlyDeleted(
  conversationKey: number,
  now: number = Date.now(),
): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  prune(now);
  tombstones.set(key, now);
}

export function markConversationInstanceRecentlyDeleted(
  conversationKey: number,
  instanceID: string,
  now: number = Date.now(),
  identityDigest?: string,
): void {
  const key = normalizeKey(conversationKey);
  const normalizedInstanceID =
    typeof instanceID === "string" ? instanceID.trim() : "";
  if (!key || !normalizedInstanceID) return;
  const tombstoneKey =
    typeof identityDigest === "string" && identityDigest.trim()
      ? identityDigest.trim()
      : conversationInstanceIdentityDigest({
          conversationKey: key,
          instanceID: normalizedInstanceID,
        });
  instanceTombstones.set(`${key}:${normalizedInstanceID}`, now);
  instanceTombstones.set(tombstoneKey, now);

  void persistConversationInstanceTombstone({
    conversationKey: key,
    instanceID: normalizedInstanceID,
    identityDigest: tombstoneKey,
    deletedAt: now,
  }).catch(() => undefined);
}

/** Insert a tombstone using the caller's active transaction; no schema DDL. */
export async function persistConversationInstanceTombstoneInTransaction(params: {
  conversationKey: number;
  instanceID: string;
  conversationID?: string;
  identityDigest?: string;
  deletedAt?: number;
}): Promise<void> {
  const db = getDb();
  if (typeof db?.queryAsync !== "function") {
    throw new Error("Zotero DB unavailable for deletion tombstone");
  }
  const key = normalizeKey(params.conversationKey);
  const instanceID = String(params.instanceID || "").trim();
  if (!key || !instanceID)
    throw new Error("Invalid deletion tombstone identity");
  const identityDigest =
    String(params.identityDigest || "").trim() ||
    conversationInstanceIdentityDigest({
      conversationKey: key,
      instanceID,
      conversationID: params.conversationID,
    });
  await db.queryAsync(
    `INSERT OR IGNORE INTO ${CONVERSATION_DELETION_TOMBSTONES_TABLE}
       (identity_digest, conversation_key, instance_id, deleted_at)
     VALUES (?, ?, ?, ?)`,
    [
      identityDigest,
      key,
      instanceID,
      Number.isFinite(Number(params.deletedAt))
        ? Math.floor(Number(params.deletedAt))
        : Date.now(),
    ],
  );
}

/** Initialize the tombstone schema, then insert one row outside a transaction. */
export async function persistConversationInstanceTombstone(params: {
  conversationKey: number;
  instanceID: string;
  conversationID?: string;
  identityDigest?: string;
  deletedAt?: number;
}): Promise<void> {
  await initRecentlyDeletedConversationTombstones();
  await persistConversationInstanceTombstoneInTransaction(params);
}

export function isConversationRecentlyDeleted(
  conversationKey: number,
  now: number = Date.now(),
): boolean {
  const key = normalizeKey(conversationKey);
  if (!key) return false;
  const deletedAt = tombstones.get(key);
  if (deletedAt === undefined) return false;
  if (now - deletedAt >= RECENTLY_DELETED_CONVERSATION_TTL_MS) {
    tombstones.delete(key);
    return false;
  }
  return true;
}

export function isConversationInstanceRecentlyDeleted(
  conversationKey: number,
  instanceID: string,
  _now: number = Date.now(),
): boolean {
  const key = normalizeKey(conversationKey);
  const normalizedInstanceID =
    typeof instanceID === "string" ? instanceID.trim() : "";
  if (!key || !normalizedInstanceID) return false;
  return instanceTombstones.has(`${key}:${normalizedInstanceID}`);
}

/**
 * Check the durable deletion boundary when no catalog/registry row remains to
 * provide an instance ID. Ambient seeding must stop in this case; deliberate
 * navigation can still create a fresh catalog instance explicitly.
 */
export async function hasConversationDeletionTombstoneForKey(
  conversationKey: number,
): Promise<boolean> {
  const key = normalizeKey(conversationKey);
  const db = getDb();
  if (!key || typeof db?.queryAsync !== "function") return false;
  try {
    const rows = (await db.queryAsync(
      `SELECT 1 AS present
       FROM ${CONVERSATION_DELETION_TOMBSTONES_TABLE}
       WHERE conversation_key = ?
       LIMIT 1`,
      [key],
    )) as Array<{ present?: unknown }> | undefined;
    return Boolean(rows?.length);
  } catch (error) {
    // A locked or otherwise unreadable deletion boundary must fail closed:
    // ambient history seeding cannot recreate a conversation while we cannot
    // prove that its instance was not already committed for deletion.  The
    // first-run missing-table case is safe because no tombstone can exist yet.
    return !/no such table|no table/i.test(String(error));
  }
}

/** Load durable identity tombstones during startup/restart. */
export async function initRecentlyDeletedConversationTombstones(): Promise<void> {
  if (tombstoneStoreInitialized) return;
  const db = getDb();
  if (typeof db?.queryAsync !== "function") return;
  try {
    await db.queryAsync(
      `CREATE TABLE IF NOT EXISTS ${CONVERSATION_DELETION_TOMBSTONES_TABLE} (
        identity_digest TEXT PRIMARY KEY,
        conversation_key INTEGER NOT NULL,
        instance_id TEXT NOT NULL,
        deleted_at INTEGER NOT NULL
      )`,
    );
    const rows = (await db.queryAsync(
      `SELECT identity_digest AS identityDigest,
              conversation_key AS conversationKey,
              instance_id AS instanceID,
              deleted_at AS deletedAt
       FROM ${CONVERSATION_DELETION_TOMBSTONES_TABLE}`,
    )) as Array<{
      identityDigest?: unknown;
      conversationKey?: unknown;
      instanceID?: unknown;
      deletedAt?: unknown;
    }>;
    for (const row of rows || []) {
      const digest =
        typeof row.identityDigest === "string" ? row.identityDigest.trim() : "";
      if (!digest) continue;
      const deletedAt = Number(row.deletedAt);
      const timestamp =
        Number.isFinite(deletedAt) && deletedAt > 0 ? deletedAt : Date.now();
      instanceTombstones.set(digest, timestamp);
      const key = normalizeKey(Number(row.conversationKey));
      const instanceID =
        typeof row.instanceID === "string" ? row.instanceID.trim() : "";
      if (key && instanceID) {
        instanceTombstones.set(`${key}:${instanceID}`, timestamp);
      }
    }
    tombstoneStoreInitialized = true;
  } catch {
    // The pending-deletion write-ahead row remains authoritative if this
    // optional mirror is unavailable during startup.
  }
}

// Legacy callers may clear only the in-memory compatibility marker. This never
// clears the durable instance tombstone or the permanent key ledger.
export function forgetRecentlyDeletedConversation(
  conversationKey: number,
): void {
  const key = normalizeKey(conversationKey);
  if (!key) return;
  tombstones.delete(key);
}

export function resetRecentlyDeletedConversationsForTests(): void {
  tombstones.clear();
  instanceTombstones.clear();
  tombstoneStoreInitialized = false;
}
