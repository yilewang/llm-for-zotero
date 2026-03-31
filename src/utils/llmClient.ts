/**
 * LLM API Client
 *
 * Provides streaming and non-streaming API calls to OpenAI-compatible endpoints.
 */

import { config } from "../../package.json";
import { DEFAULT_SYSTEM_PROMPT } from "./llmDefaults";
import {
  getAnthropicReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
  getGrokReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getQwenReasoningProfileForModel,
  getReasoningDefaultLevelForModel,
  getRuntimeReasoningOptionsForModel,
  shouldUseDeepseekThinkingPayload,
  supportsReasoningForModel,
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
  AnthropicReasoningProfile,
  QwenReasoningProfile,
  RuntimeReasoningOption,
} from "./reasoningProfiles";
import {
  EMBEDDINGS_ENDPOINT,
  FILES_ENDPOINT,
  resolveEndpoint,
  usesMaxCompletionTokens,
} from "./apiHelpers";
import { pathToFileUrl } from "./pathFileUrl";
import {
  normalizeTemperature,
  normalizeMaxTokens,
  normalizeInputTokenCap,
} from "./normalization";
import {
  getDefaultModelEntry,
  getDefaultProviderGroup,
  type ModelProviderAuthMode,
} from "./modelProviders";
import { isGrokApiBase, providerSupportsResponsesEndpoint } from "./providerPresets";
import type { ProviderProtocol } from "./providerProtocol";
import {
  buildProviderTransportHeaders,
  resolveAnthropicMessagesEndpoint,
  resolveGeminiNativeEndpoint,
  resolveProviderTransportEndpoint,
} from "./providerTransport";
import { parseDataUrl } from "../agent/model/shared";
import {
  applyModelInputTokenCap,
  estimateConversationTokens,
  getModelInputTokenLimit,
  type InputCapResult,
} from "./modelInputCap";

// =============================================================================
// Types
// =============================================================================

/** Image content for vision-capable models */
export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "low" | "high" | "auto";
  };
};

/** Text content */
export type TextContent = {
  type: "text";
  text: string;
};

/** Message content can be string or array of content parts (for vision) */
export type MessageContent = string | (TextContent | ImageContent)[];

export type ChatMessage = {
  role: "user" | "assistant" | "system";
  content: MessageContent;
};

export type ReasoningConfig = {
  provider: ReasoningProvider;
  level: ReasoningLevel;
};
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
  /** Optional override for input token cap. */
  inputTokenCap?: number;
  /** Local files to upload and attach when using Responses API */
  attachments?: ChatFileAttachment[];
  /** Extra system-only guidance added to the same request */
  systemMessages?: string[];
  /** Override provider protocol for this request */
  providerProtocol?: ProviderProtocol;
};

