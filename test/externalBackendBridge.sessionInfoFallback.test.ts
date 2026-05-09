import { assert } from "chai";
import { describe, it } from "mocha";
import { fetchExternalBridgeSessionInfo } from "../src/agent/externalBackendBridge";

describe("external bridge session-info fallback", function () {
  it("continues probing after a 404 from an earlier candidate", async function () {
    const originalFetch = globalThis.fetch;
    const calls: string[] = [];
    let requestCount = 0;

    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      requestCount += 1;
      if (requestCount === 1) {
        return new Response("not found", { status: 404 }) as Response;
      }
      return new Response(
        JSON.stringify({
          session: {
            originalConversationKey: "42",
            scopedConversationKey: "42::paper:7:9",
            providerSessionId: "sess-ok",
            scopeType: "paper",
            scopeId: "7:9",
            scopeLabel: "Paper",
          },
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ) as Response;
    }) as typeof fetch;

    try {
      const session = await fetchExternalBridgeSessionInfo({
        baseUrl: "http://127.0.0.1:19787",
        conversationKey: 42,
        scopeType: "paper",
        scopeId: "7:9",
        scopeLabel: "Paper",
      });
      assert.equal(session?.providerSessionId, "sess-ok");
      assert.isAtLeast(calls.length, 2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
