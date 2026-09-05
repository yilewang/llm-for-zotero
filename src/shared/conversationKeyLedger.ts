import type { ConversationSystem } from "./types";
import { classifyConversationKey } from "./conversationKeySpace";

export type ConversationKeyLedgerKind = "global" | "paper";

export type ConversationKeyLedgerEntry = {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  profileSignature: string;
  libraryID: number;
  paperItemID?: number;
  issuedAt: number;
  retiredAt?: number;
  retirementReason?: string;
};

export type ConversationKeyRange = {
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  profileSignature?: string;
  start: number;
  endExclusive: number;
};

export class ConversationRetiredError extends Error {
  readonly conversationKey: number;
  readonly instanceID: string;

  constructor(conversationKey: number, instanceID = "") {
    super(`Conversation ${conversationKey} is permanently retired`);
    this.name = "ConversationRetiredError";
    this.conversationKey = conversationKey;
    this.instanceID = instanceID;
  }
}

const KEY_LEDGER_TABLE = "llm_for_zotero_conversation_key_ledger";
const KEY_COUNTERS_TABLE = "llm_for_zotero_conversation_key_counters";
const KEY_QUARANTINE_TABLE =
  "llm_for_zotero_conversation_key_identity_quarantine";
const KEY_LEDGER_SYSTEM_INDEX =
  "llm_for_zotero_conversation_key_ledger_system_idx";
const KEY_LEDGER_INSTANCE_INDEX =
  "llm_for_zotero_conversation_key_ledger_instance_idx";
let keyLedgerStoreInitialized = false;
let initializedDbRef: ZoteroDb | null = null;
const retiredConversationKeys = new Set<number>();
let retiredConversationKeysDbRef: ZoteroDb | null = null;

type ZoteroDb = {
  queryAsync?: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction?: <T>(task: () => Promise<T>) => Promise<T>;
};

type QueryableZoteroDb = ZoteroDb & {
  queryAsync: NonNullable<ZoteroDb["queryAsync"]>;
};

const ledgerInitializationByDb = new WeakMap<ZoteroDb, Promise<void>>();

function getDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

function getCurrentProfileSignature(): string {
  const profileDir = String(
    (
      globalThis as typeof globalThis & {
        Zotero?: { Profile?: { dir?: unknown } };
      }
    ).Zotero?.Profile?.dir || "",
  )
    .trim()
    .replace(/\\/g, "/");
  if (!profileDir) return "profile-default";
  let hash = 2166136261;
  for (let i = 0; i < profileDir.length; i += 1) {
    hash ^= profileDir.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `profile-${(hash >>> 0).toString(16)}`;
}

function generateConversationInstanceID(): string {
  const cryptoObject = globalThis.crypto;
  if (typeof cryptoObject?.randomUUID === "function") {
    return cryptoObject.randomUUID();
  }
  if (typeof cryptoObject?.getRandomValues === "function") {
    const values = new Uint32Array(4);
    cryptoObject.getRandomValues(values);
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
  throw new Error("Secure randomness unavailable for conversation identity");
}

function normalizePositiveInt(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function normalizeText(value: unknown, maxLength = 256): string {
  return typeof value === "string"
    ? value
        .replace(/[\u0000-\u001F\u007F]/g, " ")
        .trim()
        .slice(0, maxLength)
    : "";
}

function normalizeSystem(value: unknown): ConversationSystem | null {
  return value === "upstream" || value === "claude_code" || value === "codex"
    ? value
    : null;
}

function normalizeKind(value: unknown): ConversationKeyLedgerKind | null {
  return value === "global" || value === "paper" ? value : null;
}

function normalizeRange(range: ConversationKeyRange): ConversationKeyRange {
  const start = normalizePositiveInt(range.start) || 0;
  const endExclusive = normalizePositiveInt(range.endExclusive) || 0;
  const system = normalizeSystem(range.system);
  const kind = normalizeKind(range.kind);
  if (!start || !endExclusive || endExclusive <= start || !system || !kind) {
    throw new Error("Invalid conversation key allocation range");
  }
  return {
    system,
    kind,
    profileSignature:
      normalizeText(range.profileSignature, 128) ||
      getCurrentProfileSignature(),
    start,
    endExclusive,
  };
}

function rangeID(range: ConversationKeyRange): string {
  const normalized = normalizeRange(range);
  // The numeric range, rather than only the profile hash, is authoritative.
  // Two profile signatures can hash into the same slot; they must still share
  // one allocator so they cannot issue the same key in one Zotero database.
  return [
    normalized.system,
    normalized.kind,
    normalized.start,
    normalized.endExclusive,
  ].join(":");
}

function normalizeEntry(
  entry: ConversationKeyLedgerEntry,
): ConversationKeyLedgerEntry {
  const conversationKey = normalizePositiveInt(entry.conversationKey);
  const instanceID = normalizeText(entry.instanceID, 128);
  const conversationID = normalizeText(entry.conversationID, 512);
  const system = normalizeSystem(entry.system);
  const kind = normalizeKind(entry.kind);
  const libraryID = normalizePositiveInt(entry.libraryID);
  const paperItemID = normalizePositiveInt(entry.paperItemID);
  if (
    !conversationKey ||
    !instanceID ||
    !conversationID ||
    !system ||
    !kind ||
    !libraryID ||
    (kind === "paper" && !paperItemID)
  ) {
    throw new Error("Invalid conversation key ledger entry");
  }
  return {
    conversationKey,
    instanceID,
    conversationID,
    system,
    kind,
    profileSignature:
      normalizeText(entry.profileSignature, 128) ||
      getCurrentProfileSignature(),
    libraryID,
    paperItemID: paperItemID || undefined,
    issuedAt: normalizePositiveInt(entry.issuedAt) || Date.now(),
    retiredAt: normalizePositiveInt(entry.retiredAt) || undefined,
    retirementReason: normalizeText(entry.retirementReason, 256) || undefined,
  };
}

async function initializeConversationKeyLedgerStore(
  db: QueryableZoteroDb,
): Promise<void> {
  const nextRetiredConversationKeys = new Set<number>();
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_LEDGER_TABLE} (
      conversation_key INTEGER PRIMARY KEY,
      instance_id TEXT NOT NULL UNIQUE,
      conversation_id TEXT NOT NULL,
      system TEXT NOT NULL CHECK(system IN ('upstream', 'claude_code', 'codex')),
      kind TEXT NOT NULL CHECK(kind IN ('global', 'paper')),
      profile_signature TEXT NOT NULL,
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER,
      issued_at INTEGER NOT NULL,
      retired_at INTEGER,
      retirement_reason TEXT
    )`,
  );
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_COUNTERS_TABLE} (
      range_id TEXT PRIMARY KEY,
      system TEXT NOT NULL,
      kind TEXT NOT NULL,
      range_start INTEGER NOT NULL,
      range_end_exclusive INTEGER NOT NULL,
      next_key INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
  );
  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${KEY_QUARANTINE_TABLE} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_key INTEGER NOT NULL,
      instance_id TEXT,
      conversation_id TEXT,
      system TEXT,
      kind TEXT,
      library_id INTEGER,
      paper_item_id INTEGER,
      reason TEXT NOT NULL,
      observed_at INTEGER NOT NULL
    )`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${KEY_LEDGER_SYSTEM_INDEX}
     ON ${KEY_LEDGER_TABLE} (system, kind, retired_at, conversation_key)`,
  );
  await db.queryAsync(
    `CREATE INDEX IF NOT EXISTS ${KEY_LEDGER_INSTANCE_INDEX}
     ON ${KEY_LEDGER_TABLE} (instance_id)`,
  );
  const retiredRows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE retired_at IS NOT NULL`,
  )) as Array<{ conversationKey?: unknown }> | undefined;
  for (const row of retiredRows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    if (key) nextRetiredConversationKeys.add(key);
  }
  // Agent stores are lazy and may already exist when the ledger is restored
  // after a restart.  Install the database fence for any such tables now;
  // each lazy store also calls this helper after creating its own table.
  await installConversationKeyLedgerAgentTriggers();
  if (getDb() !== db) {
    throw new Error("Conversation key ledger DB changed during initialization");
  }
  retiredConversationKeys.clear();
  for (const key of nextRetiredConversationKeys) {
    retiredConversationKeys.add(key);
  }
  retiredConversationKeysDbRef = db;
  keyLedgerStoreInitialized = true;
  initializedDbRef = db;
}

