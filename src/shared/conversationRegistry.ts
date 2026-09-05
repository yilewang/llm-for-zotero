declare const Zotero: any;

import type { ConversationSystem } from "./types";
import { getConversationKeyLedgerEntry } from "./conversationKeyLedger";

export type RegistryConversationKind = "global" | "paper";

export type ConversationRegistryScope = {
  instanceID?: string | null;
  conversationID?: string | null;
  conversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number | null;
  profileSignature?: string | null;
  createdAt?: number;
  updatedAt?: number;
  title?: string | null;
};

export type ConversationRegistryRow = Required<
  Pick<
    ConversationRegistryScope,
    | "instanceID"
    | "conversationID"
    | "conversationKey"
    | "system"
    | "kind"
    | "libraryID"
  >
> & {
  profileSignature: string;
  paperItemID: number | null;
  valid: boolean;
  isPaperRestoreTarget?: boolean;
  invalidReason?: string;
};

export type PaperRestoreTargetInvalidation = Pick<
  ConversationRegistryRow,
  | "instanceID"
  | "conversationKey"
  | "system"
  | "profileSignature"
  | "libraryID"
  | "paperItemID"
>;

export type ConversationScopeValidationReason =
  | "invalid_target"
  | "missing_registry"
  | "invalid_registry"
  | "conversation_id_mismatch"
  | "instance_id_mismatch"
  | "scope_mismatch";

export type ConversationScopeValidationDetails = {
  valid: boolean;
  reason?: ConversationScopeValidationReason;
  target?: ConversationRegistryRow;
  registered?: ConversationRegistryRow | null;
};

export type PaperContextJsonColumns = {
  paperContextsJson?: unknown;
  pdfPaperContextsJson?: unknown;
  fullTextPaperContextsJson?: unknown;
  selectedTextPaperContextsJson?: unknown;
  citationPaperContextsJson?: unknown;
};

export type PaperContextOwnershipEvidence = {
  paperItemIDs: number[];
  singlePaperItemID: number | null;
};

export const AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON =
  "ambiguous paper context evidence";

const CONVERSATION_REGISTRY_TABLE = "llm_for_zotero_conversation_registry";
const CONVERSATION_REGISTRY_SCOPE_INDEX =
  "llm_for_zotero_conversation_registry_scope_idx";
const CONVERSATION_REGISTRY_LEGACY_KEY_INDEX =
  "llm_for_zotero_conversation_registry_legacy_key_idx";
const CONVERSATION_REGISTRY_PAPER_RESTORE_TARGET_INDEX =
  "llm_for_zotero_unique_paper_restore_target";
const CONVERSATION_DELETION_TOMBSTONES_TABLE =
  "llm_for_zotero_conversation_deletion_tombstones";

let paperRestoreTargetInvalidationListener:
  | ((target: PaperRestoreTargetInvalidation) => void)
  | null = null;

export function registerPaperRestoreTargetInvalidationListener(
  listener: (target: PaperRestoreTargetInvalidation) => void,
): () => void {
  paperRestoreTargetInvalidationListener = listener;
  return () => {
    if (paperRestoreTargetInvalidationListener === listener) {
      paperRestoreTargetInvalidationListener = null;
    }
  };
}

const CATALOG_TABLES: Record<
  `${ConversationSystem}:${RegistryConversationKind}`,
  string
> = {
  "upstream:global": "llm_for_zotero_global_conversations",
  "upstream:paper": "llm_for_zotero_paper_conversations",
  "claude_code:global": "llm_for_zotero_claude_conversations",
  "claude_code:paper": "llm_for_zotero_claude_conversations",
  "codex:global": "llm_for_zotero_codex_conversations",
  "codex:paper": "llm_for_zotero_codex_conversations",
};

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 256): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): RegistryConversationKind | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeTimestamp(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : Date.now();
}

function normalizeConversationID(value: unknown): string {
  return normalizeText(value, 512)
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9:._-]/g, "_")
    .slice(0, 512);
}

function normalizeInstanceID(value: unknown): string {
  return typeof value === "string" && value.trim()
    ? value.trim().slice(0, 128)
    : "";
}

export function generateConversationInstanceID(): string {
  const randomUUID = (globalThis.crypto as Crypto | undefined)?.randomUUID;
  if (typeof randomUUID === "function") {
    return randomUUID.call(globalThis.crypto);
  }
  const values = new Uint32Array(4);
  const getRandomValues = globalThis.crypto?.getRandomValues;
  if (typeof getRandomValues === "function") {
    getRandomValues.call(globalThis.crypto, values);
    return `instance-${Array.from(values, (value) =>
      value.toString(16).padStart(8, "0"),
    ).join("")}`;
  }
  const zoteroRandomString = (
    globalThis as typeof globalThis & {
      Zotero?: { Utilities?: { randomString?: (length: number) => string } };
    }
  ).Zotero?.Utilities?.randomString;
  if (typeof zoteroRandomString === "function") {
    return `instance-${zoteroRandomString(32)}`;
  }
  // A recyclable, non-cryptographic fallback would violate the deletion
  // boundary. Refuse to create an instance until the runtime can provide
  // secure randomness instead of manufacturing an identity that can collide.
  throw new Error("Secure randomness unavailable for conversation identity");
}

