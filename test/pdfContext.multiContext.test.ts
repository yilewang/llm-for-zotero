import { assert } from "chai";
import {
  buildChunkMetadata,
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
    chunkMeta: buildChunkMetadata(chunks),
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
      firstCreator: "Smith et al.",
      year: "2023",
    };
    const context = buildPdfContext(["Main finding.", "Conclusion."]);
    const text = buildFullPaperContext(paper, context);
    assert.include(text, "Title: Paper B");
    assert.include(text, "Citation key: Smith2023");
    assert.include(text, "Source label: (Smith et al., 2023)");
    assert.include(text, "Answer format when quoting this paper:");
    assert.include(text, "Paper Text:");
  });

  it("renders evidence pack with quote-plus-source formatting", function () {
    const paperA: PaperContextRef = {
      itemId: 1,
      contextItemId: 11,
      title: "Paper A",
      firstCreator: "Zheng et al.",
      year: "2026",
    };
    const paperB: PaperContextRef = {
      itemId: 2,
      contextItemId: 22,
      title: "Paper B",
      citationKey: "Smith2023",
    };
    const rendered = renderEvidencePack({
      papers: [paperA, paperB],
      candidates: [
        {
          paperKey: buildPaperKey(paperA),
          itemId: 1,
          contextItemId: 11,
          title: "Paper A",
          firstCreator: "Zheng et al.",
          year: "2026",
          chunkIndex: 3,
          chunkText:
            "Abstract\nDespite global representational drift, the relative geometry remained stable across conditions.",
          estimatedTokens: 8,
          bm25Score: 0.7,
          embeddingScore: 0.1,
          hybridScore: 0.4,
          evidenceScore: 1.3,
        },
        {
          paperKey: buildPaperKey(paperB),
          itemId: 2,
          contextItemId: 22,
          title: "Paper B",
          citationKey: "Smith2023",
          chunkIndex: 1,
          chunkText: "Shared claim B",
          estimatedTokens: 8,
          bm25Score: 0.6,
          embeddingScore: 0.2,
          hybridScore: 0.4,
          evidenceScore: 0.9,
        },
      ],
    });
    assert.include(
      rendered,
      "Paper-grounded citation format for the final answer:",
    );
    assert.include(rendered, "Source label: (Zheng et al., 2026)");
    assert.include(
      rendered,
      "> Despite global representational drift, the relative geometry remained stable across conditions.",
    );
    assert.include(rendered, "Source label: (Paper 2)");
    assert.include(rendered, "> Shared claim B");
    assert.notInclude(rendered, "[P1-C4]");
  });

  it("builds chunk metadata with section labels and cleaned anchors", function () {
    const metadata = buildChunkMetadata([
      "Results\n\n23 activity. Representational drift increases over days.",
    ]);
    assert.lengthOf(metadata, 1);
    assert.equal(metadata[0].sectionLabel, "Results");
    assert.equal(metadata[0].chunkKind, "results");
    assert.equal(
      metadata[0].anchorText,
      "Representational drift increases over days.",
    );
    assert.isTrue(Boolean(metadata[0].leadingNoiseRemoved));
  });

  it("recognizes supplementary figure captions as figure-caption chunks", function () {
    const metadata = buildChunkMetadata([
      "Figure S7. Preserved relationship between place and grid cells across environments.",
    ]);
    assert.lengthOf(metadata, 1);
    assert.equal(metadata[0].chunkKind, "figure-caption");
  });
});
