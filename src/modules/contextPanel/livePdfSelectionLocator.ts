import { collectReaderSelectionDocuments } from "./readerSelection";
import { sanitizeText } from "./textUtils";
import { clearCitationPageCache } from "./citationNavigationCache";
import {
  findLargestUniqueQuoteTextAnchorMatch,
  normalizeLocatorText,
  stripBoundaryEllipsis,
  type QuoteTextSearchQueryKind,
} from "./quoteTextSearch";
import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
  type QuoteTextIndex,
} from "./quoteTextNormalization";

export { splitQuoteAtEllipsis, stripBoundaryEllipsis } from "./quoteTextSearch";

export type LivePdfPageText = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
};

export type LivePdfSelectionPageLocation = {
  contextItemId?: number;
  pageIndex: number;
  pageLabel?: string;
  pagesScanned: number;
};

export type LivePdfSelectionLocateStatus =
  | "resolved"
  | "ambiguous"
  | "not-found"
  | "selection-too-short"
  | "unavailable";

export type LivePdfSelectionLocateConfidence =
  | "high"
  | "medium"
  | "low"
  | "none";

export type LivePdfSelectionLocateResult = {
  status: LivePdfSelectionLocateStatus;
  confidence: LivePdfSelectionLocateConfidence;
  selectionText: string;
  normalizedSelection: string;
  queryLabel?: string;
  expectedPageIndex: number | null;
  computedPageIndex: number | null;
  matchedPageIndexes: number[];
  totalMatches: number;
  pagesScanned: number;
  sourceMatchText?: string;
  sourceMatchKind?: QuoteTextSearchQueryKind;
  sourceMatchPageOccurrence?: number;
  sourceMatchQuoteTokenCoverage?: number;
  excerpt?: string;
  reason?: string;
  debugSummary?: string[];
};

export type ExactQuoteJumpQueryAttempt = {
  query: string;
  matchedPageIndexes: number[];
  totalMatches: number;
};

export type ExactQuoteJumpResult = {
  matched: boolean;
  reason: string;
  failureStage?:
    | "find-controller-unavailable"
    | "source-fingerprint-mismatch"
    | "page-text-unavailable"
    | "full-quote-not-on-page"
    | "query-not-accepted"
    | "full-match-not-found"
    | "intended-match-not-selected"
    | "deadline-exceeded";
  expectedPageIndex: number | null;
  matchedPageIndex?: number;
  queryUsed?: string;
  highlightCoverage?: number;
  queries: ExactQuoteJumpQueryAttempt[];
  debugSummary: string[];
};

type FindControllerSearchResult = {
  matchedPageIndexes: number[];
  totalMatches: number;
  pagesCount: number;
  pageMatchCounts: number[];
  selectedPageIndex: number | null;
  selectedMatchIndex: number | null;
  acceptanceMs: number;
};

type LocatePageTextOptions = {
  queryLabel?: string;
  resolveSinglePageDuplicates?: boolean;
};

type PageMatch = {
  pageIndex: number;
  matchIndexes: number[];
  excerpt?: string;
};

type PageTextIndexEntry = {
  pageIndex: number;
  pageLabel?: string;
  text: string;
  normalizedText: string;
};

const PAGE_CONTAINER_SELECTOR = [
  ".page[data-page-number]",
  ".page[data-page-index]",
  "[data-page-number]",
  "[data-page-index]",
].join(", ");
// FindController concatenates adjacent text-content items without a separator.
// Keep an internal one-character boundary while aligning so a margin line
// number in its own item cannot fuse with a semantic word (for example,
// "the152"). The marker is removed only when reconstructing the literal query
// that FindController will normalize and search.
const PDF_TEXT_ITEM_BOUNDARY = "\u0003";

function buildPageTextIndex(pages: LivePdfPageText[]): PageTextIndexEntry[] {
  return pages.map((page) => ({
    pageIndex: page.pageIndex,
    pageLabel: page.pageLabel,
    text: page.text,
    normalizedText: normalizeLocatorText(page.text),
  }));
}

function searchPageIndexEntries(
  pageIndexEntries: PageTextIndexEntry[],
  query: string,
): {
  matchedPageIndexes: number[];
  totalMatches: number;
  excerpt?: string;
} {
  const normalizedQuery = normalizeLocatorText(query);
  if (!normalizedQuery) {
    return {
      matchedPageIndexes: [],
      totalMatches: 0,
    };
  }

  const matchedPageIndexes: number[] = [];
  let totalMatches = 0;
  let excerpt: string | undefined;
  for (const page of pageIndexEntries) {
    const matchIndexes = findAllMatchIndexes(
      page.normalizedText,
      normalizedQuery,
    );
    if (!matchIndexes.length) continue;
    matchedPageIndexes.push(page.pageIndex);
    totalMatches += matchIndexes.length;
    if (!excerpt) {
      excerpt = buildExcerpt(
        page.normalizedText,
        matchIndexes[0],
        normalizedQuery.length,
      );
    }
  }
  return { matchedPageIndexes, totalMatches, excerpt };
}

function findAllMatchIndexes(haystack: string, needle: string): number[] {
  if (!haystack || !needle) return [];
  const out: number[] = [];
  let cursor = 0;
  while (cursor < haystack.length) {
    const found = haystack.indexOf(needle, cursor);
    if (found < 0) break;
    out.push(found);
    cursor = found + Math.max(1, Math.floor(needle.length / 2));
  }
  return out;
}

function buildExcerpt(
  text: string,
  index: number,
  matchLength: number,
): string {
  if (!text) return "";
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const start = Math.max(0, index - 72);
  const end = Math.min(normalized.length, index + matchLength + 72);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < normalized.length ? "..." : "";
  return `${prefix}${normalized.slice(start, end).trim()}${suffix}`;
}

function isElementNode(value: unknown): value is Element {
  return Boolean(
    value &&
    typeof value === "object" &&
    "nodeType" in value &&
    (value as { nodeType?: unknown }).nodeType === 1,
  );
}

function getElementFromNode(node: Node | null | undefined): Element | null {
  if (!node) return null;
  if (node.nodeType === 1) {
    return node as Element;
  }
  return node.parentElement || null;
}

function parsePageIndexFromElement(
  element: Element | null | undefined,
): number | null {
  let current = element || null;
  while (current) {
    const pageNumberAttr = current.getAttribute("data-page-number");
    if (pageNumberAttr) {
      const pageNumber = Number.parseInt(pageNumberAttr, 10);
      if (Number.isFinite(pageNumber) && pageNumber >= 1) {
        return pageNumber - 1;
      }
    }
    const pageIndexAttr = current.getAttribute("data-page-index");
    if (pageIndexAttr) {
      const pageIndex = Number.parseInt(pageIndexAttr, 10);
      if (Number.isFinite(pageIndex) && pageIndex >= 0) {
        return pageIndex;
      }
    }
    current = current.parentElement;
  }
  return null;
}

function getPageLabelFromElement(
  element: Element | null | undefined,
): string | undefined {
  let current = element || null;
  while (current) {
    const explicitPageLabel = current.getAttribute("data-page-label")?.trim();
    if (explicitPageLabel) return explicitPageLabel;

    const localizationArgs = current.getAttribute("data-l10n-args");
    if (localizationArgs) {
      try {
        const parsed = JSON.parse(localizationArgs) as Record<string, unknown>;
        const localizedPageLabel = String(
          parsed.pageLabel ?? parsed.page ?? parsed.label ?? "",
        ).trim();
        if (localizedPageLabel) return localizedPageLabel;
      } catch {
        // Ignore malformed localization metadata and use the PDF.js fallback.
      }
    }

    const ariaLabel = current.getAttribute("aria-label")?.trim();
    if (ariaLabel) {
      const pageLabelMatch = ariaLabel.match(
        /(?:^|\b)page\s*:?\s*([^\s,.]+)(?:\s|[,.]|$)/i,
      );
      if (pageLabelMatch?.[1]) return pageLabelMatch[1];
    }

    const pageNumberAttr = current.getAttribute("data-page-number");
    if (pageNumberAttr) {
      return pageNumberAttr;
    }
    const pageIndexAttr = current.getAttribute("data-page-index");
    if (pageIndexAttr) {
      const pageIndex = Number.parseInt(pageIndexAttr, 10);
      if (Number.isFinite(pageIndex) && pageIndex >= 0) {
        return `${pageIndex + 1}`;
      }
    }
    current = current.parentElement;
  }
  return undefined;
}

function parseRomanPageLabel(value: string): number {
  const values: Record<string, number> = {
    i: 1,
    v: 5,
    x: 10,
    l: 50,
    c: 100,
    d: 500,
    m: 1000,
  };
  const clean = sanitizeText(value || "")
    .trim()
    .toLowerCase();
  if (!/^[ivxlcdm]+$/.test(clean)) return 0;
  let total = 0;
  let previous = 0;
  for (let index = clean.length - 1; index >= 0; index -= 1) {
    const current = values[clean[index]] || 0;
    if (!current) return 0;
    if (current < previous) {
      total -= current;
    } else {
      total += current;
      previous = current;
    }
  }
  return total;
}

function countRenderedPages(doc: Document): number {
  return doc.querySelectorAll(PAGE_CONTAINER_SELECTOR).length;
}

function getPageElementByIndex(
  doc: Document,
  pageIndex: number,
): Element | null {
  const pageElements = Array.from(
    doc.querySelectorAll(PAGE_CONTAINER_SELECTOR),
  ).filter(isElementNode);
  for (const pageElement of pageElements) {
    if (parsePageIndexFromElement(pageElement) === pageIndex) {
      return pageElement;
    }
  }
  return null;
}

function getSelectionPageElement(doc: Document): Element | null {
  const selection = doc.defaultView?.getSelection?.();
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed) {
    return null;
  }
  const candidates: Array<Node | null> = [
    selection.anchorNode,
    selection.focusNode,
    selection.getRangeAt(0).commonAncestorContainer,
  ];
  for (const node of candidates) {
    const element = getElementFromNode(node);
    const pageIndex = parsePageIndexFromElement(element);
    if (pageIndex !== null) {
      return element;
    }
  }
  return null;
}

function buildDomResolvedResult(
  selectionText: string,
  expectedPageIndex: number | null,
  pageIndex: number,
  pageLabel?: string,
  pagesScanned = 0,
): LivePdfSelectionLocateResult {
  return {
    status: "resolved",
    confidence: "high",
    selectionText: sanitizeText(selectionText || "").trim(),
    normalizedSelection: normalizeLocatorText(selectionText),
    queryLabel: "Selection",
    expectedPageIndex,
    computedPageIndex: pageIndex,
    matchedPageIndexes: [pageIndex],
    totalMatches: 1,
    pagesScanned,
    reason: pageLabel
      ? `Resolved directly from the live selection DOM on page ${pageLabel}.`
      : "Resolved directly from the live selection DOM.",
  };
}

function matchByPrefixSuffix(
  normalizedPageText: string,
  normalizedSelection: string,
): number[] {
  if (normalizedSelection.length < 48) return [];
  const edgeLength = Math.max(
    18,
    Math.min(64, Math.floor(normalizedSelection.length / 3)),
  );
  const prefix = normalizedSelection.slice(0, edgeLength).trim();
  const suffix = normalizedSelection.slice(-edgeLength).trim();
  if (!prefix || !suffix) return [];
  const out: number[] = [];
  let cursor = 0;
  while (cursor < normalizedPageText.length) {
    const prefixIndex = normalizedPageText.indexOf(prefix, cursor);
    if (prefixIndex < 0) break;
    const suffixSearchStart = prefixIndex + prefix.length;
    const suffixIndex = normalizedPageText.indexOf(suffix, suffixSearchStart);
    if (suffixIndex < 0) break;
    const spanLength = suffixIndex + suffix.length - prefixIndex;
    if (spanLength <= normalizedSelection.length * 1.8 + 48) {
      out.push(prefixIndex);
    }
    cursor = prefixIndex + Math.max(1, Math.floor(prefix.length / 2));
  }
  return out;
}

function collectPageMatches(
  pages: LivePdfPageText[],
  normalizedSelection: string,
): { matches: PageMatch[]; confidence: LivePdfSelectionLocateConfidence } {
  const exactMatches: PageMatch[] = [];
  for (const page of pages) {
    const normalizedPageText = normalizeLocatorText(page.text);
    const matchIndexes = findAllMatchIndexes(
      normalizedPageText,
      normalizedSelection,
    );
    if (!matchIndexes.length) continue;
    exactMatches.push({
      pageIndex: page.pageIndex,
      matchIndexes,
      excerpt: buildExcerpt(
        normalizedPageText,
        matchIndexes[0],
        normalizedSelection.length,
      ),
    });
  }
  if (exactMatches.length) {
    return { matches: exactMatches, confidence: "high" };
  }

  const fallbackMatches: PageMatch[] = [];
  for (const page of pages) {
    const normalizedPageText = normalizeLocatorText(page.text);
    const matchIndexes = matchByPrefixSuffix(
      normalizedPageText,
      normalizedSelection,
    );
    if (!matchIndexes.length) continue;
    fallbackMatches.push({
      pageIndex: page.pageIndex,
      matchIndexes,
      excerpt: buildExcerpt(
        normalizedPageText,
        matchIndexes[0],
        normalizedSelection.length,
      ),
    });
  }
  return {
    matches: fallbackMatches,
    confidence: fallbackMatches.length ? "medium" : "none",
  };
}

