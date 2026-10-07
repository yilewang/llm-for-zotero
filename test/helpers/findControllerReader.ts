/**
 * A fake Zotero reader whose PDF.js FindController behaves like the real one
 * closely enough for page-native quote navigation: a find dispatch replaces
 * the query, reports matches on one page, and fires the progress events the
 * navigator waits for. `livePdfSelectionLocator.test.ts` drives the locator
 * with it directly; the citation-navigation characterization tests drive the
 * whole click path through it.
 */
import { assert } from "chai";

export type ExactFindControllerReaderParams = {
  pageItems: Array<Array<{ str: string; hasEOL?: boolean }>>;
  targetPageIndex: number;
  matchCount?: number;
  shouldMatch?: boolean;
  matchesQuery?: (query: string) => boolean;
  previousQuery?: string;
  delayedAcceptanceMs?: number;
  delayedResultsMs?: number;
  resultPageIndex?: number;
  ignoreFindAgain?: boolean;
  fingerprint?: string;
};

export type ExactFindControllerReaderFixture = {
  reader: any;
  dispatched: Array<{ type: string; query: string }>;
  findController: any;
  getListenerCount: () => number;
  setDelayedResultsMs: (delayMs: number | undefined) => void;
};

export function createExactFindControllerReader(
  params: ExactFindControllerReaderParams,
): ExactFindControllerReaderFixture {
  const dispatched: Array<{ type: string; query: string }> = [];
  const matchCount = params.matchCount ?? 1;
  const findController: any = {
    _rawQuery: params.previousQuery || "",
    _state: {
      query: params.previousQuery || "",
      phraseSearch: true,
    },
    pageMatches: params.pageItems.map(() => []),
    _pendingFindMatches: new Set(),
    _pagesToSearch: 0,
    matchesCount: { total: 0 },
    selected: { pageIdx: 0, matchIdx: 0 },
  };
  const listeners = new Map<string, Set<() => void>>();
  const emit = (eventName: string): void => {
    for (const listener of listeners.get(eventName) || []) listener();
  };
  let delayedResultsMs = params.delayedResultsMs;
  const applySearch = (query: string): void => {
    findController._rawQuery = query;
    findController._state = {
      ...findController._state,
      query,
    };
    findController.pageMatches = params.pageItems.map(() => []);
    findController.matchesCount = { total: 0 };
    findController._pendingFindMatches = new Set([0]);
    findController._pagesToSearch = params.pageItems.length;
    const shouldMatch =
      params.matchesQuery?.(query) ?? params.shouldMatch !== false;
    const finishSearch = (): void => {
      if (findController._rawQuery !== query) return;
      const resultPageIndex = params.resultPageIndex ?? params.targetPageIndex;
      if (shouldMatch && query !== params.previousQuery) {
        findController.pageMatches[resultPageIndex] = Array.from(
          { length: matchCount },
          (_value, index) => index,
        );
        findController.matchesCount = { total: matchCount };
        findController.selected = {
          pageIdx: resultPageIndex,
          matchIdx: 0,
        };
      }
      findController._pendingFindMatches = new Set();
      findController._pagesToSearch = 0;
      emit("updatefindmatchescount");
      emit("updatefindcontrolstate");
    };
    if (delayedResultsMs !== undefined) {
      setTimeout(finishSearch, delayedResultsMs);
    } else {
      finishSearch();
    }
  };
  const eventBus = {
    _on: (eventName: string, listener: () => void) => {
      const registered = listeners.get(eventName) || new Set<() => void>();
      registered.add(listener);
      listeners.set(eventName, registered);
    },
    _off: (eventName: string, listener: () => void) => {
      listeners.get(eventName)?.delete(listener);
    },
    dispatch: (
      _eventName: string,
      state: { query?: string; type?: string },
    ) => {
      const type = state.type || "";
      const query = String(state.query || findController._rawQuery || "");
      dispatched.push({ type, query });
      if (type === "again") {
        if (params.ignoreFindAgain) return;
        findController.selected = {
          pageIdx: params.targetPageIndex,
          matchIdx:
            (Number(findController.selected?.matchIdx || 0) + 1) % matchCount,
        };
        return;
      }
      applySearch(query);
    },
  };
  let findBar: any;
  if (params.delayedAcceptanceMs !== undefined) {
    class FakeInputEvent {
      constructor(_type: string, _init?: EventInit) {}
    }
    const findField: any = {
      value: params.previousQuery || "",
      ownerDocument: {
        defaultView: {
          Event: FakeInputEvent,
          InputEvent: FakeInputEvent,
        },
      },
      dispatchEvent: () => {
        const query = findField.value;
        setTimeout(() => applySearch(query), params.delayedAcceptanceMs);
        return true;
      },
    };
    findBar = {
      opened: false,
      open: () => {
        findBar.opened = true;
      },
      close: () => {
        findBar.opened = false;
      },
      findField,
      _findField: findField,
    };
  }
  const app = {
    pdfDocument: {
      numPages: params.pageItems.length,
      fingerprints: [params.fingerprint || "test-pdf"],
      getPage: async (pageNumber: number) => ({
        getTextContent: async (options: { disableNormalization?: boolean }) => {
          assert.isTrue(options.disableNormalization);
          return { items: params.pageItems[pageNumber - 1] || [] };
        },
      }),
    },
    pagesCount: params.pageItems.length,
    page: params.targetPageIndex + 1,
    eventBus,
    findBar,
    findController,
  };
  return {
    reader: {
      _window: {
        PDFViewerApplication: app,
      },
    },
    dispatched,
    findController,
    getListenerCount: () =>
      Array.from(listeners.values()).reduce(
        (total, registered) => total + registered.size,
        0,
      ),
    setDelayedResultsMs: (delayMs) => {
      delayedResultsMs = delayMs;
    },
  };
}
