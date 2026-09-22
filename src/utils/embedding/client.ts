import { estimateDataUrlByteLength } from "../imageOptimization";
import { planEmbeddingBatches } from "./batching";
import { getEmbeddingFormatAdapter } from "./formats";
import {
  EmbeddingImageError,
  EmbeddingRequestError,
  type EmbeddingBatchLimits,
  type EmbeddingRequestFormat,
  type MultimodalItem,
} from "./types";

/** DashScope caps an image at 5 MB; stay below it after compression. */
export const MAX_EMBEDDING_IMAGE_BYTES = 4 * 1024 * 1024;
const ERROR_BODY_LIMIT = 500;
const IMAGE_DATA_URL_PATTERN = /^data:image\/[a-z0-9.+-]+;base64,/i;

export type EmbeddingRequestConfig = {
  apiBase: string;
  apiKey: string;
  model: string;
  format: EmbeddingRequestFormat;
  limits: EmbeddingBatchLimits;
  /** Guard: a text-only model must never receive an image. */
  allowImages: boolean;
};

export type EmbeddingClientDeps = {
  fetchFn: typeof fetch;
  buildHeaders: (apiKey: string) => Record<string, string>;
  normalizeImage: (dataUrl: string) => Promise<string>;
  createAbortController?: () => AbortController | undefined;
};

async function prepareItems(
  items: MultimodalItem[],
  normalizeImage: EmbeddingClientDeps["normalizeImage"],
): Promise<MultimodalItem[]> {
  return Promise.all(
    items.map(async (item, index): Promise<MultimodalItem> => {
      if (item.kind === "text") return item;
      let dataUrl: string;
      try {
        dataUrl = await normalizeImage(item.dataUrl);
      } catch (error) {
        throw new EmbeddingImageError(
          index,
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!IMAGE_DATA_URL_PATTERN.test(dataUrl)) {
        throw new EmbeddingImageError(index, "not a base64 image data URL");
      }
      const bytes = estimateDataUrlByteLength(dataUrl);
      if (bytes > MAX_EMBEDDING_IMAGE_BYTES) {
        throw new EmbeddingImageError(
          index,
          `${bytes} bytes after compression exceeds ${MAX_EMBEDDING_IMAGE_BYTES}`,
        );
      }
      return { kind: "image", dataUrl };
    }),
  );
}

/**
 * Embeds text and image inputs with one request format. Returns one vector
 * per input, in input order. Any failed batch rejects the whole call; a
 * partial result would misalign vectors with their inputs.
 */
export async function embedItemsWithConfig(
  items: MultimodalItem[],
  config: EmbeddingRequestConfig,
  deps: EmbeddingClientDeps,
): Promise<number[][]> {
  if (!items.length) return [];
  if (!config.allowImages && items.some((item) => item.kind === "image")) {
    throw new Error(
      "Image input is not enabled for the configured embedding model.",
    );
  }
  const adapter = getEmbeddingFormatAdapter(config.format);
  const prepared = await prepareItems(items, deps.normalizeImage);
  const batches = planEmbeddingBatches(prepared, {
    maxItems: Math.min(config.limits.maxItems, adapter.hardLimits.maxItems),
    maxImages: Math.min(config.limits.maxImages, adapter.hardLimits.maxImages),
  });
  const url = adapter.resolveUrl(config.apiBase);
  const headers = deps.buildHeaders(config.apiKey);
  const controller = deps.createAbortController?.();
  const results: number[][] = new Array(items.length);
  let firstError: unknown = null;
  let nextBatch = 0;

  const runBatch = async (indexes: number[]) => {
    const res = await deps.fetchFn(url, {
      method: "POST",
      headers,
      body: JSON.stringify(
        adapter.buildBody(
          config.model,
          indexes.map((index) => prepared[index]),
        ),
      ),
      ...(controller ? { signal: controller.signal } : {}),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new EmbeddingRequestError({
        format: config.format,
        status: res.status,
        statusText: res.statusText,
        body: text.slice(0, ERROR_BODY_LIMIT),
      });
    }
    const vectors = adapter.parseResponse(await res.json());
    if (vectors.length !== indexes.length) {
      throw new Error(
        `Embedding endpoint returned ${vectors.length} vectors for ${indexes.length} inputs.`,
      );
    }
    vectors.forEach((vector, offset) => {
      if (!vector.length) {
        throw new Error(
          `Embedding endpoint returned an empty vector for input #${indexes[offset]}.`,
        );
      }
      results[indexes[offset]] = vector;
    });
  };

  const worker = async () => {
    while (!firstError && nextBatch < batches.length) {
      const batch = batches[nextBatch++];
      try {
        await runBatch(batch);
      } catch (error) {
        if (!firstError) {
          firstError = error;
          controller?.abort();
        }
      }
    }
  };

  const workerCount = Math.min(
    Math.max(1, Math.floor(config.limits.concurrency)),
    batches.length,
  );
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  if (firstError) throw firstError;

  const dimension = results[0].length;
  const mismatch = results.findIndex((vector) => vector.length !== dimension);
  if (mismatch >= 0) {
    throw new Error(
      `Embedding dimensions differ within one call (${dimension} vs ${results[mismatch].length}).`,
    );
  }
  return results;
}
