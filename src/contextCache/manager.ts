import type { UsageStats } from "../shared/llm";
import type { PaperContextRef } from "../shared/types";
import { estimateTextTokens } from "../utils/modelInputCap";
import { detectProviderPreset } from "../utils/providerPresets";
import type { ProviderProtocol } from "../utils/providerProtocol";
import { config } from "../../package.json";
import type {
  ProviderParams,
  ProviderPromptCacheCapability,
  ProviderPromptCacheProvider,
} from "../providers/types";

export type ContextCachePreference = "auto" | "off" | "pinned";

export type ContextCacheAssemblyMode = "full" | "retrieval";
export type ContextCacheAssemblyStrategy =
  | "paper-first-full"
  | "paper-cache-full"
  | "paper-manual-full"
  | "paper-explicit-retrieval"
  | "paper-followup-retrieval"
  | "agent-evidence-full"
  | "general-full"
  | "general-retrieval";

export type ContextCachePlanMode =
  | "disabled"
  | "retrieval_fallback"
  | "stable_prefix"
  | "anthropic_block"
  | "explicit_resource"
  | "opaque_prefix";

export type ContextCachePlan = {
  enabled: boolean;
  mode: ContextCachePlanMode;
  provider: ProviderPromptCacheProvider;
  providerLabel: string;
  telemetry: ProviderPromptCacheCapability["telemetry"];
  cacheKey?: string;
  contentHash?: string;
  contextTokens?: number;
  statusLabel?: string;
  reason?: string;
  requestHints?: {
    promptCacheKey?: string;
    promptCacheRetention?: "in_memory" | "24h";
    anthropicCacheControl?: { type: "ephemeral"; ttl?: "5m" | "1h" };
  };
};

export type ContextCacheTelemetryRecord = {
  cacheKey: string;
  provider: ProviderPromptCacheProvider;
  hits: number;
  misses: number;
  reads: number;
  writes: number;
  lastHitRatio?: number;
  lastUpdatedAt: number;
};

const CACHE_MIN_TOKENS = 1024;
const TELEMETRY_PREF_NAME = "contextCacheTelemetry";
const MAX_PERSISTED_TELEMETRY_RECORDS = 100;
const telemetryByCacheKey = new Map<string, ContextCacheTelemetryRecord>();
let telemetryLoaded = false;

function getPrefName(key: string): string | null {
  const prefsPrefix = config?.prefsPrefix;
  return prefsPrefix ? `${prefsPrefix}.${key}` : null;
}

function getZoteroPref(key: string): unknown {
  try {
    const prefName = getPrefName(key);
    if (!prefName) return undefined;
    return Zotero.Prefs.get(prefName, true);
  } catch (_err) {
    return undefined;
  }
}

function setZoteroPref(key: string, value: unknown): void {
  try {
    const prefName = getPrefName(key);
    if (!prefName) return;
    Zotero.Prefs.set(
      prefName,
      typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
        ? value
        : JSON.stringify(value),
      true,
    );
  } catch (_err) {
    // Preference persistence is best-effort; cache planning still works without it.
  }
}

export function resolveContextCachePreference(): ContextCachePreference {
  const raw = getZoteroPref("contextCacheReuse");
  const normalized = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (normalized === "off" || normalized === "pinned") {
    return normalized;
  }
  return "auto";
}

function loadPersistedTelemetry(): void {
  if (telemetryLoaded) return;
  telemetryLoaded = true;
  const raw = getZoteroPref(TELEMETRY_PREF_NAME);
  if (typeof raw !== "string" || !raw.trim()) return;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const row = entry as Record<string, unknown>;
      const cacheKey = typeof row.cacheKey === "string" ? row.cacheKey : "";
      const provider =
        typeof row.provider === "string"
          ? (row.provider as ProviderPromptCacheProvider)
          : "unknown";
      if (!cacheKey) continue;
      telemetryByCacheKey.set(cacheKey, {
        cacheKey,
        provider,
        hits: Math.max(0, Math.floor(Number(row.hits) || 0)),
        misses: Math.max(0, Math.floor(Number(row.misses) || 0)),
        reads: Math.max(0, Math.floor(Number(row.reads) || 0)),
        writes: Math.max(0, Math.floor(Number(row.writes) || 0)),
        lastHitRatio:
          Number.isFinite(Number(row.lastHitRatio)) &&
          Number(row.lastHitRatio) >= 0
            ? Math.max(0, Math.min(1, Number(row.lastHitRatio)))
            : undefined,
        lastUpdatedAt: Math.max(0, Math.floor(Number(row.lastUpdatedAt) || 0)),
      });
    }
  } catch (_err) {
    // Ignore corrupted telemetry; it is advisory and can be rebuilt.
  }
}

