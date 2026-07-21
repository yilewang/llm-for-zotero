import { assert } from "chai";
import { clearPageTextCache } from "../src/modules/contextPanel/livePdfSelectionLocator";
import {
  navigateSelectedTextContextToPage,
  resolveSelectedTextContextTargetItemId,
  type SelectedTextContextNavigationDeps,
} from "../src/modules/contextPanel/selectedTextContextNavigation";
import type { SelectedTextContext } from "../src/modules/contextPanel/types";

function createPdfItem(id: number) {
  return {
    id,
    attachmentContentType: "application/pdf",
    isAttachment: () => true,
  };
}

function createReader(itemId: number, dispatchedQueries: string[]) {
  const selectedText = [
    "Hippocampal place cells provide a complete selected passage for reader navigation.",
    "The remaining sentence keeps the test focused on the full-text search policy.",
  ].join(" ");
  const findController: any = {
    _rawQuery: "",
    pageMatches: [[], [], []] as unknown[],
    _pendingFindMatches: new Set<unknown>(),
    _pagesToSearch: 0,
    matchesCount: { total: 0 },
    selected: { pageIdx: 1, matchIdx: 0 },
  };
  const reader: any = {
    _item: { id: itemId },
    itemID: itemId,
    navigatedLocations: [] as unknown[],
    navigate: async (location: unknown) => {
      reader.navigatedLocations.push(location);
    },
    _window: {
      PDFViewerApplication: {
        pdfDocument: {
          numPages: 3,
          getPage: async (pageNumber: number) => ({
            getTextContent: async () => ({
              items: [
                {
                  str:
                    pageNumber === 2
                      ? selectedText
                      : `Unrelated page ${pageNumber}.`,
                },
              ],
            }),
          }),
        },
        pagesCount: 3,
        page: 2,
        findController,
        eventBus: {
          dispatch: (
            _eventName: string,
            params: { query: string; type?: string },
          ) => {
            dispatchedQueries.push(params.query);
            findController._rawQuery = params.query;
            findController.pageMatches = [[], [0], []];
            findController.matchesCount = { total: 1 };
            findController.selected = { pageIdx: 1, matchIdx: 0 };
          },
        },
      },
    },
  };
  return reader;
}

function createContext(contextItemId: number): SelectedTextContext {
  return {
    source: "pdf",
    contextItemId,
    pageIndex: 1,
    pageLabel: "431",
    text: [
      "Hippocampal place cells provide a complete selected passage for reader navigation.",
      "The remaining sentence keeps the test focused on the full-text search policy.",
    ].join(" "),
  };
}

function createNavigationDeps(
  overrides: Partial<SelectedTextContextNavigationDeps> = {},
): SelectedTextContextNavigationDeps {
  return {
    getActiveContextAttachment: () => null,
    getCurrentItem: () => null,
    resolveCurrentPaperBaseItem: () => null,
    getItemById: () => null,
    getActiveReaderForSelectedTab: () => null,
    getSelectedTabId: () => null,
    getReaderByTabId: () => null,
    ...overrides,
  };
}

