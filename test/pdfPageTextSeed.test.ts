import { assert } from "chai";
import {
  clearPageTextCache,
  getCachedPageTextForAttachment,
  hasCompleteSearchablePageTextForAttachment,
  seedPageTextCacheFromFullText,
  splitPdfWorkerFullTextIntoPages,
  verifyQuoteLocationForAttachment,
  warmPageTextCacheForAttachment,
} from "../src/services/pdf/livePdfSelectionLocator";
import {
  isPageCompleteZoteroFulltextCache,
  readPageCompleteZoteroFulltextCache,
} from "../src/services/pdf/zoteroFulltextPageCache";
import { ensurePDFTextCached } from "../src/services/paperContent/pdfContext";
import {
  pdfTextCache,
  pdfTextLoadingTasks,
} from "../src/services/paperContent/contextCache";
import {
  clearPdfBookmarksCache,
  readPdfBookmarks,
} from "../src/services/paperContent/pdfBookmarks";
import { PdfPageService } from "../src/agent/services/pdfPageService";
import {
  BOOK_BOOKMARKS,
  BOOK_LEADING_BLANK_PAGES,
  BOOK_PAGES,
  DISSERTATION_PAGES,
  joinPages,
} from "./fixtures/longdoc/pageTexts";

type WorkerResult = {
  text: string;
  pageChars?: number[];
  totalPages?: number;
  extractedPages?: number;
};

type FakeFulltextCache = {
  text: string;
  indexedPages: number | null;
  totalPages: number | null;
  cacheModified?: number;
  pdfModified?: number;
};

const PDF_PATH_PREFIX = "/zotero/storage/";
const PARENT_ID_SHIFT = 50_000;

function installZotero(options: {
  worker?: (itemId: number) => Promise<WorkerResult | null>;
  fulltext?: Record<number, FakeFulltextCache>;
  nonPdfIds?: number[];
  parentTypes?: Record<number, string>;
  /** A PDF file's size and modification time; change one to replace it. */
  pdfFiles?: Record<number, { size: number; mtime: number }>;
}): { workerCalls: number[]; pdfReads: string[]; restore: () => void } {
  const g = globalThis as any;
  const originalZotero = g.Zotero;
  const originalZtoolkit = g.ztoolkit;
  const originalIOUtils = g.IOUtils;
  const workerCalls: number[] = [];
  // A PDF's bytes are read only for its bookmarks.
  const pdfReads: string[] = [];
  const fulltext = options.fulltext || {};
  const attachment = (id: number) => ({
    id,
    parentID: options.parentTypes?.[id] ? id + PARENT_ID_SHIFT : undefined,
    attachmentContentType: options.nonPdfIds?.includes(id)
      ? "text/html"
      : "application/pdf",
    attachmentFilename: options.nonPdfIds?.includes(id)
      ? `${id}.html`
      : `${id}.pdf`,
    isAttachment: () => true,
    isNote: () => false,
    getField: (field: string) => (field === "title" ? `Paper ${id}` : ""),
    getFilePathAsync: async () => `${PDF_PATH_PREFIX}${id}/paper.pdf`,
  });
  g.Zotero = {
    Prefs: { get: () => undefined, set: () => undefined },
    Items: {
      get: (id: number) =>
        id >= PARENT_ID_SHIFT
          ? {
              id,
              itemType: options.parentTypes?.[id - PARENT_ID_SHIFT],
              getField: () => "Parent",
            }
          : attachment(id),
    },
    PDFWorker: {
      getFullText: async (itemId: number) => {
        workerCalls.push(itemId);
        return options.worker ? options.worker(itemId) : null;
      },
    },
    Fulltext: {
      getItemCacheFile: (item: { id: number }) => ({
        path: `${PDF_PATH_PREFIX}${item.id}/.zotero-ft-cache`,
        exists: () => Boolean(fulltext[item.id]),
      }),
      getPages: async (itemId: number) => {
        const entry = fulltext[itemId];
        return entry
          ? { indexedPages: entry.indexedPages, total: entry.totalPages }
          : false;
      },
    },
  };
  g.ztoolkit = { log: () => undefined };
  const idFromPath = (path: string) =>
    Number(path.slice(PDF_PATH_PREFIX.length).split("/")[0]);
  g.IOUtils = {
    stat: async (path: string) => {
      const file = path.endsWith(".zotero-ft-cache")
        ? undefined
        : options.pdfFiles?.[idFromPath(path)];
      if (file) return { size: file.size, lastModified: file.mtime };
      const entry = fulltext[idFromPath(path)];
      if (!entry) throw new Error(`missing ${path}`);
      return {
        lastModified: path.endsWith(".zotero-ft-cache")
          ? (entry.cacheModified ?? 2_000)
          : (entry.pdfModified ?? 1_000),
      };
    },
    readUTF8: async (path: string) => {
      const entry = fulltext[idFromPath(path)];
      if (!entry || !path.endsWith(".zotero-ft-cache")) {
        throw new Error(`unexpected read ${path}`);
      }
      return entry.text;
    },
    read: async (path: string) => {
      pdfReads.push(path);
      throw new Error(`no PDF bytes in unit tests: ${path}`);
    },
    write: async () => {
      throw new Error("the Zotero full-text cache must never be written");
    },
  };
  return {
    workerCalls,
    pdfReads,
    restore: () => {
      for (const [key, value] of [
        ["Zotero", originalZotero],
        ["ztoolkit", originalZtoolkit],
        ["IOUtils", originalIOUtils],
      ] as const) {
        if (value === undefined) delete g[key];
        else g[key] = value;
      }
    },
  };
}