async function ensureConversationKeyLedgerStoreInitialized(
  forceRefresh: boolean,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const queryableDb = db as QueryableZoteroDb;
  const inFlight = ledgerInitializationByDb.get(db);
  if (inFlight) {
    await inFlight;
    if (!forceRefresh) return;
  }
  if (!forceRefresh && keyLedgerStoreInitialized && initializedDbRef === db) {
    return;
  }

  // A new database must not inherit retirement state from an old profile.
  // A same-database refresh keeps the conservative in-memory fence intact
  // until the durable replacement has been read successfully.
  if (retiredConversationKeysDbRef && retiredConversationKeysDbRef !== db) {
    retiredConversationKeys.clear();
    retiredConversationKeysDbRef = null;
  }
  keyLedgerStoreInitialized = false;
  initializedDbRef = null;
  const initialization = initializeConversationKeyLedgerStore(
    queryableDb,
  ).catch((error) => {
    // Readiness is a safety claim: callers may only trust it after every
    // discovered trigger has been installed.  Keep the store unready so the
    // next startup or lazy-store attempt retries, while retaining the prior
    // same-database fence conservatively if a forced refresh failed.
    if (getDb() === db) {
      keyLedgerStoreInitialized = false;
      initializedDbRef = null;
    }
    throw error;
  });
  ledgerInitializationByDb.set(db, initialization);
  try {
    await initialization;
  } finally {
    if (ledgerInitializationByDb.get(db) === initialization) {
      ledgerInitializationByDb.delete(db);
    }
  }
}

export async function initConversationKeyLedgerStore(): Promise<void> {
  await ensureConversationKeyLedgerStoreInitialized(false);
}

/**
 * Re-read durable retirement state after a migration or test intentionally
 * changes ledger rows while retaining the same Zotero DB wrapper.
 */
export async function refreshConversationKeyLedgerStore(): Promise<void> {
  await ensureConversationKeyLedgerStoreInitialized(true);
}

export function isConversationKeyLedgerStoreInitialized(): boolean {
  return keyLedgerStoreInitialized && initializedDbRef === getDb();
}

/**
 * Fast process-local fence for callbacks that may arrive after the deletion
 * transaction has committed.  The database ledger remains authoritative; the
 * set only prevents an already-running callback from repopulating an in-memory
 * agent cache while its database write is being rejected by the ledger
 * triggers.
 */
export function isConversationKeyRetiredInMemory(
  conversationKey: number,
): boolean {
  const key = normalizePositiveInt(conversationKey);
  return Boolean(
    key &&
    retiredConversationKeysDbRef === getDb() &&
    retiredConversationKeys.has(key),
  );
}

export function rememberConversationKeyRetired(conversationKey: number): void {
  const key = normalizePositiveInt(conversationKey);
  const db = getDb();
  if (!key || !db) return;
  if (retiredConversationKeysDbRef !== db) {
    retiredConversationKeys.clear();
    retiredConversationKeysDbRef = db;
  }
  retiredConversationKeys.add(key);
}

export async function getConversationKeyLedgerEntry(
  conversationKey: number,
): Promise<ConversationKeyLedgerEntry | null> {
  const db = getDb();
  const key = normalizePositiveInt(conversationKey);
  if (!db?.queryAsync || !key) return null;
  const rows = (await db.queryAsync(
    `SELECT conversation_key AS conversationKey,
            instance_id AS instanceID,
            conversation_id AS conversationID,
            system,
            kind,
            profile_signature AS profileSignature,
            library_id AS libraryID,
            paper_item_id AS paperItemID,
            issued_at AS issuedAt,
            retired_at AS retiredAt,
            retirement_reason AS retirementReason
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [key],
  )) as Array<Record<string, unknown>> | undefined;
  const row = rows?.[0];
  if (!row) return null;
  try {
    return normalizeEntry(row as ConversationKeyLedgerEntry);
  } catch (_error) {
    return null;
  }
}

export async function ensureConversationKeyLedgerEntryInTransaction(
  entry: ConversationKeyLedgerEntry,
): Promise<ConversationKeyLedgerEntry> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const normalized = normalizeEntry(entry);
  const existing = await getConversationKeyLedgerEntry(
    normalized.conversationKey,
  );
  if (existing) {
    if (
      existing.instanceID !== normalized.instanceID ||
      existing.conversationID !== normalized.conversationID ||
      existing.system !== normalized.system ||
      existing.kind !== normalized.kind
    ) {
      throw new Error(
        `Conversation key ${normalized.conversationKey} is already owned by another immutable identity`,
      );
    }
    if (existing.retiredAt && !normalized.retiredAt) {
      throw new ConversationRetiredError(
        normalized.conversationKey,
        normalized.instanceID,
      );
    }
    return existing;
  }
  await db.queryAsync(
    `INSERT INTO ${KEY_LEDGER_TABLE}
      (conversation_key, instance_id, conversation_id, system, kind,
       profile_signature, library_id, paper_item_id, issued_at, retired_at,
       retirement_reason)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      normalized.conversationKey,
      normalized.instanceID,
      normalized.conversationID,
      normalized.system,
      normalized.kind,
      normalized.profileSignature,
      normalized.libraryID,
      normalized.paperItemID || null,
      normalized.issuedAt,
      normalized.retiredAt || null,
      normalized.retirementReason || null,
    ],
  );
  return normalized;
}

