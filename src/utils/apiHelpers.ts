/**
 * Shared API helpers used by both llmClient and preferenceScript.
 */

// =============================================================================
// Constants
// =============================================================================

export const API_ENDPOINT = "/v1/chat/completions";
export const RESPONSES_ENDPOINT = "/v1/responses";
export const EMBEDDINGS_ENDPOINT = "/v1/embeddings";
export const FILES_ENDPOINT = "/v1/files";

/**
 * Ollama's native chat endpoint.
 *
 * The stored base is usually the bare origin (`http://localhost:11434`), but
 * users routinely paste the OpenAI-compatible base instead, and a reverse proxy
 * may add a path prefix. Strip a trailing `/v1` or an already-present `/api/...`
 * suffix so all three land on `<prefix>/api/chat` rather than `/v1/api/chat` or
 * `/api/chat/api/chat`.
 *
 * Lives here rather than in providerTransport so the capability layer can reach
 * it without importing the transport module, which would close an import cycle
 * back through modelProviders.
 */
export function resolveOllamaNativeEndpoint(apiBase: string): string {
  const cleaned = (apiBase || "").trim().replace(/\/+$/, "");
  if (!cleaned) return cleaned;
  let parsed: URL;
  try {
    parsed = new URL(cleaned);
  } catch (_error) {
    return cleaned;
  }
  let path = parsed.pathname.replace(/\/+$/, "");
  path = path.replace(/\/v1$/i, "");
  path = path.replace(/\/api(?:\/(?:chat|generate|tags|show|version))?$/i, "");
  return `${parsed.origin}${path}/api/chat`;
}

/** Base for Ollama's native metadata endpoints (`/api/tags`, `/api/show`). */
export function resolveOllamaNativeApiRoot(apiBase: string): string {
  return resolveOllamaNativeEndpoint(apiBase).replace(/\/chat$/, "");
}

/**
 * AbortController is not guaranteed in Zotero's Gecko chrome context. Every
 * fetch-with-timeout in the plugin must go through this one guarded lookup so
 * a future fallback (or a platform change) lands everywhere at once.
 */
export function getAbortController(): typeof AbortController | undefined {
  return (globalThis as unknown as { AbortController?: typeof AbortController })
    .AbortController;
}

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
  const lowerCleaned = cleaned.toLowerCase();
  if (lowerCleaned.includes("chatgpt.com/backend-api/codex/responses")) {
    return cleaned;
  }
  // Expand bare Gemini base URLs (e.g. https://generativelanguage.googleapis.com)
  // to include the required OpenAI-compatibility sub-path (/v1beta/openai).
  // The normalized URL already contains /openai so this branch won't fire again.
  const geminiNormalized = normalizeGeminiApiBase(cleaned);
  if (geminiNormalized !== cleaned) {
    return resolveEndpoint(geminiNormalized, path);
  }
  const chatSuffix = "/chat/completions";
  const responsesSuffix = "/responses";
  const embeddingSuffix = "/embeddings";
  const filesSuffix = "/files";
  const hasChat = cleaned.endsWith(chatSuffix);
  const hasResponses = cleaned.endsWith(responsesSuffix);
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
  const cleaned = baseOrUrl.trim().replace(/\/+$/, "");
  if (!cleaned) return false;
  try {
    const pathname = new URL(cleaned).pathname
      .replace(/\/+$/, "")
      .toLowerCase();
    return pathname.endsWith("/responses");
  } catch (_err) {
    return cleaned.toLowerCase().endsWith("/responses");
  }
}

/** Check whether the base URL points at a Gemini (generativelanguage.googleapis.com) endpoint. */
export function isGeminiBase(baseOrUrl: string): boolean {
  return /generativelanguage\.googleapis\.com/.test(baseOrUrl);
}

/**
 * Expand a bare Gemini base URL to include the required OpenAI-compatibility
 * sub-path (`/v1beta/openai`).  Any URL that already contains `/openai` is
 * returned unchanged, so fully-qualified Gemini endpoints are safe to pass.
 *
 * Examples:
 *   https://generativelanguage.googleapis.com          → …/v1beta/openai
 *   https://generativelanguage.googleapis.com/v1beta   → …/v1beta/openai
 *   https://generativelanguage.googleapis.com/v1beta/openai → unchanged
 *   https://generativelanguage.googleapis.com/v1beta/openai/responses → unchanged
 */
export function normalizeGeminiApiBase(baseOrUrl: string): string {
  const cleaned = baseOrUrl.trim().replace(/\/$/, "");
  if (!isGeminiBase(cleaned)) return cleaned;
  // Already routed through the OpenAI compat layer
  if (cleaned.includes("/openai")) return cleaned;
  // Find the version segment (/v1beta, /v1, …) and inject /openai after it
  const versionMatch = cleaned.match(/\/v\d+(?:beta)?(?=\/|$)/);
  if (versionMatch) {
    const idx = cleaned.indexOf(versionMatch[0]) + versionMatch[0].length;
    return `${cleaned.slice(0, idx)}/openai${cleaned.slice(idx)}`;
  }
  // No version segment — append the default Gemini compat path
  return `${cleaned}/v1beta/openai`;
}
