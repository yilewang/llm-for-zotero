import type { EmbeddingFormatAdapter, EmbeddingRequestFormat } from "../types";
import { dashscopeAdapter } from "./dashscope";
import { openaiCompatAdapter } from "./openaiCompat";
import { vllmMessagesAdapter } from "./vllmMessages";

export function getEmbeddingFormatAdapter(
  format: EmbeddingRequestFormat,
): EmbeddingFormatAdapter {
  switch (format) {
    case "dashscope":
      return dashscopeAdapter;
    case "vllm_messages":
      return vllmMessagesAdapter;
    default:
      return openaiCompatAdapter;
  }
}
