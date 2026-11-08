import {
  isReasoningLevelActive,
  parseStatusFromErrorMessage,
  requireCompleteModelText,
  type ChatParams,
  type ReasoningConfig,
} from "./llmClient";
import { resolveOutputRequestPolicy } from "./outputTokenPolicy";
import type { ModelProviderAuthMode } from "./modelProviders";
import {
  inferLegacyProviderProtocol,
  type ProviderProtocol,
} from "./providerProtocol";
import {
  getModelCapabilities,
  type ModelCapabilityProvider,
  type ModelProfileOverride,
  type ModelReasoningCapability,
  type ReasoningCapabilityOption,
  type ResolvedModelCapabilities,
} from "../modelCapabilities";
import type { ReasoningLevel, ReasoningProvider } from "./reasoningProfiles";
import type { ModelTurnOutcome } from "../shared/llm";
import {
  getAnthropicReasoningProfileForModel,
  getGeminiReasoningProfileForModel,
} from "./reasoningProfiles";
import { callLLMWithTimeout } from "./llmCallTimeout";

export type UtilityLLMFailureReason =
  | "not_configured"
  | "budget_unavailable"
  | "output_limit"
  | "timeout"
  | "transport"
  | "empty";

export type UtilityLLMFailure = {
  ok: false;
  reason: UtilityLLMFailureReason;
  /**
   * The provider's own error text, truncated. `reason` is a typed category
   * chosen so callers can branch on it; without this a 401, a 429 and a
   * dropped socket are all indistinguishable in the log.
   */
  detail?: string;
  /** HTTP status parsed out of the provider error, when there was one. */
  status?: number;
};

export type UtilityLLMResult = { ok: true; text: string } | UtilityLLMFailure;

/** Longest provider error text carried on a failure, to keep logs readable. */
const MAX_FAILURE_DETAIL_CHARS = 300;

/** One-line failure description for a log or a thrown error message. */
export function describeUtilityLLMFailure(failure: UtilityLLMFailure): string {
  return failure.detail
    ? `${failure.reason}: ${failure.detail}`
    : failure.reason;
}

/**
 * Record why an internal call gave up. These features all degrade quietly by
 * design, so the log is the only place the cause ever surfaces. `Zotero` is
 * reached through `globalThis` because this module is also loaded by the unit
 * tests, where no chrome global exists.
 */
export function logUtilityLLMFailure(
  context: string,
  failure: UtilityLLMFailure,
): void {
  (
    globalThis as typeof globalThis & {
      Zotero?: { debug?: (message: string) => void };
    }
  ).Zotero?.debug?.(
    `[llm-for-zotero] ${context} (${describeUtilityLLMFailure(failure)})`,
  );
}

export type UtilityLLMParams = {
  prompt: string;
  model?: string;
  apiBase?: string;
  apiKey?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  /** Preserve a supported configured reasoning level for semantic interpretation. */
  reasoning?: ReasoningConfig;
  /** The caller's useful JSON output, excluding any reasoning reserve. */
  jsonBudget: number;
  /** Use Auto when the expected JSON size must not cap hidden reasoning. */
  outputTokenLimit?: ChatParams["outputTokenLimit"];
  /** Minimum capacity for configured reasoning; does not alter its effort level. */
  reasoningReserveTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  /**
   * Required, deliberately. A shared default is invisible to the tests — they
   * all inject `llmCall`, which resolves instantly, so a wrong budget never
   * fires the timer — and these calls range from a 220-token slash-command
   * lookup to a 1200-token batch. Each caller has to name its own.
   */
  timeoutMs: number;
  systemMessages?: string[];
  /**
   * Let the call go out when the caller names neither an API URL nor a key.
   * `callLLM` then resolves the connection from the saved default model
   * entry, or from the auth mode itself (Codex login, Copilot), and fails
   * with its own error when there is none. Reader calls set this because
   * full-read batches always reached `callLLM` that way.
   */
  allowImplicitConnection?: boolean;
  /** Test seam: replaces the actual model call. */
  llmCall?: (chatParams: ChatParams) => Promise<ModelTurnOutcome>;
};

