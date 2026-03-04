/**
 * Shared API helpers used by both llmClient and preferenceScript.
 */

// =============================================================================
// Constants
// =============================================================================

export const API_ENDPOINT = "/v1/chat/completions";
export const RESPONSES_ENDPOINT = "/v1/responses";
export const ANTHROPIC_MESSAGES_ENDPOINT = "/v1/messages";
export const EMBEDDINGS_ENDPOINT = "/v1/embeddings";
export const FILES_ENDPOINT = "/v1/files";

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
  const messagesSuffix = "/messages";
  const embeddingSuffix = "/embeddings";
  const filesSuffix = "/files";
  const hasChat = cleaned.endsWith(chatSuffix);
  const hasResponses = cleaned.endsWith(responsesSuffix);
  const hasMessages = cleaned.endsWith(messagesSuffix);
  const hasEmbeddings = cleaned.endsWith(embeddingSuffix);
  const hasFiles = cleaned.endsWith(filesSuffix);

  if (hasChat) {
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, embeddingSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, responsesSuffix);
    }
    if (path === FILES_ENDPOINT) {
      return cleaned.replace(/\/chat\/completions$/, filesSuffix);
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
    if (path === FILES_ENDPOINT) {
      return cleaned.replace(/\/responses$/, filesSuffix);
    }
    return cleaned;
  }

  if (hasMessages) {
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/messages$/, chatSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/messages$/, responsesSuffix);
    }
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/messages$/, embeddingSuffix);
    }
    if (path === FILES_ENDPOINT) {
      return cleaned.replace(/\/messages$/, filesSuffix);
    }
    return cleaned;
  }

  if (hasEmbeddings) {
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/embeddings$/, chatSuffix);
    }
    if (path === FILES_ENDPOINT) {
      return cleaned.replace(/\/embeddings$/, filesSuffix);
    }
    return cleaned;
  }

  if (hasFiles) {
    if (path === API_ENDPOINT) {
      return cleaned.replace(/\/files$/, chatSuffix);
    }
    if (path === RESPONSES_ENDPOINT) {
      return cleaned.replace(/\/files$/, responsesSuffix);
    }
    if (path === EMBEDDINGS_ENDPOINT) {
      return cleaned.replace(/\/files$/, embeddingSuffix);
    }
    return cleaned;
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

/** Build headers for Anthropic-compatible Messages API. */
export function buildAnthropicHeaders(apiKey: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "anthropic-version": "2023-06-01",
  };
  if (apiKey) {
    headers["x-api-key"] = apiKey;
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

/** Check whether the base URL points at an Anthropic-compatible endpoint. */
export function isAnthropicBase(baseOrUrl: string): boolean {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "").toLowerCase();
  if (!cleaned) return false;
  return (
    cleaned.includes("/anthropic") ||
    cleaned.endsWith("/v1/messages") ||
    cleaned.endsWith("/messages")
  );
}