function persistTelemetry(): void {
  const records = [...telemetryByCacheKey.values()]
    .sort((a, b) => b.lastUpdatedAt - a.lastUpdatedAt)
    .slice(0, MAX_PERSISTED_TELEMETRY_RECORDS);
  setZoteroPref(TELEMETRY_PREF_NAME, JSON.stringify(records));
}

function normalizeProtocol(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function resolvePromptCacheCapability(
  params: ProviderParams,
): ProviderPromptCacheCapability {
  const authMode = normalizeProtocol(params.authMode);
  const protocol = normalizeProtocol(params.protocol);
  const preset = detectProviderPreset(params.apiBase || "");

  if (authMode === "codex_app_server") {
    return {
      kind: "opaque",
      provider: "codex",
      label: "Codex app-server",
      telemetry: "opaque",
      stablePrefix: true,
    };
  }

  if (authMode === "codex_auth" || protocol === "codex_responses") {
    return {
      kind: "automatic_prefix",
      provider: "codex",
      label: "Codex / ChatGPT",
      telemetry: "openai_cached_tokens",
      stablePrefix: true,
    };
  }

  if (preset === "openai") {
    return {
      kind: "automatic_prefix",
      provider: "openai",
      label: "OpenAI prompt cache",
      telemetry: "openai_cached_tokens",
      stablePrefix: true,
      supportsPromptCacheKey: true,
      supportsRetentionHint: true,
    };
  }

  if (preset === "anthropic" && protocol === "anthropic_messages") {
    return {
      kind: "explicit_blocks",
      provider: "anthropic",
      label: "Anthropic prompt cache",
      telemetry: "anthropic_read_write",
      stablePrefix: true,
      supportsAnthropicCacheControl: true,
    };
  }

  if (preset === "deepseek") {
    return {
      kind: "automatic_prefix",
      provider: "deepseek",
      label: "DeepSeek KV cache",
      telemetry: "deepseek_hit_miss",
      stablePrefix: true,
    };
  }

  if (preset === "gemini") {
    return {
      kind: "automatic_prefix",
      provider: "gemini",
      label: "Gemini context cache",
      telemetry: "gemini_cached_content",
      stablePrefix: true,
      supportsExplicitResource: protocol === "gemini_native",
    };
  }

  if (preset === "kimi") {
    return {
      kind: "automatic_prefix",
      provider: "kimi",
      label: "Kimi context cache",
      telemetry: "kimi_cached_tokens",
      stablePrefix: true,
    };
  }

  return {
    kind: "none",
    provider: "unknown",
    label: "No prompt cache support",
    telemetry: "none",
    stablePrefix: false,
  };
}

function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function paperContextKey(ref: PaperContextRef): string {
  return `${Math.floor(Number(ref.itemId) || 0)}:${Math.floor(Number(ref.contextItemId) || 0)}`;
}

function normalizeModelForCacheKey(model: string | undefined): string {
  return (model || "").trim().toLowerCase() || "unknown-model";
}

function buildContextCacheKey(params: {
  capability: ProviderPromptCacheCapability;
  model?: string;
  contextText: string;
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
}): { cacheKey: string; contentHash: string } {
  const papers = [
    ...(params.paperContexts || []),
    ...(params.fullTextPaperContexts || []),
  ]
    .map(paperContextKey)
    .filter(Boolean)
    .sort()
    .join(",");
  const contentHash = stableHash(params.contextText);
  return {
    cacheKey: [
      params.capability.provider,
      normalizeModelForCacheKey(params.model),
      papers || "no-papers",
      contentHash,
    ].join(":"),
    contentHash,
  };
}

function supportsProviderRequestHints(
  capability: ProviderPromptCacheCapability,
): boolean {
  return Boolean(
    capability.supportsPromptCacheKey ||
    capability.supportsRetentionHint ||
    capability.supportsAnthropicCacheControl,
  );
}

function shouldUseRetentionHint(model: string | undefined): boolean {
  const normalized = normalizeModelForCacheKey(model);
  return /^gpt-(?:5|4\.1)(?:$|[-._])/.test(normalized);
}

export function planContextCacheReuse(params: {
  model?: string;
  apiBase?: string;
  authMode?: string;
  protocol?: ProviderProtocol;
  mode: ContextCacheAssemblyMode;
  strategy: ContextCacheAssemblyStrategy;
  contextText: string;
  paperContexts?: PaperContextRef[];
  fullTextPaperContexts?: PaperContextRef[];
  preference?: ContextCachePreference;
}): ContextCachePlan {
  const capability = resolvePromptCacheCapability({
    model: params.model || "",
    apiBase: params.apiBase,
    authMode: params.authMode,
    protocol: params.protocol,
  });
  const preference = params.preference || resolveContextCachePreference();
  const contextText = params.contextText || "";
  const contextTokens = estimateTextTokens(contextText);

  const disabled = (reason: string): ContextCachePlan => ({
    enabled: false,
    mode: params.mode === "retrieval" ? "retrieval_fallback" : "disabled",
    provider: capability.provider,
    providerLabel: capability.label,
    telemetry: capability.telemetry,
    contextTokens,
    reason,
  });

  if (preference === "off") return disabled("disabled-by-preference");
  if (capability.kind === "none") return disabled("provider-unsupported");
  if (!contextText.trim()) return disabled("empty-context");
  if (params.mode !== "full") return disabled("retrieval-mode");
  if (contextTokens < CACHE_MIN_TOKENS)
    return disabled("below-cache-threshold");
  if (
    preference === "pinned" &&
    !(params.fullTextPaperContexts && params.fullTextPaperContexts.length)
  ) {
    return disabled("not-pinned");
  }

  const { cacheKey, contentHash } = buildContextCacheKey({
    capability,
    model: params.model,
    contextText,
    paperContexts: params.paperContexts,
    fullTextPaperContexts: params.fullTextPaperContexts,
  });
  const requestHints: ContextCachePlan["requestHints"] = {};
  if (capability.supportsPromptCacheKey) {
    requestHints.promptCacheKey = cacheKey.slice(0, 128);
  }
  if (
    capability.supportsRetentionHint &&
    shouldUseRetentionHint(params.model)
  ) {
    requestHints.promptCacheRetention = "24h";
  }
  if (capability.supportsAnthropicCacheControl) {
    requestHints.anthropicCacheControl = { type: "ephemeral" };
  }

  const mode: ContextCachePlanMode =
    capability.kind === "explicit_blocks"
      ? "anthropic_block"
      : capability.kind === "explicit_resource"
        ? "explicit_resource"
        : capability.kind === "opaque"
          ? "opaque_prefix"
          : "stable_prefix";

  return {
    enabled: true,
    mode,
    provider: capability.provider,
    providerLabel: capability.label,
    telemetry: capability.telemetry,
    cacheKey,
    contentHash,
    contextTokens,
    statusLabel:
      capability.kind === "opaque"
        ? "Using cache-aware stable context"
        : supportsProviderRequestHints(capability)
          ? "Using provider prompt cache"
          : "Using cache-aware stable context",
    requestHints: Object.keys(requestHints).length ? requestHints : undefined,
  };
}

export function shouldPreferCacheAwareFullContext(params: {
  model?: string;
  apiBase?: string;
  authMode?: string;
  protocol?: ProviderProtocol;
  candidateContextText: string;
  hasPinnedFullText?: boolean;
  preference?: ContextCachePreference;
}): boolean {
  const preference = params.preference || resolveContextCachePreference();
  if (preference === "off") return false;
  if (preference === "pinned" && !params.hasPinnedFullText) return false;
  const capability = resolvePromptCacheCapability({
    model: params.model || "",
    apiBase: params.apiBase,
    authMode: params.authMode,
    protocol: params.protocol,
  });
  if (capability.kind === "none") return false;
  if (!capability.stablePrefix) return false;
  return estimateTextTokens(params.candidateContextText) >= CACHE_MIN_TOKENS;
}

function readNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : 0;
}

