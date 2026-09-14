import type { ProviderProtocol } from "./providerProtocol";

export type SupportedProviderPresetId =
  | "openai"
  | "gemini"
  | "anthropic"
  | "minimax"
  | "glm"
  | "deepseek"
  | "grok"
  | "qwen"
  | "kimi"
  | "mimo"
  | "copilot"
  | "ollama"
  | "local_openai";

export type ProviderPresetId = SupportedProviderPresetId | "customized";

/** Preserve only explicit selections recognized by the provider registry. */
export function normalizeProviderPresetId(
  value: unknown,
): ProviderPresetId | undefined {
  return value === "customized" ||
    PROVIDER_PRESETS.some((preset) => preset.id === value)
    ? (value as ProviderPresetId)
    : undefined;
}

/** Explicit provider choices take precedence over legacy URL inference. */
export function resolveProviderPresetId(group: {
  authMode: string;
  apiBase?: string;
  presetIdOverride?: ProviderPresetId;
}): ProviderPresetId {
  if (group.authMode !== "api_key") return "customized";
  return (
    normalizeProviderPresetId(group.presetIdOverride) ??
    detectProviderPreset(group.apiBase || "")
  );
}

export type ProviderPreset = {
  id: SupportedProviderPresetId;
  label: string;
  defaultApiBase: string;
  defaultProtocol: ProviderProtocol;
  supportedProtocols: ProviderProtocol[];
  helperText: string;
  matches: (apiBase: string) => boolean;
  /** When true, prefer /v1/responses over /v1/chat/completions when calling the API. */
  supportsResponsesEndpoint?: boolean;
  /** Whether this provider exposes an OpenAI-compatible /v1/embeddings endpoint. */
  supportsEmbeddings?: boolean;
  /** Default embedding model name for providers that support embeddings. */
  defaultEmbeddingModel?: string;
  /**
   * Whether an API key is mandatory. Absent means required. Local runtimes
   * (Ollama, LM Studio, llama.cpp, vLLM) serve unauthenticated by default, so
   * the key field, the connection test and the model catalog must all work
   * with it left blank.
   */
  requiresApiKey?: boolean;
};

const GENERAL_API_KEY_PROTOCOL_OPTIONS: ProviderProtocol[] = [
  "responses_api",
  "openai_chat_compat",
  "anthropic_messages",
];

const CUSTOMIZED_API_KEY_PROTOCOL_OPTIONS: ProviderProtocol[] = [
  ...GENERAL_API_KEY_PROTOCOL_OPTIONS,
  "gemini_native",
];

type ParsedApiBase = {
  hostname: string;
  pathname: string;
  port: string;
};

function normalizeApiBase(apiBase: string): string {
  return typeof apiBase === "string" ? apiBase.trim().replace(/\/+$/, "") : "";
}

function parseApiBase(apiBase: string): ParsedApiBase | null {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return null;
  try {
    const parsed = new URL(normalized);
    return {
      hostname: parsed.hostname.trim().toLowerCase(),
      pathname: parsed.pathname.replace(/\/+$/, "") || "/",
      port: parsed.port,
    };
  } catch (_err) {
    return null;
  }
}

/** Private IPv4 ranges (RFC1918) plus link-local, for LAN-hosted runtimes. */
function isPrivateIPv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  const parts = octets.map((part) => Number(part));
  if (parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 169.254.0.0/16 link-local, e.g. a directly attached inference box.
  if (a === 169 && b === 254) return true;
  return false;
}

function isLocalHostname(hostname: string): boolean {
  if (!hostname) return false;
  if (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "::1" ||
    hostname === "[::1]" ||
    hostname === "host.docker.internal"
  ) {
    return true;
  }
  // 127.0.0.0/8 loopback and *.localhost both resolve to the local machine.
  if (hostname.startsWith("127.")) return isPrivateOrLoopbackIPv4(hostname);
  if (hostname.endsWith(".localhost")) return true;
  // mDNS names published by a machine on the same LAN.
  if (hostname.endsWith(".local")) return true;
  return isPrivateIPv4(hostname);
}

