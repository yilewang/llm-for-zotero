import { config } from "../../package.json";
import type { PdfOutlineResult } from "./pdfOutline";

export class PdfSplitterCancelledError extends Error {
  constructor() {
    super("PDF preparation cancelled");
    this.name = "PdfSplitterCancelledError";
  }
}

export type PdfSplitterSession = {
  pageCount: number;
  extractPages: (startPage: number, endPage: number) => Promise<Uint8Array>;
  close: () => void;
};

type PdfWorkerChannel = {
  request: (
    data: Record<string, unknown>,
    transfer?: Transferable[],
  ) => Promise<any>;
  close: () => void;
};

/** One pdf-lib worker, terminated on cancellation or close. */
function startPdfWorker(signal?: AbortSignal): PdfWorkerChannel {
  const WorkerCtor = (
    Zotero.getMainWindow() as unknown as Window & { Worker: typeof Worker }
  ).Worker;
  const worker = new WorkerCtor(
    `chrome://${config.addonRef}/content/scripts/pdfSplitterWorker.js`,
  );
  let nextId = 0;
  let closed = false;
  const pending = new Map<
    number,
    { resolve: (data: any) => void; reject: (error: Error) => void }
  >();
  const close = (error = new PdfSplitterCancelledError()) => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener("abort", abort);
    worker.terminate();
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const abort = () => close();
  worker.onmessage = (event) => {
    const { data } = event as MessageEvent;
    const request = pending.get(data.id);
    if (!request) return;
    pending.delete(data.id);
    if (data.error) request.reject(new Error(data.error));
    else request.resolve(data);
  };
  worker.onerror = (event) => {
    event.preventDefault();
    close(new Error(`PDF preparation worker failed: ${event.message}`));
  };
  signal?.addEventListener("abort", abort, { once: true });
  const request = (
    data: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<any> => {
    if (closed || signal?.aborted)
      return Promise.reject(new PdfSplitterCancelledError());
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        worker.postMessage({ id, ...data }, transfer);
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  };
  return { request, close: () => close() };
}

/** One worker owns one source PDF, and is terminated on cancellation or close. */
export async function openPdfSplitter(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PdfSplitterSession> {
  if (signal?.aborted) throw new PdfSplitterCancelledError();
  const { request, close } = startPdfWorker(signal);
  try {
    const buffer = new Uint8Array(bytes).buffer;
    const opened = await request({ action: "open", bytes: buffer }, [buffer]);
    return {
      pageCount: opened.pageCount,
      extractPages: async (startPage, endPage) => {
        const result = await request({ action: "extract", startPage, endPage });
        return new Uint8Array(result.bytes);
      },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

/**
 * The PDF's bookmarks, read by pdf-lib in a worker of its own, which ends
 * with the read. The buffer of `bytes` is transferred (moved, not copied)
 * when `bytes` spans all of it, so the caller must not use `bytes` after
 * the call. An encrypted PDF answers `{ status: "encrypted" }`; a PDF
 * pdf-lib cannot read rejects.
 */
export async function readPdfOutlineInWorker(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<PdfOutlineResult> {
  if (signal?.aborted) throw new PdfSplitterCancelledError();
  const { request, close } = startPdfWorker(signal);
  try {
    const buffer =
      bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
        ? (bytes.buffer as ArrayBuffer)
        : new Uint8Array(bytes).buffer;
    const result = await request({ action: "outline", bytes: buffer }, [
      buffer,
    ]);
    return result.status === "encrypted"
      ? { status: "encrypted" }
      : {
          status: "ok",
          pageCount: Number(result.pageCount) || 0,
          entries: Array.isArray(result.entries) ? result.entries : [],
        };
  } finally {
    close();
  }
}