function readNestedNumber(
  obj: Record<string, unknown>,
  key: string,
  nestedKey: string,
): number {
  const nested = obj[key];
  if (!nested || typeof nested !== "object" || Array.isArray(nested)) return 0;
  return readNumber(nested as Record<string, unknown>, nestedKey);
}

export function extractContextCacheUsage(usage: unknown): Partial<UsageStats> {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return {};
  const u = usage as Record<string, unknown>;
  const inputTokens =
    readNumber(u, "prompt_tokens") ||
    readNumber(u, "input_tokens") ||
    readNumber(u, "promptTokenCount") ||
    readNumber(u, "prompt_token_count") ||
    readNumber(u, "inputTokens");

  const deepseekHit = readNumber(u, "prompt_cache_hit_tokens");
  const deepseekMiss = readNumber(u, "prompt_cache_miss_tokens");
  if (deepseekHit > 0 || deepseekMiss > 0) {
    const denominator = inputTokens || deepseekHit + deepseekMiss;
    return {
      cacheReadTokens: deepseekHit,
      cacheMissTokens: deepseekMiss,
      cacheHitRatio: denominator > 0 ? deepseekHit / denominator : undefined,
      cacheProvider: "deepseek",
    };
  }

  const anthropicRead = readNumber(u, "cache_read_input_tokens");
  const anthropicWrite = readNumber(u, "cache_creation_input_tokens");
  if (anthropicRead > 0 || anthropicWrite > 0) {
    const denominator = inputTokens || anthropicRead + anthropicWrite;
    return {
      cacheReadTokens: anthropicRead,
      cacheWriteTokens: anthropicWrite,
      cacheMissTokens: Math.max(0, inputTokens - anthropicRead),
      cacheHitRatio: denominator > 0 ? anthropicRead / denominator : undefined,
      cacheProvider: "anthropic",
    };
  }

  const openAiCached =
    readNestedNumber(u, "prompt_tokens_details", "cached_tokens") ||
    readNestedNumber(u, "input_tokens_details", "cached_tokens") ||
    readNestedNumber(u, "promptTokensDetails", "cachedTokens") ||
    readNestedNumber(u, "inputTokensDetails", "cachedTokens");
  if (openAiCached > 0) {
    const denominator = inputTokens || openAiCached;
    return {
      cacheReadTokens: openAiCached,
      cacheMissTokens: Math.max(0, inputTokens - openAiCached),
      cacheHitRatio: denominator > 0 ? openAiCached / denominator : undefined,
      cacheProvider: "openai",
    };
  }

  const geminiCached =
    readNumber(u, "cachedContentTokenCount") ||
    readNumber(u, "cached_content_token_count");
  if (geminiCached > 0) {
    const denominator = inputTokens || geminiCached;
    return {
      cacheReadTokens: geminiCached,
      cacheMissTokens: Math.max(0, inputTokens - geminiCached),
      cacheHitRatio: denominator > 0 ? geminiCached / denominator : undefined,
      cacheProvider: "gemini",
    };
  }

  const genericRead =
    readNumber(u, "cacheReadTokens") || readNumber(u, "cache_read_tokens");
  const genericWrite =
    readNumber(u, "cacheWriteTokens") || readNumber(u, "cache_write_tokens");
  const genericMiss =
    readNumber(u, "cacheMissTokens") || readNumber(u, "cache_miss_tokens");
  if (genericRead > 0 || genericWrite > 0 || genericMiss > 0) {
    const denominator = inputTokens || genericRead + genericMiss;
    return {
      cacheReadTokens: genericRead,
      cacheWriteTokens: genericWrite,
      cacheMissTokens: genericMiss,
      cacheHitRatio: denominator > 0 ? genericRead / denominator : undefined,
      cacheProvider: "codex",
    };
  }

  const kimiCached = readNumber(u, "cached_tokens");
  if (kimiCached > 0) {
    const denominator = inputTokens || kimiCached;
    return {
      cacheReadTokens: kimiCached,
      cacheMissTokens: Math.max(0, inputTokens - kimiCached),
      cacheHitRatio: denominator > 0 ? kimiCached / denominator : undefined,
      cacheProvider: "kimi",
    };
  }

  return {};
}

