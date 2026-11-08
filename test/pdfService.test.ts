import { assert } from "chai";
import { PdfService } from "../src/agent/services/pdfService";
import { paperTextStore } from "../src/services/paperContent/paperTextStore";
import type { PdfContext } from "../src/services/paperContent/types";
import { configureRetrievalCandidateInvalidator } from "../src/services/retrieval/cacheInvalidation";
import { clearPageTextCache } from "../src/services/pdf/livePdfSelectionLocator";
import type { PaperContextRef } from "../src/shared/types";
import {
  mockPdfAttachment,
  restoreTestGlobals,
  setupMemoryIO,
  setupZoteroGlobals,
  snapshotTestGlobals,
  type TestGlobalSnapshot,
} from "./helpers/retrievalCorpus";

const attachmentId = 201;
const paperContext: PaperContextRef = {
  itemId: 100,
  contextItemId: attachmentId,
  title: "Synthetic overview paper",
  firstCreator: "Example",
  year: "2026",
};

function cachedContext(
  chunks: string[],
  sourceType?: PdfContext["sourceType"],
): PdfContext {
  return {
    title: paperContext.title,
    chunks,
    chunkMeta: [],
    chunkStats: [],
    docFreq: {},
    avgChunkLength: 0,
    fullLength: chunks.join("\n\n").length,
    sourceType,
  };
}

describe("PdfService overview provenance", function () {
  let globals: TestGlobalSnapshot;
  let invalidated: Array<number | undefined>;
  let restoreInvalidator: () => void;

  beforeEach(function () {
    globals = snapshotTestGlobals();
    invalidated = [];
    restoreInvalidator = configureRetrievalCandidateInvalidator((id) =>
      invalidated.push(id),
    );
    setupMemoryIO();
    setupZoteroGlobals(paperContext.title);
    const attachment = mockPdfAttachment(attachmentId);
    const parent = {
      isRegularItem: () => true,
      getAttachments: () => [attachmentId],
      getField: (field: string) =>
        field === "title" ? paperContext.title : "",
    };
    Zotero.Items.get = ((id: number) =>
      id === attachmentId
        ? attachment
        : id === paperContext.itemId
          ? parent
          : null) as typeof Zotero.Items.get;
  });

  afterEach(function () {
    restoreInvalidator();
    clearPageTextCache();
    restoreTestGlobals(globals);
  });

  for (const sourceType of [
    "mineru",
    "zotero-worker",
    "zotero-fulltext-cache",
    undefined,
  ] as const) {
    const backend = sourceType === "mineru" ? "mineru" : "raw_pdf_text";

    it(`reports ${sourceType ?? "legacy"} provenance for a complete overview`, async function () {
      const chunks = ["Synthetic abstract.", "Synthetic methods."];
      const originalChunks = [...chunks];
      const cached = cachedContext(chunks, sourceType);
      paperTextStore.write(attachmentId, cached);

      const result = await new PdfService().getOverviewExcerpt({
        paperContext,
      });

      assert.equal(result.backend, backend);
      assert.equal(
        result.text,
        "[chunk 0]\nSynthetic abstract.\n\n[chunk 1]\nSynthetic methods.",
      );
      assert.deepEqual(result.chunkIndexes, [0, 1]);
      assert.equal(result.totalChunks, 2);
      assert.strictEqual(result.paperContext, paperContext);
      assert.strictEqual(paperTextStore.peek(attachmentId), cached);
      assert.deepEqual(cached.chunks, originalChunks);
    });

    it(`reports ${sourceType ?? "legacy"} provenance for a sampled overview`, async function () {
      const chunks = [
        `Introduction\n${"i".repeat(300)}`,
        `Methods\n${"m".repeat(300)}`,
        `Results\n${"r".repeat(300)}`,
        `Supplement\n${"x".repeat(300)}`,
        `Discussion\n${"d".repeat(300)}`,
        `Supporting observations\n${"s".repeat(300)}`,
      ];
      const originalChunks = [...chunks];
      const cached = cachedContext(chunks, sourceType);
      paperTextStore.write(attachmentId, cached);

      const result = await new PdfService().getOverviewExcerpt({
        paperContext,
        maxChars: 1800,
      });

      assert.equal(result.backend, backend);
      assert.deepEqual(result.chunkIndexes, [0, 1, 2, 4, 5]);
      assert.equal(
        result.text,
        [0, 1, 2, 4, 5]
          .map((index) => `[chunk ${index}]\n${originalChunks[index]}`)
          .join("\n\n"),
      );
      assert.equal(result.totalChunks, 6);
      assert.strictEqual(result.paperContext, paperContext);
      assert.strictEqual(paperTextStore.peek(attachmentId), cached);
      assert.deepEqual(cached.chunks, originalChunks);
    });
  }

  it("respects an explicit text source when MinerU text was previously cached", async function () {
    paperTextStore.write(
      attachmentId,
      cachedContext(["Synthetic MinerU-only content."], "mineru"),
    );
    let workerCalls = 0;
    Zotero.PDFWorker.getFullText = (async () => {
      workerCalls += 1;
      return { text: "Synthetic native PDF content." };
    }) as typeof Zotero.PDFWorker.getFullText;
    const textContext: PaperContextRef = {
      ...paperContext,
      contentSourceMode: "text",
    };

    const result = await new PdfService().getOverviewExcerpt({
      paperContext: textContext,
    });

    assert.equal(workerCalls, 1);
    assert.deepEqual(invalidated, [attachmentId]);
    assert.equal(result.backend, "raw_pdf_text");
    assert.include(result.text, "Synthetic native PDF content.");
    assert.notInclude(result.text, "Synthetic MinerU-only content.");
    assert.equal(
      paperTextStore.peek(attachmentId)?.sourceType,
      "zotero-worker",
    );
    assert.strictEqual(result.paperContext, textContext);
  });

  it("reports the actual PDF fallback even when MinerU was requested", async function () {
    Zotero.Prefs.get = (() => false) as typeof Zotero.Prefs.get;
    Zotero.PDFWorker.getFullText = (async () => ({
      text: "Synthetic fallback PDF content.",
    })) as typeof Zotero.PDFWorker.getFullText;
    const mineruContext: PaperContextRef = {
      ...paperContext,
      contentSourceMode: "mineru",
    };

    const result = await new PdfService().getOverviewExcerpt({
      paperContext: mineruContext,
    });

    assert.equal(result.backend, "raw_pdf_text");
    assert.include(result.text, "Synthetic fallback PDF content.");
    assert.equal(
      paperTextStore.peek(attachmentId)?.sourceType,
      "zotero-worker",
    );
    assert.strictEqual(result.paperContext, mineruContext);
  });

  it("retains the no-text failure for an empty cached context", async function () {
    paperTextStore.write(attachmentId, cachedContext([], "mineru"));

    try {
      await new PdfService().getOverviewExcerpt({ paperContext });
      assert.fail("Expected the overview to reject empty text");
    } catch (error) {
      assert.equal(
        (error as Error).message,
        "No extractable PDF text available for this paper",
      );
    }
  });

  it("retains the no-text failure when extraction produces no text", async function () {
    Zotero.Prefs.get = (() => false) as typeof Zotero.Prefs.get;

    try {
      await new PdfService().getOverviewExcerpt({ paperContext });
      assert.fail("Expected the overview to reject missing text");
    } catch (error) {
      assert.equal(
        (error as Error).message,
        "No extractable PDF text available for this paper",
      );
    }
  });
});
