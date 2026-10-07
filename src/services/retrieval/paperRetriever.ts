/**
 * The per-paper retrieval loop shared by the panel's multi-paper context
 * planner and the agent's evidence service.
 *
 * For each paper, in order: look the paper up in the caller's cache; on a
 * miss, resolve the query embedding (at most once per call, and never when
 * every paper hits), rank the paper's chunks with
 * `buildPaperRetrievalCandidates`, project the candidates into the caller's
 * entry type, and store them. The entries come back in paper order; any
 * cross-paper ranking is the caller's.
 *
 * The caller owns every policy: the cache (its key, its bound, and whether a
 * paper bypasses it), when the query embedding is computed, the builder
 * options for each paper, and how a failure is handled. A builder failure
 * propagates; papers before it stay cached, the failing paper does not.
 */
import { buildPaperRetrievalCandidates } from "../paperContent/pdfContext";
import type { PaperContextCandidate, PdfContext } from "../paperContent/types";
import type { PaperContextRef } from "../../shared/types";

export type PaperCandidateBuilder = typeof buildPaperRetrievalCandidates;

type BuilderOptionsArgument = Parameters<PaperCandidateBuilder>[3];

/** One paper to retrieve from; a caller may carry its own fields with it. */
export type PaperRetrievalTarget = {
  paperContext: PaperContextRef;
  pdfContext: PdfContext | undefined;
};

/**
 * Where a caller keeps retrieved entries. `keyFor` returning `undefined`
 * bypasses the cache for that paper: nothing is read and nothing is stored.
 */
export type PaperRetrievalCachePolicy<Target, Entry> = {
  keyFor(target: Target): string | undefined;
  get(key: string): Entry[] | undefined;
  set(key: string, entries: Entry[]): void;
};

/**
 * The builder arguments for one paper. `apiOverrides`, when present, is the
 * builder's fourth argument and `options` its fifth; otherwise `options` is
 * the fourth argument alone.
 */
export type PaperRetrievalBuilderArguments = {
  apiOverrides?: BuilderOptionsArgument;
  options: NonNullable<BuilderOptionsArgument>;
};

export async function retrievePerPaper<
  Target extends PaperRetrievalTarget,
  Entry,
>(params: {
  targets: readonly Target[];
  question: string;
  cache: PaperRetrievalCachePolicy<Target, Entry>;
  /**
   * Called on the first cache miss only. A caller that wants the embedding
   * computed up front resolves it before the call and returns it here.
   */
  resolveQueryEmbedding: () => Promise<number[] | undefined>;
  builderArguments: (
    target: Target,
    precomputedQueryEmbedding: number[] | undefined,
  ) => PaperRetrievalBuilderArguments;
  project: (target: Target, candidates: PaperContextCandidate[]) => Entry[];
  candidateBuilder?: PaperCandidateBuilder;
}): Promise<Entry[]> {
  const candidateBuilder =
    params.candidateBuilder || buildPaperRetrievalCandidates;
  let queryEmbedding: Promise<number[] | undefined> | undefined;
  const entries: Entry[] = [];
  for (const target of params.targets) {
    const cacheKey = params.cache.keyFor(target);
    const cached =
      cacheKey === undefined ? undefined : params.cache.get(cacheKey);
    if (cached) {
      entries.push(...cached);
      continue;
    }
    if (!queryEmbedding) queryEmbedding = params.resolveQueryEmbedding();
    const precomputedQueryEmbedding = await queryEmbedding;
    const args = params.builderArguments(target, precomputedQueryEmbedding);
    const candidates = args.apiOverrides
      ? await candidateBuilder(
          target.paperContext,
          target.pdfContext,
          params.question,
          args.apiOverrides,
          args.options,
        )
      : await candidateBuilder(
          target.paperContext,
          target.pdfContext,
          params.question,
          args.options,
        );
    const paperEntries = params.project(target, candidates);
    if (cacheKey !== undefined) params.cache.set(cacheKey, paperEntries);
    entries.push(...paperEntries);
  }
  return entries;
}