export function buildProfileSignature(profileDir: string): string {
  const normalized = profileDir.trim().replace(/\\/g, "/");
  let hash = 2166136261;
  for (let i = 0; i < normalized.length; i += 1) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

export function getCurrentProfileSignature(): string {
  const profileDir = normalizeText(
    (
      globalThis as typeof globalThis & {
        Zotero?: { Profile?: { dir?: unknown } };
      }
    ).Zotero?.Profile?.dir,
    1024,
  );
  return profileDir ? buildProfileSignature(profileDir) : "profile-default";
}

export function buildConversationID(params: {
  conversationKey: number;
  system: ConversationSystem;
  kind: RegistryConversationKind;
  libraryID: number;
  paperItemID?: number | null;
  profileSignature?: string | null;
}): string {
  const conversationKey = normalizePositiveInt(params.conversationKey) || 0;
  const libraryID = normalizePositiveInt(params.libraryID) || 0;
  const paperItemID =
    params.kind === "paper" ? normalizePositiveInt(params.paperItemID) || 0 : 0;
  const profileSignature =
    normalizeText(params.profileSignature, 128) || getCurrentProfileSignature();
  return [
    "lfz",
    profileSignature,
    params.system,
    params.kind,
    `lib-${libraryID}`,
    `paper-${paperItemID}`,
    `legacy-${conversationKey}`,
  ].join(":");
}

function normalizeScope(params: ConversationRegistryScope):
  | (ConversationRegistryRow & {
      createdAt: number;
      updatedAt: number;
      title: string | null;
    })
  | null {
  const conversationKey = normalizePositiveInt(params.conversationKey);
  const libraryID = normalizePositiveInt(params.libraryID);
  const system = normalizeSystem(params.system);
  const kind = normalizeKind(params.kind);
  if (!conversationKey || !libraryID || !system || !kind) return null;
  const paperItemID =
    kind === "paper" ? normalizePositiveInt(params.paperItemID) : null;
  if (kind === "paper" && !paperItemID) return null;
  return {
    instanceID:
      normalizeInstanceID(params.instanceID) ||
      generateConversationInstanceID(),
    conversationID:
      normalizeConversationID(params.conversationID) ||
      buildConversationID({
        conversationKey,
        system,
        kind,
        libraryID,
        paperItemID,
        profileSignature:
          normalizeText(params.profileSignature, 128) ||
          getCurrentProfileSignature(),
      }),
    conversationKey,
    system,
    kind,
    profileSignature:
      normalizeText(params.profileSignature, 128) ||
      getCurrentProfileSignature(),
    libraryID,
    paperItemID,
    valid: true,
    createdAt: normalizeTimestamp(params.createdAt),
    updatedAt: normalizeTimestamp(params.updatedAt),
    title: normalizeText(params.title || "", 128) || null,
  };
}

function sameRegistryScope(
  left: ConversationRegistryRow,
  right: ConversationRegistryRow,
): boolean {
  return (
    left.system === right.system &&
    left.kind === right.kind &&
    left.profileSignature === right.profileSignature &&
    left.libraryID === right.libraryID &&
    (left.paperItemID || null) === (right.paperItemID || null)
  );
}

function logRegistryWarning(message: string): void {
  const debug = (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug;
  debug?.(`LLM: ${message}`);
}

async function registryWriteStillOwnsLedger(
  scope: Pick<
    ConversationRegistryScope,
    "conversationKey" | "instanceID" | "conversationID" | "system" | "kind"
  >,
): Promise<boolean> {
  const ledgerEntry = await getConversationKeyLedgerEntry(
    scope.conversationKey,
  );
  if (!ledgerEntry) return true;
  return Boolean(
    !ledgerEntry.retiredAt &&
    ledgerEntry.instanceID === scope.instanceID &&
    ledgerEntry.conversationID === scope.conversationID &&
    ledgerEntry.system === scope.system &&
    ledgerEntry.kind === scope.kind,
  );
}

function getZoteroDb(): {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
} | null {
  return (
    (
      globalThis as typeof globalThis & {
        Zotero?: {
          DB?: {
            queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
            executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
          };
        };
      }
    ).Zotero?.DB || null
  );
}

async function getTableColumns(tableName: string): Promise<Set<string>> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return new Set();
  const rows = (await db.queryAsync(`PRAGMA table_info(${tableName})`)) as
    | Array<{ name?: unknown }>
    | undefined;
  return new Set(
    (rows || [])
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
}

async function createConversationRegistryTable(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${CONVERSATION_REGISTRY_TABLE} (
      instance_id TEXT,
      conversation_id TEXT PRIMARY KEY,
      legacy_conversation_key INTEGER NOT NULL,
      system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
      kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
      profile_signature TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      title TEXT,
      valid INTEGER NOT NULL DEFAULT 1,
      invalid_reason TEXT,
      is_paper_restore_target INTEGER NOT NULL DEFAULT 0
        CHECK(is_paper_restore_target IN (0, 1))
    )`,
  );
}

async function ensurePaperRestoreTargetColumn(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const columns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (!columns.has("is_paper_restore_target")) {
    await db.queryAsync(
      `ALTER TABLE ${CONVERSATION_REGISTRY_TABLE}
       ADD COLUMN is_paper_restore_target INTEGER NOT NULL DEFAULT 0
         CHECK(is_paper_restore_target IN (0, 1))`,
    );
  }
}

async function ensureRegistryInstanceIDs(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const columns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (!columns.has("instance_id")) {
    await db.queryAsync(
      `ALTER TABLE ${CONVERSATION_REGISTRY_TABLE} ADD COLUMN instance_id TEXT`,
    );
  }
  const rows = (await db.queryAsync(
    `SELECT conversation_id AS conversationID
     FROM ${CONVERSATION_REGISTRY_TABLE}
     WHERE instance_id IS NULL OR TRIM(instance_id) = ''`,
  )) as Array<{ conversationID?: unknown }> | undefined;
  for (const row of rows || []) {
    const conversationID = normalizeConversationID(row.conversationID);
    if (!conversationID) continue;
    await db.queryAsync(
      `UPDATE ${CONVERSATION_REGISTRY_TABLE}
       SET instance_id = ?
       WHERE conversation_id = ?
         AND (instance_id IS NULL OR TRIM(instance_id) = '')`,
      [generateConversationInstanceID(), conversationID],
    );
  }
}

export async function syncCatalogInstanceID(
  scope: Pick<
    ConversationRegistryScope,
    "instanceID" | "conversationKey" | "system" | "kind"
  >,
): Promise<void> {
  const db = getZoteroDb();
  const table = CATALOG_TABLES[`${scope.system}:${scope.kind}`];
  const instanceID = normalizeInstanceID(scope.instanceID);
  const conversationKey = normalizePositiveInt(scope.conversationKey);
  if (!db?.queryAsync || !table || !instanceID || !conversationKey) return;
  try {
    await db.queryAsync(
      `UPDATE ${table}
       SET conversation_instance_id = ?
       WHERE conversation_key = ?
         AND (conversation_instance_id IS NULL OR TRIM(conversation_instance_id) = '')`,
      [instanceID, conversationKey],
    );
  } catch {
    // Older store schemas add the column during their own initialization. A
    // registry write must remain usable while an upgrade is in progress.
  }
}

async function getCatalogInstanceID(
  scope: Pick<ConversationRegistryScope, "conversationKey" | "system" | "kind">,
): Promise<string> {
  const db = getZoteroDb();
  const table = CATALOG_TABLES[`${scope.system}:${scope.kind}`];
  const conversationKey = normalizePositiveInt(scope.conversationKey);
  if (!db?.queryAsync || !table || !conversationKey) return "";
  try {
    const rows = (await db.queryAsync(
      `SELECT conversation_instance_id AS instanceID
       FROM ${table}
       WHERE conversation_key = ?
       LIMIT 1`,
      [conversationKey],
    )) as Array<{ instanceID?: unknown }> | undefined;
    return normalizeInstanceID(rows?.[0]?.instanceID);
  } catch {
    return "";
  }
}

/**
 * A catalog summary can be in flight while its conversation is being deleted.
 * Such a stale read must never recreate the registry after the local commit.
 * A new instance may reuse the numeric key, but it must carry a strictly newer
 * catalog creation timestamp (or an explicit instance ID).
 */
async function hasDeletionTombstoneAtOrAfter(
  conversationKey: number,
  createdAt: unknown,
): Promise<boolean> {
  const db = getZoteroDb();
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!db?.queryAsync || !normalizedKey) return false;
  const createdTimestamp = normalizeTimestamp(createdAt);
  try {
    const rows = (await db.queryAsync(
      `SELECT 1 AS present
       FROM ${CONVERSATION_DELETION_TOMBSTONES_TABLE}
       WHERE conversation_key = ?
         AND deleted_at >= ?
       LIMIT 1`,
      [normalizedKey, createdTimestamp],
    )) as Array<{ present?: unknown }> | undefined;
    return Boolean(rows?.length);
  } catch (error) {
    // The tombstone table is created lazily. A missing table is equivalent to
    // having no committed deletion. For any other DB failure, fail closed:
    // recreating a registry row from an unreadable deletion boundary is worse
    // than deferring a non-destructive repair.
    return !/no such table|no table/i.test(String(error));
  }
}

/** Read the immutable instance ID stored on a catalog row. */
export async function getCatalogInstanceIDForScope(
  scope: Pick<ConversationRegistryScope, "conversationKey" | "system" | "kind">,
): Promise<string> {
  return getCatalogInstanceID(scope);
}

async function migrateLegacyRegistrySchema(
  columns: Set<string>,
): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  if (
    !columns.has("conversation_key") ||
    columns.has("legacy_conversation_key")
  ) {
    return;
  }
  const legacyTable = `${CONVERSATION_REGISTRY_TABLE}_legacy_keyed`;
  await db.queryAsync(`DROP TABLE IF EXISTS ${legacyTable}`);
  await db.queryAsync(
    `ALTER TABLE ${CONVERSATION_REGISTRY_TABLE}
     RENAME TO ${legacyTable}`,
  );
  await createConversationRegistryTable();
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            created_at AS createdAt,
            updated_at AS updatedAt,
            title,
            valid,
            invalid_reason AS invalidReason
     FROM ${legacyTable}`,
  )) as Array<Record<string, unknown>> | undefined;
  for (const row of rows || []) {
    const system = normalizeSystem(row.system);
    const kind = normalizeKind(row.kind);
    const conversationKey = normalizePositiveInt(row.conversationKey);
    const libraryID = normalizePositiveInt(row.libraryID);
    if (!system || !kind || !conversationKey || !libraryID) continue;
    const paperItemID = normalizePositiveInt(row.paperItemID);
    const profileSignature =
      normalizeText(row.profileSignature, 128) || getCurrentProfileSignature();
    await db.queryAsync(
      `INSERT OR IGNORE INTO ${CONVERSATION_REGISTRY_TABLE}
        (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        buildConversationID({
          conversationKey,
          system,
          kind,
          libraryID,
          paperItemID,
          profileSignature,
        }),
        conversationKey,
        system,
        kind,
        profileSignature,
        libraryID,
        kind === "paper" ? paperItemID || null : null,
        normalizeTimestamp(row.createdAt),
        normalizeTimestamp(row.updatedAt),
        normalizeText(row.title, 128) || null,
        Number(row.valid) === 0 ? 0 : 1,
        normalizeText(row.invalidReason, 256) || null,
        generateConversationInstanceID(),
      ],
    );
  }
  await db.queryAsync(`DROP TABLE IF EXISTS ${legacyTable}`);
}

/**
 * True when the legacy-key index still carries the superseded UNIQUE
 * constraint and therefore has to be replaced.
 */
async function isLegacyKeyIndexUnique(): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  try {
    const rows = (await db.queryAsync(
      `PRAGMA index_list(${CONVERSATION_REGISTRY_TABLE})`,
    )) as Array<{ name?: unknown; unique?: unknown }> | undefined;
    return (rows || []).some(
      (row) =>
        row?.name === CONVERSATION_REGISTRY_LEGACY_KEY_INDEX &&
        Number(row?.unique) === 1,
    );
  } catch {
    // Without PRAGMA support fall back to replacing it, which is correct but
    // costs an index rebuild on this handle's first initialization only.
    return true;
  }
}

let registryInitTask: Promise<void> | null = null;
let registryInitDbRef: unknown = null;

/**
 * Prepare the registry schema once per database handle.
 *
 * This runs schema work -- PRAGMA table_info, a backfill scan, and index
 * maintenance -- and `getRegisteredConversationScope` awaits it on every
 * lookup, from ~30 call sites including message append and history rendering.
 * Unmemoized, each lookup paid all of it; worse, the legacy-key index was
 * dropped and recreated each time, so a single conversation lookup rebuilt an
 * index over the whole registry table.
 *
 * The result is cached against the DB handle so tests and profile switches,
 * which swap the handle, still re-initialize.
 */
export function initConversationRegistryStore(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return Promise.resolve();
  if (registryInitTask && registryInitDbRef === db) return registryInitTask;
  registryInitDbRef = db;
  registryInitTask = initConversationRegistryStoreUncached().catch((error) => {
    // A failed init must not be cached as success: clear it so the next
    // caller retries rather than running against an unprepared schema.
    if (registryInitDbRef === db) {
      registryInitTask = null;
      registryInitDbRef = null;
    }
    throw error;
  });
  return registryInitTask;
}

/** Test-only reset so fixtures can swap the database between cases. */
export function resetConversationRegistryStoreInitForTests(): void {
  registryInitTask = null;
  registryInitDbRef = null;
}

async function initConversationRegistryStoreUncached(): Promise<void> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const columns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (columns.size && columns.has("conversation_key")) {
    await migrateLegacyRegistrySchema(columns);
  } else {
    await createConversationRegistryTable();
  }
  const currentColumns = await getTableColumns(CONVERSATION_REGISTRY_TABLE);
  if (currentColumns.size && !currentColumns.has("conversation_id")) {
    logRegistryWarning(
      "Conversation registry schema is missing conversation_id; refusing to use unsafe registry table.",
    );
    return;
  }
  await ensureRegistryInstanceIDs();
  await ensurePaperRestoreTargetColumn();
  // Legacy builds made the recyclable numeric key unique.  That constraint is
  // incompatible with immutable instances: a later conversation is allowed
  // to reuse the key after the old instance has been deleted.  Drop the old
  // unique index and retain only a lookup index.
  //
  // Only drop when the existing index is actually the unique one. Dropping
  // unconditionally rebuilt the index over the whole table on every call.
  if (await isLegacyKeyIndexUnique()) {
    await db.queryAsync(
      `DROP INDEX IF EXISTS ${CONVERSATION_REGISTRY_LEGACY_KEY_INDEX}`,
    );
  }
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${CONVERSATION_REGISTRY_LEGACY_KEY_INDEX}
     ON ${CONVERSATION_REGISTRY_TABLE} (legacy_conversation_key, updated_at DESC)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${CONVERSATION_REGISTRY_SCOPE_INDEX}
     ON ${CONVERSATION_REGISTRY_TABLE}
       (profile_signature, system, kind, library_id, paper_item_id, updated_at DESC)`,
  );
  await db.queryAsync(
    `CREATE UNIQUE INDEX IF NOT EXISTS ${CONVERSATION_REGISTRY_PAPER_RESTORE_TARGET_INDEX}
     ON ${CONVERSATION_REGISTRY_TABLE}
       (profile_signature, system, library_id, paper_item_id)
     WHERE kind = 'paper'
       AND paper_item_id IS NOT NULL
       AND is_paper_restore_target = 1`,
  );
}

export async function getRegisteredConversationScope(
  conversationKey: number,
): Promise<ConversationRegistryRow | null> {
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalizedKey) return null;
  const db = getZoteroDb();
  if (!db?.queryAsync) return null;
  await initConversationRegistryStore();
  const rows = (await db.queryAsync(
    `SELECT instance_id AS instanceID,
            conversation_id AS conversationID,
            legacy_conversation_key AS conversationKey,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            valid,
            invalid_reason AS invalidReason
     FROM ${CONVERSATION_REGISTRY_TABLE}
     WHERE legacy_conversation_key = ?
     ORDER BY updated_at DESC, rowid DESC
     LIMIT 1`,
    [normalizedKey],
  )) as Array<Record<string, unknown>> | undefined;
  const row = rows?.[0];
  if (!row) return null;
  const system = normalizeSystem(row.system);
  const kind = normalizeKind(row.kind);
  const libraryID = normalizePositiveInt(row.libraryID);
  if (!system || !kind || !libraryID) return null;
  return {
    instanceID:
      normalizeInstanceID(row.instanceID) ||
      `${getCurrentProfileSignature()}:${normalizedKey}`,
    conversationID:
      normalizeConversationID(row.conversationID) ||
      buildConversationID({
        conversationKey: normalizedKey,
        system,
        kind,
        profileSignature: normalizeText(row.profileSignature, 128),
        libraryID,
        paperItemID: normalizePositiveInt(row.paperItemID),
      }),
    conversationKey: normalizedKey,
    system,
    kind,
    profileSignature: normalizeText(row.profileSignature, 128),
    libraryID,
    paperItemID: normalizePositiveInt(row.paperItemID),
    valid: Number(row.valid) !== 0,
    invalidReason: normalizeText(row.invalidReason, 256) || undefined,
  };
}

