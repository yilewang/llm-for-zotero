import { getMaintenanceQueryOptions } from "../../core/logging";
import type { PdfChunkMeta } from "../paperContent/types";
import {
  INDEX_MAX_ATTEMPTS,
  INDEX_RETRY_BACKOFF_MS,
  LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
  LIBRARY_TEXT_INDEX_POSTINGS_ONLY_CHUNKER_VERSION,
  LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
} from "./constants";
import { openLibraryTextIndexDb, type LibraryTextIndexDb } from "./db";

export type StoredChunkMeta = Pick<
  PdfChunkMeta,
  | "sectionLabel"
  | "sectionIndex"
  | "sectionPath"
  | "sectionLevel"
  | "enclosingSection"
  | "chunkKind"
  | "kindSource"
  | "pageStart"
  | "pageEnd"
  | "sourceStart"
  | "sourceEnd"
  | "sourceFingerprint"
  | "anchorText"
>;
export type IndexDocumentInput = {
  attachmentId: number;
  attachmentKey: string;
  libraryID: number;
  parentItemId: number | null;
  title: string;
  sourceType: string;
  sourceFingerprint: string;
  sourceMtime: number | null;
  sourceSize: number | null;
  chunkerVersion: number;
  byteEstimate: number;
  chunks: Array<{
    chunkIndex: number;
    text: string;
    tokenCount: number;
    meta: StoredChunkMeta;
    tf: Record<string, number>;
  }>;
};
export type IndexDocumentRow = {
  attachmentId: number;
  attachmentKey: string;
  libraryID: number;
  parentItemId: number | null;
  title: string;
  sourceType: string;
  sourceFingerprint: string;
  sourceMtime: number | null;
  sourceSize: number | null;
  chunkerVersion: number;
  chunkCount: number;
  totalTokens: number;
  byteEstimate: number;
  lastUsedAt: number;
  indexedAt: number;
};
export type PostingRow = {
  term: string;
  attachmentId: number;
  hits: Array<[chunkIndex: number, tf: number, tokenCount: number]>;
};
export type StoredChunk = {
  attachmentId: number;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  meta: StoredChunkMeta;
  title: string;
  parentItemId: number | null;
  sourceType: string;
};
export type CorpusStats = {
  chunkCount: number;
  avgTokens: number;
  documentCount: number;
};
export type VectorDocumentInput = {
  attachmentId: number;
  namespace: string;
  dims: number;
  chunkCount: number;
  path: string;
  sourceFingerprint: string;
};
export type VectorDocumentRow = {
  attachmentId: number;
  dims: number;
  chunkCount: number;
  path: string;
  sourceFingerprint: string;
};
export type QueueRow = {
  attachmentId: number;
  libraryID: number;
  priority: number;
  reason: string;
  enqueuedAt: number;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
};

const SQL_CHUNK = 400; // parameters per IN (...) query; SQLite's default limit is 999

function chunked<T>(items: T[], size = SQL_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size));
  return out;
}

export class LibraryTextIndexStore {
  private stats: CorpusStats | null = null;
  /** Session-only cache of a true answer: nothing here writes older postings. */
  private tokenizerCurrent = false;
  constructor(private readonly db: LibraryTextIndexDb) {}

  /**
   * True when no document needs re-posting (tokenizerUpgrade.ts). The global
   * meta row is informational only: an older build can re-index documents
   * after it was written, so this re-checks the per-document markers once per
   * session.
   */
  async isTokenizerVersionCurrent(): Promise<boolean> {
    if (this.tokenizerCurrent) return true;
    const pending = await this.listDocumentsNeedingRepost(
      LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
      1,
    );
    this.tokenizerCurrent = pending.length === 0;
    return this.tokenizerCurrent;
  }

  private q(sql: string, params?: unknown[]): Promise<unknown> {
    return this.db.queryAsync(sql, params, getMaintenanceQueryOptions());
  }

