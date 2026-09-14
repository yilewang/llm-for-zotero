import {
  getModelCapabilities,
  type ModelProfileOverride,
} from "../modelCapabilities";
import type { OutputTokenLimitSetting } from "../shared/types";
import { MAX_ALLOWED_TOKENS } from "./llmDefaults";
import type { ModelProviderAuthMode } from "./modelProviders";
import { detectProviderPreset } from "./providerPresets";
import type { ProviderProtocol } from "./providerProtocol";

/** Expected answer space reserved by prompt planners; never a wire-level cap. */
export const DEFAULT_OUTPUT_RESERVE_TOKENS = 8_192;

/**
 * Anthropic-compatible Messages endpoints require max_tokens. Unknown models
 * use this conservative seed until capability metadata is available.
 */
export const AUTO_REQUIRED_OUTPUT_TOKEN_SEED = 8_192;

/** Share of the context window the plugin lets input plus the transmitted cap fill. */
export const CONTEXT_USABLE_RATIO = 0.9;
/**
 * Local token estimates are heuristic. The transmitted cap leaves this much
 * headroom over the estimated input so a provider that validates
 * `input + max_tokens <= context window` (Anthropic, OpenAI) never rejects a
 * prompt the budget already accepted.
 */
export const INPUT_ESTIMATE_SAFETY_RATIO = 1.2;
/** Never reserve more than this share of the usable window for the answer. */
const MAX_ANSWER_RESERVE_RATIO = 0.25;

export type OutputRequestPolicy =
  | {
      mode: "omit";
      source: "auto_provider";
    }
  | {
      mode: "runtime_managed";
      source: "runtime";
    }
  | {
      mode: "unlimited";
      source: "auto_provider";
    }
  | {
      mode: "numeric";
      tokens: number;
      source: "auto_capability" | "auto_compatibility" | "custom";
    };

type OutputPolicyIdentity = {
  setting?: OutputTokenLimitSetting;
  model: string;
  apiBase?: string;
  protocol: ProviderProtocol;
  authMode?: ModelProviderAuthMode;
  profileOverride?: ModelProfileOverride;
};

function resolveKnownOutputLimit(
  params: Omit<OutputPolicyIdentity, "setting">,
): number | undefined {
  const capabilities = getModelCapabilities({
    model: params.model,
    provider: params.apiBase
      ? detectProviderPreset(params.apiBase).toString()
      : undefined,
    apiBase: params.apiBase,
    protocol: params.protocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  });
  const limit = capabilities.limits.outputTokens;
  return Number.isSafeInteger(limit) && Number(limit) > 0
    ? Math.min(Number(limit), MAX_ALLOWED_TOKENS)
    : undefined;
}

function normalizeCustomTokens(value: unknown, knownLimit?: number): number {
  const parsed = Math.floor(Number(value));
  const normalized =
    Number.isFinite(parsed) && parsed >= 1
      ? Math.min(parsed, MAX_ALLOWED_TOKENS)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return knownLimit ? Math.min(normalized, knownLimit) : normalized;
}

export function resolveOutputRequestPolicy(
  params: OutputPolicyIdentity,
): OutputRequestPolicy {
  if (
    params.authMode === "codex_auth" ||
    params.authMode === "codex_app_server" ||
    params.authMode === "webchat" ||
    params.protocol === "web_sync"
  ) {
    return { mode: "runtime_managed", source: "runtime" };
  }

  const setting = params.setting || { mode: "auto" };
  const identity = {
    model: params.model,
    apiBase: params.apiBase,
    protocol: params.protocol,
    authMode: params.authMode,
    profileOverride: params.profileOverride,
  };
  const knownLimit = resolveKnownOutputLimit(identity);

  if (setting.mode === "custom") {
    return {
      mode: "numeric",
      tokens: normalizeCustomTokens(setting.tokens, knownLimit),
      source: "custom",
    };
  }

  if (params.protocol === "ollama_native") {
    return { mode: "unlimited", source: "auto_provider" };
  }
  if (params.protocol === "anthropic_messages") {
    return knownLimit
      ? {
          mode: "numeric",
          tokens: knownLimit,
          source: "auto_capability",
        }
      : {
          mode: "numeric",
          tokens: AUTO_REQUIRED_OUTPUT_TOKEN_SEED,
          source: "auto_compatibility",
        };
  }
  if (
    (params.protocol === "openai_chat_compat" ||
      params.protocol === "responses_api") &&
    knownLimit
  ) {
    // A registry-known limit beats the provider's undocumented default cap;
    // a provider that rejects the value is retried once by the transport.
    return { mode: "numeric", tokens: knownLimit, source: "auto_capability" };
  }
  return { mode: "omit", source: "auto_provider" };
}

