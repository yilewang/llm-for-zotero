/**
 * LLM API Client
 *
 * Provides streaming and non-streaming API calls to OpenAI-compatible endpoints.
 */

import { config } from "../../package.json";
import { DEFAULT_MAX_TOKENS, DEFAULT_SYSTEM_PROMPT } from "./llmDefaults";
import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
  getGrokReasoningProfileForModel,
  getMimoReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getQwenReasoningProfileForModel,
  getReasoningDefaultLevelForModel,
  getRuntimeReasoningOptionsForModel,
  supportsReasoningForModel,
  withGeminiThoughtSummaries,
} from "./reasoningProfiles";
import type {
  ReasoningProvider,
  ReasoningLevel,
  OpenAIReasoningEffort,
  OpenAIReasoningProfile,
  GeminiThinkingParam,
  GeminiThinkingValue,
  GeminiReasoningOption,
  GeminiReasoningProfile,
  AnthropicAdaptiveEffort,
  AnthropicThinkingMode,
  AnthropicReasoningProfile,
  QwenReasoningProfile,
  RuntimeReasoningOption,
} from "./reasoningProfiles";
import type {
  ChatMessage,
  ImageContent,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
export type {
  ChatMessage,
  ImageContent,
  MessageContent,
  ReasoningConfig,
  ReasoningEvent,
  TextContent,
  UsageStats,
} from "../shared/llm";
import {
  EMBEDDINGS_ENDPOINT,
  FILES_ENDPOINT,
  resolveEndpoint,
  usesMaxCompletionTokens,
} from "./apiHelpers";
import { pathToFileUrl } from "./localPath";
import { fingerprintSecret } from "./secretFingerprint";
import {
  normalizeMaxTokens,
  normalizeTemperature,
  normalizeMaxTokensForModel,
  resolveGeminiTemperature,
} from "./normalization";
import {
  getDefaultModelEntry,
  getDefaultProviderGroup,
  getModelProviderGroups,
  type ModelProviderAuthMode,
} from "./modelProviders";
import {
  detectProviderPreset,
  getProviderPreset,
  isGrokApiBase,
  providerSupportsResponsesEndpoint,
} from "./providerPresets";
import {
  inferLegacyProviderProtocol,
  type ProviderProtocol,
} from "./providerProtocol";
import {
  buildProviderTransportHeaders,
  resolveAnthropicMessagesEndpoint,
  resolveGeminiNativeEndpoint,
  resolveOllamaNativeEndpoint,
  resolveProviderTransportEndpoint,
} from "./providerTransport";
import { parseDataUrl } from "../shared/dataUrl";
import { readFileRefAsBase64 } from "../agent/model/shared";
import { buildMultipartRequest } from "./multipart";
import {
  applyModelInputTokenCap,
  estimateConversationTokens,
  resolveModelInputTokenLimit,
  type InputCapResult,
} from "./modelInputCap";
import { resolveProviderCapabilities } from "../providers";
import {
  extractContextCacheUsage,
  type ContextCachePlan,
} from "../contextCache/manager";
import type { ModelInputMode } from "../shared/types";
import {
  compileReasoningControls,
  ensureModelCapabilities,
  getModelCapabilities,
  isRecord,
  isReservedRequestKey,
  profileOverrideAppliesTo,
  type ModelProfileOverride,
} from "../modelCapabilities";
import {
  CODEX_DIRECT_RESPONSES_URL,
  buildCodexAuthHeaders,
  refreshCodexAuthSession,
  resolveCodexAuthSession,
} from "../codexAuth/auth";
import {
  assertCodexDirectModelAvailable,
  sanitizeCodexDirectReasoningConfig,
} from "../codexAuth/modelCatalog";

// =============================================================================
// Types
// =============================================================================

export type ChatFileAttachment = {
  name: string;
  mimeType?: string;
  storedPath?: string;
  contentHash?: string;
};

export type ChatParams = {
  prompt: string;
  context?: string;
  history?: ChatMessage[];
  signal?: AbortSignal;
  /** Base64 data URL of an image to include with the prompt (legacy single-image field) */
  image?: string;
  /** Base64 data URLs to include with the prompt */
  images?: string[];
  /** Override model for this request */
  model?: string;
  /** Override API base for this request */
  apiBase?: string;
  /** Override API key for this request */
  apiKey?: string;
  /** Override auth mode for this request */
  authMode?: ModelProviderAuthMode;
  /** Optional reasoning control from UI */
  reasoning?: ReasoningConfig;
  /** Optional custom sampling temperature */
  temperature?: number;
  /** Optional custom token budget for completion/output */
  maxTokens?: number;
  /** Whether maxTokens was deliberately set rather than inherited as a default. */
  maxTokensExplicit?: boolean;
  /** Optional override for input token cap. */
  inputTokenCap?: number;
  /** Optional per-model input capability override. Missing means auto. */
  inputMode?: ModelInputMode;
  /** Local files to upload and attach when using Responses API */
  attachments?: ChatFileAttachment[];
  /** Extra system-only guidance added to the same request */
  systemMessages?: string[];
  /** Override provider protocol for this request */
  providerProtocol?: ProviderProtocol;
  /** Provider-side prompt/context cache plan resolved by the context planner. */
  contextCache?: ContextCachePlan;
  /**
   * User-authored capability overrides for the selected model. Threaded through
   * so capability resolution, token clamping and the request body all see the
   * same picture the preferences pane showed.
   */
  profileOverride?: ModelProfileOverride;
};

export type ContextBudgetPlan = {
  modelLimitTokens: number;
  limitTokens: number;
  softLimitTokens: number;
  baseInputTokens: number;
  outputReserveTokens: number;
  reasoningReserveTokens: number;
  contextBudgetTokens: number;
};

export type PreparedChatRequest = {
  apiBase: string;
  apiKey: string;
  authMode: ModelProviderAuthMode;
  model: string;
  systemPrompt: string;
  messages: ChatMessage[];
  inputCap: InputCapResult;
  providerProtocol: ProviderProtocol;
  contextCache?: ContextCachePlan;
};

interface StreamChoice {
  delta?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    thought?: unknown;
  };
  message?: {
    content?: unknown;
    reasoning_content?: unknown;
    reasoning?: unknown;
    thinking?: unknown;
    thought?: unknown;
  };
}

interface CompletionResponse {
  choices?: Array<{
    message?: { content?: string };
    text?: string;
  }>;
}

interface EmbeddingResponse {
  data?: Array<{ index?: number; embedding?: number[] }>;
}

type NativePdfPart = {
  base64: string;
};

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_CODEX_API_BASE = CODEX_DIRECT_RESPONSES_URL;

const COPILOT_GITHUB_CLIENT_ID = "Iv1.b507a08c87ecfe98";
const COPILOT_DEVICE_CODE_URL = "https://github.com/login/device/code";
const COPILOT_OAUTH_TOKEN_URL = "https://github.com/login/oauth/access_token";
const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_COPILOT_API_BASE = "https://api.githubcopilot.com";

// =============================================================================
// Utilities
// =============================================================================

const prefKey = (key: string) => `${config.prefsPrefix}.${key}`;
const getPref = (key: string) => Zotero.Prefs.get(prefKey(key), true) as string;

function getApiConfig(overrides?: {
  apiBase?: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  model?: string;
  providerProtocol?: ProviderProtocol;
}) {
  const defaultEntry = getDefaultModelEntry();
  const defaultProviderGroup = getDefaultProviderGroup();
  const authMode = (overrides?.authMode ||
    defaultEntry?.authMode ||
    defaultProviderGroup?.authMode ||
    "api_key") as ModelProviderAuthMode;
  const prefApiBase =
    defaultEntry?.apiBase ||
    defaultProviderGroup?.apiBase ||
    getPref("apiBasePrimary") ||
    getPref("apiBase") ||
    "";
  const resolvedApiBase =
    authMode === "codex_auth"
      ? DEFAULT_CODEX_API_BASE
      : overrides?.apiBase ||
        prefApiBase ||
        (authMode === "codex_app_server"
          ? DEFAULT_CODEX_API_BASE
          : authMode === "copilot_auth"
            ? DEFAULT_COPILOT_API_BASE
            : "");
  const apiBase = resolvedApiBase.trim().replace(/\/$/, "");
  const apiKey = (
    overrides?.apiKey ||
    defaultEntry?.apiKey ||
    defaultProviderGroup?.apiKey ||
    getPref("apiKeyPrimary") ||
    getPref("apiKey") ||
    ""
  ).trim();
  const modelPrimary =
    defaultEntry?.model ||
    getPref("modelPrimary") ||
    getPref("model") ||
    DEFAULT_MODEL;
  const model = (overrides?.model || modelPrimary).trim();
  const embeddingModel = getPref("embeddingModel") || DEFAULT_EMBEDDING_MODEL;
  const customSystemPrompt = getPref("systemPrompt") || "";
  const providerProtocol: ProviderProtocol = (() => {
    if (authMode === "codex_auth") return "codex_responses";
    if (overrides?.providerProtocol) return overrides.providerProtocol;
    // Only inherit the configured group protocol when we are actually using that
    // group's base URL. If the caller supplied their own apiBase override, derive
    // the protocol from that URL instead so the correct transport is selected
    // (e.g. a Grok /v1/responses URL should use responses_api, not the
    // openai_chat_compat default from an unrelated legacy group entry).
    if (!overrides?.apiBase) {
      if (defaultEntry?.providerProtocol) return defaultEntry.providerProtocol;
      if (defaultProviderGroup?.providerProtocol)
        return defaultProviderGroup.providerProtocol;
    }
    return inferLegacyProviderProtocol({ authMode, apiBase });
  })();

  if (!apiBase) {
    throw new Error("API URL is missing in preferences");
  }

  return {
    apiBase,
    apiKey,
    authMode,
    model,
    embeddingModel,
    systemPrompt: customSystemPrompt
      ? `${DEFAULT_SYSTEM_PROMPT}\n\n${customSystemPrompt}`
      : DEFAULT_SYSTEM_PROMPT,
    providerProtocol,
  };
}

export type ResolvedEmbeddingConfig = {
  apiBase: string;
  apiKey: string;
  model: string;
  providerKey: string;
  cacheKey: string;
  attemptKey: string;
};

function normalizeEmbeddingApiBase(apiBase: string): string {
  return apiBase.trim().replace(/\/+$/, "");
}

const fingerprintEmbeddingSecret = fingerprintSecret;

function resolveSeparateEmbeddingApiKey(embeddingProvider: string): string {
  const explicitKey = (getPref("embeddingApiKey") || "").toString().trim();
  if (explicitKey || embeddingProvider === "custom") return explicitKey;

  const groups = getModelProviderGroups();
  for (const group of groups) {
    if (group.authMode !== "api_key" || !group.apiKey.trim()) continue;
    if (detectProviderPreset(group.apiBase) === embeddingProvider) {
      return group.apiKey.trim();
    }
  }
  return "";
}

export function getResolvedEmbeddingConfig(): ResolvedEmbeddingConfig {
  const embeddingProvider = (getPref("embeddingProvider") || "")
    .toString()
    .trim();
  const embeddingApiBase = normalizeEmbeddingApiBase(
    (getPref("embeddingApiBase") || "").toString(),
  );
  const explicitEmbeddingModel = (getPref("embeddingModel") || "")
    .toString()
    .trim();

  if (!embeddingApiBase) {
    throw new Error(
      "No embedding provider configured. Enable semantic search and select a provider in Settings → Customization.",
    );
  }

  const apiKey = resolveSeparateEmbeddingApiKey(embeddingProvider);
  const model = explicitEmbeddingModel || DEFAULT_EMBEDDING_MODEL;
  const providerKey = `${embeddingProvider}:${embeddingApiBase}`;
  const cacheKey = `${providerKey}:${model}`;
  return {
    apiBase: embeddingApiBase,
    apiKey,
    model,
    providerKey,
    cacheKey,
    attemptKey: `${cacheKey}:auth=${fingerprintEmbeddingSecret(apiKey)}`,
  };
}

/**
 * Returns the currently configured embedding model name.
 */
export function getEmbeddingModelName(): string {
  const explicit = (getPref("embeddingModel") || "").toString().trim();
  if (explicit) return explicit as string;

  try {
    return getResolvedEmbeddingConfig().model;
  } catch {
    // No embedding provider configured
  }
  return DEFAULT_EMBEDDING_MODEL;
}

type IOUtilsLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  write?: (path: string, data: Uint8Array) => Promise<unknown>;
  makeDirectory?: (
    path: string,
    options?: { createAncestors?: boolean; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type OSFileLike = {
  exists?: (path: string) => Promise<boolean>;
  read?: (path: string) => Promise<Uint8Array | ArrayBuffer>;
  writeAtomic?: (path: string, data: Uint8Array) => Promise<void>;
  makeDir?: (
    path: string,
    options?: { from?: string; ignoreExisting?: boolean },
  ) => Promise<void>;
};

type ZoteroFileLike = {
  getContentsAsync?: (
    source: string | nsIFile,
    charset?: string,
    maxLength?: number,
  ) => Promise<unknown> | unknown;
  getBinaryContentsAsync?: (
    source: string | nsIFile,
    maxLength?: number,
  ) => Promise<string> | string;
};

const uploadedResponseFileIdCache = new Map<string, string>();

function getIOUtils(): IOUtilsLike | undefined {
  const fromGlobal = (globalThis as unknown as { IOUtils?: IOUtilsLike })
    .IOUtils;
  if (fromGlobal?.read) return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("IOUtils") as IOUtilsLike | undefined;
  return fromToolkit?.read ? fromToolkit : undefined;
}

function getOSFile(): OSFileLike | undefined {
  const fromGlobal = (globalThis as { OS?: { File?: OSFileLike } }).OS?.File;
  if (fromGlobal?.read) return fromGlobal;
  const toolkitOS = ztoolkit.getGlobal("OS") as
    | { File?: OSFileLike }
    | undefined;
  const fromToolkit = toolkitOS?.File;
  return fromToolkit?.read ? fromToolkit : undefined;
}

function getZoteroFile(): ZoteroFileLike | undefined {
  const fromGlobal = (globalThis as { Zotero?: { File?: ZoteroFileLike } })
    .Zotero?.File;
  if (fromGlobal?.getContentsAsync || fromGlobal?.getBinaryContentsAsync) {
    return fromGlobal;
  }
  const toolkitZotero = ztoolkit.getGlobal("Zotero") as
    | { File?: ZoteroFileLike }
    | undefined;
  const fromToolkit = toolkitZotero?.File;
  if (fromToolkit?.getContentsAsync || fromToolkit?.getBinaryContentsAsync) {
    return fromToolkit;
  }
  return undefined;
}

function binaryStringToBytes(data: string): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) {
    out[i] = data.charCodeAt(i) & 0xff;
  }
  return out;
}

function coerceToBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (typeof data === "string") {
    // Many Zotero/Gecko APIs return binary content as a byte-string.
    return binaryStringToBytes(data);
  }
  return null;
}

// =============================================================================
// GitHub Copilot Auth
// =============================================================================

let cachedCopilotJwt: { token: string; expiresAt: number } | null = null;

function buildCopilotHeaders(token: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
    "Copilot-Integration-Id": "vscode-chat",
    "Editor-Version": "vscode/1.96.0",
    "Editor-Plugin-Version": "copilot-chat/0.24.2",
    "Openai-Intent": "conversation-panel",
  };
}

