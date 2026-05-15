import { assert } from "chai";
import {
  getMineruBatchState,
  getMineruItemList,
  processSelectedItems,
  startBatchProcessing,
} from "../src/modules/mineruBatchProcessor";
import { writeMineruCacheFiles } from "../src/modules/contextPanel/mineruCache";

const encoder = new TextEncoder();

type MockItem = {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number;
  itemType?: string;
  attachmentContentType?: string;
  attachmentFilename?: string;
  attachmentSyncedHash?: string;
  attachmentIDs?: number[];
  isAttachment: () => boolean;
  isRegularItem?: () => boolean;
  getAttachments?: () => number[];
  getCollections?: () => number[];
  getTags?: () => Array<
    string | { tag?: string; name?: string; type?: number }
  >;
  getField?: (field: string) => string;
  getFilePathAsync?: () => Promise<string | false>;
};

function pdfText(pageCount: number): string {
  return `%PDF-1.7
1 0 obj
<< /Type /Pages /Count ${pageCount} /Kids [] >>
endobj`;
}

function setupZotero(
  items: Map<number, MockItem>,
  options: {
    pref?: (key: string) => unknown;
    files?: Record<string, string | Uint8Array>;
  } = {},
): void {
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(options.files || {})) {
    files.set(path, typeof value === "string" ? encoder.encode(value) : value);
  }
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Libraries: { userLibraryID: 1 },
    Prefs: {
      get: (key: string) => {
        const override = options.pref?.(key);
        if (override !== undefined) return override;
        if (key.endsWith(".mineruMaxAutoPages")) return 100;
        if (key.endsWith(".mineruExcludePatterns")) return "";
        if (key.endsWith(".mineruSyncEnabled")) return false;
        return false;
      },
      set: () => {},
    },
    Items: {
      get: (id: number) => items.get(id) || null,
      getAll: async (libraryID: number) =>
        [...items.values()].filter((item) => item.libraryID === libraryID),
    },
  };
  (globalThis as unknown as { ztoolkit: unknown }).ztoolkit = {
    log: () => {},
  };
  (globalThis as unknown as { IOUtils: unknown }).IOUtils = {
    exists: async (path: string) => files.has(path),
    read: async (path: string) => {
      const value = files.get(path);
      if (value) return value;
      throw new Error("missing");
    },
    getChildren: async () => [],
    makeDirectory: async () => {},
    write: async (path: string, data: Uint8Array) => {
      files.set(path, data);
    },
  };
}

function createRawPdf(): MockItem {
  return {
    id: 101,
    key: "RAWPDF",
    libraryID: 1,
    itemType: "attachment",
    attachmentContentType: "application/pdf",
    attachmentFilename: "raw-paper.pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getCollections: () => [7],
    getField: (field) =>
      field === "title"
        ? "Raw paper PDF"
        : field === "dateAdded"
          ? "2026-05-01 10:00:00"
          : "",
  };
}

