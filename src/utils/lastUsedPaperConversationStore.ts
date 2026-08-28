import { config } from "../../package.json";
import { UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE } from "../shared/conversationKeySpace";

type ZoteroDb = {
  queryAsync: (sql: string, params?: unknown[]) => Promise<unknown>;
  executeTransaction: (task: () => Promise<unknown>) => Promise<unknown>;
};

type ZoteroPrefs = {
  get?: (key: string, global?: boolean) => unknown;
  clear?: (key: string, global?: boolean) => void;
};

type LastUsedPaperConversationRow = {
  libraryID?: unknown;
  paperItemID?: unknown;
  conversationKey?: unknown;
};

export const LAST_USED_PAPER_CONVERSATIONS_TABLE =
  "llm_for_zotero_last_used_paper_conversations";

const LEGACY_PREF_KEY = `${config.prefsPrefix}.lastUsedPaperConversationMap`;

let lastUsedByPaper = new Map<string, number>();
let cachePrimed = false;
let storeInitialized = false;
let initializationTask: Promise<void> | null = null;
let pendingWrites: Promise<void> = Promise.resolve();

function getZoteroDb(): ZoteroDb | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { DB?: ZoteroDb } }).Zotero
      ?.DB || null
  );
}

function getZoteroPrefs(): ZoteroPrefs | null {
  return (
    (globalThis as typeof globalThis & { Zotero?: { Prefs?: ZoteroPrefs } })
      .Zotero?.Prefs || null
  );
}

function normalizePositiveInteger(value: unknown): number | null {
  const normalized = Math.floor(Number(value));
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function normalizeConversationKey(value: unknown): number | null {
  const normalized = normalizePositiveInteger(value);
  return normalized && normalized < UPSTREAM_GLOBAL_CONVERSATION_KEY_BASE
    ? normalized
    : null;
}

function buildStateKey(libraryID: number, paperItemID: number): string {
  return `${libraryID}:${paperItemID}`;
}

function parseStateKey(
  value: string,
): { libraryID: number; paperItemID: number } | null {
  const match = /^(\d+):(\d+)$/.exec(value);
  if (!match) return null;
  const libraryID = normalizePositiveInteger(match[1]);
  const paperItemID = normalizePositiveInteger(match[2]);
  return libraryID && paperItemID ? { libraryID, paperItemID } : null;
}

function readLegacyPreference(): Map<string, number> {
  const raw = getZoteroPrefs()?.get?.(LEGACY_PREF_KEY, true);
  if (typeof raw !== "string" || !raw.trim()) return new Map();
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Map();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return new Map();
  }
  const entries = new Map<string, number>();
  for (const [stateKey, value] of Object.entries(parsed)) {
    const identity = parseStateKey(stateKey);
    const conversationKey = normalizeConversationKey(value);
    if (!identity || !conversationKey) continue;
    entries.set(
      buildStateKey(identity.libraryID, identity.paperItemID),
      conversationKey,
    );
  }
  return entries;
}

function primeCacheFromLegacyPreference(): void {
  if (cachePrimed) return;
  lastUsedByPaper = readLegacyPreference();
  cachePrimed = true;
}

