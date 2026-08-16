import { assert } from "chai";
import {
  runCodexAppServerConnectionTest,
  runProviderConnectionTest,
} from "../src/utils/providerConnectionTest";

describe("provider connection tests", function () {
  it("tests native Codex with the configured native app-server turn", async function () {
    let received:
      | {
          model: string;
          codexPath?: string;
        }
      | undefined;

    const result = await runCodexAppServerConnectionTest({
      modelName: "gpt-5.6-sol",
      codexPath: "C:\\tools\\codex.cmd",
      runTurn: async (params) => {
        received = params;
        return " native OK ";
      },
    });

    assert.equal(result.reply, "native OK");
    assert.deepInclude(received, {
      model: "gpt-5.6-sol",
      codexPath: "C:\\tools\\codex.cmd",
    });
  });

  it("tests the configured legacy Codex endpoint before using fallback", async function () {
    let requestedUrl = "";
    let requestedInit: RequestInit | undefined;
    let fallbackCalls = 0;
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      requestedUrl = String(input);
      requestedInit = init;
      return new Response('data: {"delta":"OK"}\n\ndata: [DONE]\n\n', {
        status: 200,
      });
    }) as typeof fetch;

    const result = await runProviderConnectionTest({
      fetchFn,
      protocol: "codex_responses",
      authMode: "codex_auth",
      apiBase: "https://example.test/custom/responses",
      apiKey: "access-token",
      codexAccountId: "account-123",
      modelName: "gpt-5.5",
      runCodexFallback: async () => {
        fallbackCalls += 1;
        return "fallback";
      },
    });

    assert.equal(result.reply, "OK");
    assert.equal(requestedUrl, "https://example.test/custom/responses");
    const headers = requestedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer access-token");
    assert.equal(headers.Originator, "codex");
    assert.equal(headers["ChatGPT-Account-ID"], "account-123");
    assert.equal(fallbackCalls, 0);
  });

  it("falls back only after a legacy Codex fetch transport failure", async function () {
    let directCalls = 0;
    let fallbackCalls = 0;
    const fetchFn = (async () => {
      directCalls += 1;
      throw new TypeError("NetworkError when attempting to fetch resource.");
    }) as typeof fetch;

    const result = await runProviderConnectionTest({
      fetchFn,
      protocol: "codex_responses",
      authMode: "codex_auth",
      apiBase: "https://chatgpt.com/backend-api/codex/responses",
      apiKey: "access-token",
      modelName: "gpt-5.6-terra",
      runCodexFallback: async (params) => {
        fallbackCalls += 1;
        assert.equal(params.model, "gpt-5.6-terra");
        return "fallback OK";
      },
    });

    assert.equal(result.reply, "fallback OK");
    assert.equal(directCalls, 1);
    assert.equal(fallbackCalls, 1);
  });

  it("does not hide a legacy Codex HTTP configuration error with fallback", async function () {
    let fallbackCalls = 0;
    const fetchFn = (async () =>
      new Response("wrong endpoint", { status: 404 })) as typeof fetch;

    let thrown: unknown;
    try {
      await runProviderConnectionTest({
        fetchFn,
        protocol: "codex_responses",
        authMode: "codex_auth",
        apiBase: "https://example.test/wrong/responses",
        apiKey: "access-token",
        modelName: "gpt-5.5",
        runCodexFallback: async () => {
          fallbackCalls += 1;
          return "fallback";
        },
      });
    } catch (error) {
      thrown = error;
    }

    assert.match(String(thrown), /HTTP 404: wrong endpoint/);
    assert.equal(fallbackCalls, 0);
  });
});