  /**
   * Writes a document, its chunks and its postings in one transaction. Every
   * `tf` comes from `buildChunkIndex` (index terms), so the document is
   * recorded at the current tokenizer version.
   */
  async upsertDocument(doc: IndexDocumentInput): Promise<void> {
    const now = Date.now();
    const byTerm = new Map<string, Array<[number, number, number]>>();
    for (const chunk of doc.chunks) {
      for (const term of Object.keys(chunk.tf)) {
        const hits = byTerm.get(term) || [];
        hits.push([chunk.chunkIndex, chunk.tf[term], chunk.tokenCount]);
        byTerm.set(term, hits);
      }
    }
    const totalTokens = doc.chunks.reduce((sum, c) => sum + c.tokenCount, 0);
    await this.db.executeTransaction(async () => {
      await this.q(`DELETE FROM postings WHERE attachment_id = ?`, [
        doc.attachmentId,
      ]);
      await this.q(`DELETE FROM chunks WHERE attachment_id = ?`, [
        doc.attachmentId,
      ]);
      await this.q(
        `INSERT INTO documents (attachment_id, attachment_key, library_id, parent_item_id, title, source_type, source_fingerprint, source_mtime, source_size, chunker_version, chunk_count, total_tokens, byte_estimate, last_used_at, indexed_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(attachment_id) DO UPDATE SET attachment_key = excluded.attachment_key, library_id = excluded.library_id, parent_item_id = excluded.parent_item_id, title = excluded.title, source_type = excluded.source_type, source_fingerprint = excluded.source_fingerprint, source_mtime = excluded.source_mtime, source_size = excluded.source_size, chunker_version = excluded.chunker_version, chunk_count = excluded.chunk_count, total_tokens = excluded.total_tokens, byte_estimate = excluded.byte_estimate, indexed_at = excluded.indexed_at`,
        [
          doc.attachmentId,
          doc.attachmentKey,
          doc.libraryID,
          doc.parentItemId,
          doc.title,
          doc.sourceType,
          doc.sourceFingerprint,
          doc.sourceMtime,
          doc.sourceSize,
          doc.chunkerVersion,
          doc.chunks.length,
          totalTokens,
          doc.byteEstimate,
          now,
          now,
        ],
      );
      for (const chunk of doc.chunks) {
        await this.q(
          `INSERT INTO chunks (attachment_id, chunk_index, text, token_count, meta_json) VALUES (?,?,?,?,?)`,
          [
            doc.attachmentId,
            chunk.chunkIndex,
            chunk.text,
            chunk.tokenCount,
            JSON.stringify(chunk.meta),
          ],
        );
      }
      for (const [term, hits] of byTerm) {
        await this.q(
          `INSERT INTO postings (term, attachment_id, hits_json, hit_count) VALUES (?,?,?,?)`,
          [term, doc.attachmentId, JSON.stringify(hits), hits.length],
        );
      }
      await this.q(
        `INSERT OR REPLACE INTO document_tokenizer (attachment_id, tokenizer_version, indexed_at) VALUES (?, ?, ?)`,
        [doc.attachmentId, LIBRARY_TEXT_INDEX_TOKENIZER_VERSION, now],
      );
    });
    this.stats = null;
  }

  /**
   * Documents whose postings were not written at `tokenizerVersion` (no
   * marker row, another version, or a marker older than the document's last
   * indexing, which means an older build re-indexed it), lowest attachment id first.
   */
  async listDocumentsNeedingRepost(
    tokenizerVersion: number,
    limit: number,
    excludeIds: number[] = [],
  ): Promise<number[]> {
    const exclude = excludeIds.length
      ? ` AND d.attachment_id NOT IN (${excludeIds.map(() => "?").join(",")})`
      : "";
    const rows = (await this.q(
      `SELECT d.attachment_id FROM documents d LEFT JOIN document_tokenizer t ON t.attachment_id = d.attachment_id
       WHERE (t.attachment_id IS NULL OR t.tokenizer_version <> ? OR t.indexed_at <> d.indexed_at OR d.chunker_version = ?)${exclude}
       ORDER BY d.attachment_id ASC LIMIT ?`,
      [
        tokenizerVersion,
        LIBRARY_TEXT_INDEX_POSTINGS_ONLY_CHUNKER_VERSION,
        ...excludeIds,
        limit,
      ],
    )) as Array<{ attachment_id: number }>;
    return rows.map((row) => Number(row.attachment_id));
  }

