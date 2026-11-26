import { extractPdfPageCountFromBytes } from "../utils/pdfPageCount";
import {
  buildMineruFilenameMatcher,
  getMineruMaxAutoPages,
  type MineruFilenameMatcher,
} from "../utils/mineruConfig";

type IOUtilsLike = {
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
};

type PdfAttachmentLike = Zotero.Item & {
  attachmentFilename?: string;
  attachmentSyncedHash?: string;
  getFilePathAsync?: () => Promise<string | false>;
};

export type MineruParseExclusionReason = "filename" | "page_count";

export type MineruParseEligibility = {
  eligible: boolean;
  excluded: boolean;
  reasons: MineruParseExclusionReason[];
  primaryReason: MineruParseExclusionReason | null;
  reasonLabel: string;
  pageCount: number | null;
  maxPages: number;
  overrideAllowed: boolean;
};

export type MineruParseEligibilityOptions = {
  filenameMatcher?: MineruFilenameMatcher;
  inspectPageCount?: boolean;
};

type PageCountCacheEntry = {
  signature: string;
  pageCount: number | null;
};

const pageCountCache = new Map<number, PageCountCacheEntry>();

function getIOUtils(): IOUtilsLike | undefined {
  return (globalThis as unknown as { IOUtils?: IOUtilsLike }).IOUtils;
}

function coerceToUint8Array(
  data: Uint8Array | ArrayBuffer | null | undefined,
): Uint8Array | null {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

async function readFileBytes(path: string): Promise<Uint8Array | null> {
  const io = getIOUtils();
  if (!io?.read) return null;
  try {
    return coerceToUint8Array(await io.read(path));
  } catch {
    return null;
  }
}

async function getPdfFileSignature(
  pdfAtt: PdfAttachmentLike,
): Promise<{ filePath: string; signature: string } | null> {
  const filePath = await pdfAtt.getFilePathAsync?.();
  if (!filePath) return null;
  const hash =
    typeof pdfAtt.attachmentSyncedHash === "string"
      ? pdfAtt.attachmentSyncedHash
      : "";
  return {
    filePath,
    signature: `${filePath}\n${hash}`,
  };
}

export async function getMineruPdfPageCount(
  pdfAtt: Zotero.Item,
): Promise<number | null> {
  const att = pdfAtt as PdfAttachmentLike;
  const fileInfo = await getPdfFileSignature(att);
  if (!fileInfo) return null;

  const cached = pageCountCache.get(pdfAtt.id);
  if (cached?.signature === fileInfo.signature) return cached.pageCount;

  const bytes = await readFileBytes(fileInfo.filePath);
  const pageCount = bytes ? extractPdfPageCountFromBytes(bytes) : null;
  pageCountCache.set(pdfAtt.id, {
    signature: fileInfo.signature,
    pageCount,
  });
  return pageCount;
}

/** Refine the existing file-signature cache after authoritative parsing. */
export function updateMineruPdfPageCount(
  attachmentId: number,
  pageCount: number,
): void {
  const cached = pageCountCache.get(attachmentId);
  if (cached) cached.pageCount = pageCount;
}

function getReasonLabel(
  reason: MineruParseExclusionReason | null,
  pageCount: number | null,
): string {
  if (reason === "filename") return "filename rule";
  if (reason === "page_count" && pageCount !== null) {
    return `${pageCount} pages`;
  }
  if (reason === "page_count") return "too many pages";
  return "";
}

function getAttachmentFilename(pdfAtt: Zotero.Item): string {
  return (
    (pdfAtt as PdfAttachmentLike).attachmentFilename ||
    pdfAtt.getField?.("title") ||
    ""
  );
}

export async function getMineruParseEligibility(
  _parentItem: Zotero.Item | null,
  pdfAtt: Zotero.Item,
  options: MineruParseEligibilityOptions = {},
): Promise<MineruParseEligibility> {
  const reasons: MineruParseExclusionReason[] = [];
  const filename = getAttachmentFilename(pdfAtt);
  const filenameMatcher =
    options.filenameMatcher || buildMineruFilenameMatcher();
  if (filenameMatcher.matches(filename)) reasons.push("filename");

  const maxPages = getMineruMaxAutoPages();
  let pageCount: number | null = null;
  if (
    maxPages > 0 &&
    reasons.length === 0 &&
    options.inspectPageCount !== false
  ) {
    pageCount = await getMineruPdfPageCount(pdfAtt);
    if (pageCount !== null && pageCount > maxPages) {
      reasons.push("page_count");
    }
  }

  const primaryReason = reasons[0] || null;
  const reasonLabel = getReasonLabel(primaryReason, pageCount);
  return {
    eligible: reasons.length === 0,
    excluded: reasons.length > 0,
    reasons,
    primaryReason,
    reasonLabel,
    pageCount,
    maxPages,
    overrideAllowed: true,
  };
}