export async function startCopilotDeviceFlow(signal?: AbortSignal): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  interval: number;
  expires_in: number;
}> {
  const response = await getFetch()(COPILOT_DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: COPILOT_GITHUB_CLIENT_ID,
      scope: "read:user",
    }),
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `GitHub device code request failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
  return (await response.json()) as unknown as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
  };
}

export async function pollCopilotDeviceAuth(params: {
  deviceCode: string;
  interval: number;
  expiresIn: number;
  signal?: AbortSignal;
}): Promise<string> {
  const deadline = Date.now() + params.expiresIn * 1000;
  let interval = params.interval * 1000;

  while (Date.now() < deadline) {
    if (params.signal?.aborted) {
      throw new Error("Copilot device auth polling aborted");
    }

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      params.signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("Copilot device auth polling aborted"));
        },
        { once: true },
      );
    });

    const response = await getFetch()(COPILOT_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: COPILOT_GITHUB_CLIENT_ID,
        device_code: params.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
      signal: params.signal,
    });

    const payload = (await response.json()) as {
      access_token?: string;
      error?: string;
    };

    if (payload.access_token) {
      return payload.access_token;
    }

    if (payload.error === "authorization_pending") {
      continue;
    }
    if (payload.error === "slow_down") {
      interval += 5000;
      continue;
    }
    if (payload.error === "expired_token") {
      throw new Error("Login expired. Try again.");
    }
    if (payload.error === "access_denied") {
      throw new Error("Login denied by user.");
    }
    throw new Error(`Unexpected device auth error: ${payload.error}`);
  }

  throw new Error("Login expired. Try again.");
}

async function fetchCopilotJwt(
  githubToken: string,
  signal?: AbortSignal,
): Promise<{ token: string; expiresAt: number }> {
  const response = await getFetch()(COPILOT_TOKEN_URL, {
    method: "GET",
    headers: {
      Authorization: `token ${githubToken}`,
      Accept: "application/json",
      "Editor-Version": "vscode/1.96.0",
      "Editor-Plugin-Version": "copilot-chat/0.24.2",
      "User-Agent": "GithubCopilot/1.246.0",
    },
    signal,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Copilot token exchange failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
  const payload = (await response.json()) as {
    token?: string;
    expires_at?: number;
  };
  const token = typeof payload.token === "string" ? payload.token.trim() : "";
  if (!token) {
    throw new Error("Copilot token exchange returned empty token");
  }
  const expiresAt =
    typeof payload.expires_at === "number"
      ? payload.expires_at * 1000
      : Date.now() + 25 * 60 * 1000;
  cachedCopilotJwt = { token, expiresAt };
  return { token, expiresAt };
}

export async function resolveCopilotAccessToken(params: {
  githubToken: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (cachedCopilotJwt && cachedCopilotJwt.expiresAt > Date.now() + 60_000) {
    return cachedCopilotJwt.token;
  }
  const result = await fetchCopilotJwt(params.githubToken, params.signal);
  return result.token;
}

type CopilotModelEntry = {
  id?: string;
  name?: string;
  model_picker_enabled?: boolean;
  model_picker_category?: string;
  capabilities?: {
    type?: string;
    supports?: {
      chat?: boolean;
      tool_calls?: boolean;
    };
  };
  policy?: {
    state?: string;
  };
  supported_endpoints?: string[];
};

function isCopilotModelUsable(m: CopilotModelEntry): boolean {
  // Exclude non-chat models (e.g. embeddings)
  if (m.capabilities?.type && m.capabilities.type !== "chat") return false;
  // Exclude models with disabled policy
  if (m.policy?.state === "disabled") return false;
  // Exclude models that support neither /chat/completions nor /responses
  if (
    Array.isArray(m.supported_endpoints) &&
    !m.supported_endpoints.includes("/chat/completions") &&
    !m.supported_endpoints.includes("/responses")
  ) {
    return false;
  }
  // Exclude internal/legacy duplicates (model_picker_enabled=false with no category)
  if (m.model_picker_enabled === false && !m.model_picker_category)
    return false;
  // Exclude codex agent-only models (gated to VS Code agent, not usable via general API)
  if (typeof m.id === "string" && /-codex($|-)/i.test(m.id)) return false;
  // Exclude VS Code internal models (oswe = fine-tuned for VS Code Copilot)
  if (typeof m.id === "string" && /^oswe-/i.test(m.id)) return false;
  // Exclude grok-code models (gated to specific Copilot integrations)
  if (typeof m.id === "string" && /^grok-code/i.test(m.id)) return false;
  return true;
}

function resolveCopilotModelProtocol(
  endpoints: string[] | undefined,
): ProviderProtocol | undefined {
  if (!Array.isArray(endpoints) || !endpoints.length) return undefined;
  const hasChat = endpoints.includes("/chat/completions");
  const hasResponses = endpoints.includes("/responses");
  // Only override when the model doesn't support the default (chat/completions)
  if (!hasChat && hasResponses) return "responses_api";
  return undefined; // chat-compatible or both → inherit group default
}

export type CopilotModelInfo = {
  id: string;
  name: string;
  protocol?: ProviderProtocol;
};

export async function fetchCopilotModelList(params: {
  githubToken: string;
  signal?: AbortSignal;
}): Promise<CopilotModelInfo[]> {
  const jwt = await resolveCopilotAccessToken(params);
  const response = await getFetch()(`${DEFAULT_COPILOT_API_BASE}/models`, {
    method: "GET",
    headers: buildCopilotHeaders(jwt),
    signal: params.signal,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Copilot model list fetch failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
  const payload = (await response.json()) as {
    data?: CopilotModelEntry[];
  };
  return (payload.data || [])
    .filter(
      (m) => typeof m.id === "string" && m.id.trim() && isCopilotModelUsable(m),
    )
    .map((m) => ({
      id: m.id!.trim(),
      name: (m.name || m.id || "").trim(),
      protocol: resolveCopilotModelProtocol(m.supported_endpoints),
    }));
}

export async function readLocalFileBytes(path: string): Promise<Uint8Array> {
  const normalizedPath = (path || "").trim();
  if (!normalizedPath) {
    throw new Error("Attachment file path is empty");
  }
  const attempted: string[] = [];

  const io = getIOUtils();
  if (io?.read) {
    attempted.push("IOUtils.read");
    const data = await io.read(normalizedPath);
    const bytes = coerceToBytes(data);
    if (bytes) return bytes;
  }

  const osFile = getOSFile();
  if (osFile?.read) {
    attempted.push("OS.File.read");
    const data = await osFile.read(normalizedPath);
    const bytes = coerceToBytes(data);
    if (bytes) return bytes;
  }

  const zoteroFile = getZoteroFile();
  if (zoteroFile?.getContentsAsync) {
    attempted.push("Zotero.File.getContentsAsync");
    try {
      const data = await zoteroFile.getContentsAsync(normalizedPath);
      const bytes = coerceToBytes(data);
      if (bytes) return bytes;
    } catch (err) {
      ztoolkit.log("LLM: Zotero.File.getContentsAsync failed", err);
    }
  }
  if (zoteroFile?.getBinaryContentsAsync) {
    attempted.push("Zotero.File.getBinaryContentsAsync");
    try {
      const data = await zoteroFile.getBinaryContentsAsync(normalizedPath);
      const bytes = coerceToBytes(data);
      if (bytes) return bytes;
    } catch (err) {
      ztoolkit.log("LLM: Zotero.File.getBinaryContentsAsync failed", err);
    }
  }

  const fileUrl = pathToFileUrl(normalizedPath);
  if (fileUrl) {
    attempted.push("fetch(file://)");
    try {
      const res = await getFetch()(fileUrl);
      if (res.ok) {
        return new Uint8Array(await res.arrayBuffer());
      }
      ztoolkit.log(
        "LLM: fetch(file://) returned non-OK status",
        res.status,
        res.statusText,
      );
    } catch (err) {
      ztoolkit.log("LLM: fetch(file://) failed", err);
    }
  }

  throw new Error(
    `No binary file read API available (tried: ${attempted.join(", ") || "none"})`,
  );
}

function createAbortError(): Error {
  const err = new Error("Aborted");
  (err as { name?: string }).name = "AbortError";
  return err;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw createAbortError();
  }
}

function normalizeUploadableAttachments(
  attachments: ChatFileAttachment[] | undefined,
): ChatFileAttachment[] {
  if (!Array.isArray(attachments) || !attachments.length) return [];
  const out: ChatFileAttachment[] = [];
  const seen = new Set<string>();
  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") continue;
    const storedPath =
      typeof attachment.storedPath === "string"
        ? attachment.storedPath.trim()
        : "";
    if (!storedPath) continue;
    const name =
      typeof attachment.name === "string" && attachment.name.trim()
        ? attachment.name.trim()
        : "attachment";
    const mimeType =
      typeof attachment.mimeType === "string" && attachment.mimeType.trim()
        ? attachment.mimeType.trim()
        : "application/octet-stream";
    const contentHash =
      typeof attachment.contentHash === "string" &&
      /^[a-f0-9]{64}$/i.test(attachment.contentHash.trim())
        ? attachment.contentHash.trim().toLowerCase()
        : undefined;
    const key = contentHash || storedPath;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name,
      mimeType,
      storedPath,
      contentHash,
    });
  }
  return out;
}

function extractUploadedFileId(data: unknown): string {
  if (!data || typeof data !== "object") return "";
  const typed = data as { id?: unknown; file_id?: unknown };
  if (typeof typed.id === "string" && typed.id.trim()) {
    return typed.id.trim();
  }
  if (typeof typed.file_id === "string" && typed.file_id.trim()) {
    return typed.file_id.trim();
  }
  return "";
}

function isPurposeValidationError(status: number, bodyText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  return /purpose/i.test(bodyText);
}

function buildUploadRequest(params: {
  purpose: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): { body: BodyInit; contentType?: string; mode: "formdata" | "manual" } {
  const request = buildMultipartRequest(
    [
      { name: "purpose", value: params.purpose || "assistants" },
      {
        name: "file",
        filename: params.fileName || "attachment",
        contentType: params.mimeType || "application/octet-stream",
        data: params.bytes,
      },
    ],
    {
      boundaryPrefix: "llmforzotero",
      fallbackName: "attachment",
      preferFormData: true,
    },
  );
  return {
    ...request,
    body:
      request.body instanceof Uint8Array
        ? (request.body.buffer.slice(
            request.body.byteOffset,
            request.body.byteOffset + request.body.byteLength,
          ) as ArrayBuffer)
        : request.body,
  };
}

async function uploadAttachmentForResponses(params: {
  apiBase: string;
  apiKey: string;
  attachment: ChatFileAttachment;
  signal?: AbortSignal;
}): Promise<string> {
  const filesUrl = resolveEndpoint(params.apiBase, FILES_ENDPOINT);
  const storedPath = (params.attachment.storedPath || "").trim();
  if (!storedPath) {
    throw new Error("Attachment stored path is missing");
  }
  const cacheKey = [
    filesUrl,
    params.apiKey,
    params.attachment.contentHash || storedPath,
  ].join("::");
  const cached = uploadedResponseFileIdCache.get(cacheKey);
  if (cached) return cached;

  throwIfAborted(params.signal);
  const bytes = await readLocalFileBytes(storedPath);
  throwIfAborted(params.signal);

  const headers: Record<string, string> = {};
  if (params.apiKey) {
    headers.Authorization = `Bearer ${params.apiKey}`;
  }
  const uploadPurposes = ["assistants", "user_data"];
  let lastError = "Unknown file upload error";
  for (let index = 0; index < uploadPurposes.length; index++) {
    const purpose = uploadPurposes[index];
    const uploadRequest = buildUploadRequest({
      purpose,
      fileName: params.attachment.name || "attachment",
      mimeType: params.attachment.mimeType || "application/octet-stream",
      bytes,
    });
    const requestHeaders = uploadRequest.contentType
      ? {
          ...headers,
          "Content-Type": uploadRequest.contentType,
        }
      : headers;
    if (uploadRequest.mode === "manual") {
      ztoolkit.log(
        "LLM: Uploading attachment via manual multipart fallback",
        params.attachment.name,
      );
    }

    const res = await getFetch()(filesUrl, {
      method: "POST",
      headers: requestHeaders,
      body: uploadRequest.body,
      signal: params.signal,
    });
    if (res.ok) {
      const data = (await res.json()) as unknown;
      const fileId = extractUploadedFileId(data);
      if (!fileId) {
        throw new Error("File upload succeeded but no file ID was returned");
      }
      uploadedResponseFileIdCache.set(cacheKey, fileId);
      return fileId;
    }

    const errText = await res.text();
    lastError = `${res.status} ${res.statusText} - ${errText}`;
    if (
      index === uploadPurposes.length - 1 ||
      !isPurposeValidationError(res.status, errText)
    ) {
      break;
    }
  }

  throw new Error(lastError);
}

export async function uploadFilesForResponses(params: {
  apiBase: string;
  apiKey: string;
  attachments: ChatFileAttachment[] | undefined;
  signal?: AbortSignal;
}): Promise<string[]> {
  const uploadable = normalizeUploadableAttachments(params.attachments);
  if (!uploadable.length) return [];
  const fileIds: string[] = [];
  const seen = new Set<string>();
  for (const attachment of uploadable) {
    throwIfAborted(params.signal);
    try {
      const fileId = await uploadAttachmentForResponses({
        apiBase: params.apiBase,
        apiKey: params.apiKey,
        attachment,
        signal: params.signal,
      });
      if (!fileId || seen.has(fileId)) continue;
      seen.add(fileId);
      fileIds.push(fileId);
    } catch (err) {
      ztoolkit.log(
        "LLM: Failed to upload attachment to Responses API",
        attachment.name,
        err,
      );
    }
  }
  return fileIds;
}

/** Build messages array from params */
function buildMessages(
  params: ChatParams,
  systemPrompt: string,
): ChatMessage[] {
  const messages: ChatMessage[] = [{ role: "system", content: systemPrompt }];

  if (params.context) {
    messages.push({
      role: "system",
      content: `Document Context:\n${params.context}`,
    });
  }

  if (Array.isArray(params.systemMessages)) {
    for (const systemMessage of params.systemMessages) {
      if (typeof systemMessage !== "string" || !systemMessage.trim()) continue;
      messages.push({
        role: "system",
        content: systemMessage.trim(),
      });
    }
  }

  if (params.history?.length) {
    messages.push(...params.history);
  }

  const imageUrls: string[] = [];
  if (Array.isArray(params.images)) {
    for (const image of params.images) {
      if (typeof image === "string" && image.trim()) {
        imageUrls.push(image.trim());
      }
    }
  }
  if (typeof params.image === "string" && params.image.trim()) {
    imageUrls.push(params.image.trim());
  }

  // Build user message - with image(s) if provided (vision API format)
  if (imageUrls.length) {
    const contentParts: (TextContent | ImageContent)[] = [
      { type: "text", text: params.prompt },
    ];
    for (const url of imageUrls) {
      contentParts.push({
        type: "image_url",
        image_url: {
          url,
          detail: "high",
        },
      });
    }
    messages.push({
      role: "user",
      content: contentParts,
    });
  } else {
    messages.push({
      role: "user",
      content: params.prompt,
    });
  }

  return messages;
}

function stripUnsupportedImageContent(
  messages: ChatMessage[],
  params: {
    modelName: string;
    apiBase?: string;
    authMode?: ModelProviderAuthMode;
    providerProtocol?: ProviderProtocol;
    inputMode?: ModelInputMode;
  },
): ChatMessage[] {
  const capabilities = resolveProviderCapabilities({
    model: params.modelName,
    apiBase: params.apiBase,
    authMode: params.authMode,
    protocol: params.providerProtocol,
    inputMode: params.inputMode,
  });
  if (capabilities.images) return messages;
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const omittedImageCount = message.content.filter(
      (part) => part.type === "image_url",
    ).length;
    const textParts = message.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .filter((text) => text.trim());
    const omittedNotice =
      omittedImageCount > 0
        ? `[${omittedImageCount} image input${
            omittedImageCount === 1 ? "" : "s"
          } omitted because ${params.modelName || "the selected model"} does not support image input.]`
        : "";
    const content = [...textParts, omittedNotice].filter(Boolean).join("\n\n");
    return {
      ...message,
      content: content || omittedNotice || "",
    };
  });
}

export function prepareChatRequest(params: ChatParams): PreparedChatRequest {
  const { apiBase, apiKey, authMode, model, systemPrompt, providerProtocol } =
    getApiConfig({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      model: params.model,
      providerProtocol: params.providerProtocol,
    });
  const rawMessages = stripUnsupportedImageContent(
    buildMessages(params, systemPrompt),
    {
      modelName: model,
      apiBase,
      authMode,
      providerProtocol,
      inputMode: params.inputMode,
    },
  );
  const inputCap = applyModelInputTokenCap(
    rawMessages,
    model,
    params.inputTokenCap,
    {
      provider: detectProviderPreset(apiBase).toString(),
      apiBase,
      protocol: providerProtocol,
      authMode,
      profileOverride: params.profileOverride,
    },
  );
  return {
    apiBase,
    apiKey,
    authMode,
    model,
    systemPrompt,
    messages: inputCap.messages as ChatMessage[],
    inputCap,
    providerProtocol,
    contextCache: params.contextCache,
  };
}

export async function preflightRequestModelCapabilities(
  params: ChatParams,
): Promise<void> {
  try {
    const resolved = getApiConfig({
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      model: params.model,
      providerProtocol: params.providerProtocol,
    });
    await ensureModelCapabilities(
      {
        provider: detectProviderPreset(resolved.apiBase).toString(),
        model: resolved.model,
        apiBase: resolved.apiBase,
        protocol: resolved.providerProtocol,
        authMode: resolved.authMode,
        apiKey: resolved.apiKey,
      },
      { timeoutMs: 5_000 },
    );
  } catch {
    // Capability discovery is best effort. The request must retain its
    // bundled/legacy fallback when a provider catalog is unavailable.
  }
}

function getReasoningReserveTokens(reasoning?: ReasoningConfig): number {
  const level = reasoning?.level || "none";
  switch (level) {
    case "minimal":
      return 512;
    case "low":
      return 1_024;
    case "default":
      return 1_024;
    case "medium":
      return 2_048;
    case "high":
      return 4_096;
    case "xhigh":
    case "ultra":
    case "max":
      return 8_192;
    default:
      return 256;
  }
}

export function estimateAvailableContextBudget(params: {
  prompt: string;
  history?: ChatMessage[];
  image?: string;
  images?: string[];
  model: string;
  reasoning?: ReasoningConfig;
  maxTokens?: number;
  maxTokensExplicit?: boolean;
  inputTokenCap?: number;
  systemPrompt?: string;
  apiBase?: string;
  providerProtocol?: ProviderProtocol;
  authMode?: ModelProviderAuthMode;
  profileOverride?: ModelProfileOverride;
}): ContextBudgetPlan {
  const normalizedModel =
    (params.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const resolvedInputLimit = resolveModelInputTokenLimit(
    normalizedModel,
    params.inputTokenCap,
    {
      provider: params.apiBase
        ? detectProviderPreset(params.apiBase).toString()
        : undefined,
      apiBase: params.apiBase,
      protocol: params.providerProtocol,
      authMode: params.authMode,
      profileOverride: params.profileOverride,
    },
  );
  const limitTokens = resolvedInputLimit.limitTokens;
  const modelLimitTokens = limitTokens;
  const softLimitTokens = Math.max(1, Math.floor(limitTokens * 0.9));
  const outputReserveTokens = normalizeMaxTokensForRequest({
    value: params.maxTokens,
    maxTokensExplicit: params.maxTokensExplicit,
    model: normalizedModel,
    apiBase: params.apiBase,
    protocol: params.providerProtocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  const reasoningReserveTokens = getReasoningReserveTokens(params.reasoning);

  const baseMessages = buildMessages(
    {
      prompt: params.prompt,
      history: params.history,
      image: params.image,
      images: params.images,
    },
    params.systemPrompt
      ? `${DEFAULT_SYSTEM_PROMPT}\n\n${params.systemPrompt}`
      : DEFAULT_SYSTEM_PROMPT,
  );
  const baseInputTokens = estimateConversationTokens(baseMessages);
  const contextBudgetTokens = Math.max(
    0,
    softLimitTokens -
      baseInputTokens -
      outputReserveTokens -
      reasoningReserveTokens,
  );

  return {
    modelLimitTokens,
    limitTokens,
    softLimitTokens,
    baseInputTokens,
    outputReserveTokens,
    reasoningReserveTokens,
    contextBudgetTokens,
  };
}

/** Get fetch function from Zotero global */
function getFetch(): typeof fetch {
  return ztoolkit.getGlobal("fetch") as typeof fetch;
}

function normalizeStreamText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value
      .map((entry) => normalizeStreamText(entry))
      .filter(Boolean)
      .join("");
  }
  if (value && typeof value === "object") {
    const row = value as {
      text?: unknown;
      content?: unknown;
      reasoning?: unknown;
      summary?: unknown;
      delta?: unknown;
      thinking?: unknown;
      thought?: unknown;
    };
    return (
      normalizeStreamText(row.text) ||
      normalizeStreamText(row.content) ||
      normalizeStreamText(row.reasoning) ||
      normalizeStreamText(row.summary) ||
      normalizeStreamText(row.delta) ||
      normalizeStreamText(row.thinking) ||
      normalizeStreamText(row.thought)
    );
  }
  return "";
}

type ThoughtTagState = {
  inThought: boolean;
  buffer: string;
  /** Which tag opened the current block, so only its match can close it. */
  openTagName?: string;
  /**
   * Whether any non-whitespace answer text has streamed yet. Once it has, a
   * reasoning tag can no longer be a chat-template leak, so it is left in the
   * answer as the ordinary text it is.
   */
  sawAnswerText: boolean;
};

function getPartialTagTailLength(text: string, tag: string): number {
  const textLower = text.toLowerCase();
  const tagLower = tag.toLowerCase();
  const max = Math.min(textLower.length, tagLower.length - 1);
  for (let len = max; len > 0; len--) {
    if (tagLower.startsWith(textLower.slice(-len))) {
      return len;
    }
  }
  return 0;
}

/**
 * Reasoning tags that arrive inline in the content stream instead of in a
 * dedicated field. Every one of them is *leakage*, not a contract this plugin
 * asked the model for: llama.cpp and vLLM without a reasoning parser pass the
 * chat template's raw output straight through, and `<thought>` reaches us the
 * same way from a Codex-side prompt we do not own.
 *
 * That distinction is why `thoughtBlockCanOpen` below exists. Nothing tells a
 * leaked `<think>` apart from a model *writing about* `<think>` except where it
 * sits: a template always emits its reasoning block first, so a leak opens the
 * assistant message, while an answer that mentions the tag has already started
 * talking. Without that rule, "how do I stop my model emitting <think> blocks?"
 * loses its own answer into the Thinking panel.
 */
const THOUGHT_TAG_NAMES = ["thought", "think", "reasoning"] as const;

type ThoughtTagMatch = { index: number; length: number; name: string };

/**
 * Whether a reasoning block may still open. False once the model has streamed
 * any non-whitespace answer text — the leading newlines a chat template emits
 * around its block (`<think>\n…\n</think>\n\n`) are part of the leak, so
 * whitespace alone must not close the window.
 */
function thoughtBlockCanOpen(state: ThoughtTagState): boolean {
  return !state.sawAnswerText;
}

/** Earliest opening tag at or after `from`, across every recognized name. */
function findEarliestTag(
  haystackLower: string,
  from: number,
  build: (name: string) => string,
): ThoughtTagMatch | null {
  let best: ThoughtTagMatch | null = null;
  for (const name of THOUGHT_TAG_NAMES) {
    const tag = build(name);
    const index = haystackLower.indexOf(tag, from);
    if (index === -1) continue;
    if (!best || index < best.index) {
      best = { index, length: tag.length, name };
    }
  }
  return best;
}

/**
 * Longest partial tag suffix across every recognized name, so a tag split
 * across two stream chunks is held back rather than emitted as text.
 */
function longestPartialTagTail(
  segment: string,
  build: (name: string) => string,
): number {
  let longest = 0;
  for (const name of THOUGHT_TAG_NAMES) {
    const tail = getPartialTagTailLength(segment, build(name));
    if (tail > longest) longest = tail;
  }
  return longest;
}

function splitThoughtTaggedText(
  chunk: string,
  state: ThoughtTagState,
): { answer: string; thought: string } {
  const openTag = (name: string) => `<${name}>`;
  const closeTag = (name: string) => `</${name}>`;
  const input = `${state.buffer}${chunk}`;
  state.buffer = "";
  if (!input) return { answer: "", thought: "" };

  const inputLower = input.toLowerCase();
  let answer = "";
  let thought = "";
  let cursor = 0;

  while (cursor < input.length) {
    if (state.inThought) {
      // Only the tag that opened the block can close it, so a stray
      // `</think>` inside a `<thought>` block does not end it early.
      const closeName = state.openTagName || THOUGHT_TAG_NAMES[0];
      const close = closeTag(closeName);
      const closeIdx = inputLower.indexOf(close, cursor);
      if (closeIdx === -1) {
        const segment = input.slice(cursor);
        const tailLen = getPartialTagTailLength(segment, close);
        thought += segment.slice(0, segment.length - tailLen);
        state.buffer = segment.slice(segment.length - tailLen);
        break;
      }
      thought += input.slice(cursor, closeIdx);
      cursor = closeIdx + close.length;
      state.inThought = false;
      state.openTagName = undefined;
      continue;
    }

    const open = thoughtBlockCanOpen(state)
      ? findEarliestTag(inputLower, cursor, openTag)
      : null;
    // Answer text ahead of the tag means the model is writing about it, not
    // leaking it, so the tag and everything after stay in the answer.
    const opensTheMessage = open
      ? !input.slice(cursor, open.index).trim()
      : false;
    if (!open || !opensTheMessage) {
      const segment = input.slice(cursor);
      // Only hold back a partial tag while one could still open; afterwards a
      // trailing `<thi` is ordinary text and must not be swallowed.
      const tailLen = thoughtBlockCanOpen(state)
        ? longestPartialTagTail(segment, openTag)
        : 0;
      const emitted = segment.slice(0, segment.length - tailLen);
      answer += emitted;
      if (emitted.trim()) state.sawAnswerText = true;
      state.buffer = segment.slice(segment.length - tailLen);
      break;
    }
    answer += input.slice(cursor, open.index);
    cursor = open.index + open.length;
    state.inThought = true;
    state.openTagName = open.name;
  }

  return { answer, thought };
}

/**
 * Flush whatever is left in the tag buffer when the stream ends.
 *
 * Only a partial tag suffix can be held back — text inside an open reasoning
 * block is emitted as it arrives so the Thinking panel stays live. That means
 * an unterminated block cannot be reclassified as the answer after the fact
 * without showing the same text twice, so it is deliberately left as reasoning.
 */
function resolveUnterminatedThought(state: ThoughtTagState): {
  asAnswer: boolean;
  text: string;
} {
  const text = state.buffer;
  if (!text) return { asAnswer: false, text: "" };
  return { asAnswer: !state.inThought, text };
}

function buildTokenParam(model: string, maxTokens: number) {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function buildResponsesTokenParam(maxTokens: number) {
  return { max_output_tokens: maxTokens };
}

export function normalizeMaxTokensForRequest(params: {
  value?: number;
  maxTokensExplicit?: boolean;
  model: string;
  apiBase?: string;
  protocol?: ProviderProtocol;
  authMode?: ModelProviderAuthMode;
  profileOverride?: ModelProfileOverride;
}): number {
  if (params.maxTokensExplicit) return normalizeMaxTokens(params.value);
  const normalized = normalizeMaxTokensForModel(params.value, params.model, {
    provider: params.apiBase
      ? detectProviderPreset(params.apiBase).toString()
      : undefined,
    apiBase: params.apiBase,
    protocol: params.protocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  return normalized;
}

const OPENAI_EFFORT_ORDER: OpenAIReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

const REASONING_LEVEL_ALIAS_MAP: Partial<
  Record<ReasoningLevel, ReasoningLevel>
> = {
  minimal: "low",
  xhigh: "high",
};

function getReasoningLevelAlias(level: ReasoningLevel): ReasoningLevel | null {
  return REASONING_LEVEL_ALIAS_MAP[level] || null;
}

// Re-export reasoning profile helpers so consumers can import from llmClient
// without coupling directly to reasoningProfiles.
export type {
  ReasoningProvider,
  ReasoningLevel,
  OpenAIReasoningEffort,
  OpenAIReasoningProfile,
  GeminiThinkingParam,
  GeminiThinkingValue,
  GeminiReasoningOption,
  GeminiReasoningProfile,
  AnthropicAdaptiveEffort,
  AnthropicThinkingMode,
  AnthropicReasoningProfile,
  QwenReasoningProfile,
  RuntimeReasoningOption,
} from "./reasoningProfiles";

export {
  getRuntimeReasoningOptionsForModel as getRuntimeReasoningOptions,
  getOpenAIReasoningProfileForModel as getOpenAIReasoningProfile,
  getGrokReasoningProfileForModel as getGrokReasoningProfile,
  getGeminiReasoningProfileForModel as getGeminiReasoningProfile,
  getAnthropicReasoningProfileForModel as getAnthropicReasoningProfile,
  getQwenReasoningProfileForModel as getQwenReasoningProfile,
} from "./reasoningProfiles";

// Local aliases for internal use (re-exports above don't create local bindings)
const getOpenAIReasoningProfile = getOpenAIReasoningProfileForModel;
const getGrokReasoningProfile = getGrokReasoningProfileForModel;
const getGeminiReasoningProfile = getGeminiReasoningProfileForModel;
const getAnthropicReasoningProfile = getAnthropicReasoningProfileForModel;
const getQwenReasoningProfile = getQwenReasoningProfileForModel;

function resolveOpenAIReasoningEffort(
  provider: "openai" | "grok",
  level: ReasoningLevel,
  modelName?: string,
  apiBase?: string,
): OpenAIReasoningEffort | null {
  const profile =
    provider === "grok"
      ? getGrokReasoningProfile(modelName)
      : getOpenAIReasoningProfile(modelName);
  const direct = profile.levelToEffort[level];
  if (direct !== undefined) {
    return direct;
  }

  const requestedAlias = getReasoningLevelAlias(level);
  if (requestedAlias) {
    const aliasValue = profile.levelToEffort[requestedAlias];
    if (aliasValue !== undefined) {
      return aliasValue;
    }
  }

  for (const candidate of OPENAI_EFFORT_ORDER) {
    if (profile.supportedEfforts.includes(candidate)) {
      return candidate;
    }
  }

  const defaultEffort = profile.levelToEffort[profile.defaultLevel];
  if (defaultEffort !== undefined) {
    return defaultEffort;
  }

  return null;
}

function resolveAnthropicThinkingBudget(
  level: ReasoningLevel,
  profile: AnthropicReasoningProfile,
): number {
  const direct = profile.levelToBudgetTokens[level];
  if (Number.isFinite(direct)) {
    return Number(direct);
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasBudget = profile.levelToBudgetTokens[aliasLevel];
    if (Number.isFinite(aliasBudget)) {
      return Number(aliasBudget);
    }
  }

  const defaultBudget = profile.levelToBudgetTokens[profile.defaultLevel];
  if (Number.isFinite(defaultBudget)) {
    return Number(defaultBudget);
  }

  return profile.defaultBudgetTokens;
}

function resolveAnthropicAdaptiveEffort(
  level: ReasoningLevel,
  profile: AnthropicReasoningProfile,
): AnthropicAdaptiveEffort | null {
  const direct = profile.levelToEffort[level];
  if (direct) return direct;

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasEffort = profile.levelToEffort[aliasLevel];
    if (aliasEffort) return aliasEffort;
  }

  const defaultEffort = profile.levelToEffort[profile.defaultLevel];
  return defaultEffort || null;
}

function resolveAnthropicThinkingMode(params: {
  profile: AnthropicReasoningProfile;
  override?: AnthropicReasoningModeOverride;
}): AnthropicReasoningModeOverride | null {
  if (
    params.override === "adaptive" &&
    params.profile.supportsAdaptiveThinking
  ) {
    return "adaptive";
  }
  if (params.override === "manual" && params.profile.supportsManualThinking) {
    return "manual";
  }
  if (
    params.profile.preferredMode === "adaptive" &&
    params.profile.supportsAdaptiveThinking
  ) {
    return "adaptive";
  }
  if (
    params.profile.preferredMode === "manual" &&
    params.profile.supportsManualThinking
  ) {
    return "manual";
  }
  return null;
}

/** A local validation failure for a main request's selected reasoning mode. */
export class ReasoningBudgetError extends Error {
  readonly code = "reasoning_budget_too_small" as const;

  constructor(message: string) {
    super(message);
    this.name = "ReasoningBudgetError";
  }
}

function resolveAnthropicManualBudget(params: {
  level: ReasoningLevel;
  profile: AnthropicReasoningProfile;
  maxTokens?: number;
  modelName?: string;
}): number {
  const requested = Math.max(
    1024,
    Math.floor(resolveAnthropicThinkingBudget(params.level, params.profile)),
  );
  const maxTokens = Math.floor(Number(params.maxTokens));
  if (!Number.isFinite(maxTokens) || maxTokens < 1) {
    return requested;
  }

  const reservedAnswerTokens = 1024;
  const maxBudgetTokens = maxTokens - reservedAnswerTokens;
  if (maxBudgetTokens < 1024) {
    const label = (params.modelName || "the selected Anthropic model").trim();
    throw new ReasoningBudgetError(
      `${label} extended thinking requires max_tokens of at least 2048 so budget_tokens can be less than max_tokens while leaving room for the answer. Increase max tokens or turn thinking off.`,
    );
  }
  return Math.min(requested, maxBudgetTokens);
}

function resolveQwenEnableThinking(
  level: ReasoningLevel,
  profile: QwenReasoningProfile,
): boolean | null {
  const direct = profile.levelToEnableThinking[level];
  if (typeof direct === "boolean" || direct === null) {
    return direct;
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasValue = profile.levelToEnableThinking[aliasLevel];
    if (typeof aliasValue === "boolean" || aliasValue === null) {
      return aliasValue;
    }
  }

  const defaultValue = profile.levelToEnableThinking[profile.defaultLevel];
  if (typeof defaultValue === "boolean" || defaultValue === null) {
    return defaultValue;
  }

  return profile.defaultEnableThinking;
}

function isDashScopeApiBase(apiBase?: string): boolean {
  const normalized = (apiBase || "").trim().toLowerCase();
  if (!normalized) return false;
  return /dashscope(?:-intl)?\.aliyuncs\.com/.test(normalized);
}

function resolveGeminiReasoningOption(
  level: ReasoningLevel,
  profile: GeminiReasoningProfile,
): GeminiReasoningOption {
  const direct = profile.levelToValue[level];
  if (direct !== undefined) {
    return { level, value: direct };
  }

  const aliasLevel = getReasoningLevelAlias(level);
  if (aliasLevel) {
    const aliasValue = profile.levelToValue[aliasLevel];
    if (aliasValue !== undefined) {
      return { level: aliasLevel, value: aliasValue };
    }
  }

  const defaultMapped = profile.levelToValue[profile.defaultLevel];
  if (defaultMapped !== undefined) {
    return { level: profile.defaultLevel, value: defaultMapped };
  }

  const byDefaultValue = profile.options.find(
    (option) => option.value === profile.defaultValue,
  );
  if (byDefaultValue) return byDefaultValue;

  return profile.options[0] || { level: "medium", value: profile.defaultValue };
}

function stringifyContent(content: MessageContent): string {
  if (typeof content === "string") return content;
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

function mergeSystemMessagesForChatPayload(
  messages: ChatMessage[],
): ChatMessage[] {
  if (!Array.isArray(messages) || !messages.length) return [];
  const systemParts = messages
    .filter((message) => message.role === "system")
    .map((message) => stringifyContent(message.content).trim())
    .filter(Boolean);
  if (!systemParts.length) return messages;
  return [
    {
      role: "system",
      content: systemParts.join("\n\n"),
    },
    ...messages.filter((message) => message.role !== "system"),
  ];
}

function buildResponsesInput(
  messages: ChatMessage[],
  responseFileIds?: string[],
  options?: { preserveSystemMessages?: boolean },
) {
  const preserveSystemMessages = options?.preserveSystemMessages === true;
  const instructionsParts: string[] = [];
  type ResponsesContentPart =
    | { type: "input_text"; text: string }
    | { type: "input_image"; image_url: string; detail?: string }
    | { type: "input_file"; file_id: string }
    | { type: "input_file"; filename: string; file_data: string };
  const input: Array<{
    type: "message";
    role: "system" | "user" | "assistant";
    content: string | ResponsesContentPart[];
  }> = [];
  const normalizedFileIds = Array.isArray(responseFileIds)
    ? responseFileIds
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];

  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message.role === "system" && !preserveSystemMessages) {
      const text = stringifyContent(message.content);
      if (text) instructionsParts.push(text);
      continue;
    }
    const appendFilesToMessage =
      message.role === "user" &&
      index === messages.length - 1 &&
      normalizedFileIds.length > 0;

    if (typeof message.content === "string") {
      if (appendFilesToMessage) {
        const contentParts: ResponsesContentPart[] = [
          { type: "input_text", text: message.content },
        ];
        for (const fileId of normalizedFileIds) {
          contentParts.push({
            type: "input_file",
            file_id: fileId,
          });
        }
        input.push({
          type: "message",
          role: message.role,
          content: contentParts,
        });
        continue;
      }
      input.push({
        type: "message",
        role: message.role,
        content: message.content,
      });
      continue;
    }

    let pdfCounter = 0;
    const contentParts: ResponsesContentPart[] = message.content.map((part) => {
      if (part.type === "text") {
        return { type: "input_text" as const, text: part.text };
      }
      const url = part.image_url.url;
      // Legacy PDF data URIs from older history entries should be sent as
      // inline input_file, not input_image. New PDF delivery paths should use
      // provider-native files, provider upload, or rendered page images.
      if (url.startsWith("data:application/pdf;base64,")) {
        pdfCounter += 1;
        return {
          type: "input_file" as const,
          filename: `document${pdfCounter > 1 ? `-${pdfCounter}` : ""}.pdf`,
          file_data: url,
        };
      }
      return {
        type: "input_image" as const,
        image_url: url,
        detail: part.image_url.detail,
      };
    });
    if (appendFilesToMessage) {
      for (const fileId of normalizedFileIds) {
        contentParts.push({
          type: "input_file",
          file_id: fileId,
        });
      }
    }

    input.push({
      type: "message",
      role: message.role,
      content: contentParts,
    });
  }

  return {
    instructions: instructionsParts.length
      ? instructionsParts.join("\n\n")
      : undefined,
    input,
  };
}

function emptyReasoningPayload() {
  return { extra: {}, omitTemperature: false } as const;
}

export type AnthropicReasoningModeOverride = Exclude<
  AnthropicThinkingMode,
  "none"
>;

export type ReasoningPayloadOptions = {
  maxTokens?: number;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
  /** User-authored capability overrides, including extra body parameters. */
  profileOverride?: ModelProfileOverride;
};

export type ReasoningSelection = ReasoningConfig & {
  anthropicModeOverride?: AnthropicReasoningModeOverride;
};

/**
 * Reasoning controls plus any user-authored extra request parameters.
 *
 * `extraBody` is not reasoning-specific, but this function's result is already
 * spread into every payload builder, so it is the one hook that reaches all
 * protocols. Reasoning controls are layered on top: the reasoning selector is
 * a live per-message control, and static configuration must not silently
 * override what the user just picked.
 */
export function buildReasoningPayload(
  reasoning: ReasoningConfig | undefined,
  useResponses: boolean,
  modelName?: string,
  apiBase?: string,
  providerProtocol?: ProviderProtocol,
  options?: ReasoningPayloadOptions,
): { extra: Record<string, unknown>; omitTemperature: boolean } {
  const base = buildReasoningControlPayload(
    reasoning,
    useResponses,
    modelName,
    apiBase,
    providerProtocol,
    options,
  );
  const extraBody = resolveUserExtraBody(options?.profileOverride, modelName);
  if (!extraBody) return base;
  return {
    extra: { ...extraBody, ...base.extra },
    omitTemperature: base.omitTemperature,
  };
}

/**
 * The extra request parameters an override contributes to a request — after
 * the reserved-key strip, and only when the override was authored for the
 * model being called (a dormant override from a renamed entry contributes
 * nothing; see `forModel`).
 */
export function resolveUserExtraBody(
  profileOverride: ModelProfileOverride | undefined,
  modelName: string | undefined,
): Record<string, unknown> | undefined {
  if (!profileOverrideAppliesTo(profileOverride, modelName || "")) {
    return undefined;
  }
  return stripReservedRequestKeys(profileOverride?.extraBody);
}

/**
 * Last line of defence against a user parameter occupying an envelope key.
 *
 * The editor rejects these at input time with a visible message, so reaching
 * here means a hand-edited or imported config. Silent by design: every payload
 * builder spreads the reasoning extras into the body, most of them after the
 * envelope, so an unfiltered `messages` or `tools` key would replace the
 * conversation or drop every tool definition.
 */
export function stripReservedRequestKeys(
  extraBody: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extraBody) return undefined;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extraBody)) {
    if (isReservedRequestKey(key)) continue;
    kept[key] = value;
  }
  return Object.keys(kept).length ? kept : undefined;
}

function buildReasoningControlPayload(
  reasoning: ReasoningConfig | undefined,
  useResponses: boolean,
  modelName?: string,
  apiBase?: string,
  providerProtocol?: ProviderProtocol,
  options?: ReasoningPayloadOptions,
): { extra: Record<string, unknown>; omitTemperature: boolean } {
  if (!reasoning) {
    return emptyReasoningPayload();
  }
  const exactEffort = reasoning.effort?.trim();
  if (
    exactEffort &&
    (reasoning.provider === "openai" || reasoning.provider === "grok")
  ) {
    return {
      extra: useResponses
        ? { reasoning: { effort: exactEffort, summary: "detailed" } }
        : { reasoning_effort: exactEffort },
      omitTemperature: reasoning.provider === "openai",
    };
  }
  const capabilities = getModelCapabilities({
    provider: reasoning.provider,
    model: modelName || "",
    apiBase,
    protocol: providerProtocol,
    profileOverride: options?.profileOverride,
  });
  const declarativeControls = compileReasoningControls(capabilities, reasoning);
  if (declarativeControls) return declarativeControls;
  if (
    capabilities.reasoning.kind === "none" &&
    !supportsReasoningForModel(reasoning.provider, modelName)
  ) {
    return emptyReasoningPayload();
  }

  if (reasoning.provider === "openai" || reasoning.provider === "grok") {
    const effort = resolveOpenAIReasoningEffort(
      reasoning.provider,
      reasoning.level,
      modelName,
      apiBase,
    );
    const omitTemperature = reasoning.provider === "openai";
    if (useResponses) {
      const responseReasoning: Record<string, unknown> = {
        summary: "detailed",
      };
      if (effort) {
        responseReasoning.effort = effort;
      }
      return {
        extra: {
          reasoning: responseReasoning,
        },
        // GPT-5 families may reject temperature when reasoning is configured.
        omitTemperature,
      };
    }
    return {
      extra: effort ? { reasoning_effort: effort } : {},
      omitTemperature,
    };
  }

  if (reasoning.provider === "gemini") {
    const profile = getGeminiReasoningProfile(modelName);
    const resolvedOption = resolveGeminiReasoningOption(
      reasoning.level,
      profile,
    );

    // Keep request valid if a stale/unsupported level is selected.
    const thinkingConfig: Record<string, unknown> = {
      include_thoughts: true,
    };
    if (profile.param === "thinking_budget") {
      thinkingConfig.thinking_budget =
        typeof resolvedOption.value === "number" ? resolvedOption.value : 8192;
    } else {
      thinkingConfig.thinking_level =
        resolvedOption.value === "minimal" ||
        resolvedOption.value === "low" ||
        resolvedOption.value === "medium" ||
        resolvedOption.value === "high"
          ? resolvedOption.value
          : "medium";
    }

    return {
      extra: {
        extra_body: {
          google: {
            thinking_config: thinkingConfig,
          },
        },
      },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "qwen") {
    const profile = getQwenReasoningProfile(modelName);
    const enableThinking = resolveQwenEnableThinking(reasoning.level, profile);
    if (enableThinking === null) {
      return emptyReasoningPayload();
    }
    if (isDashScopeApiBase(apiBase)) {
      return {
        extra: {
          enable_thinking: enableThinking,
        },
        omitTemperature: false,
      };
    }
    return {
      extra: {
        chat_template_kwargs: {
          enable_thinking: enableThinking,
        },
      },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "deepseek") {
    const profile = getDeepseekReasoningProfileForModel(modelName);
    const thinkingType =
      profile.levelToThinkingType[reasoning.level] ??
      profile.defaultThinkingType;
    if (!thinkingType) {
      return emptyReasoningPayload();
    }
    const reasoningEffort =
      profile.levelToReasoningEffort[reasoning.level] ??
      profile.defaultReasoningEffort;
    const extra: Record<string, unknown> = {
      thinking: {
        type: thinkingType,
      },
    };
    if (thinkingType === "enabled" && reasoningEffort) {
      if (providerProtocol === "anthropic_messages") {
        extra.output_config = { effort: reasoningEffort };
      } else {
        extra.reasoning_effort = reasoningEffort;
      }
    }
    return {
      extra,
      omitTemperature:
        thinkingType === "enabled" && profile.omitTemperatureWhenThinking,
    };
  }

  if (reasoning.provider === "mimo") {
    const profile = getMimoReasoningProfileForModel(modelName);
    const thinkingType =
      profile.levelToThinkingType[reasoning.level] ??
      profile.levelToThinkingType[profile.defaultLevel] ??
      null;
    if (!thinkingType) {
      return emptyReasoningPayload();
    }
    return {
      extra: { thinking: { type: thinkingType } },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "kimi") {
    // Kimi k2/k2.5: "default" = thinking enabled, "minimal" = thinking disabled
    const thinkingType = reasoning.level === "minimal" ? "disabled" : "enabled";
    return {
      extra: { thinking: { type: thinkingType } },
      omitTemperature: false,
    };
  }

  if (reasoning.provider === "anthropic") {
    if (providerProtocol !== "anthropic_messages") {
      return emptyReasoningPayload();
    }
    const profile = getAnthropicReasoningProfile(modelName);
    const mode = resolveAnthropicThinkingMode({
      profile,
      override: options?.anthropicModeOverride,
    });
    if (!mode) {
      return emptyReasoningPayload();
    }
    if (mode === "adaptive") {
      const effort = resolveAnthropicAdaptiveEffort(reasoning.level, profile);
      return {
        extra: {
          thinking: {
            type: "adaptive",
          },
          ...(effort ? { output_config: { effort } } : {}),
        },
        omitTemperature: true,
      };
    }

    const budgetTokens = resolveAnthropicManualBudget({
      level: reasoning.level,
      profile,
      maxTokens: options?.maxTokens,
      modelName,
    });
    return {
      extra: {
        thinking: {
          type: "enabled",
          budget_tokens: budgetTokens,
        },
      },
      omitTemperature: true,
    };
  }

  return emptyReasoningPayload();
}

function buildAnthropicMessagesPayload(params: {
  model: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number;
  effectiveTemperature: number;
  stream: boolean;
  reasoning?: ReasoningConfig;
  apiBase?: string;
  anthropicModeOverride?: AnthropicReasoningModeOverride;
  pdfParts?: NativePdfPart[];
  contextCache?: ContextCachePlan;
  profileOverride?: ModelProfileOverride;
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
    )
    .filter(Boolean);
  const nonSystemSourceMessages = params.messages.filter(
    (m) => m.role !== "system",
  );
  let lastUserMessageIndex = -1;
  for (let index = nonSystemSourceMessages.length - 1; index >= 0; index--) {
    if (nonSystemSourceMessages[index].role === "user") {
      lastUserMessageIndex = index;
      break;
    }
  }
  const documentBlocks = (params.pdfParts || []).map((part) => ({
    type: "document",
    source: {
      type: "base64",
      media_type: "application/pdf",
      data: part.base64,
    },
  }));
  const nonSystemMessages = nonSystemSourceMessages.map((m, index) => {
    const content =
      typeof m.content === "string"
        ? [{ type: "text", text: m.content }]
        : m.content.map((c) => {
            if (c.type !== "image_url") {
              return { type: "text", text: (c as { text: string }).text };
            }
            const parsed = parseDataUrl(
              (c as { image_url: { url: string } }).image_url.url,
            );
            if (parsed?.mimeType === "application/pdf") {
              return {
                type: "document",
                source: {
                  type: "base64",
                  media_type: "application/pdf",
                  data: parsed.data,
                },
              };
            }
            return {
              type: "image",
              source: {
                type: "base64",
                media_type: parsed?.mimeType || "image/jpeg",
                data: parsed?.data || "",
              },
            };
          });
    if (index === lastUserMessageIndex && documentBlocks.length) {
      content.push(...documentBlocks);
    }
    return {
      role: m.role as "user" | "assistant",
      content,
    };
  });
  const payload: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.effectiveMaxTokens,
    messages: nonSystemMessages,
  };
  const reasoningPayload = buildReasoningPayload(
    params.reasoning,
    false,
    params.model,
    params.apiBase,
    "anthropic_messages",
    {
      maxTokens: params.effectiveMaxTokens,
      anthropicModeOverride: params.anthropicModeOverride,
      profileOverride: params.profileOverride,
    },
  );
  Object.assign(payload, reasoningPayload.extra);
  if (systemParts.length > 0) {
    const systemText = systemParts.join("\n\n");
    const cacheControl =
      params.contextCache?.enabled &&
      params.contextCache.requestHints?.anthropicBlockCacheControl
        ? params.contextCache.requestHints.anthropicBlockCacheControl
        : undefined;
    payload.system = cacheControl
      ? [{ type: "text", text: systemText, cache_control: cacheControl }]
      : systemText;
  }
  if (!reasoningPayload.omitTemperature) {
    payload.temperature = params.effectiveTemperature;
  }
  if (params.stream) {
    payload.stream = true;
  }
  return payload;
}

async function parseAnthropicStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
  onUsage?: (usage: UsageStats) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: { type?: string; text?: string; thinking?: string };
            usage?: { output_tokens?: number };
            message?: {
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                cache_creation_input_tokens?: number;
                cache_read_input_tokens?: number;
              };
            };
          };
          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "text_delta" &&
            parsed.delta.text
          ) {
            fullText += parsed.delta.text;
            onDelta(parsed.delta.text);
          }
          if (
            parsed.type === "content_block_delta" &&
            parsed.delta?.type === "thinking_delta" &&
            parsed.delta.thinking &&
            onReasoning
          ) {
            onReasoning({ details: parsed.delta.thinking });
          }
          if (
            parsed.type === "message_start" &&
            parsed.message?.usage &&
            onUsage
          ) {
            const inputTokens = parsed.message.usage.input_tokens ?? 0;
            const outputTokens = parsed.message.usage.output_tokens ?? 0;
            const totalTokens = inputTokens + outputTokens;
            if (inputTokens > 0 || totalTokens > 0) {
              const cacheUsage = extractContextCacheUsage(parsed.message.usage);
              onUsage({
                promptTokens: inputTokens,
                completionTokens: outputTokens,
                totalTokens,
                ...cacheUsage,
                contextTokens: inputTokens,
                contextWindowIsAuthoritative: inputTokens > 0,
              });
            }
          }
          if (parsed.type === "message_delta" && parsed.usage && onUsage) {
            const outputTokens = parsed.usage.output_tokens ?? 0;
            if (outputTokens > 0) {
              onUsage({
                promptTokens: 0,
                completionTokens: outputTokens,
                totalTokens: outputTokens,
              });
            }
          }
        } catch (_err) {
          // ignore parse errors
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

function buildGeminiNativePayload(params: {
  model: string;
  apiBase?: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number;
  /** Omitted from the payload when undefined (Gemini 3 server default). */
  temperature: number | undefined;
  reasoning?: ReasoningConfig;
  pdfParts?: Array<{ base64: string }>;
  profileOverride?: ModelProfileOverride;
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) => ({
      text:
        typeof m.content === "string"
          ? m.content
          : m.content.map((c) => ("text" in c ? c.text : "")).join(""),
    }))
    .filter((p) => p.text);
  const contents: Array<{ role: string; parts: unknown[] }> = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((c) =>
              c.type === "image_url"
                ? (() => {
                    const parsed = parseDataUrl(
                      (c as { image_url: { url: string } }).image_url.url,
                    );
                    return {
                      inline_data: {
                        mime_type: parsed?.mimeType || "image/jpeg",
                        data: parsed?.data || "",
                      },
                    };
                  })()
                : { text: (c as { text: string }).text },
            ),
    }));
  if (params.pdfParts?.length) {
    let lastUserIdx = -1;
    for (let i = contents.length - 1; i >= 0; i--) {
      if (contents[i].role === "user") {
        lastUserIdx = i;
        break;
      }
    }
    if (lastUserIdx >= 0) {
      for (const p of params.pdfParts) {
        contents[lastUserIdx].parts.push({
          inlineData: { mimeType: "application/pdf", data: p.base64 },
        });
      }
    }
  }
  // User extra parameters ride along here the same as on every other
  // protocol; a user generationConfig is merged under the envelope so the
  // dedicated temperature/max-token fields keep the last word on a collision.
  const extraBody = resolveUserExtraBody(params.profileOverride, params.model);
  const { generationConfig: extraGenerationConfig, ...extraTop } = (extraBody ||
    {}) as { generationConfig?: unknown } & Record<string, unknown>;
  const payload: Record<string, unknown> = {
    ...extraTop,
    contents,
    generationConfig: {
      ...(isRecord(extraGenerationConfig) ? extraGenerationConfig : {}),
      maxOutputTokens: params.effectiveMaxTokens,
      ...(params.temperature !== undefined
        ? { temperature: params.temperature }
        : {}),
    },
  };
  if (params.reasoning?.provider === "gemini") {
    const declarative = compileReasoningControls(
      getModelCapabilities({
        provider: "gemini",
        model: params.model,
        apiBase: params.apiBase,
        protocol: "gemini_native",
        profileOverride: params.profileOverride,
      }),
      params.reasoning,
    );
    const generationConfig = payload.generationConfig as Record<
      string,
      unknown
    >;
    const declaredGenerationConfig =
      declarative?.extra.generationConfig ||
      declarative?.extra.generation_config;
    if (
      declaredGenerationConfig &&
      typeof declaredGenerationConfig === "object" &&
      !Array.isArray(declaredGenerationConfig)
    ) {
      Object.assign(generationConfig, declaredGenerationConfig);
    }
    const declarativeConfig =
      declarative?.extra.thinkingConfig ||
      declarative?.extra.thinking_config ||
      generationConfig.thinkingConfig;
    if (isRecord(declarativeConfig)) {
      generationConfig.thinkingConfig =
        withGeminiThoughtSummaries(declarativeConfig);
    } else {
      const profile = getGeminiReasoningProfile(params.model);
      const value =
        profile.levelToValue[params.reasoning.level] ??
        profile.levelToValue[profile.defaultLevel] ??
        profile.defaultValue;
      (payload.generationConfig as Record<string, unknown>).thinkingConfig =
        profile.param === "thinking_budget"
          ? {
              includeThoughts: true,
              thinkingBudget: typeof value === "number" ? value : 8192,
            }
          : {
              includeThoughts: true,
              thinkingLevel:
                value === "minimal" ||
                value === "low" ||
                value === "medium" ||
                value === "high"
                  ? value
                  : "medium",
            };
    }
    if (declarative?.omitTemperature) delete generationConfig.temperature;
  }
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  return payload;
}

export function buildPromptCachePayloadHints(
  contextCache: ContextCachePlan | undefined,
): Record<string, unknown> {
  if (!contextCache?.enabled || !contextCache.requestHints) return {};
  const hints: Record<string, unknown> = {};
  if (contextCache.requestHints.promptCacheKey) {
    hints.prompt_cache_key = contextCache.requestHints.promptCacheKey;
  }
  if (contextCache.requestHints.promptCacheRetention) {
    hints.prompt_cache_retention =
      contextCache.requestHints.promptCacheRetention;
  }
  return hints;
}

function assertCodexAppServerUsesNativeRuntime(
  authMode: ModelProviderAuthMode,
): void {
  if (authMode !== "codex_app_server") return;
  throw new Error(
    "Codex App Server is only supported through the native Codex conversation system. " +
      "Use Codex Direct (Legacy) for the direct backend transport.",
  );
}

/**
 * Gemini marks thought-summary parts with `thought: true` when
 * `includeThoughts` is requested.  A `thoughtSignature` alone does NOT make a
 * part a thought: Gemini 3 attaches signatures to regular answer parts too.
 */
function isGeminiThoughtSummaryPart(part: { thought?: unknown }): boolean {
  return part.thought === true;
}

async function parseGeminiNativeStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
  onUsage?: (usage: UsageStats) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const parsed = JSON.parse(data) as {
            candidates?: Array<{
              content?: {
                parts?: Array<{ text?: string; thought?: unknown }>;
              };
            }>;
            usageMetadata?: {
              promptTokenCount?: number;
              candidatesTokenCount?: number;
              totalTokenCount?: number;
              cachedContentTokenCount?: number;
            };
          };
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          const thoughtText = parts
            .filter((p) => isGeminiThoughtSummaryPart(p))
            .map((p) => p.text || "")
            .join("");
          if (thoughtText && onReasoning) {
            onReasoning({ details: thoughtText });
          }
          const text = parts
            .filter((p) => !isGeminiThoughtSummaryPart(p))
            .map((p) => p.text || "")
            .join("");
          if (text) {
            fullText += text;
            onDelta(text);
          }
          if (parsed.usageMetadata && onUsage) {
            const total = parsed.usageMetadata.totalTokenCount ?? 0;
            if (total > 0) {
              const cacheUsage = extractContextCacheUsage(parsed.usageMetadata);
              onUsage({
                promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
                completionTokens:
                  parsed.usageMetadata.candidatesTokenCount ?? 0,
                totalTokens: total,
                ...cacheUsage,
                contextTokens: parsed.usageMetadata.promptTokenCount ?? 0,
                contextWindowIsAuthoritative:
                  (parsed.usageMetadata.promptTokenCount ?? 0) > 0,
              });
            }
          }
        } catch (_err) {
          // ignore parse errors
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

// ── Ollama native (/api/chat) ────────────────────────────────────────────────

/**
 * Ollama's chat message shape. Unlike OpenAI, images are not content parts:
 * they ride alongside the text as an array of bare base64 strings.
 */
type OllamaChatMessage = {
  role: string;
  content: string;
  images?: string[];
};

function toOllamaChatMessages(messages: ChatMessage[]): OllamaChatMessage[] {
  return messages.map((message) => {
    if (typeof message.content === "string") {
      return { role: message.role, content: message.content };
    }
    const textParts: string[] = [];
    const images: string[] = [];
    for (const part of message.content) {
      if (part.type === "text") {
        textParts.push(part.text);
        continue;
      }
      // Ollama wants raw base64 with no data: prefix; a plain URL cannot be
      // forwarded, so drop it rather than sending something unfetchable.
      const parsed = parseDataUrl(part.image_url?.url || "");
      if (parsed?.data) images.push(parsed.data);
    }
    return {
      role: message.role,
      content: textParts.join("\n"),
      ...(images.length ? { images } : {}),
    };
  });
}

/**
 * The one Ollama `/api/chat` envelope builder, shared by chat mode and the
 * agent adapter so the merge subtleties below exist in exactly one place.
 */
export function buildOllamaChatPayload(params: {
  model: string;
  /** Pre-converted messages (agent adapter) or ChatMessages (chat mode). */
  messages: ChatMessage[] | Array<Record<string, unknown>>;
  messagesAreConverted?: boolean;
  stream: boolean;
  temperature?: number;
  /**
   * Output cap. Ollama's own default is unlimited (-1); a thinking model that
   * inherits the plugin's 4096 default can spend the whole budget reasoning and
   * return empty content, so callers pass -1 unless the user set a value.
   */
  numPredict?: number;
  /** Runtime context window, so what we claim and what Ollama allocates agree. */
  numCtx?: number;
  /** Tool definitions (agent mode). User extra params never occupy this key. */
  tools?: unknown[];
  reasoningExtra?: Record<string, unknown>;
}): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (params.temperature !== undefined)
    options.temperature = params.temperature;
  if (params.numPredict !== undefined) options.num_predict = params.numPredict;
  if (params.numCtx !== undefined) options.num_ctx = params.numCtx;
  const { options: extraOptions, ...extraTop } = (params.reasoningExtra ||
    {}) as { options?: unknown } & Record<string, unknown>;
  // `options` is merged rather than spread over: a user parameter such as
  // `options.repeat_penalty` would otherwise replace the whole object and
  // silently drop num_ctx, reinstating the context truncation this protocol
  // exists to avoid. User keys win within the merge; the envelope does not.
  const mergedOptions = isRecord(extraOptions)
    ? { ...options, ...extraOptions }
    : options;
  return {
    model: params.model,
    messages: params.messagesAreConverted
      ? params.messages
      : toOllamaChatMessages(params.messages as ChatMessage[]),
    stream: params.stream,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(Object.keys(mergedOptions).length ? { options: mergedOptions } : {}),
    ...extraTop,
  };
}

/**
 * Ollama's own `num_predict` default is -1 (unlimited). The plugin's 4096
 * default is a hazard here: a thinking model can spend the entire budget
 * reasoning and return empty content. Treat the untouched plugin default as
 * "unset" and let the server decide; any other value is the user's explicit
 * choice and is honoured.
 */
export function resolveOllamaNumPredict(
  effectiveMaxTokens: number,
  maxTokensExplicit = false,
): number {
  return !maxTokensExplicit && effectiveMaxTokens === DEFAULT_MAX_TOKENS
    ? -1
    : effectiveMaxTokens;
}

/**
 * Ollama's runtime context window defaults well below a model's trained
 * maximum, so a prompt sized against the trained figure is silently truncated.
 * Allocating exactly the cap the plugin trimmed to keeps the claim and the
 * allocation in agreement.
 */
export function resolveOllamaNumCtx(
  protocol: ProviderProtocol,
  limitTokens: number,
): number | undefined {
  if (protocol !== "ollama_native") return undefined;
  return Number.isSafeInteger(limitTokens) && limitTokens > 0
    ? limitTokens
    : undefined;
}

type OllamaChatChunk = {
  message?: {
    content?: unknown;
    thinking?: unknown;
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown };
    }>;
  };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
};

/** A tool call as Ollama frames it; the agent layer assigns ids itself. */
export type OllamaRawToolCall = { name: string; arguments: unknown };

/**
 * Parse Ollama's `/api/chat` stream — the one NDJSON parser for both chat
 * mode and the agent adapter, so a wire quirk is fixed in exactly one place.
 *
 * The framing is NDJSON — one complete JSON object per line, with no `data:`
 * prefix — so `parseStreamResponse` cannot be reused: it skips every line that
 * does not start with `data:` and would silently return "".
 *
 * `message.thinking` and `message.content` arrive as separate fields, which is
 * the whole reason this protocol exists (see #363): over Ollama's
 * OpenAI-compatible endpoint some models put the entire answer in the reasoning
 * field and leave content empty.
 *
 * Ollama emits each tool call complete in a single chunk, so `onToolCall`
 * fires once per call with no per-index accumulation.
 */
export async function parseOllamaChatStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void | Promise<void>,
  onReasoning?: (event: ReasoningEvent) => void | Promise<void>,
  onUsage?: (usage: UsageStats) => void | Promise<void>,
  onToolCall?: (call: OllamaRawToolCall) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";

  const handleLine = async (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: OllamaChatChunk;
    try {
      parsed = JSON.parse(trimmed) as OllamaChatChunk;
    } catch (err) {
      ztoolkit.log("Ollama stream parse error:", err);
      return;
    }
    if (parsed.error) {
      throw new Error(`Ollama error: ${parsed.error}`);
    }
    const thinking = normalizeStreamText(parsed.message?.thinking ?? "");
    if (thinking && onReasoning) await onReasoning({ details: thinking });
    const content = normalizeStreamText(parsed.message?.content ?? "");
    if (content) {
      fullText += content;
      await onDelta(content);
    }
    if (onToolCall && Array.isArray(parsed.message?.tool_calls)) {
      for (const call of parsed.message.tool_calls) {
        const name = call?.function?.name?.trim();
        if (!name) continue;
        onToolCall({ name, arguments: call.function?.arguments });
      }
    }
    if (parsed.done && onUsage) {
      const promptTokens = parsed.prompt_eval_count ?? 0;
      const completionTokens = parsed.eval_count ?? 0;
      const totalTokens = promptTokens + completionTokens;
      if (totalTokens > 0) {
        await onUsage({
          promptTokens,
          completionTokens,
          totalTokens,
          contextTokens: promptTokens,
          contextWindowIsAuthoritative: promptTokens > 0,
        });
      }
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) await handleLine(line);
    }
    // Flush a trailing object that arrived without a closing newline.
    if (buffer.trim()) await handleLine(buffer);
  } finally {
    reader.releaseLock();
  }

  return fullText;
}

function createChatPayloadBuilder(params: {
  model: string;
  messages: ChatMessage[];
  useResponses: boolean;
  responseFileIds?: string[];
  authMode: ModelProviderAuthMode;
  apiBase: string;
  providerProtocol?: ProviderProtocol;
  effectiveTemperature: number;
  effectiveMaxTokens: number;
  stream: boolean;
  contextCache?: ContextCachePlan;
  profileOverride?: ModelProfileOverride;
}) {
  const {
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    providerProtocol,
    effectiveTemperature,
    effectiveMaxTokens,
    stream,
    contextCache,
  } = params;
  return (reasoningOverride: ReasoningConfig | undefined) => {
    const isCodexAuth = authMode === "codex_auth";
    const responsesInput = useResponses
      ? buildResponsesInput(messages, responseFileIds, {
          preserveSystemMessages: isGrokApiBase(apiBase),
        })
      : null;
    const chatMessages = useResponses
      ? messages
      : mergeSystemMessagesForChatPayload(messages);
    if (useResponses && isCodexAuth && responsesInput) {
      const codexReasoningEffort = sanitizeCodexDirectReasoningConfig(
        model,
        reasoningOverride,
      )?.effort;
      const codexInstructionsParts = [
        responsesInput.instructions || "You are a helpful assistant.",
        codexReasoningEffort
          ? "Before the final answer, output one concise high-level reasoning summary wrapped in <thought>...</thought>."
          : "",
      ]
        .map((entry) => entry.trim())
        .filter(Boolean);
      const codexPayload = {
        model,
        ...responsesInput,
        instructions: codexInstructionsParts.join("\n\n"),
        ...(codexReasoningEffort
          ? { reasoning: { effort: codexReasoningEffort, summary: "detailed" } }
          : {}),
        store: false,
        stream: true,
      };
      return codexPayload as Record<string, unknown>;
    }

    const reasoningPayload = buildReasoningPayload(
      reasoningOverride,
      useResponses,
      model,
      apiBase,
      providerProtocol,
      {
        maxTokens: effectiveMaxTokens,
        profileOverride: params.profileOverride,
      },
    );
    const temperatureParam = reasoningPayload.omitTemperature
      ? {}
      : { temperature: effectiveTemperature };
    const cachePayloadHints = buildPromptCachePayloadHints(contextCache);

    const payload = useResponses
      ? {
          model,
          ...responsesInput,
          ...cachePayloadHints,
          ...reasoningPayload.extra,
          ...temperatureParam,
          ...buildResponsesTokenParam(effectiveMaxTokens),
        }
      : {
          model,
          messages: chatMessages,
          ...cachePayloadHints,
          ...reasoningPayload.extra,
          ...temperatureParam,
          ...buildTokenParam(model, effectiveMaxTokens),
        };

    if (stream) {
      return {
        ...payload,
        stream: true,
        // Ask OpenAI-compatible endpoints to include usage in the final stream chunk
        ...(useResponses ? {} : { stream_options: { include_usage: true } }),
      } as Record<string, unknown>;
    }
    return payload as Record<string, unknown>;
  };
}

function stripTemperature(payload: Record<string, unknown>) {
  if (!Object.prototype.hasOwnProperty.call(payload, "temperature")) {
    return payload;
  }
  const clone = { ...payload };
  delete clone.temperature;
  return clone;
}

type TemperaturePolicy =
  | { mode: "default" }
  | { mode: "omit" }
  | { mode: "fixed"; value: number };

const temperaturePolicyCache = new Map<string, TemperaturePolicy>();

function getTemperaturePolicyKey(
  url: string,
  payload: Record<string, unknown>,
) {
  const model =
    typeof payload.model === "string" ? payload.model.trim().toLowerCase() : "";
  return `${url}::${model}`;
}

function applyTemperaturePolicy(
  payload: Record<string, unknown>,
  policy: TemperaturePolicy,
) {
  if (policy.mode === "omit") {
    return stripTemperature(payload);
  }
  if (policy.mode === "fixed") {
    return {
      ...payload,
      temperature: policy.value,
    };
  }
  return payload;
}

function extractFixedTemperature(message: string): number | null {
  const text = message.toLowerCase();
  const patterns = [
    /only\s+(-?\d+(?:\.\d+)?)\s+is\s+allowed/,
    /temperature[^.\n]*must\s+be\s+(-?\d+(?:\.\d+)?)/,
    /temperature[^.\n]*should\s+be\s+(-?\d+(?:\.\d+)?)/,
    /allowed\s+temperature[^.\n]*:\s*(-?\d+(?:\.\d+)?)/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    const value = Number.parseFloat(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

function getTemperatureRecoveryPolicy(
  status: number,
  message: string,
): TemperaturePolicy | null {
  if (status !== 400 && status !== 422) return null;
  const text = message.toLowerCase();
  if (!text.includes("temperature")) return null;

  const fixedValue = extractFixedTemperature(text);
  if (fixedValue !== null) {
    return { mode: "fixed", value: fixedValue };
  }

  if (
    text.includes("not supported") ||
    text.includes("unsupported") ||
    text.includes("not allowed") ||
    text.includes("unknown parameter") ||
    text.includes("invalid parameter") ||
    text.includes("invalid temperature") ||
    text.includes("deprecated")
  ) {
    return { mode: "omit" };
  }

  return null;
}

export type RequestAuthState = {
  mode: ModelProviderAuthMode;
  token: string;
  codex?: {
    authPath: string;
    refreshToken: string;
    accountId?: string;
  };
  copilot?: {
    githubToken: string;
  };
};

function buildAuthHeaders(
  token: string,
  mode?: ModelProviderAuthMode,
  accountId?: string,
): Record<string, string> {
  if (mode === "copilot_auth") {
    return buildCopilotHeaders(token);
  }
  if (mode === "codex_auth") {
    return buildCodexAuthHeaders(
      { token, accountId },
      { "Content-Type": "application/json" },
    );
  }
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

async function refreshCodexAuthState(
  state: RequestAuthState,
  signal?: AbortSignal,
): Promise<RequestAuthState> {
  if (state.mode !== "codex_auth") return state;
  const session =
    state.codex?.authPath && state.codex.refreshToken
      ? {
          token: state.token,
          authPath: state.codex.authPath,
          refreshToken: state.codex.refreshToken,
          accountId: state.codex.accountId,
        }
      : await resolveCodexAuthSession({ signal, fetchFn: getFetch() });
  const refreshed = await refreshCodexAuthSession(session, {
    signal,
    fetchFn: getFetch(),
  });
  return {
    mode: "codex_auth",
    token: refreshed.token,
    codex: {
      authPath: refreshed.authPath,
      refreshToken: refreshed.refreshToken,
      ...(refreshed.accountId ? { accountId: refreshed.accountId } : {}),
    },
  };
}

async function refreshCopilotAuthState(
  state: RequestAuthState,
  signal?: AbortSignal,
): Promise<RequestAuthState> {
  if (state.mode !== "copilot_auth" || !state.copilot?.githubToken) {
    return state;
  }
  cachedCopilotJwt = null;
  const token = await resolveCopilotAccessToken({
    githubToken: state.copilot.githubToken,
    signal,
  });
  return {
    mode: "copilot_auth",
    token,
    copilot: { githubToken: state.copilot.githubToken },
  };
}

async function postWithTemperatureFallback(params: {
  url: string;
  auth: RequestAuthState;
  payload: Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}) {
  const policyKey = getTemperaturePolicyKey(params.url, params.payload);
  const hasTemperature = Object.prototype.hasOwnProperty.call(
    params.payload,
    "temperature",
  );
  const send = (bodyPayload: Record<string, unknown>, auth: RequestAuthState) =>
    getFetch()(params.url, {
      method: "POST",
      headers:
        params.headers ??
        buildAuthHeaders(auth.token, auth.mode, auth.codex?.accountId),
      body: JSON.stringify(bodyPayload),
      signal: params.signal,
    });

  let requestPayload = params.payload;
  const cachedPolicy = temperaturePolicyCache.get(policyKey);
  if (hasTemperature && cachedPolicy) {
    requestPayload = applyTemperaturePolicy(params.payload, cachedPolicy);
  }

  let authState = params.auth;
  let res = await send(requestPayload, authState);
  if (res.status === 401) {
    if (authState.mode === "codex_auth" && authState.codex?.refreshToken) {
      authState = await refreshCodexAuthState(authState, params.signal);
      res = await send(requestPayload, authState);
    } else if (
      authState.mode === "copilot_auth" &&
      authState.copilot?.githubToken
    ) {
      authState = await refreshCopilotAuthState(authState, params.signal);
      res = await send(requestPayload, authState);
    }
  }
  if (res.ok) return res;

  const firstErr = await res.text();
  const recoveryPolicy = hasTemperature
    ? getTemperatureRecoveryPolicy(res.status, firstErr)
    : null;
  if (recoveryPolicy) {
    const fallbackPayload = applyTemperaturePolicy(
      params.payload,
      recoveryPolicy,
    );
    res = await send(fallbackPayload, authState);
    if (res.status === 401) {
      if (authState.mode === "codex_auth" && authState.codex?.refreshToken) {
        authState = await refreshCodexAuthState(authState, params.signal);
        res = await send(fallbackPayload, authState);
      } else if (
        authState.mode === "copilot_auth" &&
        authState.copilot?.githubToken
      ) {
        authState = await refreshCopilotAuthState(authState, params.signal);
        res = await send(fallbackPayload, authState);
      }
    }
    if (res.ok) {
      temperaturePolicyCache.set(policyKey, recoveryPolicy);
      return res;
    }
    const secondErr = await res.text();
    throw new Error(
      `${res.status} ${res.statusText} (${params.url}) - ${secondErr}`,
    );
  }

  throw new Error(
    `${res.status} ${res.statusText} (${params.url}) - ${firstErr}`,
  );
}

export function parseStatusFromErrorMessage(message: string): number | null {
  const match = message.trim().match(/^(\d{3})\b/);
  if (!match) return null;
  const value = Number.parseInt(match[1], 10);
  return Number.isFinite(value) ? value : null;
}

function isReasoningErrorMessage(errorMessage: string): boolean {
  const status = parseStatusFromErrorMessage(errorMessage);
  if (status !== 400 && status !== 422) return false;
  const text = errorMessage.toLowerCase();
  return (
    text.includes("reasoning") ||
    text.includes("effort") ||
    text.includes("thinking") ||
    text.includes("enable_thinking") ||
    text.includes("chat_template_kwargs") ||
    text.includes("thinking_level") ||
    text.includes("thinking_budget") ||
    text.includes("budget_tokens") ||
    // Ollama rejects an unsupported think level, e.g. a string level sent to a
    // model that only accepts a boolean.
    text.includes("think")
  );
}

function getReasoningRecoverySelection(params: {
  currentReasoning: ReasoningSelection | undefined;
  modelName?: string;
}): ReasoningSelection | undefined | null {
  const { currentReasoning, modelName } = params;
  if (!currentReasoning) return null;
  const defaultLevel = getReasoningDefaultLevelForModel(
    currentReasoning.provider,
    modelName,
  );
  if (defaultLevel && currentReasoning.level !== defaultLevel) {
    return {
      provider: currentReasoning.provider,
      level: defaultLevel,
    };
  }
  return undefined;
}

function getReasoningSelectionKey(
  reasoningSelection: ReasoningSelection | undefined,
): string {
  if (!reasoningSelection) return "none";
  return [
    reasoningSelection.provider,
    reasoningSelection.level,
    reasoningSelection.effort || "",
    reasoningSelection.anthropicModeOverride || "",
  ].join(":");
}

export function getAnthropicMessagesReasoningRecoverySelection(params: {
  currentReasoning: ReasoningSelection | undefined;
  modelName?: string;
}): ReasoningSelection | undefined | null {
  const { currentReasoning, modelName } = params;
  if (!currentReasoning) return null;
  if (currentReasoning.provider !== "anthropic") {
    return getReasoningRecoverySelection(params);
  }
  const profile = getAnthropicReasoningProfile(modelName);
  const currentMode = resolveAnthropicThinkingMode({
    profile,
    override: currentReasoning.anthropicModeOverride,
  });
  if (currentMode === "adaptive" && profile.supportsManualThinking) {
    return {
      provider: "anthropic",
      level: currentReasoning.level,
      anthropicModeOverride: "manual",
    };
  }
  return undefined;
}

export async function postWithReasoningFallback(params: {
  url: string;
  auth: RequestAuthState;
  modelName?: string;
  initialReasoning: ReasoningSelection | undefined;
  buildPayload: (
    reasoningOverride: ReasoningSelection | undefined,
  ) => Record<string, unknown>;
  getRecoverySelection?: (params: {
    currentReasoning: ReasoningSelection | undefined;
    modelName?: string;
  }) => ReasoningSelection | undefined | null;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}) {
  let reasoningSelection = params.initialReasoning;
  let retries = 0;
  const maxRetries = 2;
  let lastError: unknown;
  const attemptedSelections = new Set<string>([
    getReasoningSelectionKey(reasoningSelection),
  ]);

  while (retries <= maxRetries) {
    const payload = params.buildPayload(reasoningSelection);
    try {
      return await postWithTemperatureFallback({
        url: params.url,
        auth: params.auth,
        payload,
        signal: params.signal,
        headers: params.headers,
      });
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      if (!isReasoningErrorMessage(message)) {
        throw err;
      }
      const recovered = (
        params.getRecoverySelection || getReasoningRecoverySelection
      )({
        currentReasoning: reasoningSelection,
        modelName: params.modelName,
      });
      if (recovered === null) {
        throw err;
      }
      const nextKey = getReasoningSelectionKey(recovered);
      if (attemptedSelections.has(nextKey)) {
        throw err;
      }
      ztoolkit.log("LLM: Retrying after reasoning payload rejection", {
        model: params.modelName,
        from: getReasoningSelectionKey(reasoningSelection),
        to: nextKey,
        error: message,
      });
      attemptedSelections.add(nextKey);
      reasoningSelection = recovered;
      retries += 1;
    }
  }

  throw (lastError as Error) || new Error("Request failed after retries");
}

function extractResponsesOutputText(data: {
  output_text?: string;
  output?: Array<{
    content?: Array<{ type?: string; text?: string }>;
  }>;
}): string {
  if (data?.output_text) return data.output_text;
  const firstText =
    data?.output
      ?.flatMap((item) => item.content || [])
      .find((content) => content.type === "output_text" && content.text)
      ?.text || "";
  return firstText || JSON.stringify(data);
}

export async function resolveRequestAuthState(params: {
  authMode: ModelProviderAuthMode;
  apiKey: string;
  signal?: AbortSignal;
}): Promise<RequestAuthState> {
  if (params.authMode === "codex_auth") {
    const resolved = await resolveCodexAuthSession({
      signal: params.signal,
      fetchFn: getFetch(),
    });
    return {
      mode: "codex_auth",
      token: resolved.token,
      codex: {
        authPath: resolved.authPath,
        refreshToken: resolved.refreshToken,
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
      },
    };
  }
  if (params.authMode === "copilot_auth") {
    const token = await resolveCopilotAccessToken({
      githubToken: params.apiKey,
      signal: params.signal,
    });
    return {
      mode: "copilot_auth",
      token,
      copilot: { githubToken: params.apiKey },
    };
  }
  return {
    mode: "api_key",
    token: params.apiKey,
  };
}

// =============================================================================
// API Functions
// =============================================================================

/**
 * Handles anthropic_messages, gemini_native and ollama_native protocols for
 * both streaming and non-streaming calls. Passing onDelta enables streaming.
 */
async function callNativeProtocol(params: {
  protocol: "anthropic_messages" | "gemini_native" | "ollama_native";
  apiBase: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number;
  maxTokensExplicit?: boolean;
  /** Raw request temperature; protocol-specific defaults are applied here. */
  rawTemperature?: number | string;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReasoning?: (event: ReasoningEvent) => void;
  onUsage?: (usage: UsageStats) => void;
  attachments?: ChatFileAttachment[];
  reasoning?: ReasoningConfig;
  contextCache?: ContextCachePlan;
  /** ollama_native only: runtime context window to allocate. */
  numCtx?: number;
  profileOverride?: ModelProfileOverride;
}): Promise<string> {
  const {
    protocol,
    apiBase,
    apiKey,
    model,
    messages,
    effectiveMaxTokens,
    rawTemperature,
    signal,
    onDelta,
    onReasoning,
    onUsage,
  } = params;
  const isStreaming = Boolean(onDelta);
  const url =
    protocol === "anthropic_messages"
      ? resolveAnthropicMessagesEndpoint(apiBase)
      : protocol === "ollama_native"
        ? resolveOllamaNativeEndpoint(apiBase)
        : resolveGeminiNativeEndpoint({ apiBase, model, stream: isStreaming });
  const headers = buildProviderTransportHeaders({ protocol, apiKey });
  const pdfParts: Array<{ base64: string }> = [];
  if (
    (protocol === "anthropic_messages" || protocol === "gemini_native") &&
    params.attachments?.length
  ) {
    for (const att of params.attachments) {
      if (!att.storedPath) continue;
      const mime = att.mimeType || "";
      if (
        mime !== "application/pdf" &&
        !att.name?.toLowerCase().endsWith(".pdf")
      )
        continue;
      try {
        const base64 = await readFileRefAsBase64(att.storedPath);
        pdfParts.push({ base64 });
      } catch (err) {
        ztoolkit.log(`LLM: Failed to read PDF attachment for ${protocol}`, err);
      }
    }
  }
  const buildBody = (reasoningOverride: ReasoningSelection | undefined) =>
    protocol === "ollama_native"
      ? buildOllamaChatPayload({
          model,
          messages,
          stream: isStreaming,
          temperature: normalizeTemperature(rawTemperature),
          numPredict: resolveOllamaNumPredict(
            effectiveMaxTokens,
            params.maxTokensExplicit,
          ),
          numCtx: params.numCtx,
          reasoningExtra: buildReasoningPayload(
            reasoningOverride,
            false,
            model,
            apiBase,
            "ollama_native",
            { profileOverride: params.profileOverride },
          ).extra,
        })
      : protocol === "anthropic_messages"
        ? buildAnthropicMessagesPayload({
            model,
            messages,
            effectiveMaxTokens,
            effectiveTemperature: normalizeTemperature(rawTemperature),
            stream: isStreaming,
            reasoning: reasoningOverride,
            apiBase,
            anthropicModeOverride: reasoningOverride?.anthropicModeOverride,
            pdfParts: pdfParts.length ? pdfParts : undefined,
            contextCache: params.contextCache,
            profileOverride: params.profileOverride,
          })
        : buildGeminiNativePayload({
            model,
            apiBase,
            messages,
            effectiveMaxTokens,
            temperature: resolveGeminiTemperature(model, rawTemperature),
            reasoning: reasoningOverride,
            pdfParts: pdfParts.length ? pdfParts : undefined,
            profileOverride: params.profileOverride,
          });
  const res = await postWithReasoningFallback({
    url,
    auth: { mode: "api_key", token: apiKey },
    headers,
    modelName: model,
    initialReasoning: params.reasoning,
    buildPayload: buildBody,
    signal,
    getRecoverySelection:
      protocol === "anthropic_messages"
        ? getAnthropicMessagesReasoningRecoverySelection
        : undefined,
  });
  if (!res.ok) {
    throw new Error(`${res.status} (${url}) - ${await res.text()}`);
  }
  if (isStreaming) {
    if (!res.body) return callNativeProtocol({ ...params, onDelta: undefined });
    return protocol === "anthropic_messages"
      ? parseAnthropicStreamResponse(res.body, onDelta!, onReasoning, onUsage)
      : protocol === "ollama_native"
        ? parseOllamaChatStream(res.body, onDelta!, onReasoning, onUsage)
        : parseGeminiNativeStreamResponse(
            res.body,
            onDelta!,
            onReasoning,
            onUsage,
          );
  }
  if (protocol === "ollama_native") {
    const data = (await res.json()) as OllamaChatChunk;
    const thinking = normalizeStreamText(data?.message?.thinking ?? "");
    if (thinking && onReasoning) onReasoning({ details: thinking });
    // Deliberately no fallback to `thinking` when content is empty: if the
    // server put the answer in the reasoning field that is the server's bug,
    // and silently promoting it would hide a misconfiguration (see #363).
    return normalizeStreamText(data?.message?.content ?? "");
  }
  if (protocol === "anthropic_messages") {
    const data = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    return (
      data?.content?.find((c) => c.type === "text")?.text ??
      JSON.stringify(data)
    );
  }
  const data = (await res.json()) as {
    candidates?: Array<{
      content?: { parts?: Array<{ text?: string; thought?: unknown }> };
    }>;
  };
  return (
    data.candidates?.[0]?.content?.parts
      ?.filter((p) => !isGeminiThoughtSummaryPart(p))
      .map((p) => p.text || "")
      .join("") ?? JSON.stringify(data)
  );
}

/**
 * Call LLM API (non-streaming)
 */
export async function callLLM(params: ChatParams): Promise<string> {
  await preflightRequestModelCapabilities(params);
  const prepared = prepareChatRequest(params);
  const {
    apiBase,
    apiKey,
    authMode,
    model,
    messages,
    inputCap,
    providerProtocol,
  } = prepared;
  if (authMode === "codex_auth") {
    assertCodexDirectModelAvailable(model);
  }
  if (
    providerProtocol === "anthropic_messages" ||
    providerProtocol === "gemini_native" ||
    providerProtocol === "ollama_native"
  ) {
    return callNativeProtocol({
      protocol: providerProtocol,
      apiBase,
      apiKey,
      model,
      messages,
      effectiveMaxTokens: normalizeMaxTokensForRequest({
        value: params.maxTokens,
        maxTokensExplicit: params.maxTokensExplicit,
        model,
        apiBase,
        protocol: providerProtocol,
        authMode,
        profileOverride: params.profileOverride,
      }),
      maxTokensExplicit: params.maxTokensExplicit === true,
      rawTemperature: params.temperature,
      signal: params.signal,
      attachments: params.attachments,
      reasoning: params.reasoning,
      contextCache: params.contextCache,
      numCtx: resolveOllamaNumCtx(providerProtocol, inputCap.limitTokens),
      profileOverride: params.profileOverride,
    });
  }
  assertCodexAppServerUsesNativeRuntime(authMode);
  if (authMode === "codex_auth") {
    let output = "";
    const streamed = await callLLMStream(
      params,
      (delta) => {
        output += delta;
      },
      undefined,
      undefined,
    );
    return output.trim() || streamed.trim() || "OK";
  }
  const auth = await resolveRequestAuthState({
    authMode,
    apiKey,
    signal: params.signal,
  });
  if (inputCap.capped) {
    ztoolkit.log("LLM: Applied model-aware input cap", {
      model,
      beforeTokens: inputCap.estimatedBeforeTokens,
      afterTokens: inputCap.estimatedAfterTokens,
      capTokens: inputCap.limitTokens,
      softCapTokens: inputCap.softLimitTokens,
      effects: inputCap.effects,
    });
  }
  const useResponses =
    providerProtocol === "responses_api" ||
    providerProtocol === "codex_responses";
  // Only upload files via /v1/files for providers that actually host that endpoint.
  // Third-party relays using responses_api get inline base64 instead (via buildResponsesInput).
  const canUploadFiles =
    useResponses && providerSupportsResponsesEndpoint(apiBase);
  const responseFileIds = canUploadFiles
    ? await uploadFilesForResponses({
        apiBase,
        apiKey: auth.token,
        attachments: params.attachments,
        signal: params.signal,
      })
    : [];
  const effectiveTemperature = normalizeTemperature(params.temperature);
  const effectiveMaxTokens = normalizeMaxTokensForRequest({
    value: params.maxTokens,
    maxTokensExplicit: params.maxTokensExplicit,
    model,
    apiBase,
    protocol: providerProtocol,
    authMode,
    profileOverride: params.profileOverride,
  });

  const url = resolveProviderTransportEndpoint({
    protocol: providerProtocol,
    apiBase,
    model,
    stream: false,
    authMode,
  });
  const requestHeaders = buildProviderTransportHeaders({
    protocol: providerProtocol,
    apiKey: auth.token,
    authMode,
  });
  const buildPayload = createChatPayloadBuilder({
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    providerProtocol,
    effectiveTemperature,
    effectiveMaxTokens,
    stream: false,
    contextCache: params.contextCache,
    profileOverride: params.profileOverride,
  });
  const res = await postWithReasoningFallback({
    url,
    auth,
    headers: requestHeaders,
    modelName: model,
    initialReasoning: params.reasoning,
    buildPayload,
    signal: params.signal,
  });

  const data = (await res.json()) as CompletionResponse & {
    output_text?: string;
    output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
  };
  if (useResponses) {
    return extractResponsesOutputText(data);
  }
  return (
    data?.choices?.[0]?.message?.content ??
    data?.choices?.[0]?.text ??
    JSON.stringify(data)
  );
}

/**
 * Call LLM API with streaming response
 */
export async function callLLMStream(
  params: ChatParams,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
  onUsage?: (usage: UsageStats) => void,
): Promise<string> {
  await preflightRequestModelCapabilities(params);
  const prepared = prepareChatRequest(params);
  const {
    apiBase,
    apiKey,
    authMode,
    model,
    messages,
    inputCap,
    providerProtocol,
  } = prepared;
  if (authMode === "codex_auth") {
    assertCodexDirectModelAvailable(model);
  }
  if (
    providerProtocol === "anthropic_messages" ||
    providerProtocol === "gemini_native" ||
    providerProtocol === "ollama_native"
  ) {
    return callNativeProtocol({
      protocol: providerProtocol,
      apiBase,
      apiKey,
      model,
      messages,
      effectiveMaxTokens: normalizeMaxTokensForRequest({
        value: params.maxTokens,
        maxTokensExplicit: params.maxTokensExplicit,
        model,
        apiBase,
        protocol: providerProtocol,
        authMode,
        profileOverride: params.profileOverride,
      }),
      maxTokensExplicit: params.maxTokensExplicit === true,
      rawTemperature: params.temperature,
      signal: params.signal,
      onDelta,
      onReasoning,
      onUsage,
      attachments: params.attachments,
      reasoning: params.reasoning,
      contextCache: params.contextCache,
      numCtx: resolveOllamaNumCtx(providerProtocol, inputCap.limitTokens),
      profileOverride: params.profileOverride,
    });
  }
  assertCodexAppServerUsesNativeRuntime(authMode);
  const auth = await resolveRequestAuthState({
    authMode,
    apiKey,
    signal: params.signal,
  });
  if (inputCap.capped) {
    ztoolkit.log("LLM: Applied model-aware input cap", {
      model,
      beforeTokens: inputCap.estimatedBeforeTokens,
      afterTokens: inputCap.estimatedAfterTokens,
      capTokens: inputCap.limitTokens,
      softCapTokens: inputCap.softLimitTokens,
      effects: inputCap.effects,
    });
  }
  if (
    authMode === "codex_auth" &&
    Array.isArray(params.attachments) &&
    params.attachments.length
  ) {
    throw new Error(
      "codex auth currently does not support file attachments in this plugin v1.",
    );
  }
  const useResponses =
    providerProtocol === "responses_api" ||
    providerProtocol === "codex_responses";
  // Only upload files via /v1/files for providers that actually host that endpoint.
  // Third-party relays using responses_api get inline base64 instead (via buildResponsesInput).
  const canUploadFiles =
    useResponses && providerSupportsResponsesEndpoint(apiBase);
  const responseFileIds = canUploadFiles
    ? await uploadFilesForResponses({
        apiBase,
        apiKey: auth.token,
        attachments: params.attachments,
        signal: params.signal,
      })
    : [];
  const effectiveTemperature = normalizeTemperature(params.temperature);
  const effectiveMaxTokens = normalizeMaxTokensForRequest({
    value: params.maxTokens,
    maxTokensExplicit: params.maxTokensExplicit,
    model,
    apiBase,
    protocol: providerProtocol,
    authMode,
    profileOverride: params.profileOverride,
  });

  const url = resolveProviderTransportEndpoint({
    protocol: providerProtocol,
    apiBase,
    model,
    stream: true,
    authMode,
  });
  const requestHeaders = buildProviderTransportHeaders({
    protocol: providerProtocol,
    apiKey: auth.token,
    authMode,
  });
  const buildPayload = createChatPayloadBuilder({
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    providerProtocol,
    effectiveTemperature,
    effectiveMaxTokens,
    stream: true,
    contextCache: params.contextCache,
    profileOverride: params.profileOverride,
  });
  const res = await postWithReasoningFallback({
    url,
    auth,
    ...(authMode === "codex_auth" ? {} : { headers: requestHeaders }),
    modelName: model,
    initialReasoning: params.reasoning,
    buildPayload,
    signal: params.signal,
  });

  // Fallback to non-streaming if body is not available
  if (!res.body) {
    if (useResponses) {
      const data = (await res.json()) as {
        output_text?: string;
        output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      return extractResponsesOutputText(data);
    }
    return callLLM(params);
  }

  return useResponses
    ? parseResponsesStream(res.body, onDelta, onReasoning, onUsage)
    : parseStreamResponse(res.body, onDelta, onReasoning, onUsage);
}

/**
 * Lightweight pre-check: will `callEmbeddings` work with the current config?
 * Returns `true` if a viable embedding endpoint is available (either a
 * separate provider or a main provider that supports embeddings).
 * Does NOT make any network calls.
 */
export function checkEmbeddingAvailability(): boolean {
  const embeddingProvider = (getPref("embeddingProvider") || "").trim();
  const embeddingApiBase = (getPref("embeddingApiBase") || "").trim();

  if (!embeddingApiBase) return false;

  // Custom/local providers may not need a key
  if (embeddingProvider === "custom") return true;
  return Boolean(resolveSeparateEmbeddingApiKey(embeddingProvider));
}

/**
 * Diagnostic: returns a human-readable reason why embeddings are unavailable.
 * Used by the preference UI to show actionable guidance.
 */
export function getEmbeddingUnavailableReason(): string | null {
  const embeddingProvider = (getPref("embeddingProvider") || "").trim();
  const embeddingApiBase = (getPref("embeddingApiBase") || "").trim();

  if (!embeddingApiBase) {
    return "No embedding provider configured. Select a provider in Settings → Customization → Semantic Search.";
  }

  // Custom/local providers may not need a key
  if (embeddingProvider === "custom") return null;
  if (resolveSeparateEmbeddingApiKey(embeddingProvider)) return null;
  return `No API key found for your ${embeddingProvider} embedding provider. Add a key in Settings → Customization → Semantic Search.`;
}

/**
 * Error thrown when the configured provider does not support embeddings.
 * Callers can check `instanceof EmbeddingUnsupportedError` to distinguish
 * from network or API errors and show appropriate user guidance.
 */
export class EmbeddingUnsupportedError extends Error {
  providerLabel: string;
  constructor(providerLabel: string) {
    super(
      `Provider "${providerLabel}" does not support embeddings. ` +
        "Configure a separate embedding provider in Settings → Customization.",
    );
    this.name = "EmbeddingUnsupportedError";
    this.providerLabel = providerLabel;
  }
}

export async function callEmbeddings(input: string[]): Promise<number[][]> {
  const resolvedEmbedding = getResolvedEmbeddingConfig();

  const apiBase = resolvedEmbedding.apiBase;
  const apiKey = resolvedEmbedding.apiKey;
  const embeddingModel = resolvedEmbedding.model;
  const embeddingProvider = (getPref("embeddingProvider") || "")
    .toString()
    .trim();

  // Custom providers (local/ollama) may not need an API key
  if (!apiKey && embeddingProvider !== "custom") {
    throw new Error(
      `Embedding provider "${embeddingProvider}" requires an API key. ` +
        "Set it in Settings → Customization → Semantic Search.",
    );
  }

  const payload = {
    model: embeddingModel,
    input,
  };

  const url = resolveEndpoint(apiBase, EMBEDDINGS_ENDPOINT);
  const res = await getFetch()(url, {
    method: "POST",
    headers: buildAuthHeaders(apiKey),
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText} - ${text}`);
  }

  const data = (await res.json()) as EmbeddingResponse;
  const embeddings = data?.data || [];
  // Only sort by index when all items carry valid indices; otherwise
  // preserve the original order to avoid misaligning embeddings with inputs.
  const hasIndices =
    embeddings.length > 0 &&
    embeddings.every((item) => typeof item.index === "number");
  const ordered = hasIndices
    ? [...embeddings].sort((a, b) => a.index! - b.index!)
    : embeddings;
  return ordered.map((item) => item.embedding || []);
}