// The exact page layout PDFWorker's getFulltext produces: each page's text,
// a blank line, then a form feed between pages, and the whole string trimmed.
function pdfWorkerText(pages: string[]): string {
  return pages
    .map((page) => `${page}\n\n`)
    .join("\f")
    .trim();
}

const PAGE_ONE =
  "Representational drift was measured across twelve recording sessions.";
const PAGE_THREE =
  "Population geometry stayed stable even as single neurons changed tuning.";

describe("PDF page text seeding", function () {
  let restore = () => undefined as void;

  afterEach(function () {
    restore();
    restore = () => undefined;
    clearPageTextCache();
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
  });

  it("splits seeded text exactly as a PDFWorker warm of the same text", async function () {
    const text = pdfWorkerText([PAGE_ONE, "Second page text.", PAGE_THREE]);
    const zotero = installZotero({
      worker: async () => ({ text, totalPages: 3, extractedPages: 3 }),
    });
    restore = zotero.restore;

    const seeded = await seedPageTextCacheFromFullText(501, {
      text,
      totalPages: 3,
      extractedPages: 3,
    });
    const warmed = await warmPageTextCacheForAttachment(502);

    assert.isNotNull(seeded);
    assert.deepEqual(seeded?.pages, warmed?.pages);
    assert.equal(seeded?.pageCount, 3);
    assert.equal(seeded?.coverage, "full-pdfworker");
    assert.deepEqual(
      seeded?.normalised.map((page) => page.normalizedText),
      warmed?.normalised.map((page) => page.normalizedText),
    );
    assert.deepEqual(zotero.workerCalls, [502]);
  });

  it("serves a later warm from the seeded pages without a second extraction", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      worker: async () => ({ text, totalPages: 2 }),
    });
    restore = zotero.restore;

    await seedPageTextCacheFromFullText(601, { text, totalPages: 2 });
    const warmed = await warmPageTextCacheForAttachment(601);

    assert.equal(warmed?.pages[1]?.text, PAGE_THREE);
    assert.deepEqual(zotero.workerCalls, []);
    assert.isTrue(hasCompleteSearchablePageTextForAttachment(601));
  });

  it("keeps an interior blank page so the PDF stays complete", async function () {
    const zotero = installZotero({});
    restore = zotero.restore;
    const text = pdfWorkerText([PAGE_ONE, "", PAGE_THREE]);

    const seeded = await seedPageTextCacheFromFullText(701, {
      text,
      totalPages: 3,
    });

    assert.deepEqual(
      seeded?.pages.map((page) => [page.pageIndex, page.text]),
      [
        [0, PAGE_ONE],
        [1, ""],
        [2, PAGE_THREE],
      ],
    );
    assert.equal(seeded?.pageCount, 3);
    assert.isTrue(hasCompleteSearchablePageTextForAttachment(701));
  });

  it("does not call a PDF complete when trailing pages were trimmed away", async function () {
    const zotero = installZotero({});
    restore = zotero.restore;
    // PDFWorker trims the whole text, so two blank last pages leave no form
    // feed behind; only totalPages reveals that they exist.
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE, "", ""]);

    const seeded = await seedPageTextCacheFromFullText(702, {
      text,
      totalPages: 4,
    });

    assert.lengthOf(seeded?.pages || [], 2);
    assert.equal(seeded?.pageCount, 4);
    assert.isFalse(hasCompleteSearchablePageTextForAttachment(702));
  });

  it("does not call a mostly blank (scanned) PDF complete", async function () {
    const zotero = installZotero({});
    restore = zotero.restore;
    const text = pdfWorkerText([PAGE_ONE, "", "", "", PAGE_THREE]);

    await seedPageTextCacheFromFullText(703, { text, totalPages: 5 });

    assert.isNotNull(getCachedPageTextForAttachment(703));
    assert.isFalse(hasCompleteSearchablePageTextForAttachment(703));
  });

  it("rejects text with more page breaks than the PDF has pages", function () {
    assert.isNull(
      splitPdfWorkerFullTextIntoPages({
        text: pdfWorkerText([PAGE_ONE, PAGE_THREE, "Extra."]),
        totalPages: 2,
      }),
    );
  });

  it("rejects text that lost a leading blank page to trimming", function () {
    assert.isNull(
      splitPdfWorkerFullTextIntoPages({
        text: "Page two body.\fPage three body.",
        totalPages: 3,
        extractedPages: 3,
      }),
    );
  });

  it("keeps indices when the extraction limit stops before the last page", function () {
    const split = splitPdfWorkerFullTextIntoPages({
      text: pdfWorkerText([PAGE_ONE, "Second body.", PAGE_THREE]),
      totalPages: 5,
      extractedPages: 3,
    });
    assert.deepEqual(
      split?.pages.map((page) => page.pageIndex),
      [0, 1, 2],
    );
    assert.equal(split?.pageCount, 5);
  });

  it("accepts text whose part count equals the page count", function () {
    const split = splitPdfWorkerFullTextIntoPages({
      text: pdfWorkerText([PAGE_ONE, PAGE_THREE]),
      totalPages: 2,
      extractedPages: 2,
    });
    assert.deepEqual(
      split?.pages.map((page) => page.pageIndex),
      [0, 1],
    );
  });

  it("does not cache an oversized page and leaves the attachment unwarmed", async function () {
    const zotero = installZotero({});
    restore = zotero.restore;
    const hugePage = "word ".repeat(12_000);

    const seeded = await seedPageTextCacheFromFullText(704, {
      text: pdfWorkerText([PAGE_ONE, hugePage]),
      totalPages: 2,
    });

    assert.isNull(seeded);
    assert.isNull(getCachedPageTextForAttachment(704));
  });

  it("seeds page text from the PDFWorker text that context extraction already read", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      worker: async () => ({ text, totalPages: 2, extractedPages: 2 }),
    });
    restore = zotero.restore;
    const item = (globalThis as any).Zotero.Items.get(801);

    await ensurePDFTextCached(item);
    // Seeding is fire-and-forget; a warm joins it instead of re-extracting.
    const warmed = await warmPageTextCacheForAttachment(801);

    assert.deepEqual(zotero.workerCalls, [801]);
    assert.equal(warmed?.pages[0]?.text, PAGE_ONE);
    assert.equal(warmed?.pageCount, 2);
  });

  it("reads a replaced PDF again instead of serving the text seeded from the old file", async function () {
    const pdfFiles = { 803: { size: 100, mtime: 1_000 } };
    let text = pdfWorkerText([PAGE_ONE]);
    const zotero = installZotero({
      pdfFiles,
      worker: async () => ({ text, totalPages: text.split("\f").length }),
    });
    restore = zotero.restore;
    const item = (globalThis as any).Zotero.Items.get(803);

    await ensurePDFTextCached(item);
    assert.lengthOf(
      (await warmPageTextCacheForAttachment(803))?.pages || [],
      1,
    );
    // The PDF is replaced by a two-page file under the same attachment.
    pdfFiles[803] = { size: 200, mtime: 2_000 };
    text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);

    const warmed = await warmPageTextCacheForAttachment(803);

    assert.equal(warmed?.pages[1]?.text, PAGE_THREE);
    assert.deepEqual(zotero.workerCalls, [803, 803]);
    // An unchanged file is served from the cache.
    await warmPageTextCacheForAttachment(803);
    assert.deepEqual(zotero.workerCalls, [803, 803]);
  });

  it("does not seed page text from background library indexing", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      worker: async () => ({ text, totalPages: 2, extractedPages: 2 }),
    });
    restore = zotero.restore;
    const item = (globalThis as any).Zotero.Items.get(802);

    await ensurePDFTextCached(item, {
      preferFulltextCache: true,
      silentLoad: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.deepEqual(zotero.workerCalls, [802]);
    assert.isNull(getCachedPageTextForAttachment(802));
  });
});

