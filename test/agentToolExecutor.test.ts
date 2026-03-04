import { assert } from "chai";
import { buildChunkMetadata } from "../src/modules/contextPanel/pdfContext";
import {
  createAgentToolExecutorState,
  executeAgentToolCall,
} from "../src/modules/contextPanel/Agent/ToolInfra/executor";
import { pdfTextCache } from "../src/modules/contextPanel/state";
import type {
  PaperContextRef,
  PdfContext,
} from "../src/modules/contextPanel/types";

describe("agentToolExecutor", function () {
  const originalZotero = globalThis.Zotero;
  const paper: PaperContextRef = {
    itemId: 1,
    contextItemId: 100,
    title: "Executor Paper",
  };

  beforeEach(function () {
    pdfTextCache.clear();
    const items = new Map<number, any>([
      [
        100,
        {
          id: 100,
          isAttachment: () => true,
          attachmentContentType: "application/pdf",
        },
      ],
    ]);
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        get: (id: number) => items.get(id) || null,
      },
    } as typeof Zotero;
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
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

  it("skips duplicate exact tool calls within a request", async function () {
    pdfTextCache.set(100, buildPdfContext(["A", "B"]));
    const state = createAgentToolExecutorState();
    const ctx = {
      question: "read full paper",
      libraryID: 5,
      conversationMode: "open" as const,
      activePaperContext: paper,
      selectedPaperContexts: [],
      pinnedPaperContexts: [],
      recentPaperContexts: [],
      retrievedPaperContexts: [paper],
    };
    const first = await executeAgentToolCall({
      call: {
        name: "read_paper_text",
        target: { scope: "retrieved-paper", index: 1 },
      },
      ctx,
      state,
    });
    const second = await executeAgentToolCall({
      call: {
        name: "read_paper_text",
        target: { scope: "retrieved-paper", index: 1 },
      },
      ctx,
      state,
    });

    assert.isTrue(first?.ok);
    assert.isFalse(second?.ok);
    assert.include(second?.traceLines[0] || "", "Duplicate tool call");
  });
});
