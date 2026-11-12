import { isBodyEvidenceSection } from "../../shared/libraryChatEvidencePolicy";
import { RRF_K } from "../retrieval/constants";
import {
  toRetrievalIndexTerm,
  tokenizeRetrievalQuery,
} from "../retrieval/retrievalTokenizer";
import { MAX_QUERY_TERMS } from "./constants";
import type { LibraryTextIndexStore, StoredChunkMeta } from "./store";

export type IndexCoverage = {
  scopeAttachments: number;
  indexed: number;
  unindexed: number[];
  failed: number[];
  stale: number[];
  vectorIndexed?: number;
};
export type IndexedChunkHit = {
  attachmentId: number;
  parentItemId: number | null;
  chunkIndex: number;
  text: string;
  title: string;
  /** The indexed document's source (`mineru`, `zotero-fulltext-cache`, ...). */
  sourceType: string;
  meta: StoredChunkMeta;
  bm25Score: number;
  vectorScore?: number;
  hybridScore: number;
  rank: number;
  evidenceScore: number;
  /** Surface query terms whose index term occurs in this chunk. */
  matchedTerms: string[];
};
export type IndexedPaperHit = {
  attachmentId: number;
  parentItemId: number | null;
  score: number;
  matchingChunks: number;
  bestChunkIndex: number;
  rank: number;
};
export type LibraryTextIndexSearchParams = {
  store: LibraryTextIndexStore;
  scopeAttachmentIds: number[];
  queries: string[];
  maxPapers: number;
  perPaperTopK: number;
  maxChunks?: number;
  /**
   * Only the top this-many papers get chunk rows (and an LRU touch); the
   * rest are ranked and counted only. Defaults to every returned paper.
   */
  chunkPapers?: number;
};
export type LibraryTextIndexSearchResult = {
  chunks: IndexedChunkHit[];
  /** The top `maxPapers` matching papers. */
  papers: IndexedPaperHit[];
  /** Every in-scope paper with a match, before the `maxPapers` cut. */
  totalMatchingPapers: number;
  coverage: IndexCoverage;
  /** The surface query terms (what the reader typed), not index terms. */
  queryTerms: string[];
  timings: Record<string, number>;
};

// Same constants as scoreChunkBM25 in pdfContext.ts; the parity test pins them.
const BM25_K1 = 1.2;
const BM25_B = 0.75;
const PAPER_BREADTH_WEIGHT = 0.2;

/** One term's BM25 contribution; the same formula as `scoreChunkBM25`. */
export function scoreBm25(
  tf: number,
  tokenCount: number,
  df: number,
  chunkCount: number,
  avgTokens: number,
): number {
  if (!tf || !tokenCount) return 0;
  const idf = Math.log(1 + (chunkCount - df + 0.5) / (df + 0.5));
  const norm =
    (tf * (BM25_K1 + 1)) /
    (tf + BM25_K1 * (1 - BM25_B + (BM25_B * tokenCount) / avgTokens));
  return idf * norm;
}

/**
 * Union of the query variants' surface terms in first-seen order, capped at
 * MAX_QUERY_TERMS. Postings are keyed by index terms: look them up through
 * `toRetrievalIndexTerm`.
 */
export function collectQueryTerms(queries: string[]): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    for (const term of tokenizeRetrievalQuery(query || "")) {
      if (seen.has(term)) continue;
      seen.add(term);
      terms.push(term);
      if (terms.length >= MAX_QUERY_TERMS) return terms;
    }
  }
  return terms;
}

type ChunkAccumulator = {
  score: number;
  tokenCount: number;
  terms: Set<string>;
};
type PaperAccumulator = {
  best: number;
  bestChunk: number;
  count: number;
  chunks: Array<{ chunkIndex: number; score: number; terms: string[] }>;
};