/**
 * Parse SSE stream response
 */
export async function parseStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
  onUsage?: (usage: UsageStats) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  const thoughtState: ThoughtTagState = {
    inThought: false,
    buffer: "",
    sawAnswerText: false,
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            choices?: StreamChoice[];
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              total_tokens?: number;
              prompt_tokens_details?: { cached_tokens?: number };
              prompt_cache_hit_tokens?: number;
              prompt_cache_miss_tokens?: number;
              cached_tokens?: number;
            };
          };
          if (parsed.usage && onUsage) {
            const totalTokens =
              parsed.usage.total_tokens ??
              (parsed.usage.prompt_tokens ?? 0) +
                (parsed.usage.completion_tokens ?? 0);
            if (totalTokens > 0) {
              const cacheUsage = extractContextCacheUsage(parsed.usage);
              onUsage({
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens,
                ...cacheUsage,
                contextTokens: parsed.usage.prompt_tokens ?? 0,
                contextWindowIsAuthoritative:
                  (parsed.usage.prompt_tokens ?? 0) > 0,
              });
            }
          }
          const choice = parsed?.choices?.[0];
          const reasoningDelta = normalizeStreamText(
            choice?.delta?.reasoning_content ??
              choice?.delta?.reasoning ??
              choice?.delta?.thinking ??
              choice?.delta?.thought ??
              choice?.message?.reasoning_content ??
              choice?.message?.reasoning ??
              choice?.message?.thinking ??
              choice?.message?.thought ??
              "",
          );
          if (reasoningDelta && onReasoning) {
            onReasoning({ details: reasoningDelta });
          }

          const deltaRaw = normalizeStreamText(
            choice?.delta?.content ?? choice?.message?.content ?? "",
          );
          const { answer, thought } = splitThoughtTaggedText(
            deltaRaw,
            thoughtState,
          );
          if (thought && onReasoning) {
            onReasoning({ details: thought });
          }

          if (answer) {
            fullText += answer;
            onDelta(answer);
          }
        } catch (err) {
          ztoolkit.log("LLM stream parse error:", err);
        }
      }
    }
  } finally {
    const tail = resolveUnterminatedThought(thoughtState);
    if (tail.text) {
      if (tail.asAnswer) {
        fullText += tail.text;
        onDelta(tail.text);
      } else if (onReasoning) {
        onReasoning({ details: tail.text });
      }
    }
    reader.releaseLock();
  }

  return fullText;
}