export async function registerConversationScope(
  params: ConversationRegistryScope,
  options?: { inTransaction?: boolean },
): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  const queryAsync = db.queryAsync.bind(db);
  const executeTransaction = db.executeTransaction?.bind(db);
  const catalogInstanceID = await getCatalogInstanceID(params);
  await initConversationRegistryStore();
  const existing = await getRegisteredConversationScope(
    normalizePositiveInt(params.conversationKey) || 0,
  );
  if (
    !params.instanceID &&
    !catalogInstanceID &&
    (await hasDeletionTombstoneAtOrAfter(
      normalizePositiveInt(params.conversationKey) || 0,
      params.createdAt,
    ))
  ) {
    logRegistryWarning(
      `Refused to recreate registry for deleted conversation ${normalizePositiveInt(params.conversationKey) || 0} from a stale catalog read.`,
    );
    return false;
  }
  const normalized = normalizeScope({
    ...params,
    // A registry repair can run after a legacy catalog row was read but
    // before its instance column was backfilled.  Preserve the already
    // registered immutable ID in that case instead of minting a new ID for
    // the same live instance while a delete intent is outstanding.
    instanceID:
      params.instanceID ||
      catalogInstanceID ||
      existing?.instanceID ||
      undefined,
  });
  if (!normalized) return false;
  try {
    const ledgerEntry = await getConversationKeyLedgerEntry(
      normalized.conversationKey,
    );
    if (
      ledgerEntry &&
      (ledgerEntry.retiredAt ||
        ledgerEntry.instanceID !== normalized.instanceID ||
        ledgerEntry.conversationID !== normalized.conversationID)
    ) {
      logRegistryWarning(
        `Refused to register conversation key ${normalized.conversationKey}: permanent ledger identity mismatch or retirement.`,
      );
      return false;
    }
  } catch (error) {
    if (!/no such table|no table/i.test(String(error))) throw error;
  }
  if (existing && !sameRegistryScope(existing, normalized)) {
    logRegistryWarning(
      `Refused to reassign conversation ${normalized.conversationKey} from ${existing.system}/${existing.kind}/${existing.libraryID}/${existing.paperItemID || ""} to ${normalized.system}/${normalized.kind}/${normalized.libraryID}/${normalized.paperItemID || ""}.`,
    );
    return false;
  }
  if (existing && existing.instanceID !== normalized.instanceID) {
    logRegistryWarning(
      `Refused to reuse conversation key ${normalized.conversationKey} for a new immutable instance.`,
    );
    return false;
  }
  if (existing && existing.conversationID !== normalized.conversationID) {
    logRegistryWarning(
      `Refused to reassign legacy conversation key ${normalized.conversationKey} from ${existing.conversationID} to ${normalized.conversationID}.`,
    );
    return false;
  }
  const writeRegistry = async (): Promise<boolean> => {
    if (!(await registryWriteStillOwnsLedger(normalized))) return false;
    await queryAsync(
      `INSERT INTO ${CONVERSATION_REGISTRY_TABLE}
        (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         legacy_conversation_key = excluded.legacy_conversation_key,
         updated_at = excluded.updated_at,
         title = COALESCE(excluded.title, ${CONVERSATION_REGISTRY_TABLE}.title),
         instance_id = excluded.instance_id`,
      [
        normalized.conversationID,
        normalized.conversationKey,
        normalized.system,
        normalized.kind,
        normalized.profileSignature,
        normalized.libraryID,
        normalized.paperItemID,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.title,
        normalized.instanceID,
      ],
    );
    return true;
  };
  // Catalog creation and registry insertion are one ownership transaction.
  // Zotero's SQLite wrapper does not support opening a second transaction from
  // inside an existing executeTransaction callback, so callers that already
  // hold the catalog transaction explicitly use the transaction-aware path.
  const wrote =
    options?.inTransaction || !executeTransaction
      ? await writeRegistry()
      : await executeTransaction(writeRegistry);
  if (!wrote) return false;
  await syncCatalogInstanceID(normalized);
  return true;
}

