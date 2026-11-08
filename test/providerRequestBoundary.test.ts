import { assert } from "chai";
import { ESLint } from "eslint";
import {
  createProviderRequestScope,
  sendProviderRequest,
} from "../src/utils/providerTransport";

describe("provider dispatch boundary", function () {
  it("leaves other providers' authentication, signal, and payload untouched", async function () {
    const init = {
      method: "POST",
      headers: {
        Authorization: "Bearer test",
        "anthropic-version": "2023-06-01",
      },
      body: "{}",
      signal: new AbortController().signal,
    };
    let captured: RequestInit | undefined;
    await sendProviderRequest({
      url: "https://api.anthropic.com/v1/messages",
      scope: createProviderRequestScope(),
      init,
      fetchFn: (async (_url, sent) => {
        captured = sent;
        return new Response("OK");
      }) as typeof fetch,
    });
    assert.strictEqual(captured, init);
  });

  it("sends the OpenCode session header on the /inference routes of both products", async function () {
    for (const url of [
      "https://opencode.ai/inference/go/v1/chat/completions",
      "https://opencode.ai/inference/v1/chat/completions",
    ]) {
      let captured: RequestInit | undefined;
      await sendProviderRequest({
        url,
        scope: { operationId: "op-1" },
        init: { headers: { Authorization: "Bearer test" } },
        fetchFn: (async (_url, sent) => {
          captured = sent;
          return new Response("OK");
        }) as typeof fetch,
      });
      assert.equal(
        new Headers(captured?.headers).get("x-opencode-session"),
        "op-1",
        url,
      );
    }
  });

  it("refuses an empty OpenCode session before dispatch", async function () {
    let sent = false;
    try {
      await sendProviderRequest({
        url: "https://opencode.ai/zen/go/v1/chat/completions",
        scope: { operationId: "" },
        init: {},
        fetchFn: (async () => {
          sent = true;
          return new Response("OK");
        }) as typeof fetch,
      });
      assert.fail("should reject missing session");
    } catch (error) {
      assert.include(String(error), "stable request session");
    }
    assert.isFalse(sent);
  });

  it("creates distinct sessions for separate standalone operations", function () {
    assert.notDeepEqual(
      createProviderRequestScope(),
      createProviderRequestScope(),
    );
  });

  it("lint rejects raw HTTP in adapters, settings tests, and the retry owner", async function () {
    this.timeout(15000);
    const eslint = new ESLint();
    for (const [filePath, code] of [
      [
        "src/agent/model/newAdapter.ts",
        "async function run() { return getFetch()('https://example.test', {}); }",
      ],
      [
        "src/utils/providerConnectionTest.ts",
        "async function run(params) { return params.fetchFn('https://example.test', {}); }",
      ],
      [
        "src/utils/llmClient.ts",
        "async function postWithTemperatureFallback() { return getFetch()('https://example.test', {}); }",
      ],
    ]) {
      const [result] = await eslint.lintText(code, { filePath });
      assert.isTrue(
        result.messages.some((m) => m.ruleId === "no-restricted-syntax"),
        `${filePath}: ${JSON.stringify(result.messages)}`,
      );
    }
  });
});
