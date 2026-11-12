/**
 * The re-posting pass after a tokenizer change (LIBRARY_TEXT_INDEX_TOKENIZER_VERSION).
 *
 * Each document's postings are rebuilt from its stored chunk text through
 * the same `buildChunkIndex` a fresh index uses: no PDF read, the chunk
 * boundaries, the document row's fingerprint and every vector stay. One
 * document per transaction (`store.repostDocument`), and the per-document
 * `document_tokenizer` row is written in that transaction, so an interrupted
 * pass resumes where it stopped and never redoes a finished document. The
 * global `tokenizer_version` row is written only once no document is left.
 *
 * Until then the index is mixed per document: a re-posted document matches
 * by index term ("errors" finds "error"), a waiting one only where the
 * query's index term equals a surface word it contains.
 */
import { buildChunkIndex } from "../paperContent/pdfContext";
import {
  LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
  TOKENIZER_VERSION_META_KEY,
} from "./constants";
import { isLibraryTextIndexClosedError } from "./db";
import { estimateDocumentBytes } from "./indexer";
import type { LibraryTextIndexStore } from "./store";

const REPOST_BATCH = 25;

export type TokenizerUpgradeSlice = {
  /** Documents re-posted in this slice. */
  reposted: number;
  /** True once every document is at the current version and the global row is written. */
  done: boolean;
  /** Message of the first failure in this slice; the failed document was set aside. */
  failure?: string;
};

/** Index-term counts per chunk and the byte estimate, as a fresh index computes them. */
export function rebuildDocumentTerms(texts: string[]): {
  tf: Array<Record<string, number>>;
  byteEstimate: number;
} {
  const tf = buildChunkIndex(texts).chunkStats.map((stat) => stat.tf);
  return {
    tf,
    byteEstimate: estimateDocumentBytes({
      chunks: texts.map((text, i) => ({ text, tf: tf[i] || {} })),
    }),
  };
}

/**
 * Re-posts documents until `sliceMs` has passed (at least one document per
 * call), then returns. Call again until `done`. A throw leaves every
 * finished document finished; the next call continues with the rest.
 */
export async function runTokenizerUpgradeSlice(
  store: LibraryTextIndexStore,
  options: {
    sliceMs: number;
    now?: () => number;
    /**
     * Failures per document, kept by the caller across slices. A document
     * with `maxAttempts` failures is left out of the pass. A failure does
     * not end the slice: the pass goes on with the other documents.
     */
    failures?: Map<number, number>;
    maxAttempts?: number;
    onSkipped?: (attachmentId: number, message: string) => void;
  },
): Promise<TokenizerUpgradeSlice> {
  if (await store.isTokenizerVersionCurrent()) {
    const recorded = await store.getIndexMeta(TOKENIZER_VERSION_META_KEY);
    if (recorded !== String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION))
      await store.setIndexMeta(
        TOKENIZER_VERSION_META_KEY,
        String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION),
      );
    return { reposted: 0, done: true };
  }
  const now = options.now || Date.now;
  const started = now();
  const failures = options.failures || new Map<number, number>();
  const maxAttempts = options.maxAttempts ?? Infinity;
  const setAside = new Set<number>(); // failed in this slice: not retried until the next one
  let failure: string | undefined;
  let reposted = 0;
  let attempted = 0;
  while (true) {
    const exclude = [
      ...new Set([
        ...setAside,
        ...[...failures].filter(([, n]) => n >= maxAttempts).map(([id]) => id),
      ]),
    ];
    const ids = await store.listDocumentsNeedingRepost(
      LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
      REPOST_BATCH,
      exclude,
    );
    if (!ids.length) {
      // A document left out keeps its old postings: the store stays "not current".
      const leftOut =
        (
          await store.listDocumentsNeedingRepost(
            LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
            1,
          )
        ).length > 0;
      if (!leftOut)
        await store.setIndexMeta(
          TOKENIZER_VERSION_META_KEY,
          String(LIBRARY_TEXT_INDEX_TOKENIZER_VERSION),
        );
      return { reposted, done: true, ...(failure ? { failure } : {}) };
    }
    for (const attachmentId of ids) {
      // The budget is checked before a document, not after it: a slice that
      // ran out of time just after the last document would otherwise return
      // not done, and once nothing needs re-posting no later slice runs to
      // record the version.
      if (attempted > 0 && now() - started >= options.sliceMs)
        return { reposted, done: false, ...(failure ? { failure } : {}) };
      attempted += 1;
      try {
        await store.repostDocument(
          attachmentId,
          LIBRARY_TEXT_INDEX_TOKENIZER_VERSION,
          rebuildDocumentTerms,
        );
        reposted += 1;
      } catch (error) {
        // Without a failure map the caller wants the first failure thrown.
        if (!options.failures || isLibraryTextIndexClosedError(error))
          throw error;
        const message = error instanceof Error ? error.message : String(error);
        failure = failure ?? message;
        const count = (failures.get(attachmentId) || 0) + 1;
        failures.set(attachmentId, count);
        setAside.add(attachmentId);
        if (count >= maxAttempts) options.onSkipped?.(attachmentId, message);
      }
    }
  }
}
