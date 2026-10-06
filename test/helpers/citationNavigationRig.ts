/**
 * A stand-in Zotero for driving a real citation button through the click
 * navigator (`resolveAndNavigateAssistantCitation`) without Zotero.
 *
 * Papers are regular items with one PDF attachment each. Every attachment gets
 * a fake reader whose PDF.js FindController searches that paper's page text,
 * so the real locator, page-text caches and paragraph jump all run. The rig
 * records what a user could see: which readers opened and where, which
 * FindController queries ran, the status line, the events the panel received,
 * and how often the main window was raised.
 */
import { FakeElement } from "./fakeDom";
import {
  createExactFindControllerReader,
  type ExactFindControllerReaderFixture,
} from "./findControllerReader";
import {
  citationNavigationForTests,
  collectAssistantCitationCandidates,
  extractStandalonePaperSourceLabel,
  type AssistantCitationPaperCandidate,
} from "../../src/modules/contextPanel/assistantCitationLinks";
import { clearPageTextCache } from "../../src/services/pdf/livePdfSelectionLocator";
import { clearQuoteEvidenceProvenanceCacheForTests } from "../../src/modules/contextPanel/quoteEvidenceProvenance";
import { invalidatePaperSearchCache } from "../../src/modules/contextPanel/paperSearch";
import type {
  Message,
  QuoteCitation,
} from "../../src/modules/contextPanel/types";

export type RigPaper = {
  itemId: number;
  attachmentId: number;
  title: string;
  firstCreator: string;
  year: string;
  /** One string per PDF page. */
  pages: string[];
  /**
   * Page text the viewer's PDF.js reports, when it differs from the text
   * Zotero's background PDFWorker reads. Default: `pages`.
   */
  viewerPages?: string[];
  /** Whether Zotero's background PDFWorker can read the text. Default true. */
  backgroundText?: boolean;
  /** Attachment content type. Default "application/pdf". */
  contentType?: string;
  /** Printed page labels the viewer reports, by page index. */
  pageLabels?: string[];
  /** PDF.js document fingerprint. Default `fp-<attachmentId>`. */
  fingerprint?: string;
  /** Collections the parent item is filed in. */
  collectionIds?: number[];
  /** Matches FindController reports on the page that holds a query. Default 1. */
  findMatchCount?: number;
  /**
   * Whether the viewer's FindController finds any query. Default true; false
   * makes every viewer search fail while background text can still verify.
   */
  viewerFinds?: boolean;
  /**
   * Gate on each viewer search, by its 0-based order among the non-empty
   * queries FindController ran. A search the gate refuses finds nothing even
   * when the page text holds the query. Default: every search passes. It
   * models a transient FindController miss; a real FindController does not
   * reject a query for its wording.
   */
  viewerAccepts?: (searchIndex: number) => boolean;
};

export type RigStatus = { text: string; variant: string };

export type RigButtonParams = {
  /** The citation as the answer wrote it, e.g. "(Smith, 2020)". */
  citationLabel: string;
  quoteText: string;
  candidates?: AssistantCitationPaperCandidate[];
  quoteCitation?: QuoteCitation;
  paragraphQuoteText?: string;
  navigationMode?: "inline-citation" | "trusted-quote" | "untrusted-quote";
  agentRunId?: string;
};

export type RigOpen = { itemId: number; location?: Record<string, unknown> };

type RigReader = {
  fixture: ExactFindControllerReaderFixture;
  navigations: Array<Record<string, unknown>>;
};

/** A FakeElement the navigator treats as attached to a live document. */
class LiveElement extends FakeElement {
  get isConnected() {
    return true;
  }

  closest(selector: string): FakeElement | null {
    for (const part of selector.split(",")) {
      const match = super.closest(part.trim());
      if (match) return match;
    }
    return null;
  }
}

const liveDocument = {
  createElement: (tagName: string) => new LiveElement(tagName),
  createElementNS: (_namespace: string, tagName: string) =>
    new LiveElement(tagName),
  querySelectorAll: () => [],
} as unknown as Document;

class RigEvent {
  constructor(public readonly type: string) {}
}

function makeRegularItem(paper: RigPaper): any {
  const fields: Record<string, string> = {
    title: paper.title,
    firstCreator: paper.firstCreator,
    date: paper.year,
    year: paper.year,
  };
  return {
    id: paper.itemId,
    key: `ITEM-${paper.itemId}`,
    libraryID: 1,
    dateAdded: "2025-01-01T00:00:00Z",
    dateModified: "2025-01-01T00:00:00Z",
    firstCreator: paper.firstCreator,
    parentID: undefined,
    attachmentContentType: "",
    isAttachment: () => false,
    isRegularItem: () => true,
    isNote: () => false,
    getAttachments: () => [paper.attachmentId],
    getCollections: () => paper.collectionIds || [],
    getField: (field: string) => fields[field] || "",
    getCreators: () => [
      {
        firstName: "",
        lastName: paper.firstCreator,
        fieldMode: 1,
        creatorTypeID: 8,
      },
    ],
  };
}

