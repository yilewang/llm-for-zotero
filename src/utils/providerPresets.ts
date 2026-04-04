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
  | "copilot"
  // Domestic (China)
  | "siliconflow"
  | "spark"
  | "hunyuan"
  | "baichuan"
  | "stepfun"
  | "yi"
  // International
  | "openrouter"
  | "together"
  | "groq"
  | "mistral"
  | "fireworks";

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
const SILICONFLOW_PATHS = ["/", "/v1", "/v1/chat/completions"];
const SPARK_PATHS = ["/", "/v1", "/v1/chat/completions"];
const HUNYUAN_PATHS = ["/", "/v1", "/v1/chat/completions"];
const BAICHUAN_PATHS = ["/", "/v1", "/v1/chat/completions"];
const STEPFUN_PATHS = ["/", "/v1", "/v1/chat/completions"];
const YI_PATHS = ["/", "/v1", "/v1/chat/completions"];
const OPENROUTER_PATHS = ["/", "/api/v1", "/api/v1/chat/completions"];
const TOGETHER_PATHS = ["/", "/v1", "/v1/chat/completions"];
const GROQ_PATHS = ["/", "/openai/v1", "/openai/v1/chat/completions"];
const MISTRAL_PATHS = ["/", "/v1", "/v1/chat/completions"];
const FIREWORKS_PATHS = ["/", "/inference/v1", "/inference/v1/chat/completions"];

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
  },
  {
    id: "anthropic",
    label: "Anthropic",
    defaultApiBase: "https://api.anthropic.com/v1",
    defaultProtocol: "anthropic_messages",
    supportedProtocols: ["anthropic_messages", "openai_chat_compat"],
    helperText: "Preset uses Anthropic's native Messages API.",
    matches: makeHostAndPathMatcher(["api.anthropic.com"], ANTHROPIC_PATHS),
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
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    defaultApiBase: "https://api.deepseek.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses DeepSeek's official API base (v1).",
    matches: makeHostAndPathMatcher(["api.deepseek.com"], DEEPSEEK_PATHS),
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
  },
  {
    id: "kimi",
    label: "Kimi",
    defaultApiBase: "https://api.moonshot.ai/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Moonshot's international API. Use api.moonshot.cn for China.",
    matches: makeHostAndPathMatcher(
      ["api.moonshot.cn", "api.moonshot.ai"],
      KIMI_PATHS,
    ),
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    defaultApiBase: "https://api.githubcopilot.com",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat", "responses_api"],
    helperText:
      "Uses GitHub Copilot via device login. Requires an active Copilot subscription.",
    matches: makeHostAndPathMatcher(
      ["api.githubcopilot.com"],
      COPILOT_PATHS,
    ),
  },
  // --- Domestic (China) ---
  {
    id: "siliconflow",
    label: "SiliconFlow",
    defaultApiBase: "https://api.siliconflow.cn/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses SiliconFlow's official API (aggregates open-source models).",
    matches: makeHostAndPathMatcher(
      ["api.siliconflow.cn", "api.siliconflow.com"],
      SILICONFLOW_PATHS,
    ),
  },
  {
    id: "spark",
    label: "Spark",
    defaultApiBase: "https://spark-api-open.xf-yun.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses iFlytek Spark's OpenAI-compatible API.",
    matches: makeHostAndPathMatcher(
      ["spark-api-open.xf-yun.com"],
      SPARK_PATHS,
    ),
  },
  {
    id: "hunyuan",
    label: "Hunyuan",
    defaultApiBase: "https://api.hunyuan.cloud.tencent.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Tencent Hunyuan's official API.",
    matches: makeHostAndPathMatcher(
      ["api.hunyuan.cloud.tencent.com", "hunyuan.cloud.tencent.com"],
      HUNYUAN_PATHS,
    ),
  },
  {
    id: "baichuan",
    label: "Baichuan",
    defaultApiBase: "https://api.baichuan-ai.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Baichuan AI's official API.",
    matches: makeHostAndPathMatcher(
      ["api.baichuan-ai.com"],
      BAICHUAN_PATHS,
    ),
  },
  {
    id: "stepfun",
    label: "StepFun",
    defaultApiBase: "https://api.stepfun.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses StepFun's official API.",
    matches: makeHostAndPathMatcher(
      ["api.stepfun.com"],
      STEPFUN_PATHS,
    ),
  },
  {
    id: "yi",
    label: "Yi",
    defaultApiBase: "https://api.lingyiwanwu.com/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses 01.AI (Yi) official API.",
    matches: makeHostAndPathMatcher(
      ["api.lingyiwanwu.com"],
      YI_PATHS,
    ),
  },
  // --- International ---
  {
    id: "openrouter",
    label: "OpenRouter",
    defaultApiBase: "https://openrouter.ai/api/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses OpenRouter's API (aggregates many model providers).",
    matches: makeHostAndPathMatcher(
      ["openrouter.ai"],
      OPENROUTER_PATHS,
    ),
  },
  {
    id: "together",
    label: "Together.ai",
    defaultApiBase: "https://api.together.xyz/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Together.ai's API (open-source models).",
    matches: makeHostAndPathMatcher(
      ["api.together.xyz"],
      TOGETHER_PATHS,
    ),
  },
  {
    id: "groq",
    label: "Groq",
    defaultApiBase: "https://api.groq.com/openai/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Groq's ultra-fast inference API.",
    matches: makeHostAndPathMatcher(
      ["api.groq.com"],
      GROQ_PATHS,
    ),
  },
  {
    id: "mistral",
    label: "Mistral",
    defaultApiBase: "https://api.mistral.ai/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Mistral AI's official API.",
    matches: makeHostAndPathMatcher(
      ["api.mistral.ai"],
      MISTRAL_PATHS,
    ),
  },
  {
    id: "fireworks",
    label: "Fireworks AI",
    defaultApiBase: "https://api.fireworks.ai/inference/v1",
    defaultProtocol: "openai_chat_compat",
    supportedProtocols: ["openai_chat_compat"],
    helperText: "Preset uses Fireworks AI's inference API.",
    matches: makeHostAndPathMatcher(
      ["api.fireworks.ai"],
      FIREWORKS_PATHS,
    ),
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
