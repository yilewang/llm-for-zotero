/**
 * One attachment into one library text index document, through the existing
 * extraction and chunking pipeline (`ensurePDFTextCached`). Nothing here
 * re-implements chunking or BM25 term statistics.
 */
import { appLogger } from "../../core/logging";
import { fnv1a32 } from "../../utils/fnv1a";
import {
  readAttachmentFileState,
  type AttachmentFileState,
} from "../../utils/attachmentFileState";
import { paperTextStore } from "../paperContent/paperTextStore";
import { ensurePDFTextCached } from "../paperContent/pdfContext";
import type { PdfContext } from "../paperContent/types";
import { LIBRARY_TEXT_INDEX_CHUNKER_VERSION } from "./constants";
import type {
  IndexDocumentInput,
  LibraryTextIndexStore,
  StoredChunkMeta,
} from "./store";

/** sourceType of a document whose attachment yielded no text (e.g. a scan). */
export const NO_TEXT_SOURCE_TYPE = "none";

export type IndexLane = "prefetch" | "urgent";
export type IndexAttachmentResult = {
  status: "indexed" | "unchanged" | "no_text" | "skipped";
  attachmentId: number;
  chunkCount: number;
  sourceType?: string;
  elapsedMs: number;
};

const META_KEYS: Array<keyof StoredChunkMeta> = [
  "sectionLabel",
  "sectionIndex",
  "sectionPath",
  "sectionLevel",
  "enclosingSection",
  "chunkKind",
  "kindSource",
  "pageStart",
  "pageEnd",
  "sourceStart",
  "sourceEnd",
  "sourceFingerprint",
  "anchorText",
];
const POSTING_ROW_BYTES = 24;

/** UTF-8 length without allocating an encoded copy. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (
      code >= 0xd800 &&
      code <= 0xdbff &&
      i + 1 < text.length &&
      (text.charCodeAt(i + 1) & 0xfc00) === 0xdc00
    ) {
      bytes += 4; // a surrogate pair is one 4-byte code point
      i += 1;
    } else bytes += 3;
  }
  return bytes;
}

/** Stored text as UTF-8 plus a fixed cost per posting row (the byte budget's unit). */
export function estimateDocumentBytes(
  doc: Pick<IndexDocumentInput, "chunks">,
): number {
  let bytes = 0;
  for (const chunk of doc.chunks) {
    bytes +=
      utf8ByteLength(chunk.text) +
      Object.keys(chunk.tf).length * POSTING_ROW_BYTES;
  }
  return bytes;
}

export function buildIndexDocumentFromPdfContext(params: {
  attachmentId: number;
  attachmentKey: string;
  libraryID: number;
  parentItemId: number | null;
  fileState: AttachmentFileState | null;
  ctx: PdfContext;
}): IndexDocumentInput {
  const { ctx } = params;
  const chunks = ctx.chunks.map((text, chunkIndex) => {
    const stat = ctx.chunkStats[chunkIndex];
    const full = ctx.chunkMeta[chunkIndex];
    // Copied key by key from a full PdfChunkMeta, so required keys (chunkKind) are present.
    const meta = {} as StoredChunkMeta;
    for (const key of META_KEYS) {
      const value = full?.[key];
      if (value !== undefined) {
        (meta as Record<string, unknown>)[key] = value;
      }
    }
    return {
      chunkIndex,
      text,
      tokenCount: stat?.length || 0,
      meta,
      tf: stat?.tf || {},
    };
  });
  return {
    attachmentId: params.attachmentId,
    attachmentKey: params.attachmentKey,
    libraryID: params.libraryID,
    parentItemId: params.parentItemId,
    title: ctx.title,
    sourceType: ctx.sourceType || "unknown",
    sourceFingerprint:
      ctx.chunkMeta[0]?.sourceFingerprint || fnv1a32(ctx.chunks.join("\n\n")),
    sourceMtime: params.fileState?.mtime ?? null,
    sourceSize: params.fileState?.size ?? null,
    chunkerVersion: LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
    byteEstimate: estimateDocumentBytes({ chunks }),
    chunks,
  };
}

/** fnv1a32 over chunk boundaries and section labels; pinned by a unit test. */
export function computeChunkerFingerprint(ctx: PdfContext): string {
  return fnv1a32(
    ctx.chunks
      .map(
        (c, i) =>
          `${c.length}:${ctx.chunkMeta[i]?.sectionLabel || ""}:${ctx.chunkMeta[i]?.chunkKind || ""}:${ctx.chunkMeta[i]?.enclosingSection || ""}`,
      )
      .join("|"),
  );
}

