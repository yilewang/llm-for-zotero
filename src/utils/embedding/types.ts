/**
 * Shared types for the embedding request layer. Embedding and (later)
 * reranking both consume MultimodalItem, so it lives here rather than in a
 * format adapter.
 */

export type MultimodalItem =
  | { kind: "text"; text: string }
  | { kind: "image"; dataUrl: string };

export const EMBEDDING_REQUEST_FORMATS = [
  "openai_compat",
  "dashscope",
  "vllm_messages",
] as const;

export type EmbeddingRequestFormat = (typeof EMBEDDING_REQUEST_FORMATS)[number];

export function isEmbeddingRequestFormat(
  value: unknown,
): value is EmbeddingRequestFormat {
  return (
    typeof value === "string" &&
    (EMBEDDING_REQUEST_FORMATS as readonly string[]).includes(value)
  );
}

export type EmbeddingBatchLimits = {
  maxItems: number;
  maxImages: number;
  concurrency: number;
};

/** Range the settings page accepts before a format's own hard limits apply. */
export const MAX_EMBEDDING_BATCH_ITEMS = 256;
export const MAX_EMBEDDING_CONCURRENCY = 8;

export type EmbeddingFormatAdapter = {
  format: EmbeddingRequestFormat;
  /** Used when the user leaves a batch field empty. */
  defaults: EmbeddingBatchLimits;
  /** Documented endpoint limits; larger user values are capped to these. */
  hardLimits: { maxItems: number; maxImages: number };
  resolveUrl(apiBase: string): string;
  buildBody(model: string, items: MultimodalItem[]): unknown;
  /** Vectors in input order. Count and shape checks happen in the client. */
  parseResponse(json: unknown): number[][];
};

export class EmbeddingRequestError extends Error {
  readonly format: EmbeddingRequestFormat;
  readonly status: number;
  readonly body: string;

  constructor(params: {
    format: EmbeddingRequestFormat;
    status: number;
    statusText: string;
    body: string;
  }) {
    super(`${params.status} ${params.statusText} - ${params.body}`);
    this.name = "EmbeddingRequestError";
    this.format = params.format;
    this.status = params.status;
    this.body = params.body;
  }
}

export class EmbeddingImageError extends Error {
  readonly itemIndex: number;

  constructor(itemIndex: number, reason: string) {
    super(
      `Image input #${itemIndex} could not be prepared for embedding: ${reason}`,
    );
    this.name = "EmbeddingImageError";
    this.itemIndex = itemIndex;
  }
}
