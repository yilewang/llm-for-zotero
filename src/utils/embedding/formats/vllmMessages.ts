import { EMBEDDINGS_ENDPOINT, resolveEndpoint } from "../../apiHelpers";
import type { EmbeddingFormatAdapter } from "../types";
import { orderEmbeddingRows } from "./rows";

/** Qwen3-VL-Embedding's default instruction, as in its official vLLM example. */
export const VLLM_EMBEDDING_INSTRUCTION = "Represent the user's input.";

/**
 * vLLM chat-style embeddings. Text and images both go through the chat
 * template so they land in the same space; one conversation yields one
 * vector, hence one input per request.
 */
export const vllmMessagesAdapter: EmbeddingFormatAdapter = {
  format: "vllm_messages",
  defaults: { maxItems: 1, maxImages: 1, concurrency: 4 },
  hardLimits: { maxItems: 1, maxImages: 1 },
  resolveUrl: (apiBase) => resolveEndpoint(apiBase, EMBEDDINGS_ENDPOINT),
  buildBody: (model, items) => {
    if (items.length !== 1) {
      throw new Error(
        `vLLM messages embedding takes exactly one input per request, got ${items.length}`,
      );
    }
    const [item] = items;
    return {
      model,
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: VLLM_EMBEDDING_INSTRUCTION }],
        },
        {
          role: "user",
          content: [
            item.kind === "text"
              ? { type: "text", text: item.text }
              : { type: "image_url", image_url: { url: item.dataUrl } },
          ],
        },
      ],
      add_generation_prompt: true,
    };
  },
  parseResponse: (json) =>
    orderEmbeddingRows((json as { data?: unknown } | null)?.data),
};
