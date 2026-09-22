import { appLogger } from "../../core/logging";
import {
  decodeBase64Bytes,
  encodeBytesBase64,
  parseDataUrl,
} from "../../shared/dataUrl";
import type { MultimodalItem } from "../../utils/embedding/types";
import { optimizeImageDataUrl } from "../../utils/imageOptimization";
import {
  embedItems,
  getResolvedEmbeddingConfig,
  isImageEmbeddingEnabled,
} from "../../utils/llmClient";
import { extractEmbeddedImages } from "../pdf/embeddedImages/extractor";
import {
  readPdfFigureCropCacheFromDir,
  type PdfFigureCropCache,
} from "../pdf/pdfFigureCropCache";
import {
  getMineruItemDir,
  readManifest,
  type MineruManifest,
} from "../mineru/mineruCache";
import {
  resolvePaperImageSource,
  type PaperImageSource,
  type PaperImageSourceDeps,
} from "./paperImageSource";
import {
  IMAGE_EXTRACTION_ALGORITHM_VERSION,
  IMAGE_MANIFEST_VERSION,
  loadImageManifest,
  loadImageVectors,
  readImageFile,
  saveImageManifest,
  saveImageVectors,
  writeImageFile,
  type EmbeddedImageManifest,
  type EmbeddedImageRecord,
} from "../retrieval/imageStore";
import { isPdfContextAttachment } from "./contextAttachmentSupport";
import type { PdfContext } from "./types";

type EmbeddingKeys = { cacheKey: string; attemptKey: string };

export type ImageIndexDeps = {
  isEnabled: () => boolean;
  getEmbeddingKeys: () => EmbeddingKeys | null;
  /** MinerU-backed papers use MinerU's figures; the rest use pdf.js. */
  resolveSource: (
    attachmentId: number,
    useMineru: boolean,
  ) => Promise<PaperImageSource | null>;
  compress: (dataUrl: string) => Promise<string>;
  loadManifest: (attachmentId: number) => Promise<EmbeddedImageManifest | null>;
  saveManifest: (
    attachmentId: number,
    manifest: EmbeddedImageManifest,
  ) => Promise<void>;
  writeImage: (
    attachmentId: number,
    fileName: string,
    bytes: Uint8Array,
  ) => Promise<void>;
  readImage: (
    attachmentId: number,
    fileName: string,
  ) => Promise<Uint8Array | null>;
  loadVectors: (
    attachmentId: number,
    cacheKey: string,
    imageIds: string[],
  ) => Promise<number[][] | null>;
  saveVectors: (
    attachmentId: number,
    data: { cacheKey: string; imageIds: string[]; vectors: number[][] },
  ) => Promise<void>;
  embed: (items: MultimodalItem[]) => Promise<number[][]>;
};

export type PendingImageInput = {
  record: EmbeddedImageRecord;
  item: MultimodalItem;
};

export type ImageVectorSet = {
  records: EmbeddedImageRecord[];
  vectors: number[][];
};

function fileNameFor(imageId: string, mimeType: string): string {
  const safe = imageId.toLowerCase().replace(/[^a-z0-9._-]+/g, "-");
  return `${safe}.${mimeType === "image/jpeg" ? "jpg" : "png"}`;
}

/**
 * Per-paper image index: extracts images once per PDF version, keeps them on
 * disk, and embeds them under the current embedding config. Everything is a
 * no-op while image embedding is off.
 */
