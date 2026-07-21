import { buildPaperRetrievalCandidates } from "../../modules/contextPanel/pdfContext";
import {
  buildRetrievalQueryPlanCacheKey,
  resolveRetrievalQueryPlan,
  type RetrievalQueryPlan,
} from "../../modules/contextPanel/retrievalQueryPlan";
import {
  callEmbeddings,
  checkEmbeddingAvailability,
  type ChatParams,
  type ReasoningConfig,
} from "../../utils/llmClient";
import type { ProviderProtocol } from "../../utils/providerProtocol";
import {
  formatPaperCitationLabel,
  formatPaperSourceLabel,
} from "../../modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../../shared/types";
import { PdfService } from "./pdfService";

type RetrievalResult = {
  paperContext: PaperContextRef;
  chunkIndex: number;
  sectionLabel?: string;
  chunkKind?: string;
  citationLabel: string;
  sourceLabel: string;
  text: string;
  score: number;
  sourceStart?: number;
  sourceEnd?: number;
  sourceFingerprint?: string;
  pageStart?: number;
  pageEnd?: number;
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
    const key = `${entry.itemId}:${entry.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

type EvidenceCacheKey = string;

function buildEvidenceCacheKey(
  contextItemId: number,
  queryKey: string,
): EvidenceCacheKey {
  // Strip punctuation and normalise whitespace so minor phrasing variations
  // (e.g. "What is the method?" vs "what is the method") share a cache entry.
  const normalizedQ = queryKey
    .trim()
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${contextItemId}::${normalizedQ}`;
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
    reasoning?: ReasoningConfig;
    signal?: AbortSignal;
    topK?: number;
    perPaperTopK?: number;
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
      reasoning: params.reasoning,
      signal: params.signal,
      sourceSamples: papers.map((paperContext) => {
        const pdfContext = pdfContexts.get(paperContext.contextItemId);
        return [paperContext.title, pdfContext?.chunks[0] || ""]
          .filter(Boolean)
          .join("\n");
      }),
    });
    const queryCacheKey = buildRetrievalQueryPlanCacheKey(queryPlan);
    let embeddingsAvailable = false;
    try {
      embeddingsAvailable = checkEmbeddingAvailability();
    } catch {
      embeddingsAvailable = false;
    }
    let precomputedQueryEmbedding: number[] | undefined;
    if (queryPlan.semanticQuery.trim() && embeddingsAvailable) {
      try {
        precomputedQueryEmbedding = (
          await callEmbeddings([queryPlan.semanticQuery])
        )[0];
      } catch {
        // Embedding unavailable — buildPaperRetrievalCandidates will fall back.
      }
    }
    const results: RetrievalResult[] = [];
    for (const paperContext of papers) {
      const cacheKey = buildEvidenceCacheKey(
        paperContext.contextItemId,
        queryCacheKey,
      );
      const cached = this.evidenceCache.get(cacheKey);
      if (cached) {
        results.push(...cached);
        continue;
      }
      const pdfContext = pdfContexts.get(paperContext.contextItemId);
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        params.question,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
          precomputedQueryEmbedding,
          queryPlan,
        },
        {
          topK: perPaperTopK,
          mode: "evidence",
          precomputedQueryEmbedding,
          queryPlan,
        },
      );
      const paperResults: RetrievalResult[] = candidates.map((candidate) => ({
        paperContext,
        chunkIndex: candidate.chunkIndex,
        sectionLabel: candidate.sectionLabel,
        chunkKind: candidate.chunkKind,
        citationLabel: formatPaperCitationLabel(paperContext),
        sourceLabel: formatPaperSourceLabel(paperContext),
        text: candidate.chunkText,
        score: candidate.evidenceScore,
        sourceStart: candidate.sourceStart,
        sourceEnd: candidate.sourceEnd,
        sourceFingerprint: candidate.sourceFingerprint,
        pageStart: candidate.pageStart,
        pageEnd: candidate.pageEnd,
      }));
      this.evidenceCache.set(cacheKey, paperResults);
      results.push(...paperResults);
    }
    results.sort((a, b) => b.score - a.score || a.chunkIndex - b.chunkIndex);
    return results.slice(0, topK);
  }

  clearEvidenceCache(): void {
    this.evidenceCache.clear();
  }
}
