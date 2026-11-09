import { assert } from "chai";
import {
  clearPageTextCache,
  getCachedPageTextForAttachment,
  hasCompleteSearchablePageTextForAttachment,
  seedPageTextCacheFromFullText,
  splitPdfWorkerFullTextIntoPages,
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

function installZotero(options: {
  worker?: (itemId: number) => Promise<WorkerResult | null>;
  fulltext?: Record<number, FakeFulltextCache>;
  nonPdfIds?: number[];
  /** A PDF file's size and modification time; change one to replace it. */
  pdfFiles?: Record<number, { size: number; mtime: number }>;
}): { workerCalls: number[]; restore: () => void } {
  const g = globalThis as any;
  const originalZotero = g.Zotero;
  const originalZtoolkit = g.ztoolkit;
  const originalIOUtils = g.IOUtils;
  const workerCalls: number[] = [];
  const fulltext = options.fulltext || {};
  const attachment = (id: number) => ({
    id,
    parentID: undefined,
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
    Items: { get: (id: number) => attachment(id) },
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
    write: async () => {
      throw new Error("the Zotero full-text cache must never be written");
    },
  };
  return {
    workerCalls,
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
