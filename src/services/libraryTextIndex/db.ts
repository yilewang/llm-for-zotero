/**
 * The library text index lives in its own SQLite file opened through a
 * separate `Zotero.DBConnection`. Schema work on `Zotero.DB` shares Zotero's
 * single storage thread and stalls sync (#485, see
 * src/shared/startupSchemaFingerprint.ts), so nothing here may touch
 * `Zotero.DB`.
 */

import { appLogger, getMaintenanceQueryOptions } from "../../core/logging";
import { joinLocalPath } from "../../utils/localPath";
import {
  LIBRARY_TEXT_INDEX_DB_NAME,
  LIBRARY_TEXT_INDEX_SCHEMA_VERSION,
} from "./constants";

export type LibraryTextIndexDb = {
  queryAsync: (
    sql: string,
    params?: unknown[],
    options?: { debug?: boolean },
  ) => Promise<unknown>;
  executeTransaction: <T>(fn: () => Promise<T>) => Promise<T>;
  closeDatabase?: (permanent?: boolean) => Promise<void>;
};

type ZoteroWithConnection = {
  DBConnection?: new (dbNameOrPath: string) => LibraryTextIndexDb;
  DataDirectory?: { dir?: string };
};

let connection: LibraryTextIndexDb | null = null;
let testOverride: LibraryTextIndexDb | null = null;
let openPromise: Promise<LibraryTextIndexDb | null> | null = null;
/** True while the files are being deleted; opens are refused meanwhile. */
let deletingFiles = false;
/** Set when Zotero quits: a late search or job must not open a new handle. */
let quitting = false;

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS documents (
     attachment_id INTEGER PRIMARY KEY,
     attachment_key TEXT NOT NULL,
     library_id INTEGER NOT NULL,
     parent_item_id INTEGER,
     title TEXT NOT NULL,
     source_type TEXT NOT NULL,
     source_fingerprint TEXT NOT NULL,
     source_mtime INTEGER,
     source_size INTEGER,
     chunker_version INTEGER NOT NULL,
     chunk_count INTEGER NOT NULL,
     total_tokens INTEGER NOT NULL,
     byte_estimate INTEGER NOT NULL DEFAULT 0,
     last_used_at INTEGER NOT NULL DEFAULT 0,
     indexed_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS documents_library_idx ON documents (library_id)`,
  `CREATE INDEX IF NOT EXISTS documents_last_used_idx ON documents (last_used_at)`,
  `CREATE TABLE IF NOT EXISTS chunks (
     attachment_id INTEGER NOT NULL,
     chunk_index INTEGER NOT NULL,
     text TEXT NOT NULL,
     token_count INTEGER NOT NULL,
     meta_json TEXT NOT NULL,
     PRIMARY KEY (attachment_id, chunk_index)
   )`,
  `CREATE TABLE IF NOT EXISTS postings (
     term TEXT NOT NULL,
     attachment_id INTEGER NOT NULL,
     hits_json TEXT NOT NULL,
     hit_count INTEGER NOT NULL,
     PRIMARY KEY (term, attachment_id)
   )`,
  `CREATE INDEX IF NOT EXISTS postings_attachment_idx ON postings (attachment_id)`,
  `CREATE TABLE IF NOT EXISTS queue (
     attachment_id INTEGER PRIMARY KEY,
     library_id INTEGER NOT NULL,
     priority INTEGER NOT NULL,
     reason TEXT NOT NULL,
     enqueued_at INTEGER NOT NULL,
     attempts INTEGER NOT NULL DEFAULT 0,
     next_attempt_at INTEGER NOT NULL DEFAULT 0,
     last_error TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS vector_documents (
     attachment_id INTEGER NOT NULL,
     namespace TEXT NOT NULL,
     dims INTEGER NOT NULL,
     chunk_count INTEGER NOT NULL,
     path TEXT NOT NULL,
     source_fingerprint TEXT NOT NULL,
     indexed_at INTEGER NOT NULL,
     PRIMARY KEY (attachment_id, namespace)
   )`,
];
const TABLES = [
  "postings",
  "chunks",
  "vector_documents",
  "queue",
  "documents",
  "index_meta",
];

function getZotero(): ZoteroWithConnection | undefined {
  return (globalThis as { Zotero?: ZoteroWithConnection }).Zotero;
}

export function getLibraryTextIndexDbPath(): string {
  const dir = getZotero()?.DataDirectory?.dir;
  if (typeof dir !== "string" || !dir.trim()) {
    throw new Error("Cannot resolve data directory for the library text index");
  }
  return joinLocalPath(dir.trim(), `${LIBRARY_TEXT_INDEX_DB_NAME}.sqlite`);
}

export async function ensureLibraryTextIndexSchema(
  db: LibraryTextIndexDb,
): Promise<void> {
  const q = (sql: string, params?: unknown[]) =>
    db.queryAsync(sql, params, getMaintenanceQueryOptions());
  await q(SCHEMA_SQL[0]);
  const rows = (await q(
    `SELECT value FROM index_meta WHERE key = 'schema_version'`,
  )) as Array<{ value: string }>;
  const recorded = rows[0] ? Number(rows[0].value) : null;
  if (recorded !== null && recorded !== LIBRARY_TEXT_INDEX_SCHEMA_VERSION) {
    appLogger.info(
      `LLM index: schema ${recorded} -> ${LIBRARY_TEXT_INDEX_SCHEMA_VERSION}, rebuilding`,
    );
    for (const table of TABLES) await q(`DROP TABLE IF EXISTS ${table}`);
  }
  for (const sql of SCHEMA_SQL) await q(sql);
  await q(
    `INSERT OR REPLACE INTO index_meta (key, value) VALUES ('schema_version', ?)`,
    [String(LIBRARY_TEXT_INDEX_SCHEMA_VERSION)],
  );
}

export function setLibraryTextIndexDbForTests(
  db: LibraryTextIndexDb | null,
): void {
  testOverride = db;
  connection = null;
  openPromise = null;
}

export async function openLibraryTextIndexDb(): Promise<LibraryTextIndexDb | null> {
  // A connection opened mid-delete would keep writing to an unlinked file,
  // and SQLite's shared cache would make the next open of the path read-only.
  if (deletingFiles || quitting) return null;
  if (testOverride) {
    await ensureLibraryTextIndexSchema(testOverride);
    return testOverride;
  }
  if (connection) return connection;
  if (openPromise) return openPromise;
  openPromise = (async () => {
    const zotero = getZotero();
    if (!zotero?.DBConnection) {
      // Not a failure (tests, stripped hosts): openPromise stays resolved to
      // null, so the session asks once and every caller takes the direct path.
      appLogger.debug(
        "LLM index: Zotero.DBConnection unavailable; library text index disabled",
      );
      return null;
    }
    let raw: LibraryTextIndexDb | null = null;
    try {
      // An absolute path makes Zotero treat this as an external database. A
      // bare name gets Zotero's main-database routine: after an unclean
      // shutdown it runs an integrity check behind the pane-wide progress
      // meter and never clears it (Zotero.locked then swallows every
      // keystroke), and it schedules idle-time .bak backups of the file.
      const constructed = new zotero.DBConnection(getLibraryTextIndexDbPath());
      raw = constructed;
      // Call as methods: Zotero's connection reads `this._callbacks` inside
      // executeTransaction (see the note in utils/usageHistoryBackfill.ts).
      const db: LibraryTextIndexDb = {
        queryAsync: (sql, params, options) =>
          constructed.queryAsync(sql, params, options),
        executeTransaction: (fn) => constructed.executeTransaction(fn),
        closeDatabase: constructed.closeDatabase
          ? (permanent) => constructed.closeDatabase!(permanent)
          : undefined,
      };
      await ensureLibraryTextIndexSchema(db);
      connection = db;
      return db;
    } catch (error) {
      if (raw?.closeDatabase) {
        try {
          await raw.closeDatabase(true);
        } catch (closeError) {
          appLogger.debug(
            "LLM index: failed to close the library text index database after open failure",
            closeError,
          );
        }
      }
      appLogger.warn(
        "LLM index: failed to open the library text index database",
        error,
      );
      openPromise = null;
      return null;
    }
  })();
  return openPromise;
}

/**
 * Refuses every later open for the rest of this session. Zotero's exit waits
 * for each open Sqlite connection, so a handle opened after the quit-time
 * close would hold the process alive until AsyncShutdown force-kills it.
 */
export function refuseLibraryTextIndexOpensForQuit(): void {
  quitting = true;
}

export function resetLibraryTextIndexQuitForTests(): void {
  quitting = false;
}

export async function closeLibraryTextIndexDb(
  options: { throwOnError?: boolean } = {},
): Promise<void> {
  // An open racing shutdown must finish first, or its handle leaks.
  const pending = openPromise;
  if (!connection && pending) {
    try {
      await pending;
    } catch {
      // The open failed; there is nothing to close.
    }
  }
  const db = connection;
  connection = null;
  openPromise = null;
  if (db?.closeDatabase) {
    try {
      // Permanent: Zotero's non-permanent close lets the next query on this
      // object silently reopen an untracked handle (a late fire-and-forget
      // write, an abandoned job). Late queries now throw
      // (isLibraryTextIndexClosedError); the next open builds a new connection.
      await db.closeDatabase(true);
    } catch (error) {
      appLogger.debug("LLM index: close failed", error);
      // Production shutdown remains best-effort; owned test fixtures must
      // surface failed disposal rather than reporting a successful teardown.
      if (options.throwOnError) throw error;
    }
  }
}

/**
 * The error a query on a permanently closed connection throws (Zotero's
 * "Database permanently closed; not re-opening"). Late work that races a
 * stop or a Clear hits it; callers treat it as "the index went away", not as
 * a failure worth a warning.
 */
export function isLibraryTextIndexClosedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /permanently closed/i.test(message);
}

type FileRemover = {
  remove?: (
    path: string,
    options?: { ignoreAbsent?: boolean },
  ) => Promise<void>;
};

/**
 * Deletes the index database file and its `-wal`/`-shm`/`-journal`
 * companions; absent files are fine. Stop the scheduler first (a job
 * mid-write must finish). Opens are refused until the delete ends, and any
 * connection opened since the caller's close is closed here, so no handle
 * survives on an unlinked file.
 */
export async function deleteLibraryTextIndexDatabaseFiles(): Promise<void> {
  deletingFiles = true;
  try {
    await closeLibraryTextIndexDb();
    await removeDatabaseFiles();
  } finally {
    deletingFiles = false;
  }
}

async function removeDatabaseFiles(): Promise<void> {
  const path = getLibraryTextIndexDbPath();
  const scope = globalThis as {
    IOUtils?: FileRemover;
    OS?: { File?: FileRemover };
  };
  const remover = scope.IOUtils?.remove
    ? scope.IOUtils
    : scope.OS?.File?.remove
      ? scope.OS.File
      : null;
  if (!remover?.remove) return;
  // WAL companions, and the rollback journal external databases use.
  for (const file of [path, `${path}-wal`, `${path}-shm`, `${path}-journal`]) {
    await remover.remove(file, { ignoreAbsent: true });
  }
}