export function locateSelectionInPageTexts(
  pages: LivePdfPageText[],
  selectionText: string,
  expectedPageIndex?: number | null,
  options?: LocatePageTextOptions,
): LivePdfSelectionLocateResult {
  const queryLabel = options?.queryLabel || "Selection";
  const queryLabelLower = queryLabel.toLowerCase();
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: pages.length,
      reason: `${queryLabel} text was empty.`,
    };
  }
  if (normalizedSelection.length < 12) {
    return {
      status: "selection-too-short",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: pages.length,
      reason: `${queryLabel} was too short for reliable page resolution.`,
    };
  }

  const { matches, confidence } = collectPageMatches(
    pages,
    normalizedSelection,
  );
  const matchedPageIndexes = matches.map((match) => match.pageIndex);
  const totalMatches = matches.reduce(
    (sum, match) => sum + match.matchIndexes.length,
    0,
  );
  if (!matches.length) {
    return {
      status: "not-found",
      confidence: "none",
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      reason: `The live PDF text search did not find the current ${queryLabelLower}.`,
    };
  }
  if (
    matches.length === 1 &&
    totalMatches > 1 &&
    options?.resolveSinglePageDuplicates
  ) {
    return {
      status: "resolved",
      confidence: confidence === "high" ? "low" : confidence,
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: matches[0].pageIndex,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      excerpt: matches[0].excerpt,
      reason: `The current ${queryLabelLower} matched multiple locations on the same page in the live PDF.`,
    };
  }
  if (matches.length > 1 || totalMatches > 1) {
    return {
      status: "ambiguous",
      confidence: confidence === "high" ? "low" : confidence,
      selectionText: sanitizeText(selectionText || "").trim(),
      normalizedSelection,
      queryLabel,
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      excerpt: matches[0].excerpt,
      reason: `The current ${queryLabelLower} matched more than one location in the live PDF.`,
    };
  }

  return {
    status: "resolved",
    confidence,
    selectionText: sanitizeText(selectionText || "").trim(),
    normalizedSelection,
    queryLabel,
    expectedPageIndex: expectedPageIndex ?? null,
    computedPageIndex: matches[0].pageIndex,
    matchedPageIndexes,
    totalMatches,
    pagesScanned: pages.length,
    excerpt: matches[0].excerpt,
  };
}

type IndexedLivePdfPageText = {
  page: LivePdfPageText;
  textIndex: QuoteTextIndex;
};

function locateQuoteInIndexedPageTexts(
  indexedPages: IndexedLivePdfPageText[],
  quoteText: string,
  expectedPageIndex?: number | null,
): LivePdfSelectionLocateResult {
  const pages = indexedPages.map((entry) => entry.page);
  const cleanQuote = sanitizeText(quoteText || "").trim();
  const normalizedSelection = normalizeLocatorText(cleanQuote);
  if (!normalizedSelection) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: pages.length,
      reason: "Quote text was empty.",
    };
  }
  const matches = indexedPages
    .map((entry) => ({
      page: entry.page,
      spans: findQuoteSourceSpansAllowingLayoutArtifacts(
        entry.textIndex,
        cleanQuote,
      ),
    }))
    .filter((entry) => entry.spans.length);
  const matchedPageIndexes = matches.map((entry) => entry.page.pageIndex);
  const totalMatches = matches.reduce(
    (sum, entry) => sum + entry.spans.length,
    0,
  );
  if (!matches.length) {
    const pageByEntryId = new Map<string, LivePdfPageText>();
    const searchEntries = pages.map((page, index) => {
      const id = `page-${page.pageIndex}-${index}`;
      pageByEntryId.set(id, page);
      return {
        id,
        text: page.text,
      };
    });
    const sourceMatch = findLargestUniqueQuoteTextAnchorMatch(
      searchEntries,
      cleanQuote,
      {
        minQueryLength: 24,
        rejectWeakQueries: true,
      },
    );
    const matchedPage = sourceMatch
      ? pageByEntryId.get(sourceMatch.entryId)
      : undefined;
    if (sourceMatch && matchedPage) {
      return {
        status: "resolved",
        confidence: sourceMatch.confidence,
        selectionText: cleanQuote,
        normalizedSelection,
        queryLabel: "Quote",
        expectedPageIndex: expectedPageIndex ?? null,
        computedPageIndex: matchedPage.pageIndex,
        matchedPageIndexes: [matchedPage.pageIndex],
        totalMatches: sourceMatch.totalOccurrences,
        pagesScanned: pages.length,
        sourceMatchText: sourceMatch.query,
        sourceMatchKind: sourceMatch.matchKind,
        sourceMatchPageOccurrence: 0,
        sourceMatchQuoteTokenCoverage: sourceMatch.quoteTokenCoverage,
        reason:
          "The complete quote did not align, but its largest strong contiguous source span matched exactly once in the live PDF text.",
        debugSummary: [
          `Largest unique source span matched ${sourceMatch.matchedTokenCount}/${sourceMatch.quoteTokenCount} quote tokens.`,
        ],
      };
    }
    return {
      status: "not-found",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      reason: "The complete quote was not found in the live PDF text.",
    };
  }
  const normalizedExpectedPageIndex =
    Number.isFinite(expectedPageIndex) && Number(expectedPageIndex) >= 0
      ? Math.floor(Number(expectedPageIndex))
      : null;
  const expectedPageMatch =
    normalizedExpectedPageIndex === null
      ? undefined
      : matches.find(
          (entry) => entry.page.pageIndex === normalizedExpectedPageIndex,
        );
  if (
    totalMatches > 1 &&
    expectedPageMatch &&
    expectedPageMatch.spans.length === 1
  ) {
    return {
      status: "resolved",
      confidence: "high",
      selectionText: cleanQuote,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex: normalizedExpectedPageIndex,
      computedPageIndex: normalizedExpectedPageIndex,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      sourceMatchText: expectedPageMatch.spans[0].text.trim(),
      sourceMatchKind: "exact",
      sourceMatchPageOccurrence: expectedPageMatch.spans[0].occurrenceIndex,
      sourceMatchQuoteTokenCoverage: 1,
      reason:
        "The complete quote matched the expected PDF page; identical complete matches elsewhere in the PDF do not make this navigation ambiguous.",
    };
  }
  const firstSingleOccurrencePage = matches.find(
    (entry) => entry.spans.length === 1,
  );
  if (matches.length > 1 && firstSingleOccurrencePage) {
    return {
      status: "resolved",
      confidence: "medium",
      selectionText: cleanQuote,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex: normalizedExpectedPageIndex,
      computedPageIndex: firstSingleOccurrencePage.page.pageIndex,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      sourceMatchText: firstSingleOccurrencePage.spans[0].text.trim(),
      sourceMatchKind: "exact",
      sourceMatchPageOccurrence:
        firstSingleOccurrencePage.spans[0].occurrenceIndex,
      sourceMatchQuoteTokenCoverage: 1,
      reason:
        "The complete quote matched multiple PDF pages; navigation uses the first page containing one complete occurrence.",
    };
  }
  if (matches.length > 1 || totalMatches > 1) {
    return {
      status: "ambiguous",
      confidence: "low",
      selectionText: cleanQuote,
      normalizedSelection,
      queryLabel: "Quote",
      expectedPageIndex: expectedPageIndex ?? null,
      computedPageIndex: null,
      matchedPageIndexes,
      totalMatches,
      pagesScanned: pages.length,
      reason:
        matches.length > 1
          ? "The complete quote matched more than one PDF page."
          : "The complete quote matched more than one occurrence on the PDF page.",
    };
  }
  return {
    status: "resolved",
    confidence: "high",
    selectionText: cleanQuote,
    normalizedSelection,
    queryLabel: "Quote",
    expectedPageIndex: expectedPageIndex ?? null,
    computedPageIndex: matches[0].page.pageIndex,
    matchedPageIndexes,
    totalMatches,
    pagesScanned: pages.length,
    sourceMatchText: matches[0].spans[0].text.trim(),
    sourceMatchKind: "exact",
    sourceMatchPageOccurrence: matches[0].spans[0].occurrenceIndex,
    sourceMatchQuoteTokenCoverage: 1,
    reason: "The complete quote matched a single PDF page.",
  };
}

export function locateQuoteInPageTexts(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex?: number | null,
): LivePdfSelectionLocateResult {
  return locateQuoteInIndexedPageTexts(
    pages.map((page) => ({
      page,
      textIndex: buildQuoteTextIndex(page.text),
    })),
    quoteText,
    expectedPageIndex,
  );
}

function unwrapGeckoJsObject(value: any): any {
  try {
    return value?.wrappedJSObject || value;
  } catch {
    return value;
  }
}

function resolveGeckoMethodOwner(value: any, methodName: string): any | null {
  const candidates = [unwrapGeckoJsObject(value), value];
  const seen = new Set<any>();
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue;
    seen.add(candidate);
    try {
      if (typeof candidate[methodName] === "function") return candidate;
    } catch {
      // Continue to the other side of the Gecko wrapper.
    }
  }
  return null;
}

function getPdfViewerApplication(reader: any): any | null {
  const candidates = [
    reader?._internalReader?._lastView,
    reader?._internalReader?._primaryView,
    reader?._internalReader?._secondaryView,
    reader,
  ];
  for (const candidate of candidates) {
    // Firefox/Gecko Xray wrapper bypass — custom JS globals like
    // PDFViewerApplication are hidden behind Xray wrappers and need
    // wrappedJSObject to expose PDFDocumentProxy prototype methods such as
    // getPage() to chrome (privileged) code. Prefer the unwrapped application:
    // an Xray wrapper can expose app.pdfDocument while still hiding getPage(),
    // which makes page-native quote extraction fail in the real Zotero reader.
    try {
      const wrapped =
        candidate?._iframeWindow?.wrappedJSObject?.PDFViewerApplication ||
        candidate?._iframe?.contentWindow?.wrappedJSObject
          ?.PDFViewerApplication ||
        candidate?._window?.wrappedJSObject?.PDFViewerApplication;
      if (wrapped?.pdfDocument) return wrapped;
    } catch {
      // wrappedJSObject may throw in non-Firefox environments
    }

    // Standard property access for tests and reader builds without Xray
    // wrappers.
    const app =
      candidate?._iframeWindow?.PDFViewerApplication ||
      candidate?._iframe?.contentWindow?.PDFViewerApplication ||
      candidate?._window?.PDFViewerApplication;
    if (app?.pdfDocument) return app;
  }

  // Last resort: reach the iframe window via the DOM documents already
  // accessible through collectReaderSelectionDocuments.
  try {
    const docs = collectReaderSelectionDocuments(reader);
    for (const doc of docs) {
      const win: any = doc?.defaultView;
      if (!win) continue;
      try {
        const wrapped = win.wrappedJSObject?.PDFViewerApplication;
        if (wrapped?.pdfDocument) return wrapped;
      } catch {
        // Ignore
      }
      const app = win.PDFViewerApplication;
      if (app?.pdfDocument) return app;
    }
  } catch {
    // Ignore
  }

  return null;
}

function getExpectedPageIndex(reader: any, app?: any | null): number | null {
  const candidates = [
    reader?._internalReader?._state?.primaryViewStats?.pageIndex,
    reader?._internalReader?._state?.secondaryViewStats?.pageIndex,
    Number.isFinite(app?.page) ? Number(app.page) - 1 : null,
  ];
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") {
      continue;
    }
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }
  return null;
}

function locateCurrentSelectionFromDom(
  reader: any,
  selectionText: string,
): LivePdfSelectionLocateResult | null {
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) return null;

  const app = getPdfViewerApplication(reader);
  const expectedPageIndex = getExpectedPageIndex(reader, app);
  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const selectedText = sanitizeText(
      doc.defaultView?.getSelection?.()?.toString() || "",
    ).trim();
    if (!selectedText) continue;
    if (normalizeLocatorText(selectedText) !== normalizedSelection) continue;
    const selectionPageElement = getSelectionPageElement(doc);
    const pageIndex = parsePageIndexFromElement(selectionPageElement);
    if (pageIndex === null) continue;
    return buildDomResolvedResult(
      selectionText,
      expectedPageIndex,
      pageIndex,
      getPageLabelForIndex(reader, pageIndex),
      countRenderedPages(doc),
    );
  }
  return null;
}

export function getCurrentSelectionPageLocationFromReader(
  reader: any,
  selectionText: string,
): LivePdfSelectionPageLocation | null {
  const normalizedSelection = normalizeLocatorText(selectionText);
  if (!normalizedSelection) return null;

  const docs = collectReaderSelectionDocuments(reader);
  const contextItemId = (() => {
    const raw = Number(reader?._item?.id || reader?.itemID || 0);
    return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
  })();

  for (const doc of docs) {
    const selectedText = sanitizeText(
      doc.defaultView?.getSelection?.()?.toString() || "",
    ).trim();
    if (!selectedText) continue;
    if (normalizeLocatorText(selectedText) !== normalizedSelection) continue;
    const selectionPageElement = getSelectionPageElement(doc);
    const pageIndex = parsePageIndexFromElement(selectionPageElement);
    if (pageIndex === null) continue;
    return {
      contextItemId,
      pageIndex,
      pageLabel: getPageLabelForIndex(reader, pageIndex),
      pagesScanned: countRenderedPages(doc),
    };
  }

  return null;
}

export function getPageLabelForIndex(
  reader: any,
  pageIndex: number,
): string | undefined {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return undefined;
  const normalizedPageIndex = Math.floor(pageIndex);

  // PDF.js data-page-number is always the internal 1-based index. Prefer
  // the viewer's pageLabels array so printed labels such as 431 or iv are
  // preserved instead of being collapsed to the internal page number 4.
  const app = getPdfViewerApplication(reader);
  const labels =
    app?.pdfViewer?.pageLabels ||
    app?.pdfViewer?._pageLabels ||
    app?.pdfDocument?._pageLabels;
  if (Array.isArray(labels) && labels[normalizedPageIndex]) {
    return String(labels[normalizedPageIndex]);
  }

  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const pageElement = getPageElementByIndex(doc, normalizedPageIndex);
    const pageLabel = getPageLabelFromElement(pageElement);
    if (pageLabel) return pageLabel;
  }

  return `${normalizedPageIndex + 1}`;
}

/**
 * Reverse lookup: resolve a page label (printed page number) to a 0-based
 * page index using the PDF's actual page label array.  Falls back to
 * `parseInt(label) - 1` when the PDF has no custom labels or the label is
 * not found in the array.
 */