  /**
   * Rewrites one document's postings from its stored chunk text, and records
   * `tokenizerVersion` for it, in one transaction: the chunk rows, the
   * document row's identity and every vector row stay as they are. The read
   * is inside the transaction, so a concurrent re-index or delete of the same
   * document cannot interleave. `rebuild` returns each chunk's term counts
   * (in chunk order) and the document's new byte estimate. Returns false
   * when the document is no longer indexed.
   */
  async repostDocument(
    attachmentId: number,
    tokenizerVersion: number,
    rebuild: (texts: string[]) => {
      tf: Array<Record<string, number>>;
      byteEstimate: number;
    },
  ): Promise<boolean> {
    const reposted = await this.db.executeTransaction(async () => {
      const documents = (await this.q(
        `SELECT attachment_id, indexed_at FROM documents WHERE attachment_id = ?`,
        [attachmentId],
      )) as Array<{ attachment_id: number; indexed_at: number }>;
      if (!documents.length) {
        await this.q(`DELETE FROM document_tokenizer WHERE attachment_id = ?`, [
          attachmentId,
        ]);
        return false;
      }
      const chunks = (await this.q(
        `SELECT chunk_index, text, token_count FROM chunks WHERE attachment_id = ? ORDER BY chunk_index`,
        [attachmentId],
      )) as Array<{ chunk_index: number; text: string; token_count: number }>;
      const rebuilt = rebuild(chunks.map((chunk) => String(chunk.text)));
      const byTerm = new Map<string, Array<[number, number, number]>>();
      chunks.forEach((chunk, i) => {
        const tf = rebuilt.tf[i] || {};
        for (const term of Object.keys(tf)) {
          const hits = byTerm.get(term) || [];
          hits.push([
            Number(chunk.chunk_index),
            tf[term],
            Number(chunk.token_count),
          ]);
          byTerm.set(term, hits);
        }
      });
      // New postings first, stale ones after. A search does not wait for
      // this transaction: Zotero runs a plain query on the same connection
      // in the middle of it and sees its uncommitted rows. Written in this
      // order, every state it can see holds the document's old postings, its
      // new ones, or both, so the document never drops out of a search.
      for (const [term, hits] of byTerm) {
        await this.q(
          `INSERT OR REPLACE INTO postings (term, attachment_id, hits_json, hit_count) VALUES (?,?,?,?)`,
          [term, attachmentId, JSON.stringify(hits), hits.length],
        );
      }
      const kept = (await this.q(
        `SELECT term FROM postings WHERE attachment_id = ?`,
        [attachmentId],
      )) as Array<{ term: string }>;
      for (const row of kept) {
        const term = String(row.term);
        if (!byTerm.has(term))
          await this.q(
            `DELETE FROM postings WHERE term = ? AND attachment_id = ?`,
            [term, attachmentId],
          );
      }
      await this.q(
        `UPDATE documents SET byte_estimate = ?, chunker_version = CASE WHEN chunker_version = ? THEN ? ELSE chunker_version END WHERE attachment_id = ?`,
        [
          rebuilt.byteEstimate,
          LIBRARY_TEXT_INDEX_POSTINGS_ONLY_CHUNKER_VERSION,
          LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
          attachmentId,
        ],
      );
      await this.q(
        `INSERT OR REPLACE INTO document_tokenizer (attachment_id, tokenizer_version, indexed_at) VALUES (?, ?, ?)`,
        [attachmentId, tokenizerVersion, Number(documents[0].indexed_at)],
      );
      return true;
    });
    // Corpus stats come from the chunk rows, which did not change.
    return reposted;
  }

