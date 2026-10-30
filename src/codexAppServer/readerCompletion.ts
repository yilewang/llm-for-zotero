import type { ReaderCompletion } from "../shared/readerCompletion";
import {
  callLLM,
  DEFAULT_CODEX_API_BASE,
  requireCompleteModelText,
  type ChatParams,
} from "../utils/llmClient";
import { callLLMWithTimeout } from "../utils/llmCallTimeout";
import type { ModelProfileOverride } from "../modelCapabilities";
import type { ModelTurnOutcome } from "../shared/llm";

/** The placeholder model name of a Codex chat with no model picked. */
const CODEX_APP_SERVER_PLACEHOLDER_MODEL = "codex-app-server";

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

/**
 * The Codex Responses endpoint as a reader completion: one tool-free
 * request on the user's Codex login (`codex_auth`), never an app-server
 * thread. App-server turns are coding-agent turns and always expose a
 * built-in tool surface; reading is a pure completion task, so it goes to the
 * Responses endpoint with no tools instead of a deny-list of app-server
 * features.
 *
 * `maxTokens` is not sent (the route sizes its own output). A `timeoutMs`
 * bounds the call; without one the call runs until it ends or is stopped,
 * as the full reader has always run.
 */
export function createCodexResponsesCompletion(
  params: {
    profileOverride?: ModelProfileOverride;
    /** Test seam: replaces the model call. */
    llmCall?: (chatParams: ChatParams) => Promise<ModelTurnOutcome>;
  } = {},
): ReaderCompletion {
  return async (prompt, options) => {
    const model = (options.model || "").trim();
    if (!model || model === CODEX_APP_SERVER_PLACEHOLDER_MODEL) {
      throw new Error(
        "A concrete Codex model is required for tool-free reader completions",
      );
    }
    throwIfAborted(options.signal);
    const chat = {
      prompt,
      systemMessages: options.systemMessages,
      model,
      reasoning: options.reasoning,
      temperature: options.temperature,
      apiBase: DEFAULT_CODEX_API_BASE,
      authMode: "codex_auth" as const,
      providerProtocol: "codex_responses" as const,
      profileOverride: params.profileOverride,
    };
    const outcome =
      options.timeoutMs !== undefined
        ? await callLLMWithTimeout({
            ...chat,
            parentSignal: options.signal,
            timeoutMs: options.timeoutMs,
            llmCall: params.llmCall,
          })
        : await (params.llmCall || callLLM)({
            ...chat,
            signal: options.signal,
          });
    return {
      text: requireCompleteModelText(outcome, "Codex reader completion"),
    };
  };
}