type UtilityReasoningPlan = {
  reasoning?: ReasoningConfig;
  reserveTokens: number;
};

const REASONING_RESERVE_BY_LEVEL: Record<string, number> = {
  minimal: 512,
  low: 1_024,
  default: 1_024,
  medium: 2_048,
  high: 4_096,
  xhigh: 8_192,
  ultra: 8_192,
  max: 8_192,
};

const REASONING_PROVIDERS = new Set<ReasoningProvider>([
  "openai",
  "gemini",
  "deepseek",
  "kimi",
  "mimo",
  "qwen",
  "grok",
  "anthropic",
  "local",
]);

function normalize(value: unknown): string {
  return `${value ?? ""}`.trim().toLowerCase();
}

function isDisabledOption(
  option: ReasoningCapabilityOption | undefined,
): boolean {
  const id = normalize(option?.id);
  const label = normalize(option?.label);
  return (
    id === "off" ||
    id === "disabled" ||
    id === "none" ||
    label === "off" ||
    label === "disabled" ||
    label === "none"
  );
}

function providerForReasoning(
  provider: ModelCapabilityProvider,
  protocol?: ProviderProtocol,
): ReasoningProvider | undefined {
  if (REASONING_PROVIDERS.has(provider as ReasoningProvider)) {
    return provider as ReasoningProvider;
  }
  if (
    protocol === "codex_responses" ||
    protocol === "responses_api" ||
    protocol === "openai_chat_compat"
  ) {
    return "openai";
  }
  if (protocol === "gemini_native") return "gemini";
  if (protocol === "anthropic_messages") return "anthropic";
  if (protocol === "ollama_native") return "local";
  return undefined;
}

function numericReserveFromControls(
  option: ReasoningCapabilityOption | undefined,
): number | undefined {
  const body = option?.controls?.body;
  if (!body) return undefined;
  const candidates = [
    body.thinking_budget,
    body.thinkingBudget,
    isRecord(body.thinking_config)
      ? body.thinking_config.thinking_budget
      : undefined,
    isRecord(body.thinkingConfig)
      ? body.thinkingConfig.thinkingBudget
      : undefined,
    isRecord(body.generation_config) &&
    isRecord(body.generation_config.thinking_config)
      ? body.generation_config.thinking_config.thinking_budget
      : undefined,
    isRecord(body.generationConfig) &&
    isRecord(body.generationConfig.thinkingConfig)
      ? body.generationConfig.thinkingConfig.thinkingBudget
      : undefined,
  ];
  const numeric = candidates.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value) && value >= 0,
  );
  return numeric === undefined ? undefined : Math.floor(numeric);
}