export async function invalidateRegisteredConversationScope(
  conversationKey: number,
  reason: string,
): Promise<void> {
  const normalizedKey = normalizePositiveInt(conversationKey);
  if (!normalizedKey) return;
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  await initConversationRegistryStore();
  const selectedRows = (await db.queryAsync(
    `SELECT instance_id AS instanceID,
            legacy_conversation_key AS conversationKey,
            system,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID
     FROM ${CONVERSATION_REGISTRY_TABLE}
     WHERE legacy_conversation_key = ?
       AND is_paper_restore_target = 1`,
    [normalizedKey],
  )) as Array<Record<string, unknown>> | undefined;
  await db.queryAsync(
    `UPDATE ${CONVERSATION_REGISTRY_TABLE}
     SET valid = 0,
         invalid_reason = ?,
         is_paper_restore_target = 0
     WHERE legacy_conversation_key = ?`,
    [normalizeText(reason, 256) || "invalid scope", normalizedKey],
  );
  for (const row of selectedRows || []) {
    const system = normalizeSystem(row.system);
    const libraryID = normalizePositiveInt(row.libraryID);
    const paperItemID = normalizePositiveInt(row.paperItemID);
    if (!system || !libraryID || !paperItemID) continue;
    paperRestoreTargetInvalidationListener?.({
      instanceID: normalizeInstanceID(row.instanceID),
      conversationKey: normalizedKey,
      system,
      profileSignature:
        normalizeText(row.profileSignature, 128) ||
        getCurrentProfileSignature(),
      libraryID,
      paperItemID,
    });
  }
}

