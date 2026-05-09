import {
  API_ENDPOINT,
  RESPONSES_ENDPOINT,
  buildHeaders,
  resolveEndpoint,
} from "./apiHelpers";
import type { ModelProviderAuthMode } from "./modelProviders";
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

function rewriteApiBasePath(parsed: ParsedApiBase, pathname: string): string {
  return `${parsed.origin}${pathname}`;
}

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
    return resolveEndpoint(params.apiBase, RESPONSES_ENDPOINT);
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
  return resolveGeminiNativeEndpoint({
    apiBase: params.apiBase,
    model: params.model || "",
    stream: params.stream,
  });
}

export function buildProviderTransportHeaders(params: {
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
  return {
    "Content-Type": "application/json",
    "x-goog-api-key": params.apiKey,
  };
}