export type ReasoningEvent = {
  summary?: string;
  details?: string;
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

export type UsageStats = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
  data?: Array<{ embedding?: number[] }>;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_CODEX_API_BASE = "https://chatgpt.com/backend-api/codex/responses";
const CODEX_REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

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
  const authMode = (
    overrides?.authMode ||
    defaultEntry?.authMode ||
    defaultProviderGroup?.authMode ||
    "api_key"
  ) as ModelProviderAuthMode;
  const prefApiBase =
    defaultEntry?.apiBase ||
    defaultProviderGroup?.apiBase ||
    getPref("apiBasePrimary") ||
    getPref("apiBase") ||
    "";
  const resolvedApiBase =
    overrides?.apiBase ||
    prefApiBase ||
    (authMode === "codex_auth"
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
  const providerProtocol: ProviderProtocol =
    overrides?.providerProtocol ||
    defaultEntry?.providerProtocol ||
    defaultProviderGroup?.providerProtocol ||
    "openai_chat_compat";

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
type ProcessLike = { env?: Record<string, string | undefined> };
type PathUtilsLike = {
  homeDir?: string;
  join?: (...parts: string[]) => string;
  parent?: (path: string) => string;
};
type ServicesLike = {
  dirsvc?: {
    get?: (key: string, iface?: unknown) => { path?: string } | undefined;
  };
};
type OSLike = {
  Constants?: {
    Path?: {
      homeDir?: string;
    };
  };
};

type CodexTokenData = {
  access_token?: string;
  refresh_token?: string;
};

type CodexAuthJson = {
  tokens?: CodexTokenData;
  last_refresh?: string;
  OPENAI_API_KEY?: string;
};

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

function getPathUtils(): PathUtilsLike | undefined {
  const fromGlobal = (globalThis as { PathUtils?: PathUtilsLike }).PathUtils;
  if (fromGlobal?.join || fromGlobal?.homeDir || fromGlobal?.parent) {
    return fromGlobal;
  }
  return ztoolkit.getGlobal("PathUtils") as PathUtilsLike | undefined;
}

function getServices(): ServicesLike | undefined {
  const fromGlobal = (globalThis as { Services?: ServicesLike }).Services;
  if (fromGlobal?.dirsvc?.get) return fromGlobal;
  return ztoolkit.getGlobal("Services") as ServicesLike | undefined;
}

function getOS(): OSLike | undefined {
  const fromGlobal = (globalThis as { OS?: OSLike }).OS;
  if (fromGlobal?.Constants?.Path?.homeDir) return fromGlobal;
  return ztoolkit.getGlobal("OS") as OSLike | undefined;
}

function getNsIFile(): unknown {
  const ci = (globalThis as { Ci?: { nsIFile?: unknown } }).Ci;
  if (ci?.nsIFile) return ci.nsIFile;
  const components = (globalThis as {
    Components?: { interfaces?: { nsIFile?: unknown } };
  }).Components;
  return components?.interfaces?.nsIFile;
}

function getProcess(): ProcessLike | undefined {
  const fromGlobal = (globalThis as { process?: ProcessLike }).process;
  if (fromGlobal?.env) return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("process") as ProcessLike | undefined;
  return fromToolkit?.env ? fromToolkit : undefined;
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

function getParentPath(path: string): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.parent) return pathUtils.parent(path);
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index > 0 ? normalized.slice(0, index) : normalized;
}

function joinPath(...parts: string[]): string {
  const pathUtils = getPathUtils();
  if (pathUtils?.join) {
    return pathUtils.join(...parts);
  }
  const normalized = parts
    .filter((part) => Boolean(part))
    .map((part, index) =>
      index === 0
        ? part.replace(/[\\/]+$/, "")
        : part.replace(/^[\\/]+|[\\/]+$/g, ""),
    )
    .filter((part) => Boolean(part));
  return normalized.join("/");
}

function resolveHomeDir(): string {
  const env = getProcess()?.env;
  const envHome = env?.HOME || env?.USERPROFILE;
  if (typeof envHome === "string" && envHome.trim()) {
    return envHome.trim();
  }
  const fromPathUtils = getPathUtils()?.homeDir;
  if (typeof fromPathUtils === "string" && fromPathUtils.trim()) {
    return fromPathUtils.trim();
  }
  const osHome = getOS()?.Constants?.Path?.homeDir;
  if (typeof osHome === "string" && osHome.trim()) {
    return osHome.trim();
  }
  const servicesHome = getServices()?.dirsvc
    ?.get?.("Home", getNsIFile())
    ?.path?.trim();
  if (typeof servicesHome === "string" && servicesHome) {
    return servicesHome;
  }
  const profileDir = (Zotero as unknown as { Profile?: { dir?: string } })
    .Profile?.dir;
  if (typeof profileDir === "string" && profileDir.trim()) {
    return profileDir.trim();
  }
  throw new Error("Unable to resolve HOME directory for Codex auth");
}

function resolveCodexAuthPath(): string {
  const env = getProcess()?.env;
  const codexHome = env?.CODEX_HOME?.trim();
  if (codexHome) return joinPath(codexHome, "auth.json");
  return joinPath(resolveHomeDir(), ".codex", "auth.json");
}

async function pathExists(path: string): Promise<boolean> {
  const io = getIOUtils();
  if (io?.exists) {
    try {
      return Boolean(await io.exists(path));
    } catch (_err) {
      return false;
    }
  }
  const osFile = getOSFile();
  if (osFile?.exists) {
    try {
      return Boolean(await osFile.exists(path));
    } catch (_err) {
      return false;
    }
  }
  return false;
}

async function ensureDir(path: string): Promise<void> {
  const io = getIOUtils();
  if (io?.makeDirectory) {
    await io.makeDirectory(path, {
      createAncestors: true,
      ignoreExisting: true,
    });
    return;
  }
  const osFile = getOSFile();
  if (osFile?.makeDir) {
    await osFile.makeDir(path, {
      from: getParentPath(path),
      ignoreExisting: true,
    });
    return;
  }
  throw new Error("No directory API available to persist Codex auth");
}

async function readUtf8File(path: string): Promise<string> {
  const bytes = await readLocalFileBytes(path);
  const decoder = new TextDecoder("utf-8");
  return decoder.decode(bytes);
}

async function writeUtf8File(path: string, content: string): Promise<void> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  await ensureDir(getParentPath(path));
  const io = getIOUtils();
  if (io?.write) {
    await io.write(path, data);
    return;
  }
  const osFile = getOSFile();
  if (osFile?.writeAtomic) {
    await osFile.writeAtomic(path, data);
    return;
  }
  throw new Error("No file write API available to persist Codex auth");
}

