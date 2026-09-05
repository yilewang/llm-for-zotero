import { assert } from "chai";
import type { ChatMessage } from "../src/utils/llmClient";
import {
  SUMMARY_TIMEOUT_MS,
  clearConversationSummary,
  flushPendingSummaries,
  getConversationSummaryEntry,
  resetConversationSummaryStateForTests,
  scheduleLLMSummary,
} from "../src/modules/contextPanel/conversationSummaryCache";
import { DEFAULT_LLM_CALL_TIMEOUT_MS } from "../src/utils/llmCallTimeout";

/** Enough pairs to cross SUMMARY_TRIGGER_PAIRS (10). */
function buildHistory(pairs: number): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (let i = 0; i < pairs; i += 1) {
    messages.push({ role: "user", content: `question ${i} about drift` });
    messages.push({ role: "assistant", content: `answer ${i} about drift` });
  }
  return messages;
}

const CONFIG = {
  model: "gpt-5.4",
  apiBase: "https://api.openai.com/v1",
  apiKey: "key",
  providerProtocol: "openai_chat_compat" as const,
};

describe("conversation summary cache", function () {
  afterEach(function () {
    resetConversationSummaryStateForTests();
  });

  it("uses its own timeout rather than the generic utility default", async function () {
    let seen: number | undefined;
    scheduleLLMSummary(1, buildHistory(12), {
      ...CONFIG,
      llmCall: async (params) => {
        seen = (params as unknown as { maxTokens?: number }).maxTokens;
        return "- drift grows with age";
      },
    });
    await flushPendingSummaries();

    assert.equal(SUMMARY_TIMEOUT_MS, 30_000);
    assert.notEqual(SUMMARY_TIMEOUT_MS, DEFAULT_LLM_CALL_TIMEOUT_MS);
    assert.isNumber(seen);
    assert.include(
      getConversationSummaryEntry(1)?.text || "",
      "drift grows with age",
    );
  });

  it("gives a transport failure one retry, then stops trying", async function () {
    let calls = 0;
    const config = {
      ...CONFIG,
      llmCall: async () => {
        calls += 1;
        throw new Error("503 Service Unavailable - upstream hiccup");
      },
    };

    for (let turn = 0; turn < 4; turn += 1) {
      scheduleLLMSummary(1, buildHistory(12 + turn), config);
      await flushPendingSummaries();
    }

    assert.equal(calls, 2);
  });

  it("stops after a single timeout, because the input only grows", async function () {
    let calls = 0;
    const config = {
      ...CONFIG,
      // isTimeoutError classifies on the message alone, so this is a faithful
      // timeout without waiting 30 seconds for a real one.
      llmCall: async () => {
        calls += 1;
        throw new Error(`LLM call timed out after ${SUMMARY_TIMEOUT_MS}ms`);
      },
    };

    for (let turn = 0; turn < 3; turn += 1) {
      scheduleLLMSummary(1, buildHistory(12 + turn), config);
      await flushPendingSummaries();
    }

    assert.equal(calls, 1);
  });

  it("never reaches the network when the profile cap cannot fit the call", async function () {
    let calls = 0;
    const config = {
      ...CONFIG,
      profileOverride: {
        forModel: "gpt-5.4",
        limits: { outputTokens: 300 },
      },
      llmCall: async () => {
        calls += 1;
        return "- unreachable";
      },
    };

    scheduleLLMSummary(1, buildHistory(12), config);
    await flushPendingSummaries();
    scheduleLLMSummary(1, buildHistory(13), config);
    await flushPendingSummaries();

    assert.equal(calls, 0);
    assert.isUndefined(getConversationSummaryEntry(1));
  });

  it("does not resume trying just because the conversation grew", async function () {
    // The regression test for the failure key: toSummarize.length changes on
    // every turn, so including it would reset the latch every turn and make
    // the whole backoff a no-op.
    let calls = 0;
    const config = {
      ...CONFIG,
      llmCall: async () => {
        calls += 1;
        throw new Error(`LLM call timed out after ${SUMMARY_TIMEOUT_MS}ms`);
      },
    };

    for (let turn = 0; turn < 6; turn += 1) {
      scheduleLLMSummary(1, buildHistory(12 + turn * 3), config);
      await flushPendingSummaries();
    }

    assert.equal(calls, 1);
  });

  it("tries again once the user switches model", async function () {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error(`LLM call timed out after ${SUMMARY_TIMEOUT_MS}ms`);
    };

    scheduleLLMSummary(1, buildHistory(12), { ...CONFIG, llmCall: failing });
    await flushPendingSummaries();
    scheduleLLMSummary(1, buildHistory(13), { ...CONFIG, llmCall: failing });
    await flushPendingSummaries();
    assert.equal(calls, 1);

    scheduleLLMSummary(1, buildHistory(14), {
      ...CONFIG,
      model: "gpt-5.4-pro",
      llmCall: failing,
    });
    await flushPendingSummaries();
    assert.equal(calls, 2);
  });

  it("tries again once the user fixes the API key", async function () {
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error("401 Unauthorized - Incorrect API key");
    };

    // Two attempts are allowed for a transport failure before the latch.
    for (let turn = 0; turn < 3; turn += 1) {
      scheduleLLMSummary(1, buildHistory(12 + turn), {
        ...CONFIG,
        llmCall: failing,
      });
      await flushPendingSummaries();
    }
    assert.equal(calls, 2);

    scheduleLLMSummary(1, buildHistory(15), {
      ...CONFIG,
      apiKey: "corrected-key",
      llmCall: failing,
    });
    await flushPendingSummaries();
    assert.equal(calls, 3);
  });

  it("resets the failure count after a success", async function () {
    let calls = 0;
    let shouldFail = true;
    const config = {
      ...CONFIG,
      llmCall: async () => {
        calls += 1;
        if (shouldFail) throw new Error("503 Service Unavailable");
        return "- drift grows with age";
      },
    };

    scheduleLLMSummary(1, buildHistory(12), config);
    await flushPendingSummaries();
    assert.equal(calls, 1);

    shouldFail = false;
    scheduleLLMSummary(1, buildHistory(13), config);
    await flushPendingSummaries();
    assert.equal(calls, 2);

    // The counter restarted, so the next run gets a full two attempts again.
    shouldFail = true;
    scheduleLLMSummary(1, buildHistory(14), config);
    await flushPendingSummaries();
    scheduleLLMSummary(1, buildHistory(15), config);
    await flushPendingSummaries();
    assert.equal(calls, 4);
  });

  it("clears the latch when the conversation is deleted", async function () {
    let calls = 0;
    const config = {
      ...CONFIG,
      llmCall: async () => {
        calls += 1;
        throw new Error(`LLM call timed out after ${SUMMARY_TIMEOUT_MS}ms`);
      },
    };

    scheduleLLMSummary(1, buildHistory(12), config);
    await flushPendingSummaries();
    scheduleLLMSummary(1, buildHistory(13), config);
    await flushPendingSummaries();
    assert.equal(calls, 1);

    // A fresh conversation can reuse the numeric key and must start clean.
    clearConversationSummary(1);
    scheduleLLMSummary(1, buildHistory(14), config);
    await flushPendingSummaries();
    assert.equal(calls, 2);
  });
});