function isPrivateOrLoopbackIPv4(hostname: string): boolean {
  const octets = hostname.split(".");
  if (octets.length !== 4) return false;
  return octets.every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

/**
 * True when an API base points at a model server on this machine or the local
 * network. Used to decide that an API key is optional and that requests may go
 * over plain HTTP — never to override which provider family a model belongs
 * to, since `deepseek-r1:8b` served by Ollama is still DeepSeek's weights.
 */
export function isLocalModelApiBase(apiBase: string): boolean {
  const parsed = parseApiBase(apiBase);
  return parsed ? isLocalHostname(parsed.hostname) : false;
}

function matchesPaths(pathname: string, paths: string[]): boolean {
  return paths.includes(pathname);
}

function isHost(parsed: ParsedApiBase | null, hosts: string[]): boolean {
  if (!parsed) return false;
  return hosts.includes(parsed.hostname);
}

function makeHostAndPathMatcher(hosts: string[], paths: string[]) {
  return (apiBase: string) => {
    const parsed = parseApiBase(apiBase);
    if (!parsed) return false;
    return isHost(parsed, hosts) && matchesPaths(parsed.pathname, paths);
  };
}

const OPENAI_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/files",
  "/v1/embeddings",
];

const GEMINI_PATHS = [
  "/",
  "/v1",
  "/v1/models",
  "/v1alpha",
  "/v1alpha/models",
  "/v1beta",
  "/v1beta/models",
  "/v1beta/openai",
  "/v1beta/openai/chat/completions",
  "/v1beta/openai/responses",
  "/v1beta/openai/files",
];

const ANTHROPIC_PATHS = ["/", "/v1", "/v1/messages", "/v1/chat/completions"];
const MINIMAX_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/anthropic",
  "/anthropic/v1",
  "/anthropic/v1/messages",
];
const GLM_PATHS = [
  "/",
  "/api/paas/v4",
  "/api/paas/v4/chat/completions",
  "/api/coding/paas/v4",
  "/api/coding/paas/v4/chat/completions",
  "/api/anthropic",
  "/api/anthropic/v1",
  "/api/anthropic/v1/messages",
];
const DEEPSEEK_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/anthropic",
  "/anthropic/v1",
  "/anthropic/v1/messages",
];
const GROK_PATHS = ["/", "/v1", "/v1/chat/completions", "/v1/responses"];
const QWEN_PATHS = [
  "/",
  "/compatible-mode/v1",
  "/compatible-mode/v1/chat/completions",
  "/compatible-mode/v1/responses",
  "/api/v2/apps/protocols/compatible-mode/v1",
  "/api/v2/apps/protocols/compatible-mode/v1/responses",
];
const KIMI_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  // Kimi-for-Coding subscription endpoint (api.kimi.com).
  "/coding",
  "/coding/v1",
  "/coding/v1/chat/completions",
];
const MIMO_PATHS = ["/", "/v1", "/v1/chat/completions"];
const COPILOT_PATHS = ["/", "/chat/completions", "/models"];

const OLLAMA_DEFAULT_PORT = "11434";

/**
 * Ollama is claimed when the base is local and either sits on its default port
 * or already names an /api path. Anything else local falls through to the
 * generic OpenAI-compatible preset below, so LM Studio (1234), llama.cpp (8080)
 * and vLLM (8000) are not mislabelled.
 */
function matchesOllamaBase(apiBase: string): boolean {
  const parsed = parseApiBase(apiBase);
  if (!parsed || !isLocalHostname(parsed.hostname)) return false;
  if (parsed.port === OLLAMA_DEFAULT_PORT) return true;
  return parsed.pathname === "/api" || parsed.pathname.startsWith("/api/");
}