export function recordContextCacheTelemetry(
  plan: ContextCachePlan | undefined,
  usage: UsageStats,
): void {
  if (!plan?.enabled || !plan.cacheKey) return;
  loadPersistedTelemetry();
  const read = Math.max(0, usage.cacheReadTokens || 0);
  const write = Math.max(0, usage.cacheWriteTokens || 0);
  const miss = Math.max(0, usage.cacheMissTokens || 0);
  const existing = telemetryByCacheKey.get(plan.cacheKey);
  telemetryByCacheKey.set(plan.cacheKey, {
    cacheKey: plan.cacheKey,
    provider: plan.provider,
    hits: (existing?.hits || 0) + (read > 0 ? 1 : 0),
    misses: (existing?.misses || 0) + (read <= 0 && miss > 0 ? 1 : 0),
    reads: (existing?.reads || 0) + read,
    writes: (existing?.writes || 0) + write,
    lastHitRatio:
      typeof usage.cacheHitRatio === "number" ? usage.cacheHitRatio : undefined,
    lastUpdatedAt: Date.now(),
  });
  persistTelemetry();
}

export function getContextCacheTelemetry(
  cacheKey: string | undefined,
): ContextCacheTelemetryRecord | undefined {
  loadPersistedTelemetry();
  return cacheKey ? telemetryByCacheKey.get(cacheKey) : undefined;
}

export function clearContextCacheTelemetry(): void {
  loadPersistedTelemetry();
  telemetryByCacheKey.clear();
  persistTelemetry();
}
