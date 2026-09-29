/**
 * Page links in assistant answers use Zotero's own URI,
 * `[p. 44](zotero://open-pdf/library/items/<key>?page=44)`, so they keep
 * working when an answer is saved to a note. Gecko's chrome-document HTML
 * parser drops zotero:// hrefs, so the chat displays them as inert fragments
 * and its click handler opens the page itself.
 */

const FRAGMENT_PREFIX = "#llm-pdf-page:";
const OPEN_PDF_LINK_TARGET =
  /\]\((zotero:\/\/open-pdf\/[^\s)]+)((?:\s+"[^"]*")?)\)/g;
const OPEN_PDF_URI =
  /^zotero:\/\/open-pdf\/(?:library|groups\/(\d+))\/items\/([A-Za-z0-9]+)(?:\?(.*))?$/;

/** Elements that open a PDF page carry these attributes. */
export const PDF_LOCATION_ATTRIBUTES = {
  contextItemId: "data-llm-pdf-context-item-id",
  pageIndex: "data-llm-pdf-page-index",
} as const;

export type ZoteroOpenPdfUri = {
  groupID?: number;
  itemKey: string;
  /** 1-based physical page, as the zotero:// URI records it. */
  pageNumber?: number;
};

export type PdfPageJumpTarget = {
  contextItemId: number;
  /** 0-based; absent means the start of the PDF. */
  pageIndex?: number;
};

export type PdfPageLinkLookups = {
  userLibraryID: () => number;
  libraryIDForGroup: (groupID: number) => number | null;
  itemIdForKey: (libraryID: number, itemKey: string) => number | null;
};

export const ZOTERO_PDF_PAGE_LINK_LOOKUPS: PdfPageLinkLookups = {
  userLibraryID: () => Number(Zotero.Libraries.userLibraryID),
  libraryIDForGroup: (groupID) =>
    Number(Zotero.Groups.getLibraryIDFromGroupID(groupID)) || null,
  itemIdForKey: (libraryID, itemKey) => {
    const item = Zotero.Items.getByLibraryAndKey(libraryID, itemKey);
    return item ? item.id : null;
  },
};

export function parseZoteroOpenPdfUri(uri: string): ZoteroOpenPdfUri | null {
  const match = OPEN_PDF_URI.exec(uri.trim());
  if (!match) return null;
  const page = new URLSearchParams(match[3] || "").get("page") || "";
  const pageNumber = /^\d+$/.test(page) ? Number(page) : 0;
  return {
    ...(match[1] ? { groupID: Number(match[1]) } : {}),
    itemKey: match[2],
    ...(pageNumber > 0 ? { pageNumber } : {}),
  };
}

/** Swaps open-pdf link targets for fragments the panel keeps. */
export function rewritePdfPageLinksForDisplay(markdown: string): string {
  return markdown.replace(
    OPEN_PDF_LINK_TARGET,
    (whole, uri: string, title: string) =>
      parseZoteroOpenPdfUri(uri)
        ? `](${FRAGMENT_PREFIX}${encodeURIComponent(uri)}${title})`
        : whole,
  );
}

function readFragmentUri(href: string): string | null {
  if (!href.startsWith(FRAGMENT_PREFIX)) return null;
  try {
    return decodeURIComponent(href.slice(FRAGMENT_PREFIX.length));
  } catch {
    return null;
  }
}

function readLocationAttributes(element: Element): PdfPageJumpTarget | null {
  const contextItemId = Number(
    element.getAttribute(PDF_LOCATION_ATTRIBUTES.contextItemId),
  );
  if (!Number.isInteger(contextItemId) || contextItemId <= 0) return null;
  const pageIndex = Number(
    element.getAttribute(PDF_LOCATION_ATTRIBUTES.pageIndex),
  );
  return Number.isInteger(pageIndex) && pageIndex >= 0
    ? { contextItemId, pageIndex }
    : { contextItemId };
}

/** The PDF page a click inside the chat should open, if any. */
export function resolvePdfPageJump(
  target: Element | null,
  lookups: PdfPageLinkLookups,
): PdfPageJumpTarget | null {
  const located = target?.closest?.(
    `[${PDF_LOCATION_ATTRIBUTES.contextItemId}]`,
  );
  if (located) return readLocationAttributes(located);
  const link = target?.closest?.("a[href]");
  const uri = readFragmentUri(link?.getAttribute("href") || "");
  const parsed = uri ? parseZoteroOpenPdfUri(uri) : null;
  if (!parsed) return null;
  const libraryID =
    parsed.groupID === undefined
      ? lookups.userLibraryID()
      : lookups.libraryIDForGroup(parsed.groupID);
  if (!libraryID) return null;
  const contextItemId = lookups.itemIdForKey(libraryID, parsed.itemKey);
  if (!contextItemId) return null;
  return parsed.pageNumber
    ? { contextItemId, pageIndex: parsed.pageNumber - 1 }
    : { contextItemId };
}
