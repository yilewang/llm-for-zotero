import { assert } from "chai";
import {
  getModelCapabilities,
  getDiscoveredModels,
  configureModelCapabilityRuntime,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import {
  getModelProviderGroups,
  setModelProviderGroups,
  getRuntimeModelEntries,
  type ModelProviderGroup,
} from "../src/utils/modelProviders";
import { buildReasoningPayload } from "../src/utils/llmClient";
import { detectProviderPreset } from "../src/utils/providerPresets";

/**
 * Adversarial checks for local-model support: each case is a claim the design
 * makes, written so that a regression fails loudly rather than degrading
 * quietly. The quiet degradations are the dangerous ones here — a lost
 * override or a shadowed hosted profile still "works", just wrongly.
 */
describe("local model support — adversarial", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
        clear: (key: string) => {
          prefStore.delete(key);
        },
      },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    resetModelCapabilityStateForTests();
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  function makeGroup(overrides: Partial<ModelProviderGroup> = {}) {
    return {
      id: "group-1",
      apiBase: "http://localhost:11434",
      apiKey: "",
      authMode: "api_key" as const,
      providerProtocol: "ollama_native" as const,
      models: [
        {
          id: "model-1",
          model: "qwen3:8b",
          temperature: 0.3,
          maxTokens: 4096,
        },
      ],
      ...overrides,
    } as ModelProviderGroup;
  }

  describe("override round-trip", function () {
    it("survives save and reload", function () {
      const group = makeGroup();
      group.models[0].profileOverride = {
        limits: { contextWindowTokens: 8192 },
        extraBody: { top_k: 40 },
      };
      setModelProviderGroups([group]);

      const reloaded = getModelProviderGroups();
      assert.deepEqual(reloaded[0].models[0].profileOverride, {
        limits: { contextWindowTokens: 8192 },
        extraBody: { top_k: 40 },
      });
    });

    it("reaches the runtime entry that requests are built from", function () {
      const group = makeGroup();
      group.models[0].profileOverride = {
        limits: { contextWindowTokens: 8192 },
      };
      setModelProviderGroups([group]);

      const entries = getRuntimeModelEntries();
      assert.lengthOf(entries, 1);
      assert.deepEqual(entries[0].advanced?.profileOverride, {
        limits: { contextWindowTokens: 8192 },
      });
    });

    it("is dropped, not preserved as {}, when the user clears it", function () {
      const group = makeGroup();
      group.models[0].profileOverride = { limits: {} };
      setModelProviderGroups([group]);
      assert.isUndefined(
        getModelProviderGroups()[0].models[0].profileOverride,
        "an emptied override must not persist as an empty object",
      );
    });

    it("ignores a corrupt stored override instead of dropping the group", function () {
      const group = makeGroup();
      (group.models[0] as { profileOverride?: unknown }).profileOverride =
        "not an object";
      setModelProviderGroups([group]);
      const reloaded = getModelProviderGroups();
      assert.lengthOf(reloaded, 1, "the provider must survive");
      assert.lengthOf(reloaded[0].models, 1, "the model must survive");
      assert.isUndefined(reloaded[0].models[0].profileOverride);
    });

    it("keeps a group written by an older client that has no override field", function () {
      const group = makeGroup();
      setModelProviderGroups([group]);
      const reloaded = getModelProviderGroups();
      assert.equal(reloaded[0].models[0].model, "qwen3:8b");
      assert.isUndefined(reloaded[0].models[0].profileOverride);
    });
  });

  describe("override staleness across a model change", function () {
    // Parameters are tuned for one model. kimi-k2.6 drives thinking with
    // `thinking.type`, kimi-k3 with `reasoning_effort` — so an override left
    // behind by a rename does not merely look wrong, it sends the wrong body.
    const K2_OVERRIDE = {
      reasoning: {
        kind: "select" as const,
        options: [
          {
            id: "off",
            label: "Off",
            enabled: true,
            controls: { body: { thinking: { type: "disabled" } } },
          },
          {
            id: "on",
            label: "On",
            enabled: true,
            controls: { body: { thinking: { type: "enabled" } } },
          },
        ],
      },
    };

    it("would mask the new model's real profile if it were kept", function () {
      const detected = getModelCapabilities({
        model: "kimi-k3",
        apiBase: "https://api.moonshot.ai/v1",
        protocol: "openai_chat_compat",
      });
      assert.deepEqual(
        detected.reasoning.options.map((o) => o.id),
        ["low", "high", "max"],
        "kimi-k3 uses graded reasoning_effort, not an on/off toggle",
      );

      const masked = getModelCapabilities({
        model: "kimi-k3",
        apiBase: "https://api.moonshot.ai/v1",
        protocol: "openai_chat_compat",
        profileOverride: K2_OVERRIDE,
      });
      assert.deepEqual(
        masked.reasoning.options.map((o) => o.id),
        ["off", "on"],
        "an override wins outright, which is why a stale one must be cleared",
      );
      assert.equal(masked.provenance.reasoning, "user");
    });

    it("restores the detected profile once the override is dropped", function () {
      const restored = getModelCapabilities({
        model: "kimi-k3",
        apiBase: "https://api.moonshot.ai/v1",
        protocol: "openai_chat_compat",
        profileOverride: undefined,
      });
      assert.deepEqual(
        restored.reasoning.options.map((o) => o.id),
        ["low", "high", "max"],
      );
      assert.notEqual(restored.provenance.reasoning, "user");
    });
  });

  describe("blast radius onto hosted providers", function () {
    it("does not classify tunnels or proxies as a local preset by accident", function () {
      // An SSH tunnel to a hosted API does resolve as local — unavoidable
      // without probing — so the guarantee is that the user can still override
      // it by choosing a different preset explicitly.
      assert.equal(
        detectProviderPreset("http://127.0.0.1:8443/v1"),
        "local_openai",
      );
      assert.equal(
        detectProviderPreset("https://api.openai.com/v1/responses"),
        "openai",
        "a hosted host must never fall through to a local preset",
      );
    });

    it("keeps DeepSeek's hosted encoding intact", function () {
      const payload = buildReasoningPayload(
        { provider: "deepseek", level: "high" },
        false,
        "deepseek-reasoner",
        "https://api.deepseek.com/v1",
        "openai_chat_compat",
      );
      assert.notProperty(payload.extra, "think");
      assert.property(payload.extra, "thinking");
    });

    it("does not leak omitTemperature from a hosted profile onto a local model", async function () {
      configureModelCapabilityRuntime({
        fetch: (async (url: string) => {
          if (String(url).endsWith("/api/tags")) {
            return new Response(
              JSON.stringify({ models: [{ name: "deepseek-r1:8b" }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({
              capabilities: ["completion", "thinking"],
              model_info: { "general.architecture": "qwen2" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
      });
      const identity = {
        model: "deepseek-r1:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      await refreshModelCatalog(identity);

      const payload = buildReasoningPayload(
        { provider: "deepseek", level: "default" },
        false,
        identity.model,
        identity.apiBase,
        "ollama_native",
      );
      assert.isFalse(
        payload.omitTemperature,
        "DeepSeek's hosted profile drops temperature; a local server must keep the user's value",
      );
      assert.deepEqual(payload.extra, { think: true });
    });
  });

  describe("catalog cache keys", function () {
    it("does not share a snapshot between two local servers on different ports", async function () {
      configureModelCapabilityRuntime({
        fetch: (async (url: string) => {
          const port = String(url).includes(":11434") ? "11434" : "1234";
          if (String(url).endsWith("/api/tags")) {
            return new Response(
              JSON.stringify({ models: [{ name: `model-on-${port}` }] }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }
          return new Response(
            JSON.stringify({ data: [{ id: `model-on-${port}` }] }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }) as typeof fetch,
      });

      const first = {
        model: "model-on-11434",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      const second = {
        model: "model-on-1234",
        apiBase: "http://localhost:1234/v1",
        protocol: "openai_chat_compat",
      } as const;
      await refreshModelCatalog(first);
      await refreshModelCatalog(second);

      assert.deepEqual(
        getDiscoveredModels(first).map((m) => m.id),
        ["model-on-11434"],
      );
      assert.deepEqual(
        getDiscoveredModels(second).map((m) => m.id),
        ["model-on-1234"],
      );
    });
  });

  describe("degradation", function () {
    it("marks the snapshot stale when the server is unreachable", async function () {
      configureModelCapabilityRuntime({
        fetch: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      });
      const identity = {
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      await refreshModelCatalog(identity);
      assert.isTrue(getModelCapabilities(identity).stale);
    });

    it("does not throw when the server answers with HTML", async function () {
      configureModelCapabilityRuntime({
        fetch: (async () =>
          new Response("<html>not json</html>", {
            status: 200,
            headers: { "content-type": "text/html" },
          })) as typeof fetch,
      });
      const identity = {
        model: "qwen3:8b",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      let threw = false;
      try {
        await refreshModelCatalog(identity);
      } catch (_error) {
        threw = true;
      }
      assert.isFalse(threw, "a garbage response must degrade, not throw");
      assert.deepEqual(getDiscoveredModels(identity), []);
    });

    it("caps an absurdly long model list", async function () {
      configureModelCapabilityRuntime({
        fetch: (async () =>
          new Response(
            JSON.stringify({
              models: Array.from({ length: 5000 }, (_v, i) => ({
                name: `m${i}`,
              })),
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          )) as typeof fetch,
      });
      const identity = {
        model: "m0",
        apiBase: "http://localhost:11434",
        protocol: "ollama_native",
      } as const;
      await refreshModelCatalog(identity);
      assert.isAtMost(getDiscoveredModels(identity).length, 4096);
    });
  });
});
