/**
 * A PDF attachment's bookmarks, read without opening a reader tab: pdf-lib
 * in a worker (`readPdfOutlineInWorker`), from the file's bytes. One read per
 * attachment file state; a changed file (path, size or modification time) is
 * read again. An encrypted PDF, a PDF pdf-lib cannot parse, a cancelled read
 * or a failed read answers null: the caller falls back to the text's own
 * headings. Only a definite answer is kept for the session (the bookmarks, or
 * none because the file has none or is encrypted); a read that failed is
 * tried again by the next load.
 */
import { appLogger } from "../../core/logging";
import type { AttachmentFileState } from "../../utils/attachmentFileState";
import type { PdfOutlineEntry, PdfOutlineResult } from "../../utils/pdfOutline";
import { readPdfOutlineInWorker } from "../../utils/pdfSplitter";
import { readAttachmentBytes } from "../attachmentStorage";

/** Reads the outline of the PDF at `path`; rejects when it cannot. */
export type PdfOutlineReader = (
  path: string,
  signal?: AbortSignal,
) => Promise<PdfOutlineResult>;

type CachedBookmarks = {
  fileKey: string;
  read: Promise<PdfOutlineEntry[] | null>;
};

/** One entry per attachment: the read for its last seen file state. */
const bookmarksByAttachment = new Map<number, CachedBookmarks>();

function fileKeyOf(state: AttachmentFileState): string {
  return `${state.path}\u0000${state.size ?? ""}\u0000${state.mtime ?? ""}`;
}

const readOutlineInWorker: PdfOutlineReader = async (path, signal) =>
  readPdfOutlineInWorker(await readAttachmentBytes(path), signal);

/**
 * The bookmarks of the PDF at `fileState.path`, or null when none can be
 * read. Callers share one read, which runs without any caller's signal:
 * `signal` stops only this caller's wait, and the read stays shared.
 */
export function readPdfBookmarks(
  attachmentId: number,
  fileState: AttachmentFileState | null,
  options: { signal?: AbortSignal; readOutline?: PdfOutlineReader } = {},
): Promise<PdfOutlineEntry[] | null> {
  if (!fileState?.path) return Promise.resolve(null);
  const signal = options.signal;
  if (signal?.aborted) return Promise.resolve(null);
  const fileKey = fileKeyOf(fileState);
  let entry = bookmarksByAttachment.get(attachmentId);
  if (entry?.fileKey !== fileKey) {
    const readOutline = options.readOutline || readOutlineInWorker;
    const created: CachedBookmarks = {
      fileKey,
      read: readOutline(fileState.path).then(
        (result) => (result.status === "ok" ? result.entries : null),
        (error) => {
          appLogger.debug("LLM: PDF bookmarks unavailable", error);
          if (bookmarksByAttachment.get(attachmentId) === created)
            bookmarksByAttachment.delete(attachmentId);
          return null;
        },
      ),
    };
    bookmarksByAttachment.set(attachmentId, created);
    entry = created;
  }
  if (!signal) return entry.read;
  return new Promise((resolve) => {
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    void entry.read.then((entries) => {
      signal.removeEventListener("abort", onAbort);
      resolve(entries);
    });
  });
}

/** Forgets every read (test seam and plugin shutdown). */
export function clearPdfBookmarksCache(): void {
  bookmarksByAttachment.clear();
}