  /**
   * Records a new file stat for a document whose text did not change (a
   * re-download with identical bytes), so reconcile stops flagging it stale.
   */
  async updateFileState(
    attachmentId: number,
    state: { mtime: number | null; size: number | null },
  ): Promise<void> {
    await this.q(
      `UPDATE documents SET source_mtime = ?, source_size = ? WHERE attachment_id = ?`,
      [state.mtime, state.size, attachmentId],
    );
  }

  async deleteDocuments(attachmentIds: number[]): Promise<void> {
    if (!attachmentIds.length) return;
    await this.db.executeTransaction(async () => {
      for (const ids of chunked(attachmentIds)) {
        const marks = ids.map(() => "?").join(",");
        for (const table of [
          "postings",
          "document_tokenizer",
          "chunks",
          "vector_documents",
          "queue",
          "documents",
        ]) {
          await this.q(
            `DELETE FROM ${table} WHERE attachment_id IN (${marks})`,
            ids,
          );
        }
      }
    });
    this.stats = null;
  }

  async getDocument(attachmentId: number): Promise<IndexDocumentRow | null> {
    const rows = (await this.q(
      `SELECT * FROM documents WHERE attachment_id = ?`,
      [attachmentId],
    )) as Array<Record<string, unknown>>;
    return rows[0] ? toDocumentRow(rows[0]) : null;
  }

  async listDocuments(libraryID: number): Promise<IndexDocumentRow[]> {
    const rows = (await this.q(`SELECT * FROM documents WHERE library_id = ?`, [
      libraryID,
    ])) as Array<Record<string, unknown>>;
    return rows.map(toDocumentRow);
  }

  async getPostings(terms: string[]): Promise<PostingRow[]> {
    const out: PostingRow[] = [];
    for (const batch of chunked([...new Set(terms)])) {
      if (!batch.length) continue;
      const rows = (await this.q(
        `SELECT term, attachment_id, hits_json FROM postings WHERE term IN (${batch.map(() => "?").join(",")})`,
        batch,
      )) as Array<{ term: string; attachment_id: number; hits_json: string }>;
      for (const row of rows)
        out.push({
          term: row.term,
          attachmentId: Number(row.attachment_id),
          hits: JSON.parse(row.hits_json),
        });
    }
    return out;
  }

  async getDocumentFrequencies(terms: string[]): Promise<Map<string, number>> {
    const df = new Map<string, number>();
    for (const batch of chunked([...new Set(terms)])) {
      if (!batch.length) continue;
      const rows = (await this.q(
        `SELECT term, SUM(hit_count) AS df FROM postings WHERE term IN (${batch.map(() => "?").join(",")}) GROUP BY term`,
        batch,
      )) as Array<{ term: string; df: number }>;
      for (const row of rows) df.set(row.term, Number(row.df));
    }
    return df;
  }

  async getChunks(
    refs: Array<{ attachmentId: number; chunkIndex: number }>,
  ): Promise<StoredChunk[]> {
    const out: StoredChunk[] = [];
    for (const batch of chunked(refs, 200)) {
      if (!batch.length) continue;
      const where = batch
        .map(() => "(c.attachment_id = ? AND c.chunk_index = ?)")
        .join(" OR ");
      const rows = (await this.q(
        `SELECT c.attachment_id, c.chunk_index, c.text, c.token_count, c.meta_json, d.title, d.parent_item_id, d.source_type
         FROM chunks c JOIN documents d ON d.attachment_id = c.attachment_id WHERE ${where}`,
        batch.flatMap((r) => [r.attachmentId, r.chunkIndex]),
      )) as Array<Record<string, unknown>>;
      for (const row of rows) out.push(toStoredChunk(row));
    }
    return out;
  }

