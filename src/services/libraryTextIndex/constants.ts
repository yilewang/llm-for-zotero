export const LIBRARY_TEXT_INDEX_DB_NAME = "llm-for-zotero-index";
export const LIBRARY_TEXT_INDEX_SCHEMA_VERSION = 1;
/**
 * 2: chunks carry their enclosing standard section (`enclosingSection`).
 * 3: same chunk boundaries as 2, and the postings hold index terms (stems).
 * An older build expects 2, so it sees 3 as stale and re-indexes from the
 * PDF with its own tokenizer; this build re-posts a version 2 document from
 * its stored chunks instead (`isChunkerVersionStale`).
 */
export const LIBRARY_TEXT_INDEX_CHUNKER_VERSION = 3;
/** The last version whose chunk boundaries equal the current ones. */
export const LIBRARY_TEXT_INDEX_POSTINGS_ONLY_CHUNKER_VERSION = 2;
/** True when a document's chunks must be rebuilt from the source. */
export function isChunkerVersionStale(version: number): boolean {
  return (
    version !== LIBRARY_TEXT_INDEX_CHUNKER_VERSION &&
    version !== LIBRARY_TEXT_INDEX_POSTINGS_ONLY_CHUNKER_VERSION
  );
}
/**
 * What the postings' terms are. 1 (no `tokenizer_version` row in
 * `index_meta`): surface tokens. 2: index terms, the Porter stems of plain
 * English words (`toRetrievalIndexTerm`). A change re-posts every document
 * from its stored chunk text (tokenizerUpgrade.ts): no PDF read, the chunk
 * boundaries and vectors stay.
 */
export const LIBRARY_TEXT_INDEX_TOKENIZER_VERSION = 2;
export const TOKENIZER_VERSION_META_KEY = "tokenizer_version";
/** One drain step re-posts documents for about this long, then yields. */
export const INDEX_REPOST_SLICE_MS = 50;
export const INDEX_DRAIN_GAP_MS = 250;
export const INDEX_DRAIN_GAP_BUSY_MS = 2000;
export const INDEX_MAX_ATTEMPTS = 3;
export const MAX_UNINDEXED_FALLBACK_PAPERS = 5;
export const INDEX_COVERAGE_SKIP_PROBES_RATIO = 0.9;
export const INDEX_PLANNER_SOFT_DEADLINE_MS = 4000;
export const MAX_QUERY_TERMS = 32;
export const VECTOR_TOP_HITS = 200;
export const EMBEDDING_CONCURRENCY = 3;
export const INDEX_BUDGET_MB_DEFAULT = 500;
/** The smallest size limit the settings pane accepts and the scheduler honours. */
export const INDEX_BUDGET_MB_MIN = 50;
export const INDEX_BUDGET_SOFT_RATIO = 0.9; // prefetch stops enqueueing above this share of the budget
export const INDEX_USER_IDLE_SECONDS = 60;
export const INDEX_RETRY_BACKOFF_MS = [60_000, 600_000, 3_600_000] as const; // attempt 1, 2, 3
export const INDEX_RECONCILE_STAT_BATCH = 50;
export const INDEX_RECENT_USE_PROTECT_MS = 60 * 60 * 1000; // never evict a paper searched within the last hour
export const INDEX_PRIORITY = {
  prefetch: 0,
  chunkerVersion: 1,
  stale: 2,
  mineruUpgrade: 2,
  textInvalidated: 5,
  added: 9,
  modified: 9,
  writeThrough: 10,
} as const;
export const INDEX_URGENT_MIN_PRIORITY = 5; // >= this drains regardless of user idle
export const INDEX_URGENT_ADD_BATCH_MAX = 20; // a larger notifier add batch (e.g. an initial sync) goes to prefetch
export const INDEX_STOP_GRACE_MS = 10_000; // stop() waits this long for an in-flight job before closing
