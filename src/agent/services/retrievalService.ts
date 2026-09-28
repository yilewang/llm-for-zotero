import { appLogger } from "../../core/logging";
import {
  buildPaperRetrievalCandidates,
  ensurePaperImageVectors,
} from "../../services/paperContent/pdfContext";
import type { RetrievalExplanation } from "../../services/paperContent/types";
import {
  MAX_IMAGES_PER_READ,
  selectRetrievalImages,
  type ImageSelectionReason,
} from "../../services/retrieval/imageSelection";
import {
  getImageFilePath,
  type EmbeddedImageRecord,
} from "../../services/retrieval/imageStore";
import {
  resolveRetrievalQueryPlan,
  type RetrievalQueryPlan,
} from "../../services/retrieval/retrievalQueryPlan";
import {
  RETRIEVAL_DEFAULTS,
  readRetrievalSettings,
  type RetrievalSettings,
} from "../../utils/embedding/settings";
import {
  callEmbeddings,
  getResolvedEmbeddingConfig,
  isImageEmbeddingEnabled,
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
import { PdfService } from "./pdfService";
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

export type RetrievalImageResult = {
  paperContext: PaperContextRef;
  citationLabel: string;
  sourceLabel: string;
  imageId: string;
  /** 0-based. */
  pageIndex: number;
  label?: string;
  caption?: string;
  score: number;
  why: ImageSelectionReason;
  imagePath: string;
  mimeType: string;
  source: "embedded" | "vector" | "mineru";
};

type PaperSource = Awaited<ReturnType<PdfService["ensurePaperContext"]>>;

export type RetrievalImageDeps = {
  isImageEmbeddingEnabled: () => boolean;
  readSettings: () => RetrievalSettings;
  loadImageVectors: (
    pdfContext: NonNullable<PaperSource>,
    attachmentId: number,
  ) => Promise<{ records: EmbeddedImageRecord[]; vectors: number[][] } | null>;
  embedQuery: (text: string) => Promise<number[] | undefined>;
  imagePath: (attachmentId: number, fileName: string) => string;
};

const DEFAULT_IMAGE_DEPS: RetrievalImageDeps = {
  // Semantic search switched off means no query embedding, so no images.
  isImageEmbeddingEnabled: () => {
    try {
      return resolveSemanticSearchState().enabled && isImageEmbeddingEnabled();
    } catch {
      return false;
    }
  },
  readSettings: () => {
    try {
      return readRetrievalSettings();
    } catch {
      return RETRIEVAL_DEFAULTS;
    }
  },
  loadImageVectors: ensurePaperImageVectors,
  embedQuery: (text) =>
    callEmbeddings([text])
      .then((values) => values[0])
      .catch(() => undefined),
  imagePath: getImageFilePath,
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
  purpose?: string;
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
    params.purpose,
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

type EvidenceCacheEntry = {
  results: RetrievalResult[];
  /** [chunkIndex, query–chunk similarity] for the image selection rules. */
  embeddingScores: Array<[number, number]>;
};

type RetrievalParams = Parameters<RetrievalService["retrieveEvidence"]>[0];

type RetrievalRun = {
  results: RetrievalResult[];
  /** Keyed by `${contextItemId}:${chunkIndex}`. */
  embeddingScores: Map<string, number>;
  pdfContexts: Map<number, PaperSource>;
  semanticQuery: string;
  queryEmbedding?: number[];
};

function chunkScoreKey(contextItemId: number, chunkIndex: number): string {
  return `${contextItemId}:${chunkIndex}`;
}

export class RetrievalService {
  private readonly evidenceCache = new Map<
    EvidenceCacheKey,
    EvidenceCacheEntry
  >();

  constructor(
    private readonly pdfService: PdfService,
    private readonly candidateBuilder = buildPaperRetrievalCandidates,
    private readonly imageDeps: RetrievalImageDeps = DEFAULT_IMAGE_DEPS,
  ) {}

  async retrieveEvidence(params: {
    papers: PaperContextRef[];
    question: string;
    queryVariants?: string[];
    queryPlan?: RetrievalQueryPlan;
    intent?: import("../types").ClassifiedTurnIntent;
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
    return (await this.retrieveInternal(params)).results;
  }

  /**
   * Text evidence as {@link retrieveEvidence} returns it, plus the paper
   * images the hit chunks vouch for or that clearly stand out on their own.
   */
  async retrieveEvidenceWithImages(
    params: RetrievalParams & { includeImages?: boolean },
  ): Promise<{ results: RetrievalResult[]; images: RetrievalImageResult[] }> {
    const run = await this.retrieveInternal(params);
    const settings = this.imageDeps.readSettings();
    if (
      params.includeImages === false ||
      settings.imageTopK <= 0 ||
      !this.imageDeps.isImageEmbeddingEnabled()
    ) {
      return { results: run.results, images: [] };
    }
    let queryEmbedding = run.queryEmbedding;
    const images: RetrievalImageResult[] = [];
    for (const paperContext of dedupePaperContexts(params.papers)) {
      const pdfContext = run.pdfContexts.get(paperContext.contextItemId);
      if (!pdfContext) continue;
      const index = await this.imageDeps
        .loadImageVectors(pdfContext, paperContext.contextItemId)
        .catch(() => null);
      if (!index?.records.length) continue;
      if (!queryEmbedding && run.semanticQuery.trim()) {
        queryEmbedding = await this.imageDeps.embedQuery(run.semanticQuery);
      }
      if (!queryEmbedding) break;
      const hitChunks = run.results
        .filter(
          (result) =>
            result.paperContext.contextItemId === paperContext.contextItemId,
        )
        .map((result) => {
          const span = pdfContext.chunkPageSpans?.[result.chunkIndex];
          return {
            text: result.text,
            pageStart: span ? span.start : result.pageStart,
            pageEnd: span ? span.end : result.pageEnd,
            embeddingScore: run.embeddingScores.get(
              chunkScoreKey(paperContext.contextItemId, result.chunkIndex),
            ),
          };
        });
      const picked = selectRetrievalImages({
        images: index.records.map((record, position) => ({
          ...record,
          vector: index.vectors[position] || [],
        })),
        queryEmbedding,
        hitChunks,
        topK: settings.imageTopK,
        outstandingPercent: settings.imageOutstandingPercent,
        onDiagnostics: (details) =>
          appLogger.debug("[Embedded images] Selection", {
            contextItemId: paperContext.contextItemId,
            hitChunkSimilarities: hitChunks.map(
              (entry) => entry.embeddingScore,
            ),
            ...details,
          }),
      });
      for (const { image, score, why } of picked) {
        images.push({
          paperContext,
          citationLabel: formatPaperCitationLabel(paperContext),
          sourceLabel: formatPaperSourceLabel(paperContext),
          imageId: image.imageId,
          pageIndex: image.pageIndex,
          ...(image.label ? { label: image.label } : {}),
          ...(image.caption ? { caption: image.caption } : {}),
          score,
          why,
          imagePath: this.imageDeps.imagePath(
            paperContext.contextItemId,
            image.fileName,
          ),
          mimeType: image.mimeType,
          source: image.source ?? "embedded",
        });
      }
    }
    images.sort((a, b) => b.score - a.score);
    return {
      results: run.results,
      images: images.slice(0, MAX_IMAGES_PER_READ),
    };
  }

  private async retrieveInternal(
    params: RetrievalParams,
  ): Promise<RetrievalRun> {
    const embeddingScores = new Map<string, number>();
    const pdfContexts = new Map<number, PaperSource>();
    const papers = dedupePaperContexts(params.papers);
    if (!papers.length) {
      return { results: [], embeddingScores, pdfContexts, semanticQuery: "" };
    }
    const settings = this.imageDeps.readSettings();
    const perPaperTopK = Number.isFinite(params.perPaperTopK)
      ? Math.max(1, Math.floor(params.perPaperTopK as number))
      : settings.textTopK;
    const topK = Number.isFinite(params.topK)
      ? Math.max(1, Math.floor(params.topK as number))
      : Math.max(6, settings.textTopK);
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
    queryPlan.retrievalPurpose = params.intent?.semantic?.retrievalPurpose;
    queryPlan.quoteAnchorPolicy =
      params.intent?.retrievalIntent === "verify" ? "verified" : "none";
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
    let queryEmbedding: Promise<number[] | undefined> | undefined;
    const results: RetrievalResult[] = [];
    for (const paperContext of papers) {
      const sectionIds = [
        ...(params.sectionIdsByPaper?.get(paperContext.contextItemId) ??
          params.sectionIds ??
          []),
      ].filter(Boolean);
      const pdfContext = pdfContexts.get(paperContext.contextItemId);
      const cacheKey = buildEvidenceCacheKey({
        paper: paperContext,
        queryKey: queryCacheKey,
        perPaperTopK,
        sectionIds,
        source: pdfContext,
        embeddingKey,
        purpose: queryPlan.retrievalPurpose,
        quotePolicy: queryPlan.quoteAnchorPolicy,
      });
      const cached = this.evidenceCache.get(cacheKey);
      if (cached) {
        results.push(...cached.results);
        for (const [chunkIndex, score] of cached.embeddingScores) {
          embeddingScores.set(
            chunkScoreKey(paperContext.contextItemId, chunkIndex),
            score,
          );
        }
        continue;
      }
      // Shared across this read's papers, and never spent for a cache hit.
      if (
        !queryEmbedding &&
        queryPlan.semanticQuery.trim() &&
        embeddingsAvailable
      ) {
        queryEmbedding = callEmbeddings([queryPlan.semanticQuery])
          .then((values) => values[0])
          .catch(() => undefined);
      }
      const precomputedQueryEmbedding = await queryEmbedding;
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        params.question,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
        {
          topK: perPaperTopK,
          mode: "evidence",
          precomputedQueryEmbedding,
          queryPlan,
          ...(sectionIds.length ? { sectionIds } : {}),
        },
      );
      const paperResults: RetrievalResult[] = candidates.map((candidate) => ({
        paperContext,
        chunkIndex: candidate.chunkIndex,
        sectionLabel: candidate.sectionLabel,
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
      }));
      const paperScores: Array<[number, number]> = candidates.map(
        (candidate) => [candidate.chunkIndex, candidate.embeddingScore],
      );
      for (const [chunkIndex, score] of paperScores) {
        embeddingScores.set(
          chunkScoreKey(paperContext.contextItemId, chunkIndex),
          score,
        );
      }
      this.evidenceCache.set(cacheKey, {
        results: paperResults,
        embeddingScores: paperScores,
      });
      results.push(...paperResults);
    }
    // Evidence mode gives every paper's rank-1 chunk the same score, so the
    // fused score decides which paper's best chunk leads; the chunk index is
    // only the last resort.
    results.sort(
      (a, b) =>
        b.score - a.score ||
        b.hybridScore - a.hybridScore ||
        a.chunkIndex - b.chunkIndex,
    );
    return {
      results: results.slice(0, topK),
      embeddingScores,
      pdfContexts,
      semanticQuery: queryPlan.semanticQuery,
      queryEmbedding: queryEmbedding ? await queryEmbedding : undefined,
    };
  }

  clearEvidenceCache(): void {
    this.evidenceCache.clear();
  }
}
