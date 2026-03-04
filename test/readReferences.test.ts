import { assert } from "chai";
import { buildChunkMetadata } from "../src/modules/contextPanel/pdfContext";
import { executeReadReferencesCall } from "../src/modules/contextPanel/Agent/Tools/readReferences";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type { PaperContextRef, PdfContext } from "../src/modules/contextPanel/types";

describe("readReferences", function () {
  const paper: PaperContextRef = {
    itemId: 1,
    contextItemId: 100,
    title: "References Paper",
    firstCreator: "Kim",
    year: "2025",
  };
  const contextItem = {
    id: 100,
    isAttachment: () => true,
    attachmentContentType: "application/pdf",
  } as unknown as Zotero.Item;

  beforeEach(function () {
    pdfTextCache.clear();
  });

  function buildPdfContext(chunks: string[]): PdfContext {
    return {
      title: paper.title,
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: chunks.join("\n\n").length,
      embeddingFailed: true,
    };
  }

  it("extracts numbered reference entries from a references section", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([
        "Introduction\n\nWe build on prior work in policy learning.",
        "Results\n\nThe method outperforms previous baselines.",
        "References\n\n[1] Ho, J., Jain, A., and Abbeel, P. (2020). Denoising diffusion probabilistic models.\n\n[2] Chi, C., Feng, S., Du, Y. (2023). Diffusion policy: Visuomotor policy learning via action diffusion.",
      ]),
    );

    const result = await executeReadReferencesCall(
      {
        question: "What does this paper cite?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 1500,
      },
      {
        name: "read_references",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "References Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "- Tool: read_references");
    assert.include(result.groundingText, "References section found: yes");
    assert.include(result.groundingText, "Denoising diffusion probabilistic models");
    assert.include(result.groundingText, "Diffusion policy: Visuomotor policy learning");
    assert.deepEqual(result.addedPaperContexts, [paper]);
  });

  it("returns a graceful message when no references section is found", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext([
        "Introduction\n\nThis paper presents a method.",
        "Conclusion\n\nFuture work will explore more tasks.",
      ]),
    );

    const result = await executeReadReferencesCall(
      {
        question: "What references are cited?",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "read_references",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "References Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "References section found: no");
    assert.include(result.groundingText, "No references or bibliography section heading");
  });
});