/**
 * How one context window is split between prompt input and the answer.
 * This is the single owner of "room left for the prompt": the Agent prompt
 * budget, the direct-chat budget and the transmitted cap all derive from it.
 */
export type ContextAllocation = {
  contextWindow: number;
  /** Input plus transmitted cap may fill this much of the window. */
  usableTokens: number;
  /** Answer room guaranteed to survive prompt planning. */
  answerReserveTokens: number;
  /** Largest prompt the planner may build. */
  inputBudgetTokens: number;
};

export function resolveContextAllocation(params: {
  contextWindow: number;
  policy: OutputRequestPolicy;
}): ContextAllocation {
  const contextWindow = Math.max(1, Math.floor(Number(params.contextWindow)));
  const usableTokens = Math.max(
    1,
    Math.floor(contextWindow * CONTEXT_USABLE_RATIO),
  );
  // A user-chosen cap is reserved in full so the prompt planner leaves room
  // for it; an Auto capability limit is the model's ceiling, not a request,
  // and only the default answer window is held back for it.
  const requestedReserve =
    params.policy.mode === "numeric"
      ? params.policy.source === "custom"
        ? params.policy.tokens
        : Math.min(params.policy.tokens, DEFAULT_OUTPUT_RESERVE_TOKENS)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  const answerReserveTokens = Math.max(
    1,
    Math.min(
      requestedReserve,
      Math.floor(usableTokens * MAX_ANSWER_RESERVE_RATIO),
    ),
  );
  return {
    contextWindow,
    usableTokens,
    answerReserveTokens,
    inputBudgetTokens: Math.max(1, usableTokens - answerReserveTokens),
  };
}

/**
 * The cap actually sent on the wire for one request. A numeric cap shrinks to
 * the room left beside the estimated input (never below the answer reserve);
 * every other policy is passed through unchanged.
 */
export function resolveTransmittedOutputPolicy(params: {
  policy: OutputRequestPolicy;
  contextWindow: number;
  estimatedInputTokens: number;
}): OutputRequestPolicy {
  if (params.policy.mode !== "numeric") return params.policy;
  const allocation = resolveContextAllocation({
    contextWindow: params.contextWindow,
    policy: params.policy,
  });
  const guardedInput = Math.ceil(
    Math.max(0, Number(params.estimatedInputTokens) || 0) *
      INPUT_ESTIMATE_SAFETY_RATIO,
  );
  const roomLeft = allocation.contextWindow - guardedInput;
  const tokens = Math.max(
    allocation.answerReserveTokens,
    Math.min(params.policy.tokens, roomLeft),
  );
  return tokens === params.policy.tokens
    ? params.policy
    : { ...params.policy, tokens };
}

export function resolveOutputReserve(
  setting: OutputTokenLimitSetting | undefined,
  model: string,
  identity?: Omit<OutputPolicyIdentity, "setting" | "model" | "protocol"> & {
    protocol?: ProviderProtocol;
  },
): number {
  const knownLimit = identity?.protocol
    ? resolveKnownOutputLimit({
        model,
        apiBase: identity.apiBase,
        protocol: identity.protocol,
        authMode: identity.authMode,
        profileOverride: identity.profileOverride,
      })
    : getModelCapabilities({ model }).limits.outputTokens;
  const requested =
    setting?.mode === "custom"
      ? normalizeCustomTokens(setting.tokens)
      : DEFAULT_OUTPUT_RESERVE_TOKENS;
  return knownLimit ? Math.min(requested, knownLimit) : requested;
}
