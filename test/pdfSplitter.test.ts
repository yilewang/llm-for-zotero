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
  readPdfOutlineInWorker,
} from "../src/utils/pdfSplitter";
import { createPdfWithOutline } from "./helpers/outlinePdfFixture";
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

describe("bundled PDF bookmark reader", function () {
  beforeEach(function () {
    (globalThis as any).Zotero = {};
    installPdfWorkerTestHost();
  });
  afterEach(async function () {
    await closePdfWorkersForTests();
    delete (globalThis as any).Zotero;
  });

  it("reads nested bookmarks with pages, depths, tops and named destinations", async function () {
    const bytes = await createPdfWithOutline({
      pages: [["Preface"], ["Chapter 1"], ["more"], ["Chapter 2"]],
      outline: [
        { title: "Preface", page: 0 },
        {
          title: "  Chapter 1  Basics ",
          page: 1,
          top: 560,
          children: [{ title: "1.1 Start", page: 2, top: 300, named: true }],
        },
        { title: "Chapter 2", page: 3, top: 560, named: true },
      ],
    });
    const result = await readPdfOutlineInWorker(bytes);
    assert.deepEqual(result, {
      status: "ok",
      pageCount: 4,
      entries: [
        { depth: 0, title: "Preface", pageIndex: 0, top: null, fitsPage: true },
        {
          depth: 0,
          title: "Chapter 1 Basics",
          pageIndex: 1,
          top: 560,
          fitsPage: false,
        },
        {
          depth: 1,
          title: "1.1 Start",
          pageIndex: 2,
          top: 300,
          fitsPage: false,
        },
        {
          depth: 0,
          title: "Chapter 2",
          pageIndex: 3,
          top: 560,
          fitsPage: false,
        },
      ],
    });
  });

  it("keeps bookmark titles in any script unchanged", async function () {
    const titles = [
      "第3章 研究方法",
      "第三章 结果与讨论",
      "Глава 2 Обзор литературы",
      "Kapitel 4 Ergebnisse und Diskussion",
      "الفصل 5 الخلاصة",
    ];
    const bytes = await createPdfWithOutline({
      pages: titles.map(() => ["page"]).concat([["page"]]),
      outline: [
        ...titles.map((title, page) => ({ title, page, top: 560 })),
        { title: "Kapitel 6 Überblick", page: 5, top: 560, literal: true },
      ],
    });
    const result = await readPdfOutlineInWorker(bytes);
    assert.equal(result.status, "ok");
    assert.deepEqual(
      result.status === "ok" ? result.entries.map((entry) => entry.title) : [],
      [...titles, "Kapitel 6 Überblick"],
    );
  });

  it("answers an empty list for a PDF without bookmarks", async function () {
    const result = await readPdfOutlineInWorker(createPdfFixture(3));
    assert.deepEqual(result, { status: "ok", pageCount: 3, entries: [] });
  });

  it("answers encrypted for an encrypted PDF", async function () {
    const result = await readPdfOutlineInWorker(createEncryptedPdfFixture());
    assert.deepEqual(result, { status: "encrypted" });
  });

  it("rejects bytes that are not a PDF", async function () {
    const error = await rejected(
      readPdfOutlineInWorker(new TextEncoder().encode("not a pdf")),
    );
    assert.match(error.message, /bookmarks/);
  });
});