  async getChunksForDocument(attachmentId: number): Promise<StoredChunk[]> {
    const rows = (await this.q(
      `SELECT c.attachment_id, c.chunk_index, c.text, c.token_count, c.meta_json, d.title, d.parent_item_id, d.source_type
       FROM chunks c JOIN documents d ON d.attachment_id = c.attachment_id WHERE c.attachment_id = ? ORDER BY c.chunk_index`,
      [attachmentId],
    )) as Array<Record<string, unknown>>;
    return rows.map(toStoredChunk);
  }

  async getCorpusStats(): Promise<CorpusStats> {
    if (this.stats) return this.stats;
    const rows = (await this.q(
      `SELECT COUNT(*) AS chunk_count, COALESCE(SUM(token_count), 0) AS total_tokens, (SELECT COUNT(*) FROM documents) AS document_count FROM chunks`,
    )) as Array<{
      chunk_count: number;
      total_tokens: number;
      document_count: number;
    }>;
    const chunkCount = Number(rows[0]?.chunk_count || 0);
    this.stats = {
      chunkCount,
      avgTokens: chunkCount ? Number(rows[0].total_tokens) / chunkCount : 0,
      documentCount: Number(rows[0]?.document_count || 0),
    };
    return this.stats;
  }

  async getCoverage(
    attachmentIds: number[],
  ): Promise<{ indexed: Set<number>; missing: number[]; failed: number[] }> {
    const indexed = new Set<number>();
    const failed = new Set<number>();
    for (const batch of chunked(attachmentIds)) {
      if (!batch.length) continue;
      const marks = batch.map(() => "?").join(",");
      const rows = (await this.q(
        `SELECT attachment_id FROM documents WHERE attachment_id IN (${marks})`,
        batch,
      )) as Array<{ attachment_id: number }>;
      for (const row of rows) indexed.add(Number(row.attachment_id));
      const parked = (await this.q(
        `SELECT attachment_id FROM queue WHERE attempts >= ? AND attachment_id IN (${marks})`,
        [INDEX_MAX_ATTEMPTS, ...batch],
      )) as Array<{ attachment_id: number }>;
      for (const row of parked) failed.add(Number(row.attachment_id));
    }
    const missing = attachmentIds.filter((id) => !indexed.has(id));
    return { indexed, missing, failed: missing.filter((id) => failed.has(id)) };
  }

  async touchDocuments(
    attachmentIds: number[],
    now = Date.now(),
  ): Promise<void> {
    for (const batch of chunked(attachmentIds)) {
      if (batch.length)
        await this.q(
          `UPDATE documents SET last_used_at = ? WHERE attachment_id IN (${batch.map(() => "?").join(",")})`,
          [now, ...batch],
        );
    }
  }

  async sumByteEstimates(): Promise<number> {
    const rows = (await this.q(
      `SELECT COALESCE(SUM(byte_estimate), 0) AS bytes FROM documents`,
    )) as Array<{ bytes: number }>;
    return Number(rows[0]?.bytes || 0);
  }

  async listLeastRecentlyUsed(
    limit: number,
    notUsedSince: number,
  ): Promise<
    Array<{ attachmentId: number; byteEstimate: number; lastUsedAt: number }>
  > {
    const rows = (await this.q(
      `SELECT attachment_id, byte_estimate, last_used_at FROM documents WHERE last_used_at < ? AND byte_estimate > 0 ORDER BY last_used_at ASC, attachment_id ASC LIMIT ?`,
      [notUsedSince, limit],
    )) as Array<{
      attachment_id: number;
      byte_estimate: number;
      last_used_at: number;
    }>;
    return rows.map((row) => ({
      attachmentId: Number(row.attachment_id),
      byteEstimate: Number(row.byte_estimate),
      lastUsedAt: Number(row.last_used_at),
    }));
  }

  async resetAttempts(attachmentIds: number[]): Promise<void> {
    for (const batch of chunked(attachmentIds)) {
      if (batch.length)
        await this.q(
          `UPDATE queue SET attempts = 0, next_attempt_at = 0, last_error = NULL WHERE attachment_id IN (${batch.map(() => "?").join(",")})`,
          batch,
        );
    }
  }