function makeAttachment(paper: RigPaper): any {
  const contentType = paper.contentType || "application/pdf";
  return {
    id: paper.attachmentId,
    key: `ATTACH-${paper.attachmentId}`,
    libraryID: 1,
    dateModified: "2025-01-01T00:00:00Z",
    parentID: paper.itemId,
    attachmentContentType: contentType,
    attachmentFilename:
      contentType === "application/pdf"
        ? `paper-${paper.attachmentId}.pdf`
        : `paper-${paper.attachmentId}.html`,
    isAttachment: () => true,
    isRegularItem: () => false,
    isNote: () => false,
    getAttachments: () => [],
    getCollections: () => [],
    getField: (field: string) => (field === "title" ? "Full Text PDF" : ""),
    getCreators: () => [],
  };
}

export type CitationNavigationRig = ReturnType<
  typeof installCitationNavigationRig
>;

/**
 * Install the fake Zotero. Call `rig.restore()` in `afterEach`.
 *
 * `runEvents` are the agent-run trace events `resolveQuoteEvidenceProvenance`
 * reads (the recorded quote provenance of an untrusted quote card).
 */
export function installCitationNavigationRig(options: {
  papers: RigPaper[];
  runEvents?: unknown[];
  /** Readers that exist without a Zotero item behind them (by item id). */
  orphanReaders?: Array<{ itemId: number; pages: string[] }>;
}) {
  const scope = globalThis as typeof globalThis & {
    Zotero?: any;
    ztoolkit?: any;
  };
  const originalZotero = scope.Zotero;
  const originalToolkit = scope.ztoolkit;

  const items = new Map<number, any>();
  const papersByAttachment = new Map<number, RigPaper>();
  const pagesByReaderItem = new Map<number, string[]>();
  for (const paper of options.papers) {
    items.set(paper.itemId, makeRegularItem(paper));
    items.set(paper.attachmentId, makeAttachment(paper));
    papersByAttachment.set(paper.attachmentId, paper);
    pagesByReaderItem.set(paper.attachmentId, paper.pages);
  }
  for (const orphan of options.orphanReaders || []) {
    pagesByReaderItem.set(orphan.itemId, orphan.pages);
  }

  const panelItem = {
    id: 1,
    key: "PANEL",
    libraryID: 1,
    parentID: undefined,
    isAttachment: () => false,
    isRegularItem: () => false,
    isNote: () => false,
    getAttachments: () => [],
    getField: () => "",
  } as unknown as Zotero.Item;

  const readers = new Map<number, RigReader>();
  const opened: RigOpen[] = [];
  const pdfWorkerReads: number[] = [];
  let libraryScans = 0;
  let focusCount = 0;
  let activeReaderItemId: number | null = null;
  const logs: string[] = [];

  const readerFor = (itemId: number): RigReader | null => {
    const existing = readers.get(itemId);
    if (existing) return existing;
    const pages = pagesByReaderItem.get(itemId);
    if (!pages) return null;
    const paper = papersByAttachment.get(itemId);
    const viewerPages = paper?.viewerPages ?? pages;
    let lastQuery = "";
    let searchCount = 0;
    const findParams = {
      pageItems: viewerPages.map((text) => [{ str: text }]),
      // Where a find-again lands: the page that holds the last query, as the
      // real FindController's selection does. (The viewer's current page is
      // read once at construction, while the query is still empty.)
      get targetPageIndex() {
        const index = viewerPages.findIndex((text) => text.includes(lastQuery));
        return index >= 0 ? index : 0;
      },
      matchCount: paper?.findMatchCount,
      fingerprint: paper?.fingerprint || `fp-${itemId}`,
      matchesQuery: (query: string) => {
        lastQuery = query;
        if (!query) return false;
        const accepted = paper?.viewerAccepts?.(searchCount) ?? true;
        searchCount += 1;
        if (paper?.viewerFinds === false || !accepted) return false;
        return viewerPages.some((text) => text.includes(query));
      },
      // Read at search time: FindController reports the page that holds the
      // query, as the real one does.
      get resultPageIndex() {
        const index = viewerPages.findIndex((text) => text.includes(lastQuery));
        return index >= 0 ? index : 0;
      },
    };
    const fixture = createExactFindControllerReader(findParams);
    const app = fixture.reader._window.PDFViewerApplication;
    if (paper?.pageLabels) app.pdfViewer = { pageLabels: paper.pageLabels };
    const getPage = app.pdfDocument.getPage;
    app.pdfDocument.getPage = async (pageNumber: number) => {
      const page = await getPage(pageNumber);
      return {
        // The viewer-API text pass asks without options; the page-native
        // pass asks with them. Both read the same page.
        getTextContent: (textOptions?: { disableNormalization?: boolean }) =>
          page.getTextContent(textOptions || { disableNormalization: true }),
      };
    };
    const navigations: Array<Record<string, unknown>> = [];
    fixture.reader.itemID = itemId;
    // A loaded reader has its internal reader; the Task progress page
    // fallback waits for it.
    fixture.reader._internalReader = {};
    fixture.reader.navigate = async (location: Record<string, unknown>) => {
      navigations.push({ ...location });
    };
    const rigReader = { fixture, navigations };
    readers.set(itemId, rigReader);
    return rigReader;
  };

  scope.ztoolkit = { log: () => undefined };
  scope.Zotero = {
    Items: {
      get: (id: number) => items.get(Math.floor(Number(id))) || null,
      getAll: async () => {
        libraryScans += 1;
        return Array.from(items.values());
      },
    },
    Collections: {
      get: () => null,
      getByLibrary: () => [],
    },
    Libraries: { getName: () => "My Library" },
    PDFWorker: {
      getFullText: async (itemId: number) => {
        pdfWorkerReads.push(itemId);
        const paper = papersByAttachment.get(itemId);
        if (!paper || paper.backgroundText === false) return null;
        return {
          text: paper.pages.join(""),
          pageChars: paper.pages.map((text) => text.length),
        };
      },
    },
    Reader: {
      open: async (itemId: number, location?: Record<string, unknown>) => {
        opened.push({
          itemId,
          location: location ? { ...location } : location,
        });
        const reader = readerFor(itemId);
        if (!reader) return undefined;
        activeReaderItemId = itemId;
        return reader.fixture.reader;
      },
      getByTabID: (tabId: string) => {
        const itemId = Number(String(tabId).replace("tab-", ""));
        return readerFor(itemId)?.fixture.reader || null;
      },
      _readers: [],
    },
    get Tabs() {
      return activeReaderItemId === null
        ? undefined
        : { selectedID: `tab-${activeReaderItemId}`, selectedType: "reader" };
    },
    DB: {
      queryAsync: async () =>
        (options.runEvents || []).map((payload, index) => ({
          runId: "run-1",
          seq: index + 1,
          eventType: "tool_result",
          payloadJson: JSON.stringify(payload),
          createdAt: 1,
        })),
    },
    getMainWindow: () => ({
      focus: () => {
        focusCount += 1;
      },
    }),
    getMainWindows: () => [],
    getActiveZoteroPane: () => null,
    debug: (message: string) => {
      logs.push(String(message));
    },
  };

  const statusHistory: RigStatus[] = [];
  let statusText = "";
  const statusElement = {
    get textContent() {
      return statusText;
    },
    set textContent(value: string) {
      statusText = value;
    },
    get className() {
      return "";
    },
    set className(value: string) {
      statusHistory.push({
        text: statusText,
        variant: value.replace("llm-status llm-status-", ""),
      });
    },
  };
  const events: string[] = [];
  const buttons: HTMLButtonElement[] = [];
  const buttonParams = new WeakMap<HTMLButtonElement, RigButtonParams>();
  const body = {
    querySelector: (selector: string) =>
      selector === "#llm-status" ? statusElement : null,
    querySelectorAll: (selector: string) =>
      selector === "button.llm-citation-icon" ? buttons : [],
    dispatchEvent: (event: { type: string }) => {
      events.push(event.type);
      return true;
    },
    ownerDocument: { defaultView: { Event: RigEvent } },
  } as unknown as Element;

  clearPageTextCache();
  clearQuoteEvidenceProvenanceCacheForTests();
  invalidatePaperSearchCache();

  return {
    panelItem,
    body,
    opened,
    pdfWorkerReads,
    statusHistory,
    events,
    /** Warnings the navigator logged, e.g. failed paragraph jumps. */
    logs,
    get libraryScans() {
      return libraryScans;
    },
    get focusCount() {
      return focusCount;
    },
    get status(): RigStatus | undefined {
      return statusHistory[statusHistory.length - 1];
    },
    /** Make a reader the selected tab, as if the user had it open. */
    selectReader(itemId: number | null) {
      if (itemId !== null) readerFor(itemId);
      activeReaderItemId = itemId;
    },
    reader(itemId: number): RigReader | undefined {
      return readers.get(itemId);
    },
    /**
     * FindController "find" dispatches a reader ran, without find-again and
     * empty-query dispatches. A restore pass that re-sends the last query
     * after a failed search is counted.
     */
    findQueries(itemId: number): string[] {
      return (readers.get(itemId)?.fixture.dispatched || [])
        .filter((entry) => entry.type === "" && entry.query)
        .map((entry) => entry.query);
    },
    /** A message-context candidate for each paper, as a paired user turn. */
    messageCandidates(papers: RigPaper[]): AssistantCitationPaperCandidate[] {
      return collectAssistantCitationCandidates(panelItem, {
        role: "user",
        text: "",
        timestamp: 0,
        paperContexts: papers.map((paper) => ({
          itemId: paper.itemId,
          contextItemId: paper.attachmentId,
          title: paper.title,
          firstCreator: paper.firstCreator,
          year: paper.year,
        })),
      } as Message);
    },
    /** Build a real citation button the way the renderer does. */
    makeButton(params: RigButtonParams): HTMLButtonElement {
      const extractedCitation = extractStandalonePaperSourceLabel(
        params.citationLabel,
      );
      if (!extractedCitation) {
        throw new Error(`not a citation label: ${params.citationLabel}`);
      }
      const container = citationNavigationForTests.createCitationButton({
        ownerDoc: liveDocument,
        body,
        panelItem,
        candidates: params.candidates || [],
        extractedCitation,
        quoteText: params.quoteText,
        quoteCitation: params.quoteCitation,
        paragraphQuoteText: params.paragraphQuoteText,
        navigationMode: params.navigationMode,
        preferRawCitationLabel: params.navigationMode === "untrusted-quote",
        agentRunId: params.agentRunId,
      }) as unknown as FakeElement;
      const button = container.findByClass(
        "llm-citation-icon",
      ) as unknown as HTMLButtonElement;
      buttons.push(button);
      buttonParams.set(button, params);
      return button;
    },
    /** The text a button's citation label shows. */
    labelOf(button: HTMLButtonElement): string {
      return (
        (button as unknown as FakeElement).parentElement?.findByClass(
          "llm-citation-text",
        )?.textContent || ""
      );
    },
    /**
     * Click a button with the arguments its mousedown handler passes, and
     * wait for the navigation to finish. (The handler itself fires and
     * forgets, and also starts background cache warming, which would race
     * the tiers under test.)
     */
    async click(button: HTMLButtonElement): Promise<void> {
      const params = buttonParams.get(button);
      if (!params) throw new Error("not a rig button");
      const extractedCitation = extractStandalonePaperSourceLabel(
        params.citationLabel,
      )!;
      const candidates = params.candidates || [];
      const matchedDisplayLabel =
        params.navigationMode === "untrusted-quote"
          ? ""
          : candidates[0]?.displayCitationLabel || "";
      await citationNavigationForTests.resolveAndNavigateAssistantCitation({
        body,
        button,
        baseSourceLabel: extractedCitation.sourceLabel,
        displayCitationLabel:
          matchedDisplayLabel || extractedCitation.displayCitationLabel,
        candidates,
        panelItem,
        quoteText: params.quoteText,
        paragraphQuoteText: params.paragraphQuoteText,
      });
    },
    /**
     * Press a button the way a user does: dispatch a real `mousedown` on it,
     * so its own handler runs (including the background quote-location cache
     * warm that `click` skips), then wait for the navigation to finish.
     */
    async mousedown(button: HTMLButtonElement): Promise<void> {
      if (!buttonParams.has(button)) throw new Error("not a rig button");
      const target = button as unknown as FakeElement;
      const event = target.dispatchFakeEvent("mousedown");
      if (!event.defaultPrevented) {
        throw new Error("the mousedown handler did not run");
      }
      const startedAt = Date.now();
      while (button.dataset.loading !== "false") {
        if (Date.now() - startedAt > 10000) {
          throw new Error("the mousedown navigation never finished");
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    restore() {
      clearPageTextCache();
      clearQuoteEvidenceProvenanceCacheForTests();
      invalidatePaperSearchCache();
      if (originalZotero === undefined) delete scope.Zotero;
      else scope.Zotero = originalZotero;
      if (originalToolkit === undefined) delete scope.ztoolkit;
      else scope.ztoolkit = originalToolkit;
    },
  };
}
