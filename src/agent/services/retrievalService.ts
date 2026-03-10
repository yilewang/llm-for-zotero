import {
  buildPaperRetrievalCandidates,
} from "../../modules/contextPanel/pdfContext";
import { formatPaperSourceLabel } from "../../modules/contextPanel/paperAttribution";
import type { PaperContextRef } from "../../modules/contextPanel/types";
import { PdfService } from "./pdfService";

type RetrievalResult = {
  paperContext: PaperContextRef;
  chunkIndex: number;
  sectionLabel?: string;
  chunkKind?: string;
  sourceLabel: string;
  text: string;
  score: number;
};

function dedupePaperContexts(
  paperContexts: PaperContextRef[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const entry of paperContexts) {
    if (!entry || !Number.isFinite(entry.itemId) || !Number.isFinite(entry.contextItemId)) continue;
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
  question: string,
): EvidenceCacheKey {
  // Strip punctuation and normalise whitespace so minor phrasing variations
  // (e.g. "What is the method?" vs "what is the method") share a cache entry.
  const normalizedQ = question
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
    apiBase?: string;
    apiKey?: string;
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
    const results: RetrievalResult[] = [];
    for (const paperContext of papers) {
      const cacheKey = buildEvidenceCacheKey(
        paperContext.contextItemId,
        params.question,
      );
      const cached = this.evidenceCache.get(cacheKey);
      if (cached) {
        results.push(...cached);
        continue;
      }
      const pdfContext = await this.pdfService.ensurePaperContext(paperContext);
      const candidates = await this.candidateBuilder(
        paperContext,
        pdfContext,
        params.question,
        {
          apiBase: params.apiBase,
          apiKey: params.apiKey,
        },
        {
          topK: perPaperTopK,
          mode: "evidence",
        },
      );
      const paperResults: RetrievalResult[] = candidates.map((candidate) => ({
        paperContext,
        chunkIndex: candidate.chunkIndex,
        sectionLabel: candidate.sectionLabel,
        chunkKind: candidate.chunkKind,
        sourceLabel: formatPaperSourceLabel(paperContext),
        text: candidate.chunkText,
        score: candidate.evidenceScore,
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
