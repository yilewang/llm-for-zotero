/**
 * Zotero's own full-text cache (`storage/<KEY>/.zotero-ft-cache`) as a cheap
 * source of PDF page text.
 *
 * Zotero writes that file from `PDFWorker.getFullText`, so a complete copy has
 * the same text and the same form-feed page breaks a fresh extraction would
 * return, without queueing a PDF parse. The file is only trusted when its page
 * breaks account for every page Zotero indexed and the PDF has not changed
 * since. It is read, never written.
 */
import { appLogger } from "../../core/logging";
import { isPdfContextAttachment } from "../paperContent/contextAttachmentSupport";
import type { TextPageOffset } from "../paperContent/types";

type ZoteroFulltextApi = {
  getItemCacheFile?: (item: Zotero.Item) => { path?: string } | null;
  getPages?: (
    itemID: number,
  ) => Promise<
    false | null | undefined | { indexedPages?: unknown; total?: unknown }
  >;
};

type FulltextIOUtils = {
  stat?: (path: string) => Promise<{ lastModified?: number }>;
  readUTF8?: (path: string) => Promise<string>;
};

function positiveInt(value: unknown): number | null {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * True when a full-text cache covers every page of its PDF with one form-feed
 * separated part per page. PDFWorker trims leading and trailing blank pages
 * from its text, so only an exact count proves that each part sits on the
 * page its position names, unless the text's bookmarks proved how many
 * leading pages it lost (`textPageOffset`) for text of this part count.
 */
export function isPageCompleteZoteroFulltextCache(input: {
  text: string;
  indexedPages?: number | null;
  totalPages?: number | null;
  textPageOffset?: TextPageOffset;
}): boolean {
  const totalPages = positiveInt(input.totalPages);
  if (!totalPages || !input.text) return false;
  // Zotero indexes at most `fulltext.pdfMaxPages` pages.
  if (positiveInt(input.indexedPages) !== totalPages) return false;
  const parts = input.text.split("\f").length;
  if (parts === totalPages) return true;
  const shift = input.textPageOffset;
  return Boolean(
    shift &&
    shift.pageOffset > 0 &&
    parts === shift.textParts &&
    shift.pageOffset + parts <= totalPages,
  );
}

function getZoteroFulltextApi(): ZoteroFulltextApi | null {
  const zotero = (globalThis as { Zotero?: unknown }).Zotero as
    | { Fulltext?: ZoteroFulltextApi; FullText?: ZoteroFulltextApi }
    | undefined;
  return zotero?.Fulltext || zotero?.FullText || null;
}

function getIOUtils(): FulltextIOUtils | null {
  return (
    ((globalThis as { IOUtils?: unknown }).IOUtils as FulltextIOUtils) || null
  );
}

/**
 * The shift of form-feed text that may have lost blank leading pages, shown
 * for that same text and its PDF's page count; undefined when none is shown.
 */
export type ProveTextPageOffset = (text: {
  text: string;
  totalPages: number;
}) => Promise<TextPageOffset | undefined>;

async function getModifiedTime(
  io: FulltextIOUtils,
  path: string,
): Promise<number | null> {
  const modified = Number((await io.stat!(path))?.lastModified);
  return Number.isFinite(modified) ? modified : null;
}

/**
 * Read an attachment's Zotero full-text cache when it can stand in for a
 * fresh PDFWorker extraction. Returns null for anything that cannot be
 * verified: no cache, an unknown or mismatched page count, a cache older than
 * the PDF, or a read failure. Text that lost blank leading pages is accepted
 * with `textPageOffset`, or else with the shift `proveShift` shows for this
 * same text; the result names the shift it was accepted with.
 */
export async function readPageCompleteZoteroFulltextCache(
  attachmentId: number,
  options: {
    textPageOffset?: TextPageOffset;
    proveShift?: ProveTextPageOffset;
  } = {},
): Promise<{
  text: string;
  totalPages: number;
  textPageOffset?: TextPageOffset;
} | null> {
  try {
    const itemId = positiveInt(attachmentId);
    if (!itemId) return null;
    const item = Zotero.Items.get(itemId) as Zotero.Item | null;
    if (!item || !isPdfContextAttachment(item)) return null;
    const fulltext = getZoteroFulltextApi();
    const io = getIOUtils();
    if (!fulltext?.getItemCacheFile || !fulltext.getPages) return null;
    if (!io?.stat || !io.readUTF8) return null;
    const cacheFile = fulltext.getItemCacheFile(item);
    const cachePath = cacheFile?.path;
    if (!cachePath) return null;
    const pages = await fulltext.getPages(itemId);
    if (!pages) return null;
    const totalPages = positiveInt(pages.total);
    if (!totalPages || positiveInt(pages.indexedPages) !== totalPages) {
      return null;
    }
    const pdfPath = await (
      item as unknown as { getFilePathAsync?: () => Promise<string | false> }
    ).getFilePathAsync?.();
    if (!pdfPath) return null;
    const [cacheModified, pdfModified] = await Promise.all([
      getModifiedTime(io, cachePath),
      getModifiedTime(io, pdfPath),
    ]);
    // A PDF replaced after indexing would put old text on new pages.
    if (cacheModified === null || pdfModified === null) return null;
    if (cacheModified < pdfModified) return null;
    const text = await io.readUTF8(cachePath);
    const pageComplete = (textPageOffset?: TextPageOffset) =>
      isPageCompleteZoteroFulltextCache({
        text,
        indexedPages: positiveInt(pages.indexedPages),
        totalPages,
        textPageOffset,
      });
    if (pageComplete(options.textPageOffset)) {
      return { text, totalPages, textPageOffset: options.textPageOffset };
    }
    const proven = await options.proveShift?.({ text, totalPages });
    if (proven && pageComplete(proven)) {
      return { text, totalPages, textPageOffset: proven };
    }
    return null;
  } catch (error) {
    appLogger.debug("LLM: Zotero full-text page cache unavailable", {
      attachmentId,
      error,
    });
    return null;
  }
}