export async function ensureConversationKeyLedgerEntry(
  entry: ConversationKeyLedgerEntry,
): Promise<ConversationKeyLedgerEntry> {
  await initConversationKeyLedgerStore();
  const db = getDb();
  if (!db?.executeTransaction) {
    throw new Error("Conversation key ledger transaction DB is unavailable");
  }
  return db.executeTransaction(() =>
    ensureConversationKeyLedgerEntryInTransaction(entry),
  );
}

export async function allocateConversationKeyInTransaction(params: {
  range: ConversationKeyRange;
  instanceID?: string;
  conversationID?: string;
  libraryID: number;
  paperItemID?: number;
  issuedAt?: number;
}): Promise<ConversationKeyLedgerEntry> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const range = normalizeRange(params.range);
  const instanceID =
    normalizeText(params.instanceID, 128) || generateConversationInstanceID();
  const conversationID =
    normalizeText(params.conversationID, 512) ||
    `pending-conversation:${instanceID}`;
  const libraryID = normalizePositiveInt(params.libraryID);
  const paperItemID = normalizePositiveInt(params.paperItemID);
  if (
    !conversationID ||
    !libraryID ||
    (range.kind === "paper" && !paperItemID)
  ) {
    throw new Error("Invalid conversation key allocation request");
  }
  const id = rangeID(range);
  const counterRows = (await db.queryAsync(
    `SELECT next_key AS nextKey
     FROM ${KEY_COUNTERS_TABLE}
     WHERE range_id = ?
     LIMIT 1`,
    [id],
  )) as Array<{ nextKey?: unknown }> | undefined;
  const maxRows = (await db.queryAsync(
    `SELECT MAX(conversation_key) AS maxKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key >= ?
       AND conversation_key < ?`,
    [range.start, range.endExclusive],
  )) as Array<{ maxKey?: unknown }> | undefined;
  let candidate = Math.max(
    range.start,
    Number(counterRows?.[0]?.nextKey) || 0,
    (Number(maxRows?.[0]?.maxKey) || range.start - 1) + 1,
  );
  while (candidate < range.endExclusive) {
    const usedRows = (await db.queryAsync(
      `SELECT 1 AS present
       FROM ${KEY_LEDGER_TABLE}
       WHERE conversation_key = ?
       LIMIT 1`,
      [candidate],
    )) as Array<{ present?: unknown }> | undefined;
    if (!usedRows?.length) break;
    candidate += 1;
  }
  if (candidate >= range.endExclusive) {
    throw new Error(
      `Conversation key range exhausted for ${range.system}/${range.kind}`,
    );
  }
  const entry = await ensureConversationKeyLedgerEntryInTransaction({
    conversationKey: candidate,
    instanceID,
    conversationID,
    system: range.system,
    kind: range.kind,
    profileSignature: range.profileSignature || getCurrentProfileSignature(),
    libraryID,
    paperItemID: paperItemID || undefined,
    issuedAt: params.issuedAt || Date.now(),
  });
  await db.queryAsync(
    `INSERT INTO ${KEY_COUNTERS_TABLE}
      (range_id, system, kind, range_start, range_end_exclusive, next_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(range_id) DO UPDATE SET
       next_key = MAX(${KEY_COUNTERS_TABLE}.next_key, excluded.next_key),
       updated_at = excluded.updated_at`,
    [
      id,
      range.system,
      range.kind,
      range.start,
      range.endExclusive,
      candidate + 1,
      Date.now(),
    ],
  );
  return entry;
}

/** Initialize/advance a high-water counter during migration.  This never
 * removes a counter and never moves it backwards, even when legacy rows have
 * holes or a preference was lost. */
export async function initializeConversationKeyCounterInTransaction(
  range: ConversationKeyRange,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const normalized = normalizeRange(range);
  const id = rangeID(normalized);
  const maxRows = (await db.queryAsync(
    `SELECT MAX(conversation_key) AS maxKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key >= ? AND conversation_key < ?`,
    [normalized.start, normalized.endExclusive],
  )) as Array<{ maxKey?: unknown }> | undefined;
  const existingRows = (await db.queryAsync(
    `SELECT next_key AS nextKey
     FROM ${KEY_COUNTERS_TABLE}
     WHERE range_id = ? LIMIT 1`,
    [id],
  )) as Array<{ nextKey?: unknown }> | undefined;
  const nextKey = Math.max(
    normalized.start,
    Number(existingRows?.[0]?.nextKey) || 0,
    (Number(maxRows?.[0]?.maxKey) || normalized.start - 1) + 1,
  );
  await db.queryAsync(
    `INSERT INTO ${KEY_COUNTERS_TABLE}
      (range_id, system, kind, range_start, range_end_exclusive, next_key, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(range_id) DO UPDATE SET
       next_key = MAX(${KEY_COUNTERS_TABLE}.next_key, excluded.next_key),
       updated_at = excluded.updated_at`,
    [
      id,
      normalized.system,
      normalized.kind,
      normalized.start,
      normalized.endExclusive,
      nextKey,
      Date.now(),
    ],
  );
}

/**
 * Recover a crash between provider-store key allocation and catalog commit.
 * A live ledger row with no matching catalog witness is not a conversation;
 * retire it permanently so startup can never expose or allocate it again.
 */
function logLedger(message: string, details?: Record<string, unknown>): void {
  try {
    (
      globalThis as typeof globalThis & {
        Zotero?: { debug?: (message: string, details?: unknown) => void };
      }
    ).Zotero?.debug?.(message, details);
  } catch {
    // Diagnostics must never break a migration.
  }
}

const CONVERSATION_MESSAGE_TABLES = [
  "llm_for_zotero_chat_messages",
  "llm_for_zotero_claude_messages",
  "llm_for_zotero_codex_messages",
];

