import {
  buildEvidencePack,
  buildPaperKey,
} from "../../modules/contextPanel/pdfContext";
import type { PaperContextCandidate } from "../../modules/contextPanel/types";
import type { PaperContextRef } from "../../shared/types";
import { chunkKindFromSectionLabel } from "../../shared/libraryChatEvidencePolicy";

type LibraryRetrieveEvidenceSnippet = {
  itemId: string;
  contextItemId?: string;
  chunkIndex?: number;
  title: string;
  sectionLabel?: string;
  snippet: string;
  surroundingText?: string;
  matchMethod: "metadata" | "exact" | "fts" | "bm25" | "semantic";
  score: number;
  matchedQueryVariant?: string;
};

export function buildLibraryRetrieveEvidencePack(params: {
  papers: PaperContextRef[];
  snippets: LibraryRetrieveEvidenceSnippet[];
}): {
  evidenceLedgerText?: string;
  synthesisDigest?: string;
} {
  const paperByKey = new Map(
    params.papers.map((paper) => [buildPaperKey(paper), paper]),
  );
  if (!paperByKey.size) return {};
  const candidates: PaperContextCandidate[] = [];
  for (const [index, snippet] of params.snippets.entries()) {
    if (!snippet.contextItemId) continue;
    const itemId = Number(snippet.itemId);
    const contextItemId = Number(snippet.contextItemId);
    if (
      !Number.isFinite(itemId) ||
      !Number.isFinite(contextItemId) ||
      itemId <= 0 ||
      contextItemId <= 0
    ) {
      continue;
    }
    const paperKey = `${Math.floor(itemId)}:${Math.floor(contextItemId)}`;
    if (!paperByKey.has(paperKey)) continue;
    candidates.push({
      paperKey,
      itemId,
      contextItemId,
      title: snippet.title,
      chunkIndex: snippet.chunkIndex ?? index,
      chunkText: snippet.surroundingText || snippet.snippet,
      sectionLabel: snippet.sectionLabel,
      chunkKind: chunkKindFromSectionLabel(snippet.sectionLabel),
      estimatedTokens: Math.max(1, Math.ceil(snippet.snippet.length / 4)),
      bm25Score: snippet.matchMethod === "bm25" ? snippet.score : 0,
      embeddingScore: snippet.matchMethod === "semantic" ? snippet.score : 0,
      hybridScore: snippet.score,
      evidenceScore: snippet.score,
      matchedQueryVariant: snippet.matchedQueryVariant,
    });
  }
  const pack = buildEvidencePack({
    papers: params.papers,
    candidates,
    quoteAnchorPolicy: "none",
  });
  return {
    evidenceLedgerText: pack.ledgerText || undefined,
    synthesisDigest: pack.synthesisDigest || undefined,
  };
}
