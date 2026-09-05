/**
 * Normalized model capability contracts.
 *
 * This module intentionally contains data-only types.  Provider adapters and
 * the registry service live in sibling modules so request code can consume a
 * stable capability snapshot without knowing where it came from.
 */

export type ModelCapabilityProvider =
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
  /**
   * A model served by a local runtime whose name matches no hosted family.
   * Marks *where* the model is served, never overriding a recognized family —
   * `deepseek-r1:8b` on Ollama is still DeepSeek's weights.
   */
  | "local"
  | "customized"
  | "unknown";

export type ModelCapabilityIdentity = {
  model: string;
  provider?: string;
  apiBase?: string;
  protocol?: string;
  authMode?: string;
  /** Runtime scope, for example a Claude bridge profile signature. */
  scope?: string;
  /**
   * User-authored overrides for this model, applied on top of every detected
   * source. Carried on the identity so capability resolution stays a pure
   * function of its argument rather than reaching into preferences.
   */
  profileOverride?: unknown;
};

export type ModelCapabilityLimits = {
  /** Provider-declared total context window, when known. */
  contextWindowTokens?: number;
  /** Provider-declared maximum input tokens, when distinct from context. */
  inputTokens?: number;
  /** Provider-declared maximum output tokens, when known. */
  outputTokens?: number;
  /** True when the provider describes inputTokens as the active context. */
  inputLimitIsAuthoritative?: boolean;
};

export type ReasoningCapabilityKind =
  | "none"
  | "server_default"
  | "toggle"
  | "fixed"
  | "select";

export type ModelControlPatch = {
  /** JSON-safe patch merged into the request body. */
  body?: Record<string, unknown>;
  /** Optional body keys that must be omitted for this option. */
  omit?: string[];
  /** Whether this option requires the sampling temperature to be omitted. */
  omitTemperature?: boolean;
};

export type ReasoningCapabilityOption = {
  /** Opaque provider value. It may be a newly introduced value such as ultra. */
  id: string;
  label: string;
  enabled?: boolean;
  controls?: ModelControlPatch;
};

export type ModelReasoningCapability = {
  kind: ReasoningCapabilityKind;
  options: ReasoningCapabilityOption[];
  defaultOptionId?: string;
  controls?: ModelControlPatch;
};

export type ModelSamplingCapability = {
  temperature: "configurable" | "fixed" | "unsupported";
  minTemperature?: number;
  maxTemperature?: number;
  omitWhenReasoning?: boolean;
};

export type ModelInputCapabilities = {
  text: boolean;
  image: boolean;
  video: boolean;
  pdf: boolean;
};

export type ModelFeatureCapabilities = {
  tools: boolean;
  streaming: boolean;
  promptCache: boolean;
};

export type CapabilitySource =
  | "user"
  | "live"
  | "remote"
  | "bundled"
  | "legacy";

export type ResolvedModelCapabilities = {
  identity: ModelCapabilityIdentity;
  provider: ModelCapabilityProvider;
  model: string;
  limits: ModelCapabilityLimits;
  reasoning: ModelReasoningCapability;
  sampling: ModelSamplingCapability;
  inputs: ModelInputCapabilities;
  features: ModelFeatureCapabilities;
  source: CapabilitySource;
  stale: boolean;
  resolvedAt: number;
  provenance: Partial<
    Record<
      "limits" | "reasoning" | "sampling" | "inputs" | "features",
      CapabilitySource
    >
  >;
};

export type RegistryMatch = {
  provider?: string;
  exact?: string;
  prefix?: string;
};

export type RegistryModelEntry = {
  match: RegistryMatch;
  displayName?: string;
  limits?: ModelCapabilityLimits;
  reasoning?: ModelReasoningCapability;
  sampling?: ModelSamplingCapability;
  inputs?: Partial<ModelInputCapabilities>;
  features?: Partial<ModelFeatureCapabilities>;
};

export type ModelCapabilityRegistry = {
  schemaVersion: 1;
  revision: number;
  models: RegistryModelEntry[];
};

export type DiscoveredModel = {
  id: string;
  ownedBy?: string;
  created?: number;
  limits?: ModelCapabilityLimits;
  inputs?: Partial<ModelInputCapabilities>;
  /** Server-declared feature support, e.g. Ollama's `capabilities: ["tools"]`. */
  features?: Partial<ModelFeatureCapabilities>;
  reasoningSupported?: boolean;
  displayName?: string;
  source: "live";
};

export type ModelCatalogIdentity = ModelCapabilityIdentity & {
  apiKey?: string;
};

export type ModelCapabilityRefreshOptions = {
  force?: boolean;
  timeoutMs?: number;
};
