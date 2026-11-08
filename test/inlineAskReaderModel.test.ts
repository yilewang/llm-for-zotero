import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import { getSelectedReasoningForItem } from "../src/modules/contextPanel/chat";
import {
  createInlineAskModelPicker,
  INLINE_ASK_MODEL_ENTRY_PREF,
  resolveInlineAskModelChoice,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskReader";
import {
  resetCodexDirectCatalogForTests,
  setCodexDirectCatalogDependenciesForTests,
} from "../src/codexAuth/modelCatalog";
import { clearStandaloneSurfaceChoices } from "../src/modules/contextPanel/surfaceChoices";
import {
  clearSelectedReasoningForSurface,
  reasoningCacheKey,
  selectedReasoningCache,
  selectedReasoningProviderCache,
} from "../src/modules/contextPanel/state";
import { setModelProviderGroups } from "../src/utils/modelProviders";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

/**
 * Inline Ask reads the sidebar's effort for its own model; it must never
 * write the sidebar's per-item reasoning cache ("embedded:<itemId>").
 */
describe("Inline Ask reads the sidebar's reasoning without changing it", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const itemId = 8_801;
  const sidebarKey = reasoningCacheKey("embedded", itemId);

  beforeEach(function () {
    prefStore.clear();
    clearStandaloneSurfaceChoices();
    clearSelectedReasoningForSurface("embedded");
    globalScope.Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
        clear: (key: string) => {
          prefStore.delete(key);
        },
      },
    };
    setModelProviderGroups([
      {
        id: "group-openai",
        authMode: "api_key",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "responses_api",
        models: [{ id: "entry-openai", model: "gpt-5" }],
      },
      {
        id: "group-anthropic",
        authMode: "api_key",
        apiBase: "https://api.anthropic.com/v1",
        apiKey: "key",
        providerProtocol: "anthropic_messages",
        models: [{ id: "entry-anthropic", model: "claude-sonnet-4-5" }],
      },
    ] as any);
    prefStore.set(`${config.prefsPrefix}.lastUsedModelEntryId`, "entry-openai");
  });

  afterEach(function () {
    clearSelectedReasoningForSurface("embedded");
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = originalZotero;
  });

  it("keeps the sidebar's level and provider when Inline Ask uses another provider", function () {
    selectedReasoningCache.set(sidebarKey, "high");
    selectedReasoningProviderCache.set(sidebarKey, "openai");
    prefStore.set(
      `${config.prefsPrefix}.${INLINE_ASK_MODEL_ENTRY_PREF}`,
      "entry-anthropic",
    );

    const choice = resolveInlineAskModelChoice(itemId);
    assert.equal(choice?.target.model, "claude-sonnet-4-5");

    assert.equal(selectedReasoningCache.get(sidebarKey), "high");
    assert.equal(selectedReasoningProviderCache.get(sidebarKey), "openai");
    assert.equal(
      getSelectedReasoningForItem(
        itemId,
        "gpt-5",
        "https://api.openai.com/v1",
        "responses_api",
        undefined,
        "embedded",
      )?.level,
      "high",
      "the sidebar still sends with its own level",
    );
  });

  it("writes nothing when the sidebar had no cached level", function () {
    prefStore.set(
      `${config.prefsPrefix}.${INLINE_ASK_MODEL_ENTRY_PREF}`,
      "entry-anthropic",
    );
    resolveInlineAskModelChoice(itemId);
    assert.isFalse(selectedReasoningCache.has(sidebarKey));
    assert.isFalse(selectedReasoningProviderCache.has(sidebarKey));
  });
});

describe("Inline Ask's model picker loads the Codex Direct catalog", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const itemId = 8_802;
  let fetches = 0;

  beforeEach(function () {
    prefStore.clear();
    fetches = 0;
    resetCodexDirectCatalogForTests();
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = {
      Prefs: {
        get: (key: string) => prefStore.get(key) ?? "",
        set: (key: string, value: unknown) => {
          prefStore.set(key, value);
        },
        clear: (key: string) => {
          prefStore.delete(key);
        },
      },
    };
    setModelProviderGroups([
      {
        id: "group-codex",
        authMode: "codex_auth",
        apiBase: "",
        apiKey: "",
        providerProtocol: "codex_responses",
        models: [{ id: "entry-codex", model: "gpt-codex" }],
      },
    ] as any);
    prefStore.set(
      `${config.prefsPrefix}.${INLINE_ASK_MODEL_ENTRY_PREF}`,
      "entry-codex",
    );
    setCodexDirectCatalogDependenciesForTests({
      authPath: "/test/codex/auth.json",
      readText: async () =>
        JSON.stringify({
          tokens: {
            access_token: "access",
            refresh_token: "refresh",
            account_id: "account",
          },
        }),
      fetchFn: (async () => {
        fetches += 1;
        return new Response(
          JSON.stringify({
            models: [
              {
                slug: "gpt-codex",
                display_name: "GPT Codex",
                visibility: "list",
                priority: 1,
                supported_reasoning_levels: [
                  { effort: "low", description: "Faster" },
                  { effort: "high", description: "Deeper" },
                ],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }) as typeof fetch,
    });
  });

  afterEach(function () {
    setCodexDirectCatalogDependenciesForTests(undefined);
    resetCodexDirectCatalogForTests();
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = originalZotero;
  });

  it("opening a menu starts the load and reports the real effort levels", async function () {
    const state = { choice: resolveInlineAskModelChoice(itemId) };
    assert.equal(state.choice?.target.model, "gpt-codex");
    assert.deepEqual(
      state.choice?.levels.map((level) => level.value),
      ["auto"],
      "before the catalog, Auto only",
    );
    const picker = createInlineAskModelPicker(itemId, state);
    const changed = new Promise<void>((resolve) =>
      picker.prepareMenu!(() => resolve()),
    );
    await changed;
    assert.equal(fetches, 1);
    assert.deepEqual(
      state.choice?.levels.map((level) => level.value),
      ["auto", "low", "high"],
    );
    assert.deepEqual(
      picker.effortMenu().levels.map((level) => level.value),
      ["auto", "low", "high"],
    );
    // Loaded: the next menu opens without another request.
    let calledAgain = false;
    picker.prepareMenu!(() => {
      calledAgain = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetches, 1);
    assert.isFalse(calledAgain);
  });

  it("does nothing without a Codex Direct provider", async function () {
    setModelProviderGroups([
      {
        id: "group-openai",
        authMode: "api_key",
        apiBase: "https://api.openai.com/v1",
        apiKey: "key",
        providerProtocol: "responses_api",
        models: [{ id: "entry-openai", model: "gpt-5" }],
      },
    ] as any);
    const picker = createInlineAskModelPicker(itemId, {
      choice: resolveInlineAskModelChoice(itemId),
    });
    picker.prepareMenu!(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetches, 0);
  });
});
