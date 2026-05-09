import { assert } from "chai";
import { getMineruItemList } from "../src/modules/mineruBatchProcessor";

type MockItem = {
  id: number;
  key: string;
  libraryID: number;
  parentID?: number;
  itemType?: string;
  attachmentContentType?: string;
  attachmentFilename?: string;
  attachmentIDs?: number[];
  isAttachment: () => boolean;
  isRegularItem?: () => boolean;
  getAttachments?: () => number[];
  getCollections?: () => number[];
  getField?: (field: string) => string;
};

function setupZotero(items: Map<number, MockItem>): void {
  (globalThis as unknown as { Zotero: unknown }).Zotero = {
    DataDirectory: { dir: "/tmp/zotero" },
    Libraries: { userLibraryID: 1 },
    Prefs: {
      get: () => false,
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
    exists: async () => false,
    read: async () => {
      throw new Error("missing");
    },
    getChildren: async () => [],
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
    setupZotero(new Map<number, MockItem>([[parent.id, parent], [pdf.id, pdf]]));

    const list = await getMineruItemList();

    assert.lengthOf(list, 1);
    assert.equal(list[0].attachmentId, pdf.id);
    assert.equal(list[0].parentItemId, parent.id);
    assert.equal(list[0].title, "Parent Paper");
  });
});