  async enqueue(
    rows: Array<{
      attachmentId: number;
      libraryID: number;
      priority: number;
      reason: string;
    }>,
  ): Promise<void> {
    if (!rows.length) return;
    const now = Date.now();
    await this.db.executeTransaction(async () => {
      for (const row of rows) {
        await this.q(
          `INSERT INTO queue (attachment_id, library_id, priority, reason, enqueued_at, attempts, next_attempt_at, last_error) VALUES (?,?,?,?,?,0,0,NULL)
           ON CONFLICT(attachment_id) DO UPDATE SET priority = MAX(priority, excluded.priority), reason = excluded.reason, attempts = 0, next_attempt_at = 0, last_error = NULL`,
          [row.attachmentId, row.libraryID, row.priority, row.reason, now],
        );
      }
    });
  }

  async dequeueNext(
    options: { now?: number; minPriority?: number } = {},
  ): Promise<QueueRow | null> {
    const now = options.now ?? Date.now();
    const rows = (await this.q(
      `SELECT * FROM queue WHERE attempts < ? AND next_attempt_at <= ? AND priority >= ? ORDER BY priority DESC, enqueued_at ASC LIMIT 1`,
      [INDEX_MAX_ATTEMPTS, now, options.minPriority ?? 0],
    )) as Array<Record<string, unknown>>;
    return rows[0] ? toQueueRow(rows[0]) : null;
  }

  async markQueueAttempt(
    attachmentId: number,
    error: string | null,
    now = Date.now(),
  ): Promise<void> {
    const rows = (await this.q(
      `SELECT attempts FROM queue WHERE attachment_id = ?`,
      [attachmentId],
    )) as Array<{ attempts: number }>;
    const attempts = Number(rows[0]?.attempts || 0);
    const backoff =
      INDEX_RETRY_BACKOFF_MS[
        Math.min(attempts, INDEX_RETRY_BACKOFF_MS.length - 1)
      ];
    await this.q(
      `UPDATE queue SET attempts = attempts + 1, next_attempt_at = ?, last_error = ? WHERE attachment_id = ?`,
      [now + backoff, error, attachmentId],
    );
  }

  async removeFromQueue(attachmentIds: number[]): Promise<void> {
    for (const batch of chunked(attachmentIds)) {
      if (batch.length)
        await this.q(
          `DELETE FROM queue WHERE attachment_id IN (${batch.map(() => "?").join(",")})`,
          batch,
        );
    }
  }

  async countQueue(
    libraryID: number,
  ): Promise<{ queued: number; failed: number }> {
    const rows = (await this.q(
      `SELECT SUM(CASE WHEN attempts < ? THEN 1 ELSE 0 END) AS queued, SUM(CASE WHEN attempts >= ? THEN 1 ELSE 0 END) AS failed FROM queue WHERE library_id = ?`,
      [INDEX_MAX_ATTEMPTS, INDEX_MAX_ATTEMPTS, libraryID],
    )) as Array<{ queued: number | null; failed: number | null }>;
    return {
      queued: Number(rows[0]?.queued || 0),
      failed: Number(rows[0]?.failed || 0),
    };
  }

  /** Every queued attachment in a library, parked (attempt cap reached) or pending. */
  async listQueuedAttachmentIds(libraryID: number): Promise<Set<number>> {
    const rows = (await this.q(
      `SELECT attachment_id FROM queue WHERE library_id = ?`,
      [libraryID],
    )) as Array<{ attachment_id: number }>;
    return new Set(rows.map((row) => Number(row.attachment_id)));
  }

  // ── Vector layer ───────────────────────────────────────────────────────────

  async upsertVectorDocument(row: VectorDocumentInput): Promise<void> {
    await this.q(
      `INSERT OR REPLACE INTO vector_documents (attachment_id, namespace, dims, chunk_count, path, source_fingerprint, indexed_at) VALUES (?,?,?,?,?,?,?)`,
      [
        row.attachmentId,
        row.namespace,
        row.dims,
        row.chunkCount,
        row.path,
        row.sourceFingerprint,
        Date.now(),
      ],
    );
  }

