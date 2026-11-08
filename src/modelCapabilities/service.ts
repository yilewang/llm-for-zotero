import {
  getAnthropicReasoningProfileForModel,
  getDeepseekReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
  getMimoReasoningProfileForModel,
  getOpenAIReasoningProfileForModel,
  getQwenReasoningProfileForModel,
  getRuntimeReasoningOptionsForModel,
  supportsReasoningForModel,
  hasKnownReasoningProfile,
  type ReasoningProvider,
} from "../utils/reasoningProfiles";
import { MAX_ALLOWED_TOKENS } from "../utils/llmDefaults";
import { isTextOnlyModel } from "../providers/modelChecks";
import { BUNDLED_MODEL_CAPABILITY_REGISTRY } from "./bundled";
import {
  readModelCapabilityRegistryCache,
  writeModelCapabilityRegistryCache,
} from "./registryCache";
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
import {
  detectProviderPreset,
  isLocalModelApiBase,
} from "../utils/providerPresets";
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
  validateReasoning,
} from "./registry";
import {
  classifyModelDiscoveryHttpError,
  getModelDiscoveryAdapter,
  hasModelDiscoveryAdapter,
  isDiscoveredChatModel,
  MODEL_DISCOVERY_CACHE_TTL_MS,
  type ModelDiscoveryErrorCode,
} from "./modelDiscovery";
import type {
  CapabilitySource,
  DiscoveredModel,
  ModelCapabilityIdentity,
  ModelCapabilityLimits,
  ModelCapabilityProvider,
  ModelCapabilityRefreshOptions,
  ModelCatalogIdentity,
  ModelCatalogStatus,
  ModelControlPatch,
  ModelReasoningCapability,
  ModelReasoningSelection,
  ModelSamplingCapability,
  RegistryModelEntry,
  ResolvedModelCapabilities,
} from "./types";

const REGISTRY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const PROVIDER_CATALOG_TTL_MS = 60 * 1000;
// A failed fetch marks its snapshot stale, and stale snapshots bypass the TTL.
// Without a retry floor every caller (each model-menu rebuild, each notify)
// starts another request to an unreachable server.
const FAILED_REFRESH_RETRY_MS = 60 * 1000;
// A user may start a local server right after a failed catalog fetch, so
// the catalog retries sooner than the registry.
const FAILED_CATALOG_RETRY_MS = 10 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 10_000;
const FIRST_USE_PREFLIGHT_TIMEOUT_MS = 5_000;

function getCatalogTtlMs(identity: ModelCatalogIdentity): number {
  return hasModelDiscoveryAdapter(identity)
    ? MODEL_DISCOVERY_CACHE_TTL_MS
    : PROVIDER_CATALOG_TTL_MS;
}

type CatalogSnapshot = ModelCatalogStatus;

type CapabilityRuntime = {
  fetch?: typeof fetch;
  now?: () => number;
  /** Test/development override for the bundled environment guard. */
  environment?: "production" | "development" | "test";
};

let runtime: CapabilityRuntime = {};
let activeRegistry = cloneRegistry(BUNDLED_MODEL_CAPABILITY_REGISTRY);
let activeRegistrySource: CapabilitySource = "bundled";
let registryLoadTask: Promise<void> | null = null;
let registryFetchedAt = 0;
/** Last registry fetch that failed to reach the server (0: none). */
let registryFailedAt = 0;
let registryRefreshTask: Promise<boolean> | null = null;
const capabilityPreflightTasks = new Map<string, Promise<void>>();
const catalogRefreshTasks = new Map<string, Promise<DiscoveredModel[]>>();
const catalogFetchGenerations = new Map<string, number>();
let nextCatalogFetchGeneration = 0;
const catalogSnapshots = new Map<string, CatalogSnapshot>();
const catalogAttemptedAt = new Map<string, number>();
const capabilityListeners = new Set<() => void>();

function now(): number {
  return runtime.now?.() || Date.now();
}

