import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  getSelectedReasoningForItem,
  resolveEffectiveRequestConfig,
} from "../src/modules/contextPanel/chat";
import {
  clearStandaloneSurfaceChoices,
  setSelectedModelEntryForSurface,
  surfaceChoices,
} from "../src/modules/contextPanel/surfaceChoices";
import {
  clearSelectedReasoningForSurface,
  reasoningCacheKey,
  selectedReasoningCache,
} from "../src/modules/contextPanel/state";
import { setModelProviderGroups } from "../src/utils/modelProviders";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };

describe("request config: a panel's send uses its own surface's model", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();
  const item = { id: 4242, libraryID: 1 } as unknown as Zotero.Item;

  beforeEach(function () {
    prefStore.clear();
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
        id: "group-a",
        authMode: "api_key",
        apiBase: "https://surface-request.invalid/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
        models: [
          { id: "entry-a", model: "model-a" },
          { id: "entry-b", model: "model-b" },
        ],
      },
      {
        id: "group-web",
        authMode: "webchat",
        apiBase: "",
        apiKey: "",
        providerProtocol: "web_sync",
        models: [{ id: "entry-web", model: "chatgpt.com" }],
      },
    ] as any);
    prefStore.set(`${config.prefsPrefix}.lastUsedModelEntryId`, "entry-a");
  });

  afterEach(function () {
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = originalZotero;
  });

  it("fills an unspecified model from the window's choice only for the window", function () {
    setSelectedModelEntryForSurface("entry-b", "standalone");

    assert.equal(
      resolveEffectiveRequestConfig({ item, surface: "standalone" }).model,
      "model-b",
    );
    assert.equal(
      resolveEffectiveRequestConfig({ item, surface: "embedded" }).model,
      "model-a",
    );
    // An item no panel shows resolves for the sidebar.
    assert.equal(resolveEffectiveRequestConfig({ item }).model, "model-a");
  });

  it("WebChat in the window does not make the sidebar a WebChat request", function () {
    setSelectedModelEntryForSurface("entry-web", "standalone");

    assert.equal(
      resolveEffectiveRequestConfig({ item, surface: "standalone" })
        .providerProtocol,
      "web_sync",
    );
    assert.notEqual(
      resolveEffectiveRequestConfig({ item, surface: "embedded" })
        .providerProtocol,
      "web_sync",
    );
  });

  it("a Codex send with no model named uses its own surface's Codex model and effort", function () {
    prefStore.set(`${config.prefsPrefix}.enableCodexAppServerMode`, true);
    prefStore.set(`${config.prefsPrefix}.codexAppServerModel`, "gpt-5.4");
    prefStore.set(`${config.prefsPrefix}.codexAppServerReasoning`, "low");
    surfaceChoices.codexRuntimeModel.set("gpt-5.5", "standalone");
    surfaceChoices.codexReasoningMode.set("high", "standalone");

    const windowConfig = resolveEffectiveRequestConfig({
      item,
      authMode: "codex_app_server",
      surface: "standalone",
    });
    const sidebarConfig = resolveEffectiveRequestConfig({
      item,
      authMode: "codex_app_server",
      surface: "embedded",
    });
    assert.equal(windowConfig.model, "gpt-5.5");
    assert.equal((windowConfig.reasoning as any)?.effort, "high");
    assert.equal(sidebarConfig.model, "gpt-5.4");
    assert.equal((sidebarConfig.reasoning as any)?.effort, "low");
  });

  it("an API send falls back to its own surface's last reasoning level", function () {
    surfaceChoices.lastUsedReasoningLevel.set("low", "embedded");
    surfaceChoices.lastUsedReasoningLevel.set("high", "standalone");

    const windowLevel = getSelectedReasoningForItem(
      9001,
      "gpt-5",
      "https://api.openai.com/v1",
      "responses_api",
      undefined,
      "standalone",
    )?.level;
    const sidebarLevel = getSelectedReasoningForItem(
      9002,
      "gpt-5",
      "https://api.openai.com/v1",
      "responses_api",
      undefined,
      "embedded",
    )?.level;
    assert.equal(windowLevel, "high");
    assert.equal(sidebarLevel, "low");
  });

  it("the window and a sidebar panel showing the same conversation keep separate reasoning levels", function () {
    clearSelectedReasoningForSurface("embedded");
    clearSelectedReasoningForSurface("standalone");
    surfaceChoices.lastUsedReasoningLevel.set("low", "embedded");
    surfaceChoices.lastUsedReasoningLevel.set("high", "standalone");
    const ask = (surface: "embedded" | "standalone") =>
      getSelectedReasoningForItem(
        7777,
        "gpt-5",
        "https://api.openai.com/v1",
        "responses_api",
        undefined,
        surface,
      )?.level;

    // Same item id on both surfaces: the sidebar resolves first, then the
    // window must still get its own level rather than the sidebar's cached one.
    assert.equal(ask("embedded"), "low");
    assert.equal(ask("standalone"), "high");
    assert.equal(ask("embedded"), "low");

    // Picking a level on one surface and clearing that surface leaves the other's.
    clearSelectedReasoningForSurface("standalone");
    assert.isUndefined(
      selectedReasoningCache.get(reasoningCacheKey("standalone", 7777)),
    );
    assert.equal(
      selectedReasoningCache.get(reasoningCacheKey("embedded", 7777)),
      "low",
    );
  });
});