describe("Zotero full-text cache as a page-text source", function () {
  let restore = () => undefined as void;

  afterEach(function () {
    restore();
    restore = () => undefined;
    clearPageTextCache();
  });

  it("accepts the cache only when its page breaks match the indexed page count", function () {
    const threePages = pdfWorkerText([PAGE_ONE, "", PAGE_THREE]);
    assert.isTrue(
      isPageCompleteZoteroFulltextCache({
        text: threePages,
        indexedPages: 3,
        totalPages: 3,
      }),
    );
    assert.isFalse(
      isPageCompleteZoteroFulltextCache({
        text: pdfWorkerText([PAGE_ONE, PAGE_THREE]),
        indexedPages: 3,
        totalPages: 3,
      }),
      "trimmed blank pages leave fewer breaks than pages",
    );
    assert.isFalse(
      isPageCompleteZoteroFulltextCache({
        text: `${PAGE_ONE} ${PAGE_THREE}`,
        indexedPages: 2,
        totalPages: 2,
      }),
      "a cache without page breaks cannot place quotes on pages",
    );
    assert.isFalse(
      isPageCompleteZoteroFulltextCache({
        text: threePages,
        indexedPages: 3,
        totalPages: 120,
      }),
      "a cache truncated by the indexing page limit is not the whole PDF",
    );
    assert.isFalse(
      isPageCompleteZoteroFulltextCache({
        text: threePages,
        indexedPages: null,
        totalPages: null,
      }),
      "an unknown page count cannot be checked",
    );
    assert.isTrue(
      isPageCompleteZoteroFulltextCache({
        text: PAGE_ONE,
        indexedPages: 1,
        totalPages: 1,
      }),
      "a one-page PDF has no page break to match",
    );
  });

  it("warms page text from a page-complete cache without calling PDFWorker", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      worker: async () => ({ text, totalPages: 2 }),
      fulltext: { 901: { text, indexedPages: 2, totalPages: 2 } },
    });
    restore = zotero.restore;

    const warmed = await warmPageTextCacheForAttachment(901);

    assert.deepEqual(zotero.workerCalls, []);
    assert.equal(warmed?.coverage, "full-pdfworker");
    assert.deepEqual(
      warmed?.pages.map((page) => page.text),
      [PAGE_ONE, PAGE_THREE],
    );
    assert.isTrue(hasCompleteSearchablePageTextForAttachment(901));
  });

  it("falls back to PDFWorker when the cache page count does not match", async function () {
    const workerText = pdfWorkerText([PAGE_ONE, PAGE_THREE, "Third page."]);
    const zotero = installZotero({
      worker: async () => ({ text: workerText, totalPages: 3 }),
      fulltext: {
        902: {
          text: `${PAGE_ONE} ${PAGE_THREE} Third page.`,
          indexedPages: 3,
          totalPages: 3,
        },
      },
    });
    restore = zotero.restore;

    const warmed = await warmPageTextCacheForAttachment(902);

    assert.deepEqual(zotero.workerCalls, [902]);
    assert.lengthOf(warmed?.pages || [], 3);
  });

  it("ignores a cache older than its PDF", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      fulltext: {
        903: {
          text,
          indexedPages: 2,
          totalPages: 2,
          cacheModified: 1_000,
          pdfModified: 5_000,
        },
      },
    });
    restore = zotero.restore;

    assert.isNull(await readPageCompleteZoteroFulltextCache(903));
  });

  it("ignores non-PDF attachments and missing caches", async function () {
    const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
    const zotero = installZotero({
      nonPdfIds: [904],
      fulltext: { 904: { text, indexedPages: 2, totalPages: 2 } },
    });
    restore = zotero.restore;

    assert.isNull(await readPageCompleteZoteroFulltextCache(904));
    assert.isNull(await readPageCompleteZoteroFulltextCache(905));
  });
});