function normalize(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeApiBase(value: unknown): string {
  return normalize(value).replace(/\/+$/, "");
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
  if (
    explicit &&
    explicit !== "customized" &&
    explicit !== "unknown" &&
    explicit !== "siliconflow"
  ) {
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
    (explicit === "siliconflow" ||
    detectProviderPreset(identity.apiBase || "") === "siliconflow"
      ? "siliconflow"
      : null) ??
    "unknown"
  );
}

function catalogProviderFromIdentity(
  identity: ModelCapabilityIdentity,
): ModelCapabilityProvider {
  const discoveryAdapter = getModelDiscoveryAdapter(identity);
  if (discoveryAdapter) {
    return discoveryAdapter.providerId as ModelCapabilityProvider;
  }
  return providerFromIdentity(identity);
}

/**
 * The reasoning-profile family a capability provider maps onto, or null when
 * the provider has no hand-maintained profile. Exported because the request
 * builder and its preview must agree on this mapping.
 */
export function toReasoningProvider(
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
    provider === "minimax" ||
    provider === "glm" ||
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
  const legacyProviderName = toReasoningProvider(provider);
  if (
    !legacyProviderName ||
    !hasKnownReasoningProfile(legacyProviderName, model)
  ) {
    return { kind: "unknown", options: [] };
  }
  if (!supportsReasoningForModel(legacyProviderName, model)) {
    return { kind: "none", options: [] };
  }
  const options: ModelReasoningCapability["options"] =
    getRuntimeReasoningOptionsForModel(legacyProviderName, model)
      .filter((option) => option.enabled)
      .map((option) => ({
        id: option.level,
        label: option.label || option.level,
        enabled: option.enabled,
      }));
  if (
    provider === "anthropic" &&
    getAnthropicReasoningProfileForModel(model).supportsDisabledThinking
  ) {
    options.push({
      id: "none",
      label: "Off",
      controls: { body: { thinking: { type: "disabled" } } },
    });
  }
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

function normalizeApiKey(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function buildCatalogKey(identity: ModelCatalogIdentity): string {
  return [
    catalogProviderFromIdentity(identity),
    normalizeApiBase(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
    normalize(identity.scope),
    normalizeApiKey(identity.apiKey),
  ].join("\u0000");
}

function buildCatalogBaseKey(identity: ModelCapabilityIdentity): string {
  return [
    catalogProviderFromIdentity(identity),
    normalizeApiBase(identity.apiBase),
    normalize(identity.protocol),
    normalize(identity.authMode),
  ].join("\u0000");
}

function isSameCatalogConfiguration(
  existingKey: string,
  identity: ModelCatalogIdentity,
): boolean {
  const parts = existingKey.split("\u0000");
  const reqScope = normalize(identity.scope);
  const existingScope = parts[4] || "";
  if (existingScope !== reqScope) {
    return false;
  }
  if (reqScope) {
    return true;
  }
  const baseKey = buildCatalogBaseKey(identity);
  const normalizedBase = normalizeApiBase(identity.apiBase);
  const endpointTail = normalizedBase
    ? [
        normalizedBase,
        normalize(identity.protocol),
        normalize(identity.authMode),
      ].join("\u0000")
    : "";
  const existingBaseKey = parts.slice(0, 4).join("\u0000");
  const existingEndpointTail = parts.slice(1, 4).join("\u0000");
  return (
    existingBaseKey === baseKey ||
    Boolean(endpointTail && existingEndpointTail === endpointTail)
  );
}

/** Stores the snapshot; true when what readers can see changed. */
function setCatalogSnapshot(
  key: string,
  identity: ModelCatalogIdentity,
  snapshot: CatalogSnapshot,
): boolean {
  let changed = false;
  for (const existingKey of Array.from(catalogSnapshots.keys())) {
    if (existingKey === key) continue;
    if (isSameCatalogConfiguration(existingKey, identity)) {
      catalogSnapshots.delete(existingKey);
      changed = true;
    }
  }
  const previous = catalogSnapshots.get(key);
  catalogSnapshots.set(key, snapshot);
  return changed || !isSameCatalogContent(previous, snapshot);
}

// fetchedAt alone is not a material change: listeners rebuild open menus and
// settings editors, and a refetch that returns the same list (or fails the
// same way again) must not make them repaint.
function isSameCatalogContent(
  previous: CatalogSnapshot | undefined,
  next: CatalogSnapshot,
): boolean {
  if (!previous) return false;
  return (
    previous.stale === next.stale &&
    previous.error === next.error &&
    previous.errorCode === next.errorCode &&
    JSON.stringify(previous.models) === JSON.stringify(next.models)
  );
}

/** setCatalogSnapshot, then notify listeners only on a material change. */
function publishCatalogSnapshot(
  key: string,
  identity: ModelCatalogIdentity,
  snapshot: CatalogSnapshot,
): void {
  if (setCatalogSnapshot(key, identity, snapshot)) notify();
}

function getCatalogSnapshot(
  identity: ModelCatalogIdentity,
): CatalogSnapshot | undefined {
  const exact = catalogSnapshots.get(buildCatalogKey(identity));
  if (exact) return exact;
  const reqProtocol = normalize(identity.protocol);
  const reqAuthMode = normalize(identity.authMode);
  const reqScope = normalize(identity.scope);
  const hasExplicitApiKey = identity.apiKey !== undefined;
  const reqApiKey = normalizeApiKey(identity.apiKey);
  const matchesSnapshotKey = (snapshotKey: string): boolean => {
    const parts = snapshotKey.split("\u0000");
    const snapshotProtocol = parts[2] || "";
    const snapshotAuthMode = parts[3] || "";
    const snapshotScope = parts[4] || "";
    const snapshotApiKey = parts[5] || "";
    if (reqProtocol && snapshotProtocol && snapshotProtocol !== reqProtocol) {
      return false;
    }
    if (reqAuthMode && snapshotAuthMode && snapshotAuthMode !== reqAuthMode) {
      return false;
    }
    if (reqScope && snapshotScope && snapshotScope !== reqScope) {
      return false;
    }
    if (hasExplicitApiKey && snapshotApiKey !== reqApiKey) {
      return false;
    }
    return true;
  };
  const entriesNewestFirst = Array.from(catalogSnapshots.entries()).reverse();
  const baseKey = buildCatalogBaseKey(identity);
  for (const [snapshotKey, snapshot] of entriesNewestFirst) {
    if (!matchesSnapshotKey(snapshotKey)) continue;
    if (snapshotKey.split("\u0000").slice(0, 4).join("\u0000") === baseKey) {
      return snapshot;
    }
  }
  const catalogProvider = catalogProviderFromIdentity(identity);
  const normalizedBase = normalizeApiBase(identity.apiBase);
  for (const [snapshotKey, snapshot] of entriesNewestFirst) {
    if (!matchesSnapshotKey(snapshotKey)) continue;
    const parts = snapshotKey.split("\u0000");
    if (parts[0] === catalogProvider && parts[1] === normalizedBase) {
      return snapshot;
    }
  }
  if (normalizedBase) {
    for (const [snapshotKey, snapshot] of entriesNewestFirst) {
      if (!matchesSnapshotKey(snapshotKey)) continue;
      const parts = snapshotKey.split("\u0000");
      if (parts[1] === normalizedBase) {
        return snapshot;
      }
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
  if (live?.reasoning && protocol !== "ollama_native") {
    return { reasoning: clone(live.reasoning), source: "live" };
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
      source: activeRegistrySource,
    };
  }
  if (live?.reasoningSupported) {
    return {
      reasoning: legacy.options.length
        ? legacy
        : { kind: "server_default", options: [] },
      source: legacy.options.length ? "legacy" : "live",
    };
  }
  return { reasoning: legacy, source: "legacy" };
}

function defaultInputs(
  provider: ModelCapabilityProvider,
  model: string,
): ResolvedModelCapabilities["inputs"] {
  return {
    text: true,
    image: !isTextOnlyModel(model),
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

/** Load local metadata before mounting model controls; never fetches remotely. */
export function initializeModelCapabilityRegistry(): Promise<void> {
  if (!registryLoadTask) {
    registryLoadTask = (async () => {
      const cached = await readModelCapabilityRegistryCache(now());
      if (!cached) return;
      registryFetchedAt = cached.fetchedAt;
      if (cached.registry.revision >= activeRegistry.revision) {
        activeRegistry = cached.registry;
        activeRegistrySource = "remote";
        notify();
      }
    })();
  }
  return registryLoadTask;
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
  let task = capabilityPreflightTasks.get(key);
  if (!task) {
    task = (async () => {
      await initializeModelCapabilityRegistry();
      const registryProbe = !findRegistryEntry(
        activeRegistry,
        providerFromIdentity(identity),
        identity.model,
      );
      const preflightTasks: Array<Promise<unknown>> = [
        refreshModelCapabilityRegistry({ timeoutMs, force: registryProbe }),
      ];
      if (!hasModelDiscoveryAdapter(identity)) {
        preflightTasks.push(refreshModelCatalog(identity, { timeoutMs }));
      }
      await Promise.allSettled(preflightTasks);
    })();
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
      ...defaultInputs(provider, model),
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
  const resolved = resolveModelReasoningSelection(capabilities, selection);
  if (resolved.kind === "auto") return null;
  const option = resolved.option;
  if (option.effort) {
    const responses =
      capabilities.identity.protocol === "responses_api" ||
      capabilities.identity.protocol === "codex_responses";
    return {
      extra: responses
        ? { reasoning: { effort: option.effort } }
        : { reasoning_effort: option.effort },
      omitTemperature:
        capabilities.sampling.temperature !== "configurable" ||
        capabilities.provider === "openai",
    };
  }
  const requested = normalize(option.id);
  const disabledOption =
    requested === "none" || requested === "off" || requested === "disabled";
  // A disabled selection may only emit controls its own option authored.
  // The capability-level patch is the *enable* payload, so inheriting it here
  // would turn reasoning on for the level the user picked to turn it off.
  const controls =
    option?.controls || (disabledOption ? undefined : reasoning.controls);
  if (!controls) {
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
    // A model that rejects temperature rejects it whatever the option says.
    omitTemperature:
      Boolean(controls.omitTemperature) ||
      capabilities.sampling.temperature !== "configurable",
  };
}

/** Validate once for menus, saved preferences, and every request encoder. */
export function resolveModelReasoningSelection(
  capabilities: ResolvedModelCapabilities,
  selection?: { level?: string; effort?: string },
): ModelReasoningSelection {
  const requested = normalize(selection?.effort || selection?.level);
  if (!requested || requested === "auto") return { kind: "auto" };
  const exact = capabilities.reasoning.options.find(
    (candidate) =>
      candidate.enabled !== false && normalize(candidate.id) === requested,
  );
  const option =
    exact ||
    capabilities.reasoning.options.find(
      (candidate) =>
        candidate.enabled !== false &&
        ((requested === "minimal" &&
          candidate.id === "off" &&
          Boolean(candidate.controls)) ||
          (requested === "default" &&
            capabilities.provider !== "openai" &&
            capabilities.provider !== "grok" &&
            candidate.id === capabilities.reasoning.defaultOptionId)),
    );
  if (
    !option ||
    !isOptionProtocolSupported(option, capabilities) ||
    isProviderDefaultOption(option, capabilities)
  )
    return { kind: "auto" };
  return { kind: "option", option };
}

function isOptionProtocolSupported(
  option: ModelReasoningCapability["options"][number],
  capabilities: ResolvedModelCapabilities,
): boolean {
  return (
    !option.effort ||
    !capabilities.identity.protocol ||
    ["responses_api", "openai_chat_compat", "codex_responses"].includes(
      capabilities.identity.protocol,
    )
  );
}

function isProviderDefaultOption(
  option: ModelReasoningCapability["options"][number],
  capabilities: ResolvedModelCapabilities,
): boolean {
  return (
    option.id === "default" &&
    !option.controls &&
    !option.effort &&
    !capabilities.reasoning.controls &&
    capabilities.provenance.reasoning === "legacy" &&
    (capabilities.provider === "openai" || capabilities.provider === "grok")
  );
}

export function getModelReasoningChoices(
  capabilities: ResolvedModelCapabilities,
) {
  if (capabilities.reasoning.kind === "none") return [];
  return [
    { level: "auto", label: "Auto", enabled: true },
    ...capabilities.reasoning.options
      .filter(
        (option) =>
          option.id !== "auto" &&
          isOptionProtocolSupported(option, capabilities) &&
          !isProviderDefaultOption(option, capabilities),
      )
      .map((option) => ({
        level: option.id,
        label: option.label,
        enabled: option.enabled !== false,
      })),
  ];
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

async function persistRegistry(): Promise<void> {
  // Retain freshness in memory even if the disk is temporarily unwritable.
  registryFetchedAt = now();
  await writeModelCapabilityRegistryCache({
    schemaVersion: 1,
    registry: activeRegistry,
    fetchedAt: registryFetchedAt,
  });
}

export async function refreshModelCapabilityRegistry(
  options: ModelCapabilityRefreshOptions = {},
): Promise<boolean> {
  await initializeModelCapabilityRegistry();
  if (
    !options.force &&
    registryFetchedAt > 0 &&
    now() - registryFetchedAt < REGISTRY_REFRESH_INTERVAL_MS
  ) {
    return false;
  }
  if (registryRefreshTask) return registryRefreshTask;
  if (
    !options.force &&
    registryFailedAt > 0 &&
    now() - registryFailedAt < FAILED_REFRESH_RETRY_MS
  ) {
    return false;
  }
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
      if (!response.ok) {
        registryFailedAt = now();
        return false;
      }
      registryFailedAt = 0;
      const text = await response.text();
      if (text.length > MODEL_CAPABILITY_REGISTRY_MAX_BYTES) return false;
      const parsed = validateRegistry(JSON.parse(text));
      if (!parsed) return false;
      if (parsed.revision <= activeRegistry.revision) {
        await persistRegistry();
        return false;
      }
      activeRegistry = parsed;
      activeRegistrySource = "remote";
      await persistRegistry();
      notify();
      return true;
    } catch {
      registryFailedAt = now();
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

class CatalogFetchError extends Error {
  readonly code: ModelDiscoveryErrorCode;

  constructor(code: ModelDiscoveryErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function getCatalogEndpoint(identity: ModelCatalogIdentity): string | null {
  const discoveryAdapter = getModelDiscoveryAdapter(identity);
  if (discoveryAdapter) {
    try {
      return discoveryAdapter.buildEndpoint(identity.apiBase || "");
    } catch {
      return null;
    }
  }
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
    if (!path.endsWith("/models")) {
      const marker = ["/chat/completions", "/responses", "/embeddings"].find(
        (suffix) => path.endsWith(suffix),
      );
      url.pathname = `${marker ? path.slice(0, -marker.length) : path}/models`
        .replace(/\/\/+/g, "/")
        .replace("https:/", "https://")
        .replace("http:/", "http://");
    }
    return url.toString();
  } catch {
    return null;
  }
}

function parseDiscoveredModels(
  value: unknown,
  options?: { filterChatModels?: boolean },
): DiscoveredModel[] {
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
  const seen = new Set<string>();
  for (const raw of rawModels) {
    if (models.length >= 4096) break;
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    let id = typeof row.id === "string" ? row.id.trim() : "";
    if (!id && typeof row.name === "string")
      id = row.name.trim().replace(/^models\//, "");
    if (!id || id.length > 256 || seen.has(id)) continue;
    if (options?.filterChatModels && !isDiscoveredChatModel(row, id)) continue;
    seen.add(id);
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
      ...(validateReasoning(row.reasoning)
        ? { reasoning: clone(row.reasoning) }
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
  const ttlMs = getCatalogTtlMs(identity);
  if (
    cached &&
    !options.force &&
    !cached.stale &&
    now() - cached.fetchedAt < ttlMs
  ) {
    return cached.models;
  }
  if (
    cached?.stale &&
    !options.force &&
    now() - (catalogAttemptedAt.get(key) ?? 0) < FAILED_CATALOG_RETRY_MS
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
  const generation = ++nextCatalogFetchGeneration;
  catalogAttemptedAt.set(key, now());
  for (const existingKey of Array.from(catalogFetchGenerations.keys())) {
    if (
      existingKey === key ||
      isSameCatalogConfiguration(existingKey, identity)
    ) {
      catalogFetchGenerations.set(existingKey, generation);
    }
  }
  catalogFetchGenerations.set(key, generation);
  const isCurrentGeneration = () =>
    catalogFetchGenerations.get(key) === generation;

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
      if (isCurrentGeneration()) {
        publishCatalogSnapshot(key, identity, {
          models,
          fetchedAt: now(),
          stale: false,
        });
      }
      return models;
    } catch (error) {
      const snapshot: CatalogSnapshot = {
        models: cached?.models || [],
        fetchedAt: cached?.fetchedAt || 0,
        stale: true,
        error: error instanceof Error ? error.message : String(error),
      };
      if (isCurrentGeneration()) {
        setCatalogSnapshot(key, identity, snapshot);
      }
      return snapshot.models;
    }
  }
  const discoveryAdapter = getModelDiscoveryAdapter(identity);
  if (discoveryAdapter && !normalizeApiKey(identity.apiKey)) {
    const snapshot: CatalogSnapshot = {
      models: cached?.models || [],
      fetchedAt: cached?.fetchedAt || 0,
      stale: true,
      errorCode: "missing_api_key",
      error: "Enter the API key above to fetch this provider's models.",
    };
    if (isCurrentGeneration()) {
      publishCatalogSnapshot(key, identity, snapshot);
    }
    return snapshot.models;
  }
  const compatEndpoint = getAnthropicCompatCatalogEndpoint(identity);
  const endpoint = compatEndpoint || getCatalogEndpoint(identity);
  if (!endpoint) {
    if (discoveryAdapter) {
      const snapshot: CatalogSnapshot = {
        models: cached?.models || [],
        fetchedAt: cached?.fetchedAt || 0,
        stale: true,
        errorCode: "network_error",
        error: "Invalid API URL for models endpoint.",
      };
      if (isCurrentGeneration()) {
        publishCatalogSnapshot(key, identity, snapshot);
      }
      return snapshot.models;
    }
    return cached?.models || [];
  }
  if (!fetchFn) return cached?.models || [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let timedOut = false;
  let controller: AbortController | undefined;
  try {
    const AbortControllerCtor = getAbortController();
    controller = AbortControllerCtor ? new AbortControllerCtor() : undefined;
    const timeoutMs = options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS;
    const headers: Record<string, string> = { Accept: "application/json" };
    if (identity.apiKey && identity.authMode !== "codex_auth") {
      if (identity.protocol === "gemini_native") {
        // Header auth keeps the key out of URLs (and any proxy/server logs).
        headers["x-goog-api-key"] = identity.apiKey.trim();
      } else if (
        identity.protocol === "anthropic_messages" &&
        !compatEndpoint
      ) {
        headers["x-api-key"] = identity.apiKey.trim();
        headers["anthropic-version"] = "2023-06-01";
      } else {
        headers.Authorization = `Bearer ${identity.apiKey.trim()}`;
      }
    }
    const response = await new Promise<Response>((resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        const abortErr = new Error("Request timed out while fetching models.");
        abortErr.name = "AbortError";
        reject(abortErr);
      }, timeoutMs);
      fetchFn(endpoint, {
        headers,
        signal: controller?.signal,
      }).then(resolve, reject);
    });
    if (!response.ok) {
      const classified = classifyModelDiscoveryHttpError(response.status);
      throw new CatalogFetchError(classified.code, classified.message);
    }
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new CatalogFetchError(
        "invalid_json",
        "Invalid JSON response from models endpoint.",
      );
    }
    if (
      discoveryAdapter &&
      (!payload ||
        typeof payload !== "object" ||
        !Array.isArray((payload as { data?: unknown }).data))
    ) {
      throw new CatalogFetchError(
        "invalid_json",
        "Invalid JSON response from models endpoint.",
      );
    }
    const parsedModels = parseDiscoveredModels(payload, {
      filterChatModels: Boolean(discoveryAdapter),
    });
    const models = discoveryAdapter
      ? discoveryAdapter.filterAndSortModels(parsedModels)
      : parsedModels;
    if (discoveryAdapter && models.length === 0) {
      const emptySnapshot: CatalogSnapshot = {
        models: [],
        fetchedAt: 0,
        stale: true,
        errorCode: "empty_list",
        error: "No available chat models returned by provider.",
      };
      if (isCurrentGeneration()) {
        publishCatalogSnapshot(key, identity, emptySnapshot);
        return [];
      }
      return catalogSnapshots.get(key)?.models || [];
    }
    if (isCurrentGeneration()) {
      publishCatalogSnapshot(key, identity, {
        models,
        fetchedAt: now(),
        stale: false,
      });
      return models;
    }
    return catalogSnapshots.get(key)?.models || models;
  } catch (error) {
    const isTimeout =
      timedOut ||
      Boolean(controller?.signal?.aborted) ||
      (error instanceof Error &&
        (error.name === "AbortError" ||
          /abort|timed?\s*out/i.test(error.message)));
    const errorCode: ModelDiscoveryErrorCode = isTimeout
      ? "timeout"
      : error instanceof CatalogFetchError
        ? error.code
        : "network_error";
    const errorMessage = isTimeout
      ? "Request timed out while fetching models."
      : error instanceof Error
        ? error.message
        : String(error);
    const snapshot: CatalogSnapshot = {
      models: cached?.models || [],
      fetchedAt: cached?.fetchedAt || 0,
      stale: true,
      errorCode,
      error: errorMessage,
    };
    if (isCurrentGeneration()) {
      publishCatalogSnapshot(key, identity, snapshot);
      return snapshot.models;
    }
    return catalogSnapshots.get(key)?.models || snapshot.models;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

export function invalidateModelCatalog(identity: ModelCatalogIdentity): void {
  const invalidationGeneration = ++nextCatalogFetchGeneration;
  for (const existingKey of Array.from(catalogFetchGenerations.keys())) {
    if (isSameCatalogConfiguration(existingKey, identity)) {
      catalogFetchGenerations.set(existingKey, invalidationGeneration);
    }
  }
  let removed = false;
  for (const existingKey of Array.from(catalogSnapshots.keys())) {
    if (isSameCatalogConfiguration(existingKey, identity)) {
      catalogSnapshots.delete(existingKey);
      removed = true;
    }
  }
  if (removed) {
    notify();
  }
}

export function getDiscoveredModels(
  identity: ModelCatalogIdentity,
): DiscoveredModel[] {
  const snapshot =
    catalogSnapshots.get(buildCatalogKey(identity)) ??
    getCatalogSnapshot(identity);
  return clone(snapshot?.models || []);
}

export function getModelCatalogStatus(
  identity: ModelCatalogIdentity,
): CatalogSnapshot | null {
  const snapshot =
    catalogSnapshots.get(buildCatalogKey(identity)) ??
    getCatalogSnapshot(identity);
  return snapshot ? clone(snapshot) : null;
}

export function isModelCatalogExpired(identity: ModelCatalogIdentity): boolean {
  const snapshot =
    catalogSnapshots.get(buildCatalogKey(identity)) ??
    getCatalogSnapshot(identity);
  if (!snapshot || snapshot.stale || snapshot.fetchedAt <= 0) return true;
  return now() - snapshot.fetchedAt >= getCatalogTtlMs(identity);
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
  registryLoadTask = null;
  registryFetchedAt = 0;
  registryFailedAt = 0;
  registryRefreshTask = null;
  capabilityPreflightTasks.clear();
  catalogRefreshTasks.clear();
  catalogFetchGenerations.clear();
  nextCatalogFetchGeneration = 0;
  catalogSnapshots.clear();
  catalogAttemptedAt.clear();
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
