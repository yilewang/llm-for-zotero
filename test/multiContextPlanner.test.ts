import { assert } from "chai";
import {
  assembleFullMultiPaperContext,
  assembleRetrievedMultiPaperContext,
  selectContextAssemblyMode,
} from "../src/modules/contextPanel/multiContextPlanner";
import { buildPaperKey } from "../src/modules/contextPanel/pdfContext";
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

function buildPdfContext(title: string, chunks: string[]): PdfContext {
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
    title,
    chunks,
    chunkStats,
    docFreq,
    avgChunkLength,
    fullLength: chunks.join("\n\n").length,
    embeddingFailed: true,
  };
}

describe("multiContextPlanner", function () {
  it("selects full mode when full text fits context budget", function () {
    const mode = selectContextAssemblyMode({
      fullContextText: "A short full context",
      fullContextTokens: 120,
      contextBudgetTokens: 2_000,
    });
    assert.equal(mode, "full");
  });

  it("selects retrieval mode when full text exceeds context budget", function () {
    const mode = selectContextAssemblyMode({
      fullContextText: "Very long context",
      fullContextTokens: 12_000,
      contextBudgetTokens: 1_500,
    });
    assert.equal(mode, "retrieval");
  });

  it("assembles retrieval evidence with per-paper coverage", async function () {
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
    const papers = [
      {
        paperContext: paperA,
        contextItem: null,
        pdfContext: buildPdfContext("A", [
          "shared phenomenon and common result",
          "method details and calibration",
          "additional shared analysis",
        ]),
      },
      {
        paperContext: paperB,
        contextItem: null,
        pdfContext: buildPdfContext("B", [
          "common result appears again in paper B",
          "implementation details",
          "discussion on shared behavior",
        ]),
      },
    ];
    const result = await assembleRetrievedMultiPaperContext({
      papers: papers as any,
      question: "summarize common result",
      contextBudgetTokens: 10_000,
      activePaperKey: buildPaperKey(paperA),
    });
    assert.isAtLeast(result.selectedChunkCount, 3);
    assert.include(result.contextText, "[P1-");
    assert.include(result.contextText, "[P2-");
  });

  it("assembles full multi-paper context blocks", function () {
    const paperA: PaperContextRef = {
      itemId: 3,
      contextItemId: 33,
      title: "Paper C",
    };
    const full = assembleFullMultiPaperContext({
      papers: [
        {
          paperContext: paperA,
          contextItem: null,
          pdfContext: buildPdfContext("C", ["Full text block one.", "Two."]),
        },
      ] as any,
    });
    assert.include(full.contextText, "Full Paper Contexts:");
    assert.include(full.contextText, "Paper 1");
    assert.isAbove(full.estimatedTokens, 0);
  });
});
