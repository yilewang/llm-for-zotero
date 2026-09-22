import { EMBEDDINGS_ENDPOINT, resolveEndpoint } from "../../apiHelpers";
import {
  MAX_EMBEDDING_BATCH_ITEMS,
  type EmbeddingFormatAdapter,
} from "../types";
import { orderEmbeddingRows } from "./rows";

/** Inputs per request before batching became configurable. */
const EMBEDDING_BATCH_SIZE = 16;

/**
 * OpenAI-compatible /embeddings. Text inputs stay plain strings so a
 * text-only request is byte-identical to the pre-multimodal client; images
 * use the `{image}` object SiliconFlow accepts in the same list.
 */
export const openaiCompatAdapter: EmbeddingFormatAdapter = {
  format: "openai_compat",
  defaults: { maxItems: EMBEDDING_BATCH_SIZE, maxImages: 4, concurrency: 1 },
  hardLimits: {
    maxItems: MAX_EMBEDDING_BATCH_ITEMS,
    maxImages: MAX_EMBEDDING_BATCH_ITEMS,
  },
  resolveUrl: (apiBase) => resolveEndpoint(apiBase, EMBEDDINGS_ENDPOINT),
  buildBody: (model, items) => ({
    model,
    input: items.map((item) =>
      item.kind === "text" ? item.text : { image: item.dataUrl },
    ),
  }),
  parseResponse: (json) =>
    orderEmbeddingRows((json as { data?: unknown } | null)?.data),
};
