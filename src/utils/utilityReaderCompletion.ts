import {
  ReaderCompletionError,
  type ReaderCompletion,
} from "../shared/readerCompletion";
import {
  callUtilityLLM,
  resolveUtilityReasoningPlan,
  type UtilityLLMParams,
} from "./utilityLLM";
import { getModelOutputTokenLimit } from "../modelCapabilities";

/** The provider a turn-model reader calls: the chat's own connection. */
export type UtilityReaderConfig = Pick<
  UtilityLLMParams,
  | "apiBase"
  | "apiKey"
  | "authMode"
  | "providerProtocol"
  | "profileOverride"
  | "llmCall"
>;

/** Used when a caller names no output budget. */
const DEFAULT_JSON_BUDGET_TOKENS = 2_000;
/** Matches the error `callLLM` throws when no connection can be resolved. */
const NO_CONNECTION_PATTERN = /API URL is missing in preferences/i;

/**
 * The chat turn's provider as a reader completion, through
 * `callUtilityLLM`: its provider-safe reasoning level, its output-budget
 * check and its deadline (none when the caller names no `timeoutMs`).
 * It also accepts every setup `callLLM` accepts: a request with neither API
 * URL nor key resolves its connection from the saved default entry or the
 * auth mode, as full-read batches always did. `maxTokens` is the JSON budget the call needs,
 * excluding any reasoning reserve. A failure throws a
 * `ReaderCompletionError` with the utility layer's own reason, status and
 * detail, so a caller branches on it exactly as on the utility result.
 */
export function createUtilityReaderCompletion(
  config: UtilityReaderConfig,
): ReaderCompletion {
  return async (prompt, options) => {
    const result = await callUtilityLLM({
      prompt,
      model: options.model,
      apiBase: config.apiBase,
      apiKey: config.apiKey,
      authMode: config.authMode,
      providerProtocol: config.providerProtocol,
      profileOverride: config.profileOverride,
      ...(options.reasoning ? { reasoning: options.reasoning } : {}),
      jsonBudget: options.maxTokens ?? DEFAULT_JSON_BUDGET_TOKENS,
      temperature: options.temperature,
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? Infinity,
      systemMessages: options.systemMessages,
      allowImplicitConnection: true,
      llmCall: config.llmCall,
    });
    if (result.ok) return { text: result.text };
    if (options.signal?.aborted) {
      throw new ReaderCompletionError({ reason: "aborted" });
    }
    throw new ReaderCompletionError({
      // No connection anywhere is a configuration failure, so a chosen
      // reader falls back to the main model instead of retrying.
      reason:
        result.reason === "transport" &&
        NO_CONNECTION_PATTERN.test(result.detail || "")
          ? "not_configured"
          : result.reason,
      ...(result.status !== undefined ? { status: result.status } : {}),
      ...(result.detail ? { detail: result.detail } : {}),
    });
  };
}

/**
 * The most JSON output tokens one turn-model reader call may ask for: the
 * model's output ceiling less the reasoning reserve its provider-safe level
 * needs. Undefined when the model has no provider-safe level.
 */
export function utilityReaderOutputCeiling(
  config: Omit<UtilityReaderConfig, "llmCall" | "apiKey"> & { model: string },
): number | undefined {
  const plan = resolveUtilityReasoningPlan({
    model: config.model,
    apiBase: config.apiBase,
    authMode: config.authMode,
    providerProtocol: config.providerProtocol,
    profileOverride: config.profileOverride,
  });
  if (!plan) return undefined;
  const limit = getModelOutputTokenLimit(config.model, {
    apiBase: config.apiBase,
    protocol: config.providerProtocol,
    authMode: config.authMode,
    profileOverride: config.profileOverride,
  });
  return Math.max(1, limit - plan.reserveTokens);
}
