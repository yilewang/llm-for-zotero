import { assert } from "chai";
import {
  buildFullPaperContext,
  buildPaperKey,
  buildPaperRetrievalCandidates,
  renderEvidencePack,
} from "../src/modules/contextPanel/pdfContext";
import type {
  ChunkStat,
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) || []).filter(
    (token) => token.length >= 3,
  );
}

function buildPdfContext(chunks: string[]): PdfContext {
  const docFreq: Record<string, number> = {};
  const chunkStats: ChunkStat[] = chunks.map((chunk, index) => {
    const tf: Record<string, number> = {};
    const terms = tokenize(chunk);
    for (const term of terms) {
      tf[term] = (tf[term] || 0) + 1;
    }
    const uniqueTerms = Object.keys(tf);
    for (const term of uniqueTerms) {
      docFreq[term] = (docFreq[term] || 0) + 1;
    }
    return {
      index,
      length: terms.length,
      tf,
      uniqueTerms,
    };
  });
  const avgChunkLength = chunkStats.length
    ? chunkStats.reduce((sum, chunk) => sum + chunk.length, 0) /
      chunkStats.length
    : 0;
  return {
    title: "Mock Paper",
    chunks,
    chunkStats,
    docFreq,
    avgChunkLength,
    fullLength: chunks.join("\n\n").length,
    embeddingFailed: true,
  };
}

describe("pdfContext multi-context helpers", function () {
  it("builds retrieval candidates with scores and metadata", async function () {
    const paper: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
      firstCreator: "Alice",
      year: "2024",
    };
    const context = buildPdfContext([
      "Gamma delta shared finding from paper A.",
      "Ablation and method details.",
      "Unrelated appendix details.",
    ]);
    const candidates = await buildPaperRetrievalCandidates(
      paper,
      context,
      "gamma delta finding",
      undefined,
      { topK: 2 },
    );
    assert.lengthOf(candidates, 2);
    assert.equal(candidates[0].paperKey, buildPaperKey(paper));
    assert.equal(candidates[0].itemId, 1);
    assert.isAtLeast(candidates[0].estimatedTokens, 1);
  });

  it("renders full paper context with metadata", function () {
    const paper: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
      citationKey: "Smith2023",
      firstCreator: "Smith",
      year: "2023",
    };
    const context = buildPdfContext(["Main finding.", "Conclusion."]);
    const text = buildFullPaperContext(paper, context);
    assert.include(text, "Title: Paper B");
    assert.include(text, "Citation key: Smith2023");
    assert.include(text, "Paper Text:");
  });

  it("renders evidence pack with stable chunk labels", function () {
    const paperA: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
    };
    const paperB: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
    };
    const rendered = renderEvidencePack({
      papers: [paperA, paperB],
      candidates: [
        {
          paperKey: buildPaperKey(paperA),
          itemId: 1,
          contextItemId: 11,
          title: "Paper A",
          chunkIndex: 3,
          chunkText: "Shared claim A",
          estimatedTokens: 8,
          bm25Score: 0.7,
          embeddingScore: 0.1,
          hybridScore: 0.4,
        },
        {
          paperKey: buildPaperKey(paperB),
          itemId: 2,
          contextItemId: 22,
          title: "Paper B",
          chunkIndex: 1,
          chunkText: "Shared claim B",
          estimatedTokens: 8,
          bm25Score: 0.6,
          embeddingScore: 0.2,
          hybridScore: 0.4,
        },
      ],
    });
    assert.include(rendered, "[P1-C4]");
    assert.include(rendered, "[P2-C2]");
  });
});