export function createImageIndex(deps: ImageIndexDeps) {
  const inflight = new WeakMap<PdfContext, Promise<ImageVectorSet | null>>();

  async function runExtraction(
    attachmentId: number,
    useMineru: boolean,
    force: boolean,
  ): Promise<EmbeddedImageRecord[] | null> {
    const source = await deps.resolveSource(attachmentId, useMineru);
    if (!source) return null;
    const pdfFingerprint = source.fingerprint;
    const cached = force ? null : await deps.loadManifest(attachmentId);
    if (
      cached &&
      cached.pdfFingerprint === pdfFingerprint &&
      cached.algorithmVersion === IMAGE_EXTRACTION_ALGORITHM_VERSION
    ) {
      return cached.images;
    }
    const started = Date.now();
    const candidates = await source.collect();
    const records: EmbeddedImageRecord[] = [];
    for (const candidate of candidates) {
      try {
        const parsed = parseDataUrl(await deps.compress(candidate.dataUrl));
        if (!parsed) continue;
        const fileName = fileNameFor(candidate.contentHash, parsed.mimeType);
        await deps.writeImage(
          attachmentId,
          fileName,
          decodeBase64Bytes(parsed.data),
        );
        records.push({
          imageId: candidate.contentHash,
          pageIndex: candidate.pageIndex,
          ...(candidate.rect ? { rect: candidate.rect } : {}),
          ...(candidate.width !== undefined ? { width: candidate.width } : {}),
          ...(candidate.height !== undefined
            ? { height: candidate.height }
            : {}),
          ...(candidate.label ? { label: candidate.label } : {}),
          ...(candidate.caption ? { caption: candidate.caption } : {}),
          fileName,
          mimeType: parsed.mimeType,
          source: candidate.source,
        });
      } catch (error) {
        appLogger.debug("[Embedded images] Skipped an image", error);
      }
    }
    await deps.saveManifest(attachmentId, {
      version: IMAGE_MANIFEST_VERSION,
      algorithmVersion: IMAGE_EXTRACTION_ALGORITHM_VERSION,
      pdfFingerprint,
      images: records,
    });
    appLogger.debug("[Embedded images] Extracted", {
      attachmentId,
      from: source.kind,
      candidates: candidates.length,
      kept: records.length,
      ms: Date.now() - started,
    });
    return records;
  }

  function beginExtraction(
    ctx: PdfContext,
    attachmentId: number,
    force: boolean,
  ): void {
    const extraction = runExtraction(
      attachmentId,
      ctx.sourceType === "mineru",
      force,
    ).catch((error) => {
      appLogger.warn("[Embedded images] Extraction failed", error);
      return null;
    });
    ctx.imageIndex = force
      ? { failureKey: ctx.imageIndex?.failureKey, extraction }
      : { ...(ctx.imageIndex || {}), extraction };
  }

  /** Called alongside text extraction; later calls reuse the same promise. */
  function startExtraction(ctx: PdfContext, attachmentId: number): void {
    if (!deps.isEnabled() || ctx.imageIndex?.extraction) return;
    beginExtraction(ctx, attachmentId, false);
  }

  async function ensureImageSet(
    ctx: PdfContext,
    attachmentId: number,
  ): Promise<EmbeddedImageRecord[] | null> {
    if (!deps.isEnabled()) return null;
    startExtraction(ctx, attachmentId);
    const records = (await ctx.imageIndex?.extraction) ?? null;
    // Let a later read try again instead of keeping a failed extraction.
    if (!records && ctx.imageIndex) ctx.imageIndex.extraction = undefined;
    return records;
  }

  /** Every record's image as an embedding input, or null if a file is gone. */
  async function readItems(
    attachmentId: number,
    records: EmbeddedImageRecord[],
  ): Promise<PendingImageInput[] | null> {
    const out: PendingImageInput[] = [];
    for (const record of records) {
      const bytes = await deps.readImage(attachmentId, record.fileName);
      if (!bytes) return null;
      out.push({
        record,
        item: {
          kind: "image",
          dataUrl: `data:${record.mimeType};base64,${encodeBytesBase64(bytes)}`,
        },
      });
    }
    return out;
  }

  /** Reads the images, extracting again once when the cache lost a file. */
  async function readItemsOrRebuild(
    ctx: PdfContext,
    attachmentId: number,
    records: EmbeddedImageRecord[],
  ): Promise<PendingImageInput[]> {
    const items = await readItems(attachmentId, records);
    if (items) return items;
    appLogger.warn("[Embedded images] Cached image files are missing", {
      attachmentId,
    });
    beginExtraction(ctx, attachmentId, true);
    const rebuilt = await ensureImageSet(ctx, attachmentId);
    return (rebuilt && (await readItems(attachmentId, rebuilt))) || [];
  }

  /** Records plus their vectors under the current config, when cached. */
  async function loadCurrent(
    ctx: PdfContext,
    attachmentId: number,
  ): Promise<{
    records: EmbeddedImageRecord[];
    keys: EmbeddingKeys;
    vectors: number[][] | null;
  } | null> {
    const records = await ensureImageSet(ctx, attachmentId);
    const keys = deps.getEmbeddingKeys();
    const state = ctx.imageIndex;
    if (!records || !keys || !state) return null;
    if (state.vectors && state.vectorsKey === keys.cacheKey) {
      return { records, keys, vectors: state.vectors };
    }
    const loaded = records.length
      ? await deps.loadVectors(
          attachmentId,
          keys.cacheKey,
          records.map((record) => record.imageId),
        )
      : [];
    if (loaded) {
      state.vectors = loaded;
      state.vectorsKey = keys.cacheKey;
    }
    return { records, keys, vectors: loaded };
  }

  /** Images still lacking vectors, for the joint text+image embedding call. */
  async function pendingImageInputs(
    ctx: PdfContext,
    attachmentId: number,
  ): Promise<PendingImageInput[]> {
    const current = await loadCurrent(ctx, attachmentId);
    if (!current || current.vectors) return [];
    if (ctx.imageIndex?.failureKey === current.keys.attemptKey) return [];
    return readItemsOrRebuild(ctx, attachmentId, current.records);
  }

  async function storeImageVectors(
    ctx: PdfContext,
    attachmentId: number,
    pending: PendingImageInput[],
    vectors: number[][],
  ): Promise<void> {
    const keys = deps.getEmbeddingKeys();
    if (!keys || pending.length !== vectors.length) return;
    const imageIds = pending.map((entry) => entry.record.imageId);
    await deps.saveVectors(attachmentId, {
      cacheKey: keys.cacheKey,
      imageIds,
      vectors,
    });
    ctx.imageIndex = {
      ...(ctx.imageIndex || {}),
      vectors,
      vectorsKey: keys.cacheKey,
      failureKey: undefined,
    };
  }

  /** Stops retries until the embedding config or its key changes. */
  function markFailure(ctx: PdfContext): void {
    const keys = deps.getEmbeddingKeys();
    if (!keys) return;
    ctx.imageIndex = { ...(ctx.imageIndex || {}), failureKey: keys.attemptKey };
  }

  async function buildImageVectors(
    ctx: PdfContext,
    attachmentId: number,
  ): Promise<ImageVectorSet | null> {
    const current = await loadCurrent(ctx, attachmentId);
    if (!current) return null;
    if (current.vectors) {
      return { records: current.records, vectors: current.vectors };
    }
    if (ctx.imageIndex?.failureKey === current.keys.attemptKey) return null;
    try {
      const pending = await readItemsOrRebuild(
        ctx,
        attachmentId,
        current.records,
      );
      const vectors = pending.length
        ? await deps.embed(pending.map((entry) => entry.item))
        : [];
      await storeImageVectors(ctx, attachmentId, pending, vectors);
      return { records: pending.map((entry) => entry.record), vectors };
    } catch (error) {
      appLogger.warn("[Embedded images] Image embedding failed", error);
      markFailure(ctx);
      return null;
    }
  }

  /** Retrieval entry point: rebuilds whatever is missing, then returns both. */
  function ensureImageVectors(
    ctx: PdfContext,
    attachmentId: number,
  ): Promise<ImageVectorSet | null> {
    if (!deps.isEnabled()) return Promise.resolve(null);
    const running = inflight.get(ctx);
    if (running) return running;
    const task = buildImageVectors(ctx, attachmentId).finally(() => {
      inflight.delete(ctx);
    });
    inflight.set(ctx, task);
    return task;
  }

  return {
    startExtraction,
    ensureImageSet,
    pendingImageInputs,
    storeImageVectors,
    markFailure,
    ensureImageVectors,
  };
}