export async function getRegisteredConversationScopeByInstanceID(
  instanceID: string,
): Promise<ConversationRegistryRow | null> {
  const normalizedInstanceID = normalizeInstanceID(instanceID);
  if (!normalizedInstanceID) return null;
  const db = getZoteroDb();
  if (!db?.queryAsync) return null;
  await initConversationRegistryStore();
  const rows = (await db.queryAsync(
    `SELECT instance_id AS instanceID,
            conversation_id AS conversationID,
            legacy_conversation_key AS conversationKey,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            valid,
            invalid_reason AS invalidReason
     FROM ${CONVERSATION_REGISTRY_TABLE}
     WHERE instance_id = ?
     LIMIT 1`,
    [normalizedInstanceID],
  )) as Array<Record<string, unknown>> | undefined;
  const row = rows?.[0];
  if (!row) return null;
  const system = normalizeSystem(row.system);
  const kind = normalizeKind(row.kind);
  const libraryID = normalizePositiveInt(row.libraryID);
  const conversationKey = normalizePositiveInt(row.conversationKey);
  if (!system || !kind || !libraryID || !conversationKey) return null;
  return {
    instanceID: normalizedInstanceID,
    conversationID: normalizeConversationID(row.conversationID),
    conversationKey,
    system,
    kind,
    profileSignature: normalizeText(row.profileSignature, 128),
    libraryID,
    paperItemID: normalizePositiveInt(row.paperItemID),
    valid: Number(row.valid) !== 0,
    invalidReason: normalizeText(row.invalidReason, 256) || undefined,
  };
}

