import type { ReasoningConfig } from "../shared/llm";
import {
  createExhaustiveBatchAnalyzer,
  type ExhaustiveBatchAnalyzer,
} from "../shared/exhaustiveDocumentReader";
import type {
  ReaderCompletion,
  ReaderCompletionUsage,
} from "../shared/readerCompletion";
import { createClaudeBridgeCompletion } from "./structuredCompletion";

export type ClaudeBridgeExhaustiveReaderSession = {
  analyzeBatch: ExhaustiveBatchAnalyzer;
  dispose: () => void;
};

function requireModel(model: string): string {
  const normalized = model.trim();
  if (!normalized) {
    throw new Error(
      "A concrete Claude model is required for tool-free exhaustive reading",
    );
  }
  return normalized;
}

/**
 * Exhaustive batch reading over the Claude Code bridge's tool-free
 * structured completion. Mirrors the Codex reader session; the completion is
 * injectable so a later caller can route a different reader model through it.
 */
export function createClaudeBridgeExhaustiveReaderSession(params: {
  model: string;
  reasoning?: ReasoningConfig;
  complete?: ReaderCompletion;
  /** Receives the token counts of each batch the bridge reported. */
  onUsage?: (usage: ReaderCompletionUsage) => void;
}): ClaudeBridgeExhaustiveReaderSession {
  const model = requireModel(params.model);
  const complete = params.complete ?? createClaudeBridgeCompletion();
  let disposed = false;

  const analyzeBatch = createExhaustiveBatchAnalyzer(
    async ({ prompt, systemMessages, signal, maxTokens, temperature }) => {
      if (disposed) {
        throw new Error("Claude exhaustive reader session is closed");
      }
      const result = await complete(prompt, {
        model,
        signal,
        systemMessages,
        reasoning: params.reasoning,
        maxTokens,
        temperature,
      });
      if (result.usage) params.onUsage?.(result.usage);
      return result.text;
    },
  );

  return {
    analyzeBatch,
    dispose: () => {
      disposed = true;
    },
  };
}
