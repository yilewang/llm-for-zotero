import { assert } from "chai";
import { config } from "../package.json";
import {
  buildModelProviderGroupsFromLegacySlots,
  buildProviderCatalogIdentity,
  consumeOutputTokenAutoMigrationNotice,
  createProviderModelEntry,
  deriveProviderLabel,
  getLastUsedModelEntryId,
  getModelProviderGroups,
  getRuntimeModelEntries,
  migrateApiBaseForAuthModeChange,
  normalizeModelProviderGroups,
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
import {
  loadCodexDirectCatalog,
  resetCodexDirectCatalogForTests,
} from "../src/codexAuth/modelCatalog";
import { resolveModelInputTokenLimit } from "../src/utils/modelInputCap";
import {
  getSelectedModelEntry,
  setSelectedModelEntry,
} from "../src/modules/contextPanel/prefHelpers";

let originalZotero: typeof Zotero | undefined;

describe("modelProviders", function () {
  before(function () {
    originalZotero = globalThis.Zotero;
  });

  beforeEach(function () {
    resetCodexDirectCatalogForTests();
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

  afterEach(function () {
    resetCodexDirectCatalogForTests();
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
    assert.equal(
      deriveProviderLabel("https://api.xiaomimimo.com/v1"),
      "Xiaomi MiMo",
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

  it("migrates legacy slots into grouped providers while resetting output limits to Auto", function () {
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
    assert.deepEqual(result.groups[0].models[1].outputTokenLimit, {
      mode: "auto",
    });
    assert.equal(result.groups[0].models[1].inputTokenCap, 64000);
    assert.equal(result.groups[1].apiBase, "");
    assert.equal(result.groups[1].models[0].model, "local-model");
    assert.isString(result.legacyToEntryId.primary);
    assert.isString(result.legacyToEntryId.secondary);
    assert.isString(result.legacyToEntryId.tertiary);
  });

  it("defaults newly created model profiles to Auto", function () {
    assert.deepEqual(createProviderModelEntry("gpt-5.4").outputTokenLimit, {
      mode: "auto",
    });
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
            outputTokenLimit: { mode: "auto" },
            inputTokenCap: 128000,
          },
          {
            id: "model-2",
            model: "gpt-4o-mini",
            temperature: 0.2,
            outputTokenLimit: { mode: "custom", tokens: 2048 },
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

  it("round-trips Auto and Custom output policies through provider storage", function () {
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
            outputTokenLimit: { mode: "custom", tokens: 4096 },
          },
          {
            id: "default",
            model: "gemma3:4b",
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
          },
          {
            id: "legacy-custom",
            model: "future-model",
            temperature: 0.3,
            outputTokenLimit: { mode: "custom", tokens: 250000 },
          },
          {
            id: "known-high-explicit",
            model: "claude-haiku-4-5",
            temperature: 0.3,
            outputTokenLimit: { mode: "custom", tokens: 200000 },
          },
        ],
      },
    ]);

    const entries = getRuntimeModelEntries();

    assert.deepEqual(entries[0].advanced.outputTokenLimit, {
      mode: "custom",
      tokens: 4096,
    });
    assert.deepEqual(entries[1].advanced.outputTokenLimit, { mode: "auto" });
    assert.deepEqual(entries[2].advanced.outputTokenLimit, {
      mode: "custom",
      tokens: 250000,
    });
    assert.deepEqual(entries[3].advanced.outputTokenLimit, {
      mode: "custom",
      tokens: 200000,
    });
  });

  it("resets inherited and deliberately edited legacy caps to Auto", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
      get: (key: string, global?: boolean) => unknown;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider",
          apiBase: "https://api.anthropic.com/v1",
          apiKey: "test",
          authMode: "api_key",
          providerProtocol: "anthropic_messages",
          models: [
            {
              id: "inherited",
              model: "claude-sonnet-4-6",
              temperature: 0.3,
              maxTokens: 4096,
            },
            {
              id: "explicit",
              model: "claude-haiku-4-5",
              temperature: 0.3,
              maxTokens: 4096,
              maxTokensExplicit: true,
            },
          ],
        },
      ]),
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      8,
      true,
    );

    const entries = getRuntimeModelEntries();

    assert.deepEqual(entries[0].advanced.outputTokenLimit, { mode: "auto" });
    assert.deepEqual(entries[1].advanced.outputTokenLimit, { mode: "auto" });
    assert.equal(
      prefs.get(
        `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
        true,
      ),
      9,
    );
    assert.isTrue(consumeOutputTokenAutoMigrationNotice());
    assert.isFalse(consumeOutputTokenAutoMigrationNotice());

    const storedAfterFirstMigration = prefs.get(
      `${config.prefsPrefix}.modelProviderGroups`,
      true,
    );
    getRuntimeModelEntries();
    assert.equal(
      prefs.get(`${config.prefsPrefix}.modelProviderGroups`, true),
      storedAfterFirstMigration,
    );
  });

  it("does not mark the Auto migration complete when saving profiles fails", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
      get: (key: string, global?: boolean) => unknown;
    };
    const groupsKey = `${config.prefsPrefix}.modelProviderGroups`;
    const versionKey = `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`;
    prefs.set(
      groupsKey,
      JSON.stringify([
        {
          id: "provider",
          apiBase: "https://api.openai.com/v1",
          apiKey: "test",
          authMode: "api_key",
          models: [{ id: "model", model: "gpt-5.4", maxTokens: 2048 }],
        },
      ]),
      true,
    );
    prefs.set(versionKey, 8, true);
    const originalSet = prefs.set.bind(prefs);
    prefs.set = (key, value, global) => {
      if (key === groupsKey) throw new Error("profile save failed");
      originalSet(key, value, global);
    };

    assert.throws(() => getModelProviderGroups(), "profile save failed");
    assert.equal(prefs.get(versionKey, true), 8);
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

  it("normalizes WebChat as target-only persisted and runtime state", function () {
    setModelProviderGroups([
      {
        id: "webchat-provider",
        apiBase: "https://ignored.example/v1",
        apiKey: "ignored-secret",
        authMode: "webchat",
        providerProtocol: "responses_api",
        presetIdOverride: "customized",
        models: [
          {
            id: "web-target",
            model: "chatgpt.com",
            temperature: 1.7,
            maxTokens: 99_999,
            maxTokensExplicit: true,
            inputTokenCap: 123,
            inputMode: "text_only",
            providerProtocol: "responses_api",
            profileOverride: { extraBody: { top_k: 10 } },
          },
        ],
      } as unknown as ModelProviderGroup,
    ]);

    const [group] = getModelProviderGroups();
    assert.equal(group.authMode, "webchat");
    if (group.authMode !== "webchat") assert.fail("expected WebChat group");
    assert.deepEqual(group, {
      id: "webchat-provider",
      authMode: "webchat",
      providerProtocol: "web_sync",
      models: [{ id: "web-target", model: "chatgpt.com" }],
    });
    const [entry] = getRuntimeModelEntries();
    assert.equal(entry.authMode, "webchat");
    assert.notProperty(entry, "advanced");

    const stored = JSON.parse(
      String(
        globalThis.Zotero.Prefs.get(
          `${config.prefsPrefix}.modelProviderGroups`,
          true,
        ),
      ),
    ) as Array<Record<string, unknown>>;
    assert.deepEqual(stored, [group]);
  });

  it("migrates legacy WebChat targets and repairs an invalid selection", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
      get: (key: string, global?: boolean) => unknown;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "webchat-provider",
          apiBase: "https://ignored.example/v1",
          apiKey: "ignored",
          authMode: "webchat",
          providerProtocol: "responses_api",
          models: [
            { id: "invalid-row", model: "gpt-5.4", temperature: 1.2 },
            { id: "chatgpt-row", model: "CHATGPT.COM", maxTokens: 1 },
            { id: "duplicate-row", model: "chatgpt.com" },
            { id: "deepseek-row", model: "chat.deepseek.com" },
          ],
        },
      ]),
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.lastUsedModelEntryId`,
      "invalid-row",
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      6,
      true,
    );

    const [group] = getModelProviderGroups();
    assert.equal(group.authMode, "webchat");
    if (group.authMode !== "webchat") assert.fail("expected WebChat group");
    assert.deepEqual(group.models, [
      { id: "chatgpt-row", model: "chatgpt.com" },
      { id: "deepseek-row", model: "chat.deepseek.com" },
    ]);
    assert.equal(getLastUsedModelEntryId(), "chatgpt-row");
    const stored = String(
      prefs.get(`${config.prefsPrefix}.modelProviderGroups`, true),
    );
    assert.notInclude(stored, "temperature");
    assert.notInclude(stored, "maxTokens");
    assert.notInclude(stored, "api.example");
    assert.notInclude(stored, "apiBase");
    assert.notInclude(stored, "apiKey");
  });

  it("preserves a selected WebChat target row that survives migration", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
      get: (key: string, global?: boolean) => unknown;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "webchat-provider",
          apiBase: "https://ignored.example/v1",
          apiKey: "ignored",
          authMode: "webchat",
          models: [
            { id: "chatgpt-row", model: "chatgpt.com" },
            {
              id: "deepseek-row",
              model: "chat.deepseek.com",
              temperature: 1.4,
            },
          ],
        },
      ]),
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.lastUsedModelEntryId`,
      "deepseek-row",
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      6,
      true,
    );

    const [group] = getModelProviderGroups();
    assert.equal(getLastUsedModelEntryId(), "deepseek-row");
    assert.equal(group.models[1]?.id, "deepseek-row");
    const stored = String(
      prefs.get(`${config.prefsPrefix}.modelProviderGroups`, true),
    );
    assert.notInclude(stored, "temperature");
    assert.notInclude(stored, "apiBase");
    assert.notInclude(stored, "apiKey");
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
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
            outputTokenLimit: { mode: "auto" },
            inputMode: "text_only",
          },
          {
            id: "model-2",
            model: "local-text-only",
            temperature: 0.3,
            outputTokenLimit: { mode: "auto" },
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

  it("preserves a newly saved large DeepSeek V4 Custom output limit", function () {
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
            outputTokenLimit: { mode: "custom", tokens: 384000 },
          },
        ],
      },
    ];

    setModelProviderGroups(groups);
    const entries = getRuntimeModelEntries();

    assert.lengthOf(entries, 1);
    assert.deepEqual(entries[0].advanced.outputTokenLimit, {
      mode: "custom",
      tokens: 384000,
    });
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
    assert.equal(entries[0].providerLabel, "Codex Direct (Legacy)");
    assert.equal(entries[0].displayModelLabel, "gpt-5.4");
    assert.equal(
      entries[0].apiBase,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(entries[0].catalogAvailability, "unverified");
  });

  it("collapses legacy Direct groups into one row-backed singleton", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "provider-codex-migration",
          apiBase: "https://custom.example/codex",
          apiKey: "dormant",
          authMode: "codex_auth",
          providerProtocol: "gemini_native",
          models: [
            { id: "m1", model: "first-model", temperature: 0.3, maxTokens: 1 },
            {
              id: "m2",
              model: "selected-model",
              temperature: 1.2,
              maxTokens: 2,
            },
          ],
        },
        {
          id: "provider-codex-duplicate",
          apiBase: "https://ignored.example/codex",
          apiKey: "also-dormant",
          authMode: "codex_auth",
          providerProtocol: "openai_chat_compat",
          codexDirectModel: "third-model",
          models: [
            { id: "m3", model: "FIRST-MODEL", inputTokenCap: 123 },
            { id: "m4", model: "third-model", temperature: 1.7 },
          ],
        },
      ]),
      true,
    );
    prefs.set(`${config.prefsPrefix}.lastUsedModelEntryId`, "m2", true);
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      4,
      true,
    );

    const groups = getModelProviderGroups();
    assert.lengthOf(groups, 1);
    const group = groups[0];
    assert.equal(group.authMode, "codex_auth");
    if (group.authMode !== "codex_auth") assert.fail("expected Direct group");
    assert.notProperty(group, "selectedModel");
    assert.equal(
      group.apiBase,
      "https://chatgpt.com/backend-api/codex/responses",
    );
    assert.equal(group.apiKey, "");
    assert.equal(group.providerProtocol, "codex_responses");
    assert.deepEqual(
      group.models.map((row) => row.model),
      ["first-model", "selected-model", "third-model"],
    );
    assert.notProperty(group.models[1], "temperature");
    assert.equal(
      globalThis.Zotero.Prefs.get(
        `${config.prefsPrefix}.lastUsedModelEntryId`,
        true,
      ),
      "m2",
    );
    const stored = JSON.parse(
      String(
        globalThis.Zotero.Prefs.get(
          `${config.prefsPrefix}.modelProviderGroups`,
          true,
        ),
      ),
    ) as Array<Record<string, unknown>>;
    assert.notProperty(stored[0], "selectedModel");
    assert.notProperty(stored[0], "codexDirectModel");
  });

  it("normalizes an empty Direct card to exactly one model row", function () {
    const groups = normalizeModelProviderGroups([
      {
        id: "provider-direct",
        authMode: "codex_auth",
        models: [],
      },
    ]);
    assert.lengthOf(groups, 1);
    const group = groups[0];
    assert.equal(group.authMode, "codex_auth");
    if (group.authMode !== "codex_auth") assert.fail("expected Direct group");
    assert.lengthOf(group.models, 1);
    assert.equal(group.models[0].model, "");
  });

  it("retains a legacy Direct selection as a row but drops the field", function () {
    const groups = normalizeModelProviderGroups([
      {
        id: "first-direct",
        authMode: "codex_auth",
        models: [{ id: "first-row", model: "first-model" }],
      },
      {
        id: "second-direct",
        authMode: "codex_auth",
        selectedModel: "saved-selection",
        models: [{ id: "saved-row", model: "saved-selection" }],
      },
    ]);
    assert.lengthOf(groups, 1);
    const group = groups[0];
    assert.equal(group.authMode, "codex_auth");
    if (group.authMode !== "codex_auth") assert.fail("expected Direct group");
    assert.notProperty(group, "selectedModel");
    assert.deepEqual(
      group.models.map((row) => row.model),
      ["first-model", "saved-selection"],
    );
  });

  it("migrates a legacy Direct model string to its stable row ID", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
      get: (key: string, global?: boolean) => unknown;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "direct",
          authMode: "codex_auth",
          selectedModel: "saved-selection",
          models: [{ id: "saved-row", model: "saved-selection" }],
        },
      ]),
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      5,
      true,
    );

    getModelProviderGroups();

    assert.equal(getLastUsedModelEntryId(), "saved-row");
    const stored = JSON.parse(
      String(prefs.get(`${config.prefsPrefix}.modelProviderGroups`, true)),
    ) as Array<Record<string, unknown>>;
    assert.notProperty(stored[0], "selectedModel");
  });

  it("does not replace a valid non-Direct selection during Direct migration", function () {
    const prefs = globalThis.Zotero.Prefs as {
      set: (key: string, value: unknown, global?: boolean) => void;
    };
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroups`,
      JSON.stringify([
        {
          id: "standard",
          authMode: "api_key",
          apiBase: "https://api.openai.com/v1",
          models: [{ id: "standard-row", model: "gpt-standard" }],
        },
        {
          id: "direct",
          authMode: "codex_auth",
          selectedModel: "saved-selection",
          models: [{ id: "saved-row", model: "saved-selection" }],
        },
      ]),
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.lastUsedModelEntryId`,
      "standard-row",
      true,
    );
    prefs.set(
      `${config.prefsPrefix}.modelProviderGroupsMigrationVersion`,
      5,
      true,
    );

    getModelProviderGroups();

    assert.equal(getLastUsedModelEntryId(), "standard-row");
  });

  it("exposes only configured Direct rows and publishes live context limits", async function () {
    setModelProviderGroups([
      {
        id: "provider-direct",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        models: [
          { id: "saved-row", model: "saved-missing" },
          { id: "catalog-row", model: "catalog-first" },
        ],
      },
    ]);
    const fallbackLimit = resolveModelInputTokenLimit(
      "catalog-first",
      undefined,
      {
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        protocol: "codex_responses",
        authMode: "codex_auth",
      },
    );
    assert.equal(fallbackLimit.limitTokens, 256000);
    assert.equal(fallbackLimit.source, "default");
    await loadCodexDirectCatalog({
      authPath: "/test/codex/auth.json",
      readText: async () =>
        JSON.stringify({
          tokens: { access_token: "test", refresh_token: "refresh" },
        }),
      fetchFn: (async () =>
        new Response(
          JSON.stringify({
            models: [
              {
                slug: "catalog-first",
                display_name: "Catalog First",
                visibility: "list",
                priority: 10,
                context_window: 128000,
                supported_reasoning_levels: [],
              },
              {
                slug: "catalog-second",
                display_name: "Catalog Second",
                visibility: "list",
                priority: 5,
                supported_reasoning_levels: [],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch,
    });

    const entries = getRuntimeModelEntries();
    assert.deepEqual(
      entries.map((entry) => entry.model),
      ["saved-missing", "catalog-first"],
    );
    assert.equal(entries[0].catalogAvailability, "saved-unavailable");
    assert.equal(entries[1].catalogAvailability, "available");
    assert.equal(entries[1].providerLabel, "Codex Direct (Legacy)");
    assert.equal(entries[1].advanced.temperature, 0.3);
    assert.deepEqual(entries[1].advanced.outputTokenLimit, { mode: "auto" });
    assert.isUndefined(entries[1].advanced.inputTokenCap);
    assert.notInclude(
      entries.map((entry) => entry.model),
      "catalog-second",
    );
    assert.equal(
      resolveModelInputTokenLimit("catalog-first", undefined, {
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        protocol: "codex_responses",
        authMode: "codex_auth",
      }).limitTokens,
      128000,
    );
  });

  it("changes Direct selection through one stable ID without provider notifications", function () {
    setModelProviderGroups([
      {
        id: "provider-direct",
        apiBase: "https://chatgpt.com/backend-api/codex/responses",
        apiKey: "",
        authMode: "codex_auth",
        providerProtocol: "codex_responses",
        models: [
          { id: "first-row", model: "first-model" },
          { id: "second-row", model: "second-model" },
        ],
      },
    ]);
    const storedBefore = globalThis.Zotero.Prefs.get(
      `${config.prefsPrefix}.modelProviderGroups`,
      true,
    );
    let providerNotifications = 0;
    const unsubscribe = subscribeModelProviderGroups(() => {
      providerNotifications += 1;
    });

    setSelectedModelEntry("second-row");

    assert.equal(getLastUsedModelEntryId(), "second-row");
    assert.equal(getSelectedModelEntry()?.entryId, "second-row");
    assert.equal(providerNotifications, 0);
    assert.equal(
      globalThis.Zotero.Prefs.get(
        `${config.prefsPrefix}.modelProviderGroups`,
        true,
      ),
      storedBefore,
    );
    unsubscribe();
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

    it("uses the fixed endpoint when leaving codex_app_server for Codex Direct", function () {
      assert.equal(
        migrateApiBaseForAuthModeChange(
          "codex_app_server",
          "codex_auth",
          "C:\\nvm4w\\nodejs\\codex.cmd",
        ),
        "https://chatgpt.com/backend-api/codex/responses",
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

    it("uses the fixed endpoint when entering Codex Direct", function () {
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
        "https://chatgpt.com/backend-api/codex/responses",
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
            outputTokenLimit: { mode: "auto" },
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
