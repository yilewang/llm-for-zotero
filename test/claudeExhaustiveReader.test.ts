import { assert } from "chai";
import { createClaudeBridgeExhaustiveReaderSession } from "../src/claudeCode/exhaustiveReader";
import { readDocumentsExhaustively } from "../src/shared/exhaustiveDocumentReader";
import type { ReaderCompletion } from "../src/shared/readerCompletion";

const batchInput = {
  paperKey: "paper-1",
  paperLabel: "Paper One",
  question: "What is the conclusion?",
  chunks: [{ chunkIndex: 0, text: "Evidence text." }],
};

describe("Claude bridge exhaustive reader", function () {
  it("requires a concrete model", function () {
    for (const model of ["", "  "]) {
      assert.throws(
        () => createClaudeBridgeExhaustiveReaderSession({ model }),
        "concrete Claude model",
      );
    }
  });

  it("reads a batch through the completion adapter and reports its usage", async function () {
    const calls: Array<{ prompt: string; options: unknown }> = [];
    const usages: unknown[] = [];
    const complete: ReaderCompletion = async (prompt, options) => {
      calls.push({ prompt, options });
      return {
        text: JSON.stringify({ digest: "Grounded.", relevantChunkIds: [0] }),
        usage: { inputTokens: 50, outputTokens: 7 },
      };
    };
    const session = createClaudeBridgeExhaustiveReaderSession({
      model: "sonnet",
      reasoning: { provider: "anthropic", level: "high" },
      complete,
      onUsage: (usage) => usages.push(usage),
    });

    const result = await session.analyzeBatch(batchInput);

    assert.deepEqual(result, { digest: "Grounded.", relevantChunkIds: [0] });
    assert.deepEqual(usages, [{ inputTokens: 50, outputTokens: 7 }]);
    assert.include(calls[0].prompt, "Evidence text.");
    const options = calls[0].options as {
      model: string;
      systemMessages: string[];
    };
    assert.equal(options.model, "sonnet");
    assert.include(options.systemMessages.join(" "), "document-reading worker");
  });

  it("refuses to read after dispose", async function () {
    const session = createClaudeBridgeExhaustiveReaderSession({
      model: "sonnet",
      complete: async () => ({ text: "{}" }),
    });
    session.dispose();
    let error: Error | undefined;
    try {
      await session.analyzeBatch(batchInput);
    } catch (caught) {
      error = caught as Error;
    }
    assert.match(error?.message || "", /closed/);
  });

  it("lets the reader's rate-limit backoff retry a 429 from the adapter", async function () {
    let calls = 0;
    const session = createClaudeBridgeExhaustiveReaderSession({
      model: "sonnet",
      complete: async () => {
        calls += 1;
        if (calls === 1) throw new Error("429 You hit your limit");
        return {
          text: JSON.stringify({ digest: "Covered.", relevantChunkIds: [] }),
        };
      },
    });
    const chunks = ["Section 1\nSome evidence."];
    const result = await readDocumentsExhaustively({
      papers: [
        {
          paperContext: { itemId: 10, contextItemId: 11, title: "Paper" },
          pdfContext: {
            title: "Paper",
            chunks,
            chunkMeta: [],
            chunkStats: [],
            docFreq: {},
            avgChunkLength: 0,
            fullLength: chunks[0].length,
          } as never,
        },
      ],
      question: "Read everything.",
      batchTokenBudget: 4000,
      finalTokenBudget: 4000,
      rateLimitBackoffMs: 0,
      analyzeBatch: session.analyzeBatch,
    });
    assert.equal(calls, 2);
    assert.equal(result.status, "complete");
  });
});
