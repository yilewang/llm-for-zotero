import { assert } from "chai";
import {
  FULL_READ_MAX_BATCH_TOKENS,
  createLlmBatchAnalyzer,
  defaultBatchDigestTokens,
  readDocumentsExhaustively,
  resolveFullReadBatchTokenBudget,
  type ExhaustiveBatchInput,
} from "../src/shared/exhaustiveDocumentReader";
import type { PaperContextRef } from "../src/modules/contextPanel/types";
import type { PdfContext } from "../src/services/paperContent/types";
import { buildChunkMetadata } from "../src/services/paperContent/pdfContext";
import { estimateTextTokens } from "../src/utils/modelInputCap";

function buildPaper(): {
  paperContext: PaperContextRef;
  pdfContext: PdfContext;
} {
  const chunks = Array.from(
    { length: 9 },
    (_, index) => `Section ${index + 1}\nEvidence from chunk ${index}.`,
  );
  return {
    paperContext: {
      itemId: 10,
      contextItemId: 11,
      title: "Coverage Paper",
    },
    pdfContext: {
      title: "Coverage Paper",
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: [],
      docFreq: {},
      avgChunkLength: 0,
      fullLength: chunks.join("\n\n").length,
    },
  };
}

describe("exhaustiveDocumentReader", function () {
  it("runs each digest at the provider's utility reasoning level, not the chat's, and leaves a level that still thinks its room", async function () {
    // At the chat's "high", DeepSeek thought through the whole 700 + 4,096
    // token budget of every digest in the live run: each came back
    // truncated, and each retry repeated it, twenty seconds a call.
    const digestCall = async (model: string, apiBase: string) => {
      const calls: Array<{ reasoning?: unknown; outputTokenLimit?: unknown }> =
        [];
      const analyze = createLlmBatchAnalyzer(
        {
          model,
          apiBase,
          reasoning: { provider: model.split("-")[0], level: "high" },
        } as never,
        (async (params: {
          reasoning?: unknown;
          outputTokenLimit?: unknown;
        }) => {
          calls.push({
            reasoning: params.reasoning,
            outputTokenLimit: params.outputTokenLimit,
          });
          return {
            text: '{"digest":"Covered 0","relevantChunkIds":[0]}',
            completion: { status: "complete" },
          };
        }) as never,
      );
      const output = await analyze({
        question: "Summarize",
        chunks: [{ chunkIndex: 0, text: "Body" }],
      } as never);
      assert.equal(output.digest, "Covered 0");
      return calls[0];
    };
    assert.deepEqual(
      await digestCall("deepseek-flash", "https://api.deepseek.com/v1"),
      {
        reasoning: { provider: "deepseek", level: "none" },
        outputTokenLimit: { mode: "custom", tokens: 700 },
      },
      "thinking off where the provider allows it",
    );
    assert.deepEqual(
      await digestCall("gpt-5", "https://api.openai.com/v1"),
      {
        reasoning: { provider: "openai", level: "low" },
        outputTokenLimit: { mode: "custom", tokens: 700 + 1024 },
      },
      "else the lowest level, with that level's room to think",
    );
  });

  it("reads at most three batches at a time across papers and keeps each paper's digests in order", async function () {
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const papers = [
      buildPaper(),
      {
        ...buildPaper(),
        paperContext: { itemId: 20, contextItemId: 21, title: "Second Paper" },
      },
    ];
    const result = await readDocumentsExhaustively({
      papers,
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 4000,
      analyzeBatch: async (batch) => {
        started.push(`${batch.paperKey}#${batch.batchIndex}`);
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Later batches answer first, so order must come from the batch.
        await new Promise((resolve) =>
          setTimeout(resolve, 2 + (batch.batchCount - batch.batchIndex) * 2),
        );
        inFlight -= 1;
        return { digest: `Covered ${batch.batchIndex}`, relevantChunkIds: [] };
      },
    });
    assert.equal(maxInFlight, 3);
    assert.equal(result.status, "complete");
    for (const paper of result.papers) {
      assert.deepEqual(
        paper.digests.map((digest) => digest.batchIndex),
        paper.digests.map((_, index) => index),
      );
    }
    assert.deepEqual(
      started.slice(0, 2),
      ["10:11#0", "10:11#1"],
      "batches start in reading order",
    );
  });

  it("drops to one call at a time after a rate-limit answer and retries that batch after a pause", async function () {
    let limited = false;
    let inFlightSinceLimit = 0;
    let maxInFlightSinceLimit = 0;
    const attempts = new Map<number, number>();
    const retriedAt: number[] = [];
    let limitedAt = 0;
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      // One chunk a batch: nine batches, so the read goes on past the limit.
      batchTokenBudget: 8,
      finalTokenBudget: 4000,
      rateLimitBackoffMs: 30,
      analyzeBatch: async (batch) => {
        const attempt = (attempts.get(batch.batchIndex) || 0) + 1;
        attempts.set(batch.batchIndex, attempt);
        const sinceLimit = limited;
        if (batch.batchIndex === 1 && attempt === 2) {
          retriedAt.push(Date.now() - limitedAt);
        }
        if (sinceLimit) {
          inFlightSinceLimit += 1;
          maxInFlightSinceLimit = Math.max(
            maxInFlightSinceLimit,
            inFlightSinceLimit,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (sinceLimit) inFlightSinceLimit -= 1;
        if (batch.batchIndex === 1 && attempt === 1) {
          limited = true;
          limitedAt = Date.now();
          throw new Error(
            "429 Too Many Requests (https://api.example.invalid/v1/chat) - rate limit reached",
          );
        }
        return { digest: `Covered ${batch.batchIndex}`, relevantChunkIds: [] };
      },
    });
    assert.equal(result.status, "complete", "the limited batch was retried");
    assert.equal(result.receipt.totalChunks, 9);
    assert.equal(attempts.get(1), 2);
    assert.isAtLeast(retriedAt[0], 25, "after the pause");
    assert.equal(
      maxInFlightSinceLimit,
      1,
      "no two calls started after the limit overlap",
    );
  });

  it("processes every source chunk and returns a complete coverage receipt", async function () {
    const seen = new Set<number>();
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read the full text and explain the result.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      analyzeBatch: async (batch: ExhaustiveBatchInput) => {
        for (const chunk of batch.chunks) seen.add(chunk.chunkIndex);
        return {
          digest: `Covered ${batch.chunks.map((chunk) => chunk.chunkIndex).join(",")}`,
          relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
        };
      },
    });

    assert.deepEqual(
      [...seen].sort((a, b) => a - b),
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    assert.equal(result.status, "complete");
    assert.equal(result.receipt.processedChunks, 9);
    assert.equal(result.receipt.totalChunks, 9);
    assert.isTrue(result.receipt.complete);
    assert.include(result.receipt.text, "9/9 chunks");
  });

  it("keeps every batch represented when the synthesis context is compacted", async function () {
    const batchCountPerPaper = 20;
    const buildLongPaper = (
      itemId: number,
      contextItemId: number,
      title: string,
    ): { paperContext: PaperContextRef; pdfContext: PdfContext } => {
      const chunks = Array.from(
        { length: batchCountPerPaper },
        (_, index) => `Chunk ${index} ${"source ".repeat(900)}`,
      );
      return {
        paperContext: { itemId, contextItemId, title },
        pdfContext: {
          title,
          chunks,
          chunkMeta: buildChunkMetadata(chunks),
          chunkStats: [],
          docFreq: {},
          avgChunkLength: chunks[0].length,
          fullLength: chunks.join("\n\n").length,
        },
      };
    };
    const papers = [
      buildLongPaper(30, 31, "First Long Paper"),
      buildLongPaper(40, 41, "Second Long Paper"),
    ];
    const result = await readDocumentsExhaustively({
      papers,
      question: "Read every section.",
      batchTokenBudget: 1024,
      finalTokenBudget: 1024,
      analyzeBatch: async (batch) => ({
        digest: `DIGEST_${batch.paperContext.itemId}_${batch.batchIndex} ${"detail ".repeat(120)}`,
        relevantChunkIds: batch.chunks.map((chunk) => chunk.chunkIndex),
      }),
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(
      result.papers.map((paper) => paper.digests.length),
      [batchCountPerPaper, batchCountPerPaper],
    );
    for (const paper of papers) {
      assert.include(result.contextText, paper.paperContext.title);
      for (
        let batchIndex = 0;
        batchIndex < batchCountPerPaper;
        batchIndex += 1
      ) {
        assert.include(
          result.contextText,
          `DIGEST_${paper.paperContext.itemId}_${batchIndex}`,
        );
      }
    }
    assert.isAtMost(estimateTextTokens(result.contextText), 1024);
  });

  it("fails honestly when the synthesis budget cannot represent every digest", async function () {
    const batchCount = 120;
    const chunks = Array.from(
      { length: batchCount },
      (_, index) => `Chunk ${index} ${"source ".repeat(20)}`,
    );
    const paperContext: PaperContextRef = {
      itemId: 50,
      contextItemId: 51,
      title: "Oversized Digest Map",
    };
    const pdfContext: PdfContext = {
      title: paperContext.title,
      chunks,
      chunkMeta: buildChunkMetadata(chunks),
      chunkStats: [],
      docFreq: {},
      avgChunkLength: chunks[0].length,
      fullLength: chunks.join("\n\n").length,
    };

    let error: unknown;
    try {
      await readDocumentsExhaustively({
        papers: [{ paperContext, pdfContext }],
        question: "Read every section.",
        batchTokenBudget: 1,
        finalTokenBudget: 256,
        analyzeBatch: async (batch) => ({
          digest: `DIGEST_${batch.batchIndex}`,
          relevantChunkIds: [],
        }),
      });
    } catch (caught) {
      error = caught;
    }

    assert.instanceOf(error, Error);
    assert.include(
      (error as Error).message,
      "too small to preserve its coverage receipt and every batch digest",
    );
  });

  it("reports failed batches instead of claiming full coverage", async function () {
    let calls = 0;
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      retryCount: 0,
      analyzeBatch: async (batch) => {
        calls += 1;
        if (calls === 2) throw new Error("synthetic failure");
        return {
          digest: `Covered ${batch.batchIndex}`,
          relevantChunkIds: [],
        };
      },
    });

    assert.equal(result.status, "partial");
    assert.isFalse(result.receipt.complete);
    assert.isBelow(result.receipt.processedChunks, result.receipt.totalChunks);
    assert.isNotEmpty(result.receipt.missingChunkRanges);
  });

  it("retries failed batches and rejects model-invented chunk IDs", async function () {
    const attempts = new Map<number, number>();
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      retryCount: 1,
      analyzeBatch: async (batch) => {
        const attempt = (attempts.get(batch.batchIndex) || 0) + 1;
        attempts.set(batch.batchIndex, attempt);
        if (batch.batchIndex === 0 && attempt === 1) {
          throw new Error("transient failure");
        }
        return {
          digest: `Covered ${batch.batchIndex}`,
          relevantChunkIds: [batch.chunks[0].chunkIndex, 99999],
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(attempts.get(0), 2);
    assert.notInclude(
      result.papers[0].exactEvidence.map((chunk) => chunk.chunkIndex),
      99999,
    );
  });

  it("retries a digest that ran out of output room with a larger budget", async function () {
    // Retrying a truncated digest at the same budget truncates it again: on
    // Haiku 5.5 every paper_read full call failed this way.
    const budgets: number[] = [];
    const analyzeBatch = createLlmBatchAnalyzer(
      { model: "deepseek-flash", apiBase: "https://api.deepseek.com/v1" },
      (async (params: { outputTokenLimit?: { tokens?: number } }) => {
        budgets.push(params.outputTokenLimit?.tokens ?? 0);
        return budgets.length === 1
          ? {
              text: '{"digest":"Cut',
              completion: { status: "incomplete", reason: "output_limit" },
            }
          : {
              text: '{"digest":"Covered","relevantChunkIds":[]}',
              completion: { status: "complete" },
            };
      }) as never,
    );
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 4000,
      finalTokenBudget: 4000,
      retryCount: 1,
      analyzeBatch,
    });

    assert.equal(result.status, "complete");
    assert.deepEqual(budgets, [700, 1400]);
  });

  it("sizes a batch at half the reader window, between 1,024 and 32,000 tokens", function () {
    assert.equal(FULL_READ_MAX_BATCH_TOKENS, 32_000);
    assert.equal(resolveFullReadBatchTokenBudget(1_000_000), 32_000);
    assert.equal(resolveFullReadBatchTokenBudget(64_000), 32_000);
    assert.equal(resolveFullReadBatchTokenBudget(40_000), 20_000);
    assert.equal(resolveFullReadBatchTokenBudget(8_000), 4_000);
    assert.equal(resolveFullReadBatchTokenBudget(1_000), 1_024);
  });

  it("gives a digest a quarter of its batch's input tokens, never under 700", async function () {
    const small = [{ text: "Short chunk." }];
    assert.equal(defaultBatchDigestTokens(small), 700);
    const big = [
      { text: "word ".repeat(8000) },
      { text: "word ".repeat(8000) },
    ];
    const inputTokens =
      estimateTextTokens(big[0].text) + estimateTextTokens(big[1].text);
    const expected = Math.ceil(inputTokens * 0.25);
    assert.isAbove(expected, 700);
    assert.equal(defaultBatchDigestTokens(big), expected);

    // The reader hands that budget to every first attempt.
    const seen: Array<number | undefined> = [];
    await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 4000,
      finalTokenBudget: 4000,
      analyzeBatch: async (batch) => {
        seen.push(batch.maxTokens);
        return { digest: "Covered", relevantChunkIds: [] };
      },
    });
    assert.deepEqual(seen, [
      defaultBatchDigestTokens(
        buildPaper().pdfContext.chunks.map((text) => ({ text })),
      ),
    ]);
  });

  it("clamps a digest budget to the reader model's output limit", async function () {
    const sent: number[] = [];
    const analyze = createLlmBatchAnalyzer(
      {
        model: "deepseek-flash",
        apiBase: "https://api.deepseek.com/v1",
        profileOverride: { limits: { outputTokens: 1000 } },
      } as never,
      (async (params: { outputTokenLimit?: { tokens?: number } }) => {
        sent.push(params.outputTokenLimit?.tokens ?? 0);
        return {
          text: '{"digest":"Covered","relevantChunkIds":[]}',
          completion: { status: "complete" },
        };
      }) as never,
    );
    await analyze({
      question: "Summarize",
      chunks: [{ chunkIndex: 0, text: "Body" }],
      maxTokens: 5000,
    } as never);
    await analyze({
      question: "Summarize",
      chunks: [{ chunkIndex: 0, text: "Body" }],
      maxTokens: 600,
    } as never);
    assert.deepEqual(sent, [1000, 600]);
  });

  it("splits a batch whose digest stays cut off, and merges the halves", async function () {
    const calls: Array<{ ids: number[]; maxTokens?: number }> = [];
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 4000,
      finalTokenBudget: 4000,
      retryCount: 1,
      analyzeBatch: async (batch) => {
        const ids = batch.chunks.map((chunk) => chunk.chunkIndex);
        calls.push({ ids, maxTokens: batch.maxTokens });
        if (ids.length > 2) {
          throw new Error("Exhaustive document batch stopped (output_limit)");
        }
        return {
          digest: `Digest ${ids.join("+")}`,
          relevantChunkIds: [ids[0]],
        };
      },
    });

    assert.equal(result.status, "complete");
    assert.equal(result.papers[0].processedChunks, 9);
    assert.lengthOf(result.papers[0].digests, 1);
    assert.equal(result.papers[0].digests[0].batchIndex, 0);
    assert.deepEqual(
      result.papers[0].digests[0].chunkIndexes,
      [0, 1, 2, 3, 4, 5, 6, 7, 8],
    );
    // Halves read in order, split again where they still overflow.
    assert.equal(
      result.papers[0].digests[0].digest,
      "Digest 0+1 Digest 2 Digest 3+4 Digest 5+6 Digest 7+8",
    );
    assert.deepEqual(
      result.papers[0].exactEvidence.map((chunk) => chunk.chunkIndex).sort(),
      [0, 2, 3, 5, 7],
    );
    // The full batch is tried at its default budget, then at twice that.
    assert.deepEqual(calls[0].ids, [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    assert.deepEqual(calls[1].ids, calls[0].ids);
    assert.equal(calls[1].maxTokens, (calls[0].maxTokens as number) * 2);
  });

  it("ends partial when a single chunk keeps overflowing its digest", async function () {
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 4000,
      retryCount: 1,
      analyzeBatch: async (batch) => {
        const ids = batch.chunks.map((chunk) => chunk.chunkIndex);
        if (ids.includes(3)) {
          throw new Error("Exhaustive document batch stopped (output_limit)");
        }
        return { digest: `Digest ${ids.join("+")}`, relevantChunkIds: [] };
      },
    });

    assert.equal(result.status, "partial");
    assert.equal(result.papers[0].status, "partial");
    // Chunk 3 keeps overflowing alone, so only chunk 3 is lost; the rest of
    // its batch (4 and 5) and the other two batches are read.
    assert.equal(result.papers[0].processedChunks, 8);
    assert.deepEqual(result.papers[0].missingChunkRanges, ["3"]);
    const split = result.papers[0].digests.find(
      (digest) => digest.batchIndex === 1,
    );
    assert.deepEqual(split?.chunkIndexes, [4, 5]);
    assert.equal(split?.digest, "Digest 4 Digest 5");
    assert.isTrue(
      result.papers[0].warnings.some((warning) =>
        /batch 2\/3 missed chunks 3: .*output_limit/.test(warning),
      ),
    );
  });

  it("fails a batch only when no part of it was read", async function () {
    const result = await readDocumentsExhaustively({
      papers: [buildPaper()],
      question: "Read everything.",
      batchTokenBudget: 24,
      finalTokenBudget: 4000,
      retryCount: 1,
      analyzeBatch: async (batch) => {
        const ids = batch.chunks.map((chunk) => chunk.chunkIndex);
        if (ids.some((id) => id >= 3 && id <= 5)) {
          throw new Error("Exhaustive document batch stopped (output_limit)");
        }
        return { digest: `Digest ${ids.join("+")}`, relevantChunkIds: [] };
      },
    });

    assert.equal(result.papers[0].processedChunks, 6);
    assert.deepEqual(result.papers[0].missingChunkRanges, ["3-5"]);
    assert.isTrue(
      result.papers[0].warnings.some((warning) =>
        /batch 2\/3 failed: .*output_limit/.test(warning),
      ),
    );
  });

  it("reports unreadable papers independently in a multi-paper receipt", async function () {
    const readable = buildPaper();
    const unreadable = {
      paperContext: {
        itemId: 20,
        contextItemId: 21,
        title: "Unreadable Paper",
      },
    };
    const result = await readDocumentsExhaustively({
      papers: [readable, unreadable],
      question: "Read all selected papers.",
      batchTokenBudget: 24,
      finalTokenBudget: 1200,
      analyzeBatch: async (batch) => ({
        digest: `Covered ${batch.batchIndex}`,
        relevantChunkIds: [],
      }),
    });

    assert.equal(result.status, "partial");
    assert.deepEqual(
      result.papers.map((paper) => paper.status),
      ["complete", "unreadable"],
    );
    assert.equal(result.receipt.completePaperCount, 1);
    assert.equal(result.receipt.paperCount, 2);
    assert.deepEqual(result.papers[1].missingChunkRanges, [
      "no extractable text",
    ]);
    assert.deepEqual(result.receipt.missingChunkRanges, [
      "Unreadable Paper: no extractable text",
    ]);
    assert.include(
      result.receipt.text,
      "Missing coverage: Unreadable Paper: no extractable text",
    );
    assert.include(
      result.contextText,
      "Missing coverage: Unreadable Paper: no extractable text",
    );
  });

  it("stops immediately when exhaustive reading is cancelled", async function () {
    const controller = new AbortController();
    let calls = 0;
    let error: unknown;
    try {
      await readDocumentsExhaustively({
        papers: [buildPaper()],
        question: "Read everything.",
        batchTokenBudget: 24,
        finalTokenBudget: 1200,
        signal: controller.signal,
        analyzeBatch: async () => {
          calls += 1;
          controller.abort();
          throw new Error("cancelled");
        },
      });
    } catch (caught) {
      error = caught;
    }

    assert.equal(calls, 1);
    assert.instanceOf(error, Error);
    assert.equal((error as Error).message, "cancelled");
  });
});