export async function deleteRegisteredConversationScope(
  instanceID: string,
  conversationKey?: number,
): Promise<void> {
  const normalizedInstanceID = normalizeInstanceID(instanceID);
  if (!normalizedInstanceID) return;
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  await initConversationRegistryStore();
  await deleteRegisteredConversationScopeInTransaction(
    normalizedInstanceID,
    conversationKey,
  );
}

/** Delete a registry row without opening a nested transaction. */
export async function deleteRegisteredConversationScopeInTransaction(
  instanceID: string,
  conversationKey?: number,
  conversationID?: string,
  system?: ConversationSystem,
): Promise<void> {
  const normalizedInstanceID = normalizeInstanceID(instanceID);
  if (!normalizedInstanceID) return;
  const db = getZoteroDb();
  if (!db?.queryAsync) return;
  const normalizedKey = normalizePositiveInt(conversationKey);
  const normalizedConversationID = normalizeConversationID(conversationID);
  const normalizedSystem = normalizeSystem(system);
  if (normalizedKey) {
    await db.queryAsync(
      `DELETE FROM ${CONVERSATION_REGISTRY_TABLE}
       WHERE legacy_conversation_key = ?
         AND (
           instance_id = ?
           OR (
             ? <> ''
             AND conversation_id = ?
             AND (? = '' OR system = ?)
           )
         )`,
      [
        normalizedKey,
        normalizedInstanceID,
        normalizedConversationID,
        normalizedConversationID,
        normalizedSystem || "",
        normalizedSystem || "",
      ],
    );
  } else {
    await db.queryAsync(
      `DELETE FROM ${CONVERSATION_REGISTRY_TABLE} WHERE instance_id = ?`,
      [normalizedInstanceID],
    );
  }
}