describe("mineruBatchProcessor", function () {
  afterEach(function () {
    delete (globalThis as unknown as { Zotero?: unknown }).Zotero;
    delete (globalThis as unknown as { ztoolkit?: unknown }).ztoolkit;
    delete (globalThis as unknown as { IOUtils?: unknown }).IOUtils;
  });

  it("includes top-level raw PDF attachments in the MinerU manager list", async function () {
    const rawPdf = createRawPdf();
    const items = new Map<number, MockItem>([[rawPdf.id, rawPdf]]);
    setupZotero(items);

    const list = await getMineruItemList();

    assert.lengthOf(list, 1);
    assert.equal(list[0].attachmentId, rawPdf.id);
    assert.equal(list[0].parentItemId, rawPdf.id);
    assert.equal(list[0].title, "Raw paper PDF");
    assert.equal(list[0].pdfTitle, "Raw paper PDF");
    assert.deepEqual(list[0].collectionIds, [7]);
  });

  it("does not duplicate child PDFs when attachment items also appear in getAll", async function () {
    const parent: MockItem = {
      id: 201,
      key: "PARENT",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [202],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [9],
      getField: (field) =>
        field === "title"
          ? "Parent Paper"
          : field === "firstCreator"
            ? "Smith"
            : field === "year"
              ? "2025"
              : field === "dateAdded"
                ? "2026-04-30 10:00:00"
                : "",
    };
    const pdf: MockItem = {
      id: 202,
      key: "CHILDPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "child.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Child PDF" : ""),
    };
    setupZotero(
      new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]),
    );

    const list = await getMineruItemList();

    assert.lengthOf(list, 1);
    assert.equal(list[0].attachmentId, pdf.id);
    assert.equal(list[0].parentItemId, parent.id);
    assert.equal(list[0].title, "Parent Paper");
  });

  it("populates manual and automatic tags from the parent item before falling back to the attachment", async function () {
    const parent: MockItem = {
      id: 301,
      key: "PARENTTAGS",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [302],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getTags: () => [
        { tag: "ACC", type: 0 },
        { tag: "Auto Parent", type: 1 },
      ],
      getField: (field) => (field === "title" ? "Tagged Parent Paper" : ""),
    };
    const pdf: MockItem = {
      id: 302,
      key: "PDFTAGS",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "tagged.pdf",
      isAttachment: () => true,
      isRegularItem: () => false,
      getTags: () => [{ tag: "Attachment Only", type: 0 }],
      getField: (field) => (field === "title" ? "Tagged PDF" : ""),
    };
    setupZotero(
      new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]),
    );

    const list = await getMineruItemList();

    assert.deepEqual(list[0].tags, ["ACC"]);
    assert.deepEqual(list[0].tagsAuto, ["Auto Parent"]);

    parent.getTags = () => [];
    const fallback = await getMineruItemList();

    assert.deepEqual(fallback[0].tags, ["Attachment Only"]);
    assert.deepEqual(fallback[0].tagsAuto, []);
  });

  it("does not exclude book rows by item type and defers page-count checks during manager load", async function () {
    const book: MockItem = {
      id: 401,
      key: "BOOK",
      libraryID: 1,
      itemType: "book",
      attachmentIDs: [402],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getField: (field) => (field === "title" ? "Book Parent" : ""),
    };
    const bookPdf: MockItem = {
      id: 402,
      key: "BOOKPDF",
      libraryID: 1,
      parentID: book.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "book.pdf",
      attachmentSyncedHash: "book-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Book PDF" : ""),
      getFilePathAsync: async () => "/tmp/book.pdf",
    };
    const article: MockItem = {
      id: 403,
      key: "ARTICLE",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [404],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getField: (field) => (field === "title" ? "Long Article" : ""),
    };
    const longPdf: MockItem = {
      id: 404,
      key: "LONGPDF",
      libraryID: 1,
      parentID: article.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "long.pdf",
      attachmentSyncedHash: "long-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Long PDF" : ""),
      getFilePathAsync: async () => "/tmp/long.pdf",
    };
    setupZotero(
      new Map<number, MockItem>([
        [book.id, book],
        [bookPdf.id, bookPdf],
        [article.id, article],
        [longPdf.id, longPdf],
      ]),
      {
        files: {
          "/tmp/book.pdf": pdfText(35),
          "/tmp/long.pdf": pdfText(412),
        },
      },
    );

    const list = await getMineruItemList();
    const bookEntry = list.find((item) => item.attachmentId === bookPdf.id);
    const longEntry = list.find((item) => item.attachmentId === longPdf.id);

    assert.isFalse(bookEntry?.excluded);
    assert.equal(bookEntry?.exclusionLabel, "");
    assert.isNull(bookEntry?.pageCount);
    assert.isFalse(longEntry?.excluded);
    assert.equal(longEntry?.exclusionLabel, "");
    assert.isNull(longEntry?.pageCount);
  });

  it("keeps cached filename-excluded rows visible as cached", async function () {
    const parent: MockItem = {
      id: 501,
      key: "CACHEDARTICLE",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [502],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getField: (field) => (field === "title" ? "Cached Article" : ""),
    };
    const pdf: MockItem = {
      id: 502,
      key: "CACHEDARTICLEPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "cached_translated.pdf",
      attachmentSyncedHash: "cached-article-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Cached Translated PDF" : ""),
      getFilePathAsync: async () => "/tmp/cached-translated.pdf",
    };
    setupZotero(
      new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
      ]),
      {
        files: { "/tmp/cached-translated.pdf": pdfText(42) },
        pref: (key) =>
          key.endsWith(".mineruExcludePatterns")
            ? JSON.stringify(["translated"])
            : undefined,
      },
    );
    await writeMineruCacheFiles(pdf.id, "# Cached article", [
      { relativePath: "content_list.json", data: encoder.encode("[]") },
    ]);

    const list = await getMineruItemList();

    assert.isTrue(list[0].excluded);
    assert.equal(list[0].exclusionLabel, "filename rule");
    assert.isTrue(list[0].cached);
    assert.isTrue(list[0].localCached);
  });

  it("skips over-limit and filename-excluded PDFs in Start All batch processing", async function () {
    const parent: MockItem = {
      id: 601,
      key: "LONGSTARTALL",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [602, 604],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getField: (field) => (field === "title" ? "Long Start All" : ""),
    };
    const pdf: MockItem = {
      id: 602,
      key: "LONGSTARTALLPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "long-start-all.pdf",
      attachmentSyncedHash: "long-start-all-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Long Start All PDF" : ""),
      getFilePathAsync: async () => "/tmp/long-start-all.pdf",
    };
    const translatedPdf: MockItem = {
      id: 604,
      key: "TRANSLATEDSTARTALLPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "short_translated.pdf",
      attachmentSyncedHash: "translated-start-all-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) =>
        field === "title" ? "Translated Start All PDF" : "",
      getFilePathAsync: async () => "/tmp/short-translated.pdf",
    };
    setupZotero(
      new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
        [translatedPdf.id, translatedPdf],
      ]),
      {
        files: {
          "/tmp/long-start-all.pdf": pdfText(412),
          "/tmp/short-translated.pdf": pdfText(12),
        },
        pref: (key) =>
          key.endsWith(".mineruExcludePatterns")
            ? JSON.stringify(["translated"])
            : undefined,
      },
    );

    await startBatchProcessing();

    const state = getMineruBatchState();
    assert.isFalse(state.running);
    assert.equal(state.totalCount, 0);
    assert.equal(state.processedCount, 0);
    assert.isNull(state.currentItemId);
  });

  it("skips over-limit and filename-excluded PDFs in selected processing by default", async function () {
    const parent: MockItem = {
      id: 701,
      key: "LONGSELECTED",
      libraryID: 1,
      itemType: "journalArticle",
      attachmentIDs: [702, 704],
      isAttachment: () => false,
      isRegularItem: () => true,
      getAttachments() {
        return this.attachmentIDs || [];
      },
      getCollections: () => [],
      getField: (field) => (field === "title" ? "Long Selected" : ""),
    };
    const pdf: MockItem = {
      id: 702,
      key: "LONGSELECTEDPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "long-selected.pdf",
      attachmentSyncedHash: "long-selected-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) => (field === "title" ? "Long Selected PDF" : ""),
      getFilePathAsync: async () => "/tmp/long-selected.pdf",
    };
    const translatedPdf: MockItem = {
      id: 704,
      key: "TRANSLATEDSELECTEDPDF",
      libraryID: 1,
      parentID: parent.id,
      itemType: "attachment",
      attachmentContentType: "application/pdf",
      attachmentFilename: "selected_translated.pdf",
      attachmentSyncedHash: "translated-selected-hash",
      isAttachment: () => true,
      isRegularItem: () => false,
      getField: (field) =>
        field === "title" ? "Translated Selected PDF" : "",
      getFilePathAsync: async () => "/tmp/selected-translated.pdf",
    };
    setupZotero(
      new Map<number, MockItem>([
        [parent.id, parent],
        [pdf.id, pdf],
        [translatedPdf.id, translatedPdf],
      ]),
      {
        files: {
          "/tmp/long-selected.pdf": pdfText(412),
          "/tmp/selected-translated.pdf": pdfText(12),
        },
        pref: (key) =>
          key.endsWith(".mineruExcludePatterns")
            ? JSON.stringify(["translated"])
            : undefined,
      },
    );

    await processSelectedItems([pdf.id, translatedPdf.id]);

    const state = getMineruBatchState();
    assert.isFalse(state.running);
    assert.equal(state.totalCount, 0);
    assert.equal(state.processedCount, 0);
    assert.isNull(state.currentItemId);
  });
});