export async function searchLibraryTextIndex(
  params: LibraryTextIndexSearchParams,
): Promise<LibraryTextIndexSearchResult> {
  const timings: Record<string, number> = {};
  const started = Date.now();
  const mark = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = Date.now();
    try {
      return await fn();
    } finally {
      timings[name] = (timings[name] || 0) + (Date.now() - t);
    }
  };
  const scope = new Set(params.scopeAttachmentIds);
  const coverageRaw = await mark("coverage", () =>
    params.store.getCoverage([...scope]),
  );
  const coverage: IndexCoverage = {
    scopeAttachments: scope.size,
    indexed: coverageRaw.indexed.size,
    unindexed: coverageRaw.missing,
    failed: coverageRaw.failed,
    stale: [],
  };
  const queryTerms = collectQueryTerms(params.queries);
  // Index term → the surface terms that asked for it ("errors" → "error").
  const surfaceByIndexTerm = new Map<string, string[]>();
  for (const term of queryTerms) {
    const indexTerm = toRetrievalIndexTerm(term);
    const surfaces = surfaceByIndexTerm.get(indexTerm) || [];
    surfaces.push(term);
    surfaceByIndexTerm.set(indexTerm, surfaces);
  }
  const indexTerms = [...surfaceByIndexTerm.keys()];
  if (!queryTerms.length || !coverage.indexed) {
    timings.total = Date.now() - started;
    return {
      chunks: [],
      papers: [],
      totalMatchingPapers: 0,
      coverage,
      queryTerms,
      timings,
    };
  }
  const [postings, df, stats] = await mark("postings", async () => {
    // During the re-posting pass (tokenizerUpgrade.ts) a document not yet
    // re-posted still holds surface postings: ask for the surface terms too,
    // so it keeps matching what it matched before. Re-posted documents hold
    // no surface postings for a term whose stem differs.
    const lookupTerms = (await params.store.isTokenizerVersionCurrent())
      ? indexTerms
      : [...new Set([...indexTerms, ...queryTerms])];
    return Promise.all([
      params.store.getPostings(lookupTerms),
      params.store.getDocumentFrequencies(lookupTerms),
      params.store.getCorpusStats(),
    ]);
  });
  const byChunk = new Map<string, ChunkAccumulator>();
  await mark("score", async () => {
    for (const posting of postings) {
      if (!scope.has(posting.attachmentId)) continue;
      const termDf = df.get(posting.term) || 0;
      for (const [chunkIndex, tf, tokenCount] of posting.hits) {
        const key = `${posting.attachmentId}:${chunkIndex}`;
        const acc = byChunk.get(key) || {
          score: 0,
          tokenCount,
          terms: new Set<string>(),
        };
        acc.score += scoreBm25(
          tf,
          tokenCount,
          termDf,
          stats.chunkCount,
          stats.avgTokens || 1,
        );
        acc.terms.add(posting.term);
        byChunk.set(key, acc);
      }
    }
  });
  const byPaper = new Map<number, PaperAccumulator>();
  for (const [key, acc] of byChunk) {
    if (acc.score <= 0) continue;
    const [attachmentId, chunkIndex] = key.split(":").map(Number);
    const paper = byPaper.get(attachmentId) || {
      best: 0,
      bestChunk: chunkIndex,
      count: 0,
      chunks: [],
    };
    paper.count += 1;
    if (
      acc.score > paper.best ||
      (acc.score === paper.best && chunkIndex < paper.bestChunk)
    ) {
      paper.best = acc.score;
      paper.bestChunk = chunkIndex;
    }
    paper.chunks.push({ chunkIndex, score: acc.score, terms: [...acc.terms] });
    byPaper.set(attachmentId, paper);
  }
  const papers: IndexedPaperHit[] = [...byPaper.entries()]
    .map(([attachmentId, p]) => ({
      attachmentId,
      parentItemId: null as number | null,
      score: p.best + PAPER_BREADTH_WEIGHT * Math.log1p(p.count),
      matchingChunks: p.count,
      bestChunkIndex: p.bestChunk,
      rank: 0,
    }))
    .sort((a, b) => b.score - a.score || a.attachmentId - b.attachmentId)
    .slice(0, Math.max(1, params.maxPapers));
  papers.forEach((p, i) => {
    p.rank = i + 1;
  });
  const selected: Array<{
    attachmentId: number;
    chunkIndex: number;
    score: number;
    terms: string[];
  }> = [];
  const chunkPapers = papers.slice(
    0,
    Math.max(1, params.chunkPapers ?? papers.length),
  );
  for (const paper of chunkPapers) {
    const rows = byPaper
      .get(paper.attachmentId)!
      .chunks.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex)
      .slice(0, Math.max(1, params.perPaperTopK));
    for (const row of rows)
      selected.push({ attachmentId: paper.attachmentId, ...row });
  }
  selected.sort(
    (a, b) =>
      b.score - a.score ||
      a.attachmentId - b.attachmentId ||
      a.chunkIndex - b.chunkIndex,
  );
  const limited = params.maxChunks
    ? selected.slice(0, params.maxChunks)
    : selected;
  // Always fetch each shortlisted paper's best chunk too, so its parent item
  // resolves even when maxChunks cut that paper's chunks from the answer.
  const refs = new Map<string, { attachmentId: number; chunkIndex: number }>();
  for (const s of limited)
    refs.set(`${s.attachmentId}:${s.chunkIndex}`, {
      attachmentId: s.attachmentId,
      chunkIndex: s.chunkIndex,
    });
  for (const p of chunkPapers)
    refs.set(`${p.attachmentId}:${p.bestChunkIndex}`, {
      attachmentId: p.attachmentId,
      chunkIndex: p.bestChunkIndex,
    });
  const stored = await mark("chunks", () =>
    params.store.getChunks([...refs.values()]),
  );
  const storedByKey = new Map(
    stored.map((c) => [`${c.attachmentId}:${c.chunkIndex}`, c]),
  );
  const chunks: IndexedChunkHit[] = [];
  for (const s of limited) {
    const c = storedByKey.get(`${s.attachmentId}:${s.chunkIndex}`);
    if (!c) continue;
    const rank = chunks.length + 1;
    chunks.push({
      attachmentId: c.attachmentId,
      parentItemId: c.parentItemId,
      chunkIndex: c.chunkIndex,
      text: c.text,
      title: c.title,
      sourceType: c.sourceType,
      meta: c.meta,
      bm25Score: s.score,
      hybridScore: s.score,
      rank,
      evidenceScore: 1 / (RRF_K + rank),
      matchedTerms: [
        ...new Set(
          s.terms.flatMap((term) => surfaceByIndexTerm.get(term) || [term]),
        ),
      ],
    });
  }
  // Papers past `chunkPapers` have no chunk read: their parent stays null.
  for (const paper of papers)
    paper.parentItemId =
      storedByKey.get(`${paper.attachmentId}:${paper.bestChunkIndex}`)
        ?.parentItemId ?? null;
  timings.total = Date.now() - started;
  // LRU bookkeeping for the byte budget (Task 7 eviction): fire-and-forget,
  // never on the answer path.
  if (chunkPapers.length)
    void params.store
      .touchDocuments(chunkPapers.map((p) => p.attachmentId))
      .catch(() => undefined);
  return {
    chunks,
    papers,
    totalMatchingPapers: byPaper.size,
    coverage,
    queryTerms,
    timings,
  };
}

