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
  | "litellm";

export type ProviderPresetId = SupportedProviderPresetId | "customized";

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
    };
  } catch (_err) {
    return null;
  }
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
const KIMI_PATHS = ["/", "/v1", "/v1/chat/completions"];
const MIMO_PATHS = ["/", "/v1", "/v1/chat/completions"];
const LITELLM_PATHS = [
  "/",
  "/v1",
  "/v1/chat/completions",
  "/v1/responses",
  "/v1/models",
  "/v1/embeddings",
];
const COPILOT_PATHS = ["/", "/chat/completions", "/models"];

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
      "Preset uses Moonshot's international API. Use api.moonshot.cn for China.",
    matches: makeHostAndPathMatcher(
      ["api.moonshot.cn", "api.moonshot.ai"],
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
    id: "litellm",
    label: "LiteLLM",
    defaultApiBase: "http://localhost:4000/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText:
      "Preset uses a LiteLLM proxy for unified access to 100+ LLM providers.",
    matches: (apiBase: string) => {
      const parsed = parseApiBase(apiBase);
      if (!parsed) return false;
      return (
        parsed.hostname.includes("litellm") &&
        matchesPaths(parsed.pathname, LITELLM_PATHS)
      );
    },
    supportsEmbeddings: true,
    defaultEmbeddingModel: "text-embedding-3-small",
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
];

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
