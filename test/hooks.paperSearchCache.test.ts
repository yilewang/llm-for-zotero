import { assert } from "chai";
import hooks from "../src/hooks";
import {
  invalidatePaperSearchCache,
  searchPaperCandidates,
} from "../src/modules/contextPanel/paperSearch";

type MockItem = Zotero.Item & { attachmentFilename?: string };

function makeRegularItem(id: number, attachmentID: number): MockItem {
  return {
    id,
    key: `ITEM-${id}`,
    libraryID: 1,
    dateModified: "2025-01-01T00:00:00Z",
    firstCreator: "Notify Author",
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    getAttachments: () => [attachmentID],
    getCollections: () => [],
    getField: (field: string) => {
      if (field === "title") return "Notify Cache Paper";
      if (field === "firstCreator") return "Notify Author";
      return "";
    },
    getCreators: () => [],
  } as unknown as MockItem;
}

function makeAttachment(id: number): MockItem {
  return {
    id,
    key: `ATTACH-${id}`,
    libraryID: 1,
    dateModified: "2025-01-01T00:00:00Z",
    attachmentContentType: "application/pdf",
    attachmentFilename: "notify.pdf",
    isAttachment: () => true,
    isRegularItem: () => false,
    getAttachments: () => [],
    getCollections: () => [],
    getField: (field: string) => (field === "title" ? "Notify PDF" : ""),
    getCreators: () => [],
  } as unknown as MockItem;
}

describe("hooks paper search cache invalidation", function () {
  const originalZotero = globalThis.Zotero;
  const originalToolkit = (globalThis as typeof globalThis & { ztoolkit?: any })
    .ztoolkit;

  let getAllCount = 0;

  beforeEach(function () {
    getAllCount = 0;
    invalidatePaperSearchCache();
    const items = new Map<number, MockItem>();
    items.set(1, makeRegularItem(1, 11));
    items.set(11, makeAttachment(11));
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Items: {
        getAll: async () => {
          getAllCount += 1;
          return Array.from(items.values()) as Zotero.Item[];
        },
        get: (id: number) => items.get(id) || null,
      },
      Collections: {
        getByLibrary: () => [],
      },
    } as typeof Zotero;
    (globalThis as typeof globalThis & { ztoolkit: { log: () => void } })
      .ztoolkit = {
      log: () => {},
    };
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
    (
      globalThis as typeof globalThis & { ztoolkit?: typeof originalToolkit }
    ).ztoolkit = originalToolkit;
  });

  it("clears cached library search results on relevant notifier events", async function () {
    await searchPaperCandidates(1, "notify cache");
    await searchPaperCandidates(1, "notify author");
    assert.equal(getAllCount, 1);

    await hooks.onNotify("modify", "item", [1], {});
    await searchPaperCandidates(1, "notify");
    assert.equal(getAllCount, 2);
  });
});
