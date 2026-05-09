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
  | "copilot";

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
const DEEPSEEK_PATHS = ["/", "/v1", "/v1/chat/completions"];
const GROK_PATHS = ["/", "/v1", "/v1/chat/completions", "/v1/responses"];
const QWEN_PATHS = [
  "/",
  "/compatible-mode/v1",
  "/compatible-mode/v1/chat/completions",
];
const KIMI_PATHS = ["/", "/v1", "/v1/chat/completions"];
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
    supportedProtocols: [
      "gemini_native",
      "responses_api",
      "openai_chat_compat",
    ],
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
    defaultApiBase: "https://api.deepseek.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses DeepSeek's official API base (v1).",
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
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses DashScope's compatible-mode API base (v1).",
    matches: makeHostAndPathMatcher(
      ["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com"],
      QWEN_PATHS,
    ),
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