/**
 * A document's first `k` chunks as zero-score hits, body chunks first (in
 * chunk order) and front matter after, for a shortlisted paper the index did
 * not rank. Mirrors the direct path, whose candidate builder admits
 * zero-score chunks, so a synthesis read still gets each paper's body.
 */
export async function readLeadingIndexChunks(
  store: LibraryTextIndexStore,
  attachmentId: number,
  k: number,
): Promise<IndexedChunkHit[]> {
  const limit = Math.max(0, Math.floor(k));
  if (!limit) return [];
  const stored = await store.getChunksForDocument(attachmentId);
  const isBody = (c: (typeof stored)[number]) =>
    isBodyEvidenceSection(c.meta.sectionLabel, c.meta.chunkKind);
  const ordered = [
    ...stored.filter(isBody),
    ...stored.filter((c) => !isBody(c)),
  ];
  return ordered.slice(0, limit).map((c, index) => ({
    attachmentId: c.attachmentId,
    parentItemId: c.parentItemId,
    chunkIndex: c.chunkIndex,
    text: c.text,
    title: c.title,
    sourceType: c.sourceType,
    meta: c.meta,
    bm25Score: 0,
    hybridScore: 0,
    rank: index + 1,
    evidenceScore: 0,
    matchedTerms: [],
  }));
}