/** True when any provider's message table still holds rows for this key. */
async function conversationKeyHasMessages(
  conversationKey: number,
): Promise<boolean> {
  const db = getDb();
  if (!db?.queryAsync) return false;
  for (const table of CONVERSATION_MESSAGE_TABLES) {
    try {
      const rows = (await db.queryAsync(
        `SELECT 1 AS present FROM ${table}
         WHERE conversation_key = ? LIMIT 1`,
        [conversationKey],
      )) as Array<{ present?: unknown }> | undefined;
      if (rows?.length) return true;
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }
  return false;
}

/**
 * Reverse a retirement.  Retirement is otherwise permanent and irreversible,
 * which makes any false positive unrecoverable data loss; this is the repair
 * path for that case.  It deliberately refuses to revive a key that a real
 * deletion retired -- only allocations abandoned by a crash, and identities
 * quarantined by migration, are eligible.
 */
export async function unretireConversationKeyInTransaction(params: {
  conversationKey: number;
  instanceID: string;
}): Promise<boolean> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  if (!db?.queryAsync || !key || !instanceID) return false;
  const rows = (await db.queryAsync(
    `SELECT retirement_reason AS retirementReason
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ? AND instance_id = ? AND retired_at IS NOT NULL
     LIMIT 1`,
    [key, instanceID],
  )) as Array<{ retirementReason?: unknown }> | undefined;
  if (!rows?.length) return false;
  const reason = normalizeText(rows[0]?.retirementReason, 256);
  const REVIVABLE = [
    "orphaned-ledger-allocation-after-crash",
    "quarantined-identity",
  ];
  if (!REVIVABLE.includes(reason)) {
    logLedger("LLM: refusing to unretire a deliberately deleted conversation", {
      conversationKey: key,
      reason,
    });
    return false;
  }
  await db.queryAsync(
    `UPDATE ${KEY_LEDGER_TABLE}
     SET retired_at = NULL, retirement_reason = NULL
     WHERE conversation_key = ? AND instance_id = ?`,
    [key, instanceID],
  );
  retiredConversationKeys.delete(key);
  logLedger("LLM: unretired conversation key", {
    conversationKey: key,
    previousReason: reason,
  });
  return true;
}

/**
 * Next key to issue in a range, without searching for gaps.
 *
 * Migration fallbacks previously did `while (await isIssued(k)) k += 1`, which
 * has three problems: it issues one query per occupied key; it has no ceiling,
 * so it can walk out of its own range into another system's key space; and
 * against a test double that answers every SELECT identically it never
 * terminates, spinning a core indefinitely (observed: three such processes at
 * ~97% CPU for 23 hours).
 *
 * It also contradicted the allocator's own rule -- keys are monotonic and gaps
 * are never reused -- so this takes the range maximum in one query and fails
 * closed when the range is exhausted.
 */
export async function nextUnissuedConversationKeyInRange(params: {
  start: number;
  endExclusive: number;
  atLeast?: number;
}): Promise<number> {
  const db = getDb();
  const start = normalizePositiveInt(params.start);
  const endExclusive = normalizePositiveInt(params.endExclusive);
  if (!db?.queryAsync || !start || !endExclusive || endExclusive <= start) {
    throw new Error("Invalid conversation key allocation range");
  }
  const floor = Math.max(start, normalizePositiveInt(params.atLeast) || start);
  const rows = (await db.queryAsync(
    `SELECT MAX(conversation_key) AS maxKey
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key >= ? AND conversation_key < ?`,
    [start, endExclusive],
  )) as Array<{ maxKey?: unknown }> | undefined;
  const maxIssued = normalizePositiveInt(rows?.[0]?.maxKey) || 0;
  const next = Math.max(floor, maxIssued + 1);
  if (next >= endExclusive) {
    throw new Error(
      `Conversation key range ${start}..${endExclusive} is exhausted`,
    );
  }
  return next;
}

