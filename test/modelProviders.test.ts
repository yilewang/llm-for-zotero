import { assert } from "chai";
import { config } from "../package.json";
import {
  buildModelProviderGroupsFromLegacySlots,
  deriveProviderLabel,
  getRuntimeModelEntries,
  setModelProviderGroups,
  type LegacyModelSlot,
  type ModelProviderGroup,
} from "../src/utils/modelProviders";

describe("modelProviders", function () {
  const originalZotero = globalThis.Zotero;

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
    assert.equal(entries[0].providerProtocol, "openai_chat_compat");
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
});
