/**
 * Dynamic model resolver based on available SDK models.
 * Model values are opaque SDK identifiers. The resolver only canonicalizes an
 * exact catalog match and otherwise passes the requested value through.
 */

export interface ModelInfo {
  value?: string;
  resolvedModel?: string;
  displayName?: string;
  description?: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
  supportsAdaptiveThinking?: boolean;
  supportsFastMode?: boolean;
  supportsAutoMode?: boolean;
}

function cleanModelName(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\u001b\[[0-9;]*m/g, "").trim();
}

export function normalizeProviderModelName(value: unknown): string {
  return cleanModelName(value);
}

/**
 * Cache key includes settingSources to support profile hot-swapping.
 * When user switches profiles, settingSources changes → cache miss → fresh model fetch.
 */
const modelCache = new Map<
  string,
  { models: ModelInfo[]; expiresAt: number }
>();

const CACHE_TTL_MS = 60_000; // 1 minute cache
export const MODEL_CACHE_MAX_ENTRIES = 128;

function pruneExpiredModelCache(now = Date.now()): void {
  for (const [key, cached] of modelCache) {
    if (cached.expiresAt <= now) {
      modelCache.delete(key);
    }
  }
}

function evictOldestModelCacheEntries(): void {
  while (modelCache.size > MODEL_CACHE_MAX_ENTRIES) {
    const oldestKey = modelCache.keys().next().value;
    if (typeof oldestKey !== "string") return;
    modelCache.delete(oldestKey);
  }
}

function getCacheKey(
  settingSources: string[],
  providerKey = "default",
): string {
  return `${providerKey}::${settingSources.join(",")}`;
}

export function getCachedModels(
  settingSources: string[],
  providerKey?: string,
): ModelInfo[] | undefined {
  const key = getCacheKey(settingSources, providerKey);
  const cached = modelCache.get(key);
  const now = Date.now();
  if (cached && now < cached.expiresAt) {
    // Map insertion order is the LRU order for this small shared cache.
    modelCache.delete(key);
    modelCache.set(key, cached);
    return cached.models;
  }
  if (cached) modelCache.delete(key);
  return undefined;
}

export function setCachedModels(
  settingSources: string[],
  models: ModelInfo[],
  providerKey?: string,
): void {
  const key = getCacheKey(settingSources, providerKey);
  const now = Date.now();
  pruneExpiredModelCache(now);
  modelCache.delete(key);
  modelCache.set(key, {
    models,
    expiresAt: now + CACHE_TTL_MS,
  });
  evictOldestModelCacheEntries();
}

/**
 * Returns the SDK's exact spelling for an exact catalog match.
 *
 * Unknown values are returned unchanged so Claude Code can interpret aliases,
 * provider-specific names, and future model families itself. In particular,
 * this function must never replace an unknown request with the first model.
 */
export function resolveModelAlias(
  alias: string,
  availableModels: ModelInfo[],
): string | undefined {
  const normalizedAlias = normalizeProviderModelName(alias);
  if (!normalizedAlias) return undefined;
  const exact = availableModels
    .map((model) => normalizeProviderModelName(model.value))
    .find((model) => model === normalizedAlias);
  return exact || normalizedAlias;
}

/**
 * Synchronous resolution with a cached catalog when available.
 *
 * Cache misses and unknown catalog values deliberately pass the request
 * through. Claude Code remains the authority that resolves or rejects it.
 */
export function resolveModelWithCache(
  alias: string,
  settingSources: string[],
  providerKey?: string,
): { model: string | undefined; cacheHit: boolean } {
  const normalizedAlias = normalizeProviderModelName(alias);
  if (!normalizedAlias) return { model: undefined, cacheHit: false };

  const cached = getCachedModels(settingSources, providerKey);
  if (cached) {
    return { model: resolveModelAlias(alias, cached), cacheHit: true };
  }

  return { model: normalizedAlias, cacheHit: false };
}
