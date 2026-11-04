import { assert } from "chai";
import {
  classifyModelDiscoveryHttpError,
  configureModelCapabilityRuntime,
  ensureModelCapabilities,
  getDiscoveredModels,
  getModelCapabilities,
  getModelCatalogStatus,
  getModelDiscoveryAdapter,
  hasModelDiscoveryAdapter,
  invalidateModelCatalog,
  isModelCatalogExpired,
  listModelDiscoveryProviders,
  MODEL_DISCOVERY_CACHE_TTL_MS,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";
import { attachProviderModelSelect } from "../src/modules/preferenceScript";
import {
  buildProviderCatalogIdentity,
  createProviderModelEntry,
  getModelProviderGroups,
  getRuntimeModelEntries,
  refreshConfiguredProviderModelCatalogs,
  setModelProviderGroups,
  type ModelProviderGroup,
} from "../src/utils/modelProviders";
import {
  buildProviderModelSelectRows,
  formatModelDiscoveryStatusHint,
  resolveModelEntryMode,
  resolveProviderModelFetchStatus,
  sortModelOptions,
} from "../src/utils/providerModelPicker";
import { FakePrefDocument, flushAsync } from "./helpers/fakePreferencesDom";

let originalZotero: typeof Zotero | undefined;

describe("ModelDiscovery architecture & SiliconFlow implementation", function () {
  before(function () {
    originalZotero = globalThis.Zotero;
  });

  beforeEach(function () {
    resetModelCapabilityStateForTests();
    const prefStore = new Map<string, unknown>();
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key),
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
      },
    } as typeof Zotero;
  });

  afterEach(function () {
    resetModelCapabilityStateForTests();
  });

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  describe("1. Lightweight ModelDiscovery interface & Phase 1 registry", function () {
    it("registers siliconflow and llmtr and resolves endpoint variants", function () {
      assert.deepEqual(listModelDiscoveryProviders(), ["siliconflow", "llmtr"]);
      assert.isTrue(hasModelDiscoveryAdapter({ provider: "siliconflow" }));
      assert.isTrue(
        hasModelDiscoveryAdapter({ apiBase: "https://api.siliconflow.cn/v1" }),
      );
      assert.isTrue(
        hasModelDiscoveryAdapter({ apiBase: "https://api.siliconflow.com/v1" }),
      );
      assert.isTrue(hasModelDiscoveryAdapter({ provider: "llmtr" }));
      assert.isTrue(
        hasModelDiscoveryAdapter({ apiBase: "https://llmtr.com/v1" }),
      );
      assert.isFalse(
        hasModelDiscoveryAdapter({
          provider: "openai",
          apiBase: "https://api.openai.com/v1",
        }),
      );

      const adapter = getModelDiscoveryAdapter({ provider: "siliconflow" });
      assert.isNotNull(adapter);
      assert.equal(
        adapter!.buildEndpoint(""),
        "https://api.siliconflow.cn/v1/models?sub_type=chat",
      );
      assert.equal(
        adapter!.buildEndpoint("https://api.siliconflow.cn/v1"),
        "https://api.siliconflow.cn/v1/models?sub_type=chat",
      );
      assert.equal(
        adapter!.buildEndpoint(
          "https://api.siliconflow.com/v1/chat/completions",
        ),
        "https://api.siliconflow.com/v1/models?sub_type=chat",
      );
      assert.equal(
        adapter!.buildEndpoint(
          "https://api.siliconflow.cn/v1/models?type=text",
        ),
        "https://api.siliconflow.cn/v1/models?type=text",
      );

      const llmtr = getModelDiscoveryAdapter({ provider: "llmtr" });
      assert.isNotNull(llmtr);
      assert.equal(llmtr!.buildEndpoint(""), "https://llmtr.com/v1/models");
      assert.equal(
        llmtr!.buildEndpoint("https://llmtr.com/v1"),
        "https://llmtr.com/v1/models",
      );
      assert.equal(
        llmtr!.buildEndpoint("https://llmtr.com/v1/chat/completions"),
        "https://llmtr.com/v1/models",
      );
      assert.equal(
        llmtr!.buildEndpoint("https://llmtr.com/v1/messages"),
        "https://llmtr.com/v1/models",
      );
    });
  });

  describe("2. Successful SiliconFlow model discovery, filtering, deduplication & stable sorting", function () {
    it("sends GET /v1/models?sub_type=chat with Bearer auth, preserves vendor-prefixed IDs, filters non-chat models, deduplicates, and stably sorts", async function () {
      const requests: Array<{ url: string; headers: Record<string, string> }> =
        [];
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async (
          url: string,
          init?: { headers?: Record<string, string> },
        ) => {
          requests.push({ url, headers: init?.headers || {} });
          return {
            ok: true,
            status: 200,
            json: async () => ({
              object: "list",
              data: [
                {
                  id: "Qwen/Qwen2.5-72B-Instruct",
                  object: "model",
                  sub_type: "chat",
                },
                {
                  id: "deepseek-ai/DeepSeek-V3",
                  object: "model",
                  sub_type: "chat",
                },
                {
                  id: "Pro/deepseek-ai/DeepSeek-R1",
                  object: "model",
                  sub_type: "chat",
                },
                // Duplicate ID must be deduplicated
                {
                  id: "deepseek-ai/DeepSeek-V3",
                  object: "model",
                  sub_type: "chat",
                },
                // Non-chat models must be filtered out
                {
                  id: "BAAI/bge-m3",
                  object: "model",
                  sub_type: "embedding",
                },
                {
                  id: "BAAI/bge-reranker-v2-m3",
                  object: "model",
                  sub_type: "reranker",
                },
                {
                  id: "black-forest-labs/FLUX.1-schnell",
                  object: "model",
                  type: "image",
                },
                {
                  id: "FunAudioLLM/CosyVoice2-0.5B",
                  object: "model",
                  type: "audio",
                },
              ],
            }),
          };
        }) as unknown as typeof fetch,
      });

      const identity = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-secret-key",
        scope: "group-sf-1",
      };

      const models = await refreshModelCatalog(identity);
      assert.lengthOf(requests, 1);
      assert.equal(
        requests[0].url,
        "https://api.siliconflow.cn/v1/models?sub_type=chat",
      );
      assert.equal(requests[0].headers.Authorization, "Bearer sf-secret-key");
      assert.lengthOf(models, 3, "deduplicated and filtered to 3 chat models");

      const adapter = getModelDiscoveryAdapter(identity)!;
      const sortedByAdapter = adapter.filterAndSortModels(models);
      assert.deepEqual(
        sortedByAdapter.map((m) => m.id),
        [
          "deepseek-ai/DeepSeek-V3",
          "Pro/deepseek-ai/DeepSeek-R1",
          "Qwen/Qwen2.5-72B-Instruct",
        ],
      );

      const sortedOptions = sortModelOptions([
        ...models,
        { id: "deepseek-ai/DeepSeek-V3", source: "live" },
      ]);
      assert.deepEqual(
        sortedOptions.map((m) => m.id),
        [
          "deepseek-ai/DeepSeek-V3",
          "Pro/deepseek-ai/DeepSeek-R1",
          "Qwen/Qwen2.5-72B-Instruct",
        ],
      );

      const status = getModelCatalogStatus(identity);
      assert.isNotNull(status);
      assert.isFalse(status!.stale);
      assert.isUndefined(status!.error);
      assert.isNull(
        formatModelDiscoveryStatusHint({
          apiKey: identity.apiKey,
          loading: false,
          snapshot: status,
        }),
      );
    });
  });

  describe("3. Error handling & manual fallback (401 / 403 / 429 / timeout / empty / invalid JSON)", function () {
    const baseIdentity = {
      provider: "siliconflow",
      model: "Qwen/Qwen2.5-72B-Instruct",
      apiBase: "https://api.siliconflow.cn/v1",
      protocol: "openai_chat_compat",
      authMode: "api_key",
      apiKey: "sf-key",
      scope: "group-sf-err",
    };

    it("classifies HTTP 401 unauthorized and falls back to manual entry without clearing saved model", async function () {
      assert.deepEqual(classifyModelDiscoveryHttpError(401), {
        code: "unauthorized",
        message: "API key is invalid or unauthorized (HTTP 401).",
      });

      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: false,
          status: 401,
          json: async () => ({ error: "Invalid token" }),
        })) as unknown as typeof fetch,
      });

      const models = await refreshModelCatalog(baseIdentity);
      assert.deepEqual(models, []);
      const snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.isTrue(snapshot!.stale);
      assert.equal(snapshot!.errorCode, "unauthorized");
      assert.equal(
        snapshot!.error,
        "API key is invalid or unauthorized (HTTP 401).",
      );

      const hint = formatModelDiscoveryStatusHint({
        apiKey: baseIdentity.apiKey,
        loading: false,
        snapshot,
      });
      assert.deepEqual(hint, {
        text: "API key is invalid or unauthorized (HTTP 401).",
        isError: true,
      });

      const fetchStatus = resolveProviderModelFetchStatus({
        apiKey: baseIdentity.apiKey,
        loading: false,
        snapshot,
      });
      assert.equal(
        resolveModelEntryMode({
          status: fetchStatus,
          userCustomized: false,
          inputFocused: false,
        }),
        "manual",
      );
    });

    it("classifies HTTP 403 forbidden and preserves manual fallback", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: false,
          status: 403,
          json: async () => ({ error: "Forbidden" }),
        })) as unknown as typeof fetch,
      });

      await refreshModelCatalog(baseIdentity);
      const snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.errorCode, "forbidden");
      assert.equal(
        snapshot!.error,
        "Access forbidden for this API key (HTTP 403).",
      );
    });

    it("classifies HTTP 429 rate-limited and preserves manual fallback", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: false,
          status: 429,
          json: async () => ({ error: "Too Many Requests" }),
        })) as unknown as typeof fetch,
      });

      await refreshModelCatalog(baseIdentity);
      const snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.errorCode, "rate_limited");
      assert.equal(
        snapshot!.error,
        "Rate limit exceeded when fetching models (HTTP 429).",
      );
    });

    it("classifies request timeout (timeoutMs / AbortError) and falls back cleanly", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () =>
          new Promise<Response>(() => {
            // Never resolves; timeoutMs triggers abort
          })) as unknown as typeof fetch,
      });

      const models = await refreshModelCatalog(baseIdentity, { timeoutMs: 25 });
      assert.deepEqual(models, []);
      const snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.isTrue(snapshot!.stale);
      assert.equal(snapshot!.errorCode, "timeout");
      assert.equal(snapshot!.error, "Request timed out while fetching models.");
    });

    it("reports empty_list when provider returns no chat models", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            object: "list",
            data: [
              { id: "BAAI/bge-m3", sub_type: "embedding" },
              { id: "BAAI/bge-reranker-v2-m3", sub_type: "reranker" },
            ],
          }),
        })) as unknown as typeof fetch,
      });

      const models = await refreshModelCatalog(baseIdentity);
      assert.deepEqual(models, []);
      const snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.isTrue(snapshot!.stale);
      assert.equal(snapshot!.errorCode, "empty_list");
      assert.equal(
        snapshot!.error,
        "No available chat models returned by provider.",
      );

      // Saved model remains selectable in buildProviderModelSelectRows
      const rows = buildProviderModelSelectRows({
        savedModel: "Qwen/Qwen2.5-72B-Instruct",
        catalog: models,
        customizedActive: false,
      });
      assert.deepEqual(rows[0], {
        kind: "model",
        id: "Qwen/Qwen2.5-72B-Instruct",
        fromCatalog: false,
      });
    });

    it("reports invalid_json when response JSON is malformed or missing data array", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token < in JSON");
          },
        })) as unknown as typeof fetch,
      });

      await refreshModelCatalog(baseIdentity);
      let snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.errorCode, "invalid_json");
      assert.equal(
        snapshot!.error,
        "Invalid JSON response from models endpoint.",
      );

      // Also test valid JSON that lacks a `data` array
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({ unexpected: "object" }),
        })) as unknown as typeof fetch,
      });

      await refreshModelCatalog(baseIdentity, { force: true });
      snapshot = getModelCatalogStatus(baseIdentity);
      assert.isNotNull(snapshot);
      assert.equal(snapshot!.errorCode, "invalid_json");
      assert.equal(
        snapshot!.error,
        "Invalid JSON response from models endpoint.",
      );
    });

    it("records network_error snapshot when SiliconFlow apiBase is an invalid URL instead of leaving status null", async function () {
      const invalidBaseIdentity = {
        ...baseIdentity,
        apiBase: "http://[invalid-url",
        scope: "group-sf-invalid-url",
      };

      const models = await refreshModelCatalog(invalidBaseIdentity);
      assert.deepEqual(models, []);
      const snapshot = getModelCatalogStatus(invalidBaseIdentity);
      assert.isNotNull(
        snapshot,
        "invalid URL must record an error snapshot so the UI switches to manual entry and shows an error hint",
      );
      assert.isTrue(snapshot!.stale);
      assert.equal(snapshot!.errorCode, "network_error");
      assert.equal(snapshot!.error, "Invalid API URL for models endpoint.");

      const hint = formatModelDiscoveryStatusHint({
        apiKey: invalidBaseIdentity.apiKey,
        loading: false,
        snapshot,
      });
      assert.deepEqual(hint, {
        text: "Invalid API URL for models endpoint.",
        isError: true,
      });
    });
  });

  describe("4. 30-minute TTL cache, manual force refresh, config invalidation & request coalescing", function () {
    it("hits the 30-minute cache within TTL and re-fetches after TTL or on manual force refresh", async function () {
      let currentNow = 1_000_000;
      let fetchCalls = 0;

      configureModelCapabilityRuntime({
        environment: "test",
        now: () => currentNow,
        fetch: (async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: `Qwen/Qwen2.5-72B-Instruct-v${fetchCalls}` }],
            }),
          };
        }) as unknown as typeof fetch,
      });

      const identity = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-cache-key",
        scope: "group-sf-cache",
      };

      assert.equal(MODEL_DISCOVERY_CACHE_TTL_MS, 30 * 60 * 1000);

      const first = await refreshModelCatalog(identity);
      assert.equal(fetchCalls, 1);
      assert.equal(first[0].id, "Qwen/Qwen2.5-72B-Instruct-v1");

      // Advance 29 minutes -> cache hit, 0 new network calls
      currentNow += 29 * 60 * 1000;
      const cachedHit = await refreshModelCatalog(identity);
      assert.equal(fetchCalls, 1, "must hit cache within 30 minutes");
      assert.equal(cachedHit[0].id, "Qwen/Qwen2.5-72B-Instruct-v1");

      // Manual Refresh (force: true) -> bypasses cache immediately
      const forced = await refreshModelCatalog(identity, { force: true });
      assert.equal(fetchCalls, 2, "manual refresh must bypass TTL cache");
      assert.equal(forced[0].id, "Qwen/Qwen2.5-72B-Instruct-v2");

      // Advance past 30 minutes from the last fetch -> re-fetches automatically
      currentNow += 30 * 60 * 1000 + 1;
      const expired = await refreshModelCatalog(identity);
      assert.equal(fetchCalls, 3, "expired TTL must trigger a fresh request");
      assert.equal(expired[0].id, "Qwen/Qwen2.5-72B-Instruct-v3");
    });

    it("invalidates cache immediately when apiKey or apiBase changes", async function () {
      const seenAuthHeaders: string[] = [];
      const seenUrls: string[] = [];

      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async (
          url: string,
          init?: { headers?: Record<string, string> },
        ) => {
          seenUrls.push(url);
          seenAuthHeaders.push(init?.headers?.Authorization || "");
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: `model-call-${seenUrls.length}` }],
            }),
          };
        }) as unknown as typeof fetch,
      });

      const baseIdentity = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-key-1",
        scope: "group-sf-cfg",
      };

      const res1 = await refreshModelCatalog(baseIdentity);
      assert.equal(res1[0].id, "model-call-1");
      assert.lengthOf(seenUrls, 1);

      // Change apiKey -> must not return sf-key-1's cached catalog
      const changedKeyIdentity = { ...baseIdentity, apiKey: "sf-key-2" };
      assert.isNull(getModelCatalogStatus(changedKeyIdentity));
      assert.deepEqual(getDiscoveredModels(changedKeyIdentity), []);
      const res2 = await refreshModelCatalog(changedKeyIdentity);
      assert.equal(res2[0].id, "model-call-2");
      assert.lengthOf(seenUrls, 2);
      assert.equal(seenAuthHeaders[1], "Bearer sf-key-2");

      // Change apiBase -> must not return api.siliconflow.cn's cached catalog
      const changedBaseIdentity = {
        ...changedKeyIdentity,
        apiBase: "https://api.siliconflow.com/v1",
      };
      assert.isNull(getModelCatalogStatus(changedBaseIdentity));
      const res3 = await refreshModelCatalog(changedBaseIdentity);
      assert.equal(res3[0].id, "model-call-3");
      assert.lengthOf(seenUrls, 3);
      assert.equal(
        seenUrls[2],
        "https://api.siliconflow.com/v1/models?sub_type=chat",
      );
    });

    it("does not leak cached models or status when apiKey is cleared to empty or a second unconfigured SiliconFlow card is added", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            data: [
              { id: "Qwen/Qwen2.5-72B-Instruct", sub_type: "chat" },
              { id: "deepseek-ai/DeepSeek-V3", sub_type: "chat" },
            ],
          }),
        })) as unknown as typeof fetch,
      });

      const configuredCard = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-valid-key",
        scope: "group-sf-card-1",
      };

      const fetched = await refreshModelCatalog(configuredCard);
      assert.lengthOf(fetched, 2);
      assert.isNotNull(getModelCatalogStatus(configuredCard));

      // 1. User clears the API key on the same card (`apiKey: ""`)
      const clearedKeyCard = { ...configuredCard, apiKey: "" };
      assert.isNull(
        getModelCatalogStatus(clearedKeyCard),
        "clearing apiKey to empty string must not fall back to the previous key's snapshot",
      );
      assert.deepEqual(
        getDiscoveredModels(clearedKeyCard),
        [],
        "clearing apiKey to empty string must not leak cached models",
      );

      // 2. User adds a second unconfigured SiliconFlow card (`scope: "group-sf-card-2"`, `apiKey: ""`)
      const secondUnconfiguredCard = {
        ...configuredCard,
        apiKey: "",
        scope: "group-sf-card-2",
      };
      assert.isNull(
        getModelCatalogStatus(secondUnconfiguredCard),
        "a second unconfigured SiliconFlow card must not inherit card 1's snapshot",
      );
      assert.deepEqual(getDiscoveredModels(secondUnconfiguredCard), []);

      // 3. Even if the second card has the same non-empty key, its distinct scope is respected unless queried without scope
      const secondCardDiffKey = {
        ...configuredCard,
        apiKey: "sf-other-key",
        scope: "group-sf-card-2",
      };
      assert.isNull(getModelCatalogStatus(secondCardDiffKey));
    });

    it("hits the same SiliconFlow catalog cache across vendor-prefixed model names (Qwen/*, deepseek-ai/*, meta-llama/*)", async function () {
      let fetchCalls = 0;
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                { id: "Qwen/Qwen2.5-72B-Instruct", sub_type: "chat" },
                { id: "deepseek-ai/DeepSeek-V3", sub_type: "chat" },
                {
                  id: "meta-llama/Llama-3.3-70B-Instruct",
                  sub_type: "chat",
                },
              ],
            }),
          };
        }) as unknown as typeof fetch,
      });

      const baseCard = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-vendor-key",
        scope: "group-sf-vendor",
      };

      await refreshModelCatalog(baseCard);
      assert.equal(fetchCalls, 1);

      for (const vendorModel of [
        "Qwen/Qwen2.5-72B-Instruct",
        "deepseek-ai/DeepSeek-V3",
        "meta-llama/Llama-3.3-70B-Instruct",
      ]) {
        const withVendorModel = {
          ...baseCard,
          provider: undefined,
          model: vendorModel,
        };
        const status = getModelCatalogStatus(withVendorModel);
        assert.isNotNull(
          status,
          `getModelCatalogStatus must hit SiliconFlow cache for ${vendorModel}`,
        );
        assert.lengthOf(status!.models, 3);
        assert.lengthOf(getDiscoveredModels(withVendorModel), 3);

        const refreshed = await refreshModelCatalog(withVendorModel);
        assert.lengthOf(refreshed, 3);
        assert.equal(
          fetchCalls,
          1,
          `refreshModelCatalog with ${vendorModel} must hit warm cache without extra network call`,
        );
      }
    });

    it("prevents an older slow request from overwriting a newer forced refresh", async function () {
      let callCount = 0;
      let resolveFirst!: (res: unknown) => void;
      let resolveSecond!: (res: unknown) => void;

      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => {
          callCount += 1;
          if (callCount === 1) {
            return new Promise((resolve) => {
              resolveFirst = resolve;
            });
          }
          return new Promise((resolve) => {
            resolveSecond = resolve;
          });
        }) as unknown as typeof fetch,
      });

      const identity = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-race-key",
        scope: "group-sf-race",
      };

      const p1 = refreshModelCatalog(identity);
      const p2 = refreshModelCatalog(identity, { force: true });

      // Resolve the newer forced refresh (p2) FIRST with fresh models
      resolveSecond({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "deepseek-ai/DeepSeek-R1-Fresh", sub_type: "chat" }],
        }),
      });
      const r2 = await p2;
      assert.deepEqual(
        r2.map((m) => m.id),
        ["deepseek-ai/DeepSeek-R1-Fresh"],
      );

      // Now resolve the older request (p1) LATER with stale models
      resolveFirst({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "Qwen/Old-Model", sub_type: "chat" }],
        }),
      });
      const r1 = await p1;
      assert.deepEqual(
        r1.map((m) => m.id),
        ["deepseek-ai/DeepSeek-R1-Fresh"],
        "older request must not overwrite the newer forced refresh snapshot",
      );
      assert.deepEqual(
        getDiscoveredModels(identity).map((m) => m.id),
        ["deepseek-ai/DeepSeek-R1-Fresh"],
      );
    });

    it("coalesces concurrent requests for the same SiliconFlow identity into a single HTTP request", async function () {
      let fetchCalls = 0;
      let releaseFetch: (() => void) | null = null;
      const gate = new Promise<void>((resolve) => {
        releaseFetch = resolve;
      });

      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => {
          fetchCalls += 1;
          await gate;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: "deepseek-ai/DeepSeek-V3" }],
            }),
          };
        }) as unknown as typeof fetch,
      });

      const identity = {
        provider: "siliconflow",
        model: "",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        apiKey: "sf-concurrent-key",
        scope: "group-sf-concurrent",
      };

      const p1 = refreshModelCatalog(identity);
      const p2 = refreshModelCatalog(identity);
      const p3 = refreshModelCatalog(identity);
      releaseFetch?.();

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      assert.equal(fetchCalls, 1, "only 1 network call should be made");
      assert.deepEqual(r1, r2);
      assert.deepEqual(r2, r3);
    });
  });

  describe("5. On-demand trigger boundaries & persistence across restarts", function () {
    it("does NOT fetch SiliconFlow models on Zotero startup (refreshConfiguredProviderModelCatalogs) or chat/PDF Q&A preflight (ensureModelCapabilities)", async function () {
      const requestedUrls: string[] = [];
      configureModelCapabilityRuntime({
        environment: "production",
        fetch: (async (input: RequestInfo | URL) => {
          const url = String(input);
          requestedUrls.push(url);
          return new Response(JSON.stringify({ data: [] }), { status: 200 });
        }) as typeof fetch,
      });

      const sfGroup: ModelProviderGroup = {
        id: "provider-sf-startup",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-startup-key",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [createProviderModelEntry("Qwen/Qwen2.5-72B-Instruct")],
      };
      setModelProviderGroups([sfGroup]);

      // 1. Zotero startup / menu rebuild catalog refresh
      await refreshConfiguredProviderModelCatalogs();
      assert.isEmpty(
        requestedUrls.filter((u) => u.includes("siliconflow")),
        "startup catalog refresh must never request SiliconFlow /models",
      );

      // 2. Chat / PDF Q&A preflight (ensureModelCapabilities)
      const sfIdentity = {
        ...buildProviderCatalogIdentity(sfGroup),
        model: "Qwen/Qwen2.5-72B-Instruct",
      };
      await ensureModelCapabilities(sfIdentity, { timeoutMs: 50 });
      assert.isEmpty(
        requestedUrls.filter((u) => u.includes("siliconflow")),
        "chat/PDF Q&A preflight must never request SiliconFlow /models",
      );
    });

    it("persists user-selected SiliconFlow model across Zotero restarts and preserves it when discovery fails", async function () {
      const sfGroup: ModelProviderGroup = {
        id: "provider-sf-persist",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sf-persist-key",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [createProviderModelEntry("Pro/deepseek-ai/DeepSeek-R1")],
      };
      setModelProviderGroups([sfGroup]);

      // Simulate restart by reading back from Zotero.Prefs
      const reloadedGroups = getModelProviderGroups();
      assert.lengthOf(reloadedGroups, 1);
      assert.equal(
        reloadedGroups[0].models[0].model,
        "Pro/deepseek-ai/DeepSeek-R1",
      );

      // Even if a subsequent discovery fetch fails (e.g. 500 error), the saved model is preserved
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: false,
          status: 500,
          json: async () => ({}),
        })) as unknown as typeof fetch,
      });
      await refreshModelCatalog(
        buildProviderCatalogIdentity(reloadedGroups[0]),
      );

      const runtimeEntries = getRuntimeModelEntries();
      assert.lengthOf(runtimeEntries, 1);
      assert.equal(runtimeEntries[0].model, "Pro/deepseek-ai/DeepSeek-R1");
      assert.equal(runtimeEntries[0].providerLabel, "SiliconFlow");
    });

    it("invalidates superseded snapshots for the same configuration so getModelCapabilities() uses the current API key's catalog", async function () {
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async (
          _url: string,
          init?: { headers?: Record<string, string> },
        ) => {
          const auth = init?.headers?.Authorization || "";
          const contextLen = auth.includes("sk-key-2") ? 8192 : 32768;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id: "Qwen/Qwen2.5-72B-Instruct",
                  context_length: contextLen,
                },
              ],
            }),
          } as Response;
        }) as unknown as typeof fetch,
      });

      const baseConfig = {
        provider: "siliconflow",
        model: "Qwen/Qwen2.5-72B-Instruct",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
      };

      await refreshModelCatalog({ ...baseConfig, apiKey: "sk-key-1" });
      assert.equal(
        getModelCapabilities(baseConfig).limits.contextWindowTokens,
        32768,
      );
      // Also works when caller omits authMode or includes a trailing slash on apiBase
      assert.equal(
        getModelCapabilities({
          model: "Qwen/Qwen2.5-72B-Instruct",
          apiBase: "https://api.siliconflow.cn/v1/",
          protocol: "openai_chat_compat",
        }).limits.contextWindowTokens,
        32768,
      );

      // Change API key and force refresh; callers of getModelCapabilities() do NOT pass apiKey
      await refreshModelCatalog(
        { ...baseConfig, apiKey: "sk-key-2" },
        { force: true },
      );
      const updatedCaps = getModelCapabilities(baseConfig);
      assert.equal(updatedCaps.limits.contextWindowTokens, 8192);
      assert.equal(updatedCaps.limits.inputTokens, 8192);

      // If the user edits or clears the API key in Preferences before refreshing,
      // invalidateModelCatalog immediately evicts the old key's live catalog
      invalidateModelCatalog({ ...baseConfig, apiKey: "sk-key-3" });
      assert.notEqual(
        getModelCapabilities(baseConfig).source,
        "live",
        "invalidated catalog must no longer resolve live limits from the previous API key",
      );
    });

    it("prevents a slow in-flight request from an older API key from overwriting a newer API key's snapshot", async function () {
      let resolveOldKey!: (res: Response) => void;
      let resolveNewKey!: (res: Response) => void;

      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async (
          _url: string,
          init?: { headers?: Record<string, string> },
        ) => {
          const auth = init?.headers?.Authorization || "";
          if (auth.includes("sk-old")) {
            return new Promise<Response>((resolve) => {
              resolveOldKey = resolve;
            });
          }
          return new Promise<Response>((resolve) => {
            resolveNewKey = resolve;
          });
        }) as unknown as typeof fetch,
      });

      const baseCard = {
        provider: "siliconflow",
        model: "Qwen/Qwen2.5-72B-Instruct",
        apiBase: "https://api.siliconflow.cn/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
        scope: "group-sf-cross-key-race",
      };

      const pOld = refreshModelCatalog({ ...baseCard, apiKey: "sk-old" });
      const pNew = refreshModelCatalog({ ...baseCard, apiKey: "sk-new" });

      resolveNewKey({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "Qwen/Qwen2.5-72B-Instruct", context_length: 8192 }],
        }),
      } as Response);
      await pNew;

      resolveOldKey({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ id: "Qwen/Qwen2.5-72B-Instruct", context_length: 32768 }],
        }),
      } as Response);
      await pOld;

      assert.equal(
        getModelCapabilities(baseCard).limits.contextWindowTokens,
        8192,
        "slow response for sk-old must not overwrite sk-new's snapshot",
      );
      assert.isNotNull(
        getModelCatalogStatus({ ...baseCard, apiKey: "sk-new" }),
      );
    });

    it("refreshes the SiliconFlow selector when reopened after the 30-minute cache expires", async function () {
      let currentTime = 1_700_000_000_000;
      let fetchCalls = 0;

      configureModelCapabilityRuntime({
        environment: "test",
        now: () => currentTime,
        fetch: (async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [
                {
                  id:
                    fetchCalls === 1
                      ? "Qwen/Qwen2.5-72B-Instruct"
                      : "deepseek-ai/DeepSeek-V3",
                },
              ],
            }),
          } as Response;
        }) as unknown as typeof fetch,
      });

      const doc = new FakePrefDocument();
      const inputEl = doc.createElement("input");
      Object.assign(doc.body, {
        append: (...nodes: unknown[]) => {
          for (const node of nodes) {
            doc.body.appendChild(node as never);
          }
        },
      });
      const ensureAppend = (el: unknown) => {
        const target = el as {
          append?: (...nodes: unknown[]) => void;
          appendChild: (node: unknown) => void;
          dataset?: Record<string, string>;
        };
        if (!target.dataset) target.dataset = {};
        if (!target.append) {
          target.append = (...nodes: unknown[]) => {
            for (const node of nodes) target.appendChild(node);
          };
        }
        return el;
      };
      const origCreateElementNS = doc.createElementNS.bind(doc);
      doc.createElementNS = ((ns: string, tag: string) =>
        ensureAppend(
          origCreateElementNS(ns, tag),
        )) as typeof doc.createElementNS;
      ensureAppend(inputEl);

      const group: ModelProviderGroup = {
        id: "sf-selector-expiry-group",
        apiBase: "https://api.siliconflow.cn/v1",
        apiKey: "sk-sf-expiry",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [createProviderModelEntry("Qwen/Qwen2.5-72B-Instruct")],
      };

      const picker = attachProviderModelSelect({
        doc: doc as unknown as Document,
        input: inputEl as unknown as HTMLInputElement,
        group,
        modelEntry: group.models[0],
        onModelPicked: (modelId) => {
          group.models[0].model = modelId;
        },
      });

      // 0 requests on initial mount
      assert.equal(fetchCalls, 0);

      const selectEl = picker.container.querySelector("select")!;
      assert.isNotNull(selectEl);

      // 1st selector open at t = 0 -> triggers network fetch #1
      selectEl.dispatch("focus");
      await flushAsync();
      assert.equal(fetchCalls, 1);
      assert.isFalse(
        isModelCatalogExpired(buildProviderCatalogIdentity(group)),
      );

      // Reopen selector at t = 29 minutes -> still within 30-min TTL, no extra request
      currentTime += 29 * 60 * 1000;
      selectEl.dispatch("focus");
      await flushAsync();
      assert.equal(fetchCalls, 1);

      // Reopen selector past 30 minutes (t = 30m + 1s) -> cache expired, triggers network fetch #2
      currentTime += 61 * 1000;
      assert.isTrue(isModelCatalogExpired(buildProviderCatalogIdentity(group)));
      selectEl.dispatch("focus");
      await flushAsync();
      assert.equal(
        fetchCalls,
        2,
        "reopening selector after 30 minutes must trigger a fresh request",
      );
    });

    it("preserves the 1-minute cache lifetime for existing non-ModelDiscovery providers (e.g. Ollama and local OpenAI-compatible servers)", async function () {
      let currentTime = 1_700_000_000_000;
      let fetchCalls = 0;

      configureModelCapabilityRuntime({
        environment: "test",
        now: () => currentTime,
        fetch: (async () => {
          fetchCalls += 1;
          return {
            ok: true,
            status: 200,
            json: async () => ({
              data: [{ id: `local-model-${fetchCalls}` }],
            }),
          } as Response;
        }) as unknown as typeof fetch,
      });

      const localIdentity = {
        provider: "local",
        model: "",
        apiBase: "http://127.0.0.1:11434/v1",
        protocol: "openai_chat_compat",
        authMode: "api_key",
      };

      await refreshModelCatalog(localIdentity);
      assert.equal(fetchCalls, 1);

      // At 30 seconds (< 1 minute): cache hit
      currentTime += 30 * 1000;
      await refreshModelCatalog(localIdentity);
      assert.equal(fetchCalls, 1);

      // At 61 seconds (> 1 minute, well below 30 minutes): must expire and re-fetch for non-ModelDiscovery providers
      currentTime += 31 * 1000;
      assert.isTrue(isModelCatalogExpired(localIdentity));
      const refreshed = await refreshModelCatalog(localIdentity);
      assert.equal(
        fetchCalls,
        2,
        "existing providers must keep their 1-minute catalog TTL",
      );
      assert.deepEqual(
        refreshed.map((m) => m.id),
        ["local-model-2"],
      );
    });
  });
});
