import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import { resolveEffectiveRequestConfig } from "../src/modules/contextPanel/chat";
import {
  clearStandaloneSurfaceChoices,
  setSelectedModelEntryForSurface,
} from "../src/modules/contextPanel/surfaceChoices";
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
});