describe("selected text context reader navigation", function () {
  const originalZotero = (globalThis as any).Zotero;
  const originalZtoolkit = (globalThis as any).ztoolkit;

  beforeEach(function () {
    clearPageTextCache();
    (globalThis as any).Zotero = {
      PDFWorker: { getFullText: async () => null },
    };
    (globalThis as any).ztoolkit = { log: () => undefined };
  });

  afterEach(function () {
    clearPageTextCache();
  });

  after(function () {
    if (originalZotero === undefined) {
      delete (globalThis as any).Zotero;
    } else {
      (globalThis as any).Zotero = originalZotero;
    }
    if (originalZtoolkit === undefined) {
      delete (globalThis as any).ztoolkit;
    } else {
      (globalThis as any).ztoolkit = originalZtoolkit;
    }
  });

  it("keeps explicit attachment identity authoritative with multiple PDFs", function () {
    const firstPdf = createPdfItem(101);
    const selectedPdf = createPdfItem(102);
    const context = createContext(selectedPdf.id);
    const targetItemId = resolveSelectedTextContextTargetItemId(
      context,
      createNavigationDeps({
        getActiveContextAttachment: () => firstPdf,
        getCurrentItem: () => firstPdf,
        resolveCurrentPaperBaseItem: () => ({
          getAttachments: () => [firstPdf.id, selectedPdf.id],
        }),
        getItemById: (itemId) =>
          itemId === selectedPdf.id ? selectedPdf : firstPdf,
      }),
    );

    assert.equal(targetItemId, selectedPdf.id);
  });

  it("reuses the active reader only when its attachment is the target", async function () {
    const dispatchedQueries: string[] = [];
    const reader = createReader(101, dispatchedQueries);
    let openCount = 0;

    const navigated = await navigateSelectedTextContextToPage(
      createContext(101),
      createNavigationDeps({
        getActiveReaderForSelectedTab: () => reader,
        openReader: async () => {
          openCount += 1;
          return null;
        },
      }),
    );

    assert.isTrue(navigated);
    assert.equal(openCount, 0);
    assert.deepEqual(reader.navigatedLocations, [
      { pageIndex: 1, pageLabel: "431" },
    ]);
    assert.isNotEmpty(dispatchedQueries);
  });

  it("uses the reader returned by opening the target attachment", async function () {
    const unrelatedQueries: string[] = [];
    const openedQueries: string[] = [];
    const unrelatedReader = createReader(999, unrelatedQueries);
    const openedReader = createReader(101, openedQueries);
    let openedItemId = 0;
    let selectedTabLookupCount = 0;

    const navigated = await navigateSelectedTextContextToPage(
      createContext(101),
      createNavigationDeps({
        getActiveReaderForSelectedTab: () => unrelatedReader,
        getSelectedTabId: () => {
          selectedTabLookupCount += 1;
          return "target-tab";
        },
        openReader: async (itemId) => {
          openedItemId = itemId;
          return openedReader;
        },
      }),
    );

    assert.isTrue(navigated);
    assert.equal(openedItemId, 101);
    assert.equal(selectedTabLookupCount, 0);
    assert.isEmpty(unrelatedQueries);
    assert.isNotEmpty(openedQueries);
  });

  it("resolves a void open through the newly selected reader tab", async function () {
    const unrelatedQueries: string[] = [];
    const targetQueries: string[] = [];
    const unrelatedReader = createReader(999, unrelatedQueries);
    const targetReader = createReader(101, targetQueries);
    const lookedUpTabIds: Array<string | number> = [];

    const navigated = await navigateSelectedTextContextToPage(
      createContext(101),
      createNavigationDeps({
        getActiveReaderForSelectedTab: () => unrelatedReader,
        getSelectedTabId: () => "reader-101",
        getReaderByTabId: (tabId) => {
          lookedUpTabIds.push(tabId);
          return tabId === "reader-101" ? targetReader : null;
        },
        openReader: async () => undefined,
      }),
    );

    assert.isTrue(navigated);
    assert.deepEqual(lookedUpTabIds, ["reader-101"]);
    assert.isEmpty(unrelatedQueries);
    assert.isNotEmpty(targetQueries);
  });

  it("uses the viewPDF fallback when Reader.open is unavailable", async function () {
    const targetQueries: string[] = [];
    const targetReader = createReader(101, targetQueries);
    const viewed: Array<{ itemId: number; location: unknown }> = [];
    let activeReaderLookupCount = 0;

    const navigated = await navigateSelectedTextContextToPage(
      createContext(101),
      createNavigationDeps({
        getActiveReaderForSelectedTab: () => {
          activeReaderLookupCount += 1;
          return activeReaderLookupCount === 1 ? null : targetReader;
        },
        viewPdf: async (itemId, location) => {
          viewed.push({ itemId, location });
        },
      }),
    );

    assert.isTrue(navigated);
    assert.deepEqual(viewed, [
      { itemId: 101, location: { pageIndex: 1, pageLabel: "431" } },
    ]);
    assert.isNotEmpty(targetQueries);
  });
});
