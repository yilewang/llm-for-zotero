import { assert } from "chai";
import { callSemanticCompletion } from "../src/agent/model/semanticTransport";
import { resolvedAgentRequest } from "./helpers/resolvedAgentRequest";

describe("semantic completion transport in Zotero chrome", function () {
  it("keeps structured interpretation on the bounded utility reasoning policy", async function () {
    let captured: any;
    await callSemanticCompletion(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "File this paper",
        model: "gpt-5.4",
        apiBase: "https://api.openai.com/v1",
        apiKey: "fixture",
        providerProtocol: "openai_chat_compat",
        reasoning: { provider: "openai", level: "high" },
      }),
      {
        prompt: "Interpret request",
        jsonBudget: 5000,
        timeoutMs: 20000,
        llmCall: async (params) => {
          captured = params;
          return { text: "{}", completion: { status: "complete" } };
        },
      },
    );
    assert.equal(captured.reasoning.level, "low");
    assert.isAtMost(captured.outputTokenLimit.tokens, 7000);
  });
  it("binds configured API credentials instead of inheriting an unrelated UI login", async function () {
    let authMode: unknown;
    const result = await callSemanticCompletion(
      resolvedAgentRequest({
        conversationKey: 1,
        mode: "agent",
        userText: "File this",
        model: "deepseek-chat",
        apiBase: "https://api.deepseek.com",
        apiKey: "fixture",
      }),
      {
        prompt: "structured request",
        jsonBudget: 100,
        timeoutMs: 1000,
        llmCall: async (params) => {
          authMode = params.authMode;
          return { text: "{}", completion: { status: "complete" } };
        },
      },
    );
    assert.isTrue(result.ok);
    assert.equal(authMode, "api_key");
  });
  it("uses the native window cancellation controller when chrome lacks one", async function () {
    const globals = globalThis as any;
    const saved = {
      AbortController: globals.AbortController,
      Zotero: globals.Zotero,
      fetch: globals.fetch,
    };
    const calls: string[] = [];
    try {
      globals.AbortController = undefined;
      globals.Zotero = {
        getMainWindow: () => ({ AbortController: saved.AbortController }),
      };
      globals.fetch = async (url: string, init: any) => {
        calls.push(url);
        assert.exists(init.signal);
        return {
          ok: true,
          json: async () =>
            url.endsWith("healthz")
              ? { capabilities: ["structured_completion_v1"] }
              : { text: '{"intent":"read"}' },
        };
      };
      const result = await callSemanticCompletion(
        resolvedAgentRequest({
          conversationKey: 1,
          mode: "agent",
          userText: "Read this",
          semanticProvider: {
            kind: "claude",
            baseUrl: "http://127.0.0.1:19788",
          },
        }),
        { prompt: "structured request", jsonBudget: 100, timeoutMs: 1000 },
      );
      assert.deepEqual(result, { ok: true, text: '{"intent":"read"}' });
      assert.lengthOf(calls, 2);
    } finally {
      Object.assign(globals, saved);
    }
  });
});