export async function retireOrphanedConversationLedgerEntries(params: {
  system: ConversationSystem;
  kind: ConversationKeyLedgerKind;
  catalogTables: readonly string[];
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) return;
  const catalogTables = params.catalogTables
    .map((table) => table.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  if (!catalogTables.length) return;
  // Ask for the orphans directly instead of reading every live entry and
  // probing each catalog per row. This ran on every launch and cost roughly
  // (live conversations x catalogs) queries; it now costs one, and normally
  // returns nothing.
  //
  // Retirement is permanent with no automatic reversal, so absence of evidence
  // must not be read as evidence of absence: if this query cannot run at all
  // -- a missing table, a renamed column, a repair script mid-flight -- nothing
  // is retired. The previous per-row loop skipped failed probes and then
  // retired the key anyway, silently destroying live conversations.
  const notInAnyCatalog = catalogTables
    .map(
      (table) => `NOT EXISTS (
           SELECT 1 FROM ${table} c
           WHERE c.conversation_key = l.conversation_key
             AND c.conversation_instance_id = l.instance_id
         )`,
    )
    .join(" AND ");
  let rows: Array<{ conversationKey?: unknown; instanceID?: unknown }> = [];
  try {
    rows = ((await db.queryAsync(
      `SELECT l.conversation_key AS conversationKey,
              l.instance_id AS instanceID
       FROM ${KEY_LEDGER_TABLE} l
       WHERE l.system = ? AND l.kind = ? AND l.retired_at IS NULL
         AND ${notInAnyCatalog}`,
      [params.system, params.kind],
    )) || []) as Array<{ conversationKey?: unknown; instanceID?: unknown }>;
  } catch (error) {
    logLedger("LLM: skipping orphan retirement; catalogs unreadable", {
      system: params.system,
      kind: params.kind,
      error: String(error),
    });
    return;
  }
  for (const row of rows) {
    const key = normalizePositiveInt(row.conversationKey);
    const instanceID = normalizeText(row.instanceID, 128);
    if (!key || !instanceID) continue;
    // An orphan with surviving messages is not the crash artifact this pass
    // exists to clean up.  Retiring it would strand real user content behind a
    // permanently closed key, so leave it for identity repair instead.
    if (await conversationKeyHasMessages(key)) {
      logLedger("LLM: skipping orphan retirement; messages still exist", {
        conversationKey: key,
        system: params.system,
        kind: params.kind,
      });
      continue;
    }
    logLedger("LLM: retiring orphaned conversation key", {
      conversationKey: key,
      instanceID,
      system: params.system,
      kind: params.kind,
    });
    await retireConversationKeyInTransaction({
      conversationKey: key,
      instanceID,
      reason: "orphaned-ledger-allocation-after-crash",
    });
    rememberConversationKeyRetired(key);
    try {
      await db.queryAsync(
        `DELETE FROM llm_for_zotero_conversation_registry
         WHERE legacy_conversation_key = ? AND instance_id = ?`,
        [key, instanceID],
      );
    } catch (error) {
      if (!/no such table|no table/i.test(String(error))) throw error;
    }
  }
}

export async function updateConversationKeyLedgerConversationIDInTransaction(params: {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  const conversationID = normalizeText(params.conversationID, 512);
  if (!db?.queryAsync || !key || !instanceID || !conversationID) {
    throw new Error("Invalid conversation key ledger identity update");
  }
  await db.queryAsync(
    `UPDATE ${KEY_LEDGER_TABLE}
     SET conversation_id = ?
     WHERE conversation_key = ?
       AND instance_id = ?`,
    [conversationID, key, instanceID],
  );
}

export async function retireConversationKeyInTransaction(params: {
  conversationKey: number;
  instanceID: string;
  reason?: string;
  retiredAt?: number;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  if (!db?.queryAsync || !key || !instanceID) {
    throw new Error("Invalid conversation key retirement request");
  }
  const rows = (await db.queryAsync(
    `SELECT instance_id AS instanceID
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
     LIMIT 1`,
    [key],
  )) as Array<{ instanceID?: unknown }> | undefined;
  if (rows?.length && normalizeText(rows[0]?.instanceID, 128) !== instanceID) {
    throw new Error(
      `Refused to retire conversation key ${key}: identity mismatch`,
    );
  }
  if (!rows?.length) {
    throw new Error(
      `Refused to retire conversation key ${key}: ledger entry missing`,
    );
  }
  await db.queryAsync(
    `UPDATE ${KEY_LEDGER_TABLE}
     SET retired_at = COALESCE(retired_at, ?),
         retirement_reason = COALESCE(retirement_reason, ?)
     WHERE conversation_key = ?
       AND instance_id = ?`,
    [
      normalizePositiveInt(params.retiredAt) || Date.now(),
      normalizeText(params.reason, 256) || "conversation-deleted",
      key,
      instanceID,
    ],
  );
}

export async function assertConversationKeyLiveInTransaction(params: {
  conversationKey: number;
  instanceID: string;
}): Promise<void> {
  const db = getDb();
  const key = normalizePositiveInt(params.conversationKey);
  const instanceID = normalizeText(params.instanceID, 128);
  if (!db?.queryAsync || !key || !instanceID) {
    throw new Error("Invalid conversation identity");
  }
  const rows = (await db.queryAsync(
    `SELECT 1 AS live
     FROM ${KEY_LEDGER_TABLE}
     WHERE conversation_key = ?
       AND instance_id = ?
       AND retired_at IS NULL
     LIMIT 1`,
    [key, instanceID],
  )) as Array<{ live?: unknown }> | undefined;
  if (!rows?.length) {
    throw new ConversationRetiredError(key, instanceID);
  }
}

/**
 * Version of the database fence.  The version is part of every trigger name
 * whose predicate this module has changed, so a bump installs the new rules
 * and `dropSupersededConversationFenceTriggers` removes the old ones.  Without
 * that teardown the fence would be permanent and unrepairable: triggers live
 * in the Zotero database, not in the plugin, so uninstalling or downgrading
 * never removes them.
 */
export const CONVERSATION_FENCE_VERSION = 2;

/**
 * The fence rejects writes to a permanently retired conversation key.  That is
 * the invariant deletion actually depends on, and it is expressible against
 * `conversation_key` alone -- which is `INTEGER PRIMARY KEY` on the ledger, so
 * the check is a rowid seek rather than a scan of the catalogs.
 *
 * It deliberately does NOT require `conversation_instance_id`.  Exact identity
 * matching is enforced in application code (see `resolveUpstreamAppendIdentity`
 * and the equivalents in the Claude and Codex stores).  Requiring the column
 * here would reject writes from any build that predates it, which -- because
 * triggers outlive the plugin -- would make downgrading permanently break chat
 * storage with no in-app recovery.
 */
function retiredKeyPredicate(keyColumn: string): string {
  return `EXISTS (
         SELECT 1
         FROM ${KEY_LEDGER_TABLE} l
         WHERE l.conversation_key = NEW.${keyColumn}
           AND l.retired_at IS NOT NULL
       )`;
}

const RETIRED_KEY_ABORT_MESSAGE = "conversation key is permanently retired";

/**
 * True when an error is this module's own trigger rejecting a retired key, so
 * callers can rethrow it as `ConversationRetiredError` and keep the typed
 * error their existing handling expects.
 */
export function isRetiredKeyAbort(error: unknown): boolean {
  return new RegExp(RETIRED_KEY_ABORT_MESSAGE, "i").test(String(error));
}

/**
 * Run a conversation-owned write and translate the database fence's rejection
 * into the typed error callers already handle.  The fence is authoritative, so
 * a rejection also teaches the process-local retired set something it did not
 * know -- which is how a second surface in the same process learns that a key
 * was retired underneath it.
 */
export async function withRetiredKeyErrorMapping<T>(
  conversationKey: number,
  instanceID: string,
  task: () => Promise<T>,
): Promise<T> {
  try {
    return await task();
  } catch (error) {
    if (error instanceof ConversationRetiredError) throw error;
    if (!isRetiredKeyAbort(error)) throw error;
    const key = normalizePositiveInt(conversationKey);
    if (key) rememberConversationKeyRetired(key);
    throw new ConversationRetiredError(
      key || 0,
      normalizeText(instanceID, 128),
    );
  }
}

/**
 * Remove fence triggers from superseded versions.  `DROP TRIGGER IF EXISTS` is
 * a no-op when the trigger is absent, so this is safe to run unconditionally
 * on every store initialization and repairs a profile that already ran an
 * earlier fence.
 */
async function dropSupersededConversationFenceTriggers(
  tables: readonly string[],
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) return;
  for (const table of tables) {
    const safe = table.replace(/[^A-Za-z0-9_]/g, "");
    if (!safe) continue;
    for (const legacy of [
      // v1 catalog fence: required a live (key, instance) pair.
      `${safe}_conversation_key_ledger_insert`,
      `${safe}_conversation_key_ledger_update`,
      // v1 message fence: joined both catalogs through a UNION ALL subquery.
      `${safe}_conversation_identity_insert`,
      `${safe}_conversation_identity_update`,
      // v1 attachment fence: the "_live_" pair was subsumed by "_issued_".
      `${safe}_issued_conversation_insert`,
      `${safe}_issued_conversation_update`,
      `${safe}_live_conversation_insert`,
      `${safe}_live_conversation_update`,
      // v1 agent-run-events fence: required an issued conversation.
      `${safe}_live_run_insert`,
      `${safe}_live_run_update`,
    ]) {
      try {
        await db.queryAsync(`DROP TRIGGER IF EXISTS ${legacy}`);
      } catch (error) {
        // Never fatal. A test double without trigger support, or a database
        // that refuses the statement, leaves the superseded trigger in place --
        // no worse than before this teardown existed. Aborting store startup
        // over it would recreate the very failure mode F2 removed.
        logLedger("LLM: could not drop superseded fence trigger", {
          trigger: legacy,
          error: String(error),
        });
      }
    }
  }
}

export async function installConversationKeyLedgerCatalogTriggers(
  catalogTables: readonly string[],
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  await dropSupersededConversationFenceTriggers(catalogTables);
  for (const table of catalogTables) {
    const safeTable = table.replace(/[^A-Za-z0-9_]/g, "");
    const insertTrigger = `${safeTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_insert`;
    const updateTrigger = `${safeTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_update`;
    await db.queryAsync(
      `CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
       BEFORE INSERT ON ${safeTable}
       WHEN ${retiredKeyPredicate("conversation_key")}
       BEGIN
         SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
       END`,
    );
    await db.queryAsync(
      `CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
       BEFORE UPDATE OF conversation_key ON ${safeTable}
       WHEN ${retiredKeyPredicate("conversation_key")}
       BEGIN
         SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
       END`,
    );
  }
}

/**
 * Prevent message rows from being written into a permanently retired
 * conversation.  Runtime fences protect normal code paths; this trigger also
 * covers repair scripts, stale callbacks and direct SQL writes.
 */
export async function installConversationKeyLedgerMessageTriggers(params: {
  messageTable: string;
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) {
    throw new Error("Conversation key ledger DB is unavailable");
  }
  const messageTable = params.messageTable.replace(/[^A-Za-z0-9_]/g, "");
  if (!messageTable) return;
  await dropSupersededConversationFenceTriggers([messageTable]);
  const insertTrigger = `${messageTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_insert`;
  const updateTrigger = `${messageTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_update`;
  await db.queryAsync(
    `CREATE TRIGGER IF NOT EXISTS ${insertTrigger}
     BEFORE INSERT ON ${messageTable}
     WHEN ${retiredKeyPredicate("conversation_key")}
     BEGIN
       SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
     END`,
  );
  await db.queryAsync(
    `CREATE TRIGGER IF NOT EXISTS ${updateTrigger}
     BEFORE UPDATE OF conversation_key ON ${messageTable}
     WHEN ${retiredKeyPredicate("conversation_key")}
     BEGIN
       SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
     END`,
  );
}

/**
 * Install a single database-level fence for every conversation-owned agent
 * table.  These stores predate immutable instance IDs and therefore retain
 * their numeric key columns for compatibility; permanent key retirement is
 * the safety boundary for those legacy rows.  A late callback can still run,
 * but SQLite rejects it once the ledger marks the key retired.
 */
export async function installConversationKeyLedgerAgentTriggers(): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync) return;
  let rows: Array<{ name?: unknown }> | undefined;
  try {
    rows = (await db.queryAsync(
      `SELECT name FROM sqlite_master WHERE type = 'table'`,
    )) as Array<{ name?: unknown }> | undefined;
  } catch {
    // Non-SQLite test doubles and older Zotero DB wrappers do not expose the
    // catalog query.  Their normal runtime fences remain in effect.
    return;
  }
  const tables = new Set(
    (rows || [])
      .map((row) => (typeof row.name === "string" ? row.name : ""))
      .filter(Boolean),
  );
  const keyTables = [
    "llm_for_zotero_agent_memory",
    "llm_for_zotero_agent_transcript",
    "llm_for_zotero_agent_tool_result_handles",
    "llm_for_zotero_agent_evidence",
    "llm_for_zotero_agent_runs",
    "llm_for_zotero_agent_trace_exports",
  ];
  for (const table of keyTables) {
    if (!tables.has(table)) continue;
    const safe = table.replace(/[^A-Za-z0-9_]/g, "");
    try {
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${safe}_retired_key_insert
         BEFORE INSERT ON ${safe}
         WHEN EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = NEW.conversation_key
             AND l.retired_at IS NOT NULL
         )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${safe}_retired_key_update
         BEFORE UPDATE OF conversation_key ON ${safe}
         WHEN EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = NEW.conversation_key
             AND l.retired_at IS NOT NULL
         )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const coverageTable = "llm_for_zotero_agent_coverage";
  if (tables.has(coverageTable)) {
    try {
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${coverageTable}_retired_origin_insert
         BEFORE INSERT ON ${coverageTable}
         WHEN NEW.origin_conversation_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.origin_conversation_key
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${coverageTable}_retired_origin_update
         BEFORE UPDATE OF origin_conversation_key ON ${coverageTable}
         WHEN NEW.origin_conversation_key IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM ${KEY_LEDGER_TABLE} l
            WHERE l.conversation_key = NEW.origin_conversation_key
              AND l.retired_at IS NOT NULL
          )
         BEGIN
           SELECT RAISE(ABORT, 'conversation key is permanently retired');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const eventsTable = "llm_for_zotero_agent_run_events";
  const runsTable = "llm_for_zotero_agent_runs";
  if (tables.has(eventsTable) && tables.has(runsTable)) {
    await dropSupersededConversationFenceTriggers([eventsTable]);
    try {
      // Reject events for a run whose conversation was RETIRED, not for one the
      // ledger has merely never seen. The superseded rule required a live
      // ledger row, so an agent run on any conversation missing from the ledger
      // -- a lazily created store racing the seeding pass -- failed hard at the
      // database instead of being skipped, the same defect the attachment fence
      // had.
      const retiredRunConversation = `EXISTS (
           SELECT 1
           FROM ${runsTable} r
           JOIN ${KEY_LEDGER_TABLE} l
             ON l.conversation_key = r.conversation_key
            AND l.retired_at IS NOT NULL
           WHERE r.run_id = NEW.run_id
         )`;
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${eventsTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_insert
         BEFORE INSERT ON ${eventsTable}
         WHEN ${retiredRunConversation}
         BEGIN
           SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${eventsTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_update
         BEFORE UPDATE OF run_id ON ${eventsTable}
         WHEN ${retiredRunConversation}
         BEGIN
           SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }

  const refsTable = "llm_for_zotero_attachment_refs";
  if (tables.has(refsTable)) {
    await dropSupersededConversationFenceTriggers([refsTable]);
    try {
      // Attachment references predate immutable instance IDs and key their
      // owner by the numeric conversation key.  Retirement is the boundary
      // that matters: a ref must not attach to a conversation the user
      // deleted.  Requiring the owner to be *issued* (the superseded rule)
      // additionally rejected any owner the ledger had not seen yet, which
      // turned a lazily-initialized store racing the seeding pass into a hard
      // SQL failure rather than a soft skip.
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_insert
         BEFORE INSERT ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND ${retiredKeyPredicate("owner_id")}
         BEGIN
           SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
         END`,
      );
      await db.queryAsync(
        `CREATE TRIGGER IF NOT EXISTS ${refsTable}_conversation_fence_v${CONVERSATION_FENCE_VERSION}_update
         BEFORE UPDATE OF owner_type, owner_id ON ${refsTable}
         WHEN NEW.owner_type = 'conversation'
          AND ${retiredKeyPredicate("owner_id")}
         BEGIN
           SELECT RAISE(ABORT, '${RETIRED_KEY_ABORT_MESSAGE}');
         END`,
      );
    } catch (error) {
      if (!/no such table|no such column|unknown column/i.test(String(error))) {
        throw error;
      }
    }
  }
}

export async function seedConversationKeyLedgerFromCatalogs(
  catalogs: ReadonlyArray<{
    table: string;
    system: ConversationSystem;
    kind: ConversationKeyLedgerKind;
    kindColumn?: boolean;
  }>,
): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  for (const catalog of catalogs) {
    const table = catalog.table.replace(/[^A-Za-z0-9_]/g, "");
    let rows: Array<Record<string, unknown>> | undefined;
    try {
      rows = (await db.queryAsync(
        `SELECT conversation_key AS conversationKey,
                conversation_instance_id AS instanceID,
                conversation_id AS conversationID,
                library_id AS libraryID,
                ${catalog.kind === "paper" ? "paper_item_id" : "NULL"} AS paperItemID,
                COALESCE(last_activity_at, created_at, updated_at) AS issuedAt
         FROM ${table}
         WHERE ${catalog.kindColumn ? "kind = ? AND " : ""}NOT EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = ${table}.conversation_key
             AND (
               l.instance_id = ${table}.conversation_instance_id
               OR ${table}.conversation_instance_id IS NULL
               OR TRIM(${table}.conversation_instance_id) = ''
             )
         )`,
        catalog.kindColumn ? [catalog.kind] : undefined,
      )) as Array<Record<string, unknown>> | undefined;
    } catch (error) {
      if (/no such table|no table/i.test(String(error))) continue;
      if (!/no such column|unknown column/i.test(String(error))) throw error;
      rows = (await db.queryAsync(
        `SELECT conversation_key AS conversationKey,
                conversation_instance_id AS instanceID,
                conversation_id AS conversationID,
                library_id AS libraryID,
                ${catalog.kind === "paper" ? "paper_item_id" : "NULL"} AS paperItemID,
                created_at AS issuedAt
         FROM ${table}
         WHERE ${catalog.kindColumn ? "kind = ? AND " : ""}NOT EXISTS (
           SELECT 1 FROM ${KEY_LEDGER_TABLE} l
           WHERE l.conversation_key = ${table}.conversation_key
             AND (
               l.instance_id = ${table}.conversation_instance_id
               OR ${table}.conversation_instance_id IS NULL
               OR TRIM(${table}.conversation_instance_id) = ''
             )
         )`,
        catalog.kindColumn ? [catalog.kind] : undefined,
      )) as Array<Record<string, unknown>> | undefined;
    }
    for (const row of rows || []) {
      const key = normalizePositiveInt(row.conversationKey);
      const libraryID = normalizePositiveInt(row.libraryID);
      if (!key || !libraryID) continue;
      const instanceID =
        normalizeText(row.instanceID, 128) ||
        `legacy-instance:${catalog.system}:${catalog.kind}:${key}`;
      const conversationID =
        normalizeText(row.conversationID, 512) ||
        `legacy-conversation:${catalog.system}:${catalog.kind}:${key}`;
      const paperItemID = normalizePositiveInt(row.paperItemID) || undefined;
      try {
        await ensureConversationKeyLedgerEntryInTransaction({
          conversationKey: key,
          instanceID,
          conversationID,
          system: catalog.system,
          kind: catalog.kind,
          profileSignature: getCurrentProfileSignature(),
          libraryID,
          paperItemID,
          issuedAt: normalizePositiveInt(row.issuedAt) || Date.now(),
        });
      } catch (error) {
        // Two legacy witnesses claiming one numeric key cannot be repaired
        // safely. Preserve the conflicting witness durably and keep the
        // allocator moving; later identity repair can quarantine the owning
        // catalog without deleting user data or silently choosing a winner.
        await db.queryAsync(
          `INSERT INTO ${KEY_QUARANTINE_TABLE}
            (conversation_key, instance_id, conversation_id, system, kind,
             library_id, paper_item_id, reason, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            instanceID,
            conversationID,
            catalog.system,
            catalog.kind,
            libraryID,
            paperItemID || null,
            `conflicting-legacy-identity:${String(error)}`.slice(0, 512),
            Date.now(),
          ],
        );
      }
    }
  }
}

/** Reserve keys recorded by the durable deletion tombstone table even when
 * their catalog row was removed before this migration first ran. */
export async function seedConversationKeyLedgerFromTombstones(): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  let rows: Array<Record<string, unknown>> | undefined;
  try {
    rows = (await db.queryAsync(
      `SELECT conversation_key AS conversationKey,
              instance_id AS instanceID,
              deleted_at AS deletedAt
       FROM llm_for_zotero_conversation_deletion_tombstones`,
    )) as Array<Record<string, unknown>> | undefined;
  } catch (error) {
    if (/no such table|no table/i.test(String(error))) return;
    throw error;
  }
  for (const row of rows || []) {
    const key = normalizePositiveInt(row.conversationKey);
    const classification = key ? classifyConversationKey(key) : null;
    if (!key || !classification) continue;
    const instanceID =
      normalizeText(row.instanceID, 128) || `legacy-retired-instance:${key}`;
    const paperItemID = classification.kind === "paper" ? 1 : undefined;
    const existing = await getConversationKeyLedgerEntry(key);
    if (existing && existing.instanceID !== instanceID) {
      // A tombstone is evidence that this numeric key is retired, not a
      // license to overwrite the immutable ledger owner.  Preserve the
      // existing witness and leave the conflict for the quarantine sweep.
      await db.queryAsync(
        `INSERT INTO ${KEY_QUARANTINE_TABLE}
          (conversation_key, instance_id, conversation_id, system, kind,
           library_id, paper_item_id, reason, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          key,
          instanceID,
          null,
          classification.system,
          classification.kind,
          1,
          paperItemID || null,
          "tombstone-instance-conflicts-with-ledger-owner",
          Date.now(),
        ],
      );
      continue;
    }
    if (!existing) {
      await ensureConversationKeyLedgerEntryInTransaction({
        conversationKey: key,
        instanceID,
        conversationID: `legacy-retired-conversation:${key}`,
        system: classification.system,
        kind: classification.kind,
        profileSignature: getCurrentProfileSignature(),
        libraryID: 1,
        paperItemID,
        issuedAt: normalizePositiveInt(row.deletedAt) || Date.now(),
        retiredAt: normalizePositiveInt(row.deletedAt) || Date.now(),
        retirementReason: "legacy-deletion-tombstone",
      });
    }
    await retireConversationKeyInTransaction({
      conversationKey: key,
      instanceID,
      reason: "legacy-deletion-tombstone",
      retiredAt: normalizePositiveInt(row.deletedAt) || Date.now(),
    });
    rememberConversationKeyRetired(key);
  }
}

/**
 * Burn legacy message-only keys before any catalog/provisioning path can
 * allocate them.  A message row without a matching catalog is an
 * unverifiable ownership witness: it is preserved for forensic recovery, but
 * it must never be adopted by a newer conversation instance.
 */
export async function reserveOrphanConversationMessageKeys(params: {
  messageTable?: string;
  sourceTables?: ReadonlyArray<{
    table: string;
    column?: string;
    whereSql?: string;
  }>;
  catalogTables: string[];
  system: ConversationSystem;
}): Promise<void> {
  const db = getDb();
  if (!db?.queryAsync)
    throw new Error("Conversation key ledger DB is unavailable");
  const sourceTables = [
    ...(params.messageTable
      ? [{ table: params.messageTable, column: "conversation_key" }]
      : []),
    ...(params.sourceTables || []),
  ]
    .map((source) => ({
      table: source.table.replace(/[^A-Za-z0-9_]/g, ""),
      column: (source.column || "conversation_key").replace(
        /[^A-Za-z0-9_]/g,
        "",
      ),
      whereSql: source.whereSql || "",
    }))
    .filter((source) => source.table && source.column);
  const catalogTables = params.catalogTables
    .map((table) => table.replace(/[^A-Za-z0-9_]/g, ""))
    .filter(Boolean);
  const system = normalizeSystem(params.system);
  if (!sourceTables.length || !catalogTables.length || !system) return;
  const keys = new Set<number>();
  for (const source of sourceTables) {
    // Source stores do not all use the canonical `conversation_key` column:
    // coverage uses `origin_conversation_key`, attachment refs use `owner_id`,
    // and registry/search/fork tables use legacy/source/target witnesses.
    // Build the catalog anti-join against the normalized source column rather
    // than a hard-coded alias, otherwise those rows silently evade quarantine
    // (the query would fail with "no such column" and be treated as an absent
    // optional table/column).
    const catalogPredicate = catalogTables
      .map(
        (table) =>
          `NOT EXISTS (SELECT 1 FROM ${table} c${table} WHERE c${table}.conversation_key = s.${source.column})`,
      )
      .join(" AND ");
    let rows: Array<{ conversationKey?: unknown }> | undefined;
    try {
      rows = (await db.queryAsync(
        `SELECT DISTINCT s.${source.column} AS conversationKey
         FROM ${source.table} s
         WHERE s.${source.column} IS NOT NULL
           ${source.whereSql ? `AND ${source.whereSql}` : ""}
           AND ${catalogPredicate.replaceAll("m.", "s.")}`,
      )) as Array<{ conversationKey?: unknown }> | undefined;
    } catch (error) {
      if (/no such table|no table/i.test(String(error))) continue;
      if (/no such column|unknown column/i.test(String(error))) continue;
      throw error;
    }
    for (const row of rows || []) {
      const key = normalizePositiveInt(row.conversationKey);
      if (key) keys.add(key);
    }
  }
  for (const key of keys) {
    const classification = key ? classifyConversationKey(key) : null;
    if (!key || !classification || classification.system !== system) continue;
    const kind = classification.kind;
    const instanceID = `quarantined-orphan:${system}:${key}`;
    const conversationID = `quarantined-orphan-conversation:${system}:${key}`;
    const paperItemID = kind === "paper" ? 1 : undefined;
    const existing = await getConversationKeyLedgerEntry(key);
    if (existing) {
      if (!existing.retiredAt) {
        await db.queryAsync(
          `INSERT INTO ${KEY_QUARANTINE_TABLE}
            (conversation_key, instance_id, conversation_id, system, kind,
             library_id, paper_item_id, reason, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            key,
            existing.instanceID,
            existing.conversationID,
            existing.system,
            existing.kind,
            existing.libraryID,
            existing.paperItemID || null,
            "orphan-message-row-without-catalog",
            Date.now(),
          ],
        );
      }
      continue;
    }
    await ensureConversationKeyLedgerEntryInTransaction({
      conversationKey: key,
      instanceID,
      conversationID,
      system,
      kind,
      profileSignature: getCurrentProfileSignature(),
      libraryID: 1,
      paperItemID,
      issuedAt: Date.now(),
      retiredAt: Date.now(),
      retirementReason: "orphan-message-row-without-catalog",
    });
    rememberConversationKeyRetired(key);
  }
}