async function loadCodexAuthJson(
  authPath: string,
): Promise<CodexAuthJson | null> {
  if (!(await pathExists(authPath))) return null;
  try {
    const raw = await readUtf8File(authPath);
    if (!raw.trim()) return null;
    const parsed = JSON.parse(raw) as CodexAuthJson;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_err) {
    return null;
  }
}

function extractCodexAccessToken(auth: CodexAuthJson | null): string {
  const token = auth?.tokens?.access_token;
  return typeof token === "string" ? token.trim() : "";
}

function extractCodexRefreshToken(auth: CodexAuthJson | null): string {
  const token = auth?.tokens?.refresh_token;
  return typeof token === "string" ? token.trim() : "";
}

async function refreshCodexAccessToken(params: {
  authPath: string;
  refreshToken: string;
  signal?: AbortSignal;
}): Promise<string> {
  const response = await getFetch()(CODEX_REFRESH_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: params.refreshToken,
    }),
    signal: params.signal,
  });
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Codex token refresh failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }
  const payload = (await response.json()) as {
    access_token?: unknown;
    refresh_token?: unknown;
  };
  const nextAccess =
    typeof payload.access_token === "string" ? payload.access_token.trim() : "";
  if (!nextAccess) {
    throw new Error("Codex token refresh returned empty access token");
  }

  const current = (await loadCodexAuthJson(params.authPath)) || {};
  const tokens: CodexTokenData = {
    ...(current.tokens || {}),
    access_token: nextAccess,
    refresh_token:
      typeof payload.refresh_token === "string" && payload.refresh_token.trim()
        ? payload.refresh_token.trim()
        : params.refreshToken,
  };
  const nextAuth: CodexAuthJson = {
    ...current,
    tokens,
    last_refresh: new Date().toISOString(),
  };
  await writeUtf8File(params.authPath, `${JSON.stringify(nextAuth, null, 2)}\n`);
  return nextAccess;
}

async function resolveCodexAccessToken(params?: {
  signal?: AbortSignal;
}): Promise<{ token: string; refreshToken: string; authPath: string }> {
  const authPath = resolveCodexAuthPath();
  const auth = await loadCodexAuthJson(authPath);
  const accessToken = extractCodexAccessToken(auth);
  const refreshToken = extractCodexRefreshToken(auth);
  if (accessToken) {
    return { token: accessToken, refreshToken, authPath };
  }
  if (refreshToken) {
    const refreshed = await refreshCodexAccessToken({
      authPath,
      refreshToken,
      signal: params?.signal,
    });
    return { token: refreshed, refreshToken, authPath };
  }
  throw new Error(
    "codex auth token not found. Please run `codex login` and ensure ~/.codex/auth.json is available.",
  );
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
  const expiresAt = typeof payload.expires_at === "number"
    ? payload.expires_at * 1000
    : Date.now() + 25 * 60 * 1000;
  cachedCopilotJwt = { token, expiresAt };
  return { token, expiresAt };
}

