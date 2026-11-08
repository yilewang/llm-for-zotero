import { assert } from "chai";
import {
  clearPdfBookmarksCache,
  readPdfBookmarks,
  type PdfOutlineReader,
} from "../src/services/paperContent/pdfBookmarks";
import { PdfSplitterCancelledError } from "../src/utils/pdfSplitter";

const fileState = { path: "/papers/book.pdf", size: 10, mtime: 1 };
const entries = [
  { depth: 0, title: "Preface", pageIndex: 0, top: null, fitsPage: true },
];

describe("PDF bookmark reads", function () {
  afterEach(clearPdfBookmarksCache);

  it("keeps a definite answer for the file state", async function () {
    let reads = 0;
    const readOutline: PdfOutlineReader = async () => {
      reads += 1;
      return { status: "ok", pageCount: 1, entries };
    };
    assert.deepEqual(
      await readPdfBookmarks(1, fileState, { readOutline }),
      entries,
    );
    assert.deepEqual(
      await readPdfBookmarks(1, fileState, { readOutline }),
      entries,
    );
    assert.equal(reads, 1);
    const changed = { ...fileState, mtime: 2 };
    await readPdfBookmarks(1, changed, { readOutline });
    assert.equal(reads, 2);
  });

  it("keeps an encrypted file's answer: it has no readable bookmarks", async function () {
    let reads = 0;
    const readOutline: PdfOutlineReader = async () => {
      reads += 1;
      return { status: "encrypted" };
    };
    assert.isNull(await readPdfBookmarks(1, fileState, { readOutline }));
    assert.isNull(await readPdfBookmarks(1, fileState, { readOutline }));
    assert.equal(reads, 1);
  });

  it("reads again after a failed or cancelled read", async function () {
    let reads = 0;
    const failing: PdfOutlineReader = async () => {
      reads += 1;
      throw reads === 1
        ? new Error("worker failed")
        : new PdfSplitterCancelledError();
    };
    assert.isNull(
      await readPdfBookmarks(1, fileState, { readOutline: failing }),
    );
    assert.isNull(
      await readPdfBookmarks(1, fileState, { readOutline: failing }),
    );
    assert.equal(reads, 2);
    const working: PdfOutlineReader = async () => ({
      status: "ok",
      pageCount: 1,
      entries,
    });
    assert.deepEqual(
      await readPdfBookmarks(1, fileState, { readOutline: working }),
      entries,
    );
  });

  it("passes the caller's signal to the read and skips an aborted one", async function () {
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const readOutline: PdfOutlineReader = async (_path, signal) => {
      seen = signal;
      return { status: "ok", pageCount: 1, entries };
    };
    await readPdfBookmarks(1, fileState, {
      signal: controller.signal,
      readOutline,
    });
    assert.strictEqual(seen, controller.signal);
    clearPdfBookmarksCache();
    controller.abort();
    let called = false;
    assert.isNull(
      await readPdfBookmarks(1, fileState, {
        signal: controller.signal,
        readOutline: async () => {
          called = true;
          return { status: "ok", pageCount: 1, entries };
        },
      }),
    );
    assert.isFalse(called);
  });
});
