import type { AgentRuntimeRequest } from "../types";
import {
  resolveOutputRequestPolicy,
  resolveTransmittedOutputPolicy,
  type OutputRequestPolicy,
} from "../../utils/outputTokenPolicy";
import { resolveModelInputTokenLimit } from "../../utils/modelInputCap";
import type { ProviderProtocol } from "../../utils/providerProtocol";

/** Whole-run boundaries; independent of any one response's output policy. */
export const MAX_AGENT_ROUNDS = 24;
export const MAX_AGENT_TOOL_CALLS_PER_ROUND = 8;

export const MAX_BULK_AGENT_ROUNDS = 32;
export const MAX_BULK_TOOL_CALLS_PER_ROUND = 10;

/**
 * How many times a final answer cut off by the provider's output limit is
 * asked to continue before the text written so far is delivered as is.
 */
export const MAX_ANSWER_CONTINUATIONS = 3;

/**
 * Resolve one Agent inference's wire policy. Whole-run limits remain owned by
 * the runtime's rounds, progress checks, checkpoints, and context compaction.
 */
export function resolveAgentOutputRequestPolicy(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
): OutputRequestPolicy {
  const policy = resolveOutputRequestPolicy({
    setting: request.advanced?.outputTokenLimit,
    model: request.model || "",
    apiBase: request.apiBase,
    protocol,
    authMode: request.authMode,
    profileOverride: request.advanced?.profileOverride,
  });
  (
    globalThis as typeof globalThis & {
      ztoolkit?: { log?: (...args: unknown[]) => void };
    }
  ).ztoolkit?.log?.("LLM Agent: Resolved output policy", {
    settingMode: request.advanced?.outputTokenLimit?.mode || "auto",
    resolutionSource: policy.source,
    transmittedPolicy:
      policy.mode === "numeric"
        ? { mode: "numeric", tokens: policy.tokens }
        : { mode: policy.mode },
    protocol,
  });
  return policy;
}

/**
 * The cap transmitted for one Agent inference: the resolved policy, shrunk to
 * the room left beside this request's estimated input so the provider never
 * rejects `input + max_tokens > context window`.
 */
export function resolveAgentTransmittedOutputPolicy(
  request: AgentRuntimeRequest,
  protocol: ProviderProtocol,
  estimatedInputTokens: number,
): OutputRequestPolicy {
  const policy = resolveAgentOutputRequestPolicy(request, protocol);
  if (policy.mode !== "numeric") return policy;
  const contextWindow = resolveModelInputTokenLimit(
    request.model || "",
    request.advanced?.inputTokenCap,
    {
      apiBase: request.apiBase,
      protocol,
      authMode: request.authMode,
      profileOverride: request.advanced?.profileOverride,
    },
  ).limitTokens;
  const transmitted = resolveTransmittedOutputPolicy({
    policy,
    contextWindow,
    estimatedInputTokens,
  });
  if (transmitted !== policy) {
    (
      globalThis as typeof globalThis & {
        ztoolkit?: { log?: (...args: unknown[]) => void };
      }
    ).ztoolkit?.log?.("LLM Agent: Clamped output cap to the context window", {
      protocol,
      contextWindow,
      estimatedInputTokens,
      requestedTokens: policy.tokens,
      transmittedTokens:
        transmitted.mode === "numeric" ? transmitted.tokens : undefined,
    });
  }
  return transmitted;
}

export function resolveAgentLimits(isBulkOperation: boolean): {
  maxRounds: number;
  maxToolCallsPerRound: number;
} {
  if (isBulkOperation) {
    return {
      maxRounds: MAX_BULK_AGENT_ROUNDS,
      maxToolCallsPerRound: MAX_BULK_TOOL_CALLS_PER_ROUND,
    };
  }
  return {
    maxRounds: MAX_AGENT_ROUNDS,
    maxToolCallsPerRound: MAX_AGENT_TOOL_CALLS_PER_ROUND,
  };
}
