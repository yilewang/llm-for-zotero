import type { ModelCapabilityProvider } from "./types";

/**
 * Single source of truth for guessing which provider family a model belongs
 * to.  Capability resolution, the chat reasoning selector, and any future
 * consumer must share these rules so a model keeps its reasoning profile no
 * matter which URL serves it (official host, relay, or proxy) — see issue
 * #360, where `k3` on api.kimi.com lost its thinking levels because each
 * layer kept its own partial copy of this knowledge.
 */

const MODEL_NAME_RULES: Array<{
  provider: ModelCapabilityProvider;
  pattern: RegExp;
}> = [
  { provider: "deepseek", pattern: /^deepseek/ },
  { provider: "kimi", pattern: /(^|[/:])kimi(?:\b|[.-])/ },
  // Kimi-for-Coding (api.kimi.com/coding/v1) serves the K3 family under bare
  // ids: k3, k3-256k. The boundary check keeps k30/k3x out.
  { provider: "kimi", pattern: /(^|[/:])k3(?:\b|[.-])/ },
  {
    provider: "mimo",
    pattern: /(^|[/:])mimo-v2(?:\.5)?(?:-(?:pro|omni|flash))?(?:\b|[.-])/,
  },
  { provider: "qwen", pattern: /(^|[/:])(?:qwen(?:\d+)?|qwq|qvq)(?:\b|[.-])/ },
  { provider: "grok", pattern: /(^|[/:])grok(?:\b|[.-])/ },
  { provider: "anthropic", pattern: /(^|[/:.])claude(?:\b|[.-])/ },
  { provider: "gemini", pattern: /gemini/ },
  { provider: "openai", pattern: /^(gpt-5|o\d)(\b|[.-])/ },
  { provider: "glm", pattern: /(^|[/:])glm(?:\b|[.-])/ },
  { provider: "minimax", pattern: /(^|[/:])minimax(?:\b|[.-])/ },
];

/** Infer the provider family from a model id, or null when unrecognized. */
export function inferProviderFromModelName(
  modelName: string,
): ModelCapabilityProvider | null {
  const name = modelName.trim().toLowerCase();
  if (!name) return null;
  for (const rule of MODEL_NAME_RULES) {
    if (rule.pattern.test(name)) return rule.provider;
  }
  return null;
}

/** Infer the provider family from an API base URL, or null when unrecognized. */
export function inferProviderFromApiBase(
  apiBase: string,
): ModelCapabilityProvider | null {
  const base = apiBase.trim().toLowerCase();
  if (!base) return null;
  if (base.includes("moonshot") || base.includes("api.kimi.com")) {
    return "kimi";
  }
  if (base.includes("generativelanguage.googleapis.com")) return "gemini";
  if (base.includes("anthropic.com")) return "anthropic";
  if (base.includes("deepseek.com")) return "deepseek";
  if (base.includes("openai.com")) return "openai";
  if (base.includes("api.x.ai") || base.includes("x.ai")) return "grok";
  if (base.includes("dashscope") || base.includes("aliyuncs.com")) {
    return "qwen";
  }
  if (base.includes("bigmodel.cn")) return "glm";
  if (base.includes("minimax")) return "minimax";
  if (base.includes("xiaomimimo.com")) return "mimo";
  return null;
}
