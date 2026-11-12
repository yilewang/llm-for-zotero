import {
  API_ENDPOINT,
  RESPONSES_ENDPOINT,
  buildHeaders,
  resolveEndpoint,
  resolveOllamaNativeApiRoot,
  resolveOllamaNativeEndpoint,
} from "./apiHelpers";
import {
  createProviderOperationId,
  resolveProviderSessionId,
} from "./providerSessionId";
import { version } from "../../package.json";
import type { ModelProviderAuthMode } from "./modelProviders";
import { detectProviderPreset } from "./providerPresets";
import type { ProviderProtocol } from "./providerProtocol";

const ANTHROPIC_VERSION = "2023-06-01";

type ParsedApiBase = {
  origin: string;
  hostname: string;
  pathname: string;
};

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function parseApiBase(apiBase: string): ParsedApiBase | null {
  const cleaned = trimTrailingSlash(apiBase);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return {
      origin: parsed.origin,
      hostname: parsed.hostname.trim().toLowerCase(),
      pathname: parsed.pathname.replace(/\/+$/, "") || "/",
    };
  } catch (_error) {
    return null;
  }
}

function isMiniMaxHost(parsed: ParsedApiBase | null): boolean {
  return Boolean(
    parsed &&
    (parsed.hostname === "api.minimax.io" ||
      parsed.hostname === "api.minimaxi.com"),
  );
}

function isBigModelHost(parsed: ParsedApiBase | null): boolean {
  return Boolean(parsed && parsed.hostname === "open.bigmodel.cn");
}

function isDeepSeekHost(parsed: ParsedApiBase | null): boolean {
  return Boolean(parsed && parsed.hostname === "api.deepseek.com");
}

function isQwenHost(parsed: ParsedApiBase | null): boolean {
  return Boolean(
    parsed &&
    (parsed.hostname === "dashscope.aliyuncs.com" ||
      parsed.hostname === "dashscope-intl.aliyuncs.com" ||
      parsed.hostname === "dashscope-us.aliyuncs.com"),
  );
}

function rewriteApiBasePath(parsed: ParsedApiBase, pathname: string): string {
  return `${parsed.origin}${pathname}`;
}

export { resolveOllamaNativeApiRoot, resolveOllamaNativeEndpoint };

export function normalizeOpenAICompatibleBase(apiBase: string): string {
  const cleaned = trimTrailingSlash(apiBase);
  const parsed = parseApiBase(cleaned);
  if (!parsed) return cleaned;

  if (isMiniMaxHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/anthropic" ||
      parsed.pathname === "/anthropic/v1" ||
      parsed.pathname === "/anthropic/v1/messages"
    ) {
      return rewriteApiBasePath(parsed, "/v1");
    }
  }

  if (isBigModelHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/api/anthropic" ||
      parsed.pathname === "/api/anthropic/v1" ||
      parsed.pathname === "/api/anthropic/v1/messages"
    ) {
      return rewriteApiBasePath(parsed, "/api/paas/v4");
    }
  }

  if (isDeepSeekHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/anthropic" ||
      parsed.pathname === "/anthropic/v1" ||
      parsed.pathname === "/anthropic/v1/messages"
    ) {
      return rewriteApiBasePath(parsed, "/v1");
    }
  }

  if (isQwenHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/api/v2/apps/protocols/compatible-mode/v1" ||
      parsed.pathname === "/api/v2/apps/protocols/compatible-mode/v1/responses"
    ) {
      return rewriteApiBasePath(parsed, "/compatible-mode/v1");
    }
  }

  return cleaned;
}

function normalizeQwenResponsesBase(apiBase: string): string {
  const cleaned = trimTrailingSlash(apiBase);
  const parsed = parseApiBase(cleaned);
  if (!parsed || !isQwenHost(parsed)) return cleaned;
  if (
    parsed.pathname === "/" ||
    parsed.pathname === "/compatible-mode/v1" ||
    parsed.pathname === "/compatible-mode/v1/chat/completions" ||
    parsed.pathname === "/compatible-mode/v1/responses"
  ) {
    return rewriteApiBasePath(
      parsed,
      "/api/v2/apps/protocols/compatible-mode/v1",
    );
  }
  return cleaned;
}

function normalizeAnthropicCompatibleBase(apiBase: string): string {
  const cleaned = trimTrailingSlash(apiBase);
  const parsed = parseApiBase(cleaned);
  if (!parsed) return cleaned;

  if (isMiniMaxHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/v1" ||
      parsed.pathname === "/v1/chat/completions"
    ) {
      return rewriteApiBasePath(parsed, "/anthropic");
    }
  }

  if (isBigModelHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/api/paas/v4" ||
      parsed.pathname === "/api/paas/v4/chat/completions" ||
      parsed.pathname === "/api/coding/paas/v4" ||
      parsed.pathname === "/api/coding/paas/v4/chat/completions"
    ) {
      return rewriteApiBasePath(parsed, "/api/anthropic");
    }
  }

  if (isDeepSeekHost(parsed)) {
    if (
      parsed.pathname === "/" ||
      parsed.pathname === "/v1" ||
      parsed.pathname === "/v1/chat/completions"
    ) {
      return rewriteApiBasePath(parsed, "/anthropic");
    }
  }

  return cleaned;
}

export function normalizeAnthropicMessagesBase(apiBase: string): string {
  const cleaned = normalizeAnthropicCompatibleBase(apiBase);
  if (!cleaned) return "";
  return cleaned.replace(/\/messages$/i, "");
}

export function resolveAnthropicMessagesEndpoint(apiBase: string): string {
  const cleaned = normalizeAnthropicMessagesBase(apiBase);
  if (!cleaned) return "";
  if (/\/v\d+(?:beta)?$/i.test(cleaned)) {
    return `${cleaned}/messages`;
  }
  return `${cleaned}/v1/messages`;
}

