import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live-agent/liveAgentCredentials";

describe("live workflow credential selection", function () {
  it("uses the selected run model without relying on a chrome global environment export", async function () {
    const saved = (globalThis as any).Zotero;
    try {
      (globalThis as any).Zotero = {
        Prefs: {
          get: (key: string) =>
            key.endsWith("modelProviderGroups")
              ? JSON.stringify([
                  {
                    apiKey: "test-only",
                    apiBase: "https://example.invalid",
                    providerProtocol: "anthropic_messages",
                    models: [{ model: "fixture-selected" }],
                  },
                ])
              : "",
        },
      };
      const result = await resolveLiveAgentCredentials({
        requestedModel: "fixture-selected",
      });
      assert.equal(result?.model, "fixture-selected");
    } finally {
      (globalThis as any).Zotero = saved;
    }
  });
});
