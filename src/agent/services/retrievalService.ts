import { buildPaperRetrievalCandidates } from "../../services/paperContent/pdfContext";
import type { RetrievalExplanation } from "../../services/paperContent/types";
import {
  resolveRetrievalQueryPlan,
  type RetrievalQueryPlan,
} from "../../services/retrieval/retrievalQueryPlan";
import {
  callEmbeddings,
  getResolvedEmbeddingConfig,
  resolveSemanticSearchState,
  type ChatParams,
} from "../../utils/llmClient";
import { fnv1a32 } from "../../utils/fnv1a";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../services/paperContent/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import { renderSectionLabel } from "../../shared/libraryChatEvidencePolicy";
import { PdfService } from "./pdfService";
import { retrievePerPaper } from "../../services/retrieval/paperRetriever";
import type { ModelProfileOverride } from "../../modelCapabilities";

type RetrievalResult = {
  paperContext: PaperContextRef;
  chunkIndex: number;
  sectionLabel?: string;
  sectionPath?: string;
  chunkKind?: string;
  citationLabel: string;
  sourceLabel: string;
  text: string;
  score: number;
  /** Fused rank score, before the section prior: the cross-paper tiebreak. */
  hybridScore: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
  /** Why this chunk was retrieved: input ranks, section prior, structure rule. */
  why?: RetrievalExplanation;
};

