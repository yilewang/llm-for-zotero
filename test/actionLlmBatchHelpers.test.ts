import { assert } from "chai";
import {
  callActionLlm,
  collectActionLlmBatchResults,
  extractJsonArray,
} from "../src/agent/actions/llmBatchHelpers";
import type { ActionExecutionContext } from "../src/agent/actions";

function makeContext(
  overrides: Partial<ActionExecutionContext> = {},
): ActionExecutionContext {
  return {
    registry: {} as never,
    zoteroGateway: {} as never,
    libraryID: 1,
    confirmationMode: "native_ui",
    onProgress: () => {},
    requestConfirmation: async () => ({ approved: true }),
    ...overrides,
  };
}

describe("action LLM batch helpers", function () {
  describe("collectActionLlmBatchResults", function () {
    it("runs every batch when nothing cancels the run", async function () {
      const seen: number[][] = [];
      const results = await collectActionLlmBatchResults(
        [1, 2, 3, 4, 5],
        2,
        async (batch) => {
          seen.push(batch);
          return batch;
        },
      );

      assert.deepEqual(seen, [[1, 2], [3, 4], [5]]);
      assert.deepEqual(results, [1, 2, 3, 4, 5]);
    });

    it("stops between batches once the run is cancelled", async function () {
      // Batches are sequential and each one is a bounded model call, so a
      // long queue is only interruptible here. Without the check a cancelled
      // organize run would keep calling the model for minutes.
      const controller = new AbortController();
      const seen: number[][] = [];
      const results = await collectActionLlmBatchResults(
        [1, 2, 3, 4, 5, 6],
        2,
        async (batch) => {
          seen.push(batch);
          controller.abort();
          return batch;
        },
        { signal: controller.signal },
      );

      assert.deepEqual(seen, [[1, 2]]);
      assert.deepEqual(results, [1, 2]);
    });

    /**
     * Each batch is one bounded model call, so a blank reply or a timeout on
     * batch N says nothing about batches 1..N-1. Losing their results turns a
     * single hiccup into "every item on this review page falls back to
     * deterministic suggestions", which is exactly what the user sees.
     */
    it("keeps completed batches when a later batch fails", async function () {
      const failures: Array<{ index: number; message: string }> = [];
      const results = await collectActionLlmBatchResults(
        [1, 2, 3, 4, 5, 6],
        2,
        async (batch) => {
          if (batch[0] === 3) throw new Error("empty: no text in 800 tokens");
          return batch;
        },
        {
          onBatchError: (error, index) =>
            failures.push({
              index,
              message: error instanceof Error ? error.message : String(error),
            }),
        },
      );

      assert.deepEqual(results, [1, 2, 5, 6]);
      assert.deepEqual(failures, [
        { index: 1, message: "empty: no text in 800 tokens" },
      ]);
    });

    it("rethrows the first failure when no batch succeeds", async function () {
      // A total outage must still reach the action's "AI suggestions
      // unavailable" branch rather than looking like "the model had nothing".
      let thrown: unknown;
      try {
        await collectActionLlmBatchResults([1, 2, 3, 4], 2, async (batch) => {
          throw new Error(`batch ${batch[0]} failed`);
        });
      } catch (error) {
        thrown = error;
      }

      assert.instanceOf(thrown, Error);
      assert.equal((thrown as Error).message, "batch 1 failed");
    });

    it("does not rethrow when a failing batch produced no items to lose", async function () {
      const results = await collectActionLlmBatchResults(
        [1, 2, 3],
        2,
        async (batch) => (batch[0] === 1 ? [] : batch),
      );

      assert.deepEqual(results, [3]);
    });

    it("stops after a failed batch once the run is cancelled", async function () {
      const controller = new AbortController();
      const seen: number[][] = [];
      const results = await collectActionLlmBatchResults(
        [1, 2, 3, 4, 5, 6],
        2,
        async (batch) => {
          seen.push(batch);
          if (batch[0] === 3) {
            controller.abort();
            throw new Error("timeout");
          }
          return batch;
        },
        { signal: controller.signal },
      );

      assert.deepEqual(seen, [
        [1, 2],
        [3, 4],
      ]);
      assert.deepEqual(results, [1, 2]);
    });
  });

  describe("callActionLlm", function () {
    it("returns empty without calling the model when none is configured", async function () {
      assert.equal(
        await callActionLlm({
          ctx: makeContext(),
          prompt: "tag these",
          maxTokens: 800,
          timeoutMs: 30_000,
        }),
        "",
      );
    });

    it("throws with the provider's own words when the call fails", async function () {
      // The actions have a fallback path keyed on a thrown error. Returning
      // "" here would silently look like "the model had no suggestions".
      let thrown: unknown;
      try {
        await callActionLlm({
          ctx: makeContext({
            llm: {
              model: "gpt-5.4",
              apiBase: "https://api.openai.com/v1",
              apiKey: "key",
              providerProtocol: "openai_chat_compat",
              llmCall: async () => {
                throw new Error("429 Too Many Requests - slow down");
              },
            },
          }),
          prompt: "tag these",
          maxTokens: 800,
          timeoutMs: 30_000,
        });
      } catch (error) {
        thrown = error;
      }

      assert.instanceOf(thrown, Error);
      assert.include((thrown as Error).message, "transport");
      assert.include((thrown as Error).message, "slow down");
    });

    it("propagates the action's cancellation into an in-flight model call", async function () {
      const controller = new AbortController();
      let sawSignal = false;
      let abortReachedTheCall = false;
      await callActionLlm({
        ctx: makeContext({
          signal: controller.signal,
          llm: {
            model: "gpt-5.4",
            apiBase: "https://api.openai.com/v1",
            apiKey: "key",
            providerProtocol: "openai_chat_compat",
            llmCall: async (params) => {
              const signal = (params as unknown as { signal?: AbortSignal })
                .signal;
              sawSignal = Boolean(signal);
              // The user hits stop while this request is outstanding.
              controller.abort();
              abortReachedTheCall = Boolean(signal?.aborted);
              return "[]";
            },
          },
        }),
        prompt: "tag these",
        maxTokens: 800,
        timeoutMs: 30_000,
      });

      assert.isTrue(sawSignal, "the model call received a signal");
      assert.isTrue(abortReachedTheCall, "stopping the action aborted it");
    });
  });

  describe("extractJsonArray", function () {
    it("pulls an array out of surrounding prose", function () {
      assert.equal(
        extractJsonArray('Here you go: [{"itemId":1}] — done'),
        '[{"itemId":1}]',
      );
      assert.isNull(extractJsonArray("no array here"));
    });
  });
});