export async function resolveCopilotAccessToken(params: {
  githubToken: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (
    cachedCopilotJwt &&
    cachedCopilotJwt.expiresAt > Date.now() + 60_000
  ) {
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
  if (m.model_picker_enabled === false && !m.model_picker_category) return false;
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
    .filter((m) => typeof m.id === "string" && m.id.trim() && isCopilotModelUsable(m))
    .map((m) => ({
      id: m.id!.trim(),
      name: (m.name || m.id || "").trim(),
      protocol: resolveCopilotModelProtocol(m.supported_endpoints),
    }));
}

async function readLocalFileBytes(path: string): Promise<Uint8Array> {
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

function getFormDataCtor(): typeof FormData | undefined {
  const fromGlobal = (globalThis as { FormData?: typeof FormData }).FormData;
  if (typeof fromGlobal === "function") return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("FormData") as
    | typeof FormData
    | undefined;
  return typeof fromToolkit === "function" ? fromToolkit : undefined;
}

function getBlobCtor(): typeof Blob | undefined {
  const fromGlobal = (globalThis as { Blob?: typeof Blob }).Blob;
  if (typeof fromGlobal === "function") return fromGlobal;
  const fromToolkit = ztoolkit.getGlobal("Blob") as typeof Blob | undefined;
  return typeof fromToolkit === "function" ? fromToolkit : undefined;
}

function toSafeMultipartToken(value: string): string {
  return (value || "").replace(/[\r\n"]/g, "_").trim() || "attachment";
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function buildManualMultipartBody(params: {
  purpose: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): { body: Uint8Array; contentType: string } {
  const encoder = new TextEncoder();
  const boundary = `----llmforzotero-${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  const safePurpose = toSafeMultipartToken(params.purpose);
  const safeFileName = toSafeMultipartToken(params.fileName);
  const safeMimeType = toSafeMultipartToken(params.mimeType);

  const prefix = encoder.encode(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="purpose"\r\n\r\n` +
      `${safePurpose}\r\n` +
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeFileName}"\r\n` +
      `Content-Type: ${safeMimeType}\r\n\r\n`,
  );
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`);
  return {
    body: concatBytes([prefix, params.bytes, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function buildUploadRequest(params: {
  purpose: string;
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): { body: BodyInit; contentType?: string; mode: "formdata" | "manual" } {
  const FormDataCtor = getFormDataCtor();
  const BlobCtor = getBlobCtor();
  if (FormDataCtor && BlobCtor) {
    const body = new FormDataCtor();
    const blob = new BlobCtor([params.bytes], {
      type: params.mimeType || "application/octet-stream",
    });
    body.append("purpose", params.purpose || "assistants");
    body.append("file", blob, params.fileName || "attachment");
    return { body, mode: "formdata" };
  }

  const manual = buildManualMultipartBody({
    purpose: params.purpose,
    fileName: params.fileName,
    mimeType: params.mimeType,
    bytes: params.bytes,
  });
  return {
    body: manual.body,
    contentType: manual.contentType,
    mode: "manual",
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

export function prepareChatRequest(params: ChatParams): PreparedChatRequest {
  const { apiBase, apiKey, authMode, model, systemPrompt, providerProtocol } = getApiConfig({
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    authMode: params.authMode,
    model: params.model,
    providerProtocol: params.providerProtocol,
  });
  const rawMessages = buildMessages(params, systemPrompt);
  const inputCap = applyModelInputTokenCap(
    rawMessages,
    model,
    params.inputTokenCap,
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
  };
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
  inputTokenCap?: number;
  systemPrompt?: string;
}): ContextBudgetPlan {
  const normalizedModel =
    (params.model || DEFAULT_MODEL).trim() || DEFAULT_MODEL;
  const modelLimitTokens = getModelInputTokenLimit(normalizedModel);
  const limitTokens = normalizeInputTokenCap(
    params.inputTokenCap,
    modelLimitTokens,
  );
  const softLimitTokens = Math.max(1, Math.floor(limitTokens * 0.9));
  const outputReserveTokens = normalizeMaxTokens(params.maxTokens);
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

function splitThoughtTaggedText(
  chunk: string,
  state: ThoughtTagState,
): { answer: string; thought: string } {
  const OPEN_TAG = "<thought>";
  const CLOSE_TAG = "</thought>";
  const input = `${state.buffer}${chunk}`;
  state.buffer = "";
  if (!input) return { answer: "", thought: "" };

  const inputLower = input.toLowerCase();
  let answer = "";
  let thought = "";
  let cursor = 0;

  while (cursor < input.length) {
    if (state.inThought) {
      const closeIdx = inputLower.indexOf(CLOSE_TAG, cursor);
      if (closeIdx === -1) {
        const segment = input.slice(cursor);
        const tailLen = getPartialTagTailLength(segment, CLOSE_TAG);
        thought += segment.slice(0, segment.length - tailLen);
        state.buffer = segment.slice(segment.length - tailLen);
        break;
      }
      thought += input.slice(cursor, closeIdx);
      cursor = closeIdx + CLOSE_TAG.length;
      state.inThought = false;
      continue;
    }

    const openIdx = inputLower.indexOf(OPEN_TAG, cursor);
    if (openIdx === -1) {
      const segment = input.slice(cursor);
      const tailLen = getPartialTagTailLength(segment, OPEN_TAG);
      answer += segment.slice(0, segment.length - tailLen);
      state.buffer = segment.slice(segment.length - tailLen);
      break;
    }
    answer += input.slice(cursor, openIdx);
    cursor = openIdx + OPEN_TAG.length;
    state.inThought = true;
  }

  return { answer, thought };
}

function buildTokenParam(model: string, maxTokens: number) {
  return usesMaxCompletionTokens(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };
}

function buildResponsesTokenParam(maxTokens: number) {
  return { max_output_tokens: maxTokens };
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
      // PDF data URIs should be sent as inline input_file, not input_image.
      // This enables third-party responses_api providers to receive PDFs
      // correctly even when /v1/files upload is not available.
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

export function buildReasoningPayload(
  reasoning: ReasoningConfig | undefined,
  useResponses: boolean,
  modelName?: string,
  apiBase?: string,
): { extra: Record<string, unknown>; omitTemperature: boolean } {
  if (!reasoning) {
    return emptyReasoningPayload();
  }
  if (!supportsReasoningForModel(reasoning.provider, modelName)) {
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
    if (!shouldUseDeepseekThinkingPayload(modelName)) {
      return emptyReasoningPayload();
    }
    return {
      extra: {
        thinking: {
          type: "enabled",
        },
      },
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
    const profile = getAnthropicReasoningProfile(modelName);
    const budgetTokens = resolveAnthropicThinkingBudget(
      reasoning.level,
      profile,
    );
    return {
      extra: {
        thinking: {
          type: "enabled",
          budget_tokens: Math.max(1024, Math.floor(budgetTokens)),
        },
      },
      omitTemperature: false,
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
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("")))
    .filter(Boolean);
  const nonSystemMessages = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role as "user" | "assistant",
      content:
        typeof m.content === "string"
          ? [{ type: "text", text: m.content }]
          : m.content.map((c) =>
              c.type === "image_url"
                ? (() => {
                    const parsed = parseDataUrl((c as { image_url: { url: string } }).image_url.url);
                    return {
                      type: "image",
                      source: { type: "base64", media_type: parsed?.mimeType || "image/jpeg", data: parsed?.data || "" },
                    };
                  })()
                : { type: "text", text: (c as { text: string }).text },
            ),
    }));
  const payload: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.effectiveMaxTokens,
    messages: nonSystemMessages,
  };
  if (systemParts.length > 0) {
    payload.system = systemParts.join("\n\n");
  }
  if (params.stream) {
    payload.stream = true;
  }
  return payload;
}

async function parseAnthropicStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
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
            delta?: { type?: string; text?: string };
            usage?: { output_tokens?: number };
            message?: { usage?: { input_tokens?: number; output_tokens?: number } };
          };
          if (parsed.type === "content_block_delta" && parsed.delta?.type === "text_delta" && parsed.delta.text) {
            fullText += parsed.delta.text;
            onDelta(parsed.delta.text);
          }
          if (parsed.type === "message_delta" && parsed.usage && onUsage) {
            const outputTokens = parsed.usage.output_tokens ?? 0;
            if (outputTokens > 0) {
              onUsage({ promptTokens: 0, completionTokens: outputTokens, totalTokens: outputTokens });
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
  messages: ChatMessage[];
  effectiveMaxTokens: number;
  effectiveTemperature: number;
}): Record<string, unknown> {
  const systemParts = params.messages
    .filter((m) => m.role === "system")
    .map((m) => ({ text: typeof m.content === "string" ? m.content : m.content.map((c) => ("text" in c ? c.text : "")).join("") }))
    .filter((p) => p.text);
  const contents = params.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts:
        typeof m.content === "string"
          ? [{ text: m.content }]
          : m.content.map((c) =>
              c.type === "image_url"
                ? (() => {
                    const parsed = parseDataUrl((c as { image_url: { url: string } }).image_url.url);
                    return { inline_data: { mime_type: parsed?.mimeType || "image/jpeg", data: parsed?.data || "" } };
                  })()
                : { text: (c as { text: string }).text },
            ),
    }));
  const payload: Record<string, unknown> = {
    contents,
    generationConfig: {
      maxOutputTokens: params.effectiveMaxTokens,
      temperature: params.effectiveTemperature,
    },
  };
  if (systemParts.length > 0) {
    payload.systemInstruction = { parts: systemParts };
  }
  return payload;
}

async function parseGeminiNativeStreamResponse(
  body: ReadableStream<Uint8Array>,
  onDelta: (delta: string) => void,
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
            candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
            usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number };
          };
          const text = parsed.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
          if (text) {
            fullText += text;
            onDelta(text);
          }
          if (parsed.usageMetadata && onUsage) {
            const total = parsed.usageMetadata.totalTokenCount ?? 0;
            if (total > 0) {
              onUsage({
                promptTokens: parsed.usageMetadata.promptTokenCount ?? 0,
                completionTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
                totalTokens: total,
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

function createChatPayloadBuilder(params: {
  model: string;
  messages: ChatMessage[];
  useResponses: boolean;
  responseFileIds?: string[];
  authMode: ModelProviderAuthMode;
  apiBase: string;
  effectiveTemperature: number;
  effectiveMaxTokens: number;
  stream: boolean;
}) {
  const {
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    effectiveTemperature,
    effectiveMaxTokens,
    stream,
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
      const codexReasoningEffort =
        reasoningOverride &&
        (reasoningOverride.provider === "openai" ||
          reasoningOverride.provider === "grok")
          ? resolveOpenAIReasoningEffort(
              reasoningOverride.provider,
              reasoningOverride.level,
              model,
              apiBase,
            )
          : null;
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
    );
    const temperatureParam = reasoningPayload.omitTemperature
      ? {}
      : { temperature: effectiveTemperature };

    const payload = useResponses
      ? {
          model,
          ...responsesInput,
          ...reasoningPayload.extra,
          ...temperatureParam,
          ...buildResponsesTokenParam(effectiveMaxTokens),
        }
      : {
          model,
          messages: chatMessages,
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
    text.includes("invalid temperature")
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
  };
  copilot?: {
    githubToken: string;
  };
};

function buildAuthHeaders(
  token: string,
  mode?: ModelProviderAuthMode,
): Record<string, string> {
  if (mode === "copilot_auth") {
    return buildCopilotHeaders(token);
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
  const authPath = state.codex?.authPath || resolveCodexAuthPath();
  const refreshToken =
    state.codex?.refreshToken || extractCodexRefreshToken(await loadCodexAuthJson(authPath));
  if (!refreshToken) {
    throw new Error(
      "codex auth refresh token missing. Please run `codex login` to restore ~/.codex/auth.json.",
    );
  }
  const token = await refreshCodexAccessToken({
    authPath,
    refreshToken,
    signal,
  });
  return {
    mode: "codex_auth",
    token,
    codex: {
      authPath,
      refreshToken,
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
      headers: params.headers ?? buildAuthHeaders(auth.token, auth.mode),
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
    } else if (authState.mode === "copilot_auth" && authState.copilot?.githubToken) {
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
      } else if (authState.mode === "copilot_auth" && authState.copilot?.githubToken) {
        authState = await refreshCopilotAuthState(authState, params.signal);
        res = await send(fallbackPayload, authState);
      }
    }
    if (res.ok) {
      temperaturePolicyCache.set(policyKey, recoveryPolicy);
      return res;
    }
    const secondErr = await res.text();
    throw new Error(`${res.status} ${res.statusText} (${params.url}) - ${secondErr}`);
  }

  throw new Error(`${res.status} ${res.statusText} (${params.url}) - ${firstErr}`);
}

function parseStatusFromErrorMessage(message: string): number | null {
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
    text.includes("thinking_budget")
  );
}

function getReasoningRecoverySelection(params: {
  currentReasoning: ReasoningConfig | undefined;
  modelName?: string;
}): ReasoningConfig | undefined | null {
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

export async function postWithReasoningFallback(params: {
  url: string;
  auth: RequestAuthState;
  modelName?: string;
  initialReasoning: ReasoningConfig | undefined;
  buildPayload: (
    reasoningOverride: ReasoningConfig | undefined,
  ) => Record<string, unknown>;
  signal?: AbortSignal;
  headers?: Record<string, string>;
}) {
  let reasoningSelection = params.initialReasoning;
  let retries = 0;
  const maxRetries = 2;
  let lastError: unknown;
  const attemptedSelections = new Set<string>([
    reasoningSelection
      ? `${reasoningSelection.provider}:${reasoningSelection.level}`
      : "none",
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
      const recovered = getReasoningRecoverySelection({
        currentReasoning: reasoningSelection,
        modelName: params.modelName,
      });
      if (recovered === null) {
        throw err;
      }
      const nextKey = recovered
        ? `${recovered.provider}:${recovered.level}`
        : "none";
      if (attemptedSelections.has(nextKey)) {
        throw err;
      }
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
    const resolved = await resolveCodexAccessToken({
      signal: params.signal,
    });
    return {
      mode: "codex_auth",
      token: resolved.token,
      codex: {
        authPath: resolved.authPath,
        refreshToken: resolved.refreshToken,
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
 * Handles anthropic_messages and gemini_native protocols for both streaming and
 * non-streaming calls. Passing onDelta enables streaming.
 */
async function callNativeProtocol(params: {
  protocol: "anthropic_messages" | "gemini_native";
  apiBase: string;
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  effectiveMaxTokens: number;
  effectiveTemperature: number;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onUsage?: (usage: UsageStats) => void;
}): Promise<string> {
  const { protocol, apiBase, apiKey, model, messages, effectiveMaxTokens, effectiveTemperature, signal, onDelta, onUsage } = params;
  const isStreaming = Boolean(onDelta);
  const url =
    protocol === "anthropic_messages"
      ? resolveAnthropicMessagesEndpoint(apiBase)
      : resolveGeminiNativeEndpoint({ apiBase, model, stream: isStreaming });
  const headers = buildProviderTransportHeaders({ protocol, apiKey });
  const body =
    protocol === "anthropic_messages"
      ? buildAnthropicMessagesPayload({ model, messages, effectiveMaxTokens, effectiveTemperature, stream: isStreaming })
      : buildGeminiNativePayload({ messages, effectiveMaxTokens, effectiveTemperature });
  const res = await getFetch()(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    throw new Error(`${res.status} (${url}) - ${await res.text()}`);
  }
  if (isStreaming) {
    if (!res.body) return callNativeProtocol({ ...params, onDelta: undefined });
    return protocol === "anthropic_messages"
      ? parseAnthropicStreamResponse(res.body, onDelta!, onUsage)
      : parseGeminiNativeStreamResponse(res.body, onDelta!, onUsage);
  }
  if (protocol === "anthropic_messages") {
    const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
    return data?.content?.find((c) => c.type === "text")?.text ?? JSON.stringify(data);
  }
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") ?? JSON.stringify(data);
}

/**
 * Call LLM API (non-streaming)
 */
export async function callLLM(params: ChatParams): Promise<string> {
  const prepared = prepareChatRequest(params);
  const { apiBase, apiKey, authMode, model, messages, inputCap, providerProtocol } = prepared;
  if (providerProtocol === "anthropic_messages" || providerProtocol === "gemini_native") {
    return callNativeProtocol({
      protocol: providerProtocol,
      apiBase, apiKey, model, messages,
      effectiveMaxTokens: normalizeMaxTokens(params.maxTokens),
      effectiveTemperature: normalizeTemperature(params.temperature),
      signal: params.signal,
    });
  }
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
  const useResponses = providerProtocol === "responses_api" || providerProtocol === "codex_responses";
  // Only upload files via /v1/files for providers that actually host that endpoint.
  // Third-party relays using responses_api get inline base64 instead (via buildResponsesInput).
  const canUploadFiles = useResponses && providerSupportsResponsesEndpoint(apiBase);
  const responseFileIds = canUploadFiles
    ? await uploadFilesForResponses({
        apiBase,
        apiKey: auth.token,
        attachments: params.attachments,
        signal: params.signal,
      })
    : [];
  const effectiveTemperature = normalizeTemperature(params.temperature);
  const effectiveMaxTokens = normalizeMaxTokens(params.maxTokens);

  const url = resolveProviderTransportEndpoint({ protocol: providerProtocol, apiBase, model, stream: false, authMode });
  const requestHeaders = buildProviderTransportHeaders({ protocol: providerProtocol, apiKey: auth.token, authMode });
  const buildPayload = createChatPayloadBuilder({
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    effectiveTemperature,
    effectiveMaxTokens,
    stream: false,
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
  const prepared = prepareChatRequest(params);
  const { apiBase, apiKey, authMode, model, messages, inputCap, providerProtocol } = prepared;
  if (providerProtocol === "anthropic_messages" || providerProtocol === "gemini_native") {
    return callNativeProtocol({
      protocol: providerProtocol,
      apiBase, apiKey, model, messages,
      effectiveMaxTokens: normalizeMaxTokens(params.maxTokens),
      effectiveTemperature: normalizeTemperature(params.temperature),
      signal: params.signal,
      onDelta,
      onUsage,
    });
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
  if (authMode === "codex_auth" && Array.isArray(params.attachments) && params.attachments.length) {
    throw new Error(
      "codex auth currently does not support file attachments in this plugin v1.",
    );
  }
  const useResponses = providerProtocol === "responses_api" || providerProtocol === "codex_responses";
  // Only upload files via /v1/files for providers that actually host that endpoint.
  // Third-party relays using responses_api get inline base64 instead (via buildResponsesInput).
  const canUploadFiles = useResponses && providerSupportsResponsesEndpoint(apiBase);
  const responseFileIds = canUploadFiles
    ? await uploadFilesForResponses({
        apiBase,
        apiKey: auth.token,
        attachments: params.attachments,
        signal: params.signal,
      })
    : [];
  const effectiveTemperature = normalizeTemperature(params.temperature);
  const effectiveMaxTokens = normalizeMaxTokens(params.maxTokens);

  const url = resolveProviderTransportEndpoint({ protocol: providerProtocol, apiBase, model, stream: true, authMode });
  const requestHeaders = buildProviderTransportHeaders({ protocol: providerProtocol, apiKey: auth.token, authMode });
  const buildPayload = createChatPayloadBuilder({
    model,
    messages,
    useResponses,
    responseFileIds,
    authMode,
    apiBase,
    effectiveTemperature,
    effectiveMaxTokens,
    stream: true,
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
 * Call embeddings API
 */
export async function callEmbeddings(
  input: string[],
  overrides?: {
    apiBase?: string;
    apiKey?: string;
    authMode?: ModelProviderAuthMode;
  },
): Promise<number[][]> {
  const { apiBase, apiKey, authMode, embeddingModel } = getApiConfig({
    apiBase: overrides?.apiBase,
    apiKey: overrides?.apiKey,
    authMode: overrides?.authMode,
  });
  if (authMode === "codex_auth") {
    throw new Error(
      "codex auth currently does not support embeddings in this plugin v1.",
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
  const embeddings = data?.data?.map((item) => item.embedding || []) || [];
  return embeddings;
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
  const thoughtState: ThoughtTagState = { inThought: false, buffer: "" };

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
            };
          };
          if (parsed.usage && onUsage) {
            const totalTokens =
              parsed.usage.total_tokens ??
              (parsed.usage.prompt_tokens ?? 0) + (parsed.usage.completion_tokens ?? 0);
            if (totalTokens > 0) {
              onUsage({
                promptTokens: parsed.usage.prompt_tokens ?? 0,
                completionTokens: parsed.usage.completion_tokens ?? 0,
                totalTokens,
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
    if (thoughtState.buffer) {
      if (thoughtState.inThought && onReasoning) {
        onReasoning({ details: thoughtState.buffer });
      } else {
        fullText += thoughtState.buffer;
        onDelta(thoughtState.buffer);
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
  const thoughtState: ThoughtTagState = { inThought: false, buffer: "" };
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
              const total = u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0);
              if (total > 0) {
                onUsage({
                  promptTokens: u.input_tokens ?? 0,
                  completionTokens: u.output_tokens ?? 0,
                  totalTokens: total,
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
    if (thoughtState.buffer) {
      if (thoughtState.inThought && onReasoning) {
        onReasoning({ details: thoughtState.buffer });
      } else {
        fullText += thoughtState.buffer;
        onDelta(thoughtState.buffer);
      }
    }
    reader.releaseLock();
  }

  return fullText;
}