function matchesLocalOpenAIBase(apiBase: string): boolean {
  return isLocalModelApiBase(apiBase);
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    defaultApiBase: "https://api.openai.com/v1/responses",
    defaultProtocol: "responses_api",
    supportedProtocols: ["responses_api", "openai_chat_compat"],
    helperText: "Preset uses OpenAI's official Responses endpoint.",
    matches: makeHostAndPathMatcher(["api.openai.com"], OPENAI_PATHS),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: true,
    defaultEmbeddingModel: "text-embedding-3-small",
  },
  {
    id: "gemini",
    label: "Gemini",
    defaultApiBase: "https://generativelanguage.googleapis.com/v1beta",
    defaultProtocol: "gemini_native",
    supportedProtocols: ["gemini_native", "openai_chat_compat"],
    helperText: "Preset uses Gemini's native generateContent endpoint.",
    matches: makeHostAndPathMatcher(
      ["generativelanguage.googleapis.com"],
      GEMINI_PATHS,
    ),
    supportsEmbeddings: true,
    defaultEmbeddingModel: "gemini-embedding-001",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultApiBase: "https://api.anthropic.com/v1",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText: "Preset uses Anthropic's native Messages API.",
    matches: makeHostAndPathMatcher(["api.anthropic.com"], ANTHROPIC_PATHS),
    supportsEmbeddings: false,
  },
  {
    id: "minimax",
    label: "MiniMax",
    defaultApiBase: "https://api.minimax.io/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses MiniMax's recommended Anthropic-compatible endpoint.",
    matches: makeHostAndPathMatcher(
      ["api.minimax.io", "api.minimaxi.com"],
      MINIMAX_PATHS,
    ),
    supportsEmbeddings: false,
  },
  {
    id: "glm",
    label: "GLM",
    defaultApiBase: "https://open.bigmodel.cn/api/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses GLM's Claude-compatible endpoint for agent tool use.",
    matches: makeHostAndPathMatcher(["open.bigmodel.cn"], GLM_PATHS),
    supportsEmbeddings: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultApiBase: "https://api.deepseek.com/anthropic",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText:
      "Preset uses DeepSeek's Anthropic-compatible endpoint for reliable agent tool use.",
    matches: makeHostAndPathMatcher(["api.deepseek.com"], DEEPSEEK_PATHS),
    supportsEmbeddings: true,
    defaultEmbeddingModel: "deepseek-embedding",
  },
  {
    id: "grok",
    label: "Grok",
    defaultApiBase: "https://api.x.ai/v1/responses",
    defaultProtocol: "responses_api",
    supportedProtocols: ["responses_api", "openai_chat_compat"],
    helperText: "Preset uses xAI's official Responses endpoint.",
    matches: makeHostAndPathMatcher(["api.x.ai"], GROK_PATHS),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: false,
  },
  {
    id: "qwen",
    label: "Qwen",
    defaultApiBase: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText: "Preset uses DashScope's compatible-mode API base (v1).",
    matches: makeHostAndPathMatcher(
      [
        "dashscope.aliyuncs.com",
        "dashscope-intl.aliyuncs.com",
        "dashscope-us.aliyuncs.com",
      ],
      QWEN_PATHS,
    ),
    supportsResponsesEndpoint: true,
    supportsEmbeddings: true,
    defaultEmbeddingModel: "text-embedding-v4",
  },
  {
    id: "kimi",
    label: "Kimi",
    defaultApiBase: "https://api.moonshot.ai/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText:
      "Moonshot platform keys use api.moonshot.ai (api.moonshot.cn for China). " +
      "Kimi coding-plan keys only work with https://api.kimi.com/coding/v1.",
    matches: makeHostAndPathMatcher(
      ["api.moonshot.cn", "api.moonshot.ai", "api.kimi.com"],
      KIMI_PATHS,
    ),
    supportsEmbeddings: false,
  },
  {
    id: "mimo",
    label: "Xiaomi MiMo",
    defaultApiBase: "https://api.xiaomimimo.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Xiaomi MiMo's OpenAI-compatible API base (v1).",
    matches: makeHostAndPathMatcher(["api.xiaomimimo.com"], MIMO_PATHS),
    supportsEmbeddings: false,
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    defaultApiBase: "https://api.githubcopilot.com",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText:
      "Uses GitHub Copilot via device login. Requires an active Copilot subscription.",
    matches: makeHostAndPathMatcher(["api.githubcopilot.com"], COPILOT_PATHS),
    supportsEmbeddings: false,
  },
  // Local runtimes go last: their matchers accept broad local hosts, so a
  // hosted preset must get the chance to claim the base first. Within the pair,
  // ollama must precede local_openai — detectProviderPreset returns the first
  // match and local_openai accepts every local host.
  {
    id: "ollama",
    label: "Ollama (local)",
    defaultApiBase: "http://localhost:11434",
    defaultProtocol: "ollama_native",
    supportedProtocols: ["ollama_native", "openai_chat_compat"],
    helperText:
      "Preset uses Ollama's native /api/chat endpoint, which separates thinking " +
      "from the answer and honours the think parameter. No API key required.",
    matches: matchesOllamaBase,
    supportsEmbeddings: true,
    defaultEmbeddingModel: "nomic-embed-text",
    requiresApiKey: false,
  },
  {
    id: "local_openai",
    label: "Local (OpenAI-compatible)",
    defaultApiBase: "http://localhost:1234/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText:
      "For LM Studio, llama.cpp, vLLM, Jan and other local OpenAI-compatible " +
      "servers. No API key required.",
    matches: matchesLocalOpenAIBase,
    supportsEmbeddings: true,
    requiresApiKey: false,
  },
];