export function resolvePageIndexForLabel(
  reader: any,
  pageLabel: string,
): number | null {
  const clean = sanitizeText(pageLabel || "").trim();
  if (!clean) return null;

  const app = getPdfViewerApplication(reader);
  const labels: unknown = app?.pdfViewer?.pageLabels;
  if (Array.isArray(labels) && labels.length > 0) {
    const idx = labels.findIndex(
      (entry: unknown) => String(entry || "") === clean,
    );
    if (idx >= 0) return idx;
  }

  if (/^\d+$/.test(clean)) {
    const parsed = Number.parseInt(clean, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : null;
  }

  if (/^[ivxlcdm]+$/i.test(clean)) {
    const roman = parseRomanPageLabel(clean);
    const pagesCount = getPagesCount(app);
    if (roman > 0 && (!pagesCount || roman <= pagesCount)) {
      return roman - 1;
    }
  }

  return null;
}

export async function resolveCurrentSelectionPageLocationFromReader(
  reader: any,
  selectionText: string,
): Promise<LivePdfSelectionPageLocation | null> {
  const directLocation = getCurrentSelectionPageLocationFromReader(
    reader,
    selectionText,
  );
  if (directLocation) return directLocation;

  const resolved = await locateCurrentSelectionInLivePdfReader(
    reader,
    selectionText,
  );
  if (resolved.status !== "resolved" || resolved.computedPageIndex === null) {
    return null;
  }

  const rawContextItemId = Number(reader?._item?.id || reader?.itemID || 0);
  const contextItemId =
    Number.isFinite(rawContextItemId) && rawContextItemId > 0
      ? Math.floor(rawContextItemId)
      : undefined;
  const pageIndex = Math.floor(resolved.computedPageIndex);
  return {
    contextItemId,
    pageIndex,
    pageLabel: getPageLabelForIndex(reader, pageIndex),
    pagesScanned: resolved.pagesScanned,
  };
}

function extractPageTextFromElement(pageElement: Element): string {
  const textLayer =
    pageElement.querySelector(".textLayer") ||
    pageElement.querySelector('[class*="textLayer"]');
  if (textLayer) {
    // Collect text from each direct child span separately and join with
    // a space.  Some PDF.js builds produce text-layer spans whose
    // textContent lacks trailing spaces, causing `textLayer.textContent`
    // to concatenate words into a single run (e.g. "wordAwordB").
    const children = textLayer.children;
    if (children.length > 0) {
      const parts: string[] = [];
      for (let i = 0; i < children.length; i++) {
        const t = (children[i].textContent || "").trimEnd();
        if (t) parts.push(t);
      }
      if (parts.length) {
        return sanitizeText(parts.join(" ").trim());
      }
    }
    return sanitizeText((textLayer.textContent || "").trim());
  }
  return sanitizeText((pageElement.textContent || "").trim());
}

function extractRenderedPageTexts(reader: any): {
  pages: LivePdfPageText[];
  expectedPageIndex: number | null;
} {
  const app = getPdfViewerApplication(reader);
  const pagesByIndex = new Map<number, LivePdfPageText>();
  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const pageElements = Array.from(
      doc.querySelectorAll(PAGE_CONTAINER_SELECTOR),
    ).filter(isElementNode);
    for (const pageElement of pageElements) {
      const pageIndex = parsePageIndexFromElement(pageElement);
      if (pageIndex === null || pagesByIndex.has(pageIndex)) continue;
      const text = extractPageTextFromElement(pageElement);
      if (!text) continue;
      pagesByIndex.set(pageIndex, {
        pageIndex,
        pageLabel: getPageLabelForIndex(reader, pageIndex),
        text,
      });
    }
  }

  return {
    pages: Array.from(pagesByIndex.values()).sort(
      (a, b) => a.pageIndex - b.pageIndex,
    ),
    expectedPageIndex: getExpectedPageIndex(reader, app),
  };
}

// ── Page text cache ─────────────────────────────────────────────────
// Pre-loads ALL page texts from the PDF document once and caches them
// so that subsequent quote lookups are instant (pure in-memory substring
// search with zero async I/O).

export type PageTextCacheCoverage =
  | "full-pdfworker"
  | "full-viewer"
  | "partial-dom";

export interface CachedPageTextIndex {
  pages: LivePdfPageText[];
  /** Pre-computed normalised text per page for O(1) reuse. */
  normalised: {
    pageIndex: number;
    pageLabel?: string;
    normalizedText: string;
    textIndex: QuoteTextIndex;
  }[];
  coverage: PageTextCacheCoverage;
  pageCount?: number;
  sourceFingerprint?: string;
}

type ExtractedPageTextIndexSource = {
  pages: LivePdfPageText[];
  pageCount?: number;
};

export type HiddenQuoteLocationCacheEntry = {
  contextItemId: number;
  pageIndex: number;
  sourceFingerprint?: string;
  sourceMatchText?: string;
  sourceMatchKind?: QuoteTextSearchQueryKind;
  sourceMatchPageOccurrence?: number;
  sourceMatchQuoteTokenCoverage?: number;
  confidence: LivePdfSelectionLocateConfidence;
  reason?: string;
  matchedPageIndexes: number[];
  pagesScanned: number;
  debugSummary?: string[];
};

const MAX_PAGE_TEXT_CACHE_ENTRIES = 50;
const PAGE_TEXT_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
const FIND_CONTROLLER_NAVIGATION_DEADLINE_MS = 2500;
const MAX_PAGE_TEXT_CACHE_CHARS = 8_000_000;
const MAX_HIDDEN_QUOTE_LOCATION_CACHE_ENTRIES = 1000;

type CachedPageTextRecord = {
  index: CachedPageTextIndex;
  createdAt: number;
  lastAccessedAt: number;
  lastAccessedOrder: number;
  textChars: number;
};

type HiddenQuoteLocationCacheRecord = {
  entry: HiddenQuoteLocationCacheEntry;
  createdAt: number;
  lastAccessedAt: number;
  lastAccessedOrder: number;
};

const pageTextCacheByKey = new Map<string, CachedPageTextRecord>();
const pageTextCachePromisesByKey = new Map<
  string,
  Promise<CachedPageTextIndex | null>
>();
const hiddenQuoteLocationCache = new Map<
  string,
  HiddenQuoteLocationCacheRecord
>();
const hiddenQuoteLocationTasks = new Map<
  string,
  Promise<HiddenQuoteLocationCacheEntry | null>
>();
let anonymousReaderKeys = new WeakMap<object, string>();
let anonymousReaderKeySequence = 0;
let pageTextCacheGeneration = 0;
let cacheAccessSequence = 0;

function normalizePageTextCacheKey(value: unknown): string | null {
  const key = sanitizeText(String(value || "")).trim();
  return key ? key : null;
}

