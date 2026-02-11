/**
 * Shared API helpers used by both llmClient and preferenceScript.
 */

// =============================================================================
// Constants
// =============================================================================

export const API_ENDPOINT = "/v1/chat/completions";
export const RESPONSES_ENDPOINT = "/v1/responses";
export const EMBEDDINGS_ENDPOINT = "/v1/embeddings";

// =============================================================================
// Functions
// =============================================================================

/**
 * Resolve a full API endpoint URL from a (possibly already-suffixed) base URL
 * and the desired path (e.g. `/v1/chat/completions`).
 */
export function resolveEndpoint(baseOrUrl: string, path: string): string {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "");
  if (!cleaned) return "";
  const chatSuffix = "/chat/completions";
  const responsesSuffix = "/responses";
  const embeddingSuffix = "/embeddings";
  const hasChat = cleaned.endsWith(chatSuffix);
  const hasResponses = cleaned.endsWith(responsesSuffix);
  const hasEmbeddings = cleaned.endsWith(embeddingSuffix);

  if (hasChat) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, embeddingSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, responsesSuffix);
    }
    return cleaned;
  }

  if (hasResponses) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/responses$/, embeddingSuffix);
    }
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/responses$/, chatSuffix);
    }
    return cleaned;
  }

  if (hasEmbeddings) {
    return path === API_ENDPOINT
      ? cleaned.replace(/\/embeddings$/, chatSuffix)
      : cleaned;
  }

  // If a version segment is already present (e.g., /v1 or /v1beta),
  // avoid appending a second /v1 from the default OpenAI path.
  const hasVersion = /\/v\d+(?:beta)?\b/.test(cleaned);
  const normalizedPath =
    hasVersion && path.startsWith("/v1/") ? path.replace(/^\/v1\//, "/") : path;

  return `${cleaned}${normalizedPath}`;
}

/** Build standard request headers for LLM API calls. */
export function buildHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return headers;
}

/** Check whether a model name implies `max_completion_tokens` instead of `max_tokens`. */
export function usesMaxCompletionTokens(model: string): boolean {
  const name = model.toLowerCase();
  return (
    name.startsWith("gpt-5") ||
    name.startsWith("o") ||
    name.includes("reasoning")
  );
}

/** Check whether the base URL points at a Responses API endpoint. */
export function isResponsesBase(baseOrUrl: string): boolean {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "");
  return cleaned.endsWith("/v1/responses") || cleaned.endsWith("/responses");
}