async function parseResponsesStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
  onReasoning?: (event: ReasoningEvent) => void,
  onUsage?: (usage: UsageStats) => void,
): Promise<string> {
  const reader = body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let fullText = "";
  const thoughtState: ThoughtTagState = {
    inThought: false,
    buffer: "",
    sawAnswerText: false,
  };
  let sawAnswerDelta = false;
  let sawAnswerFinal = false;
  let sawSummaryDelta = false;
  let sawDetailsDelta = false;
  let sawSummaryFinal = false;
  let sawDetailsFinal = false;

  const normalizeReasoningText = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object") {
            const row = entry as { text?: unknown; summary?: unknown };
            return (
              normalizeStreamText(row.text) || normalizeStreamText(row.summary)
            );
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (value && typeof value === "object") {
      const row = value as { text?: unknown; summary?: unknown };
      return normalizeStreamText(row.text) || normalizeStreamText(row.summary);
    }
    return "";
  };

  const extractSummary = (value: unknown): string => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => {
          if (typeof entry === "string") return entry;
          if (entry && typeof entry === "object") {
            const row = entry as { text?: unknown; summary?: unknown };
            return (
              normalizeStreamText(row.text) || normalizeStreamText(row.summary)
            );
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    if (value && typeof value === "object") {
      const row = value as { text?: unknown; summary?: unknown };
      return normalizeStreamText(row.text) || normalizeStreamText(row.summary);
    }
    return "";
  };

  const emitReasoning = (event: ReasoningEvent) => {
    if (!onReasoning) return;
    const summary =
      typeof event.summary === "string" && event.summary.length > 0
        ? event.summary
        : undefined;
    const details =
      typeof event.details === "string" && event.details.length > 0
        ? event.details
        : undefined;
    if (!summary && !details) return;
    onReasoning({ summary, details });
  };

  const emitAnswer = (value: unknown, mode: "delta" | "final"): void => {
    const text = normalizeStreamText(value);
    if (!text) return;
    if (mode === "delta" && sawAnswerFinal) return;
    if (mode === "final" && (sawAnswerDelta || sawAnswerFinal)) return;

    const { answer, thought } = splitThoughtTaggedText(text, thoughtState);
    if (thought && onReasoning) {
      onReasoning({ details: thought });
    }
    if (!answer) return;

    if (mode === "delta") {
      sawAnswerDelta = true;
    } else {
      sawAnswerFinal = true;
    }
    fullText += answer;
    onDelta(answer);
  };

  const extractOutputTextFromContent = (value: unknown): string => {
    if (!value) return "";
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((entry) => extractOutputTextFromContent(entry))
        .filter(Boolean)
        .join("");
    }
    if (value && typeof value === "object") {
      const row = value as {
        type?: unknown;
        text?: unknown;
        delta?: unknown;
        content?: unknown;
      };
      const typeValue =
        typeof row.type === "string" ? row.type.toLowerCase() : "";
      if (typeValue === "reasoning" || typeValue === "reasoning_summary") {
        return "";
      }
      if (
        typeValue === "output_text" ||
        typeValue === "text" ||
        typeValue === "message" ||
        typeValue === ""
      ) {
        return (
          normalizeStreamText(row.text) ||
          normalizeStreamText(row.delta) ||
          extractOutputTextFromContent(row.content)
        );
      }
    }
    return "";
  };

  const extractOutputTextFromOutputItem = (value: unknown): string => {
    if (!value || typeof value !== "object") return "";
    const row = value as {
      type?: unknown;
      text?: unknown;
      content?: unknown;
    };
    const typeValue =
      typeof row.type === "string" ? row.type.toLowerCase() : "";
    if (
      typeValue &&
      typeValue !== "message" &&
      typeValue !== "output_text" &&
      typeValue !== "text"
    ) {
      return "";
    }
    return (
      extractOutputTextFromContent(row.content) || normalizeStreamText(row.text)
    );
  };

  const extractOutputTextFromOutputs = (outputs: unknown): string => {
    if (!Array.isArray(outputs)) return "";
    return outputs
      .map((entry) => extractOutputTextFromOutputItem(entry))
      .filter(Boolean)
      .join("");
  };

  const emitReasoningFromOutputItem = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    const row = value as {
      type?: unknown;
      summary?: unknown;
      content?: unknown;
      text?: unknown;
      reasoning?: unknown;
    };
    const typeValue =
      typeof row.type === "string" ? row.type.toLowerCase() : "";
    if (typeValue !== "reasoning") return;
    if (!sawSummaryDelta && !sawSummaryFinal) {
      emitReasoning({ summary: extractSummary(row.summary) });
    }
    if (!sawDetailsDelta && !sawDetailsFinal) {
      emitReasoning({
        details:
          normalizeReasoningText(row.content) ||
          normalizeReasoningText(row.reasoning) ||
          normalizeReasoningText(row.text),
      });
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;

        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;

        try {
          const parsed = JSON.parse(data) as {
            type?: string;
            delta?: unknown;
            text?: unknown;
            summary?: unknown;
            reasoning?: unknown;
            message?: { content?: unknown };
            item?: {
              type?: string;
              summary?: unknown;
              content?: unknown;
              text?: unknown;
            };
            part?: {
              type?: string;
              summary?: unknown;
              content?: unknown;
              text?: unknown;
            };
            response?: {
              output_text?: unknown;
              output?: unknown;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                total_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
                prompt_tokens_details?: { cached_tokens?: number };
              };
            };
          };

          const eventType =
            typeof parsed.type === "string" ? parsed.type.toLowerCase() : "";

          if (eventType === "response.output_text.delta" && parsed.delta) {
            emitAnswer(parsed.delta, "delta");
            continue;
          }

          if (
            eventType === "response.content_part.added" ||
            eventType === "response.content_part.delta"
          ) {
            const partType =
              typeof parsed.part?.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (
              !partType ||
              partType === "output_text" ||
              partType === "text"
            ) {
              emitAnswer(
                parsed.delta ??
                  parsed.text ??
                  parsed.part?.text ??
                  parsed.part?.content,
                "delta",
              );
            }
            continue;
          }

          if (eventType === "response.output_text.done") {
            // Some providers emit full text in `done` after streaming deltas.
            emitAnswer(parsed.text ?? parsed.delta, "final");
            continue;
          }

          if (eventType === "response.content_part.done") {
            const partType =
              typeof parsed.part?.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (
              !partType ||
              partType === "output_text" ||
              partType === "text"
            ) {
              emitAnswer(
                parsed.text ??
                  parsed.delta ??
                  parsed.part?.text ??
                  parsed.part?.content,
                "final",
              );
            }
            continue;
          }

          if (
            eventType === "response.message.delta" ||
            eventType === "response.message.added"
          ) {
            emitAnswer(parsed.message?.content, "delta");
            continue;
          }

          if (eventType === "response.message.done") {
            emitAnswer(parsed.message?.content, "final");
            continue;
          }

          if (
            (eventType === "response.reasoning_summary.delta" ||
              eventType === "response.reasoning_summary_text.delta") &&
            parsed.delta
          ) {
            sawSummaryDelta = true;
            emitReasoning({ summary: normalizeStreamText(parsed.delta) });
            continue;
          }

          if (
            (eventType === "response.reasoning_summary.done" ||
              eventType === "response.reasoning_summary_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawSummaryFinal = true;
            if (!sawSummaryDelta) {
              emitReasoning({
                summary: normalizeStreamText(parsed.text ?? parsed.delta),
              });
            }
            continue;
          }

          if (
            (eventType === "response.reasoning_summary_part.added" ||
              eventType === "response.reasoning_summary_part.done") &&
            parsed.part
          ) {
            const partType =
              typeof parsed.part.type === "string"
                ? parsed.part.type.toLowerCase()
                : "";
            if (
              !partType ||
              partType === "summary_text" ||
              partType === "reasoning_summary"
            ) {
              const partSummary = normalizeStreamText(
                parsed.part.text ?? parsed.part.content ?? parsed.part.summary,
              );
              if (partSummary) {
                sawSummaryFinal = true;
                emitReasoning({ summary: partSummary });
              }
            }
            continue;
          }

          if (
            (eventType === "response.reasoning.delta" ||
              eventType === "response.reasoning_text.delta") &&
            parsed.delta
          ) {
            sawDetailsDelta = true;
            emitReasoning({ details: normalizeStreamText(parsed.delta) });
            continue;
          }

          if (
            (eventType === "response.reasoning.done" ||
              eventType === "response.reasoning_text.done") &&
            (parsed.text || parsed.delta)
          ) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              emitReasoning({
                details: normalizeStreamText(parsed.text ?? parsed.delta),
              });
            }
            continue;
          }

          if (eventType === "response.reasoning" && parsed.reasoning) {
            sawDetailsFinal = true;
            if (!sawDetailsDelta) {
              emitReasoning({
                details: normalizeReasoningText(parsed.reasoning),
              });
            }
            continue;
          }

          if (
            eventType === "response.output_item.added" ||
            eventType === "response.output_item.delta"
          ) {
            emitReasoningFromOutputItem(parsed.item);
            emitAnswer(extractOutputTextFromOutputItem(parsed.item), "delta");
            continue;
          }

          if (eventType === "response.output_item.done") {
            emitReasoningFromOutputItem(parsed.item);
            emitAnswer(extractOutputTextFromOutputItem(parsed.item), "final");
            emitAnswer(
              extractOutputTextFromOutputs(parsed.response?.output),
              "final",
            );
            const outputs = Array.isArray(parsed.response?.output)
              ? parsed.response.output
              : [];
            for (const out of outputs) {
              emitReasoningFromOutputItem(out);
            }
            continue;
          }

          if (eventType === "response.completed") {
            emitAnswer(
              parsed.response?.output_text ??
                extractOutputTextFromOutputs(parsed.response?.output),
              "final",
            );
            const u = parsed.response?.usage;
            if (u && onUsage) {
              const total =
                u.total_tokens ??
                (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
              if (total > 0) {
                const cacheUsage = extractContextCacheUsage(u);
                onUsage({
                  promptTokens: u.input_tokens ?? 0,
                  completionTokens: u.output_tokens ?? 0,
                  totalTokens: total,
                  ...cacheUsage,
                  contextTokens: u.input_tokens ?? 0,
                  contextWindowIsAuthoritative: (u.input_tokens ?? 0) > 0,
                });
              }
            }
          }

          if (
            eventType === "response.output_item.added" ||
            eventType === "response.output_item.done" ||
            eventType === "response.completed"
          ) {
            const outputs = Array.isArray(parsed.response?.output)
              ? parsed.response.output
              : [];
            for (const out of outputs) {
              emitReasoningFromOutputItem(out);
            }
          }
        } catch (err) {
          ztoolkit.log("LLM responses stream parse error:", err);
        }
      }
    }
  } finally {
    const tail = resolveUnterminatedThought(thoughtState);
    if (tail.text) {
      if (tail.asAnswer) {
        fullText += tail.text;
        onDelta(tail.text);
      } else if (onReasoning) {
        onReasoning({ details: tail.text });
      }
    }
    reader.releaseLock();
  }

  return fullText;
}
