import type { ReasoningConfig } from "../shared/llm";
import {
  createExhaustiveBatchAnalyzer,
  type ExhaustiveBatchAnalyzer,
} from "../shared/exhaustiveDocumentReader";
import type { ModelProfileOverride } from "../modelCapabilities";
import type { ReaderCompletion } from "../shared/readerCompletion";
import { createCodexResponsesCompletion } from "./readerCompletion";

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

/**
 * Exhaustive batch reading over the Codex Responses reader completion
 * (`createCodexResponsesCompletion`). The completion is injectable so a
 * later caller can route a different reader model through it.
 */
export function createCodexAppServerExhaustiveReaderSession(params: {
  model: string;
  reasoning?: ReasoningConfig;
  profileOverride?: ModelProfileOverride;
  complete?: ReaderCompletion;
}): CodexAppServerExhaustiveReaderSession {
  const model = requireModel(params.model);
  const complete =
    params.complete ??
    createCodexResponsesCompletion({ profileOverride: params.profileOverride });
  let disposed = false;

  const analyzeBatch = createExhaustiveBatchAnalyzer(
    async ({ prompt, systemMessages, signal, temperature }) => {
      if (disposed) {
        throw new Error("Codex exhaustive reader session is closed");
      }
      throwIfAborted(signal);
      const result = await complete(prompt, {
        model,
        signal,
        systemMessages,
        reasoning: params.reasoning,
        temperature,
      });
      return result.text;
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