export function normalizeGeminiNativeBase(apiBase: string): string {
  const cleaned = trimTrailingSlash(apiBase);
  if (!cleaned) return "";
  let normalized = cleaned;
  normalized = normalized.replace(
    /\/v\d+(?:beta)?\/openai(?:\/(?:chat\/completions|responses|files))?$/i,
    "/v1beta",
  );
  normalized = normalized.replace(
    /\/models\/[^/]+:(?:generateContent|streamGenerateContent)(?:\?.*)?$/i,
    "",
  );
  if (!/\/v\d+(?:beta)?\b/i.test(normalized)) {
    normalized = `${normalized}/v1beta`;
  }
  return normalized;
}

export function resolveGeminiNativeEndpoint(params: {
  apiBase: string;
  model: string;
  stream?: boolean;
}): string {
  const base = normalizeGeminiNativeBase(params.apiBase);
  if (!base) return "";
  const modelName = encodeURIComponent((params.model || "").trim());
  const action = params.stream
    ? "streamGenerateContent?alt=sse"
    : "generateContent";
  return `${base}/models/${modelName}:${action}`;
}

function isCopilotHost(apiBase: string): boolean {
  const parsed = parseApiBase(apiBase);
  return Boolean(parsed && parsed.hostname.includes("githubcopilot.com"));
}

export function resolveProviderTransportEndpoint(params: {
  protocol: ProviderProtocol;
  apiBase: string;
  model?: string;
  stream?: boolean;
  authMode?: ModelProviderAuthMode;
}): string {
  if (
    params.protocol === "codex_responses" ||
    params.protocol === "responses_api"
  ) {
    // Copilot uses /responses (no /v1 prefix)
    if (params.authMode === "copilot_auth" || isCopilotHost(params.apiBase)) {
      const base = trimTrailingSlash(params.apiBase);
      return `${base}/responses`;
    }
    return resolveEndpoint(
      normalizeQwenResponsesBase(params.apiBase),
      RESPONSES_ENDPOINT,
    );
  }
  if (params.protocol === "openai_chat_compat") {
    if (params.authMode === "copilot_auth" || isCopilotHost(params.apiBase)) {
      const base = trimTrailingSlash(params.apiBase);
      return `${base}/chat/completions`;
    }
    return resolveEndpoint(
      normalizeOpenAICompatibleBase(params.apiBase),
      API_ENDPOINT,
    );
  }
  if (params.protocol === "anthropic_messages") {
    return resolveAnthropicMessagesEndpoint(params.apiBase);
  }
  if (params.protocol === "ollama_native") {
    return resolveOllamaNativeEndpoint(params.apiBase);
  }
  return resolveGeminiNativeEndpoint({
    apiBase: params.apiBase,
    model: params.model || "",
    stream: params.stream,
  });
}

/** Identity belongs to a conversation or to one standalone operation, never a retry. */
export type ProviderRequestScope =
  | { conversationKey: number | string }
  | { operationId: string };

export function createProviderRequestScope(
  conversationKey?: number | string | null,
): ProviderRequestScope {
  if (
    conversationKey !== undefined &&
    conversationKey !== null &&
    String(conversationKey).trim()
  ) {
    return { conversationKey };
  }
  return { operationId: createProviderOperationId() };
}

/**
 * Shared HTTP dispatch boundary for configurable model inference. Requirements
 * are applied to the actual destination, after protocol/auth headers are built.
 * Callers cannot opt out by forgetting to identify the provider or its headers.
 */
export async function sendProviderRequest(params: {
  url: string;
  scope: ProviderRequestScope;
  fetchFn: typeof fetch;
  init: RequestInit;
}): Promise<Response> {
  const preset = detectProviderPreset(params.url);
  if (preset !== "opencode" && preset !== "opencode_go") {
    return params.fetchFn(params.url, params.init);
  }
  const sessionId =
    "conversationKey" in params.scope
      ? await resolveProviderSessionId(params.scope.conversationKey)
      : params.scope.operationId;
  if (!sessionId?.trim()) {
    throw new Error(
      "OpenCode requires a stable request session; no request was sent.",
    );
  }
  // Preserve authentication and protocol headers, but always own routing headers.
  const headers = Object.fromEntries(
    new Headers(params.init.headers).entries(),
  );
  headers["x-opencode-session"] = sessionId;
  headers["user-agent"] = `llm-for-zotero/${version}`;
  return params.fetchFn(params.url, { ...params.init, headers });
}

export function buildProviderAuthHeaders(params: {
  protocol: ProviderProtocol;
  apiKey: string;
  authMode?: ModelProviderAuthMode;
}): Record<string, string> {
  if (
    params.protocol === "codex_responses" ||
    params.protocol === "responses_api" ||
    params.protocol === "openai_chat_compat"
  ) {
    if (params.authMode === "copilot_auth") {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${params.apiKey}`,
        "Copilot-Integration-Id": "vscode-chat",
        "Editor-Version": "vscode/1.96.0",
        "Editor-Plugin-Version": "copilot-chat/0.24.2",
        "Openai-Intent": "conversation-panel",
      };
    }
    return buildHeaders(params.apiKey);
  }
  if (params.protocol === "anthropic_messages") {
    return {
      "Content-Type": "application/json",
      "x-api-key": params.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
    };
  }
  if (params.protocol === "ollama_native") {
    // Ollama serves unauthenticated; a key is only present when the user has
    // put it behind a reverse proxy, so send the header only when set.
    return params.apiKey
      ? {
          "Content-Type": "application/json",
          Authorization: `Bearer ${params.apiKey}`,
        }
      : { "Content-Type": "application/json" };
  }
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": params.apiKey,
  };
}
