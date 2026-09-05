import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
  getMimoReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getQwenReasoningProfileForModel,
  getRuntimeReasoningOptionsForModel,
  supportsReasoningForModel,
  type ReasoningProvider,
} from "../utils/reasoningProfiles";
import { MAX_ALLOWED_TOKENS } from "../utils/llmDefaults";
import { BUNDLED_MODEL_CAPABILITY_REGISTRY } from "./bundled";
import {
  inferProviderFromApiBase,
  inferProviderFromModelName,
} from "./providerInference";
import {
  fetchOllamaCatalog,
  stripImplicitLatestTag,
  usesOllamaCatalog,
} from "./localCatalog";
import { getAbortController } from "../utils/apiHelpers";
import { isLocalModelApiBase } from "../utils/providerPresets";
import {
  normalizeProfileOverride,
  profileOverrideAppliesTo,
  sanitizeUserRequestBody,
} from "./profileOverride";
import {
  applyControlPatch,
  cloneRegistry,
  findRegistryEntry,
  MODEL_CAPABILITY_MAX_TOKEN_LIMIT,
  MODEL_CAPABILITY_REGISTRY_MAX_BYTES,
  MODEL_CAPABILITY_REGISTRY_URL,
  removeControlRoots,
  validateRegistry,
} from "./registry";
import type {
  CapabilitySource,
  DiscoveredModel,
  ModelCapabilityIdentity,
  ModelCapabilityLimits,
  ModelCapabilityProvider,
  ModelCapabilityRefreshOptions,
  ModelCatalogIdentity,
  ModelControlPatch,
  ModelReasoningCapability,
  ModelSamplingCapability,
  RegistryModelEntry,
  ResolvedModelCapabilities,
} from "./types";

const REGISTRY_PREF_KEY =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistry";
const REGISTRY_TIMESTAMP_PREF_KEY =
  "extensions.zotero.llmforzotero.modelCapabilitiesRegistryFetchedAt";
const REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CATALOG_TTL_MS = 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const FIRST_USE_PREFLIGHT_TIMEOUT_MS = 5_000;

type CatalogSnapshot = {
  models: DiscoveredModel[];
  fetchedAt: number;
  stale: boolean;
  error?: string;
};

type CapabilityRuntime = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Test/development override for the bundled environment guard. */
  environment?: "production" | "development" | "test";
};

let runtime: CapabilityRuntime = {};
let activeRegistry = cloneRegistry(BUNDLED_MODEL_CAPABILITY_REGISTRY);
let activeRegistrySource: CapabilitySource = "bundled";
let persistedRegistryLoaded = false;
let registryRefreshTask: Promise<boolean> | null = null;
const capabilityPreflightTasks = new Map<string, Promise<void>>();
const catalogRefreshTasks = new Map<string, Promise<DiscoveredModel[]>>();
const catalogSnapshots = new Map<string, CatalogSnapshot>();
const capabilityListeners = new Set<() => void>();

