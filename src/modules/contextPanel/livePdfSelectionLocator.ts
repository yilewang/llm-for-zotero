import { collectReaderSelectionDocuments } from "./readerSelection";
import { sanitizeText } from "./textUtils";

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

export type LivePdfSelectionLocateConfidence = "high" | "medium" | "low" | "none";

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
  expectedPageIndex: number | null;
  queryUsed?: string;
  queries: ExactQuoteJumpQueryAttempt[];
  debugSummary: string[];
};

const SEARCH_BOUNDARY_PUNCTUATION_RE =
  /^[\s"'`“”‘’([{<]+|[\s"'`“”‘’)\]}>.,;:!?]+$/g;

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
const PAGE_FLASH_STYLE_ID = "llmforzotero-page-flash-style";
const PAGE_FLASH_CLASS = "llmforzotero-page-flash";

const SEARCH_WORD_PATTERN = /[a-z0-9]+/g;
const COMMON_SEARCH_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "into",
  "is",
  "it",
  "of",
  "on",
  "or",
  "that",
  "the",
  "their",
  "then",
  "these",
  "this",
  "those",
  "to",
  "was",
  "we",
  "were",
  "with",
]);

function normalizeLocatorText(value: string): string {
  return sanitizeText(value || "")
    .replace(/\u00ad/g, "")
    .replace(/([A-Za-z])-\s+([A-Za-z])/g, "$1$2")
    .replace(/[“”‘’]/g, " ")
    .replace(/[‐‑‒–—-]/g, " ")
    .replace(/[^a-zA-Z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// ── Quote pre-cleaning utilities ──────────────────────────────────────
// LLMs frequently quote PDF text with leading/trailing ellipsis
// ("...some text...") and internal ellipsis ("some text ... more text")
// where sentences were skipped.  The internal ellipsis joins two
// non-contiguous text regions, creating a phrase that never appears in
// the PDF as a contiguous string.  We strip boundary ellipsis and, when
// the full quote search fails, split at internal ellipsis and search the
// longest clean segment instead.

const ELLIPSIS_RE = /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/;
const ELLIPSIS_RE_G = /(?:\.{2,}|\u2026|\[\s*\.{2,}\s*\]|\[\s*\u2026\s*\])/g;

/**
 * Strip leading and trailing ellipsis from a quote while preserving the
 * interior.  Returns the trimmed string.
 */
export function stripBoundaryEllipsis(text: string): string {
  return text
    .replace(new RegExp("^\\s*" + ELLIPSIS_RE.source + "\\s*"), "")
    .replace(new RegExp("\\s*" + ELLIPSIS_RE.source + "\\s*$"), "")
    .trim();
}

/**
 * Split a quote at internal ellipsis markers, returning the segments
 * sorted by descending length (longest first).  Only segments with a
 * meaningful amount of text (>= 30 chars after trimming) are returned.
 */
export function splitQuoteAtEllipsis(text: string): string[] {
  const cleaned = stripBoundaryEllipsis(text);
  if (!ELLIPSIS_RE.test(cleaned)) return [cleaned];
  return cleaned
    .split(ELLIPSIS_RE_G)
    .map((s) => s.trim())
    .filter((s) => s.length >= 30)
    .sort((a, b) => b.length - a.length);
}

function stripInlineLocatorNoise(value: string): string {
  const cleaned = sanitizeText(value || "");
  return cleaned
    .replace(/\(([^)]{0,160})\)/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    )
    .replace(/\[([^\]]{0,160})\]/gi, (_match, inner: string) =>
      /\b(fig|figure|table|appendix|supp|supplement|eq|equation|section|sec\.?|et al|19\d{2}|20\d{2})\b/i.test(
        inner,
      )
        ? " "
        : ` ${inner} `,
    );
}

function extractSearchTokens(value: string): string[] {
  const normalized = normalizeLocatorText(stripInlineLocatorNoise(value));
  return normalized.match(SEARCH_WORD_PATTERN) || [];
}

function scoreSearchToken(token: string): number {
  if (!token) return Number.NEGATIVE_INFINITY;
  if (COMMON_SEARCH_STOP_WORDS.has(token)) return 0.5;
  if (/^\d+$/.test(token)) return 0.2;
  if (token.length <= 2) return 0.2;
  if (token.length === 3) return 1.5;
  return Math.min(8, token.length + (/[a-z]/.test(token) ? 1 : 0));
}

function formatQuerySnippet(query: string, maxLength = 72): string {
  if (query.length <= maxLength) return query;
  return `${query.slice(0, maxLength - 3)}...`;
}

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
    const matchIndexes = findAllMatchIndexes(page.normalizedText, normalizedQuery);
    if (!matchIndexes.length) continue;
    matchedPageIndexes.push(page.pageIndex);
    totalMatches += matchIndexes.length;
    if (!excerpt) {
      excerpt = buildExcerpt(page.normalizedText, matchIndexes[0], normalizedQuery.length);
    }
  }
  return { matchedPageIndexes, totalMatches, excerpt };
}

