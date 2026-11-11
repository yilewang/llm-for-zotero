import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFRef,
  PDFString,
  type PDFDocument,
  type PDFObject,
} from "pdf-lib";

/**
 * One PDF bookmark (outline item), in document order.
 *
 * `pageIndex` is the 0-based page its destination opens. `top` is the
 * destination's vertical position in PDF units (higher is nearer the top of
 * the page) when the destination names one; `fitsPage` marks a destination
 * that shows the whole page (`/Fit`, `/FitB`).
 */
export type PdfOutlineEntry = {
  depth: number;
  title: string;
  pageIndex: number;
  top: number | null;
  fitsPage: boolean;
};

/** What the worker's `outline` action answers. */
export type PdfOutlineResult =
  | { status: "ok"; pageCount: number; entries: PdfOutlineEntry[] }
  | { status: "encrypted" };

function decodeText(value: PDFObject | undefined): string | null {
  if (value instanceof PDFString || value instanceof PDFHexString)
    return value.decodeText();
  if (value instanceof PDFName) return value.decodeText();
  return null;
}

function numberOf(value: PDFObject | undefined): number | null {
  return value instanceof PDFNumber ? value.asNumber() : null;
}

/** A name tree lookup (`/Names /Dests`), depth first. */
function findInNameTree(
  node: PDFDict,
  key: string,
  seen: Set<PDFDict>,
): PDFObject | undefined {
  if (seen.has(node)) return undefined;
  seen.add(node);
  const names = node.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (names)
    for (let index = 0; index + 1 < names.size(); index += 2)
      if (decodeText(names.lookup(index)) === key)
        return names.lookup(index + 1);
  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
  if (kids)
    for (let index = 0; index < kids.size(); index += 1) {
      const kid = kids.lookup(index);
      if (!(kid instanceof PDFDict)) continue;
      const found = findInNameTree(kid, key, seen);
      if (found) return found;
    }
  return undefined;
}

/**
 * The bookmarks of `doc`: `/Outlines` walked by `/First` and `/Next`, each
 * item's `/Dest` (or `/A /D` of a go-to action) resolved through named
 * destinations (`/Names /Dests` and the legacy `/Dests`) to a page. Items
 * whose destination opens no page of this document are left out; their
 * children stay. A cycle in a malformed outline ends the walk there.
 */
export function readPdfOutline(doc: PDFDocument): PdfOutlineEntry[] {
  const pageIndexByRef = new Map(
    doc.getPages().map((page, index) => [page.ref.toString(), index]),
  );
  const pageCount = pageIndexByRef.size;
  const names = doc.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const destTree = names?.lookupMaybe(PDFName.of("Dests"), PDFDict);
  const legacyDests = doc.catalog.lookupMaybe(PDFName.of("Dests"), PDFDict);
  const resolveNamed = (key: string): PDFObject | undefined => {
    const found =
      (destTree ? findInNameTree(destTree, key, new Set()) : undefined) ??
      legacyDests?.lookup(PDFName.of(key));
    return found instanceof PDFDict ? found.lookup(PDFName.of("D")) : found;
  };
  const resolveDest = (
    raw: PDFObject | undefined,
  ): Omit<PdfOutlineEntry, "depth" | "title"> | null => {
    let dest = raw;
    const key = decodeText(dest);
    if (key !== null) dest = resolveNamed(key);
    if (!(dest instanceof PDFArray) || dest.size() < 1) return null;
    const target = dest.get(0);
    const pageIndex =
      target instanceof PDFRef
        ? pageIndexByRef.get(target.toString())
        : numberOf(target);
    if (
      pageIndex === undefined ||
      pageIndex === null ||
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      pageIndex >= pageCount
    )
      return null;
    const kind = dest.lookup(1);
    const view = kind instanceof PDFName ? kind.decodeText() : "";
    const at = (index: number) => {
      const value = dest.get(index);
      return value === undefined || value === PDFNull
        ? null
        : numberOf(dest.lookup(index));
    };
    const top =
      view === "XYZ"
        ? at(3)
        : view === "FitH" || view === "FitBH"
          ? at(2)
          : view === "FitR"
            ? at(5)
            : null;
    return { pageIndex, top, fitsPage: view === "Fit" || view === "FitB" };
  };
  const entries: PdfOutlineEntry[] = [];
  const seen = new Set<PDFDict>();
  const walk = (parent: PDFDict | undefined, depth: number) => {
    let item = parent?.lookupMaybe(PDFName.of("First"), PDFDict);
    while (item && !seen.has(item)) {
      seen.add(item);
      const title = (decodeText(item.lookup(PDFName.of("Title"))) || "")
        .replace(/\s+/g, " ")
        .trim();
      let dest = item.lookup(PDFName.of("Dest"));
      if (!dest) {
        const action = item.lookupMaybe(PDFName.of("A"), PDFDict);
        dest = action?.lookup(PDFName.of("D"));
      }
      const resolved = resolveDest(dest);
      if (resolved && title) entries.push({ depth, title, ...resolved });
      walk(item, depth + 1);
      item = item.lookupMaybe(PDFName.of("Next"), PDFDict);
    }
  };
  walk(doc.catalog.lookupMaybe(PDFName.of("Outlines"), PDFDict), 0);
  return entries;
}
