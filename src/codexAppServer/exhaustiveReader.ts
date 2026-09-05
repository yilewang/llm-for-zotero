import type { ReasoningConfig } from "../shared/llm";
import {
  createExhaustiveBatchAnalyzer,
  type ExhaustiveBatchAnalyzer,
} from "../shared/exhaustiveDocumentReader";
import { callLLM, DEFAULT_CODEX_API_BASE } from "../utils/llmClient";
import type { ModelProfileOverride } from "../modelCapabilities";

export type CodexAppServerExhaustiveReaderSession = {
  analyzeBatch: ExhaustiveBatchAnalyzer;
  dispose: () => void;
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Aborted");
  error.name = "AbortError";
  throw error;
}

function requireModel(model: string): string {
  const normalized = model.trim();
  if (!normalized || normalized === "codex-app-server") {
    throw new Error(
      "A concrete Codex model is required for tool-free exhaustive reading",
    );
  }
  return normalized;
}

export function createCodexAppServerExhaustiveReaderSession(params: {
  model: string;
  reasoning?: ReasoningConfig;
  profileOverride?: ModelProfileOverride;
}): CodexAppServerExhaustiveReaderSession {
  const model = requireModel(params.model);
  let disposed = false;

  const analyzeBatch = createExhaustiveBatchAnalyzer(
    async ({ prompt, systemMessages, signal, maxTokens, temperature }) => {
      if (disposed) {
        throw new Error("Codex exhaustive reader session is closed");
      }
      throwIfAborted(signal);
      // app-server turns are coding-agent turns and always expose a built-in
      // tool surface. Batch reading is a pure completion task, so send it to
      // the Codex Responses endpoint with no tools instead of attempting to
      // maintain a fragile deny-list of app-server features.
      return callLLM({
        prompt,
        systemMessages,
        signal,
        model,
        reasoning: params.reasoning,
        maxTokens,
        temperature,
        apiBase: DEFAULT_CODEX_API_BASE,
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        profileOverride: params.profileOverride,
      });
    },
  );

  return {
    analyzeBatch,
    dispose: () => {
      if (disposed) return;
      disposed = true;
    },
  };
}