/** True when the preset serves unauthenticated, so a blank API key is valid. */
export function providerPresetRequiresApiKey(id: ProviderPresetId): boolean {
  if (id === "customized") return true;
  return getProviderPreset(id).requiresApiKey !== false;
}

export function getProviderPreset(
  id: SupportedProviderPresetId,
): ProviderPreset {
  const preset = PROVIDER_PRESETS.find((entry) => entry.id === id);
  if (!preset) {
    throw new Error(`Unknown provider preset: ${id}`);
  }
  return preset;
}

function dedupeProtocols(protocols: ProviderProtocol[]): ProviderProtocol[] {
  return protocols.filter(
    (protocol, index) => protocols.indexOf(protocol) === index,
  );
}

export function getProviderPresetProtocolOptions(
  id: ProviderPresetId,
): ProviderProtocol[] {
  if (id === "customized") {
    return [...CUSTOMIZED_API_KEY_PROTOCOL_OPTIONS];
  }
  const preset = getProviderPreset(id);
  // Local runtimes speak exactly what they declare. Appending the general
  // hosted options would offer anthropic_messages against an Ollama or
  // llama.cpp server, which never serves it.
  if (preset.requiresApiKey === false) {
    return dedupeProtocols([...preset.supportedProtocols]);
  }
  return dedupeProtocols([
    ...preset.supportedProtocols,
    ...GENERAL_API_KEY_PROTOCOL_OPTIONS,
  ]);
}

export function detectProviderPreset(apiBase: string): ProviderPresetId {
  const normalized = normalizeApiBase(apiBase);
  if (!normalized) return "customized";
  for (const preset of PROVIDER_PRESETS) {
    if (preset.matches(normalized)) return preset.id;
  }
  return "customized";
}

export function isGrokApiBase(apiBase: string): boolean {
  return getProviderPreset("grok").matches(apiBase);
}

/** True if the given apiBase is for a known provider that supports the /v1/responses endpoint. */
export function providerSupportsResponsesEndpoint(apiBase: string): boolean {
  const id = detectProviderPreset(apiBase);
  if (id === "customized") return false;
  const preset = getProviderPreset(id);
  return Boolean(preset.supportsResponsesEndpoint);
}