export async function repairRegisteredConversationScope(
  params: ConversationRegistryScope,
  options?: { inTransaction?: boolean },
): Promise<boolean> {
  const db = getZoteroDb();
  if (!db?.queryAsync) return false;
  const queryAsync = db.queryAsync.bind(db);
  const executeTransaction = db.executeTransaction?.bind(db);
  const catalogInstanceID = await getCatalogInstanceID(params);
  await initConversationRegistryStore();
  const existing = await getRegisteredConversationScope(
    normalizePositiveInt(params.conversationKey) || 0,
  );
  if (
    !params.instanceID &&
    !catalogInstanceID &&
    (await hasDeletionTombstoneAtOrAfter(
      normalizePositiveInt(params.conversationKey) || 0,
      params.createdAt,
    ))
  ) {
    logRegistryWarning(
      `Refused to recreate registry for deleted conversation ${normalizePositiveInt(params.conversationKey) || 0} from a stale catalog repair.`,
    );
    return false;
  }
  const normalized = normalizeScope({
    ...params,
    instanceID:
      params.instanceID ||
      catalogInstanceID ||
      existing?.instanceID ||
      undefined,
  });
  if (!normalized) return false;
  if (existing && existing.conversationID !== normalized.conversationID) {
    const writeRepair = async (): Promise<boolean> => {
      if (!(await registryWriteStillOwnsLedger(normalized))) return false;
      await queryAsync(
        `UPDATE ${CONVERSATION_REGISTRY_TABLE}
         SET conversation_id = ?,
             instance_id = ?,
             system = ?,
             kind = ?,
             profile_signature = ?,
             library_id = ?,
             paper_item_id = ?,
             updated_at = ?,
             title = COALESCE(?, title),
             valid = 1,
             invalid_reason = NULL
         WHERE legacy_conversation_key = ?
           AND conversation_id = ?
           AND (instance_id = ? OR instance_id IS NULL OR TRIM(instance_id) = '')`,
        [
          normalized.conversationID,
          normalized.instanceID,
          normalized.system,
          normalized.kind,
          normalized.profileSignature,
          normalized.libraryID,
          normalized.paperItemID,
          normalized.updatedAt,
          normalized.title,
          normalized.conversationKey,
          existing.conversationID,
          existing.instanceID,
        ],
      );
      return true;
    };
    const repaired =
      options?.inTransaction || !executeTransaction
        ? await writeRepair()
        : await executeTransaction(writeRepair);
    if (!repaired) return false;
    await syncCatalogInstanceID(normalized);
    return true;
  }
  const writeRepair = async (): Promise<boolean> => {
    if (!(await registryWriteStillOwnsLedger(normalized))) return false;
    await queryAsync(
      `INSERT INTO ${CONVERSATION_REGISTRY_TABLE}
        (conversation_id, legacy_conversation_key, system, kind, profile_signature, library_id, paper_item_id, created_at, updated_at, title, valid, invalid_reason, instance_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         legacy_conversation_key = excluded.legacy_conversation_key,
         system = excluded.system,
         kind = excluded.kind,
         profile_signature = excluded.profile_signature,
         library_id = excluded.library_id,
         paper_item_id = excluded.paper_item_id,
         updated_at = excluded.updated_at,
         title = COALESCE(excluded.title, ${CONVERSATION_REGISTRY_TABLE}.title),
         valid = 1,
         invalid_reason = NULL,
         instance_id = excluded.instance_id`,
      [
        normalized.conversationID,
        normalized.conversationKey,
        normalized.system,
        normalized.kind,
        normalized.profileSignature,
        normalized.libraryID,
        normalized.paperItemID,
        normalized.createdAt,
        normalized.updatedAt,
        normalized.title,
        normalized.instanceID,
      ],
    );
    return true;
  };
  const repaired =
    options?.inTransaction || !executeTransaction
      ? await writeRepair()
      : await executeTransaction(writeRepair);
  if (!repaired) return false;
  await syncCatalogInstanceID(normalized);
  return true;
}