  async getVectorDocument(
    attachmentId: number,
    namespace: string,
  ): Promise<VectorDocumentRow | null> {
    const rows = (await this.q(
      `SELECT attachment_id, dims, chunk_count, path, source_fingerprint FROM vector_documents WHERE attachment_id = ? AND namespace = ?`,
      [attachmentId, namespace],
    )) as Array<Record<string, unknown>>;
    return rows[0] ? toVectorDocumentRow(rows[0]) : null;
  }

  async listVectorDocuments(namespace: string): Promise<VectorDocumentRow[]> {
    const rows = (await this.q(
      `SELECT attachment_id, dims, chunk_count, path, source_fingerprint FROM vector_documents WHERE namespace = ? ORDER BY attachment_id`,
      [namespace],
    )) as Array<Record<string, unknown>>;
    return rows.map(toVectorDocumentRow);
  }

  async deleteVectorDocument(
    attachmentId: number,
    namespace: string,
  ): Promise<void> {
    await this.q(
      `DELETE FROM vector_documents WHERE attachment_id = ? AND namespace = ?`,
      [attachmentId, namespace],
    );
  }

  /** Every namespace's vector row for these documents (namespace and shard path). */
  async listVectorDocumentsForAttachments(
    attachmentIds: number[],
  ): Promise<Array<{ attachmentId: number; namespace: string; path: string }>> {
    const out: Array<{
      attachmentId: number;
      namespace: string;
      path: string;
    }> = [];
    for (const batch of chunked([...new Set(attachmentIds)])) {
      if (!batch.length) continue;
      const rows = (await this.q(
        `SELECT attachment_id, namespace, path FROM vector_documents WHERE attachment_id IN (${batch.map(() => "?").join(",")})`,
        batch,
      )) as Array<{ attachment_id: number; namespace: string; path: string }>;
      for (const row of rows)
        out.push({
          attachmentId: Number(row.attachment_id),
          namespace: String(row.namespace),
          path: String(row.path),
        });
    }
    return out;
  }

  async deleteVectorNamespace(namespace: string): Promise<void> {
    await this.q(`DELETE FROM vector_documents WHERE namespace = ?`, [
      namespace,
    ]);
  }

  async listVectorNamespaces(): Promise<string[]> {
    const rows = (await this.q(
      `SELECT DISTINCT namespace FROM vector_documents ORDER BY namespace`,
    )) as Array<{ namespace: string }>;
    return rows.map((row) => String(row.namespace));
  }

  /** Deletes every other namespace's rows; returns the namespaces removed. */
  async deleteVectorNamespacesExcept(namespace: string): Promise<string[]> {
    const removed = (await this.listVectorNamespaces()).filter(
      (ns) => ns !== namespace,
    );
    if (removed.length)
      await this.q(`DELETE FROM vector_documents WHERE namespace <> ?`, [
        namespace,
      ]);
    return removed;
  }

  /**
   * Documents with text but no current vectors in `namespace`: never
   * embedded there, or re-indexed since (fingerprint differs). Newest first.
   */
  async listDocumentsMissingVectors(
    libraryID: number,
    namespace: string,
  ): Promise<number[]> {
    const rows = (await this.q(
      `SELECT d.attachment_id FROM documents d LEFT JOIN vector_documents v ON v.attachment_id = d.attachment_id AND v.namespace = ?
       WHERE d.library_id = ? AND d.chunk_count > 0 AND (v.attachment_id IS NULL OR v.source_fingerprint <> d.source_fingerprint)
       ORDER BY d.indexed_at DESC, d.attachment_id ASC`,
      [namespace, libraryID],
    )) as Array<{ attachment_id: number }>;
    return rows.map((row) => Number(row.attachment_id));
  }