export async function indexAttachment(params: {
  item: Zotero.Item;
  libraryID: number;
  store: LibraryTextIndexStore;
  lane: IndexLane;
  now?: () => number;
}): Promise<IndexAttachmentResult> {
  const now = params.now || Date.now;
  const started = now();
  const attachmentId = params.item.id;
  // The agent may have loaded this paper for its own reasons; only evict what indexing loaded.
  const releaseBorrowedText = paperTextStore.borrow(attachmentId);
  try {
    // Prefetch: cheapest source first (MinerU md → Zotero full-text cache → PDFWorker).
    // Urgent (write-through, added, invalidated): today's ladder, pages included.
    // Both lanes load silently so an index job never re-enqueues itself via the write-through hook.
    await ensurePDFTextCached(
      params.item,
      params.lane === "prefetch"
        ? { preferFulltextCache: true, silentLoad: true }
        : { silentLoad: true },
    );
    const ctx = paperTextStore.peek(attachmentId);
    if (!ctx || !ctx.chunks.length) {
      const fileState = await readAttachmentFileState(params.item);
      if (!fileState) {
        // No local file (not downloaded yet, or unreadable): nothing was
        // really extracted. Leave the paper unindexed; the notifier's
        // add/modify or the next reconcile queues it again once it exists.
        return {
          status: "skipped",
          attachmentId,
          chunkCount: 0,
          elapsedMs: now() - started,
        };
      }
      // The file exists but yields no text (e.g. a scan): persist a zero-chunk
      // row, so it is not re-extracted every session. Reconcile still
      // re-queues it when the file changes or a MinerU cache appears (its
      // sourceType is not "mineru").
      await params.store.upsertDocument({
        attachmentId,
        attachmentKey: String(
          (params.item as unknown as { key?: unknown }).key || "",
        ),
        libraryID: params.libraryID,
        parentItemId:
          typeof params.item.parentID === "number"
            ? params.item.parentID
            : null,
        title: "",
        sourceType: NO_TEXT_SOURCE_TYPE,
        sourceFingerprint: NO_TEXT_SOURCE_TYPE,
        sourceMtime: fileState.mtime,
        sourceSize: fileState.size,
        chunkerVersion: LIBRARY_TEXT_INDEX_CHUNKER_VERSION,
        byteEstimate: 0,
        chunks: [],
      });
      return {
        status: "no_text",
        attachmentId,
        chunkCount: 0,
        elapsedMs: now() - started,
      };
    }
    const doc = buildIndexDocumentFromPdfContext({
      attachmentId,
      attachmentKey: String(
        (params.item as unknown as { key?: unknown }).key || "",
      ),
      libraryID: params.libraryID,
      parentItemId:
        typeof params.item.parentID === "number" ? params.item.parentID : null,
      fileState: await readAttachmentFileState(params.item),
      ctx,
    });
    const existing = await params.store.getDocument(attachmentId);
    if (
      existing &&
      existing.sourceFingerprint === doc.sourceFingerprint &&
      existing.chunkerVersion === doc.chunkerVersion
    ) {
      // Same text, new stat (e.g. file sync re-downloaded identical bytes):
      // record it, or reconcile flags the paper stale at every startup.
      // A failed stat (both null) is not news; keep the recorded one.
      const statRead = doc.sourceMtime !== null || doc.sourceSize !== null;
      if (
        statRead &&
        (existing.sourceMtime !== doc.sourceMtime ||
          existing.sourceSize !== doc.sourceSize)
      ) {
        await params.store.updateFileState(attachmentId, {
          mtime: doc.sourceMtime,
          size: doc.sourceSize,
        });
      }
      return {
        status: "unchanged",
        attachmentId,
        chunkCount: existing.chunkCount,
        sourceType: doc.sourceType,
        elapsedMs: now() - started,
      };
    }
    await params.store.upsertDocument(doc);
    appLogger.debug(
      `LLM index: indexed ${attachmentId} (${doc.chunks.length} chunks, ${doc.sourceType}, ${params.lane})`,
    );
    return {
      status: "indexed",
      attachmentId,
      chunkCount: doc.chunks.length,
      sourceType: doc.sourceType,
      elapsedMs: now() - started,
    };
  } finally {
    releaseBorrowedText();
  }
}
