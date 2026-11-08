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

  it("prefers a keyed group over a Codex Direct group that lists the same model", async function () {
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
      const both = await run([
        group({ authMode: "codex_auth", apiKey: "" }),
        group({ apiKey: "keyed" }),
      ]);
      assert.equal(both?.apiKey, "keyed");
      assert.isUndefined((both as any)?.authMode);
      const codexOnly = await run([group({ authMode: "codex_auth" })]);
      assert.equal((codexOnly as any)?.authMode, "codex_auth");
    } finally {
      (globalThis as any).Zotero = saved;
    }
  });
});