function numericGeminiReserve(
  model: string,
  level: ReasoningLevel,
): number | undefined {
  const value = getGeminiReasoningProfileForModel(model).levelToValue[level];
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function findLowestSupportedOption(
  reasoning: ModelReasoningCapability,
): ReasoningCapabilityOption | undefined {
  const enabled = reasoning.options.filter(
    (option) => option.enabled !== false,
  );
  if (!enabled.length) return undefined;
  const preferred = ["minimal", "low", "default", "medium", "high", "xhigh"];
  for (const id of preferred) {
    const option = enabled.find((candidate) => normalize(candidate.id) === id);
    if (option) return option;
  }
  return enabled[0];
}

function findDisabledOption(
  capabilities: ResolvedModelCapabilities,
  reasoning: ModelReasoningCapability,
  provider?: ReasoningProvider,
): ReasoningCapabilityOption | undefined {
  return reasoning.options.find(
    (option) =>
      isDisabledOption(option) &&
      Boolean(
        option.controls?.body ||
        option.controls?.omit?.length ||
        option.controls?.omitTemperature ||
        // A hosted profile keeps its encoding in the transport rather than in
        // the option, so the only way to know the level really switches
        // thinking off is to look at the request it produces.
        !isReasoningLevelActive(capabilities, option.id) ||
        (provider === "gemini" &&
          ["off", "disabled", "none"].includes(normalize(option.label))),
      ),
  );
}

function buildReasoningPlan(params: {
  model: string;
  apiBase?: string;
  authMode?: ModelProviderAuthMode;
  providerProtocol?: ProviderProtocol;
  profileOverride?: ModelProfileOverride;
  reasoning?: ReasoningConfig;
}): UtilityReasoningPlan | null {
  const capabilities = getModelCapabilities({
    model: params.model,
    apiBase: params.apiBase,
    protocol:
      params.providerProtocol ||
      inferLegacyProviderProtocol({
        authMode: params.authMode,
        apiBase: params.apiBase,
      }),
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  const provider = providerForReasoning(
    capabilities.provider,
    params.providerProtocol,
  );
  const reasoning = capabilities.reasoning;

  const planForOption = (
    option: ReasoningCapabilityOption,
    selectedProvider: ReasoningProvider,
  ): UtilityReasoningPlan => {
    const level = normalize(option.id) as ReasoningLevel;
    return {
      reasoning: { provider: selectedProvider, level },
      reserveTokens: isDisabledOption(option)
        ? 0
        : (numericReserveFromControls(option) ??
          (capabilities.provider === "gemini"
            ? numericGeminiReserve(params.model, level)
            : undefined) ??
          REASONING_RESERVE_BY_LEVEL[level] ??
          1024),
    };
  };
  const configured =
    params.reasoning?.provider === provider
      ? reasoning.options.find(
          (option) =>
            option.enabled !== false &&
            normalize(option.id) === params.reasoning?.level,
        )
      : undefined;
  if (configured && provider) return planForOption(configured, provider);

  // Anthropic's bounded utility requests never inherit a manual thinking
  // budget. Models that think when `thinking` is omitted get thinking off, or
  // else the lowest adaptive effort. A profile-authored disabled control is
  // still honored.
  if (
    capabilities.provider === "anthropic" &&
    capabilities.provenance.reasoning === "legacy"
  ) {
    if (
      !getAnthropicReasoningProfileForModel(params.model).thinkingOnWhenOmitted
    ) {
      return { reasoning: undefined, reserveTokens: 0 };
    }
    // Claude 5.x thinks when `thinking` is omitted, inside max_tokens. Its
    // controls are only encoded for the Messages API; elsewhere the model
    // still thinks, so the call keeps room for it.
    if (capabilities.identity.protocol !== "anthropic_messages" || !provider) {
      return { reasoning: undefined, reserveTokens: 1024 };
    }
    const off = findDisabledOption(capabilities, reasoning, provider);
    if (off) {
      return {
        reasoning: { provider, level: normalize(off.id) as ReasoningLevel },
        reserveTokens: 0,
      };
    }
    const lowest = findLowestSupportedOption(reasoning);
    return lowest
      ? planForOption(lowest, provider)
      : { reasoning: undefined, reserveTokens: 1024 };
  }
  const disabled = findDisabledOption(capabilities, reasoning, provider);
  if (disabled) {
    return {
      reasoning: provider
        ? { provider, level: normalize(disabled.id) as ReasoningLevel }
        : undefined,
      reserveTokens: 0,
    };
  }
  if (capabilities.provider === "anthropic") {
    return { reasoning: undefined, reserveTokens: 0 };
  }

  if (reasoning.kind === "none") {
    // There is no evidence that this provider/model supports a controllable
    // reasoning mode, so an ordinary bounded request is safe.
    return { reasoning: undefined, reserveTokens: 0 };
  }

  const option = findLowestSupportedOption(reasoning);
  if (option && provider) {
    return planForOption(option, provider);
  }

  // Unknown controls must not manufacture a low effort. The server owns Auto.
  return { reasoning: undefined, reserveTokens: 1024 };
}

function isTimeoutError(error: unknown): boolean {
  return /LLM call timed out after \d+ms/i.test(
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * `llmClient` formats every non-OK response as `<status> <statusText> (<url>)
 * - <body>`, so the status and the provider's own words are both recoverable
 * from the thrown message.
 */
function describeTransportError(error: unknown): {
  detail: string;
  status?: number;
} {
  const message = (
    error instanceof Error ? error.message : String(error)
  ).trim();
  const status = parseStatusFromErrorMessage(message);
  const detail =
    message.length > MAX_FAILURE_DETAIL_CHARS
      ? `${message.slice(0, MAX_FAILURE_DETAIL_CHARS)}…`
      : message;
  return { detail, ...(status === null ? {} : { status }) };
}

/**
 * Make a small structured internal call with a provider-safe reasoning mode.
 * Callers own schema parsing because each utility has a different contract.
 */
export async function callUtilityLLM(
  params: UtilityLLMParams,
): Promise<UtilityLLMResult> {
  const model = (params.model || "").trim();
  if (
    !model ||
    (!params.allowImplicitConnection && !params.apiBase && !params.apiKey)
  ) {
    return { ok: false, reason: "not_configured" };
  }

  const plan = buildReasoningPlan({
    model,
    apiBase: params.apiBase,
    authMode: params.authMode,
    providerProtocol: params.providerProtocol,
    profileOverride: params.profileOverride,
    reasoning: params.reasoning,
  });
  if (!plan) {
    return {
      ok: false,
      reason: "budget_unavailable",
      detail: `no provider-safe reasoning mode for ${model}`,
    };
  }

  const jsonBudget = Math.max(1, Math.floor(params.jsonBudget));
  const reasoningReserve =
    plan.reserveTokens > 0
      ? Math.max(
          plan.reserveTokens,
          Math.floor(params.reasoningReserveTokens || 0),
        )
      : 0;
  const requiredBudget = jsonBudget + reasoningReserve;
  const outputTokenLimit = params.outputTokenLimit || {
    mode: "custom" as const,
    tokens: requiredBudget,
  };
  const outputPolicy = resolveOutputRequestPolicy({
    setting: outputTokenLimit,
    model,
    apiBase: params.apiBase,
    protocol:
      params.providerProtocol ||
      inferLegacyProviderProtocol({
        authMode: params.authMode,
        apiBase: params.apiBase,
      }),
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  if (outputPolicy.mode === "numeric" && outputPolicy.tokens < requiredBudget) {
    return {
      ok: false,
      reason: "budget_unavailable",
      detail: `${model} caps output at ${outputPolicy.tokens} tokens, below the ${requiredBudget} this call needs (${jsonBudget} JSON + ${reasoningReserve} reasoning reserve)`,
    };
  }

  try {
    const outcome = await callLLMWithTimeout({
      prompt: params.prompt,
      model,
      apiBase: params.apiBase,
      apiKey: params.apiKey,
      authMode: params.authMode,
      providerProtocol: params.providerProtocol,
      profileOverride: params.profileOverride,
      reasoning: plan.reasoning,
      temperature: params.temperature ?? 0,
      outputTokenLimit,
      parentSignal: params.signal,
      timeoutMs: params.timeoutMs,
      systemMessages: params.systemMessages,
      llmCall: params.llmCall,
    });
    if (
      outcome.completion.status === "incomplete" &&
      outcome.completion.reason === "output_limit"
    ) {
      return {
        ok: false,
        reason: "output_limit",
        detail: `Structured utility call exhausted its ${
          outputPolicy.mode === "numeric"
            ? `${outputPolicy.tokens}-token`
            : "provider-managed"
        } output budget.`,
      };
    }
    const text =
      outcome.completion.status === "complete"
        ? outcome.text
        : requireCompleteModelText(outcome, "Structured utility call");
    if (!text.trim()) {
      return {
        ok: false,
        reason: "empty",
        detail: `${model} returned no text within ${
          outputPolicy.mode === "numeric"
            ? `${outputPolicy.tokens} tokens`
            : "the provider-managed output budget"
        }`,
      };
    }
    return { ok: true, text };
  } catch (error) {
    const described = describeTransportError(error);
    return {
      ok: false,
      reason: isTimeoutError(error) ? "timeout" : "transport",
      ...described,
    };
  }
}

export { buildReasoningPlan as resolveUtilityReasoningPlan };