function getProgressiveStartOffsets(tokens: string[]): number[] {
  const offsets = [0];
  if (tokens.length > 6 && scoreSearchToken(tokens[0]) < 2) {
    offsets.push(1);
  }
  if (tokens.length > 8 && scoreSearchToken(tokens[0]) < 1 && scoreSearchToken(tokens[1]) < 2) {
    offsets.push(2);
  }
  // Add middle and tail offsets so that quotes whose beginning was
  // paraphrased by the LLM can still be located from interior tokens.
  if (tokens.length >= 10) {
    offsets.push(Math.floor(tokens.length / 2));
  }
  if (tokens.length >= 16) {
    offsets.push(Math.floor(tokens.length / 3));
    offsets.push(Math.floor((tokens.length * 2) / 3));
  }
  return offsets;
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

function buildExcerpt(text: string, index: number, matchLength: number): string {
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

function parsePageIndexFromElement(element: Element | null | undefined): number | null {
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

function getPageLabelFromElement(element: Element | null | undefined): string | undefined {
  let current = element || null;
  while (current) {
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

function countRenderedPages(doc: Document): number {
  return doc.querySelectorAll(PAGE_CONTAINER_SELECTOR).length;
}

function getPageElementByIndex(doc: Document, pageIndex: number): Element | null {
  const pageElements = Array.from(doc.querySelectorAll(PAGE_CONTAINER_SELECTOR)).filter(
    isElementNode,
  );
  for (const pageElement of pageElements) {
    if (parsePageIndexFromElement(pageElement) === pageIndex) {
      return pageElement;
    }
  }
  return null;
}

function ensurePageFlashStyle(doc: Document): void {
  if (doc.getElementById(PAGE_FLASH_STYLE_ID)) return;
  const style = doc.createElement("style");
  style.id = PAGE_FLASH_STYLE_ID;
  style.textContent = `
    @keyframes llmforzoteroPageFlashPulse {
      0%, 100% {
        box-shadow: 0 0 0 0 rgba(37, 99, 235, 0);
        background-color: rgba(37, 99, 235, 0);
      }
      25%, 75% {
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.95);
        background-color: rgba(59, 130, 246, 0.10);
      }
      50% {
        box-shadow: 0 0 0 6px rgba(96, 165, 250, 0.35);
        background-color: rgba(96, 165, 250, 0.16);
      }
    }

    .${PAGE_FLASH_CLASS} {
      animation: llmforzoteroPageFlashPulse 0.75s ease-in-out 2;
      border-radius: 6px;
    }
  `;
  (doc.head || doc.documentElement || doc).appendChild(style);
}

function flashPageElement(pageElement: Element): void {
  const doc = pageElement.ownerDocument;
  if (!doc) return;
  ensurePageFlashStyle(doc);
  pageElement.classList.remove(PAGE_FLASH_CLASS);
  void (pageElement as HTMLElement).getBoundingClientRect();
  pageElement.classList.add(PAGE_FLASH_CLASS);
  const win = doc.defaultView;
  win?.setTimeout(() => {
    pageElement.classList.remove(PAGE_FLASH_CLASS);
  }, 1700);
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
  const edgeLength = Math.max(18, Math.min(64, Math.floor(normalizedSelection.length / 3)));
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
    const matchIndexes = findAllMatchIndexes(normalizedPageText, normalizedSelection);
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
    const matchIndexes = matchByPrefixSuffix(normalizedPageText, normalizedSelection);
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

function formatPageList(pageIndexes: number[]): string {
  return pageIndexes.length
    ? pageIndexes.map((pageIndex) => `p${pageIndex + 1}`).join(", ")
    : "none";
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

  const { matches, confidence } = collectPageMatches(pages, normalizedSelection);
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
  if (matches.length === 1 && totalMatches > 1 && options?.resolveSinglePageDuplicates) {
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

export function locateQuoteInPageTexts(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex?: number | null,
): LivePdfSelectionLocateResult {
  const cleanQuote = sanitizeText(quoteText || "").trim();
  const exactResult = locateSelectionInPageTexts(
    pages,
    cleanQuote,
    expectedPageIndex,
    {
      queryLabel: "Quote",
      resolveSinglePageDuplicates: true,
    },
  );
  if (exactResult.status === "resolved") {
    return {
      ...exactResult,
      reason:
        exactResult.reason ||
        "The exact quote matched a single page in the live PDF text.",
    };
  }
  return exactResult;
}

function getPdfViewerApplication(reader: any): any | null {
  const candidates = [
    reader?._internalReader?._lastView,
    reader?._internalReader?._primaryView,
    reader?._internalReader?._secondaryView,
    reader,
  ];
  for (const candidate of candidates) {
    // Standard property access
    const app =
      candidate?._iframeWindow?.PDFViewerApplication ||
      candidate?._iframe?.contentWindow?.PDFViewerApplication ||
      candidate?._window?.PDFViewerApplication;
    if (app?.pdfDocument) return app;

    // Firefox/Gecko Xray wrapper bypass — custom JS globals like
    // PDFViewerApplication are hidden behind Xray wrappers and need
    // wrappedJSObject to be visible from chrome (privileged) code.
    try {
      const wrapped =
        candidate?._iframeWindow?.wrappedJSObject?.PDFViewerApplication ||
        candidate?._iframe?.contentWindow?.wrappedJSObject?.PDFViewerApplication ||
        candidate?._window?.wrappedJSObject?.PDFViewerApplication;
      if (wrapped?.pdfDocument) return wrapped;
    } catch {
      // wrappedJSObject may throw in non-Firefox environments
    }
  }

  // Last resort: reach the iframe window via the DOM documents already
  // accessible through collectReaderSelectionDocuments.
  try {
    const docs = collectReaderSelectionDocuments(reader);
    for (const doc of docs) {
      const win: any = doc?.defaultView;
      if (!win) continue;
      const app = win.PDFViewerApplication;
      if (app?.pdfDocument) return app;
      try {
        const wrapped = win.wrappedJSObject?.PDFViewerApplication;
        if (wrapped?.pdfDocument) return wrapped;
      } catch {
        // Ignore
      }
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
    const selectedText = sanitizeText(doc.defaultView?.getSelection?.()?.toString() || "").trim();
    if (!selectedText) continue;
    if (normalizeLocatorText(selectedText) !== normalizedSelection) continue;
    const selectionPageElement = getSelectionPageElement(doc);
    const pageIndex = parsePageIndexFromElement(selectionPageElement);
    if (pageIndex === null) continue;
    return buildDomResolvedResult(
      selectionText,
      expectedPageIndex,
      pageIndex,
      getPageLabelFromElement(selectionPageElement),
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
      pageLabel: getPageLabelFromElement(selectionPageElement),
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

  const docs = collectReaderSelectionDocuments(reader);
  for (const doc of docs) {
    const pageElement = getPageElementByIndex(doc, normalizedPageIndex);
    const pageLabel = getPageLabelFromElement(pageElement);
    if (pageLabel) return pageLabel;
  }

  const app = getPdfViewerApplication(reader);
  const labels = app?.pdfViewer?.pageLabels;
  if (Array.isArray(labels) && labels[normalizedPageIndex]) {
    return String(labels[normalizedPageIndex]);
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
): number {
  const clean = sanitizeText(pageLabel || "").trim();
  if (!clean) return 0;

  const app = getPdfViewerApplication(reader);
  const labels: unknown = app?.pdfViewer?.pageLabels;
  if (Array.isArray(labels) && labels.length > 0) {
    const idx = labels.findIndex(
      (entry: unknown) => String(entry || "") === clean,
    );
    if (idx >= 0) return idx;
  }

  const parsed = parseInt(clean, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed - 1 : 0;
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

export async function flashPageInLivePdfReader(
  reader: any,
  pageIndex: number,
): Promise<boolean> {
  if (!Number.isFinite(pageIndex) || pageIndex < 0) return false;
  const normalizedPageIndex = Math.floor(pageIndex);
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1800) {
    const app = getPdfViewerApplication(reader);
    const pageView = app?.pdfViewer?.getPageView?.(normalizedPageIndex);
    const directPageElement = isElementNode(pageView?.div) ? pageView.div : null;
    if (directPageElement) {
      flashPageElement(directPageElement);
      return true;
    }

    const docs = collectReaderSelectionDocuments(reader);
    for (const doc of docs) {
      const pageElement = getPageElementByIndex(doc, normalizedPageIndex);
      if (!pageElement) continue;
      flashPageElement(pageElement);
      return true;
    }
    await delay(40);
  }
  return false;
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
    const pageElements = Array.from(doc.querySelectorAll(PAGE_CONTAINER_SELECTOR)).filter(
      isElementNode,
    );
    for (const pageElement of pageElements) {
      const pageIndex = parsePageIndexFromElement(pageElement);
      if (pageIndex === null || pagesByIndex.has(pageIndex)) continue;
      const text = extractPageTextFromElement(pageElement);
      if (!text) continue;
      pagesByIndex.set(pageIndex, {
        pageIndex,
        pageLabel: getPageLabelFromElement(pageElement) || `${pageIndex + 1}`,
        text,
      });
    }
  }

  return {
    pages: Array.from(pagesByIndex.values()).sort((a, b) => a.pageIndex - b.pageIndex),
    expectedPageIndex: getExpectedPageIndex(reader, app),
  };
}

// ── Page text cache ─────────────────────────────────────────────────
// Pre-loads ALL page texts from the PDF document once and caches them
// so that subsequent quote lookups are instant (pure in-memory substring
// search with zero async I/O).

interface CachedPageTextIndex {
  pages: LivePdfPageText[];
  /** Pre-computed normalised text per page for O(1) reuse. */
  normalised: { pageIndex: number; pageLabel?: string; normalizedText: string }[];
}

let _pageTextCache: CachedPageTextIndex | null = null;
let _pageTextCacheReaderKey: string | null = null;
let _pageTextCachePromise: Promise<CachedPageTextIndex | null> | null = null;

function getReaderCacheKey(reader: any): string | null {
  const app = getPdfViewerApplication(reader);
  const fp = app?.pdfDocument?.fingerprints;
  if (Array.isArray(fp) && fp[0]) return String(fp[0]);
  const id = reader?._item?.id || reader?.itemID;
  return id ? `item-${id}` : null;
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
async function extractPageTextsFromPdfWorker(
  reader: any,
): Promise<LivePdfPageText[] | null> {
  try {
    const itemId = Number(reader?._item?.id || reader?.itemID || 0);
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
      const ffPages = fullText.split('\f');
      if (ffPages.length > 1) {
        ztoolkit.log("LLM quote-locator: PDFWorker — no pageChars, using form-feed split:", ffPages.length, "pages");
        const pages: LivePdfPageText[] = [];
        for (let i = 0; i < ffPages.length; i++) {
          const text = sanitizeText(ffPages[i].trim());
          if (text) {
            pages.push({ pageIndex: i, pageLabel: `${i + 1}`, text });
          }
        }
        return pages.length > 0 ? pages : null;
      }
      ztoolkit.log("LLM quote-locator: PDFWorker — no pageChars and no form-feeds, cannot split into pages");
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
      "LLM quote-locator: PDFWorker extracted", pages.length,
      "pages from", pageChars.length, "total (text length:", fullText.length, ")"
    );
    return pages.length > 0 ? pages : null;
  } catch (e) {
    ztoolkit.log("LLM quote-locator: PDFWorker strategy failed:", e);
    return null;
  }
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
): Promise<LivePdfPageText[] | null> {
  try {
    const app = getPdfViewerApplication(reader);
    if (!app) {
      ztoolkit.log("LLM quote-locator: getPdfViewerApplication returned null");
      return null;
    }
    if (!app.pdfDocument) {
      ztoolkit.log("LLM quote-locator: app found but pdfDocument is null/undefined");
      return null;
    }
    const pdfDoc = app.pdfDocument;
    const numPages = Number(pdfDoc.numPages);
    if (!Number.isFinite(numPages) || numPages < 1) {
      ztoolkit.log("LLM quote-locator: pdfDocument.numPages =", pdfDoc.numPages);
      return null;
    }

    ztoolkit.log("LLM quote-locator: extracting text from", numPages, "pages via viewer API");
    const pages: LivePdfPageText[] = [];
    for (let i = 1; i <= numPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const textContent = await page.getTextContent();
        const items = Array.isArray(textContent?.items) ? textContent.items : [];
        const text = items
          .map((item: any) => (item.str ?? ""))
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
        ztoolkit.log("LLM quote-locator: page", i, "text extraction failed:", e);
      }
    }
    if (pages.length) {
      ztoolkit.log("LLM quote-locator: viewer API extracted", pages.length, "pages");
    }
    return pages.length > 0 ? pages : null;
  } catch (e) {
    ztoolkit.log("LLM quote-locator: viewer API strategy failed:", e);
    return null;
  }
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
  const key = getReaderCacheKey(reader);
  if (key && key === _pageTextCacheReaderKey && _pageTextCache) {
    return _pageTextCache;
  }
  if (key && key === _pageTextCacheReaderKey && _pageTextCachePromise) {
    return _pageTextCachePromise;
  }
  _pageTextCacheReaderKey = key;
  _pageTextCachePromise = (async () => {
    try {
      // Strategy 0: Zotero PDFWorker — ALL pages via getFullText + pageChars
      let pages = await extractPageTextsFromPdfWorker(reader);

      // Strategy 1: pdf.js viewer API — ALL pages from viewer iframe
      if (!pages) {
        ztoolkit.log("LLM quote-locator: PDFWorker unavailable, trying viewer API");
        pages = await extractPageTextsFromViewer(reader);
      }

      // Strategy 2: DOM text layer scraping — rendered pages only
      if (!pages) {
        ztoolkit.log("LLM quote-locator: viewer API unavailable, falling back to DOM text layers");
        const rendered = extractRenderedPageTexts(reader);
        if (rendered.pages.length) {
          pages = rendered.pages;
          ztoolkit.log("LLM quote-locator: DOM extracted", pages.length, "rendered pages");
        }
      }

      if (!pages?.length) {
        ztoolkit.log("LLM quote-locator: all extraction strategies failed — no pages");
        return null;
      }

      const normalised = pages.map((p) => ({
        pageIndex: p.pageIndex,
        pageLabel: p.pageLabel,
        normalizedText: normalizeLocatorText(p.text),
      }));
      const result: CachedPageTextIndex = { pages, normalised };
      _pageTextCache = result;
      return result;
    } catch (e) {
      ztoolkit.log("LLM quote-locator: warmPageTextCache error:", e);
      return null;
    }
  })();
  return _pageTextCachePromise;
}

/** Clear cache (e.g. when switching documents). */
export function clearPageTextCache(): void {
  _pageTextCache = null;
  _pageTextCacheReaderKey = null;
  _pageTextCachePromise = null;
}

/**
 * The simplest, most reliable search: take the first N characters of
 * the normalised quote and do a plain substring search across every
 * page.  This mirrors what a user does with Ctrl+F — "just search the
 * first couple of words."
 */
/**
 * Overload accepting pre-computed normalised page data (from cache).
 */
export function locateQuoteByRawPrefixInPages(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex: number | null,
  precomputedNorms?: { pageIndex: number; pageLabel?: string; normalizedText: string }[],
): LivePdfSelectionLocateResult | null {
  const normalized = normalizeLocatorText(quoteText);
  if (!normalized || normalized.length < 10) return null;

  // Build queries: short first (15 → 25) then longer.
  // Short prefixes are tried first because they are most tolerant of
  // minor text-extraction differences while still being discriminative
  // enough to land on a unique page in most papers.
  const queries: string[] = [];
  for (const len of [15, 25, 40, 60]) {
    if (normalized.length <= len) continue;
    const prefix = normalized.slice(0, len).replace(/\s\S*$/, "").trim();
    if (prefix.length >= 10 && !queries.includes(prefix)) {
      queries.push(prefix);
    }
  }
  // Full text as last resort (if short enough)
  if (normalized.length <= 200 && !queries.includes(normalized)) {
    queries.push(normalized);
  }

  const pageNorms = precomputedNorms ?? pages.map((p) => ({
    pageIndex: p.pageIndex,
    pageLabel: p.pageLabel,
    normalizedText: normalizeLocatorText(p.text),
  }));
  const debugSummary: string[] = [];

  for (const query of queries) {
    const matchedPageIndexes: number[] = [];
    let totalMatches = 0;
    for (const p of pageNorms) {
      const idx = p.normalizedText.indexOf(query);
      if (idx >= 0) {
        matchedPageIndexes.push(p.pageIndex);
        totalMatches++;
      }
    }
    debugSummary.push(
      `Raw prefix "${formatQuerySnippet(query)}" -> ${formatPageList(matchedPageIndexes)}`,
    );
    if (matchedPageIndexes.length === 1) {
      return buildPageTextQuoteResult(
        quoteText,
        expectedPageIndex,
        { matchedPageIndexes, totalMatches },
        pages.length,
        `Direct text prefix search found the quote on a single page.`,
        query.length >= 40 ? "high" : "medium",
        matchedPageIndexes[0],
        debugSummary,
      );
    }
    // Multiple pages → try next (longer) prefix to disambiguate
    if (matchedPageIndexes.length > 1) continue;
    // No matches → also try next length
  }
  return null;
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

function shouldRunExactQuoteQuery(quoteText: string): boolean {
  const tokens = extractSearchTokens(quoteText);
  return tokens.length > 0 && tokens.length <= 24 && quoteText.length <= 220;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Build raw-text prefix queries from the original quote, trimmed at word
 * boundaries.  These are passed to the FindController as-is (no
 * tokenisation), mimicking what a user would type into the Ctrl+F bar.
 */
export function buildRawPrefixQueries(text: string): string[] {
  const clean = sanitizeText(text || "").trim();
  if (clean.length < 12) return [];
  const queries: string[] = [];
  const pushQuery = (query: string) => {
    const normalizedQuery = sanitizeText(query || "").trim();
    if (normalizedQuery.length < 12 || queries.includes(normalizedQuery)) return;
    queries.push(normalizedQuery);
  };
  const stripped = clean.replace(SEARCH_BOUNDARY_PUNCTUATION_RE, "").trim();
  const bases = Array.from(
    new Set(
      [stripped || clean, stripped === clean ? clean : ""].filter(
        (value) => value.length >= 12,
      ),
    ),
  );

  for (const base of bases) {
    // Try the whole visible phrase first when it is short enough.
    if (base.length <= 220) {
      pushQuery(base);
    }

    // Human-like fallback: search from the beginning of the quote/title.
    for (const charLen of [50, 30, 18]) {
      if (base.length <= charLen) continue;
      const prefix = base.slice(0, charLen).replace(/\s\S*$/, "").trim();
      pushQuery(prefix);
    }

    // Also search from the end of the quote/title, which often works better
    // for titles or model outputs that add wrapper quotation marks.
    for (const charLen of [50, 30, 18]) {
      if (base.length <= charLen) continue;
      const suffix = base.slice(-charLen).replace(/^\S*\s/, "").trim();
      pushQuery(suffix);
    }
  }
  return queries;
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

  while (Date.now() - startedAt < timeoutMs) {
    // Verify the FindController is processing our query.
    // _rawQuery is a private property that may not exist in all PDF.js
    // forks (e.g. Zotero's bundled version).  When it's undefined we
    // fall back to a short grace period before reading results.
    if (!queryConfirmed) {
      const rawQuery = findController?._rawQuery;
      if (rawQuery !== undefined && String(rawQuery) === expectedQuery) {
        queryConfirmed = true;
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
    if ((pageMatches.length >= pagesCount || pagesToSearch === 0) && pendingSize === 0) {
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
): Promise<{
  matchedPageIndexes: number[];
  totalMatches: number;
  pagesCount: number;
  pageMatchCounts: number[];
} | null> {
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

  let searchTriggered = false;

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
      searchTriggered = true;
    } catch (err) {
      ztoolkit.log(
        "LLM paragraph-jump: find-bar input approach failed, will try eventBus",
        err,
      );
    }
  }

  // Fallback: direct eventBus / executeCommand dispatch (may not work in all
  // Zotero builds, but costs nothing to try).
  if (!searchTriggered) {
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
  }

  // Wait for the FindController to process and populate results.
  // Use waitForFindControllerPageMatches first (reads pageMatches array),
  // then fall back to reading matchesCount (what the find-bar "1/1" uses).
  const pageMatches = await waitForFindControllerPageMatches(
    findController,
    pagesCount,
    query,
  );
  const result = {
    ...summarizeFindControllerMatches(pageMatches),
    pagesCount,
  };

  // Fallback: if pageMatches reading returned 0 (cross-realm array issues or
  // different property name in this PDF.js build), check the FindController's
  // own matchesCount — this is the same value the find bar uses to show "1/1".
  if (result.totalMatches === 0) {
    const fcTotal: number =
      (typeof findController?.matchesCount?.total === "number"
        ? findController.matchesCount.total
        : 0) ||
      (typeof findController?._matchesCountTotal === "number"
        ? findController._matchesCountTotal
        : 0);
    if (fcTotal > 0) {
      const selected =
        findController?.selected ?? findController?._selected;
      const selectedPage =
        typeof selected?.pageIdx === "number" ? selected.pageIdx : -1;
      result.totalMatches = fcTotal;
      if (selectedPage >= 0) {
        result.matchedPageIndexes = [selectedPage];
        result.pageMatchCounts = [];
        result.pageMatchCounts[selectedPage] = fcTotal;
      }
    }
  }

  return result;
}

function buildFindControllerQuoteResult(
  quoteText: string,
  expectedPageIndex: number | null,
  searchResult: {
    matchedPageIndexes: number[];
    totalMatches: number;
    pagesCount: number;
  },
  reason: string,
  confidence: LivePdfSelectionLocateConfidence,
  computedPageIndex: number | null,
  debugSummary?: string[],
): LivePdfSelectionLocateResult {
  return {
    status: computedPageIndex === null ? "ambiguous" : "resolved",
    confidence,
    selectionText: sanitizeText(quoteText || "").trim(),
    normalizedSelection: normalizeLocatorText(quoteText),
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex,
    matchedPageIndexes: searchResult.matchedPageIndexes,
    totalMatches: searchResult.totalMatches,
    pagesScanned: searchResult.pagesCount,
    debugSummary,
    reason,
  };
}

function buildPageTextQuoteResult(
  quoteText: string,
  expectedPageIndex: number | null,
  searchResult: {
    matchedPageIndexes: number[];
    totalMatches: number;
    excerpt?: string;
  },
  pagesScanned: number,
  reason: string,
  confidence: LivePdfSelectionLocateConfidence,
  computedPageIndex: number | null,
  debugSummary?: string[],
): LivePdfSelectionLocateResult {
  return {
    status: computedPageIndex === null ? "ambiguous" : "resolved",
    confidence,
    selectionText: sanitizeText(quoteText || "").trim(),
    normalizedSelection: normalizeLocatorText(quoteText),
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex,
    matchedPageIndexes: searchResult.matchedPageIndexes,
    totalMatches: searchResult.totalMatches,
    pagesScanned,
    excerpt: searchResult.excerpt,
    debugSummary,
    reason,
  };
}

function locateQuoteProgressivelyInPageTexts(
  pages: LivePdfPageText[],
  quoteText: string,
  expectedPageIndex: number | null,
): {
  result: LivePdfSelectionLocateResult | null;
  debugSummary: string[];
} {
  const tokens = extractSearchTokens(quoteText);
  const pageIndexEntries = buildPageTextIndex(pages);
  const debugSummary: string[] = [];
  const minQueryLength = tokens.length >= 12 ? 4 : 3;
  const maxQueryLength = Math.min(tokens.length, 14);
  for (const offset of getProgressiveStartOffsets(tokens)) {
    for (
      let queryLength = minQueryLength;
      queryLength <= maxQueryLength && offset + queryLength <= tokens.length;
      queryLength += 1
    ) {
      const query = tokens.slice(offset, offset + queryLength).join(" ");
      const searchResult = searchPageIndexEntries(pageIndexEntries, query);
      debugSummary.push(
        `Rendered prefix query: "${formatQuerySnippet(query)}" -> ${formatPageList(searchResult.matchedPageIndexes)}`,
      );
      if (searchResult.matchedPageIndexes.length === 1) {
        return {
          result: buildPageTextQuoteResult(
            quoteText,
            expectedPageIndex,
            searchResult,
            pages.length,
            "The progressive rendered-page quote search found a unique page.",
            queryLength >= 6 ? "high" : "medium",
            searchResult.matchedPageIndexes[0],
            debugSummary,
          ),
          debugSummary,
        };
      }
      if (!searchResult.matchedPageIndexes.length) {
        break;
      }
    }
  }
  return { result: null, debugSummary };
}

async function locateQuoteProgressivelyWithFindController(
  reader: any,
  quoteText: string,
  expectedPageIndex: number | null,
): Promise<{
  result: LivePdfSelectionLocateResult | null;
  debugSummary: string[];
}> {
  const tokens = extractSearchTokens(quoteText);
  const debugSummary: string[] = [];
  const minQueryLength = tokens.length >= 12 ? 4 : 3;
  const maxQueryLength = Math.min(tokens.length, 14);
  for (const offset of getProgressiveStartOffsets(tokens)) {
    for (
      let queryLength = minQueryLength;
      queryLength <= maxQueryLength && offset + queryLength <= tokens.length;
      queryLength += 1
    ) {
      const query = tokens.slice(offset, offset + queryLength).join(" ");
      const searchResult = await searchFindControllerForQuery(reader, query);
      if (!searchResult) {
        return { result: null, debugSummary };
      }
      debugSummary.push(
        `Progressive query: "${formatQuerySnippet(query)}" -> ${formatPageList(searchResult.matchedPageIndexes)}`,
      );
      if (searchResult.matchedPageIndexes.length === 1) {
        return {
          result: buildFindControllerQuoteResult(
            quoteText,
            expectedPageIndex,
            searchResult,
            "The live reader progressive quote search found a unique page.",
            searchResult.totalMatches > 1 ? "medium" : "high",
            searchResult.matchedPageIndexes[0],
            debugSummary,
          ),
          debugSummary,
        };
      }
      if (!searchResult.matchedPageIndexes.length) {
        break;
      }
    }
  }
  return { result: null, debugSummary };
}

async function locateQuoteWithFindController(
  reader: any,
  quoteText: string,
): Promise<LivePdfSelectionLocateResult | null> {
  const app = getPdfViewerApplication(reader);
  const pagesCount = getPagesCount(app);
  if (pagesCount < 1) {
    return null;
  }

  const expectedPageIndex = getExpectedPageIndex(reader, app);
  const cleanQuote = sanitizeText(quoteText || "").trim();

  // ── Raw-text prefix search (mimics Ctrl+F) ────────────────────────
  // The user's observation: "simply, just search the first a couple of
  // words, and then you can get unique results from pdf!"
  // Try the original text directly before any tokenisation.
  const rawPrefixes = buildRawPrefixQueries(cleanQuote);
  const rawDebug: string[] = [];
  for (const rawQuery of rawPrefixes) {
    const rawResult = await searchFindControllerForQuery(reader, rawQuery);
    if (!rawResult) break; // FindController unavailable
    rawDebug.push(
      `Raw prefix "${formatQuerySnippet(rawQuery)}" -> ${formatPageList(rawResult.matchedPageIndexes)}`,
    );
    if (rawResult.matchedPageIndexes.length === 1) {
      return buildFindControllerQuoteResult(
        cleanQuote,
        expectedPageIndex,
        rawResult,
        rawResult.totalMatches > 1
          ? "The live reader raw-text prefix search found the quote on a single page (multiple hits)."
          : "The live reader raw-text prefix search found the quote on a single page.",
        rawResult.totalMatches > 1 ? "medium" : "high",
        rawResult.matchedPageIndexes[0],
        rawDebug,
      );
    }
    // If no matches at all, try a shorter prefix
    if (!rawResult.matchedPageIndexes.length) continue;
    // Multiple pages matched — keep going with a longer/different prefix
  }

  // ── Tokenised exact query ──────────────────────────────────────────
  const exactQuery = extractSearchTokens(cleanQuote).join(" ");
  const exactResult = shouldRunExactQuoteQuery(cleanQuote) && exactQuery
    ? await searchFindControllerForQuery(reader, exactQuery)
    : null;
  if (exactResult?.matchedPageIndexes.length === 1) {
    return buildFindControllerQuoteResult(
      cleanQuote,
      expectedPageIndex,
      exactResult,
      exactResult.totalMatches > 1
        ? "The live reader full-document exact-quote search found the quote multiple times on the same page."
        : "The live reader full-document exact-quote search found the quote on a single page.",
      exactResult.totalMatches > 1 ? "low" : "high",
      exactResult.matchedPageIndexes[0],
      [`Exact query -> ${formatPageList(exactResult.matchedPageIndexes)}`],
    );
  }

  const progressiveResult = await locateQuoteProgressivelyWithFindController(
    reader,
    cleanQuote,
    expectedPageIndex,
  );
  if (progressiveResult.result) {
    return progressiveResult.result;
  }

  // If the exact query matched multiple pages, return it as ambiguous.
  if (exactResult?.matchedPageIndexes.length) {
    return {
      ...buildFindControllerQuoteResult(
        cleanQuote,
        expectedPageIndex,
        exactResult,
        "The live reader full-document exact-quote search found the quote on multiple pages.",
        "low",
        null,
        [`Exact query -> ${formatPageList(exactResult.matchedPageIndexes)}`],
      ),
      status: "ambiguous",
    };
  }

  return {
    status: "not-found",
    confidence: "none",
    selectionText: sanitizeText(cleanQuote || "").trim(),
    normalizedSelection: normalizeLocatorText(cleanQuote),
    queryLabel: "Quote",
    expectedPageIndex,
    computedPageIndex: null,
    matchedPageIndexes: [],
    totalMatches: 0,
    pagesScanned: pagesCount,
    debugSummary: [...rawDebug, ...progressiveResult.debugSummary],
    reason: "The live reader full-document search did not find the current quote.",
  };
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
        reason: "The active reader did not expose a live selection page or rendered page text.",
      };
    }

    const result = locateSelectionInPageTexts(pages, cleanSelection, expectedPageIndex, {
      queryLabel: "Selection",
    });
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
      expectedPageIndex: getExpectedPageIndex(reader, getPdfViewerApplication(reader)),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live reader locator failed: ${message}`,
    };
  }
}

/**
 * Segment-based fallback: when the full quote contains internal ellipsis
 * ("text A ... text B"), split at the ellipsis and search each segment
 * independently.  If any segment resolves to a single page, use that.
 * If multiple segments agree on the same page, return it with medium
 * confidence.
 */
async function locateQuoteBySegments(
  reader: any,
  fullQuote: string,
  pages: LivePdfPageText[],
  expectedPageIndex: number | null,
): Promise<LivePdfSelectionLocateResult | null> {
  const segments = splitQuoteAtEllipsis(fullQuote);
  // Only try segment search if the quote actually contained internal
  // ellipsis (i.e. we got multiple segments, or a single segment that
  // is shorter than the original — meaning leading/trailing was stripped
  // and internal content differed).
  if (segments.length < 2) return null;

  const pageVotes = new Map<number, number>();
  let bestSegmentResult: LivePdfSelectionLocateResult | null = null;

  for (const segment of segments) {
    // Try progressive rendered-page search for this segment
    if (pages.length) {
      const progressive = locateQuoteProgressivelyInPageTexts(
        pages,
        segment,
        expectedPageIndex,
      );
      if (progressive.result?.status === "resolved" && progressive.result.computedPageIndex !== null) {
        const page = progressive.result.computedPageIndex;
        pageVotes.set(page, (pageVotes.get(page) || 0) + 1);
        if (!bestSegmentResult) {
          bestSegmentResult = {
            ...progressive.result,
            reason: "Resolved via segment-based search (split at internal ellipsis).",
          };
        }
        continue;
      }
    }

    // Try FindController for this segment
    const fcResult = await locateQuoteWithFindController(reader, segment);
    if (fcResult?.status === "resolved" && fcResult.computedPageIndex !== null) {
      const page = fcResult.computedPageIndex;
      pageVotes.set(page, (pageVotes.get(page) || 0) + 1);
      if (!bestSegmentResult) {
        bestSegmentResult = {
          ...fcResult,
          reason: "Resolved via segment-based search (split at internal ellipsis).",
        };
      }
    }
  }

  if (bestSegmentResult) {
    return bestSegmentResult;
  }
  return null;
}

export async function locateQuoteInLivePdfReader(
  reader: any,
  quoteText: string,
  options?: { skipFindController?: boolean },
): Promise<LivePdfSelectionLocateResult> {
  const skipFindController = options?.skipFindController ?? false;
  const cleanQuote = stripBoundaryEllipsis(sanitizeText(quoteText || "").trim());
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
    // ── Use cached page texts (pre-warmed or loaded now) ─────────────
    // warmPageTextCache tries 2 strategies internally:
    //   1. pdf.js viewer API (ALL pages via pdfDocument.getPage)
    //   2. DOM text layers (rendered pages only — last resort)
    const cached = await warmPageTextCache(reader);
    const allPages = cached?.pages || [];
    const allNorms = cached?.normalised || [];

    const expectedPageIndex = getExpectedPageIndex(
      reader,
      getPdfViewerApplication(reader),
    );

    if (allPages.length) {
      // Raw prefix substring search — first couple of words, like Ctrl+F
      const rawResult = locateQuoteByRawPrefixInPages(
        allPages,
        cleanQuote,
        expectedPageIndex,
        allNorms,
      );
      if (rawResult) return rawResult;

      // Exact / prefix-suffix matching against normalized page texts.
      // This catches truncated quotes that begin/end mid-sentence.
      const exactPageTextResult = locateQuoteInPageTexts(
        allPages,
        cleanQuote,
        expectedPageIndex,
      );
      if (exactPageTextResult.status === "resolved") {
        return {
          ...exactPageTextResult,
          reason:
            exactPageTextResult.reason ||
            "Resolved by normalized full-quote page-text matching.",
        };
      }

      // Progressive token query fallback on rendered/extracted page text.
      const progressivePageTextResult = locateQuoteProgressivelyInPageTexts(
        allPages,
        cleanQuote,
        expectedPageIndex,
      );
      if (progressivePageTextResult.result) {
        return progressivePageTextResult.result;
      }

      // For ellipsis quotes, try segments
      const segments = splitQuoteAtEllipsis(cleanQuote);
      if (segments.length >= 2) {
        for (const segment of segments) {
          const segResult = locateQuoteByRawPrefixInPages(
            allPages,
            segment,
            expectedPageIndex,
            allNorms,
          );
          if (segResult) {
            return {
              ...segResult,
              reason: "Resolved via segment search (split at internal ellipsis).",
            };
          }
        }

        if (!skipFindController) {
          const segmentFallback = await locateQuoteBySegments(
            reader,
            cleanQuote,
            allPages,
            expectedPageIndex,
          );
          if (segmentFallback) {
            return segmentFallback;
          }
        }
      }

      // If exact matching was ambiguous, return that instead of generic not-found.
      if (exactPageTextResult.status === "ambiguous") {
        return exactPageTextResult;
      }
    }

    // Final fallback: use live reader find controller search strategies.
    // Skipped when skipFindController is true (e.g. background page-label
    // resolution during decoration) to avoid opening the find bar and
    // visibly scrolling the reader without user interaction.
    if (!skipFindController) {
      const findControllerResult = await locateQuoteWithFindController(
        reader,
        cleanQuote,
      );
      if (findControllerResult) {
        return findControllerResult;
      }
    }

    // ── Not found — return error immediately ─────────────────────────
    return {
      status: "not-found",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: normalizeLocatorText(cleanQuote),
      queryLabel: "Quote",
      expectedPageIndex,
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: allPages.length,
      reason: allPages.length
        ? "Could not locate the quote in the PDF. The text may differ from the original."
        : "Could not read PDF page texts from the active reader.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: "unavailable",
      confidence: "none",
      selectionText: cleanQuote,
      normalizedSelection: normalizeLocatorText(cleanQuote),
      queryLabel: "Quote",
      expectedPageIndex: getExpectedPageIndex(reader, getPdfViewerApplication(reader)),
      computedPageIndex: null,
      matchedPageIndexes: [],
      totalMatches: 0,
      pagesScanned: 0,
      reason: `Live quote locator failed: ${message}`,
    };
  }
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
    expectedPageIndex?: number | null;
  },
): Promise<ExactQuoteJumpResult> {
  const app = getPdfViewerApplication(reader);
  const eventBus = app?.eventBus;
  const findController = app?.findController;
  const expectedPageIndex =
    options && Object.prototype.hasOwnProperty.call(options, "expectedPageIndex")
      ? Number.isFinite(options.expectedPageIndex) &&
        Number(options.expectedPageIndex) >= 0
        ? Math.floor(Number(options.expectedPageIndex))
        : null
      : getExpectedPageIndex(reader, app);
  if (!eventBus || !findController) {
    return {
      matched: false,
      reason: "PDF.js FindController is unavailable in the current reader.",
      expectedPageIndex,
      queries: [],
      debugSummary: [],
    };
  }

  const queries = buildRawPrefixQueries(quoteText);
  if (!queries.length) {
    return {
      matched: false,
      reason: "The quote is too short to build a FindController query.",
      expectedPageIndex,
      queries: [],
      debugSummary: [],
    };
  }

  const pagesCount = getPagesCount(app);
  if (pagesCount < 1) {
    return {
      matched: false,
      reason: "The reader did not report any searchable PDF pages.",
      expectedPageIndex,
      queries: [],
      debugSummary: [],
    };
  }

  const attempts: ExactQuoteJumpQueryAttempt[] = [];
  const debugSummary: string[] = [];
  let matchedOtherPagesOnly = false;

  for (const query of queries) {
    const searchResult = await searchFindControllerForQuery(reader, query);
    if (!searchResult) {
      return {
        matched: false,
        reason: "FindController search could not run in the current reader.",
        expectedPageIndex,
        queries: attempts,
        debugSummary,
      };
    }
    const attempt: ExactQuoteJumpQueryAttempt = {
      query,
      matchedPageIndexes: searchResult.matchedPageIndexes,
      totalMatches: searchResult.totalMatches,
    };
    attempts.push(attempt);
    debugSummary.push(
      `Paragraph query "${formatQuerySnippet(query)}" -> ${formatPageList(searchResult.matchedPageIndexes)}`,
    );
    if (searchResult.totalMatches <= 0) continue;
    if (
      expectedPageIndex !== null &&
      !searchResult.matchedPageIndexes.includes(expectedPageIndex)
    ) {
      matchedOtherPagesOnly = true;
      continue;
    }
    return {
      matched: true,
      reason:
        expectedPageIndex !== null
          ? `FindController matched the quote on target page ${expectedPageIndex + 1}.`
          : "FindController matched the quote in the current reader.",
      expectedPageIndex,
      queryUsed: query,
      queries: attempts,
      debugSummary,
    };
  }
  return {
    matched: false,
    reason:
      matchedOtherPagesOnly && expectedPageIndex !== null
        ? `FindController matched other pages, but not the target page ${expectedPageIndex + 1}.`
        : "FindController found no match for the available quote queries.",
    expectedPageIndex,
    queries: attempts,
    debugSummary,
  };
}
