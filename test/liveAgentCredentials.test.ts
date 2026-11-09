import { assert } from "chai";
import { resolveLiveAgentCredentials } from "../test-live/agent/liveAgentCredentials";

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

  it("prefers a Codex Direct group over a keyed group that lists the same model", async function () {
    const saved = (globalThis as any).Zotero;
    const group = (extra: object) => ({
      apiBase: "https://example.invalid",
      providerProtocol: "openai_responses",
      models: [{ model: "shared-model" }],
      ...extra,
    });
    const run = async (groups: object[]) => {
      (globalThis as any).Zotero = {
        Prefs: {
          get: (key: string) =>
            key.endsWith("modelProviderGroups") ? JSON.stringify(groups) : "",
        },
      };
      return resolveLiveAgentCredentials({ requestedModel: "shared-model" });
    };
    try {
      for (const order of [
        [group({ apiKey: "keyed" }), group({ authMode: "codex_auth" })],
        [group({ authMode: "codex_auth" }), group({ apiKey: "keyed" })],
      ]) {
        const both = await run(order);
        assert.equal(both?.authMode, "codex_auth");
        assert.equal(both?.apiKey, "");
      }
      const keyedOnly = await run([group({ apiKey: "keyed" })]);
      assert.equal(keyedOnly?.apiKey, "keyed");
      assert.isUndefined(keyedOnly?.authMode);
    } finally {
      (globalThis as any).Zotero = saved;
    }
  });
});