function uniqueCacheKeys(values: Array<string | null | undefined>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const key = normalizePageTextCacheKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function getAttachmentPageTextCacheKey(contextItemId: number): string | null {
  const itemId = Math.floor(Number(contextItemId));
  return Number.isFinite(itemId) && itemId > 0 ? `item-${itemId}` : null;
}

function getReaderItemPageTextCacheKey(reader: any): string | null {
  const itemId = Number(reader?._item?.id || reader?.itemID || 0);
  return Number.isFinite(itemId) && itemId > 0
    ? getAttachmentPageTextCacheKey(itemId)
    : null;
}

function getReaderFingerprintCacheKey(reader: any): string | null {
  const app = getPdfViewerApplication(reader);
  const fp = app?.pdfDocument?.fingerprints;
  return Array.isArray(fp) && fp[0] ? `fingerprint-${String(fp[0])}` : null;
}

function getAnonymousReaderCacheKey(reader: any): string | null {
  if (!reader) return null;
  const type = typeof reader;
  if (type !== "object" && type !== "function") return null;
  const readerObject = reader as object;
  let key = anonymousReaderKeys.get(readerObject);
  if (!key) {
    anonymousReaderKeySequence += 1;
    key = `reader-${anonymousReaderKeySequence}`;
    anonymousReaderKeys.set(readerObject, key);
  }
  return key;
}

function getReaderCacheKeys(reader: any): string[] {
  return uniqueCacheKeys([
    getReaderFingerprintCacheKey(reader),
    getReaderItemPageTextCacheKey(reader),
    getAnonymousReaderCacheKey(reader),
  ]);
}

function getCachedPageTextIndex(keys: string[]): CachedPageTextIndex | null {
  const currentTime = Date.now();
  evictExpiredPageTextCacheRecords(currentTime);
  for (const key of keys) {
    const cached = pageTextCacheByKey.get(key);
    if (cached) {
      touchPageTextCacheRecord(cached, currentTime);
      return cached.index;
    }
  }
  return null;
}

function getCachedPageTextPromise(
  keys: string[],
): Promise<CachedPageTextIndex | null> | null {
  for (const key of keys) {
    const task = pageTextCachePromisesByKey.get(key);
    if (task) return task;
  }
  return null;
}

function storeCachedPageTextIndex(
  keys: string[],
  index: CachedPageTextIndex,
): void {
  const currentTime = Date.now();
  evictExpiredPageTextCacheRecords(currentTime);
  const record: CachedPageTextRecord = {
    index,
    createdAt: currentTime,
    lastAccessedAt: currentTime,
    lastAccessedOrder: nextCacheAccessOrder(),
    textChars: estimateCachedPageTextChars(index),
  };
  for (const key of keys) {
    pageTextCacheByKey.set(key, record);
  }
  enforcePageTextCacheLimits(currentTime);
}

function nextCacheAccessOrder(): number {
  cacheAccessSequence += 1;
  return cacheAccessSequence;
}

function touchPageTextCacheRecord(
  record: CachedPageTextRecord,
  currentTime: number,
): void {
  record.lastAccessedAt = currentTime;
  record.lastAccessedOrder = nextCacheAccessOrder();
}

function storeCachedPageTextPromise(
  keys: string[],
  task: Promise<CachedPageTextIndex | null>,
): void {
  for (const key of keys) {
    pageTextCachePromisesByKey.set(key, task);
  }
}

function clearCachedPageTextPromise(
  keys: string[],
  task?: Promise<CachedPageTextIndex | null>,
): void {
  for (const key of keys) {
    if (task && pageTextCachePromisesByKey.get(key) !== task) continue;
    pageTextCachePromisesByKey.delete(key);
  }
}

function estimateCachedPageTextChars(index: CachedPageTextIndex): number {
  let total = 0;
  for (const page of index.pages) {
    total += String(page.text || "").length;
  }
  for (const page of index.normalised) {
    total += String(page.normalizedText || "").length;
  }
  return total;
}

function getUniquePageTextCacheRecords(): CachedPageTextRecord[] {
  const seen = new Set<CachedPageTextRecord>();
  const records: CachedPageTextRecord[] = [];
  for (const record of pageTextCacheByKey.values()) {
    if (seen.has(record)) continue;
    seen.add(record);
    records.push(record);
  }
  return records;
}

function deletePageTextCacheRecord(record: CachedPageTextRecord): void {
  for (const [key, cached] of pageTextCacheByKey) {
    if (cached === record) {
      pageTextCacheByKey.delete(key);
    }
  }
}

function evictExpiredPageTextCacheRecords(currentTime: number): void {
  for (const record of getUniquePageTextCacheRecords()) {
    if (currentTime - record.createdAt > PAGE_TEXT_CACHE_TTL_MS) {
      deletePageTextCacheRecord(record);
    }
  }
}

function getPageTextCacheTotalChars(records: CachedPageTextRecord[]): number {
  return records.reduce((total, record) => total + record.textChars, 0);
}

function findLeastRecentlyUsedPageTextRecord(
  records: CachedPageTextRecord[],
): CachedPageTextRecord | null {
  let oldest: CachedPageTextRecord | null = null;
  for (const record of records) {
    if (!oldest || record.lastAccessedOrder < oldest.lastAccessedOrder) {
      oldest = record;
    }
  }
  return oldest;
}

function enforcePageTextCacheLimits(currentTime: number): void {
  evictExpiredPageTextCacheRecords(currentTime);
  let records = getUniquePageTextCacheRecords();
  let totalChars = getPageTextCacheTotalChars(records);
  while (
    records.length > MAX_PAGE_TEXT_CACHE_ENTRIES ||
    (records.length > 1 && totalChars > MAX_PAGE_TEXT_CACHE_CHARS)
  ) {
    const oldest = findLeastRecentlyUsedPageTextRecord(records);
    if (!oldest) return;
    deletePageTextCacheRecord(oldest);
    records = getUniquePageTextCacheRecords();
    totalChars = getPageTextCacheTotalChars(records);
  }
}

function buildCachedPageTextIndex(
  pages: LivePdfPageText[],
  coverage: PageTextCacheCoverage,
  pageCount?: number,
  sourceFingerprint?: string,
): CachedPageTextIndex {
  const normalised = pages.map((p) => {
    const textIndex = buildQuoteTextIndex(p.text);
    return {
      pageIndex: p.pageIndex,
      pageLabel: p.pageLabel,
      normalizedText: textIndex.canonicalText,
      textIndex,
    };
  });
  const normalizedPageCount =
    Number.isFinite(pageCount) && Number(pageCount) > 0
      ? Math.floor(Number(pageCount))
      : undefined;
  const resolvedSourceFingerprint =
    sourceFingerprint ||
    `page-text:${hashFindControllerQuery(
      pages.map((page) => `${page.pageIndex}\u241e${page.text}`).join("\u241f"),
    )}`;
  return {
    pages,
    normalised,
    coverage,
    pageCount: normalizedPageCount,
    sourceFingerprint: resolvedSourceFingerprint,
  };
}

function isCompletePageTextCache(cached: CachedPageTextIndex | null): boolean {
  return (
    cached?.coverage === "full-pdfworker" || cached?.coverage === "full-viewer"
  );
}

function canUseCachedPageTextAsNegativeEvidence(
  cached: CachedPageTextIndex | null,
): boolean {
  return isCompletePageTextCache(cached);
}

export function getCachedPageTextForAttachment(
  contextItemId: number,
): CachedPageTextIndex | null {
  const key = getAttachmentPageTextCacheKey(contextItemId);
  return key ? getCachedPageTextIndex([key]) : null;
}

export function hasCompleteSearchablePageTextForAttachment(
  contextItemId: number,
): boolean {
  const cached = getCachedPageTextForAttachment(contextItemId);
  if (
    !isCompletePageTextCache(cached) ||
    !cached?.pageCount ||
    cached.pages.length !== cached.pageCount
  ) {
    return false;
  }
  return cached.normalised.every((page) => Boolean(page.normalizedText));
}

function buildHiddenQuoteLocationCacheKey(
  contextItemId: number,
  quoteText: string,
): string | null {
  const itemId = Math.floor(Number(contextItemId));
  if (!Number.isFinite(itemId) || itemId <= 0) return null;
  const normalizedQuote = normalizeLocatorText(
    stripBoundaryEllipsis(quoteText),
  );
  if (!normalizedQuote) return null;
  return `${itemId}\u241f${normalizedQuote.length}:${hashFindControllerQuery(
    normalizedQuote,
  )}`;
}

function isCacheRecordExpired(
  currentTime: number,
  record: { createdAt: number },
): boolean {
  return currentTime - record.createdAt > PAGE_TEXT_CACHE_TTL_MS;
}

function evictExpiredHiddenQuoteLocationRecords(currentTime: number): void {
  for (const [key, record] of hiddenQuoteLocationCache) {
    if (isCacheRecordExpired(currentTime, record)) {
      hiddenQuoteLocationCache.delete(key);
    }
  }
}

function enforceHiddenQuoteLocationCacheLimit(currentTime: number): void {
  evictExpiredHiddenQuoteLocationRecords(currentTime);
  while (
    hiddenQuoteLocationCache.size > MAX_HIDDEN_QUOTE_LOCATION_CACHE_ENTRIES
  ) {
    let oldestKey = "";
    let oldestAccessOrder = Number.POSITIVE_INFINITY;
    for (const [key, record] of hiddenQuoteLocationCache) {
      if (record.lastAccessedOrder < oldestAccessOrder) {
        oldestAccessOrder = record.lastAccessedOrder;
        oldestKey = key;
      }
    }
    if (!oldestKey) return;
    hiddenQuoteLocationCache.delete(oldestKey);
  }
}

function rememberHiddenQuoteLocationCacheEntry(
  key: string,
  entry: HiddenQuoteLocationCacheEntry,
): void {
  const currentTime = Date.now();
  hiddenQuoteLocationCache.set(key, {
    entry,
    createdAt: currentTime,
    lastAccessedAt: currentTime,
    lastAccessedOrder: nextCacheAccessOrder(),
  });
  enforceHiddenQuoteLocationCacheLimit(currentTime);
}

function toHiddenQuoteLocationCacheEntry(
  contextItemId: number,
  result: LivePdfSelectionLocateResult,
): HiddenQuoteLocationCacheEntry | null {
  if (result.status !== "resolved" || result.computedPageIndex === null) {
    return null;
  }
  const pageIndex = Math.floor(result.computedPageIndex);
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;
  return {
    contextItemId: Math.floor(contextItemId),
    pageIndex,
    sourceMatchText: result.sourceMatchText,
    sourceMatchKind: result.sourceMatchKind,
    sourceMatchPageOccurrence: result.sourceMatchPageOccurrence,
    sourceMatchQuoteTokenCoverage: result.sourceMatchQuoteTokenCoverage,
    confidence: result.confidence,
    reason: result.reason,
    matchedPageIndexes: result.matchedPageIndexes.slice(),
    pagesScanned: result.pagesScanned,
    debugSummary: result.debugSummary?.slice(),
  };
}

function locateQuoteLocationInCachedPages(
  contextItemId: number,
  quoteText: string,
  cached: CachedPageTextIndex,
): HiddenQuoteLocationCacheEntry | null {
  const located = locateQuoteInCachedPageTexts(cached, quoteText, null);
  const entry = toHiddenQuoteLocationCacheEntry(contextItemId, located);
  return entry
    ? {
        ...entry,
        sourceFingerprint: cached.sourceFingerprint,
      }
    : null;
}

function locateQuoteInCachedPageTexts(
  cached: CachedPageTextIndex,
  quoteText: string,
  expectedPageIndex?: number | null,
): LivePdfSelectionLocateResult {
  const cachedIndexByPage = new Map(
    cached.normalised.map((entry) => [entry.pageIndex, entry.textIndex]),
  );
  return locateQuoteInIndexedPageTexts(
    cached.pages.map((page) => ({
      page,
      textIndex:
        cachedIndexByPage.get(page.pageIndex) ??
        // Partial DOM caches can be refreshed independently. Preserve
        // correctness if a stale caller supplies a page missing its index.
        buildQuoteTextIndex(page.text),
    })),
    quoteText,
    expectedPageIndex,
  );
}

// ── Text extraction strategies ──────────────────────────────────────
// Three approaches to extract per-page text, tried in priority order.
// The first one that returns data wins.

/**
 * Strategy 0 — Zotero PDFWorker (MOST RELIABLE)
 *
 * Uses Zotero.PDFWorker.getFullText(itemId) which returns
 * { text: string, pageChars: number[] }.  `pageChars[i]` is the
 * character count for page i, so we slice the full text into per-page
 * segments using cumulative offsets.  This requires NO iframe access
 * and is proven working in the codebase (pdfContext.ts).
 */
async function extractPageTextsFromPdfWorkerItemId(
  itemId: number,
): Promise<ExtractedPageTextIndexSource | null> {
  try {
    if (!Number.isFinite(itemId) || itemId <= 0) {
      ztoolkit.log("LLM quote-locator: PDFWorker — no valid itemID on reader");
      return null;
    }

    const result = await Zotero.PDFWorker.getFullText(itemId);
    if (!result || !result.text) {
      ztoolkit.log("LLM quote-locator: PDFWorker.getFullText returned no text");
      return null;
    }

    const fullText: string = String(result.text);
    const pageChars: number[] | undefined = result.pageChars;

    if (!Array.isArray(pageChars) || pageChars.length === 0) {
      // Fallback: if pageChars is unavailable, try splitting by form-feed
      const ffPages = fullText.split("\f");
      if (ffPages.length > 1) {
        ztoolkit.log(
          "LLM quote-locator: PDFWorker — no pageChars, using form-feed split:",
          ffPages.length,
          "pages",
        );
        const pages: LivePdfPageText[] = [];
        for (let i = 0; i < ffPages.length; i++) {
          const text = sanitizeText(ffPages[i].trim());
          if (text) {
            pages.push({ pageIndex: i, pageLabel: `${i + 1}`, text });
          }
        }
        return pages.length > 0 ? { pages, pageCount: ffPages.length } : null;
      }
      ztoolkit.log(
        "LLM quote-locator: PDFWorker — no pageChars and no form-feeds, cannot split into pages",
      );
      return null;
    }

    // Slice the full text into per-page segments using pageChars offsets
    const pages: LivePdfPageText[] = [];
    let offset = 0;
    for (let i = 0; i < pageChars.length; i++) {
      const charCount = pageChars[i];
      if (charCount > 0 && offset + charCount <= fullText.length) {
        const pageText = fullText.slice(offset, offset + charCount);
        const text = sanitizeText(pageText.trim());
        if (text) {
          pages.push({ pageIndex: i, pageLabel: `${i + 1}`, text });
        }
      }
      offset += charCount;
    }

    ztoolkit.log(
      "LLM quote-locator: PDFWorker extracted",
      pages.length,
      "pages from",
      pageChars.length,
      "total (text length:",
      fullText.length,
      ")",
    );
    return pages.length > 0 ? { pages, pageCount: pageChars.length } : null;
  } catch (e) {
    ztoolkit.log("LLM quote-locator: PDFWorker strategy failed:", e);
    return null;
  }
}

async function extractPageTextsFromPdfWorker(
  reader: any,
): Promise<ExtractedPageTextIndexSource | null> {
  const itemId = Number(reader?._item?.id || reader?.itemID || 0);
  return extractPageTextsFromPdfWorkerItemId(itemId);
}

/**
 * Strategy 1 — pdf.js viewer API
 *
 * Reaches into the viewer iframe to access pdfDocument.getPage(i)
 * and getTextContent().  This gives precise per-page text with correct
 * page labels and covers ALL pages in the document.
 */
async function extractPageTextsFromViewer(
  reader: any,
): Promise<ExtractedPageTextIndexSource | null> {
  try {
    const app = getPdfViewerApplication(reader);
    if (!app) {
      ztoolkit.log("LLM quote-locator: getPdfViewerApplication returned null");
      return null;
    }
    if (!app.pdfDocument) {
      ztoolkit.log(
        "LLM quote-locator: app found but pdfDocument is null/undefined",
      );
      return null;
    }
    const pdfDoc = resolveGeckoMethodOwner(app.pdfDocument, "getPage");
    if (!pdfDoc) {
      ztoolkit.log(
        "LLM quote-locator: pdfDocument.getPage is unavailable through the Gecko wrapper",
      );
      return null;
    }
    const numPages = Number(pdfDoc.numPages);
    if (!Number.isFinite(numPages) || numPages < 1) {
      ztoolkit.log(
        "LLM quote-locator: pdfDocument.numPages =",
        pdfDoc.numPages,
      );
      return null;
    }

    ztoolkit.log(
      "LLM quote-locator: extracting text from",
      numPages,
      "pages via viewer API",
    );
    const pages: LivePdfPageText[] = [];
    for (let i = 1; i <= numPages; i++) {
      try {
        const page = resolveGeckoMethodOwner(
          await pdfDoc.getPage(i),
          "getTextContent",
        );
        if (!page) {
          ztoolkit.log(
            "LLM quote-locator: page",
            i,
            "does not expose getTextContent through the Gecko wrapper",
          );
          continue;
        }
        const textContent = unwrapGeckoJsObject(await page.getTextContent());
        const rawItems = textContent?.items;
        const itemCount = Number(rawItems?.length || 0);
        const items: any[] = [];
        if (Number.isFinite(itemCount) && itemCount > 0) {
          for (let itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
            items.push(unwrapGeckoJsObject(rawItems[itemIndex]));
          }
        }
        const text = items
          .map((item: any) => item.str ?? "")
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (text) {
          let pageLabel = `${i}`;
          const labels = app?.pdfViewer?.pageLabels;
          if (Array.isArray(labels) && labels[i - 1]) {
            pageLabel = String(labels[i - 1]);
          }
          pages.push({ pageIndex: i - 1, pageLabel, text: sanitizeText(text) });
        }
      } catch (e) {
        ztoolkit.log(
          "LLM quote-locator: page",
          i,
          "text extraction failed:",
          e,
        );
      }
    }
    if (pages.length) {
      ztoolkit.log(
        "LLM quote-locator: viewer API extracted",
        pages.length,
        "pages",
      );
    }
    return pages.length > 0 ? { pages, pageCount: numPages } : null;
  } catch (e) {
    ztoolkit.log("LLM quote-locator: viewer API strategy failed:", e);
    return null;
  }
}

async function refreshPageTextCacheFromLiveViewer(
  reader: any,
): Promise<CachedPageTextIndex | null> {
  const extracted = await extractPageTextsFromViewer(reader);
  if (!extracted?.pages.length) return null;
  const fingerprint = getPdfDocumentFingerprint(
    getPdfViewerApplication(reader),
  );
  const result = buildCachedPageTextIndex(
    extracted.pages,
    "full-viewer",
    extracted.pageCount,
    fingerprint ? `pdfjs:${fingerprint}` : undefined,
  );
  storeCachedPageTextIndex(getReaderCacheKeys(reader), result);
  return result;
}

/**
 * Warm (or return) the page-text cache for the given reader.
 *
 * Safe to call multiple times — only the first call triggers extraction;
 * subsequent calls return the same promise.  Tries three strategies:
 *
 *   0. Zotero PDFWorker  — most reliable, reads ALL pages via getFullText
 *   1. pdf.js viewer API  — reads ALL pages from the loaded document
 *   2. DOM text layers    — only currently rendered pages (~3-5)
 */
export async function warmPageTextCache(
  reader: any,
): Promise<CachedPageTextIndex | null> {
  const keys = getReaderCacheKeys(reader);
  const cached = getCachedPageTextIndex(keys);
  if (cached) return cached;
  const cachedTask = getCachedPageTextPromise(keys);
  if (cachedTask) return cachedTask;

  const generation = pageTextCacheGeneration;
  let task: Promise<CachedPageTextIndex | null> | null = null;
  task = (async () => {
    try {
      // Strategy 0: Zotero PDFWorker — ALL pages via getFullText + pageChars
      let extracted = await extractPageTextsFromPdfWorker(reader);
      let coverage: PageTextCacheCoverage = "full-pdfworker";

      // Strategy 1: pdf.js viewer API — ALL pages from viewer iframe
      if (!extracted) {
        ztoolkit.log(
          "LLM quote-locator: PDFWorker unavailable, trying viewer API",
        );
        extracted = await extractPageTextsFromViewer(reader);
        coverage = "full-viewer";
      }

      // Strategy 2: DOM text layer scraping — rendered pages only
      if (!extracted) {
        ztoolkit.log(
          "LLM quote-locator: viewer API unavailable, falling back to DOM text layers",
        );
        const rendered = extractRenderedPageTexts(reader);
        if (rendered.pages.length) {
          extracted = {
            pages: rendered.pages,
            pageCount:
              getPagesCount(getPdfViewerApplication(reader)) || undefined,
          };
          coverage = "partial-dom";
          ztoolkit.log(
            "LLM quote-locator: DOM extracted",
            extracted.pages.length,
            "rendered pages",
          );
        }
      }

      if (!extracted?.pages.length) {
        ztoolkit.log(
          "LLM quote-locator: all extraction strategies failed — no pages",
        );
        return null;
      }

      const result = buildCachedPageTextIndex(
        extracted.pages,
        coverage,
        extracted.pageCount,
        (() => {
          const fingerprint = getPdfDocumentFingerprint(
            getPdfViewerApplication(reader),
          );
          return fingerprint ? `pdfjs:${fingerprint}` : undefined;
        })(),
      );
      if (generation !== pageTextCacheGeneration) return null;
      storeCachedPageTextIndex(keys, result);
      return result;
    } catch (e) {
      ztoolkit.log("LLM quote-locator: warmPageTextCache error:", e);
      return null;
    } finally {
      if (task) clearCachedPageTextPromise(keys, task);
    }
  })();
  storeCachedPageTextPromise(keys, task);
  return task;
}

export async function warmPageTextCacheForAttachment(
  contextItemId: number,
): Promise<CachedPageTextIndex | null> {
  const key = getAttachmentPageTextCacheKey(contextItemId);
  if (!key) return null;
  const keys = [key];
  const cached = getCachedPageTextIndex(keys);
  if (cached) return cached;
  const cachedTask = getCachedPageTextPromise(keys);
  if (cachedTask) return cachedTask;

  const itemId = Math.floor(Number(contextItemId));
  const generation = pageTextCacheGeneration;
  let task: Promise<CachedPageTextIndex | null> | null = null;
  task = (async () => {
    try {
      const extracted = await extractPageTextsFromPdfWorkerItemId(itemId);
      if (!extracted?.pages.length) return null;
      const result = buildCachedPageTextIndex(
        extracted.pages,
        "full-pdfworker",
        extracted.pageCount,
      );
      if (generation !== pageTextCacheGeneration) return null;
      storeCachedPageTextIndex(keys, result);
      return result;
    } catch (e) {
      ztoolkit.log(
        "LLM quote-locator: warmPageTextCacheForAttachment error:",
        e,
      );
      return null;
    } finally {
      if (task) clearCachedPageTextPromise(keys, task);
    }
  })();
  storeCachedPageTextPromise(keys, task);
  return task;
}

export function lookupCachedQuoteLocationForAttachment(
  contextItemId: number,
  quoteText: string,
): HiddenQuoteLocationCacheEntry | null {
  const key = buildHiddenQuoteLocationCacheKey(contextItemId, quoteText);
  if (!key) return null;
  const currentTime = Date.now();
  const record = hiddenQuoteLocationCache.get(key);
  if (!record) return null;
  if (isCacheRecordExpired(currentTime, record)) {
    hiddenQuoteLocationCache.delete(key);
    return null;
  }
  const currentPageText = getCachedPageTextForAttachment(contextItemId);
  if (
    record.entry.sourceFingerprint &&
    currentPageText?.sourceFingerprint &&
    record.entry.sourceFingerprint !== currentPageText.sourceFingerprint
  ) {
    hiddenQuoteLocationCache.delete(key);
    return null;
  }
  record.lastAccessedAt = currentTime;
  record.lastAccessedOrder = nextCacheAccessOrder();
  return record.entry;
}

export async function warmQuoteLocationCacheForAttachment(
  contextItemId: number,
  quoteText: string,
): Promise<HiddenQuoteLocationCacheEntry | null> {
  const key = buildHiddenQuoteLocationCacheKey(contextItemId, quoteText);
  if (!key) return null;
  const cached = lookupCachedQuoteLocationForAttachment(
    contextItemId,
    quoteText,
  );
  if (cached) return cached;
  const existingTask = hiddenQuoteLocationTasks.get(key);
  if (existingTask) return existingTask;

  const itemId = Math.floor(Number(contextItemId));
  const generation = pageTextCacheGeneration;
  let task: Promise<HiddenQuoteLocationCacheEntry | null> | null = null;
  task = (async () => {
    try {
      const pageTextCache = await warmPageTextCacheForAttachment(itemId);
      if (!pageTextCache) return null;
      if (generation !== pageTextCacheGeneration) return null;
      const location = locateQuoteLocationInCachedPages(
        itemId,
        quoteText,
        pageTextCache,
      );
      if (location && generation === pageTextCacheGeneration) {
        rememberHiddenQuoteLocationCacheEntry(key, location);
      }
      return location;
    } catch (e) {
      ztoolkit.log(
        "LLM quote-locator: warmQuoteLocationCacheForAttachment error:",
        e,
      );
      return null;
    } finally {
      if (task && hiddenQuoteLocationTasks.get(key) === task) {
        hiddenQuoteLocationTasks.delete(key);
      }
    }
  })();
  hiddenQuoteLocationTasks.set(key, task);
  return task;
}

/**
 * Resolve a quote against an attachment's complete background text cache
 * without invoking FindController or changing the visible reader state.
 *
 * Unlike `warmQuoteLocationCacheForAttachment()`, this preserves negative and
 * ambiguous outcomes so render-time quote-card verification can distinguish a
 * real search miss from unavailable PDF text.
 */
export async function verifyQuoteLocationForAttachment(
  contextItemId: number,
  quoteText: string,
): Promise<LivePdfSelectionLocateResult> {
  const cleanQuote = stripBoundaryEllipsis(
    sanitizeText(quoteText || "").trim(),
  );
  const normalizedSelection = normalizeLocatorText(cleanQuote);
  const unavailable = (reason: string): LivePdfSelectionLocateResult => ({
    status: "unavailable",
    confidence: "none",
    selectionText: cleanQuote,
    normalizedSelection,
    queryLabel: "Quote",
    expectedPageIndex: null,
    computedPageIndex: null,
    matchedPageIndexes: [],
    totalMatches: 0,
    pagesScanned: 0,
    reason,
  });
  if (!cleanQuote || !normalizedSelection) {
    return unavailable("No quote text was provided.");
  }

  const itemId = Math.floor(Number(contextItemId));
  if (!Number.isFinite(itemId) || itemId <= 0) {
    return unavailable("No searchable PDF attachment was available.");
  }
  const pageTextCache = await warmPageTextCacheForAttachment(itemId);
  if (!pageTextCache) {
    return unavailable(
      "Could not read complete PDF page text for background quote verification.",
    );
  }
  return locateQuoteInCachedPageTexts(pageTextCache, cleanQuote, null);
}

/** Clear cache (e.g. when switching documents). */
export function clearPageTextCache(): void {
  pageTextCacheGeneration += 1;
  pageTextCacheByKey.clear();
  pageTextCachePromisesByKey.clear();
  hiddenQuoteLocationCache.clear();
  hiddenQuoteLocationTasks.clear();
  clearCitationPageCache();
  anonymousReaderKeys = new WeakMap<object, string>();
  anonymousReaderKeySequence = 0;
  cacheAccessSequence = 0;
}

function getPagesCount(app: any): number {
  const candidates = [app?.pagesCount, app?.pdfDocument?.numPages];
  for (const candidate of candidates) {
    const parsed = Number(candidate);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }
  return 0;
}

async function waitForFindControllerReady(
  reader: any,
  timeoutMs = 1200,
): Promise<{ app: any; eventBus: any; findController: any } | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const app = getPdfViewerApplication(reader);
    const eventBus = app?.eventBus;
    const findController = app?.findController;
    if (app?.pdfDocument && eventBus && findController) {
      return { app, eventBus, findController };
    }
    await delay(40);
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleBeforeDeadline<T>(
  promise: Promise<T>,
  deadlineAt: number,
): Promise<{ completed: boolean; value?: T }> {
  const remainingMs = deadlineAt - Date.now();
  if (remainingMs <= 0) return { completed: false };
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then((value) => ({ completed: true, value })),
      new Promise<{ completed: false }>((resolve) => {
        timeoutId = setTimeout(
          () => resolve({ completed: false }),
          remainingMs,
        );
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

function parsePositiveInteger(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function getFindControllerMatchCount(findController: any): number {
  const candidates = [
    findController?.matchesCount?.total,
    findController?._matchesCount?.total,
    findController?._matchesCountTotal,
  ];
  for (const candidate of candidates) {
    const parsed = parsePositiveInteger(candidate);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function getFindControllerQuery(findController: any): string | undefined {
  const rawQuery =
    findController?._rawQuery ??
    findController?._state?.query ??
    findController?.state?.query ??
    findController?._query ??
    findController?.query;
  return rawQuery === undefined ? undefined : String(rawQuery);
}

type FindControllerSearchSnapshot = {
  matchCount: number;
  pageMatches: unknown;
  pageMatchesLength: number;
  query: string | undefined;
  selectedPageIndex: number | null;
  selectedMatchIndex: number | null;
};

function getFindControllerPageMatchesValue(findController: any): unknown {
  return findController?.pageMatches ?? findController?._pageMatches;
}

function getArrayLikeLength(value: unknown): number {
  const rawLength =
    value != null && typeof (value as any).length === "number"
      ? Number((value as any).length)
      : 0;
  return Number.isFinite(rawLength) && rawLength > 0
    ? Math.floor(rawLength)
    : 0;
}

function normalizeZeroBasedPageIndex(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

function normalizeOneBasedPageNumber(value: unknown): number | null {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return null;
  return Math.floor(parsed) - 1;
}

function getFindControllerSelectedPageIndex(
  findController: any,
): number | null {
  const selectedCandidates = [
    findController?.selected,
    findController?._selected,
    findController?.offset,
    findController?._offset,
  ];
  for (const selected of selectedCandidates) {
    const pageIndex = normalizeZeroBasedPageIndex(
      selected?.pageIdx ?? selected?.pageIndex,
    );
    if (pageIndex !== null) return pageIndex;

    const pageNumber = normalizeOneBasedPageNumber(
      selected?.pageNumber ?? selected?.page,
    );
    if (pageNumber !== null) return pageNumber;
  }

  return null;
}

function getFindControllerSelectedMatchIndex(
  findController: any,
): number | null {
  const selectedCandidates = [
    findController?.selected,
    findController?._selected,
    findController?.offset,
    findController?._offset,
  ];
  for (const selected of selectedCandidates) {
    const matchIndex = normalizeZeroBasedPageIndex(
      selected?.matchIdx ?? selected?.matchIndex,
    );
    if (matchIndex !== null) return matchIndex;
  }
  return null;
}

function captureFindControllerSearchSnapshot(
  findController: any,
): FindControllerSearchSnapshot {
  const pageMatches = getFindControllerPageMatchesValue(findController);
  return {
    matchCount: getFindControllerMatchCount(findController),
    pageMatches,
    pageMatchesLength: getArrayLikeLength(pageMatches),
    query: getFindControllerQuery(findController),
    selectedPageIndex: getFindControllerSelectedPageIndex(findController),
    selectedMatchIndex: getFindControllerSelectedMatchIndex(findController),
  };
}

function didFindControllerSearchStateChange(
  findController: any,
  snapshot: FindControllerSearchSnapshot,
): boolean {
  const pageMatches = getFindControllerPageMatchesValue(findController);
  return (
    pageMatches !== snapshot.pageMatches ||
    getArrayLikeLength(pageMatches) !== snapshot.pageMatchesLength ||
    getFindControllerMatchCount(findController) !== snapshot.matchCount ||
    getFindControllerSelectedPageIndex(findController) !==
      snapshot.selectedPageIndex ||
    getFindControllerSelectedMatchIndex(findController) !==
      snapshot.selectedMatchIndex
  );
}

async function waitForFindControllerSearchAcceptance(
  findController: any,
  expectedQuery: string,
  snapshot: FindControllerSearchSnapshot,
  timeoutMs = 320,
): Promise<number | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const rawQuery = getFindControllerQuery(findController);
    if (rawQuery === expectedQuery) {
      return Date.now() - startedAt;
    }
    if (
      rawQuery === undefined &&
      didFindControllerSearchStateChange(findController, snapshot)
    ) {
      return Date.now() - startedAt;
    }
    await delay(20);
  }

  const rawQuery = getFindControllerQuery(findController);
  return rawQuery === expectedQuery ||
    (rawQuery === undefined &&
      didFindControllerSearchStateChange(findController, snapshot))
    ? Date.now() - startedAt
    : null;
}

async function waitForFindControllerPageMatches(
  findController: any,
  pagesCount: number,
  expectedQuery: string,
  timeoutMs = 2000,
): Promise<unknown[]> {
  const startedAt = Date.now();
  let latestMatches: unknown[] = [];
  let queryConfirmed = false;
  let confirmedFromRawQuery = false;

  while (Date.now() - startedAt < timeoutMs) {
    // Verify the FindController is processing our query.
    // _rawQuery is a private property that may not exist in all PDF.js
    // forks (e.g. Zotero's bundled version).  When it's undefined we
    // fall back to a short grace period before reading results.
    if (!queryConfirmed) {
      const rawQuery = getFindControllerQuery(findController);
      if (rawQuery !== undefined && String(rawQuery) === expectedQuery) {
        queryConfirmed = true;
        confirmedFromRawQuery = true;
      } else if (rawQuery !== undefined) {
        // _rawQuery exists but holds a different query → wait for ours
        await delay(25);
        continue;
      } else {
        // _rawQuery is undefined — property doesn't exist in this build.
        // Allow a brief grace period for the find event to be processed.
        if (Date.now() - startedAt < 250) {
          await delay(25);
          continue;
        }
        queryConfirmed = true;
      }
    }

    // Use an array-like length check instead of Array.isArray so that
    // cross-realm arrays (created in the PDF viewer's content window) are
    // correctly recognised in Firefox's privileged extension context.
    const rawMatches =
      findController?.pageMatches ?? findController?._pageMatches;
    const pageMatches: unknown[] =
      rawMatches != null && typeof (rawMatches as any).length === "number"
        ? (rawMatches as unknown[])
        : [];
    if (pageMatches.length > latestMatches.length) {
      latestMatches = pageMatches;
    }
    const pendingSize =
      typeof findController?._pendingFindMatches?.size === "number"
        ? findController._pendingFindMatches.size
        : 0;
    const pagesToSearch = Number.isFinite(findController?._pagesToSearch)
      ? Number(findController._pagesToSearch)
      : null;
    const canTrustEmptyCompletion =
      latestMatches.length > 0 ||
      confirmedFromRawQuery ||
      Date.now() - startedAt > 700;
    if (
      (pageMatches.length >= pagesCount || pagesToSearch === 0) &&
      pendingSize === 0 &&
      canTrustEmptyCompletion
    ) {
      return pageMatches;
    }

    // Early bail-out: if the FindController has not produced any results
    // after a longer grace period, the search mechanism is likely non-functional.
    // Zotero's embedded reader can take noticeably longer than stock PDF.js to
    // populate pageMatches right after a page navigation.
    if (Date.now() - startedAt > 1400 && latestMatches.length === 0) {
      return latestMatches;
    }
    await delay(50);
  }
  return latestMatches;
}

function summarizeFindControllerMatches(pageMatches: unknown[]): {
  matchedPageIndexes: number[];
  totalMatches: number;
  pageMatchCounts: number[];
} {
  const matchedPageIndexes: number[] = [];
  const pageMatchCounts: number[] = [];
  let totalMatches = 0;
  for (let pageIndex = 0; pageIndex < pageMatches.length; pageIndex += 1) {
    // Cross-realm compatible: use array-like length check instead of Array.isArray.
    const rawEntry = pageMatches[pageIndex];
    const matchCount =
      rawEntry != null && typeof (rawEntry as any).length === "number"
        ? Number((rawEntry as any).length)
        : 0;
    if (!matchCount) continue;
    matchedPageIndexes.push(pageIndex);
    pageMatchCounts[pageIndex] = matchCount;
    totalMatches += matchCount;
  }
  return { matchedPageIndexes, totalMatches, pageMatchCounts };
}

async function searchFindControllerForQuery(
  reader: any,
  query: string,
  options?: { matchTimeoutMs?: number; deadlineAt?: number },
): Promise<FindControllerSearchResult | null> {
  const app = getPdfViewerApplication(reader);
  const findController = app?.findController;
  const pagesCount = getPagesCount(app);
  if (!findController || pagesCount < 1) {
    return null;
  }

  // ---------------------------------------------------------------------------
  // Strategy: literally automate Ctrl+F by setting the find bar's input value
  // and dispatching a DOM input event.  This is exactly what happens when a
  // user presses Ctrl+F, types a query, and the PDF viewer finds + scrolls.
  // ---------------------------------------------------------------------------
  const findBar = app?.findBar;
  const findField: HTMLInputElement | null =
    findBar?._findField ?? findBar?.findField ?? null;
  const previousSearchSnapshot =
    captureFindControllerSearchSnapshot(findController);
  const previousQuery = previousSearchSnapshot.query;
  const previousMatchCount = previousSearchSnapshot.matchCount;
  const previousSelectedPage = previousSearchSnapshot.selectedPageIndex;
  const dispatchStartedAt = Date.now();

  let shouldRunCommandFallback = true;
  let acceptanceMs: number | null = null;

  if (findField) {
    try {
      // Ensure the find bar is open (required for the search to activate).
      if (typeof findBar?.open === "function") {
        findBar.open();
      }

      // Set the query text — equivalent to the user typing in the search box.
      findField.value = query;

      // Dispatch an InputEvent in the *content window's* context so that
      // Firefox's security boundaries don't swallow it.
      const contentWin: any = findField.ownerDocument?.defaultView;
      const EventCtor: typeof InputEvent =
        contentWin?.InputEvent ?? contentWin?.Event ?? InputEvent;
      findField.dispatchEvent(
        new EventCtor("input", { bubbles: true } as EventInit),
      );
      const findFieldAcceptanceMs = await waitForFindControllerSearchAcceptance(
        findController,
        query,
        previousSearchSnapshot,
      );
      shouldRunCommandFallback = findFieldAcceptanceMs === null;
      if (findFieldAcceptanceMs !== null) {
        acceptanceMs = Date.now() - dispatchStartedAt;
      }
    } catch (err) {
      ztoolkit.log(
        "LLM paragraph-jump: find-bar input approach failed, will try eventBus",
        err,
      );
    }
  }

  // Fallback: direct eventBus / executeCommand dispatch (may not work in all
  // Zotero builds, but costs nothing to try).
  if (shouldRunCommandFallback) {
    const eventBus = app?.eventBus;
    if (!eventBus && typeof findController.executeCommand !== "function") {
      return null;
    }
    const findState = {
      source: findBar ?? { source: "llm-live-quote-locator" },
      type: "",
      query,
      phraseSearch: true,
      caseSensitive: false,
      entireWord: false,
      highlightAll: true,
      findPrevious: false,
      matchDiacritics: false,
    };
    try {
      if (typeof findBar?.open === "function") findBar.open();
    } catch {
      /* ignore */
    }
    let dispatched = false;
    try {
      if (typeof findController.executeCommand === "function") {
        findController.executeCommand("find", findState);
        dispatched = true;
      }
    } catch {
      dispatched = false;
    }
    if (!dispatched && eventBus) {
      eventBus.dispatch("find", findState);
    }
    const commandAcceptanceMs = await waitForFindControllerSearchAcceptance(
      findController,
      query,
      previousSearchSnapshot,
    );
    if (commandAcceptanceMs !== null) {
      acceptanceMs = Date.now() - dispatchStartedAt;
    }
  }

  // Wait for the FindController to process and populate results.
  // Use waitForFindControllerPageMatches first (reads pageMatches array),
  // then fall back to reading matchesCount (what the find-bar "1/1" uses).
  const pageMatches = await waitForFindControllerPageMatches(
    findController,
    pagesCount,
    query,
    Math.max(
      50,
      Math.min(
        Math.floor(options?.matchTimeoutMs ?? 2000),
        options?.deadlineAt
          ? Math.max(50, options.deadlineAt - Date.now())
          : Number.MAX_SAFE_INTEGER,
      ),
    ),
  );
  const result = {
    ...summarizeFindControllerMatches(pageMatches),
    pagesCount,
    selectedPageIndex: null as number | null,
    selectedMatchIndex: null as number | null,
    acceptanceMs:
      acceptanceMs ??
      (getFindControllerQuery(findController) === query
        ? Date.now() - dispatchStartedAt
        : 0),
  };
  const selectedPageAfterSearch =
    getFindControllerSelectedPageIndex(findController);
  const currentQueryAfterSearch = getFindControllerQuery(findController);
  const queryConfirmedAfterSearch = currentQueryAfterSearch === query;
  if (
    queryConfirmedAfterSearch &&
    selectedPageAfterSearch !== null &&
    result.matchedPageIndexes.includes(selectedPageAfterSearch)
  ) {
    result.selectedPageIndex = selectedPageAfterSearch;
    result.selectedMatchIndex =
      getFindControllerSelectedMatchIndex(findController);
  }

  // Fallback: if pageMatches reading returned 0 (cross-realm array issues or
  // different property name in this PDF.js build), check the FindController's
  // own matchesCount — this is the same value the find bar uses to show "1/1".
  if (result.totalMatches === 0) {
    const fcTotal = getFindControllerMatchCount(findController);
    if (fcTotal > 0) {
      const selectedPage = getFindControllerSelectedPageIndex(findController);
      const currentQuery = getFindControllerQuery(findController);
      const queryConfirmed = currentQuery === query;
      const matchStateChanged =
        fcTotal !== previousMatchCount || selectedPage !== previousSelectedPage;
      result.totalMatches = fcTotal;
      if (
        selectedPage !== null &&
        queryConfirmed &&
        (matchStateChanged || previousQuery === query)
      ) {
        result.selectedPageIndex = selectedPage;
        result.selectedMatchIndex =
          getFindControllerSelectedMatchIndex(findController);
        result.matchedPageIndexes = [selectedPage];
        result.pageMatchCounts = [];
        result.pageMatchCounts[selectedPage] = fcTotal;
      }
    }
  }

  return result;
}

export type PageNativeFindControllerQuery = {
  query: string;
  occurrenceIndex: number;
  totalOccurrences: number;
};

type PageNativeFindControllerSourceMatch = PageNativeFindControllerQuery & {
  matchKind: QuoteTextSearchQueryKind;
  quoteTokenCoverage: number;
};

export function buildPageNativeFindControllerPageText(
  items: ArrayLike<{ str?: unknown; hasEOL?: unknown }>,
): string {
  const parts: string[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (index > 0) parts.push(PDF_TEXT_ITEM_BOUNDARY);
    parts.push(String(item?.str || ""));
    if (item?.hasEOL) parts.push("\n");
  }
  return parts.join("");
}

function normalizePageNativeFindControllerLiteral(
  sourceText: string,
  _quoteText: string,
): string {
  return sourceText
    .split(PDF_TEXT_ITEM_BOUNDARY)
    .join("")
    .replace(/(\p{Ll})[-‐‑‒–—−]\s*\r?\n\s*(?=\p{Ll})/gu, "$1")
    .replace(/(\p{Lu})[-‐‑‒–—−]\s*\r?\n\s*(?=\p{L})/gu, "$1")
    .replace(/(\S)[-‐‑‒–—−]\s*\r?\n\s*/gu, "$1-")
    .replace(
      /([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}])\r?\n/gu,
      "$1",
    )
    .replace(/\r\n?|\n/g, " ");
}

export function normalizePageNativeFindControllerComparableText(
  value: string,
): string {
  return normalizeLocatorText(
    normalizePageNativeFindControllerLiteral(value, ""),
  );
}

export function resolvePageNativeFindControllerQuery(
  pageText: string,
  quoteText: string,
  requestedOccurrence?: number,
  normalizationHintText?: string,
): PageNativeFindControllerQuery | null {
  const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
    buildQuoteTextIndex(pageText),
    quoteText,
  );
  if (!spans.length) return null;
  const normalizedOccurrence =
    Number.isFinite(requestedOccurrence) && Number(requestedOccurrence) >= 0
      ? Math.floor(Number(requestedOccurrence))
      : undefined;
  if (normalizedOccurrence === undefined && spans.length > 1) return null;
  const selected =
    spans[normalizedOccurrence === undefined ? 0 : normalizedOccurrence];
  if (!selected?.text) return null;
  const literalQuery = normalizePageNativeFindControllerLiteral(
    selected.text,
    normalizationHintText || quoteText,
  );
  if (!literalQuery) return null;
  return {
    query: literalQuery,
    occurrenceIndex: selected.occurrenceIndex,
    totalOccurrences: spans.length,
  };
}

function resolveLargestUniquePageNativeSourceMatch(
  pageText: string,
  quoteText: string,
  normalizationHintText?: string,
): PageNativeFindControllerSourceMatch | null {
  const sourceMatch = findLargestUniqueQuoteTextAnchorMatch(
    [
      {
        id: "live-page",
        text: pageText,
      },
    ],
    quoteText,
    {
      minQueryLength: 24,
      rejectWeakQueries: true,
    },
  );
  if (!sourceMatch || sourceMatch.matchKind === "exact") return null;
  const resolved = resolvePageNativeFindControllerQuery(
    pageText,
    sourceMatch.query,
    undefined,
    normalizationHintText || quoteText,
  );
  return resolved
    ? {
        ...resolved,
        matchKind: sourceMatch.matchKind,
        quoteTokenCoverage: sourceMatch.quoteTokenCoverage,
      }
    : null;
}

const PAGE_NATIVE_MATH_GAP_PATTERN = /[=<>+*/^_\\{}$()[\]≤≥≈≠∑∏√∞∫−]/u;
const PAGE_NATIVE_LATIN_PROSE_TOKEN_PATTERN = /^[\p{Script=Latin}\p{M}'’-]+$/u;
const PAGE_NATIVE_CJK_PROSE_TOKEN_PATTERN =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u;

function pageNativeProseTokenClass(value: string): "latin" | "cjk" | null {
  if (PAGE_NATIVE_LATIN_PROSE_TOKEN_PATTERN.test(value)) return "latin";
  if (PAGE_NATIVE_CJK_PROSE_TOKEN_PATTERN.test(value)) return "cjk";
  return null;
}

function resolvePageNativeFallbackAfterCompleteSearchFailure(
  pageText: string,
  quoteText: string,
  requestedOccurrence?: number,
  normalizationHintText?: string,
): PageNativeFindControllerSourceMatch | null {
  const pageIndex = buildQuoteTextIndex(pageText);
  const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
    pageIndex,
    quoteText,
  );
  const normalizedOccurrence =
    Number.isFinite(requestedOccurrence) && Number(requestedOccurrence) >= 0
      ? Math.floor(Number(requestedOccurrence))
      : undefined;
  if (normalizedOccurrence === undefined && spans.length !== 1) return null;
  const selected =
    spans[normalizedOccurrence === undefined ? 0 : normalizedOccurrence];
  if (!selected?.text) return null;

  const selectedIndex = buildQuoteTextIndex(selected.text);
  const quoteTokenCount = buildQuoteTextIndex(quoteText).tokens.length;
  if (selectedIndex.tokens.length < 4 || quoteTokenCount < 4) return null;

  type ProseRun = {
    tokenStart: number;
    tokenEnd: number;
    sourceStart: number;
    sourceEnd: number;
  };
  const proseRuns: ProseRun[] = [];
  let activeRun: (ProseRun & { tokenClass: "latin" | "cjk" }) | null = null;
  for (let index = 0; index < selectedIndex.tokens.length; index += 1) {
    const token = selectedIndex.tokens[index];
    const sourceToken = selectedIndex.sourceText.slice(
      token.sourceStart,
      token.sourceEnd,
    );
    const tokenClass = pageNativeProseTokenClass(sourceToken);
    const gap =
      activeRun && index > 0
        ? selectedIndex.sourceText.slice(
            selectedIndex.tokens[index - 1].sourceEnd,
            token.sourceStart,
          )
        : "";
    const canExtend = Boolean(
      activeRun &&
      tokenClass === activeRun.tokenClass &&
      !PAGE_NATIVE_MATH_GAP_PATTERN.test(gap),
    );
    if (!tokenClass) {
      if (activeRun) proseRuns.push(activeRun);
      activeRun = null;
      continue;
    }
    if (canExtend && activeRun) {
      activeRun.tokenEnd = index + 1;
      activeRun.sourceEnd = token.sourceEnd;
      continue;
    }
    if (activeRun) proseRuns.push(activeRun);
    activeRun = {
      tokenStart: index,
      tokenEnd: index + 1,
      sourceStart: token.sourceStart,
      sourceEnd: token.sourceEnd,
      tokenClass,
    };
  }
  if (activeRun) proseRuns.push(activeRun);

  const fullRun = proseRuns.find(
    (run) =>
      run.tokenStart === 0 && run.tokenEnd === selectedIndex.tokens.length,
  );
  if (fullRun && selectedIndex.tokens.length > 4) {
    const prefixLast = selectedIndex.tokens[selectedIndex.tokens.length - 2];
    const suffixFirst = selectedIndex.tokens[1];
    proseRuns.push(
      {
        tokenStart: 0,
        tokenEnd: selectedIndex.tokens.length - 1,
        sourceStart: selectedIndex.tokens[0].sourceStart,
        sourceEnd: prefixLast.sourceEnd,
      },
      {
        tokenStart: 1,
        tokenEnd: selectedIndex.tokens.length,
        sourceStart: suffixFirst.sourceStart,
        sourceEnd:
          selectedIndex.tokens[selectedIndex.tokens.length - 1].sourceEnd,
      },
    );
  }

  const candidates = proseRuns
    .filter(
      (run) =>
        run.tokenEnd - run.tokenStart >= 4 &&
        !(fullRun === run && run.tokenEnd === selectedIndex.tokens.length),
    )
    .map((run) => {
      const text = selectedIndex.sourceText
        .slice(run.sourceStart, run.sourceEnd)
        .trim();
      const normalizedText = normalizeLocatorText(text);
      return {
        ...run,
        text,
        normalizedText,
      };
    })
    .filter(
      (candidate) =>
        candidate.normalizedText.length >= 24 &&
        findQuoteSourceSpansAllowingLayoutArtifacts(pageIndex, candidate.text)
          .length === 1,
    )
    .sort(
      (left, right) =>
        right.tokenEnd - right.tokenStart - (left.tokenEnd - left.tokenStart) ||
        right.normalizedText.length - left.normalizedText.length ||
        left.tokenStart - right.tokenStart,
    );
  const candidate = candidates[0];
  if (!candidate) return null;
  const resolved = resolvePageNativeFindControllerQuery(
    pageText,
    candidate.text,
    undefined,
    normalizationHintText || quoteText,
  );
  if (!resolved) return null;
  return {
    ...resolved,
    matchKind:
      candidate.tokenStart === 0
        ? "raw-prefix"
        : candidate.tokenEnd === selectedIndex.tokens.length
          ? "raw-suffix"
          : "raw-middle",
    quoteTokenCoverage: Math.min(
      1,
      (candidate.tokenEnd - candidate.tokenStart) / quoteTokenCount,
    ),
  };
}

type FindControllerUserState = {
  query: string;
  state: Record<string, unknown> | null;
  findFieldValue: string;
  findBarWasOpen: boolean | null;
  selectedPageIndex: number | null;
  selectedMatchIndex: number | null;
  matchCount: number;
};

function getFindBarOpenState(findBar: any): boolean | null {
  for (const candidate of [
    findBar?.opened,
    findBar?._opened,
    findBar?.isOpen,
  ]) {
    if (typeof candidate === "boolean") return candidate;
  }
  const barElement =
    findBar?._findbar ?? findBar?._bar ?? findBar?.bar ?? findBar?.element;
  if (barElement?.classList?.contains) {
    return !barElement.classList.contains("hidden");
  }
  return null;
}

function captureFindControllerUserState(app: any): FindControllerUserState {
  const findController = app?.findController;
  const findBar = app?.findBar;
  const findField: HTMLInputElement | null =
    findBar?._findField ?? findBar?.findField ?? null;
  const rawState = findController?.state ?? findController?._state;
  return {
    query: getFindControllerQuery(findController) || "",
    state:
      rawState && typeof rawState === "object"
        ? { ...(rawState as Record<string, unknown>) }
        : null,
    findFieldValue: String(findField?.value || ""),
    findBarWasOpen: getFindBarOpenState(findBar),
    selectedPageIndex: getFindControllerSelectedPageIndex(findController),
    selectedMatchIndex: getFindControllerSelectedMatchIndex(findController),
    matchCount: getFindControllerMatchCount(findController),
  };
}

function dispatchFindFieldInput(findField: HTMLInputElement): void {
  const contentWin: any = findField.ownerDocument?.defaultView;
  const EventCtor: typeof InputEvent =
    contentWin?.InputEvent ?? contentWin?.Event ?? InputEvent;
  findField.dispatchEvent(
    new EventCtor("input", { bubbles: true } as EventInit),
  );
}

async function restoreFindControllerUserState(
  app: any,
  previous: FindControllerUserState,
): Promise<void> {
  const findController = app?.findController;
  const eventBus = app?.eventBus;
  const findBar = app?.findBar;
  const findField: HTMLInputElement | null =
    findBar?._findField ?? findBar?.findField ?? null;
  const query = previous.query || previous.findFieldValue;
  try {
    const restoreSnapshot = captureFindControllerSearchSnapshot(findController);
    if (findField) {
      findField.value = query;
      dispatchFindFieldInput(findField);
    } else if (eventBus && previous.state) {
      eventBus.dispatch("find", {
        ...previous.state,
        source: findBar ?? { source: "llm-live-quote-locator" },
        type: "",
        query,
      });
    } else if (query && typeof findController?.executeCommand === "function") {
      findController.executeCommand("find", {
        ...(previous.state || {}),
        query,
      });
    }
    if (
      query &&
      previous.matchCount > 0 &&
      previous.selectedPageIndex !== null &&
      previous.selectedMatchIndex !== null
    ) {
      await waitForFindControllerSearchAcceptance(
        findController,
        query,
        restoreSnapshot,
      );
      const pageMatches = await waitForFindControllerPageMatches(
        findController,
        getPagesCount(app),
        query,
        800,
      );
      const summary = summarizeFindControllerMatches(pageMatches);
      const pageMatchCount =
        summary.pageMatchCounts[previous.selectedPageIndex] || 0;
      if (pageMatchCount > 0) {
        await selectNativeFindControllerMatch({
          app,
          pageIndex: previous.selectedPageIndex,
          occurrenceIndex: previous.selectedMatchIndex,
          totalMatches: summary.totalMatches,
          pageMatchCount,
          deadlineAt: Date.now() + 800,
        });
      }
    }
    if (!query) {
      eventBus?.dispatch?.("findbarclose", {
        source: findBar ?? { source: "llm-live-quote-locator" },
      });
    }
    if (
      previous.findBarWasOpen === false &&
      typeof findBar?.close === "function"
    ) {
      findBar.close();
    }
  } catch (error) {
    ztoolkit.log("LLM paragraph-jump: could not restore prior find state", {
      error,
    });
  }
}

function getPdfDocumentFingerprint(app: any): string | undefined {
  const fingerprints = app?.pdfDocument?.fingerprints;
  const value =
    fingerprints != null && typeof fingerprints.length === "number"
      ? fingerprints[0]
      : undefined;
  const normalized = String(value || "").trim();
  return normalized || undefined;
}

async function extractFindControllerPageText(
  app: any,
  pageIndex: number,
): Promise<string | null> {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return null;

  const documents: any[] = [];
  const seenDocuments = new Set<any>();
  for (const candidate of [
    unwrapGeckoJsObject(app?.pdfDocument),
    app?.pdfDocument,
    unwrapGeckoJsObject(app?.findController?._pdfDocument),
    app?.findController?._pdfDocument,
  ]) {
    if (!candidate || seenDocuments.has(candidate)) continue;
    seenDocuments.add(candidate);
    documents.push(candidate);
  }

  for (const pdfDocument of documents) {
    if (typeof pdfDocument?.getPage !== "function") continue;
    try {
      const page = unwrapGeckoJsObject(
        await pdfDocument.getPage(Math.floor(pageIndex) + 1),
      );
      if (typeof page?.getTextContent !== "function") continue;
      let textContent: any;
      try {
        textContent = await page.getTextContent({
          disableNormalization: true,
        });
      } catch (optionsError) {
        // Some Gecko compartments reject a chrome-realm options object even
        // though the same PDFDocumentProxy method works without arguments.
        // The page still comes from the live PDF.js document; retrying keeps
        // navigation available while the offset-preserving aligner handles
        // any normalization differences.
        logFindControllerDiagnostic(
          "LLM paragraph-jump: retrying PDF.js text extraction without cross-realm options",
          {
            pageIndex,
            error: optionsError,
          },
        );
        textContent = await page.getTextContent();
      }
      const unwrappedTextContent = unwrapGeckoJsObject(textContent);
      const items =
        unwrappedTextContent?.items != null &&
        typeof unwrappedTextContent.items.length === "number"
          ? unwrappedTextContent.items
          : [];
      const unwrappedItems: Array<{ str?: unknown; hasEOL?: unknown }> = [];
      for (let index = 0; index < items.length; index += 1) {
        unwrappedItems.push(unwrapGeckoJsObject(items[index]));
      }
      const text = buildPageNativeFindControllerPageText(unwrappedItems);
      if (text) return text;
    } catch (error) {
      logFindControllerDiagnostic(
        "LLM paragraph-jump: PDF.js page text extraction failed",
        {
          pageIndex,
          error,
        },
      );
    }
  }
  return null;
}

function hashFindControllerQuery(query: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < query.length; index += 1) {
    hash ^= query.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function findControllerQueryDiagnostic(query: string): string {
  return `Full query length=${query.length} hash=${hashFindControllerQuery(query)}`;
}

function logFindControllerDiagnostic(
  message: string,
  details: Record<string, unknown>,
): void {
  if (typeof ztoolkit !== "undefined") {
    ztoolkit.log(message, details);
  }
}

async function waitForFindControllerSelectionChange(
  findController: any,
  previousPageIndex: number | null,
  previousMatchIndex: number | null,
  timeoutMs = 400,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (
      getFindControllerSelectedPageIndex(findController) !==
        previousPageIndex ||
      getFindControllerSelectedMatchIndex(findController) !== previousMatchIndex
    ) {
      return;
    }
    await delay(20);
  }
}

async function selectNativeFindControllerMatch(params: {
  app: any;
  pageIndex: number;
  occurrenceIndex: number;
  totalMatches: number;
  pageMatchCount: number;
  deadlineAt: number;
}): Promise<boolean> {
  const findController = params.app?.findController;
  const eventBus = params.app?.eventBus;
  if (!findController || !eventBus) return false;

  const isSelected = (): boolean => {
    const selectedPageIndex =
      getFindControllerSelectedPageIndex(findController);
    const selectedMatchIndex =
      getFindControllerSelectedMatchIndex(findController);
    if (selectedPageIndex !== params.pageIndex) return false;
    if (params.pageMatchCount <= 1) return true;
    return selectedMatchIndex === params.occurrenceIndex;
  };
  if (isSelected()) return true;

  for (
    let attempt = 0;
    attempt < Math.max(1, params.totalMatches) &&
    Date.now() < params.deadlineAt;
    attempt += 1
  ) {
    const previousPageIndex =
      getFindControllerSelectedPageIndex(findController);
    const previousMatchIndex =
      getFindControllerSelectedMatchIndex(findController);
    const state = findController?.state ?? findController?._state ?? {};
    eventBus.dispatch("find", {
      ...state,
      source: params.app?.findBar ?? { source: "llm-live-quote-locator" },
      type: "again",
      findPrevious: false,
    });
    await waitForFindControllerSelectionChange(
      findController,
      previousPageIndex,
      previousMatchIndex,
      Math.min(400, Math.max(20, params.deadlineAt - Date.now())),
    );
    if (isSelected()) return true;
  }
  return false;
}

export async function locateCurrentSelectionInLivePdfReader(
  reader: any,
  selectionText: string,
): Promise<LivePdfSelectionLocateResult> {
  const cleanSelection = sanitizeText(selectionText || "").trim();
  if (!cleanSelection) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanSelection,
      normalizedSelection: "",
      queryLabel: "Selection",
      expectedPageIndex: null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: "No live reader selection was available.",
    };
  }

  try {
    const domResolved = locateCurrentSelectionFromDom(reader, cleanSelection);
    if (domResolved) {
      return domResolved;
    }

    const { pages, expectedPageIndex } = extractRenderedPageTexts(reader);
    if (!pages.length) {
      return {
        status: "unavailable",
        confidence: "none",
        selectionText: cleanSelection,
        normalizedSelection: normalizeLocatorText(cleanSelection),
        queryLabel: "Selection",
        expectedPageIndex,
        computedPageIndex: null,
        matchedPageIndexes: [],
        totalMatches: 0,
        pagesScanned: 0,
        reason:
          "The active reader did not expose a live selection page or rendered page text.",
      };
    }

    const result = locateSelectionInPageTexts(
      pages,
      cleanSelection,
      expectedPageIndex,
      {
        queryLabel: "Selection",
      },
    );
    if (result.status === "resolved" && result.reason) {
      return {
        ...result,
        reason: `${result.reason} This was matched against the currently rendered live reader pages.`,
      };
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanSelection,
      normalizedSelection: normalizeLocatorText(cleanSelection),
      queryLabel: "Selection",
      expectedPageIndex: getExpectedPageIndex(
        reader,
        getPdfViewerApplication(reader),
      ),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live reader locator failed: ${message}`,
    };
  }
}

export async function locateQuoteInLivePdfReader(
  reader: any,
  quoteText: string,
  _options?: { skipFindController?: boolean; exactOnly?: boolean },
): Promise<LivePdfSelectionLocateResult> {
  const cleanQuote = stripBoundaryEllipsis(
    sanitizeText(quoteText || "").trim(),
  );
  if (!cleanQuote) {
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: "",
      queryLabel: "Quote",
      expectedPageIndex: null,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: "No quote text was provided.",
    };
  }

  try {
    const cached = await warmPageTextCache(reader);
    const expectedPageIndex = getExpectedPageIndex(
      reader,
      getPdfViewerApplication(reader),
    );
    if (!cached?.pages.length) {
      return {
        status: "unavailable",
        confidence: "none",
        selectionText: cleanQuote,
        normalizedSelection: normalizeLocatorText(cleanQuote),
        queryLabel: "Quote",
        expectedPageIndex,
        computedPageIndex: null,
        matchedPageIndexes: [],
        totalMatches: 0,
        pagesScanned: 0,
        reason: "Could not read complete PDF page text from the active reader.",
      };
    }
    const cachedResult = locateQuoteInCachedPageTexts(
      cached,
      cleanQuote,
      expectedPageIndex,
    );
    if (
      cachedResult.status === "resolved" &&
      canUseCachedPageTextAsNegativeEvidence(cached)
    ) {
      return cachedResult;
    }

    // Zotero's indexed PDFWorker text and a prematurely warmed DOM cache can
    // differ from the text currently searched by PDF.js FindController.
    // Before accepting a negative/ambiguous result or a partial-cache result,
    // rebuild from the loaded PDF.js document and apply the same locator there.
    // Only this live-viewer pass is conclusive enough to mark a quote
    // unsearchable; a cache/readiness miss must remain retryable.
    const liveViewerCache = await refreshPageTextCacheFromLiveViewer(reader);
    if (liveViewerCache) {
      return locateQuoteInCachedPageTexts(
        liveViewerCache,
        cleanQuote,
        expectedPageIndex,
      );
    }
    if (cachedResult.status === "resolved") return cachedResult;
    return {
      ...cachedResult,
      status: "unavailable",
      confidence: "none",
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      reason:
        "Could not verify the quote against the loaded PDF.js text. The cached result is not conclusive.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: normalizeLocatorText(cleanQuote),
      queryLabel: "Quote",
      expectedPageIndex: getExpectedPageIndex(
        reader,
        getPdfViewerApplication(reader),
      ),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live quote locator failed: ${message}`,
    };
  }
}

async function runPageNativeFindControllerJump(
  reader: any,
  quoteText: string,
  options?: {
    citationId?: string;
    expectedPageIndex?: number | null;
    sourceFingerprint?: string;
    sourceMatchPageOccurrence?: number;
    deadlineAt?: number;
    queryRole?: "displayed-quote" | "source-locator";
    normalizationHintText?: string;
    requireUniqueMatch?: boolean;
    highlightCoverage?: number;
    allowDerivedPartialAfterSearchFailure?: boolean;
  },
): Promise<ExactQuoteJumpResult> {
  const startedAt = Date.now();
  let diagnosticQuery = sanitizeText(quoteText || "");
  let normalizationResult = "not-attempted";
  const findControllerDiagnosticState: {
    acceptanceMs?: number;
    matchCount?: number;
  } = {};
  const ready = await waitForFindControllerReady(reader);
  const readyAt = Date.now();
  const localDeadlineAt = readyAt + FIND_CONTROLLER_NAVIGATION_DEADLINE_MS;
  const deadlineAt = Math.min(
    localDeadlineAt,
    Number.isFinite(options?.deadlineAt)
      ? Number(options?.deadlineAt)
      : localDeadlineAt,
  );
  const app = ready?.app ?? getPdfViewerApplication(reader);
  const findController = ready?.findController ?? app?.findController;
  const expectedPageIndex =
    options &&
    Object.prototype.hasOwnProperty.call(options, "expectedPageIndex")
      ? Number.isFinite(options.expectedPageIndex) &&
        Number(options.expectedPageIndex) >= 0
        ? Math.floor(Number(options.expectedPageIndex))
        : null
      : getExpectedPageIndex(reader, app);
  const failure = (
    failureStage: NonNullable<ExactQuoteJumpResult["failureStage"]>,
    reason: string,
    debugSummary: string[] = [],
    queries: ExactQuoteJumpQueryAttempt[] = [],
  ): ExactQuoteJumpResult => {
    logFindControllerDiagnostic(
      "LLM citation FindController exact match failed",
      {
        citationId: options?.citationId,
        queryLength: diagnosticQuery.length,
        queryHash: hashFindControllerQuery(diagnosticQuery),
        normalizationResult,
        pageIndex: expectedPageIndex,
        sourceOccurrence: options?.sourceMatchPageOccurrence,
        queryRole: options?.queryRole || "displayed-quote",
        acceptanceMs: findControllerDiagnosticState.acceptanceMs,
        totalMatches: findControllerDiagnosticState.matchCount,
        failureStage,
        elapsedMs: Date.now() - startedAt,
      },
    );
    return {
      matched: false,
      failureStage,
      reason,
      expectedPageIndex,
      queries,
      debugSummary,
    };
  };

  if (!app || !findController || !ready?.eventBus) {
    return failure(
      "find-controller-unavailable",
      "PDF.js FindController is unavailable in the current reader.",
    );
  }
  if (expectedPageIndex === null) {
    return failure(
      "page-text-unavailable",
      "The exact quote has no verified PDF page target.",
    );
  }

  const liveFingerprint = getPdfDocumentFingerprint(app);
  const expectedFingerprint = String(options?.sourceFingerprint || "").trim();
  const comparableExpectedFingerprint = expectedFingerprint.startsWith("pdfjs:")
    ? expectedFingerprint.slice("pdfjs:".length)
    : expectedFingerprint.startsWith("fingerprint-")
      ? expectedFingerprint.slice("fingerprint-".length)
      : "";
  if (
    comparableExpectedFingerprint &&
    liveFingerprint &&
    comparableExpectedFingerprint !== liveFingerprint
  ) {
    return failure(
      "source-fingerprint-mismatch",
      "The cited source fingerprint does not match the loaded PDF.",
    );
  }

  const pageTextResult = await settleBeforeDeadline(
    extractFindControllerPageText(app, expectedPageIndex),
    deadlineAt,
  );
  if (!pageTextResult.completed) {
    return failure(
      "deadline-exceeded",
      "Exact quote navigation exceeded its PDF.js page-text deadline.",
    );
  }
  const pageText = pageTextResult.value;
  if (!pageText) {
    return failure(
      "page-text-unavailable",
      "PDF.js could not provide searchable text for the cited page.",
    );
  }
  const completeQuery = resolvePageNativeFindControllerQuery(
    pageText,
    quoteText,
    options?.sourceMatchPageOccurrence,
    options?.normalizationHintText,
  );
  const partialSourceMatch = completeQuery
    ? null
    : resolveLargestUniquePageNativeSourceMatch(
        pageText,
        quoteText,
        options?.normalizationHintText,
      );
  const resolvedQuery = completeQuery || partialSourceMatch;
  const usedPartialSourceMatch = Boolean(partialSourceMatch);
  if (!resolvedQuery) {
    normalizationResult = "no-unique-page-native-source-span";
    return failure(
      "full-quote-not-on-page",
      "Neither the complete quote nor a strong unique partial source span could be aligned to the cited PDF page.",
    );
  }
  diagnosticQuery = resolvedQuery.query;
  normalizationResult = usedPartialSourceMatch
    ? `page-native-${partialSourceMatch?.matchKind || "partial"}`
    : "page-native-aligned";

  const previousUserState = captureFindControllerUserState(app);
  const diagnostic = findControllerQueryDiagnostic(resolvedQuery.query);
  const remainingMs = Math.max(50, deadlineAt - Date.now());
  const searchResult = await searchFindControllerForQuery(
    reader,
    resolvedQuery.query,
    {
      matchTimeoutMs: Math.min(2000, remainingMs),
      deadlineAt,
    },
  );
  const attempts: ExactQuoteJumpQueryAttempt[] = searchResult
    ? [
        {
          query: resolvedQuery.query,
          matchedPageIndexes: searchResult.matchedPageIndexes,
          totalMatches: searchResult.totalMatches,
        },
      ]
    : [];
  findControllerDiagnosticState.acceptanceMs = searchResult?.acceptanceMs;
  findControllerDiagnosticState.matchCount = searchResult?.totalMatches;
  const debugSummary = [diagnostic];
  const retryWithDerivedPartialSource =
    async (): Promise<ExactQuoteJumpResult | null> => {
      if (
        !completeQuery ||
        usedPartialSourceMatch ||
        options?.allowDerivedPartialAfterSearchFailure === false ||
        Date.now() >= deadlineAt
      ) {
        return null;
      }
      const fallback = resolvePageNativeFallbackAfterCompleteSearchFailure(
        pageText,
        quoteText,
        options?.sourceMatchPageOccurrence,
        options?.normalizationHintText,
      );
      if (!fallback || fallback.query === resolvedQuery.query) return null;
      logFindControllerDiagnostic(
        "LLM citation FindController retrying largest unique partial source span",
        {
          citationId: options?.citationId,
          completeQueryLength: resolvedQuery.query.length,
          completeQueryHash: hashFindControllerQuery(resolvedQuery.query),
          partialQueryLength: fallback.query.length,
          partialQueryHash: hashFindControllerQuery(fallback.query),
          pageIndex: expectedPageIndex,
          matchKind: fallback.matchKind,
          quoteTokenCoverage: fallback.quoteTokenCoverage,
        },
      );
      await restoreFindControllerUserState(app, previousUserState);
      const retried = await runPageNativeFindControllerJump(
        reader,
        fallback.query,
        {
          ...options,
          sourceMatchPageOccurrence: fallback.occurrenceIndex,
          deadlineAt,
          queryRole: "source-locator",
          normalizationHintText: options?.normalizationHintText || quoteText,
          requireUniqueMatch: true,
          highlightCoverage: fallback.quoteTokenCoverage,
          allowDerivedPartialAfterSearchFailure: false,
        },
      );
      return {
        ...retried,
        queries: [...attempts, ...retried.queries],
        debugSummary: [
          ...debugSummary,
          `Complete FindController query failed; retried a ${fallback.matchKind} source span covering ${Math.round(
            fallback.quoteTokenCoverage * 100,
          )}% of quote tokens.`,
          ...retried.debugSummary,
        ],
      };
    };
  if (Date.now() > deadlineAt) {
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      "deadline-exceeded",
      "Exact quote navigation exceeded its FindController search deadline.",
      debugSummary,
      attempts,
    );
  }
  if (!searchResult) {
    const retried = await retryWithDerivedPartialSource();
    if (retried) return retried;
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      "query-not-accepted",
      `FindController could not accept the ${
        usedPartialSourceMatch ? "unique partial source" : "complete quote"
      } query.`,
      debugSummary,
      attempts,
    );
  }
  if (getFindControllerQuery(findController) !== resolvedQuery.query) {
    const retried = await retryWithDerivedPartialSource();
    if (retried) return retried;
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      "query-not-accepted",
      `FindController did not retain the ${
        usedPartialSourceMatch ? "unique partial source" : "complete quote"
      } query.`,
      debugSummary,
      attempts,
    );
  }
  if (
    (usedPartialSourceMatch || options?.requireUniqueMatch) &&
    searchResult.totalMatches !== 1
  ) {
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      "full-match-not-found",
      searchResult.totalMatches > 1
        ? "The largest partial source span was not unique in the complete PDF."
        : "FindController did not find the largest partial source span in the complete PDF.",
      debugSummary,
      attempts,
    );
  }
  if (
    searchResult.totalMatches <= 0 ||
    !searchResult.matchedPageIndexes.includes(expectedPageIndex)
  ) {
    const retried = await retryWithDerivedPartialSource();
    if (retried) return retried;
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      "full-match-not-found",
      `FindController found no ${
        usedPartialSourceMatch ? "unique partial source" : "complete quote"
      } match on the cited page.`,
      debugSummary,
      attempts,
    );
  }

  const pageMatchCount =
    searchResult.pageMatchCounts[expectedPageIndex] ||
    (searchResult.matchedPageIndexes.length === 1
      ? searchResult.totalMatches
      : 0);
  const intendedOccurrence =
    pageMatchCount <= 1
      ? 0
      : (options?.sourceMatchPageOccurrence ?? resolvedQuery.occurrenceIndex);
  const selected = await selectNativeFindControllerMatch({
    app,
    pageIndex: expectedPageIndex,
    occurrenceIndex: intendedOccurrence,
    totalMatches: searchResult.totalMatches,
    pageMatchCount,
    deadlineAt,
  });
  if (!selected) {
    const retried = await retryWithDerivedPartialSource();
    if (retried) return retried;
    await restoreFindControllerUserState(app, previousUserState);
    return failure(
      Date.now() >= deadlineAt
        ? "deadline-exceeded"
        : "intended-match-not-selected",
      Date.now() >= deadlineAt
        ? "Exact quote navigation exceeded its FindController selection deadline."
        : "FindController found the quote but could not select its intended occurrence.",
      debugSummary,
      attempts,
    );
  }

  logFindControllerDiagnostic("LLM citation FindController exact match", {
    citationId: options?.citationId,
    queryLength: resolvedQuery.query.length,
    queryHash: hashFindControllerQuery(resolvedQuery.query),
    normalizationResult,
    pageIndex: expectedPageIndex,
    sourceOccurrence: resolvedQuery.occurrenceIndex,
    queryRole: options?.queryRole || "displayed-quote",
    totalMatches: searchResult.totalMatches,
    acceptanceMs: searchResult.acceptanceMs,
    readyElapsedMs: Date.now() - readyAt,
    elapsedMs: Date.now() - startedAt,
  });
  return {
    matched: true,
    reason: `FindController highlighted the ${
      usedPartialSourceMatch || options?.queryRole === "source-locator"
        ? "largest unique source locator"
        : "complete displayed quote"
    } on page ${expectedPageIndex + 1}.`,
    expectedPageIndex,
    matchedPageIndex: expectedPageIndex,
    queryUsed: resolvedQuery.query,
    highlightCoverage:
      options?.highlightCoverage !== undefined
        ? options.highlightCoverage
        : partialSourceMatch?.quoteTokenCoverage !== undefined
          ? partialSourceMatch.quoteTokenCoverage
          : 1,
    queries: attempts,
    debugSummary,
  };
}