  async getIndexMeta(key: string): Promise<string | null> {
    const rows = (await this.q(`SELECT value FROM index_meta WHERE key = ?`, [
      key,
    ])) as Array<{ value: string }>;
    return rows[0] ? String(rows[0].value) : null;
  }

  async setIndexMeta(key: string, value: string): Promise<void> {
    await this.q(
      `INSERT OR REPLACE INTO index_meta (key, value) VALUES (?, ?)`,
      [key, value],
    );
  }

  /** Every index_meta row whose key starts with `prefix`. */
  async listIndexMeta(prefix: string): Promise<Array<[string, string]>> {
    const rows = (await this.q(
      `SELECT key, value FROM index_meta WHERE substr(key, 1, ?) = ?`,
      [prefix.length, prefix],
    )) as Array<{ key: string; value: string }>;
    return rows.map((row) => [String(row.key), String(row.value)]);
  }

  async getDbBytes(): Promise<number> {
    const rows = (await this.q(
      `SELECT page_count * page_size AS bytes FROM pragma_page_count(), pragma_page_size()`,
    )) as Array<{ bytes: number }>;
    return Number(rows[0]?.bytes || 0);
  }
}

function toDocumentRow(row: Record<string, unknown>): IndexDocumentRow {
  return {
    attachmentId: Number(row.attachment_id),
    attachmentKey: String(row.attachment_key),
    libraryID: Number(row.library_id),
    parentItemId:
      row.parent_item_id === null ? null : Number(row.parent_item_id),
    title: String(row.title),
    sourceType: String(row.source_type),
    sourceFingerprint: String(row.source_fingerprint),
    sourceMtime: row.source_mtime === null ? null : Number(row.source_mtime),
    sourceSize: row.source_size === null ? null : Number(row.source_size),
    chunkerVersion: Number(row.chunker_version),
    chunkCount: Number(row.chunk_count),
    totalTokens: Number(row.total_tokens),
    byteEstimate: Number(row.byte_estimate),
    lastUsedAt: Number(row.last_used_at),
    indexedAt: Number(row.indexed_at),
  };
}
function toStoredChunk(row: Record<string, unknown>): StoredChunk {
  return {
    attachmentId: Number(row.attachment_id),
    chunkIndex: Number(row.chunk_index),
    text: String(row.text),
    tokenCount: Number(row.token_count),
    meta: JSON.parse(String(row.meta_json)) as StoredChunkMeta,
    title: String(row.title),
    parentItemId:
      row.parent_item_id === null ? null : Number(row.parent_item_id),
    sourceType: String(row.source_type),
  };
}
function toVectorDocumentRow(row: Record<string, unknown>): VectorDocumentRow {
  return {
    attachmentId: Number(row.attachment_id),
    dims: Number(row.dims),
    chunkCount: Number(row.chunk_count),
    path: String(row.path),
    sourceFingerprint: String(row.source_fingerprint),
  };
}
function toQueueRow(row: Record<string, unknown>): QueueRow {
  return {
    attachmentId: Number(row.attachment_id),
    libraryID: Number(row.library_id),
    priority: Number(row.priority),
    reason: String(row.reason),
    enqueuedAt: Number(row.enqueued_at),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    lastError: row.last_error === null ? null : String(row.last_error),
  };
}

// The shared store is bound to the connection it was built on; a closed and
// reopened connection gets a new store rather than a store over a dead handle.
let shared: { db: LibraryTextIndexDb; store: LibraryTextIndexStore } | null =
  null;
export async function getLibraryTextIndexStore(): Promise<LibraryTextIndexStore | null> {
  const db = await openLibraryTextIndexDb();
  if (!db) return null;
  if (shared?.db !== db) shared = { db, store: new LibraryTextIndexStore(db) };
  return shared.store;
}
/** Drops the shared store, so the next `getLibraryTextIndexStore` builds a new one. */
export function resetLibraryTextIndexStore(): void {
  shared = null;
}
export function resetLibraryTextIndexStoreForTests(): void {
  resetLibraryTextIndexStore();
}