export async function validateConversationScope(
  params: ConversationRegistryScope,
): Promise<boolean> {
  return (await getConversationScopeValidationDetails(params)).valid;
}

export async function getConversationScopeValidationDetails(
  params: ConversationRegistryScope,
): Promise<ConversationScopeValidationDetails> {
  const normalized = normalizeScope(params);
  if (!normalized) {
    return { valid: false, reason: "invalid_target" };
  }
  const target: ConversationRegistryRow = {
    instanceID: normalized.instanceID,
    conversationID: normalized.conversationID,
    conversationKey: normalized.conversationKey,
    system: normalized.system,
    kind: normalized.kind,
    profileSignature: normalized.profileSignature,
    libraryID: normalized.libraryID,
    paperItemID: normalized.paperItemID,
    valid: normalized.valid,
  };
  const db = getZoteroDb();
  const existing = await getRegisteredConversationScope(
    normalized.conversationKey,
  );
  if (!existing) {
    if (!db?.queryAsync || normalized.system === "upstream") {
      return { valid: true, target, registered: null };
    }
    return {
      valid: false,
      reason: "missing_registry",
      target,
      registered: null,
    };
  }
  if (!existing.valid) {
    return {
      valid: false,
      reason: "invalid_registry",
      target,
      registered: existing,
    };
  }
  if (!sameRegistryScope(existing, normalized)) {
    return {
      valid: false,
      reason: "scope_mismatch",
      target,
      registered: existing,
    };
  }
  if (
    normalizeInstanceID(params.instanceID) &&
    existing.instanceID !== normalizeInstanceID(params.instanceID)
  ) {
    return {
      valid: false,
      reason: "instance_id_mismatch",
      target,
      registered: existing,
    };
  }
  const explicitConversationID = normalizeConversationID(params.conversationID);
  if (
    explicitConversationID &&
    existing.conversationID !== normalized.conversationID
  ) {
    return {
      valid: false,
      reason: "conversation_id_mismatch",
      target,
      registered: existing,
    };
  }
  return { valid: true, target, registered: existing };
}

export function isLegacyAmbiguousPaperContextInvalidReason(
  reason: unknown,
): boolean {
  return (
    normalizeText(reason, 256).toLowerCase() ===
    AMBIGUOUS_PAPER_CONTEXT_INVALID_REASON
  );
}

export function canMigrateLegacyAmbiguousPaperRegistryScope(
  registered: ConversationRegistryRow | null | undefined,
  scope: Pick<
    ConversationRegistryScope,
    "system" | "kind" | "libraryID" | "paperItemID"
  >,
): boolean {
  const libraryID = normalizePositiveInt(scope.libraryID);
  const paperItemID = normalizePositiveInt(scope.paperItemID);
  return Boolean(
    registered &&
    !registered.valid &&
    isLegacyAmbiguousPaperContextInvalidReason(registered.invalidReason) &&
    scope.kind === "paper" &&
    libraryID &&
    paperItemID &&
    registered.system === scope.system &&
    registered.kind === "paper" &&
    registered.libraryID === libraryID &&
    (registered.paperItemID || 0) === paperItemID,
  );
}

function collectPaperIdsFromValue(value: unknown, out: Set<number>): void {
  if (typeof value !== "string" || !value.trim()) return;
  try {
    const parsed = JSON.parse(value) as unknown;
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      const itemID = normalizePositiveInt(
        (entry as { itemId?: unknown; itemID?: unknown }).itemId ??
          (entry as { itemId?: unknown; itemID?: unknown }).itemID,
      );
      if (itemID) out.add(itemID);
    }
  } catch {
    // Ignore malformed legacy JSON. It cannot safely prove ownership.
  }
}

export function inferSinglePaperItemIdFromContextRows(
  rows: PaperContextJsonColumns[],
): number | "ambiguous" | null {
  const evidence = getPaperContextOwnershipEvidenceFromRows(rows);
  if (evidence.paperItemIDs.length === 0) return null;
  if (evidence.paperItemIDs.length > 1) return "ambiguous";
  return evidence.singlePaperItemID;
}

export function getPaperContextOwnershipEvidenceFromRows(
  rows: PaperContextJsonColumns[],
): PaperContextOwnershipEvidence {
  const ids = new Set<number>();
  for (const row of rows) {
    collectPaperIdsFromValue(row.paperContextsJson, ids);
    collectPaperIdsFromValue(row.pdfPaperContextsJson, ids);
    collectPaperIdsFromValue(row.fullTextPaperContextsJson, ids);
    collectPaperIdsFromValue(row.selectedTextPaperContextsJson, ids);
    collectPaperIdsFromValue(row.citationPaperContextsJson, ids);
  }
  const paperItemIDs = Array.from(ids).sort((left, right) => left - right);
  return {
    paperItemIDs,
    singlePaperItemID: paperItemIDs.length === 1 ? paperItemIDs[0] : null,
  };
}