export type ConversationKeyQuarantineEntry = {
  conversationKey: number;
  instanceID: string;
  conversationID: string;
  system: string;
  kind: string;
  reason: string;
  observedAt: number;
};

/**
 * Read the identity quarantine.  Migration writes to this table in three
 * places and nothing ever read it back, so a conversation that landed here was
 * invisible: neither deleted nor reachable, with no signal anywhere. Exposing
 * it is the difference between a diagnosable state and a silent dead end.
 */
export async function getConversationKeyQuarantineEntries(): Promise<
  ConversationKeyQuarantineEntry[]
> {
  const db = getDb();
  if (!db?.queryAsync) return [];
  try {
    const rows = (await db.queryAsync(
      `SELECT conversation_key AS conversationKey,
              instance_id AS instanceID,
              conversation_id AS conversationID,
              system,
              kind,
              reason,
              observed_at AS observedAt
       FROM ${KEY_QUARANTINE_TABLE}
       ORDER BY observed_at DESC`,
    )) as Array<Record<string, unknown>> | undefined;
    return (rows || []).flatMap((row) => {
      const conversationKey = normalizePositiveInt(row.conversationKey);
      if (!conversationKey) return [];
      return [
        {
          conversationKey,
          instanceID: normalizeText(row.instanceID, 128),
          conversationID: normalizeText(row.conversationID, 512),
          system: normalizeText(row.system, 32),
          kind: normalizeText(row.kind, 32),
          reason: normalizeText(row.reason, 512),
          observedAt: normalizePositiveInt(row.observedAt) || 0,
        },
      ];
    });
  } catch (error) {
    if (/no such table|no table/i.test(String(error))) return [];
    throw error;
  }
}

/**
 * Log a one-line summary of quarantined identities so a user reporting
 * "my conversation vanished" has something actionable in the log.
 */
export async function logConversationKeyQuarantineSummary(): Promise<number> {
  try {
    const entries = await getConversationKeyQuarantineEntries();
    if (!entries.length) return 0;
    logLedger("LLM: conversation identities are quarantined", {
      count: entries.length,
      keys: entries.slice(0, 20).map((entry) => entry.conversationKey),
      reasons: Array.from(new Set(entries.map((entry) => entry.reason))).slice(
        0,
        5,
      ),
    });
    return entries.length;
  } catch (error) {
    logLedger("LLM: could not read the conversation identity quarantine", {
      error: String(error),
    });
    return 0;
  }
}

export const CONVERSATION_KEY_LEDGER_TABLE = KEY_LEDGER_TABLE;
export const CONVERSATION_KEY_COUNTERS_TABLE = KEY_COUNTERS_TABLE;
export const CONVERSATION_KEY_QUARANTINE_TABLE = KEY_QUARANTINE_TABLE;
