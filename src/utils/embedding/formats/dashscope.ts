import type { EmbeddingFormatAdapter } from "../types";
import { orderEmbeddingRows } from "./rows";

const DASHSCOPE_MULTIMODAL_EMBEDDING_PATH =
  "/services/embeddings/multimodal-embedding/multimodal-embedding";

/**
 * The API URL field usually holds `https://dashscope.aliyuncs.com/api/v1`;
 * a full endpoint URL is used as-is and a bare host gets `/api/v1` added.
 */
export function resolveDashscopeEmbeddingUrl(apiBase: string): string {
  const cleaned = apiBase.trim().replace(/\/+$/, "");
  if (!cleaned) return "";
  if (cleaned.includes("/services/embeddings/")) return cleaned;
  if (/\/api\/v1$/i.test(cleaned)) {
    return `${cleaned}${DASHSCOPE_MULTIMODAL_EMBEDDING_PATH}`;
  }
  return `${cleaned}/api/v1${DASHSCOPE_MULTIMODAL_EMBEDDING_PATH}`;
}

/**
 * DashScope native multimodal embedding. Without `enable_fusion` every
 * content element gets its own vector, so a request can carry a batch.
 */
export const dashscopeAdapter: EmbeddingFormatAdapter = {
  format: "dashscope",
  defaults: { maxItems: 20, maxImages: 5, concurrency: 1 },
  hardLimits: { maxItems: 20, maxImages: 5 },
  resolveUrl: resolveDashscopeEmbeddingUrl,
  buildBody: (model, items) => ({
    model,
    input: {
      contents: items.map((item) =>
        item.kind === "text" ? { text: item.text } : { image: item.dataUrl },
      ),
    },
  }),
  parseResponse: (json) =>
    orderEmbeddingRows(
      (json as { output?: { embeddings?: unknown } } | null)?.output
        ?.embeddings,
    ),
};
