import { assert } from "chai";
import { buildChunkMetadata } from "../src/modules/contextPanel/pdfContext";
import { executeReadPaperTextCall } from "../src/modules/contextPanel/Agent/Tools/readPaperText";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type { PdfContext, PaperContextRef } from "../src/modules/contextPanel/types";

describe("readPaperText", function () {
  const paper: PaperContextRef = {
    itemId: 1,
    contextItemId: 100,
    title: "Tool Paper",
    attachmentTitle: "PDF A",
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

  it("returns ordered full paper text when cached PDF text exists", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext(["First section.", "Second section."]),
    );
    const result = await executeReadPaperTextCall(
      {
        question: "read the full paper",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 3000,
      },
      {
        name: "read_paper_text",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Kim et al., 2025 - Tool Paper - Attachment: PDF A",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "Source label: (Kim et al., 2025)");
    assert.include(result.groundingText, "Answer format when quoting this paper:");
    assert.include(result.groundingText, "Paper Text:");
    assert.include(result.groundingText, "First section.");
    assert.include(result.groundingText, "Second section.");
    assert.deepEqual(result.addedPaperContexts, [paper]);
    assert.include(result.traceLines[0], "Attachment: PDF A");
  });

  it("truncates at chunk boundaries under the tool cap", async function () {
    pdfTextCache.set(
      contextItem.id,
      buildPdfContext(
        Array.from({ length: 60 }, (_, index) =>
          `Section ${index + 1}: ${"detail ".repeat(80)}`,
        ),
      ),
    );
    const result = await executeReadPaperTextCall(
      {
        question: "read the full paper",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
        toolTokenCap: 3000,
      },
      {
        name: "read_paper_text",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Tool Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.truncated);
    assert.isAtMost(result.estimatedTokens, 3000);
    assert.notInclude(result.groundingText, "Section 60");
    assert.include(result.traceLines[0], "truncated by tool budget");
  });

  it("returns metadata-only output when extractable text is unavailable", async function () {
    pdfTextCache.set(contextItem.id, buildPdfContext([]));
    const result = await executeReadPaperTextCall(
      {
        question: "read the full paper",
        libraryID: 5,
        conversationMode: "open",
        selectedPaperContexts: [],
        pinnedPaperContexts: [],
        recentPaperContexts: [],
        retrievedPaperContexts: [],
      },
      {
        name: "read_paper_text",
        target: { scope: "retrieved-paper", index: 1 },
      },
      {
        paperContext: paper,
        contextItem,
        targetLabel: "Tool Paper",
        resolvedKey: "1:100",
      },
    );

    assert.isTrue(result.ok);
    assert.include(result.groundingText, "Extractable full text available: no");
    assert.include(result.groundingText, "Source label: (Kim et al., 2025)");
    assert.include(result.groundingText, "[No extractable PDF text available.");
  });
});