function now(): number {
  return runtime.now?.() || Date.now();
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function getZoteroPrefs(): {
  get?: (key: string, global?: boolean) => unknown;
  set?: (key: string, value: unknown, global?: boolean) => void;
} | null {
  return (
    (
      globalThis as unknown as {
        Zotero?: {
          Prefs?: {
            get?: (key: string, global?: boolean) => unknown;
            set?: (key: string, value: unknown, global?: boolean) => void;
          };
        };
      }
    ).Zotero?.Prefs || null
  );
}

function getFetch(): typeof fetch | undefined {
  if (runtime.fetch) return runtime.fetch;
  const globalFetch = (globalThis as unknown as { fetch?: typeof fetch }).fetch;
  if (globalFetch) return globalFetch.bind(globalThis);
  const toolkit = (
    globalThis as unknown as {
      ztoolkit?: { getGlobal?: (key: string) => unknown };
    }
  ).ztoolkit;
  const toolkitFetch = toolkit?.getGlobal?.("fetch") as
    | typeof fetch
    | undefined;
  return toolkitFetch;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function notify(): void {
  for (const listener of capabilityListeners) {
    try {
      listener();
    } catch {
      // A UI listener must never make capability resolution fail.
    }
  }
}

function providerFromIdentity(
  identity: ModelCapabilityIdentity,
): ModelCapabilityProvider {
  const explicit = normalize(identity.provider);
  if (explicit && explicit !== "customized" && explicit !== "unknown") {
    return explicit as ModelCapabilityProvider;
  }
  if (
    normalize(identity.authMode) === "codex_auth" &&
    normalize(identity.protocol) === "codex_responses"
  ) {
    return "openai";
  }
  return (
    inferProviderFromApiBase(normalize(identity.apiBase)) ??
    // Relays and unrecognized hosts still serve recognizable models; the
    // model name keeps its provider family (and thus its reasoning profile).
    inferProviderFromModelName(normalize(identity.model)) ??
    // Last resort only, so a recognized family is never shadowed by its host.
    // Must mirror detectReasoningProvider's ordering: the two derive the same
    // provider for the same model, and a mismatch would key the live catalog
    // snapshot under one name while the capability lookup reads another.
    (isLocalModelApiBase(identity.apiBase || "") ? "local" : null) ??
    "unknown"
  );
}

function legacyReasoningProvider(
  provider: ModelCapabilityProvider,
): ReasoningProvider | null {
  if (
    provider === "openai" ||
    provider === "gemini" ||
    provider === "deepseek" ||
    provider === "kimi" ||
    provider === "mimo" ||
    provider === "qwen" ||
    provider === "grok" ||
    provider === "anthropic"
  ) {
    return provider;
  }
  return null;
}

function legacyReasoning(
  provider: ModelCapabilityProvider,
  model: string,
): ModelReasoningCapability {
  const legacyProviderName = legacyReasoningProvider(provider);
  if (
    !legacyProviderName ||
    !supportsReasoningForModel(legacyProviderName, model)
  ) {
    return { kind: "none", options: [] };
  }
  const options = getRuntimeReasoningOptionsForModel(legacyProviderName, model)
    .filter((option) => option.enabled)
    .map((option) => ({
      id: option.level,
      label: option.label || option.level,
      enabled: option.enabled,
    }));
  const defaultOptionId = options[0]?.id;
  return options.length
    ? {
        kind: options.length === 1 ? "fixed" : "select",
        options,
        defaultOptionId,
      }
    : { kind: "none", options: [] };
}

function legacyReasoningProfiles(
  provider: ModelCapabilityProvider,
  model: string,
): void {
  // Touching these profiles here keeps the adapter boundary explicit.  Their
  // detailed encoders remain in llmClient until all provider transports have
  // moved to declarative controls.
  if (provider === "openai" || provider === "grok")
    getOpenAIReasoningProfileForModel(model);
  if (provider === "gemini") getGeminiReasoningProfileForModel(model);
  if (provider === "anthropic") getAnthropicReasoningProfileForModel(model);
  if (provider === "qwen") getQwenReasoningProfileForModel(model);
  if (provider === "deepseek") getDeepseekReasoningProfileForModel(model);
  if (provider === "mimo") getMimoReasoningProfileForModel(model);
}

function buildCatalogKey(identity: ModelCapabilityIdentity): string {
  return [
    providerFromIdentity(identity),
    normalize(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
    normalize(identity.scope),
  ].join("\u0000");
}

function buildCatalogBaseKey(identity: ModelCapabilityIdentity): string {
  return [
    providerFromIdentity(identity),
    normalize(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
  ].join("\u0000");
}

function getCatalogSnapshot(
  identity: ModelCapabilityIdentity,
): CatalogSnapshot | undefined {
  const exact = catalogSnapshots.get(buildCatalogKey(identity));
  if (exact) return exact;
  const baseKey = buildCatalogBaseKey(identity);
  for (const [snapshotKey, snapshot] of catalogSnapshots) {
    if (snapshotKey.split("\u0000").slice(0, 4).join("\u0000") === baseKey) {
      return snapshot;
    }
  }
  return undefined;
}

function getLiveModel(
  identity: ModelCapabilityIdentity,
): DiscoveredModel | undefined {
  const models = getCatalogSnapshot(identity)?.models;
  if (!models) return undefined;
  return (
    models.find((model) => model.id === identity.model) ??
    models.find(
      (model) =>
        stripImplicitLatestTag(model.id) ===
        stripImplicitLatestTag(identity.model),
    )
  );
}

function mergeLimits(
  entry: RegistryModelEntry | null,
  live: DiscoveredModel | undefined,
): { limits: ModelCapabilityLimits; source?: CapabilitySource } {
  const entryLimits = entry?.limits;
  const liveLimits = live?.limits;
  const limits: ModelCapabilityLimits = {
    ...(entryLimits || {}),
    ...(liveLimits || {}),
  };
  if (liveLimits?.contextWindowTokens && liveLimits.inputTokens === undefined) {
    // A live catalog's current context window supersedes stale bundled input
    // rules when the provider does not expose a separate input limit.
    limits.inputTokens = liveLimits.contextWindowTokens;
  }
  const source: CapabilitySource | undefined = liveLimits
    ? "live"
    : entryLimits
      ? activeRegistrySource
      : undefined;
  return { limits, source };
}

/**
 * Off/On for a thinking-capable Ollama model.
 *
 * A boolean `think` is accepted by every thinking model Ollama serves, so this
 * is the one option set that is always safe. Graded levels (`"low"`…`"max"`)
 * are model-dependent and are deliberately not guessed — the user adds them in
 * the per-model parameter editor if their model supports them.
 */
function ollamaThinkOptions(): ModelReasoningCapability {
  return {
    kind: "select",
    defaultOptionId: "default",
    options: [
      {
        id: "minimal",
        label: "Off",
        enabled: true,
        controls: { body: { think: false } },
      },
      {
        id: "default",
        label: "On",
        enabled: true,
        controls: { body: { think: true } },
      },
    ],
  };
}

function mergeReasoning(
  provider: ModelCapabilityProvider,
  model: string,
  entry: RegistryModelEntry | null,
  live: DiscoveredModel | undefined,
  protocol?: string,
): { reasoning: ModelReasoningCapability; source: CapabilitySource } {
  const legacy = legacyReasoning(provider, model);
  legacyReasoningProfiles(provider, model);
  if (live?.reasoningSupported === false) {
    return { reasoning: { kind: "none", options: [] }, source: "live" };
  }
  // A recognized family may keep its level set, but never its request body,
  // when the model is served over Ollama's native protocol: `qwen3` there
  // needs `think`, never DashScope's `chat_template_kwargs`. This outranks
  // the registry entry and the legacy profiles alike — both are maintained
  // for hosted deployments, and neither may ship hosted encodings to a local
  // server. Whichever source says "this model reasons", the encoding is
  // Ollama's.
  if (
    protocol === "ollama_native" &&
    (live?.reasoningSupported || entry?.reasoning || legacy.options.length)
  ) {
    return {
      reasoning: ollamaThinkOptions(),
      source: live?.reasoningSupported
        ? "live"
        : entry?.reasoning
          ? activeRegistrySource
          : "legacy",
    };
  }
  if (entry?.reasoning) {
    return {
      reasoning: clone(entry.reasoning),
      source: live?.reasoningSupported ? "live" : activeRegistrySource,
    };
  }
  if (live?.reasoningSupported) {
    return {
      reasoning: legacy.options.length
        ? legacy
        : { kind: "server_default", options: [] },
      source: "live",
    };
  }
  return { reasoning: legacy, source: "legacy" };
}

function defaultInputs(
  provider: ModelCapabilityProvider,
): ResolvedModelCapabilities["inputs"] {
  return {
    text: true,
    image: true,
    video: provider === "gemini" || provider === "kimi",
    pdf: provider === "anthropic" || provider === "gemini",
  };
}

function defaultSampling(): ModelSamplingCapability {
  return {
    temperature: "configurable",
    minTemperature: 0,
    maxTemperature: 2,
  };
}

function loadPersistedRegistry(): void {
  if (persistedRegistryLoaded) return;
  persistedRegistryLoaded = true;
  const prefs = getZoteroPrefs();
  const raw = prefs?.get?.(REGISTRY_PREF_KEY, true);
  if (typeof raw !== "string" || !raw.trim()) return;
  try {
    const parsed = validateRegistry(JSON.parse(raw));
    if (parsed && parsed.revision >= activeRegistry.revision) {
      activeRegistry = parsed;
      activeRegistrySource = "remote";
    }
  } catch {
    // Ignore corrupt cached data and keep the bundled registry.
  }
}

export function configureModelCapabilityRuntime(next: CapabilityRuntime): void {
  runtime = { ...runtime, ...next };
}

function getRuntimeEnvironment(): CapabilityRuntime["environment"] {
  if (runtime.environment) return runtime.environment;
  try {
    return typeof __env__ === "string" ? __env__ : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Auth modes whose credentials or transports cannot use the generic
 * `/models` catalog fetch (dedicated token exchanges or no HTTP API at all).
 * Shared with the provider-group refresh so the boundary cannot drift.
 */
export const CATALOG_EXCLUDED_AUTH_MODES: ReadonlySet<string> = new Set([
  "codex_auth",
  "codex_app_server",
  "copilot_auth",
  "webchat",
]);

function canRunCapabilityPreflight(identity: ModelCatalogIdentity): boolean {
  const environment = getRuntimeEnvironment();
  if (environment !== "production" && environment !== "development") {
    return false;
  }
  if (!identity.model.trim() || !identity.apiBase?.trim()) return false;
  return !CATALOG_EXCLUDED_AUTH_MODES.has(normalize(identity.authMode));
}

/**
 * Best-effort first-use discovery. It never blocks a request for longer than
 * five seconds and failures deliberately leave the bundled/legacy fallback in
 * place. The underlying refresh may continue after the timeout so a later
 * request can use the completed snapshot.
 */
export async function ensureModelCapabilities(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions = {},
): Promise<void> {
  if (!canRunCapabilityPreflight(identity)) return;
  const requestedTimeout = Number(options.timeoutMs);
  const timeoutMs = Math.min(
    FIRST_USE_PREFLIGHT_TIMEOUT_MS,
    Number.isFinite(requestedTimeout) && requestedTimeout > 0
      ? Math.max(1, Math.floor(requestedTimeout))
      : FIRST_USE_PREFLIGHT_TIMEOUT_MS,
  );
  const key = buildCatalogKey(identity);
  loadPersistedRegistry();
  const registryProbe = !findRegistryEntry(
    activeRegistry,
    providerFromIdentity(identity),
    identity.model,
  );
  let task = capabilityPreflightTasks.get(key);
  if (!task) {
    task = Promise.allSettled([
      refreshModelCapabilityRegistry({ timeoutMs, force: registryProbe }),
      refreshModelCatalog(identity, { timeoutMs }),
    ]).then(() => undefined);
    capabilityPreflightTasks.set(key, task);
    void task.then(
      () => {
        if (capabilityPreflightTasks.get(key) === task)
          capabilityPreflightTasks.delete(key);
      },
      () => {
        if (capabilityPreflightTasks.get(key) === task)
          capabilityPreflightTasks.delete(key);
      },
    );
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      task,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function getModelCapabilities(
  identity: ModelCapabilityIdentity,
): ResolvedModelCapabilities {
  loadPersistedRegistry();
  const provider = providerFromIdentity(identity);
  const model = identity.model.trim();
  const entry = findRegistryEntry(activeRegistry, provider, model);
  const live = getLiveModel(identity);
  const mergedLimits = mergeLimits(entry, live);
  const mergedReasoning = mergeReasoning(
    provider,
    model,
    entry,
    live,
    identity.protocol,
  );
  const source: CapabilitySource = live
    ? "live"
    : entry
      ? activeRegistrySource
      : "legacy";
  const snapshot: ResolvedModelCapabilities = {
    identity: { ...identity, model },
    provider,
    model,
    limits: mergedLimits.limits,
    reasoning: mergedReasoning.reasoning,
    sampling: entry?.sampling
      ? { ...defaultSampling(), ...clone(entry.sampling) }
      : defaultSampling(),
    inputs: {
      ...defaultInputs(provider),
      ...(entry?.inputs || {}),
      ...(live?.inputs || {}),
    },
    features: {
      tools: true,
      streaming: true,
      promptCache: false,
      ...(entry?.features || {}),
      // A local server states plainly whether the loaded weights support tool
      // calling, which beats both the registry and the optimistic default.
      ...(live?.features || {}),
    },
    source,
    stale: Boolean(getCatalogSnapshot(identity)?.stale),
    resolvedAt: now(),
    provenance: {
      ...(mergedLimits.source ? { limits: mergedLimits.source } : {}),
      reasoning: mergedReasoning.source,
      ...(entry?.sampling ? { sampling: activeRegistrySource } : {}),
      ...(entry?.inputs || live?.inputs
        ? { inputs: live ? "live" : activeRegistrySource }
        : {}),
      ...(entry?.features || live?.features
        ? { features: live?.features ? "live" : activeRegistrySource }
        : {}),
    },
  };
  return applyProfileOverride(snapshot, identity.profileOverride);
}

/**
 * The user's word is final: an override sits above legacy, registry and live.
 *
 * Applied per section and only where the override actually states something,
 * so a user correcting one context window does not blank out everything the
 * server reported. Clearing a field removes it from the stored override
 * entirely (see `pruneProfileOverride`), which is what makes Reset
 * indistinguishable from never having edited. An override authored for a
 * different model (see `forModel`) is dormant, not applied — and not deleted.
 */
function applyProfileOverride(
  snapshot: ResolvedModelCapabilities,
  rawOverride: unknown,
): ResolvedModelCapabilities {
  const override = normalizeProfileOverride(rawOverride);
  if (!override) return snapshot;
  if (!profileOverrideAppliesTo(override, snapshot.identity.model)) {
    return snapshot;
  }
  const provenance = { ...snapshot.provenance };
  const next: ResolvedModelCapabilities = { ...snapshot };

  if (override.limits) {
    next.limits = { ...snapshot.limits, ...override.limits };
    provenance.limits = "user";
  }
  if (override.reasoning) {
    next.reasoning = clone(override.reasoning);
    provenance.reasoning = "user";
  }
  next.provenance = provenance;
  if (override.limits || override.reasoning) {
    next.source = "user";
  }
  return next;
}

export function compileReasoningControls(
  capabilities: ResolvedModelCapabilities,
  selection: { level?: string; effort?: string },
): { extra: Record<string, unknown>; omitTemperature: boolean } | null {
  const reasoning = capabilities.reasoning;
  const requested = normalize(selection.effort || selection.level);
  const explicitOption = reasoning.options.find(
    (candidate) => Boolean(requested) && normalize(candidate.id) === requested,
  );
  if (
    (reasoning.kind === "none" || reasoning.kind === "server_default") &&
    !explicitOption?.controls
  ) {
    return null;
  }
  if (!requested || requested === "auto") return null;
  const option =
    explicitOption ||
    (requested === "minimal"
      ? reasoning.options.find((candidate) => normalize(candidate.id) === "off")
      : undefined) ||
    (requested === "default"
      ? reasoning.options.find(
          (candidate) => candidate.id === reasoning.defaultOptionId,
        ) || reasoning.options[0]
      : undefined);
  const disabledOption =
    requested === "none" || requested === "off" || requested === "disabled";
  // A disabled selection may only emit controls its own option authored.
  // The capability-level patch is the *enable* payload, so inheriting it here
  // would turn reasoning on for the level the user picked to turn it off.
  const controls =
    option?.controls || (disabledOption ? undefined : reasoning.controls);
  if (
    !option ||
    (option.enabled === false && !(disabledOption && option.controls)) ||
    !controls
  ) {
    return null;
  }
  const patched = applyControlPatch({}, controls);
  removeControlRoots(patched, controls);
  // Capability data can come from persisted preferences as well as the
  // bundled/remote registry. Keep the request envelope authoritative even if
  // an older or hand-edited preference bypassed normalization.
  const extra = sanitizeUserRequestBody(patched) || {};
  return {
    extra,
    omitTemperature: Boolean(controls.omitTemperature),
  };
}

export function getRuntimeReasoningOptions(
  identity: ModelCapabilityIdentity,
): Array<{ level: string; label: string; enabled: boolean }> {
  const reasoning = getModelCapabilities(identity).reasoning;
  const options = [...reasoning.options].sort((left, right) => {
    if (left.id === reasoning.defaultOptionId) return -1;
    if (right.id === reasoning.defaultOptionId) return 1;
    return 0;
  });
  return options.map((option) => ({
    level: option.id,
    label: option.label,
    enabled: option.enabled !== false,
  }));
}

export function getModelOutputTokenLimit(
  model: string,
  identity?: Omit<ModelCapabilityIdentity, "model">,
): number {
  return (
    getModelCapabilities({ model, ...identity }).limits.outputTokens ||
    MAX_ALLOWED_TOKENS
  );
}

export function subscribeModelCapabilities(listener: () => void): () => void {
  capabilityListeners.add(listener);
  return () => capabilityListeners.delete(listener);
}

/** Publish model metadata obtained through a trusted provider-specific catalog. */
export function publishModelCapabilityCatalog(
  identity: ModelCapabilityIdentity,
  models: DiscoveredModel[],
): void {
  catalogSnapshots.set(buildCatalogKey(identity), {
    models: clone(models),
    fetchedAt: now(),
    stale: false,
  });
  notify();
}

function getRegistryFetchedAt(): number {
  const value = getZoteroPrefs()?.get?.(REGISTRY_TIMESTAMP_PREF_KEY, true);
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function persistRegistry(registry: typeof activeRegistry): void {
  try {
    const prefs = getZoteroPrefs();
    prefs?.set?.(REGISTRY_PREF_KEY, JSON.stringify(registry), true);
    prefs?.set?.(REGISTRY_TIMESTAMP_PREF_KEY, now(), true);
  } catch {
    // Persistence is an optimization; an unavailable preference service must
    // not discard a valid in-memory registry update.
  }
}

export async function refreshModelCapabilityRegistry(
  options: ModelCapabilityRefreshOptions = {},
): Promise<boolean> {
  loadPersistedRegistry();
  if (
    !options.force &&
    now() - getRegistryFetchedAt() < REGISTRY_REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  if (registryRefreshTask) return registryRefreshTask;
  registryRefreshTask = (async () => {
    const fetchFn = getFetch();
    if (!fetchFn) return false;
    const AbortControllerCtor = getAbortController();
    const controller = AbortControllerCtor
      ? new AbortControllerCtor()
      : undefined;
    const timer = controller
      ? setTimeout(
          () => controller.abort(),
          options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
        )
      : null;
    try {
      const response = await fetchFn(MODEL_CAPABILITY_REGISTRY_URL, {
        headers: { Accept: "application/json" },
        signal: controller?.signal,
      });
      if (!response.ok) return false;
      const text = await response.text();
      if (text.length > MODEL_CAPABILITY_REGISTRY_MAX_BYTES) return false;
      const parsed = validateRegistry(JSON.parse(text));
      if (!parsed || parsed.revision <= activeRegistry.revision) {
        persistRegistry(activeRegistry);
        return false;
      }
      activeRegistry = parsed;
      activeRegistrySource = "remote";
      persistRegistry(parsed);
      notify();
      return true;
    } catch {
      return false;
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  })();
  try {
    return await registryRefreshTask;
  } finally {
    registryRefreshTask = null;
  }
}

/**
 * Providers whose recommended chat base is an Anthropic-compatible proxy that
 * serves no `/models` route. Their OpenAI-compatible surface still lists
 * models (with plain Bearer auth), so catalog requests go there instead.
 */
const ANTHROPIC_COMPAT_CATALOG_ENDPOINTS: Partial<Record<string, string>> = {
  deepseek: "https://api.deepseek.com/models",
  glm: "https://open.bigmodel.cn/api/paas/v4/models",
  minimax: "https://api.minimax.io/v1/models",
};

function getAnthropicCompatCatalogEndpoint(
  identity: ModelCatalogIdentity,
): string | null {
  const override =
    ANTHROPIC_COMPAT_CATALOG_ENDPOINTS[providerFromIdentity(identity)];
  if (!override) return null;
  const base = normalize(identity.apiBase);
  return base.includes("anthropic") ? override : null;
}

function getCatalogEndpoint(identity: ModelCatalogIdentity): string | null {
  if (!identity.apiBase) return null;
  try {
    const url = new URL(identity.apiBase);
    const path = url.pathname.replace(/\/+$/, "");
    if (identity.protocol === "gemini_native") {
      url.pathname = (
        path.endsWith("/models") ? path : `${path || "/v1beta"}/models`
      ).replace(/\/\/+/g, "/");
      return url.toString();
    }
    if (path.endsWith("/models")) return url.toString();
    const marker = ["/chat/completions", "/responses", "/embeddings"].find(
      (suffix) => path.endsWith(suffix),
    );
    url.pathname = `${marker ? path.slice(0, -marker.length) : path}/models`
      .replace(/\/\/+/g, "/")
      .replace("https:/", "https://")
      .replace("http:/", "http://");
    return url.toString();
  } catch {
    return null;
  }
}

function parseDiscoveredModels(value: unknown): DiscoveredModel[] {
  const rawModels =
    value &&
    typeof value === "object" &&
    Array.isArray((value as { data?: unknown }).data)
      ? (value as { data: unknown[] }).data
      : value &&
          typeof value === "object" &&
          Array.isArray((value as { models?: unknown }).models)
        ? (value as { models: unknown[] }).models
        : [];
  const models: DiscoveredModel[] = [];
  for (const raw of rawModels) {
    if (models.length >= 4096) break;
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id && typeof row.name === "string")
      id = row.name.trim().replace(/^models\//, "");
    if (!id || id.length > 256) continue;
    // Local servers each name the context window differently:
    // LM Studio uses max_context_length / loaded_context_length, vLLM uses
    // max_model_len, and llama.cpp nests n_ctx / n_ctx_train under `meta`.
    const meta = (
      row.meta && typeof row.meta === "object" ? row.meta : {}
    ) as Record<string, unknown>;
    const context = Number(
      row.context_length ??
        row.context_window ??
        row.contextWindow ??
        row.max_context_length ??
        row.loaded_context_length ??
        row.max_model_len ??
        meta.n_ctx ??
        meta.n_ctx_train,
    );
    const input = Number(
      row.max_input_tokens ??
        row.maxInputTokens ??
        row.input_token_limit ??
        row.inputTokenLimit ??
        row.inputTokens,
    );
    const output = Number(
      row.max_output_tokens ??
        row.maxOutputTokens ??
        row.output_token_limit ??
        row.outputTokenLimit ??
        row.outputTokens,
    );
    const limits: ModelCapabilityLimits = {};
    if (
      Number.isSafeInteger(context) &&
      context > 0 &&
      context <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.contextWindowTokens = context;
    if (
      Number.isSafeInteger(input) &&
      input > 0 &&
      input <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.inputTokens = input;
    if (
      Number.isSafeInteger(output) &&
      output > 0 &&
      output <= MODEL_CAPABILITY_MAX_TOKEN_LIMIT
    )
      limits.outputTokens = output;
    const inputs: DiscoveredModel["inputs"] = {};
    const supportsImage =
      row.supports_image_in ?? row.supportsImageIn ?? row.supportsVision;
    const supportsVideo = row.supports_video_in ?? row.supportsVideoIn;
    if (typeof supportsImage === "boolean") inputs.image = supportsImage;
    if (typeof supportsVideo === "boolean") inputs.video = supportsVideo;
    const reasoningSupported =
      row.supports_reasoning ??
      row.supportsReasoning ??
      row.reasoning_supported ??
      row.reasoningSupported;
    models.push({
      id,
      ...(typeof row.owned_by === "string" ? { ownedBy: row.owned_by } : {}),
      ...(Number.isFinite(Number(row.created))
        ? { created: Number(row.created) }
        : {}),
      ...(Object.keys(limits).length ? { limits } : {}),
      ...(Object.keys(inputs).length ? { inputs } : {}),
      ...(typeof reasoningSupported === "boolean"
        ? { reasoningSupported }
        : {}),
      source: "live",
    });
  }
  return models;
}

export async function refreshModelCatalog(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions = {},
): Promise<DiscoveredModel[]> {
  const key = buildCatalogKey(identity);
  const cached = catalogSnapshots.get(key);
  if (
    cached &&
    !options.force &&
    now() - cached.fetchedAt < PROVIDER_CATALOG_TTL_MS
  ) {
    return cached.models;
  }
  // Coalesce concurrent refreshes: several UI rows can ask for the same
  // provider catalog in the same tick and must share one network request.
  const inFlight = catalogRefreshTasks.get(key);
  if (inFlight && !options.force) return inFlight;
  const task = fetchModelCatalog(identity, options, key, cached);
  catalogRefreshTasks.set(key, task);
  try {
    return await task;
  } finally {
    if (catalogRefreshTasks.get(key) === task) catalogRefreshTasks.delete(key);
  }
}

async function fetchModelCatalog(
  identity: ModelCatalogIdentity,
  options: ModelCapabilityRefreshOptions,
  key: string,
  cached: CatalogSnapshot | undefined,
): Promise<DiscoveredModel[]> {
  const fetchFn = getFetch();
  // Ollama's native metadata endpoints report the real context window plus
  // vision/tools/thinking, none of which its /v1/models mirror exposes.
  if (usesOllamaCatalog(identity.protocol) && fetchFn && identity.apiBase) {
    try {
      const models = await fetchOllamaCatalog({
        fetchFn,
        apiBase: identity.apiBase,
        apiKey: identity.apiKey,
        detailModel: identity.model,
        timeoutMs: options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
      });
      catalogSnapshots.set(key, { models, fetchedAt: now(), stale: false });
      notify();
      return models;
    } catch (error) {
      const snapshot: CatalogSnapshot = {
        models: cached?.models || [],
        fetchedAt: cached?.fetchedAt || 0,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
      catalogSnapshots.set(key, snapshot);
      return snapshot.models;
    }
  }
  const compatEndpoint = getAnthropicCompatCatalogEndpoint(identity);
  const endpoint = compatEndpoint || getCatalogEndpoint(identity);
  if (!endpoint || !fetchFn) return cached?.models || [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    const AbortControllerCtor = getAbortController();
    const controller = AbortControllerCtor
      ? new AbortControllerCtor()
      : undefined;
    timer = controller
      ? setTimeout(
          () => controller.abort(),
          options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS,
        )
      : null;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (identity.apiKey && identity.authMode !== "codex_auth") {
      if (identity.protocol === "gemini_native") {
        // Header auth keeps the key out of URLs (and any proxy/server logs).
        headers["x-goog-api-key"] = identity.apiKey;
      } else if (
        identity.protocol === "anthropic_messages" &&
        !compatEndpoint
      ) {
        headers["x-api-key"] = identity.apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${identity.apiKey}`;
      }
    }
    const response = await fetchFn(endpoint, {
      headers,
      signal: controller?.signal,
    });
    if (!response.ok)
      throw new Error(`catalog request failed: ${response.status}`);
    const models = parseDiscoveredModels(await response.json());
    catalogSnapshots.set(key, { models, fetchedAt: now(), stale: false });
    notify();
    return models;
  } catch (error) {
    const snapshot: CatalogSnapshot = {
      models: cached?.models || [],
      fetchedAt: cached?.fetchedAt || 0,
      stale: true,
      error: error instanceof Error ? error.message : String(error),
    };
    catalogSnapshots.set(key, snapshot);
    return snapshot.models;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function getDiscoveredModels(
  identity: ModelCapabilityIdentity,
): DiscoveredModel[] {
  return clone(catalogSnapshots.get(buildCatalogKey(identity))?.models || []);
}

export function getModelCatalogStatus(
  identity: ModelCapabilityIdentity,
): CatalogSnapshot | null {
  const snapshot = catalogSnapshots.get(buildCatalogKey(identity));
  return snapshot ? clone(snapshot) : null;
}

export async function refreshConfiguredModelCatalogs(
  identities: ModelCatalogIdentity[],
  options: ModelCapabilityRefreshOptions = {},
): Promise<void> {
  await Promise.allSettled(
    identities.map((identity) => refreshModelCatalog(identity, options)),
  );
}

export function resetModelCapabilityStateForTests(): void {
  activeRegistry = cloneRegistry(BUNDLED_MODEL_CAPABILITY_REGISTRY);
  activeRegistrySource = "bundled";
  persistedRegistryLoaded = false;
  registryRefreshTask = null;
  capabilityPreflightTasks.clear();
  catalogRefreshTasks.clear();
  catalogSnapshots.clear();
  runtime = {};
}

export function setModelCapabilityRegistryForTests(value: unknown): boolean {
  const parsed = validateRegistry(value);
  if (!parsed) return false;
  activeRegistry = parsed;
  activeRegistrySource = "remote";
  notify();
  return true;
}

export function getActiveModelCapabilityRegistryForTests(): typeof activeRegistry {
  return clone(activeRegistry);
}
