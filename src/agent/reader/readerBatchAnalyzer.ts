/**
 * Exhaustive full-read batches over a resolved reader.
 *
 * `paper_read` mode full reads every batch of a paper with one
 * `ExhaustiveBatchAnalyzer`. This one calls the reader's completion, so the
 * plugin Agent reads with its turn model (or a picked API reader) and a chosen
 * reader reads in any runtime, through the same route, window and output
 * ceiling as a digest. A batch carries no per-call deadline: full reads
 * never had one, and a large batch on a slow provider legitimately takes
 * minutes. Stop still cancels.
 */
import {
  createExhaustiveBatchAnalyzer,
  type ExhaustiveBatchAnalyzer,
} from "../../shared/exhaustiveDocumentReader";
import type { ResolvedReader } from "./resolveReader";

export function createReaderBatchAnalyzer(
  reader: ResolvedReader,
): ExhaustiveBatchAnalyzer {
  return createExhaustiveBatchAnalyzer(
    async ({ prompt, systemMessages, signal, maxTokens, temperature }) => {
      const result = await reader.complete(prompt, {
        // Read at each call: a reader that fell back names the main model.
        model: reader.model,
        signal,
        systemMessages,
        temperature,
        maxTokens:
          reader.maxOutputTokens !== undefined
            ? Math.min(maxTokens, reader.maxOutputTokens)
            : maxTokens,
      });
      return result.text;
    },
  );
}