export type ImageIndex = ReturnType<typeof createImageIndex>;

async function readBytes(path: string): Promise<Uint8Array | null> {
  try {
    return await IOUtils.read(path);
  } catch {
    return null;
  }
}

const DEFAULT_SOURCE_DEPS: PaperImageSourceDeps = {
  loadMineruManifest: (attachmentId): Promise<MineruManifest | null> =>
    readManifest(attachmentId).catch(() => null),
  mineruItemDir: getMineruItemDir,
  fileExists: async (path) => {
    try {
      return await IOUtils.exists(path);
    } catch {
      return false;
    }
  },
  readCropCache: (itemDir): Promise<PdfFigureCropCache | null> =>
    readPdfFigureCropCacheFromDir(itemDir).catch(() => null),
  readImageAsDataUrl: async (path) => {
    const bytes = await readBytes(path);
    if (!bytes) return null;
    const mimeType = /\.png$/i.test(path) ? "image/png" : "image/jpeg";
    return `data:${mimeType};base64,${encodeBytesBase64(bytes)}`;
  },
  // Notes and text attachments share the retrieval path; only PDFs have images.
  resolvePdfPath: async (attachmentId) => {
    const item = Zotero.Items.get(attachmentId);
    if (!isPdfContextAttachment(item)) return null;
    return (await item.getFilePathAsync()) || null;
  },
  statFile: async (path) => {
    try {
      const info = await IOUtils.stat(path);
      return {
        size: Number(info.size ?? 0),
        lastModified: Number(info.lastModified ?? 0),
      };
    } catch {
      return null;
    }
  },
  readFile: readBytes,
  extractFromPdf: (bytes) => {
    const doc = Zotero.getMainWindow()?.document;
    if (!doc) throw new Error("Zotero main window is unavailable");
    return extractEmbeddedImages({ bytes, doc });
  },
};

export const imageIndex = createImageIndex({
  isEnabled: isImageEmbeddingEnabled,
  getEmbeddingKeys: () => {
    try {
      const { cacheKey, attemptKey } = getResolvedEmbeddingConfig();
      return { cacheKey, attemptKey };
    } catch {
      return null;
    }
  },
  resolveSource: (attachmentId, useMineru) =>
    resolvePaperImageSource({
      attachmentId,
      useMineru,
      deps: DEFAULT_SOURCE_DEPS,
    }),
  compress: async (dataUrl) => {
    const win = Zotero.getMainWindow() as unknown as Window | null;
    return win
      ? optimizeImageDataUrl(win, dataUrl, { mode: "embedding" })
      : dataUrl;
  },
  loadManifest: loadImageManifest,
  saveManifest: saveImageManifest,
  writeImage: writeImageFile,
  readImage: readImageFile,
  loadVectors: loadImageVectors,
  saveVectors: saveImageVectors,
  embed: embedItems,
});