function dedupePaperContexts(
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of paperContexts) {
    if (
      !entry ||
      !Number.isFinite(entry.itemId) ||
      !Number.isFinite(entry.contextItemId)
    )
      continue;
    const key = `${entry.libraryID || 0}:${entry.itemId}:${entry.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

type EvidenceCacheKey = string;

/** Exported for the cache-key unit tests; not part of the service contract. */
export function buildEvidenceCacheKey(params: {
  paper: PaperContextRef;
  queryKey: string;
  perPaperTopK: number;
  sectionIds: readonly string[];
  source: Awaited<ReturnType<PdfService["ensurePaperContext"]>>;
  embeddingKey: string;
  quotePolicy?: string;
}): EvidenceCacheKey {
  const fingerprints = [
    ...new Set(
      params.source?.chunkMeta
        ?.map((meta) => meta.sourceFingerprint)
        .filter(Boolean) || [],
    ),
  ];
  const chunks = params.source?.chunks;
  // Preserve Unicode, mathematical operators, and the complete query identity.
  // Unknown provenance digests the source text rather than reusing stale
  // evidence: a whole paper in the key would grow the cache without bound.
  // Each chunk's length goes into the digest, so re-chunking that only moves a
  // boundary — same text, different passages — is a different source.
  return JSON.stringify([
    params.paper.libraryID,
    params.paper.contextItemId,
    params.queryKey,
    params.perPaperTopK,
    [...params.sectionIds].sort(),
    params.embeddingKey,
    params.quotePolicy,
    fingerprints.length
      ? fingerprints
      : chunks
        ? `chunks:${chunks.length}:${fnv1a32(
            chunks.map((chunk) => `${chunk.length}:${chunk}`).join(" "),
          )}`
        : undefined,
  ]);
}

export class RetrievalService {
  private readonly evidenceCache = new Map<
    EvidenceCacheKey,
    RetrievalResult[]
  >();

  constructor(
    private readonly pdfService: PdfService,
    private readonly candidateBuilder = buildPaperRetrievalCandidates,
  ) {}

  async retrieveEvidence(params: {
    papers: PaperContextRef[];
    question: string;
    queryVariants?: string[];
    queryPlan?: RetrievalQueryPlan;
    model?: string;
    apiBase?: string;
    apiKey?: string;
    authMode?: ChatParams["authMode"];
    providerProtocol?: ProviderProtocol;
    profileOverride?: ModelProfileOverride;
    signal?: AbortSignal;
    topK?: number;
    perPaperTopK?: number;
    /** Restrict candidates to these section ids (`s<n>`) before ranking. */
    sectionIds?: string[];
    sectionIdsByPaper?: ReadonlyMap<number, readonly string[]>;
  }): Promise<RetrievalResult[]> {
    const papers = dedupePaperContexts(params.papers);
    if (!papers.length) return [];
    const perPaperTopK = Number.isFinite(params.perPaperTopK)
      ? Math.max(1, Math.floor(params.perPaperTopK as number))
      : 4;
    const topK = Number.isFinite(params.topK)
      ? Math.max(1, Math.floor(params.topK as number))
      : 6;
    const pdfContexts = new Map<
      number,
      Awaited<ReturnType<PdfService["ensurePaperContext"]>>
    >();
    for (const paperContext of papers) {
      pdfContexts.set(
        paperContext.contextItemId,
        await this.pdfService.ensurePaperContext(paperContext),
      );
    }
    const queryPlan = await resolveRetrievalQueryPlan({
      query: params.question,
      queryVariants: params.queryVariants,
      queryPlan: params.queryPlan,
      hasRetrievalContext: true,
      model: params.model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      providerProtocol: params.providerProtocol,
      profileOverride: params.profileOverride,
      signal: params.signal,
      sourceSamples: papers.map((paperContext) => {
        const pdfContext = pdfContexts.get(paperContext.contextItemId);
        return [paperContext.title, pdfContext?.chunks[0] || ""]
          .filter(Boolean)
          .join("\n");
      }),
    });
    queryPlan.quoteAnchorPolicy = "none";
    // The planner's similarity key strips operators and truncates long input.
    // Evidence reuse must retain the complete query that selected these facts.
    const queryCacheKey = JSON.stringify([
      queryPlan.originalQuery,
      queryPlan.variants,
      queryPlan.semanticQuery,
      queryPlan.lexicalTerms,
      queryPlan.references,
    ]);
    let embeddingsAvailable = false;
    try {
      // Honour an explicit "off": never spend a query-embedding call on a user
      // who turned semantic search off.
      embeddingsAvailable = resolveSemanticSearchState().enabled;
    } catch {
      embeddingsAvailable = false;
    }
    let embeddingKey = "off";
    if (embeddingsAvailable) {
      try {
        embeddingKey = getResolvedEmbeddingConfig().cacheKey;
      } catch {
        embeddingsAvailable = false;
      }
    }
    const targets = papers.map((paperContext) => ({
      paperContext,
      pdfContext: pdfContexts.get(paperContext.contextItemId),
      sectionIds: [
        ...(params.sectionIdsByPaper?.get(paperContext.contextItemId) ??
          params.sectionIds ??
          []),
      ].filter(Boolean),
    }));
    const results = await retrievePerPaper({
      targets,
      question: params.question,
      cache: {
        keyFor: (target) =>
          buildEvidenceCacheKey({
            paper: target.paperContext,
            queryKey: queryCacheKey,
            perPaperTopK,
            sectionIds: target.sectionIds,
            source: target.pdfContext,
            embeddingKey,
            quotePolicy: queryPlan.quoteAnchorPolicy,
          }),
        get: (key) => this.evidenceCache.get(key),
        set: (key, entries) => {
          this.evidenceCache.set(key, entries);
        },
      },
      // Shared across this read's papers, and never spent for a cache hit.
      resolveQueryEmbedding: () =>
        queryPlan.semanticQuery.trim() && embeddingsAvailable
          ? callEmbeddings([queryPlan.semanticQuery])
              .then((values) => values[0])
              .catch(() => undefined)
          : Promise.resolve(undefined),
      builderArguments: ({ sectionIds }, precomputedQueryEmbedding) => ({
        apiOverrides: {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
        options: {
          topK: perPaperTopK,
          mode: "evidence",
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
      }),
      project: ({ paperContext }, candidates): RetrievalResult[] =>
        candidates.map((candidate) => ({
          paperContext,
          chunkIndex: candidate.chunkIndex,
          sectionLabel: renderSectionLabel(
            candidate.sectionLabel,
            candidate.enclosingSection,
            candidate.title,
          ),
          sectionPath: candidate.sectionPath,
          chunkKind: candidate.chunkKind,
          citationLabel: formatPaperCitationLabel(paperContext),
          sourceLabel: formatPaperSourceLabel(paperContext),
          text: candidate.chunkText,
          score: candidate.evidenceScore,
          hybridScore: candidate.hybridScore,
          sourceStart: candidate.sourceStart,
          sourceEnd: candidate.sourceEnd,
          sourceFingerprint: candidate.sourceFingerprint,
          pageStart: candidate.pageStart,
          pageEnd: candidate.pageEnd,
          why: candidate.why,
        })),
      candidateBuilder: this.candidateBuilder,
    });
    // Evidence mode gives every paper's rank-1 chunk the same score, so the
    // fused score decides which paper's best chunk leads; the chunk index is
    // only the last resort.
    results.sort(
      (a, b) =>
        b.score - a.score ||
        b.hybridScore - a.hybridScore ||
        a.chunkIndex - b.chunkIndex,
    );
    return results.slice(0, topK);
  }

  clearEvidenceCache(): void {
    this.evidenceCache.clear();
  }
}
