import { assert } from "chai";
import {
  PDFDocument,
  PDFName,
  PDFRawStream,
  decodePDFRawStream,
} from "pdf-lib";
import {
  openPdfSplitter,
  PdfSplitterCancelledError,
} from "../src/utils/pdfSplitter";
import {
  createPdfFixture,
  createPdfWithHiddenPageCount,
} from "./helpers/pdfFixture";
import { createEncryptedPdfFixture } from "./helpers/encryptedPdfFixture";
import {
  installPdfWorkerTestHost,
  closePdfWorkersForTests,
} from "./helpers/pdfWorkerHost";

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error("Expected rejection");
}

describe("bundled PDF splitter", function () {
  beforeEach(function () {
    (globalThis as any).Zotero = {};
    installPdfWorkerTestHost();
  });
  afterEach(async function () {
    await closePdfWorkersForTests();
    delete (globalThis as any).Zotero;
  });

  it("extracts every page exactly once in order and preserves the original bytes", async function () {
    const source = createPdfFixture(401);
    const original = source.slice();
    const session = await openPdfSplitter(source);
    try {
      assert.equal(session.pageCount, 401);
      const markers: string[] = [];
      for (const [start, end] of [
        [1, 200],
        [201, 400],
        [401, 401],
      ]) {
        const doc = await PDFDocument.load(
          await session.extractPages(start, end),
        );
        assert.equal(doc.getPageCount(), end - start + 1);
        for (const page of doc.getPages()) {
          const contents = page.node.lookup(
            PDFName.of("Contents"),
            PDFRawStream,
          );
          const text = new TextDecoder().decode(
            decodePDFRawStream(contents).decode(),
          );
          markers.push(/\(PAGE (\d+)\)/.exec(text)![1]);
        }
      }
      assert.deepEqual(
        markers,
        Array.from({ length: 401 }, (_, i) => String(i + 1)),
      );
      assert.deepEqual(source, original, "the source buffer remains intact");
    } finally {
      session.close();
    }
  });

  it("counts a compressed page tree whose count is hidden from text scanning", async function () {
    const session = await openPdfSplitter(
      await createPdfWithHiddenPageCount(201),
    );
    try {
      assert.equal(session.pageCount, 201);
    } finally {
      session.close();
    }
  });

  it("rejects real encrypted PDFs with an actionable message", async function () {
    const error = await rejected(openPdfSplitter(createEncryptedPdfFixture()));
    assert.include(error.message, "encrypted");
    assert.include(error.message, "unencrypted copy");
  });

  it("rejects malformed PDFs and documents without pages", async function () {
    assert.include(
      (await rejected(openPdfSplitter(new TextEncoder().encode("not a PDF"))))
        .message,
      "Unable to prepare PDF",
    );
    assert.include(
      (await rejected(openPdfSplitter(createPdfFixture(0)))).message,
      "no pages",
    );
  });

  it("rejects invalid ranges without preventing a later valid extraction", async function () {
    const session = await openPdfSplitter(createPdfFixture(2));
    try {
      for (const [start, end] of [
        [0, 1],
        [2, 1],
        [1, 3],
        [1.5, 2],
      ]) {
        assert.include(
          (await rejected(session.extractPages(start, end))).message,
          "Invalid PDF page range",
        );
      }
      assert.equal(
        (
          await PDFDocument.load(await session.extractPages(2, 2))
        ).getPageCount(),
        1,
      );
    } finally {
      session.close();
    }
  });

  for (const phase of ["before opening", "while opening", "while extracting"]) {
    it(`terminates work on cancellation ${phase}`, async function () {
      const controller = new AbortController();
      if (phase === "before opening") controller.abort();
      if (phase === "while extracting") {
        const session = await openPdfSplitter(
          createPdfFixture(401),
          controller.signal,
        );
        const pending = session.extractPages(1, 200);
        controller.abort();
        assert.instanceOf(await rejected(pending), PdfSplitterCancelledError);
        assert.instanceOf(
          await rejected(session.extractPages(201, 400)),
          PdfSplitterCancelledError,
        );
        session.close();
      } else {
        const pending = openPdfSplitter(
          createPdfFixture(401),
          controller.signal,
        );
        controller.abort();
        assert.instanceOf(await rejected(pending), PdfSplitterCancelledError);
      }
    });
  }
});