function reportWriteFailure(error: unknown): void {
  const logger = (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log;
  logger?.("LLM: Failed to persist last-used paper conversation", error);
}

function enqueueWrite(task: () => Promise<unknown>): void {
  if (!storeInitialized) return;
  pendingWrites = pendingWrites
    .then(async () => {
      await task();
    })
    .catch(reportWriteFailure);
}

async function initializeStore(): Promise<void> {
  primeCacheFromLegacyPreference();
  const db = getZoteroDb();
  if (!db) throw new Error("Zotero DB is unavailable");

  await db.queryAsync(
    `CREATE TABLE IF NOT EXISTS ${LAST_USED_PAPER_CONVERSATIONS_TABLE} (
      library_id INTEGER NOT NULL,
      paper_item_id INTEGER NOT NULL,
      conversation_key INTEGER NOT NULL,
      PRIMARY KEY (library_id, paper_item_id)
    )`,
  );

  if (lastUsedByPaper.size > 0) {
    await db.executeTransaction(async () => {
      for (const [stateKey, conversationKey] of lastUsedByPaper) {
        const identity = parseStateKey(stateKey);
        if (!identity) continue;
        await db.queryAsync(
          `INSERT OR IGNORE INTO ${LAST_USED_PAPER_CONVERSATIONS_TABLE}
             (library_id, paper_item_id, conversation_key)
           VALUES (?, ?, ?)`,
          [identity.libraryID, identity.paperItemID, conversationKey],
        );
      }
    });
  }

  const rows = (await db.queryAsync(
    `SELECT library_id AS libraryID,
            paper_item_id AS paperItemID,
            conversation_key AS conversationKey
     FROM ${LAST_USED_PAPER_CONVERSATIONS_TABLE}`,
  )) as LastUsedPaperConversationRow[] | undefined;
  const loaded = new Map<string, number>();
  for (const row of rows || []) {
    const libraryID = normalizePositiveInteger(row.libraryID);
    const paperItemID = normalizePositiveInteger(row.paperItemID);
    const conversationKey = normalizeConversationKey(row.conversationKey);
    if (!libraryID || !paperItemID || !conversationKey) continue;
    loaded.set(buildStateKey(libraryID, paperItemID), conversationKey);
  }
  lastUsedByPaper = loaded;
  getZoteroPrefs()?.clear?.(LEGACY_PREF_KEY, true);
  storeInitialized = true;
}

export function initLastUsedPaperConversationStore(): Promise<void> {
  if (storeInitialized) return Promise.resolve();
  if (!initializationTask) {
    initializationTask = initializeStore().catch((error) => {
      initializationTask = null;
      throw error;
    });
  }
  return initializationTask;
}

export function readLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): number | null {
  primeCacheFromLegacyPreference();
  return lastUsedByPaper.get(buildStateKey(libraryID, paperItemID)) || null;
}

export function writeLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
  conversationKey: number,
): void {
  primeCacheFromLegacyPreference();
  const stateKey = buildStateKey(libraryID, paperItemID);
  lastUsedByPaper.set(stateKey, conversationKey);
  enqueueWrite(() =>
    getZoteroDb()!.queryAsync(
      `INSERT INTO ${LAST_USED_PAPER_CONVERSATIONS_TABLE}
         (library_id, paper_item_id, conversation_key)
       VALUES (?, ?, ?)
       ON CONFLICT(library_id, paper_item_id) DO UPDATE SET
         conversation_key = excluded.conversation_key`,
      [libraryID, paperItemID, conversationKey],
    ),
  );
}

export function deleteLastUsedPaperConversationKey(
  libraryID: number,
  paperItemID: number,
): void {
  primeCacheFromLegacyPreference();
  const stateKey = buildStateKey(libraryID, paperItemID);
  if (!lastUsedByPaper.delete(stateKey)) return;
  enqueueWrite(() =>
    getZoteroDb()!.queryAsync(
      `DELETE FROM ${LAST_USED_PAPER_CONVERSATIONS_TABLE}
       WHERE library_id = ? AND paper_item_id = ?`,
      [libraryID, paperItemID],
    ),
  );
}

export async function flushLastUsedPaperConversationWritesForTests(): Promise<void> {
  await pendingWrites;
}

export function clearLastUsedPaperConversationKeysForTests(): void {
  primeCacheFromLegacyPreference();
  lastUsedByPaper.clear();
  enqueueWrite(() =>
    getZoteroDb()!.queryAsync(
      `DELETE FROM ${LAST_USED_PAPER_CONVERSATIONS_TABLE}`,
    ),
  );
}

export function resetLastUsedPaperConversationStoreForTests(): void {
  lastUsedByPaper.clear();
  cachePrimed = false;
  storeInitialized = false;
  initializationTask = null;
  pendingWrites = Promise.resolve();
}