describe("page text of a PDF whose text lost blank leading pages", function () {
  let restore = () => undefined as void;

  afterEach(function () {
    restore();
    restore = () => undefined;
    clearPageTextCache();
    clearPdfBookmarksCache();
    pdfTextCache.clear();
    pdfTextLoadingTasks.clear();
  });

  // Two blank cover pages, then two text pages: Zotero trims the covers.
  const TRIMMED = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
  const SHIFT = { pageOffset: 2, textParts: 2 };

  it("places text part i on PDF page i + the proven offset, with the lost pages empty", function () {
    const split = splitPdfWorkerFullTextIntoPages(
      { text: TRIMMED, totalPages: 4, extractedPages: 4 },
      { textPageOffset: SHIFT },
    );
    assert.deepEqual(
      split?.pages.map((page) => [page.pageIndex, page.text]),
      [
        [0, ""],
        [1, ""],
        [2, PAGE_ONE],
        [3, PAGE_THREE],
      ],
    );
    assert.equal(split?.pageCount, 4);
  });

  it("lists trailing pages Zotero trimmed as empty, but not pages it never extracted", function () {
    const trimmedEnd = splitPdfWorkerFullTextIntoPages(
      { text: TRIMMED, totalPages: 5, extractedPages: 5 },
      { textPageOffset: SHIFT },
    );
    assert.deepEqual(
      trimmedEnd?.pages.map((page) => page.pageIndex),
      [0, 1, 2, 3, 4],
    );
    assert.equal(trimmedEnd?.pages[4].text, "");
    const limited = splitPdfWorkerFullTextIntoPages(
      { text: TRIMMED, totalPages: 9, extractedPages: 4 },
      { textPageOffset: SHIFT },
    );
    assert.deepEqual(
      limited?.pages.map((page) => page.pageIndex),
      [0, 1, 2, 3],
    );
    assert.equal(limited?.pageCount, 9);
  });

  it("ignores the offset and refuses the split when the part count differs from the text it was proven on", function () {
    assert.isNull(
      splitPdfWorkerFullTextIntoPages(
        { text: TRIMMED, totalPages: 4, extractedPages: 4 },
        { textPageOffset: { pageOffset: 2, textParts: 3 } },
      ),
    );
  });

  it("refuses an offset that would place text past the PDF's last page or past the extracted pages", function () {
    assert.isNull(
      splitPdfWorkerFullTextIntoPages(
        { text: TRIMMED, totalPages: 3, extractedPages: 3 },
        { textPageOffset: SHIFT },
      ),
    );
    assert.isNull(
      splitPdfWorkerFullTextIntoPages(
        { text: TRIMMED, totalPages: 6, extractedPages: 3 },
        { textPageOffset: SHIFT },
      ),
    );
    assert.isNull(
      splitPdfWorkerFullTextIntoPages(
        { text: TRIMMED },
        { textPageOffset: SHIFT },
      ),
      "without the PDF's page count no offset can be checked",
    );
  });

  it("locates a quote from text page 0 on PDF page offset after a seed with the offset", async function () {
    const zotero = installZotero({});
    restore = zotero.restore;

    const seeded = await seedPageTextCacheFromFullText(
      1001,
      { text: TRIMMED, totalPages: 4, extractedPages: 4 },
      { textPageOffset: SHIFT },
    );
    assert.equal(seeded?.pageCount, 4);

    const located = await verifyQuoteLocationForAttachment(1001, PAGE_ONE);
    assert.equal(located.status, "resolved");
    assert.equal(located.computedPageIndex, 2);
  });

  it("seeds the offset-aware pages from a chat's load of a bookmarked book", async function () {
    const text = joinPages(BOOK_PAGES);
    const totalPages = BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES;
    const pdfFiles = { 1002: { size: 100, mtime: 1_000 } };
    const zotero = installZotero({
      pdfFiles,
      worker: async () => ({ text, totalPages, extractedPages: totalPages }),
    });
    restore = zotero.restore;
    // The book's bookmarks, as the reader of this file state answers them.
    await readPdfBookmarks(
      1002,
      { path: `${PDF_PATH_PREFIX}1002/paper.pdf`, size: 100, mtime: 1_000 },
      {
        readOutline: async () => ({
          status: "ok",
          pageCount: totalPages,
          entries: BOOK_BOOKMARKS,
        }),
      },
    );
    const item = (globalThis as any).Zotero.Items.get(1002);

    await ensurePDFTextCached(item);
    assert.deepEqual(pdfTextCache.get(1002)?.textPageOffset, {
      pageOffset: BOOK_LEADING_BLANK_PAGES,
      textParts: BOOK_PAGES.length,
      file: { size: 100, mtime: 1_000 },
    });
    const warmed = await warmPageTextCacheForAttachment(1002);

    assert.deepEqual(zotero.workerCalls, [1002]);
    assert.equal(warmed?.pageCount, totalPages);
    assert.equal(warmed?.pages[0]?.text, "");
    assert.match(warmed?.pages[2]?.text || "", /^CONTENTS/);
    assert.match(warmed?.pages[3]?.text || "", /^Preface/);
  });

  it("loads a chaptered PDF without its map under an article parent, and with it under a book", async function () {
    const body = "The argument continues with further detail. ".repeat(60);
    const text = joinPages(DISSERTATION_PAGES.map((lines) => [...lines, body]));
    const totalPages = DISSERTATION_PAGES.length;
    const zotero = installZotero({
      parentTypes: { 1020: "journalArticle", 1021: "book" },
      worker: async () => ({ text, totalPages, extractedPages: totalPages }),
    });
    restore = zotero.restore;
    const Z = (globalThis as any).Zotero;

    await ensurePDFTextCached(Z.Items.get(1020));
    await ensurePDFTextCached(Z.Items.get(1021));

    assert.isUndefined(pdfTextCache.get(1020)?.documentStructure);
    assert.isDefined(pdfTextCache.get(1021)?.documentStructure);
    assert.deepEqual(
      pdfTextCache.get(1020)?.chunks,
      pdfTextCache.get(1021)?.chunks,
    );
  });

  it("reads requested pages by the offset the paper's text store proved", async function () {
    const zotero = installZotero({
      worker: async () => ({ text: TRIMMED, totalPages: 4, extractedPages: 4 }),
    });
    restore = zotero.restore;
    pdfTextCache.set(1003, {
      title: "Book",
      chunks: [PAGE_ONE, PAGE_THREE],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: TRIMMED.length,
      sourceType: "zotero-worker",
      textPageOffset: SHIFT,
    });
    const service = new PdfPageService({} as never, {} as never);
    service.resolveTarget = async () => ({
      source: "library",
      title: "Book",
      mimeType: "application/pdf",
      storedPath: `${PDF_PATH_PREFIX}1003/paper.pdf`,
      contextItemId: 1003,
      itemId: 1000,
    });

    const read = await service.readPageTexts({
      request: {
        conversationKey: 1,
        mode: "agent",
        userText: "",
        libraryID: 1,
      },
      contextItemId: 1003,
      pages: [2, 3],
    } as never);

    assert.deepEqual(
      read.pages.map((page) => [page.pageIndex, page.text]),
      [
        [2, PAGE_ONE],
        [3, PAGE_THREE],
      ],
    );
  });

  const storeOffset = (
    itemId: number,
    textPageOffset: typeof SHIFT & { file?: unknown },
  ) =>
    pdfTextCache.set(itemId, {
      title: "Book",
      chunks: [PAGE_ONE, PAGE_THREE],
      chunkMeta: [],
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: TRIMMED.length,
      sourceType: "zotero-worker",
      textPageOffset,
    } as never);

  it("places pages by the stored offset when an offset-less warm is already in flight", async function () {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const zotero = installZotero({
      worker: async () => {
        await gate;
        return { text: TRIMMED, totalPages: 4, extractedPages: 4 };
      },
    });
    restore = zotero.restore;
    storeOffset(1006, SHIFT);
    // A quote check starts the warm without an offset.
    const first = warmPageTextCacheForAttachment(1006);
    await new Promise((resolve) => setTimeout(resolve, 5));
    // A page read joins it.
    const second = warmPageTextCacheForAttachment(1006, {
      textPageOffset: SHIFT,
    });
    release();

    assert.equal((await first)?.pages[2]?.text, PAGE_ONE);
    assert.equal((await second)?.pages[2]?.text, PAGE_ONE);
    assert.lengthOf(zotero.workerCalls, 1);
  });

  it("applies a stored offset to a quote check without the caller passing it", async function () {
    const zotero = installZotero({
      worker: async () => ({ text: TRIMMED, totalPages: 4, extractedPages: 4 }),
    });
    restore = zotero.restore;
    storeOffset(1007, SHIFT);
    assert.equal(
      (await warmPageTextCacheForAttachment(1007))?.pages[3]?.text,
      PAGE_THREE,
    );
  });

  it("reads a replaced file without the offset proven on the old one", async function () {
    const pdfFiles = { 1008: { size: 100, mtime: 1_000 } };
    const zotero = installZotero({
      pdfFiles,
      worker: async () => ({ text: TRIMMED, totalPages: 4, extractedPages: 4 }),
    });
    restore = zotero.restore;
    storeOffset(1008, { ...SHIFT, file: { size: 100, mtime: 1_000 } });
    // The same file keeps its offset.
    assert.equal(
      (await warmPageTextCacheForAttachment(1008))?.pages[2]?.text,
      PAGE_ONE,
    );
    // The file is replaced: the page text is refused, not misplaced.
    clearPageTextCache();
    pdfFiles[1008] = { size: 120, mtime: 2_000 };
    assert.isNull(await warmPageTextCacheForAttachment(1008));
    assert.isNull(
      await warmPageTextCacheForAttachment(1008, {
        textPageOffset: {
          ...SHIFT,
          file: { size: 100, mtime: 1_000 },
        },
      }),
    );
  });

  it("still refuses the page text without a proven offset", async function () {
    const zotero = installZotero({
      worker: async () => ({ text: TRIMMED, totalPages: 4, extractedPages: 4 }),
    });
    restore = zotero.restore;
    assert.isNull(await warmPageTextCacheForAttachment(1004));
  });

  it("accepts a Zotero full-text cache that lost blank leading pages only with the proven offset", async function () {
    const zotero = installZotero({
      fulltext: { 1005: { text: TRIMMED, indexedPages: 4, totalPages: 4 } },
    });
    restore = zotero.restore;

    assert.isNull(await readPageCompleteZoteroFulltextCache(1005));
    const warmed = await warmPageTextCacheForAttachment(1005, {
      textPageOffset: SHIFT,
    });

    assert.deepEqual(zotero.workerCalls, []);
    assert.equal(warmed?.pages[2]?.text, PAGE_ONE);
  });
  describe("without a stored offset, the warm proves it from the bookmarks", function () {
    const BOOK_TEXT = joinPages(BOOK_PAGES);
    const BOOK_TOTAL = BOOK_PAGES.length + BOOK_LEADING_BLANK_PAGES;
    const FILE = { size: 100, mtime: 1_000 };

    // Bookmarks as a paper load of this file state read them; the warm
    // reuses the same per-file read.
    const seedBookmarks = async (
      itemId: number,
      file: { size: number; mtime: number },
      entries: typeof BOOK_BOOKMARKS,
    ) => {
      let reads = 0;
      await readPdfBookmarks(
        itemId,
        { path: `${PDF_PATH_PREFIX}${itemId}/paper.pdf`, ...file },
        {
          readOutline: async () => {
            reads += 1;
            return { status: "ok", pageCount: 0, entries };
          },
        },
      );
      return () => reads;
    };
    const bookmark = (title: string, pageIndex: number) => ({
      depth: 0,
      title,
      pageIndex,
      top: null,
      fitsPage: false,
    });

    it("places PDFWorker text by the shift its bookmarks prove", async function () {
      const zotero = installZotero({
        pdfFiles: { 1010: FILE },
        worker: async () => ({
          text: BOOK_TEXT,
          totalPages: BOOK_TOTAL,
          extractedPages: BOOK_TOTAL,
        }),
      });
      restore = zotero.restore;
      const outlineReads = await seedBookmarks(1010, FILE, BOOK_BOOKMARKS);
      assert.isFalse(pdfTextCache.has(1010));

      const warmed = await warmPageTextCacheForAttachment(1010);

      assert.equal(warmed?.pageCount, BOOK_TOTAL);
      assert.equal(warmed?.pages[0]?.text, "");
      assert.equal(warmed?.pages[1]?.text, "");
      assert.match(warmed?.pages[2]?.text || "", /^CONTENTS/);
      assert.match(warmed?.pages[3]?.text || "", /^Preface/);
      assert.equal(outlineReads(), 1);
      assert.deepEqual(zotero.pdfReads, []);
      // The placed pages serve the next read.
      await warmPageTextCacheForAttachment(1010);
      assert.deepEqual(zotero.workerCalls, [1010]);
    });

    it("places a Zotero full-text cache that lost leading pages without PDFWorker", async function () {
      const zotero = installZotero({
        pdfFiles: { 1011: FILE },
        fulltext: {
          1011: {
            text: BOOK_TEXT,
            indexedPages: BOOK_TOTAL,
            totalPages: BOOK_TOTAL,
          },
        },
      });
      restore = zotero.restore;
      await seedBookmarks(1011, FILE, BOOK_BOOKMARKS);

      const warmed = await warmPageTextCacheForAttachment(1011);

      assert.deepEqual(zotero.workerCalls, []);
      assert.equal(warmed?.pageCount, BOOK_TOTAL);
      assert.match(warmed?.pages[2]?.text || "", /^CONTENTS/);
      assert.match(warmed?.pages[3]?.text || "", /^Preface/);
    });

    it("refuses when the bookmarks place equally many titles under two shifts, or there are none", async function () {
      const zotero = installZotero({
        pdfFiles: { 1012: FILE, 1013: FILE },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;
      // Shifts 1 and 2 each put one title on its page.
      await seedBookmarks(1012, FILE, [
        bookmark("Representational drift", 1),
        bookmark("Representational drift", 2),
      ]);
      await seedBookmarks(1013, FILE, []);

      assert.isNull(await warmPageTextCacheForAttachment(1012));
      assert.isNull(await warmPageTextCacheForAttachment(1013));
    });

    it("refuses without throwing when the bookmarks cannot be read", async function () {
      const zotero = installZotero({
        pdfFiles: { 1014: FILE },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;

      assert.isNull(await warmPageTextCacheForAttachment(1014));
      assert.deepEqual(zotero.pdfReads, [`${PDF_PATH_PREFIX}1014/paper.pdf`]);
    });

    it("reads the bookmarks once when both text sources lost leading pages", async function () {
      const zotero = installZotero({
        pdfFiles: { 1019: FILE },
        fulltext: { 1019: { text: TRIMMED, indexedPages: 4, totalPages: 4 } },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;

      assert.isNull(await warmPageTextCacheForAttachment(1019));
      assert.deepEqual(zotero.workerCalls, [1019]);
      assert.lengthOf(zotero.pdfReads, 1);
    });

    it("never reads bookmarks for text that has every page", async function () {
      const text = pdfWorkerText([PAGE_ONE, PAGE_THREE]);
      const zotero = installZotero({
        pdfFiles: { 1015: FILE },
        worker: async () => ({ text, totalPages: 2, extractedPages: 2 }),
      });
      restore = zotero.restore;

      const warmed = await warmPageTextCacheForAttachment(1015);

      assert.equal(warmed?.pages[1]?.text, PAGE_THREE);
      assert.deepEqual(zotero.pdfReads, []);
    });

    it("never reads bookmarks for text that pageChars places", async function () {
      const zotero = installZotero({
        pdfFiles: { 1016: FILE },
        worker: async () => ({
          text: `${PAGE_ONE}${PAGE_THREE}`,
          pageChars: [PAGE_ONE.length, PAGE_THREE.length],
          totalPages: 4,
        }),
      });
      restore = zotero.restore;

      const warmed = await warmPageTextCacheForAttachment(1016);

      assert.equal(warmed?.pages[1]?.text, PAGE_THREE);
      assert.deepEqual(zotero.pdfReads, []);
    });

    it("uses a stored offset for the same file instead of the bookmarks", async function () {
      const zotero = installZotero({
        pdfFiles: { 1017: FILE },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;
      // These bookmarks alone would put the first text page on page 1.
      await seedBookmarks(1017, FILE, [bookmark("Representational drift", 1)]);
      storeOffset(1017, { ...SHIFT, file: FILE });

      const warmed = await warmPageTextCacheForAttachment(1017);

      assert.equal(warmed?.pages[2]?.text, PAGE_ONE);
      assert.equal(warmed?.pages[1]?.text, "");
    });

    it("proves the shift again when the stored offset was proven for a different part count", async function () {
      const zotero = installZotero({
        pdfFiles: { 1020: FILE },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;
      await seedBookmarks(1020, FILE, [bookmark("Representational drift", 1)]);
      // Same file, but proven for 3 text parts; the text in hand has 2.
      storeOffset(1020, { pageOffset: 2, textParts: 3, file: FILE });

      const warmed = await warmPageTextCacheForAttachment(1020);

      assert.equal(warmed?.pages[1]?.text, PAGE_ONE);
      assert.equal(warmed?.pages[2]?.text, PAGE_THREE);
    });

    it("ignores a stored offset proven on another file and proves the shift again", async function () {
      const zotero = installZotero({
        pdfFiles: { 1018: { size: 120, mtime: 2_000 } },
        worker: async () => ({
          text: TRIMMED,
          totalPages: 4,
          extractedPages: 4,
        }),
      });
      restore = zotero.restore;
      await seedBookmarks(1018, { size: 120, mtime: 2_000 }, [
        bookmark("Representational drift", 1),
      ]);
      storeOffset(1018, { ...SHIFT, file: FILE });

      const warmed = await warmPageTextCacheForAttachment(1018);

      assert.equal(warmed?.pages[1]?.text, PAGE_ONE);
      assert.equal(warmed?.pages[2]?.text, PAGE_THREE);
    });
  });
});
