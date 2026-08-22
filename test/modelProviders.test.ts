import { assert } from "chai";
import { config } from "../package.json";
import {
  buildModelProviderGroupsFromLegacySlots,
  buildProviderCatalogIdentity,
  deriveProviderLabel,
  getRuntimeModelEntries,
  migrateApiBaseForAuthModeChange,
  refreshConfiguredProviderModelCatalogs,
  setModelProviderGroups,
  subscribeModelProviderGroups,
  type LegacyModelSlot,
  type ModelProviderGroup,
} from "../src/utils/modelProviders";
import {
  configureModelCapabilityRuntime,
  getDiscoveredModels,
  refreshModelCatalog,
  resetModelCapabilityStateForTests,
} from "../src/modelCapabilities";

let originalZotero: typeof Zotero | undefined;

describe("modelProviders", function () {
  before(function () {
    originalZotero = globalThis.Zotero;
  });

  beforeEach(function () {
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

  after(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("derives provider labels from known hosts and falls back to hostname", function () {
    assert.equal(
      deriveProviderLabel("https://api.openai.com/v1/chat/completions"),
      "OpenAI",
    );
    assert.equal(
      deriveProviderLabel("https://api.deepseek.com/v1"),
      "DeepSeek",
    );
    assert.equal(deriveProviderLabel("https://api.moonshot.ai/v1"), "Kimi");
    assert.equal(deriveProviderLabel("https://api.x.ai/v1/responses"), "Grok");
    assert.equal(deriveProviderLabel("https://api.xiaomimimo.com/v1"), "Xiaomi MiMo");
    assert.equal(
      deriveProviderLabel("https://openrouter.ai/api/v1"),
      "OpenRouter",
    );
    assert.equal(
      deriveProviderLabel("https://api.orcarouter.ai/v1"),
      "OrcaRouter",
    );
    assert.equal(
      deriveProviderLabel("https://api.minimax.io/anthropic"),
      "MiniMax",
    );
    assert.equal(
      deriveProviderLabel("https://open.bigmodel.cn/api/anthropic"),
      "GLM",
    );
    assert.equal(
      deriveProviderLabel(
        "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      ),
      "Gemini",
    );
    assert.equal(
      deriveProviderLabel("https://custom.provider.example/v1"),
      "custom.provider.example",
    );
    assert.equal(deriveProviderLabel("", 3), "Provider 3");
  });

  it("migrates legacy slots into grouped providers while preserving per-model advanced params", function () {
    const legacySlots: LegacyModelSlot[] = [
      {
        key: "primary",
        apiBase: "https://api.openai.com/v1",
        apiKey: "sk-openai",
        model: "gpt-4o-mini",
        temperature: 0.3,
        maxTokens: 4096,
        inputTokenCap: 128000,
      },
      {
        key: "secondary",
        apiBase: "https://api.openai.com/v1/",
        apiKey: "sk-openai",
        model: "gpt-4o",
        temperature: 0.1,
        maxTokens: 2048,
        inputTokenCap: 64000,
      },
      {
        key: "tertiary",
        apiBase: "",
        apiKey: "",
        model: "local-model",
        temperature: 0.7,
        maxTokens: 1024,
        inputTokenCap: 16000,
      },
    ];

    const result = buildModelProviderGroupsFromLegacySlots(legacySlots);

    assert.lengthOf(result.groups, 2);
    assert.lengthOf(result.groups[0].models, 2);
    assert.equal(result.groups[0].apiBase, "https://api.openai.com/v1");
    assert.equal(result.groups[0].apiKey, "sk-openai");
    assert.equal(result.groups[0].authMode, "api_key");
    assert.equal(result.groups[0].providerProtocol, "openai_chat_compat");
    assert.equal(result.groups[0].models[0].model, "gpt-4o-mini");
    assert.equal(result.groups[0].models[1].model, "gpt-4o");
    assert.equal(result.groups[0].models[1].temperature, 0.1);
    assert.equal(result.groups[0].models[1].maxTokens, 2048);
    assert.equal(result.groups[0].models[1].inputTokenCap, 64000);
    assert.equal(result.groups[1].apiBase, "");
    assert.equal(result.groups[1].models[0].model, "local-model");
    assert.isString(result.legacyToEntryId.primary);
    assert.isString(result.legacyToEntryId.secondary);
    assert.isString(result.legacyToEntryId.tertiary);
  });

  it("keeps duplicate model names and disambiguates runtime display labels within a provider", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.openai.com/v1",
        apiKey: "sk-openai",
        authMode: "api_key",
        models: [
          {
            id: "model-1",
            model: "gpt-4o-mini",
            temperature: 0.3,
            maxTokens: 4096,
            inputTokenCap: 128000,
          },
          {
            id: "model-2",
            model: "gpt-4o-mini",
            temperature: 0.2,
            maxTokens: 2048,
            inputTokenCap: 64000,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 1, true);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 2);
    assert.equal(entries[0].displayModelLabel, "gpt-4o-mini");
    assert.equal(entries[1].displayModelLabel, "gpt-4o-mini #2");
    assert.equal(entries[0].providerLabel, "OpenAI");
    assert.equal(entries[0].authMode, "api_key");
    assert.equal(entries[0].providerProtocol, "responses_api");
  });

  it("round-trips explicit max-token provenance through provider storage", function () {
    setModelProviderGroups([
      {
        id: "ollama",
        apiBase: "http://127.0.0.1:11434",
        apiKey: "",
        authMode: "api_key",
        providerProtocol: "ollama_native",
        models: [
          {
            id: "explicit",
            model: "qwen3:8b",
            temperature: 0.3,
            maxTokens: 4096,
            maxTokensExplicit: true,
          },
          {
            id: "default",
            model: "gemma3:4b",
            temperature: 0.3,
            maxTokens: 4096,
          },
          {
            id: "legacy-custom",
            model: "future-model",
            temperature: 0.3,
            maxTokens: 250000,
          },
          {
            id: "known-high-explicit",
            model: "claude-haiku-4-5",
            temperature: 0.3,
            maxTokens: 200000,
            maxTokensExplicit: true,
          },
        ],
      },
    ]);

    const entries = getRuntimeModelEntries();

    assert.isTrue(entries[0].advanced.maxTokensExplicit);
    assert.isUndefined(entries[1].advanced.maxTokensExplicit);
    assert.equal(entries[2].advanced.maxTokens, 250000);
    assert.isTrue(entries[2].advanced.maxTokensExplicit);
    assert.equal(entries[3].advanced.maxTokens, 200000);
    assert.isTrue(entries[3].advanced.maxTokensExplicit);
  });

  it("notifies open consumers after provider settings change", function () {
    let notifications = 0;
    const unsubscribe = subscribeModelProviderGroups(() => {
      notifications += 1;
    });

    setModelProviderGroups([]);
    unsubscribe();
    setModelProviderGroups([]);

    assert.equal(notifications, 1);
  });

  it("infers Anthropic protocol for customized providers with default chat protocol", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://proxy.example.com/anthropic",
        apiKey: "sk-anthropic",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: [
          {
            id: "model-1",
            model: "claude-sonnet-4-5",
            temperature: 0.3,
            maxTokens: 4096,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].providerProtocol, "anthropic_messages");
  });

  it("infers Responses protocol for customized providers with canonical responses URLs", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://proxy.example.com/v1/responses",
        apiKey: "sk-responses",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: [
          {
            id: "model-1",
            model: "gpt-5.4",
            temperature: 0.3,
            maxTokens: 4096,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].providerProtocol, "responses_api");
  });

  it("keeps per-model protocol override above customized URL inference", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://proxy.example.com/anthropic",
        apiKey: "sk-chat",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        presetIdOverride: "customized",
        models: [
          {
            id: "model-1",
            model: "chat-compatible-model",
            temperature: 0.3,
            maxTokens: 4096,
            providerProtocol: "openai_chat_compat",
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].providerProtocol, "openai_chat_compat");
  });

  it("uses the preset default protocol for known-provider auto mode", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.moonshot.ai/v1",
        apiKey: "sk-kimi",
        authMode: "api_key",
        providerProtocol: "responses_api",
        models: [
          {
            id: "model-1",
            model: "kimi-k2.6",
            temperature: 0.3,
            maxTokens: 4096,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].providerProtocol, "openai_chat_compat");
  });

  it("keeps explicit per-model protocol overrides for known providers", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.moonshot.ai/v1",
        apiKey: "sk-kimi",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: "model-1",
            model: "kimi-k2.6",
            temperature: 0.3,
            maxTokens: 4096,
            providerProtocol: "responses_api",
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].providerProtocol, "responses_api");
  });

  it("keeps input token cap unset when no override is stored", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.openai.com/v1",
        apiKey: "sk-openai",
        authMode: "api_key",
        models: [
          {
            id: "model-1",
            model: "gpt-4o-mini",
            temperature: 0.3,
            maxTokens: 4096,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 1, true);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.isUndefined(entries[0].advanced.inputTokenCap);
  });

  it("preserves per-model input mode overrides in runtime entries", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.openai.com/v1",
        apiKey: "sk-openai",
        authMode: "api_key",
        models: [
          {
            id: "model-1",
            model: "gpt-5.5",
            temperature: 0.3,
            maxTokens: 4096,
            inputMode: "text_only",
          },
          {
            id: "model-2",
            model: "local-text-only",
            temperature: 0.3,
            maxTokens: 4096,
            inputMode: "vision_allowed",
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 2);
    assert.equal(entries[0].advanced.inputMode, "text_only");
    assert.equal(entries[1].advanced.inputMode, "vision_allowed");
  });

  it("defaults missing, auto, and invalid input modes to automatic detection", function () {
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-1",
          apiBase: "https://api.openai.com/v1",
          apiKey: "sk-openai",
          authMode: "api_key",
          models: [
            { id: "m1", model: "gpt-5.5", temperature: 0.3, maxTokens: 4096 },
            {
              id: "m2",
              model: "gpt-5.5",
              temperature: 0.3,
              maxTokens: 4096,
              inputMode: "auto",
            },
            {
              id: "m3",
              model: "gpt-5.5",
              temperature: 0.3,
              maxTokens: 4096,
              inputMode: "images_only",
            },
          ],
        },
      ]),
      true,
    );
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 3, true);

    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 3);
    assert.isUndefined(entries[0].advanced.inputMode);
    assert.isUndefined(entries[1].advanced.inputMode);
    assert.isUndefined(entries[2].advanced.inputMode);
  });

  it("preserves large DeepSeek V4 output token settings", function () {
    const groups: ModelProviderGroup[] = [
      {
        id: "provider-1",
        apiBase: "https://api.deepseek.com/v1",
        apiKey: "sk-deepseek",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [
          {
            id: "model-1",
            model: "deepseek-v4-pro",
            temperature: 0.3,
            maxTokens: 384000,
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 3, true);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.equal(entries[0].advanced.maxTokens, 384000);
  });

  it("normalizes missing authMode to api_key for stored groups", function () {
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-legacy",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          models: [
            { id: "m1", model: "gpt-5.4", temperature: 0.3, maxTokens: 4096 },
          ],
        },
      ]),
      true,
    );
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 2, true);

    const entries = getRuntimeModelEntries();
    assert.lengthOf(entries, 1);
    assert.equal(entries[0].authMode, "api_key");
    assert.equal(entries[0].providerProtocol, "responses_api");
  });

  it("forces stored codex auth groups onto codex_responses", function () {
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-codex",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          providerProtocol: "gemini_native",
          models: [
            { id: "m1", model: "gpt-5.4", temperature: 0.3, maxTokens: 4096 },
          ],
        },
      ]),
      true,
    );
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 3, true);

    const entries = getRuntimeModelEntries();
    assert.lengthOf(entries, 1);
    assert.equal(entries[0].authMode, "codex_auth");
    assert.equal(entries[0].providerProtocol, "codex_responses");
    assert.equal(entries[0].providerLabel, "OpenAI (codex auth, legacy)");
    assert.equal(entries[0].displayModelLabel, "codex/gpt-5.4");
  });

  it("keeps codex app server entries labeled separately", function () {
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-codex-app",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_app_server",
          models: [
            { id: "m1", model: "gpt-5.4", temperature: 0.3, maxTokens: 4096 },
          ],
        },
      ]),
      true,
    );
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 3, true);

    const entries = getRuntimeModelEntries();
    assert.lengthOf(entries, 1);
    assert.equal(entries[0].authMode, "codex_app_server");
    assert.equal(entries[0].providerProtocol, "codex_responses");
    assert.equal(entries[0].providerLabel, "OpenAI (app server)");
    assert.equal(entries[0].displayModelLabel, "codex-app/gpt-5.4");
  });

  it("drops saved input mode overrides for Codex runtime auth entries", function () {
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-codex-app",
          apiBase: "",
          apiKey: "",
          authMode: "codex_app_server",
          models: [
            {
              id: "m1",
              model: "gpt-5.4",
              temperature: 0.3,
              maxTokens: 4096,
              inputMode: "text_only",
            },
          ],
        },
        {
          id: "provider-codex-legacy",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          models: [
            {
              id: "m2",
              model: "gpt-5.5",
              temperature: 0.3,
              maxTokens: 4096,
              inputMode: "vision_allowed",
            },
          ],
        },
      ]),
      true,
    );
    (
      globalThis.Zotero.Prefs as {
        set: (key: string, value: unknown, global?: boolean) => void;
      }
    ).set(`${config.prefsPrefix}.modelProviderGroupsMigrationVersion`, 3, true);

    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 2);
    assert.equal(entries[0].authMode, "codex_app_server");
    assert.isUndefined(entries[0].advanced.inputMode);
    assert.equal(entries[1].authMode, "codex_auth");
    assert.isUndefined(entries[1].advanced.inputMode);
  });

  describe("migrateApiBaseForAuthModeChange", function () {
    it("clears http(s) URLs when entering codex_app_server", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_auth",
          "codex_app_server",
          "https://chatgpt.com/backend-api/codex/responses",
        ),
        "",
      );
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "api_key",
          "codex_app_server",
          "  HTTP://example.com/v1  ",
        ),
        "",
      );
    });

    it("preserves an existing local path when re-entering codex_app_server", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_app_server",
          "codex_app_server",
          "C:\\nvm4w\\nodejs\\codex.cmd",
        ),
        "C:\\nvm4w\\nodejs\\codex.cmd",
      );
    });

    it("clears local paths when leaving codex_app_server for a URL-based mode", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_app_server",
          "codex_auth",
          "C:\\nvm4w\\nodejs\\codex.cmd",
        ),
        "",
      );
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_app_server",
          "api_key",
          "/usr/local/bin/codex",
        ),
        "",
      );
    });

    it("keeps URLs when leaving codex_app_server (the user already had a URL stashed)", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_app_server",
          "codex_auth",
          "https://chatgpt.com/backend-api/codex/responses",
        ),
        "https://chatgpt.com/backend-api/codex/responses",
      );
    });

    it("leaves apiBase alone for non-app-server transitions", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "api_key",
          "copilot_auth",
          "https://api.openai.com/v1",
        ),
        "https://api.openai.com/v1",
      );
      assert.equal(
        migrateApiBaseForAuthModeChange("api_key", "codex_auth", ""),
        "",
      );
    });
  });

  describe("discovered provider catalogs", function () {
    afterEach(function () {
      resetModelCapabilityStateForTests();
    });

    function makeGeminiGroup(): ModelProviderGroup {
      return {
        id: "provider-gemini-test",
        apiBase: "https://generativelanguage.googleapis.com/v1beta",
        apiKey: "test-key",
        authMode: "api_key",
        providerProtocol: "gemini_native",
        models: [
          {
            id: "model-entry-1",
            model: "gemini-2.5-pro",
            temperature: 0.7,
            maxTokens: 4096,
          },
        ],
      };
    }

    it("keeps the action-panel runtime list to user-configured models even when a catalog is loaded", async function () {
      const group = makeGeminiGroup();
      setModelProviderGroups([group]);
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => ({
          ok: true,
          json: async () => ({
            models: [
              {
                name: "models/gemini-2.5-pro",
                inputTokenLimit: 1_048_576,
                outputTokenLimit: 65_536,
              },
              { name: "models/gemini-2.5-flash-preview-tts" },
              { name: "models/gemma-4-26b-a4b-it" },
              { name: "models/embedding-001" },
            ],
          }),
        })) as unknown as typeof fetch,
      });

      const identity = buildProviderCatalogIdentity(group);
      const catalog = await refreshModelCatalog(identity);
      assert.lengthOf(catalog, 4, "the catalog itself keeps every model");
      assert.lengthOf(getDiscoveredModels(identity), 4);

      const entries = getRuntimeModelEntries();
      assert.deepEqual(
        entries.map((entry) => entry.model),
        ["gemini-2.5-pro"],
        "only models pinned in preferences may appear in the runtime list",
      );
    });

    it("builds the same catalog identity for preset groups that the runtime send path uses", function () {
      const group = makeGeminiGroup();
      const identity = buildProviderCatalogIdentity(group);
      assert.equal(identity.provider, "gemini");
      assert.equal(identity.model, "");
      assert.equal(identity.apiBase, group.apiBase);
      assert.equal(identity.protocol, "gemini_native");
      assert.equal(identity.authMode, "api_key");
      assert.equal(identity.apiKey, "test-key");
      assert.equal(identity.scope, group.id);
    });

    it("marks customized groups with an undefined provider in the catalog identity", function () {
      const group: ModelProviderGroup = {
        id: "provider-custom-test",
        apiBase: "https://my-llm.example.com/v1",
        apiKey: "k",
        authMode: "api_key",
        providerProtocol: "openai_chat_compat",
        models: [],
      };
      const identity = buildProviderCatalogIdentity(group);
      assert.isUndefined(identity.provider);
      assert.equal(identity.scope, group.id);
    });

    it("never runs the generic catalog fetch for copilot, codex, or webchat groups", async function () {
      let fetchCalls = 0;
      configureModelCapabilityRuntime({
        environment: "test",
        fetch: (async () => {
          fetchCalls += 1;
          return { ok: true, json: async () => ({ data: [] }) };
        }) as unknown as typeof fetch,
      });
      const excluded: ModelProviderGroup[] = [
        {
          id: "provider-copilot",
          apiBase: "https://api.githubcopilot.com",
          apiKey: "gho_github-oauth-token",
          authMode: "copilot_auth",
          providerProtocol: "openai_chat_compat",
          models: [],
        },
        {
          id: "provider-codex",
          apiBase: "https://chatgpt.com/backend-api/codex/responses",
          apiKey: "",
          authMode: "codex_auth",
          providerProtocol: "codex_responses",
          models: [],
        },
        {
          id: "provider-webchat",
          apiBase: "",
          apiKey: "",
          authMode: "webchat",
          providerProtocol: "web_sync",
          models: [],
        },
      ];
      setModelProviderGroups(excluded);
      await refreshConfiguredProviderModelCatalogs();
      assert.equal(
        fetchCalls,
        0,
        "copilot needs a token exchange (a raw GitHub token would 401) and codex/webchat have no catalog",
      );
    });
  });
});