/**
 * After navigating to the correct page, trigger PDF.js's built-in find
 * controller to scroll to the exact paragraph/text position of the quote
 * and highlight it — equivalent to the user typing the quote into Ctrl+F.
 *
 * Returns structured success/failure information so callers can surface
 * debug details when the paragraph jump fails.
 */
export async function scrollToExactQuoteInReader(
  reader: any,
  quoteText: string,
  options?: {
    citationId?: string;
    expectedPageIndex?: number | null;
    sourceFingerprint?: string;
    sourceMatchPageOccurrence?: number;
    fallbackQuoteTexts?: string[];
  },
): Promise<ExactQuoteJumpResult> {
  const { fallbackQuoteTexts = [], ...navigationOptions } = options || {};
  const quoteTexts = Array.from(
    new Set(
      [quoteText, ...fallbackQuoteTexts]
        .map((value) => sanitizeText(value || "").trim())
        .filter(Boolean),
    ),
  );
  await waitForFindControllerReady(reader);
  const deadlineAt = Date.now() + FIND_CONTROLLER_NAVIGATION_DEADLINE_MS;
  let lastResult: ExactQuoteJumpResult | null = null;
  for (
    let candidateIndex = 0;
    candidateIndex < quoteTexts.length;
    candidateIndex += 1
  ) {
    const candidate = quoteTexts[candidateIndex];
    const result = await runPageNativeFindControllerJump(reader, candidate, {
      ...navigationOptions,
      deadlineAt,
      queryRole: candidateIndex === 0 ? "displayed-quote" : "source-locator",
      normalizationHintText: quoteTexts[0],
    });
    if (result.matched) return result;
    lastResult = result;
    if (Date.now() >= deadlineAt) break;
  }
  return (
    lastResult || {
      matched: false,
      failureStage: "page-text-unavailable",
      reason: "No searchable quote text was provided.",
      expectedPageIndex: null,
      queries: [],
      debugSummary: [],
    }
  );
}

export async function scrollToSelectedTextInReader(
  reader: any,
  selectedText: string,
  options?: { expectedPageIndex?: number | null },
): Promise<ExactQuoteJumpResult> {
  return runPageNativeFindControllerJump(reader, selectedText, options);
}
