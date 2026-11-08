import {
  buildQuoteTextIndex,
  findQuoteSourceSpansAllowingLayoutArtifacts,
} from "../quotes/quoteTextNormalization";
import { getAllOpenReaders } from "./zoteroReaderTabs";

export type PdfHighlightPosition = {
  pageIndex: number;
  rects: number[][];
};
export type ResolvedPdfHighlight = {
  text: string;
  pageLabel: string;
  sortIndex: string;
  position: PdfHighlightPosition;
  source: {
    documentFingerprint: string;
    /** Absent for a host selection: Zotero's draft carries no offsets. */
    startChar?: number;
    endChar?: number;
  };
};
export type PdfHighlightRequest = {
  attachmentId: number;
  text: string;
  pageIndex?: number;
  occurrence?: number;
};

type NativeChar = {
  c: string;
  inlineRect: number[];
  ignorable?: boolean;
  spaceAfter?: boolean;
  lineBreakAfter?: boolean;
  paragraphBreakAfter?: boolean;
};

function unwrap(value: any): any {
  return value?.wrappedJSObject || value;
}

/** Preserve UTF-16 to native-character offsets through spaces and ligatures. */
function indexCharacters(chars: NativeChar[]) {
  let text = "";
  const offsets: number[] = [];
  chars.forEach((char, index) => {
    if (char.ignorable) return;
    const value =
      char.c +
      (char.lineBreakAfter || char.paragraphBreakAfter
        ? "\n"
        : char.spaceAfter
          ? " "
          : "");
    text += value;
    for (let i = 0; i < value.length; i++) offsets.push(index);
  });
  return { text, offsets };
}

/**
 * Native reader getRange/getRectsFromChars semantics. These module-private
 * helpers are not exported by Zotero; retain its inline rectangles and line
 * boundaries rather than estimating glyph dimensions or converting pixels.
 * The reader's annotation builder supplies its page label and metadata.
 */
function selectionRange(
  chars: NativeChar[],
  start: number,
  end: number,
  pageIndex: number,
) {
  const selected = chars.slice(start, end);
  const rects: number[][] = [];
  let line: number[] | null = null;
  for (const char of selected) {
    const rect = char.inlineRect;
    if (
      !Array.isArray(rect) ||
      rect.length !== 4 ||
      !rect.every(Number.isFinite) ||
      rect[2] <= rect[0] ||
      rect[3] <= rect[1]
    ) {
      throw new Error(
        "Zotero did not provide valid character geometry for this passage. No annotation was created.",
      );
    }
    line = line
      ? [
          Math.min(line[0], rect[0]),
          Math.min(line[1], rect[1]),
          Math.max(line[2], rect[2]),
          Math.max(line[3], rect[3]),
        ]
      : [...rect];
    if (char.lineBreakAfter) {
      rects.push(line);
      line = null;
    }
  }
  if (line) rects.push(line);
  return {
    pageIndex,
    anchorOffset: start,
    headOffset: end,
    text: indexCharacters(selected).text.replace(/\s+/g, " ").trim(),
    position: {
      pageIndex,
      rects: rects.map((rect) => rect.map((n) => Number(n.toFixed(3)))),
    },
  };
}

/** The pdf.js document fingerprint of a reader's open PDF, or "". */
function readerDocumentFingerprint(reader: any): string {
  const internal = unwrap(reader?._internalReader);
  const view = unwrap(internal?._primaryView);
  const app = unwrap(unwrap(view?._iframeWindow)?.PDFViewerApplication);
  const document = unwrap(app?.pdfDocument);
  return String(document?.fingerprints?.[0] || document?.fingerprint || "");
}

/**
 * The fingerprint of the PDF open in a reader for `attachmentId`, or "" when
 * no open reader holds it (or the reader is not ready).
 */
export function readOpenReaderDocumentFingerprint(
  attachmentId: number,
): string {
  try {
    const reader = getAllOpenReaders().find(
      (r) => Number(r.itemID || r._item?.id) === attachmentId,
    );
    return reader ? readerDocumentFingerprint(reader) : "";
  } catch {
    return "";
  }
}

