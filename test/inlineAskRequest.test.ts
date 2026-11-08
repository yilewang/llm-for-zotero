import { assert } from "chai";
import { describe, it } from "mocha";
import {
  INLINE_ASK_SYSTEM_MESSAGE,
  buildInlineAskContext,
  createInlineAskTurnRunner,
  resolveInlineAskSurroundingText,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskRequest";
import type { InlineAskModelTarget } from "../src/modules/contextPanel/selectionPrompt/inlineAskModel";
import type { ChatParams } from "../src/utils/llmClient";

const target: InlineAskModelTarget = {
  source: "sidebar",
  entryId: "entry-1",
  model: "model-x",
  apiBase: "https://x.example/v1",
  apiKey: "secret",
  authMode: "api_key",
  providerProtocol: "openai_chat_compat",
  providerLabel: "X",
  displayLabel: "Model X",
  advanced: {
    temperature: 0.4,
    outputTokenLimit: { mode: "auto" },
    inputTokenCap: 1000,
  },
};

describe("buildInlineAskContext", function () {
  it("names the paper and quotes the selection and its page", function () {
    const context = buildInlineAskContext({
      paper: {
        title: "Representational drift",
        firstCreator: "Ratzon",
        year: "2024",
      },
      selectedText: "a familiar stimulus drifts at a smaller rate",
      pageLabel: "3",
      surroundingText: "In the olfactory system, recordings showed decay.",
    });
    assert.include(context, "Representational drift");
    assert.include(context, "Ratzon");
    assert.include(context, "2024");
    assert.include(context, "a familiar stimulus drifts at a smaller rate");
    assert.include(context, "page 3");
    assert.include(context, "In the olfactory system");
  });

  it("works without a paper or surrounding text", function () {
    const context = buildInlineAskContext({
      paper: null,
      selectedText: "only this",
    });
    assert.include(context, "only this");
    assert.notInclude(context, "undefined");
  });
});

describe("resolveInlineAskSurroundingText", function () {
  it("uses the anchor text when it arrives in time", async function () {
    const text = await resolveInlineAskSurroundingText({
      resolveAnchorText: async () => "anchor context",
      getCachedPageText: () => "page text",
      timeoutMs: 1000,
    });
    assert.equal(text, "anchor context");
  });

  it("falls back to the cached page text on timeout, failure, or no anchor", async function () {
    for (const resolveAnchorText of [
      () => new Promise<string>(() => {}),
      async () => {
        throw new Error("no text");
      },
      async () => "  ",
    ]) {
      const text = await resolveInlineAskSurroundingText({
        resolveAnchorText,
        getCachedPageText: () => "page text",
        timeoutMs: 10,
      });
      assert.equal(text, "page text");
    }
  });

  it("caps the page text and returns empty when nothing is cached", async function () {
    const long = await resolveInlineAskSurroundingText({
      resolveAnchorText: async () => "",
      getCachedPageText: () => "x".repeat(20_000),
      timeoutMs: 10,
    });
    assert.isAtMost(long.length, 6000);
    const none = await resolveInlineAskSurroundingText({
      resolveAnchorText: async () => "",
      getCachedPageText: () => {
        throw new Error("no cache");
      },
      timeoutMs: 10,
    });
    assert.equal(none, "");
  });
});

describe("createInlineAskTurnRunner", function () {
  it("sends the model, system message, context and history with one scope", async function () {
    const requests: ChatParams[] = [];
    let contextCalls = 0;
    const runTurn = createInlineAskTurnRunner({
      getModel: () => ({
        target,
        reasoning: { provider: "openai", level: "high" },
      }),
      getContext: async () => {
        contextCalls += 1;
        return "CONTEXT";
      },
      call: (async (request: ChatParams, onDelta: (d: string) => void) => {
        requests.push(request);
        onDelta("ok");
        return { text: "ok", completion: { status: "complete" } };
      }) as any,
    });
    const deltas: string[] = [];
    const first = await runTurn({
      prompt: "Q1",
      history: [],
      onDelta: (delta) => deltas.push(delta),
    });
    await runTurn({
      prompt: "Q2",
      history: [
        { role: "user", content: "Q1" },
        { role: "assistant", content: "ok" },
      ],
      onDelta: () => {},
    });
    assert.equal(first.text, "ok");
    assert.deepEqual(deltas, ["ok"]);
    assert.equal(contextCalls, 1, "the context resolves once per card");
    const [one, two] = requests;
    assert.equal(one.prompt, "Q1");
    assert.equal(one.context, "CONTEXT");
    assert.equal(one.model, "model-x");
    assert.equal(one.apiBase, "https://x.example/v1");
    assert.equal(one.apiKey, "secret");
    assert.equal(one.authMode, "api_key");
    assert.equal(one.providerProtocol, "openai_chat_compat");
    assert.deepEqual(one.reasoning, { provider: "openai", level: "high" });
    assert.equal(one.temperature, 0.4);
    assert.equal(one.inputTokenCap, 1000);
    assert.deepEqual(one.systemMessages, [INLINE_ASK_SYSTEM_MESSAGE]);
    assert.deepEqual(two.history, [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "ok" },
    ]);
    assert.isOk(one.requestScope);
    assert.strictEqual(
      one.requestScope,
      two.requestScope,
      "one provider request scope per card session",
    );
    assert.property(one.requestScope as object, "operationId");
  });

  it("reports an empty answer as an error message", async function () {
    const runTurn = createInlineAskTurnRunner({
      getModel: () => ({ target }),
      getContext: async () => "",
      call: (async () => ({
        text: "",
        completion: { status: "blocked", reason: "refusal" },
      })) as any,
    });
    const result = await runTurn({
      prompt: "Q",
      history: [],
      onDelta: () => {},
    });
    assert.equal(result.text, "");
    assert.equal(result.errorMessage, "The model refused this request.");
  });

  it("reads the model for each turn, so a follow-up uses a newly chosen one", async function () {
    const requests: ChatParams[] = [];
    let current: { target: InlineAskModelTarget; reasoning?: any } = {
      target,
    };
    const runTurn = createInlineAskTurnRunner({
      getModel: () => current,
      getContext: async () => "",
      call: (async (request: ChatParams) => {
        requests.push(request);
        return { text: "ok", completion: { status: "complete" } };
      }) as any,
    });
    await runTurn({ prompt: "Q1", history: [], onDelta: () => {} });
    current = {
      target: { ...target, model: "model-y", entryId: "entry-2" },
      reasoning: { provider: "openai", level: "low" },
    };
    await runTurn({ prompt: "Q2", history: [], onDelta: () => {} });
    assert.deepEqual(
      requests.map((request) => request.model),
      ["model-x", "model-y"],
    );
    assert.deepEqual(requests[1].reasoning, {
      provider: "openai",
      level: "low",
    });
    assert.strictEqual(requests[0].requestScope, requests[1].requestScope);
  });

  it("returns the no-model message when no model is chosen", async function () {
    const runTurn = createInlineAskTurnRunner({
      getModel: () => null,
      getContext: async () => "",
      noModelMessage: "No model.",
      call: (async () => {
        throw new Error("must not call");
      }) as any,
    });
    const result = await runTurn({
      prompt: "Q",
      history: [],
      onDelta: () => {},
    });
    assert.deepEqual(result, { text: "", errorMessage: "No model." });
  });

  it("asks briefly, in the user's language, without citation markers", function () {
    assert.match(INLINE_ASK_SYSTEM_MESSAGE, /brief/i);
    assert.match(INLINE_ASK_SYSTEM_MESSAGE, /language/i);
    assert.match(INLINE_ASK_SYSTEM_MESSAGE, /citation/i);
  });
});
