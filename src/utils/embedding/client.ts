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
/** Attempts per batch: the first request plus two retries. */
const MAX_BATCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 500;
const MAX_RETRY_AFTER_MS = 10_000;
/** Rate limits and transient server failures; other statuses fail at once. */
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
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
  /** Waits between retries; injectable so tests do not sleep. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The server's Retry-After in ms, when it sends a usable one. */
function retryAfterMs(res: Response): number | undefined {
  const value = res.headers?.get?.("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

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

  const sleep = deps.sleep ?? defaultSleep;

  /** One batch's response, retrying rate limits and transient failures. */
  const fetchBatch = async (indexes: number[]): Promise<Response> => {
    const payload = JSON.stringify(
      adapter.buildBody(
        config.model,
        indexes.map((index) => prepared[index]),
      ),
    );
    for (let attempt = 1; ; attempt += 1) {
      // Another batch failed while this one waited: the call is already lost.
      if (attempt > 1 && firstError) throw firstError;
      let res: Response;
      try {
        res = await deps.fetchFn(url, {
          method: "POST",
          headers,
          body: payload,
          ...(controller ? { signal: controller.signal } : {}),
        });
      } catch (error) {
        // A network failure is transient; an abort means another batch failed.
        if (
          controller?.signal.aborted ||
          (error as { name?: string })?.name === "AbortError" ||
          attempt >= MAX_BATCH_ATTEMPTS
        ) {
          throw error;
        }
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      if (res.ok) return res;
      if (
        !RETRYABLE_STATUSES.has(res.status) ||
        attempt >= MAX_BATCH_ATTEMPTS
      ) {
        const text = await res.text();
        throw new EmbeddingRequestError({
          format: config.format,
          status: res.status,
          statusText: res.statusText,
          body: text.slice(0, ERROR_BODY_LIMIT),
        });
      }
      await sleep(
        retryAfterMs(res) ?? RETRY_BASE_DELAY_MS * 2 ** (attempt - 1),
      );
    }
  };

  const runBatch = async (indexes: number[]) => {
    const res = await fetchBatch(indexes);
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