/** Resolve a complete quotation against native character data, without selecting UI text. */
export async function resolveHighlightInReader(
  reader: any,
  input: PdfHighlightRequest,
  check: () => void = () => undefined,
): Promise<ResolvedPdfHighlight> {
  const internal = unwrap(reader?._internalReader);
  const view = unwrap(internal?._primaryView);
  const app = unwrap(unwrap(view?._iframeWindow)?.PDFViewerApplication);
  const document = unwrap(app?.pdfDocument);
  // Chrome-owned objects are opaque to content code through Gecko wrappers.
  // Recreate only plain data in the reader realm before calling native helpers.
  const readerJSON =
    unwrap(reader?._iframeWindow)?.JSON || unwrap(view?._iframeWindow)?.JSON;
  const nativeValue = (value: unknown) =>
    readerJSON ? readerJSON.parse(JSON.stringify(value)) : value;
  const fingerprint = readerDocumentFingerprint(reader);
  if (
    !document ||
    !fingerprint ||
    typeof view?._getAnnotationFromSelectionRanges !== "function" ||
    (typeof view?._ensureBasicPageData !== "function" &&
      typeof view?._documentData?.ensurePage !== "function")
  ) {
    throw new Error(
      "This Zotero reader does not expose the native text-selection API required for highlighting. No annotation was created; do not estimate coordinates or use scripts as a fallback.",
    );
  }
  const pageCount = Number(document.numPages);
  if (
    !Number.isInteger(pageCount) ||
    pageCount < 1 ||
    (input.pageIndex !== undefined && input.pageIndex >= pageCount)
  ) {
    throw new Error(
      "The requested page is outside this PDF. No annotation was created.",
    );
  }
  const pages =
    input.pageIndex === undefined
      ? Array.from({ length: pageCount }, (_, i) => i)
      : [input.pageIndex];
  const matches: ResolvedPdfHighlight[] = [];
  for (const pageIndex of pages) {
    check();
    if (view._ensureBasicPageData) await view._ensureBasicPageData(pageIndex);
    else await view._documentData.ensurePage(pageIndex);
    check();
    const chars = unwrap(view._pdfPages?.[pageIndex])?.chars as
      | NativeChar[]
      | undefined;
    if (!Array.isArray(chars))
      throw new Error(
        "Zotero could not load native PDF character data. No annotation was created.",
      );
    const indexed = indexCharacters(chars);
    const spans = findQuoteSourceSpansAllowingLayoutArtifacts(
      buildQuoteTextIndex(indexed.text),
      input.text,
    );
    for (const span of spans) {
      const startChar = indexed.offsets[span.sourceStart];
      const endChar = indexed.offsets[span.sourceEnd - 1] + 1;
      const range = selectionRange(chars, startChar, endChar, pageIndex);
      const viewBox = view._pdfPages[pageIndex].viewBox;
      const top = Array.isArray(viewBox)
        ? Math.max(
            0,
            Math.floor(
              viewBox[3] -
                viewBox[1] -
                Math.max(...range.position.rects.map((rect) => rect[3])),
            ),
          )
        : 0;
      const meta =
        typeof view.getAnnotationMeta === "function"
          ? view.getAnnotationMeta(nativeValue(range.position))
          : {
              sortIndex: [
                String(pageIndex).padStart(5, "0"),
                String(startChar).padStart(6, "0"),
                String(top).padStart(5, "0"),
              ].join("|"),
            };
      // Do not change the user's active selection, search, scroll, or tool.
      const annotation = view._getAnnotationFromSelectionRanges(
        nativeValue([{ ...range, sortIndex: meta.sortIndex }]),
        "highlight",
      );
      if (
        !annotation?.position?.rects?.length ||
        !annotation.text ||
        !annotation.sortIndex
      ) {
        throw new Error(
          "Zotero could not construct this text highlight. No annotation was created.",
        );
      }
      matches.push({
        text: String(annotation.text),
        pageLabel: String(annotation.pageLabel),
        sortIndex: String(annotation.sortIndex),
        position: JSON.parse(JSON.stringify(annotation.position)),
        source: { documentFingerprint: fingerprint, startChar, endChar },
      });
    }
  }
  check();
  if (!matches.length)
    throw new Error(
      "The complete quoted passage was not found in the PDF's native text. Use an exact quotation from this attachment; scanned PDFs need a usable text layer. No annotation was created. Do not estimate coordinates or use scripts as a fallback.",
    );
  const selected =
    input.occurrence === undefined
      ? matches.length === 1
        ? matches[0]
        : undefined
      : matches[input.occurrence - 1];
  if (!selected)
    throw new Error(
      `The quotation has ${matches.length} matches on PDF pages ${[...new Set(matches.map((m) => m.position.pageIndex + 1))].join(", ")}. Supply pageIndex and a one-based occurrence, or a longer unique quotation. No annotation was created.`,
    );
  return selected;
}

/** Bound reader initialization and extraction, including cancellation while awaiting native work. */
export async function resolvePdfHighlight(
  input: PdfHighlightRequest,
  signal?: AbortSignal,
): Promise<ResolvedPdfHighlight> {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout>;
  let abort: () => void;
  const check = () => {
    if (stopped || signal?.aborted)
      throw new Error(
        "PDF annotation resolution was interrupted. No annotation was created.",
      );
  };
  const interrupted = new Promise<never>((_, reject) => {
    abort = () => {
      stopped = true;
      reject(
        new Error(
          "PDF annotation resolution was interrupted. No annotation was created.",
        ),
      );
    };
    timer = setTimeout(() => {
      stopped = true;
      reject(
        new Error(
          "Timed out locating the passage in Zotero's PDF reader. No annotation was created.",
        ),
      );
    }, 30000);
    signal?.addEventListener("abort", abort, { once: true });
  });
  const resolve = async () => {
    check();
    let reader = getAllOpenReaders().find(
      (r) => Number(r.itemID || r._item?.id) === input.attachmentId,
    );
    if (!reader)
      reader = await (Zotero.Reader as any).open(
        input.attachmentId,
        undefined,
        { openInBackground: true },
      );
    check();
    while (!reader) {
      await new Promise((r) => setTimeout(r, 40));
      check();
      reader = getAllOpenReaders().find(
        (r) => Number(r.itemID || r._item?.id) === input.attachmentId,
      );
    }
    await reader._initPromise;
    const view = unwrap(unwrap(reader._internalReader)?._primaryView);
    await view?.initializedPromise;
    check();
    return resolveHighlightInReader(reader, input, check);
  };
  try {
    return await Promise.race([resolve(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timer!);
    signal?.removeEventListener("abort", abort!);
  }
}
