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

  it("skips a caller already aborted", async function () {
    const controller = new AbortController();
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

  it("one caller's cancel stops only its own wait, not a shared read", async function () {
    let reads = 0;
    let seen: AbortSignal | undefined;
    const readOutline: PdfOutlineReader = (_path, signal) => {
      reads += 1;
      seen = signal;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => resolve({ status: "ok", pageCount: 1, entries }),
          20,
        );
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new PdfSplitterCancelledError());
        });
      });
    };
    const controller = new AbortController();
    const first = readPdfBookmarks(1, fileState, {
      signal: controller.signal,
      readOutline,
    });
    const second = readPdfBookmarks(1, fileState, { readOutline });
    controller.abort();
    assert.isNull(await first, "the cancelled caller stops waiting");
    assert.deepEqual(await second, entries, "the other caller gets the read");
    assert.isUndefined(seen, "the shared read carries no caller's signal");
    assert.deepEqual(
      await readPdfBookmarks(1, fileState, { readOutline }),
      entries,
    );
    assert.equal(reads, 1, "the read is kept for the file state");
  });
});
