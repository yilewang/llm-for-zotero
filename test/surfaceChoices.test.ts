import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  bindSurfaceChoices,
  clearStandaloneSurfaceChoices,
  clearTornSurfaceChoices,
  demoteConversationSystemOnEverySurface,
  resetSideSurfaceChoices,
  startSideSurfaceChoicesFromStandalone,
  startStandaloneSurfaceChoicesFromSidebar,
  startTornSurfaceChoices,
  getSelectedModelEntryForSurface,
  setSelectedModelEntryForSurface,
  surfaceChoices,
} from "../src/modules/contextPanel/surfaceChoices";
import { resolvePreferredConversationSystem } from "../src/modules/contextPanel/portalScope";
import { setModelProviderGroups } from "../src/utils/modelProviders";

const globalScope = globalThis as typeof globalThis & { Zotero?: unknown };
const pref = (key: string) => `${config.prefsPrefix}.${key}`;

describe("surfaceChoices: each chat surface keeps its own model and backend", function () {
  const originalZotero = globalScope.Zotero;
  const prefStore = new Map<string, unknown>();

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
        apiBase: "https://surface-choices.invalid/v1",
        apiKey: "key",
        providerProtocol: "openai_chat_compat",
        models: [
          { id: "entry-a", model: "model-a" },
          { id: "entry-b", model: "model-b" },
        ],
      },
    ] as any);
    prefStore.set(pref("lastUsedModelEntryId"), "entry-a");
  });

  afterEach(function () {
    clearStandaloneSurfaceChoices();
    globalScope.Zotero = originalZotero;
  });

  it("a model chosen in the window stays out of the sidebar and the saved pref", function () {
    setSelectedModelEntryForSurface("entry-b", "standalone");

    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-b",
    );
    assert.equal(getSelectedModelEntryForSurface("embedded")?.model, "model-a");
    assert.equal(getSelectedModelEntryForSurface()?.model, "model-a");
    assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-a");
  });

  it("the sidebar's choice is saved, and the window reads it until it chooses", function () {
    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-a",
    );

    setSelectedModelEntryForSurface("entry-b", "embedded");

    assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-b");
    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-b",
    );

    setSelectedModelEntryForSurface("entry-a", "standalone");
    setSelectedModelEntryForSurface("entry-b", "embedded");
    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-a",
    );
  });

  it("an unknown model entry is not remembered for the window", function () {
    setSelectedModelEntryForSurface("missing-entry", "standalone");
    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-a",
    );
  });

  it("a new window starts from the sidebar's current values", function () {
    setSelectedModelEntryForSurface("entry-b", "standalone");
    surfaceChoices.conversationSystem.set("claude_code", "standalone");

    clearStandaloneSurfaceChoices();

    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-a",
    );
    assert.equal(
      surfaceChoices.conversationSystem.get("standalone"),
      "upstream",
    );
  });

  it("a window copies the sidebar's choices when it opens, and later sidebar changes leave it alone", function () {
    prefStore.set(pref("conversationSystem"), "claude_code");
    prefStore.set(pref("claudeCodeModel"), "sonnet");
    prefStore.set(pref("codexAppServerReasoning"), "medium");
    prefStore.set(pref("lastUsedRuntimeMode"), "agent");
    surfaceChoices.lastUsedReasoningLevelForProvider.set(
      "openai",
      "low",
      "embedded",
    );
    surfaceChoices.codexDirectReasoningSelection.set(
      "gpt-5.4",
      "medium",
      "embedded",
    );
    // A previous window's choice does not carry over.
    surfaceChoices.claudeRuntimeModel.set("haiku", "standalone");

    startStandaloneSurfaceChoicesFromSidebar();

    setSelectedModelEntryForSurface("entry-b", "embedded");
    surfaceChoices.conversationSystem.set("upstream", "embedded");
    surfaceChoices.claudeRuntimeModel.set("opus", "embedded");
    surfaceChoices.codexReasoningMode.set("xhigh", "embedded");
    surfaceChoices.lastUsedRuntimeMode.set("chat", "embedded");
    surfaceChoices.lastUsedReasoningLevelForProvider.set(
      "openai",
      "high",
      "embedded",
    );
    surfaceChoices.lastUsedReasoningLevelForProvider.set(
      "gemini",
      "high",
      "embedded",
    );
    surfaceChoices.codexDirectReasoningSelection.set(
      "gpt-5.4",
      "high",
      "embedded",
    );
    surfaceChoices.codexDirectReasoningSelection.set(
      "gpt-5.5",
      "low",
      "embedded",
    );

    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-a",
    );
    assert.equal(
      surfaceChoices.conversationSystem.get("standalone"),
      "claude_code",
    );
    assert.equal(surfaceChoices.claudeRuntimeModel.get("standalone"), "sonnet");
    assert.equal(surfaceChoices.codexReasoningMode.get("standalone"), "medium");
    assert.equal(surfaceChoices.lastUsedRuntimeMode.get("standalone"), "agent");
    assert.equal(
      surfaceChoices.lastUsedReasoningLevelForProvider.get(
        "openai",
        "standalone",
      ),
      "low",
    );
    // A provider or model the sidebar had no value for when the window
    // opened reads as unset, not as the sidebar's later value.
    assert.isNull(
      surfaceChoices.lastUsedReasoningLevelForProvider.get(
        "gemini",
        "standalone",
      ),
    );
    assert.equal(
      surfaceChoices.codexDirectReasoningSelection.get("gpt-5.4", "standalone"),
      "medium",
    );
    assert.equal(
      surfaceChoices.codexDirectReasoningSelection.get("gpt-5.5", "standalone"),
      "auto",
    );
    // The window's own choices still win over its snapshot.
    setSelectedModelEntryForSurface("entry-b", "standalone");
    assert.equal(
      getSelectedModelEntryForSurface("standalone")?.model,
      "model-b",
    );
  });

  it("keeps the conversation system per surface", function () {
    prefStore.set(pref("conversationSystem"), "claude_code");
    assert.equal(
      surfaceChoices.conversationSystem.get("standalone"),
      "claude_code",
    );

    surfaceChoices.conversationSystem.set("upstream", "embedded");
    assert.equal(prefStore.get(pref("conversationSystem")), "upstream");
    assert.equal(
      surfaceChoices.conversationSystem.get("standalone"),
      "upstream",
    );

    surfaceChoices.conversationSystem.set("codex", "standalone");
    surfaceChoices.conversationSystem.set("claude_code", "embedded");
    assert.equal(surfaceChoices.conversationSystem.get("standalone"), "codex");
    assert.equal(
      surfaceChoices.conversationSystem.get("embedded"),
      "claude_code",
    );
    assert.equal(prefStore.get(pref("conversationSystem")), "claude_code");
  });

  it("disabling a runtime demotes it on both surfaces", function () {
    prefStore.set(pref("conversationSystem"), "codex");
    surfaceChoices.conversationSystem.set("codex", "standalone");

    demoteConversationSystemOnEverySurface("codex");

    assert.equal(prefStore.get(pref("conversationSystem")), "upstream");
    assert.equal(
      surfaceChoices.conversationSystem.get("standalone"),
      "upstream",
    );
  });

  it("keeps the Claude Code and Codex runtime model and effort per surface", function () {
    prefStore.set(pref("claudeCodeModel"), "sonnet");
    prefStore.set(pref("claudeCodeReasoning"), "high");
    prefStore.set(pref("codexAppServerModel"), "gpt-5.4");
    prefStore.set(pref("codexAppServerReasoning"), "medium");

    surfaceChoices.claudeRuntimeModel.set("opus", "standalone");
    surfaceChoices.claudeReasoningMode.set("max", "standalone");
    surfaceChoices.codexRuntimeModel.set("gpt-5.5", "standalone");
    surfaceChoices.codexReasoningMode.set("xhigh", "standalone");

    assert.equal(surfaceChoices.claudeRuntimeModel.get("standalone"), "opus");
    assert.equal(surfaceChoices.claudeReasoningMode.get("standalone"), "max");
    assert.equal(surfaceChoices.codexRuntimeModel.get("standalone"), "gpt-5.5");
    assert.equal(surfaceChoices.codexReasoningMode.get("standalone"), "xhigh");
    assert.equal(surfaceChoices.claudeRuntimeModel.get("embedded"), "sonnet");
    assert.equal(surfaceChoices.claudeReasoningMode.get("embedded"), "high");
    assert.equal(surfaceChoices.codexRuntimeModel.get("embedded"), "gpt-5.4");
    assert.equal(surfaceChoices.codexReasoningMode.get("embedded"), "medium");
    assert.equal(prefStore.get(pref("claudeCodeModel")), "sonnet");
    assert.equal(prefStore.get(pref("codexAppServerReasoning")), "medium");

    // The window validates its writes as the prefs do.
    surfaceChoices.claudeRuntimeModel.set("  ", "standalone");
    surfaceChoices.claudeReasoningMode.set("bogus" as any, "standalone");
    assert.equal(surfaceChoices.claudeRuntimeModel.get("standalone"), "opus");
    assert.equal(surfaceChoices.claudeReasoningMode.get("standalone"), "max");
  });

  it("keeps the reasoning fallbacks and the Chat/Agent default per surface", function () {
    surfaceChoices.lastUsedReasoningLevel.set("high", "embedded");
    surfaceChoices.lastUsedReasoningLevelForProvider.set(
      "openai",
      "low",
      "embedded",
    );
    surfaceChoices.lastUsedRuntimeMode.set("chat", "embedded");
    surfaceChoices.codexDirectReasoningSelection.set(
      "gpt-5.4",
      "medium",
      "embedded",
    );

    surfaceChoices.lastUsedReasoningLevel.set("low", "standalone");
    surfaceChoices.lastUsedReasoningLevelForProvider.set(
      "OpenAI",
      "xhigh",
      "standalone",
    );
    surfaceChoices.lastUsedRuntimeMode.set("agent", "standalone");
    surfaceChoices.codexDirectReasoningSelection.set(
      "GPT-5.4",
      "high",
      "standalone",
    );

    assert.equal(
      surfaceChoices.lastUsedReasoningLevel.get("standalone"),
      "low",
    );
    assert.equal(surfaceChoices.lastUsedReasoningLevel.get("embedded"), "high");
    assert.equal(
      surfaceChoices.lastUsedReasoningLevelForProvider.get(
        "openai",
        "standalone",
      ),
      "xhigh",
    );
    assert.equal(
      surfaceChoices.lastUsedReasoningLevelForProvider.get(
        "openai",
        "embedded",
      ),
      "low",
    );
    // A provider the window never set falls back to the sidebar's.
    assert.isNull(
      surfaceChoices.lastUsedReasoningLevelForProvider.get(
        "gemini",
        "standalone",
      ),
    );
    assert.equal(surfaceChoices.lastUsedRuntimeMode.get("standalone"), "agent");
    assert.equal(surfaceChoices.lastUsedRuntimeMode.get("embedded"), "chat");
    assert.equal(
      surfaceChoices.codexDirectReasoningSelection.get("gpt-5.4", "standalone"),
      "high",
    );
    assert.equal(
      surfaceChoices.codexDirectReasoningSelection.get("gpt-5.4", "embedded"),
      "medium",
    );
    assert.equal(prefStore.get(pref("lastUsedRuntimeMode")), "chat");
    assert.equal(prefStore.get(pref("lastUsedReasoningLevel")), "high");
  });

  it("a bound panel follows its surface on every call", function () {
    let surface: "embedded" | "standalone" = "standalone";
    const choices = bindSurfaceChoices(() => surface);

    choices.setSelectedModelEntry("entry-b");
    assert.equal(choices.getSelectedModelEntry()?.model, "model-b");

    surface = "embedded";
    assert.equal(choices.getSelectedModelEntry()?.model, "model-a");
    assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-a");
  });

  it("a panel with nothing else to go on starts on its own surface's backend", function () {
    prefStore.set(pref("enableClaudeCodeMode"), true);
    prefStore.set(pref("enableCodexAppServerMode"), true);
    prefStore.set(pref("conversationSystem"), "upstream");
    surfaceChoices.conversationSystem.set("claude_code", "standalone");

    assert.equal(
      resolvePreferredConversationSystem({ item: null, surface: "standalone" }),
      "claude_code",
    );
    assert.equal(
      resolvePreferredConversationSystem({ item: null, surface: "embedded" }),
      "upstream",
    );
    assert.equal(
      resolvePreferredConversationSystem({ item: null }),
      "upstream",
    );
  });

  describe("the side chat surface", function () {
    beforeEach(function () {
      resetSideSurfaceChoices();
      setModelProviderGroups([
        {
          id: "group-a",
          authMode: "api_key",
          apiBase: "https://surface-choices.invalid/v1",
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
    });

    afterEach(function () {
      resetSideSurfaceChoices();
    });

    it("starts from the window's model and keeps its own afterwards, writing no pref", function () {
      setSelectedModelEntryForSurface("entry-b", "standalone");
      startSideSurfaceChoicesFromStandalone();
      assert.equal(getSelectedModelEntryForSurface("side")?.model, "model-b");

      setSelectedModelEntryForSurface("entry-a", "side");
      assert.equal(getSelectedModelEntryForSurface("side")?.model, "model-a");
      assert.equal(
        getSelectedModelEntryForSurface("standalone")?.model,
        "model-b",
      );
      assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-a");

      setSelectedModelEntryForSurface("entry-a", "standalone");
      setSelectedModelEntryForSurface("entry-b", "side");
      assert.equal(
        getSelectedModelEntryForSurface("standalone")?.model,
        "model-a",
      );
      assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-a");
    });

    it("never takes a WebChat model entry", function () {
      setSelectedModelEntryForSurface("entry-web", "standalone");
      startSideSurfaceChoicesFromStandalone();
      assert.notEqual(
        getSelectedModelEntryForSurface("side")?.authMode,
        "webchat",
      );

      setSelectedModelEntryForSurface("entry-web", "side");
      assert.notEqual(
        getSelectedModelEntryForSurface("side")?.authMode,
        "webchat",
      );
    });

    it("always runs on the API runtime", function () {
      prefStore.set(pref("enableClaudeCodeMode"), true);
      surfaceChoices.conversationSystem.set("claude_code", "standalone");
      startSideSurfaceChoicesFromStandalone();
      assert.equal(surfaceChoices.conversationSystem.get("side"), "upstream");

      surfaceChoices.conversationSystem.set("codex", "side");
      assert.equal(surfaceChoices.conversationSystem.get("side"), "upstream");
      assert.equal(
        surfaceChoices.conversationSystem.get("standalone"),
        "claude_code",
      );
      assert.equal(
        resolvePreferredConversationSystem({ item: null, surface: "side" }),
        "upstream",
      );
    });

    it("keeps its reasoning and Chat/Agent choices apart from the other surfaces", function () {
      prefStore.set(pref("lastUsedRuntimeMode"), "agent");
      surfaceChoices.lastUsedReasoningLevelForProvider.set(
        "openai",
        "high",
        "standalone",
      );
      startSideSurfaceChoicesFromStandalone();
      assert.equal(surfaceChoices.lastUsedRuntimeMode.get("side"), "agent");
      assert.equal(
        surfaceChoices.lastUsedReasoningLevelForProvider.get("openai", "side"),
        "high",
      );

      surfaceChoices.lastUsedRuntimeMode.set("chat", "side");
      surfaceChoices.lastUsedReasoningLevelForProvider.set(
        "openai",
        "low",
        "side",
      );
      surfaceChoices.lastUsedReasoningLevel.set("low", "side");
      assert.equal(surfaceChoices.lastUsedRuntimeMode.get("side"), "chat");
      assert.equal(
        surfaceChoices.lastUsedReasoningLevelForProvider.get("openai", "side"),
        "low",
      );
      assert.equal(prefStore.get(pref("lastUsedRuntimeMode")), "agent");
      assert.isUndefined(prefStore.get(pref("lastUsedReasoningLevel")));
      assert.equal(
        surfaceChoices.lastUsedReasoningLevelForProvider.get(
          "openai",
          "standalone",
        ),
        "high",
      );

      resetSideSurfaceChoices();
      assert.equal(surfaceChoices.lastUsedRuntimeMode.get("side"), "agent");
    });

    it("the side chat starts from the standalone window, never a torn window", function () {
      prefStore.set(pref("lastUsedRuntimeMode"), "agent");
      startTornSurfaceChoices("torn:1");
      setSelectedModelEntryForSurface("entry-b", "torn:1");
      surfaceChoices.lastUsedRuntimeMode.set("chat", "torn:1");
      startSideSurfaceChoicesFromStandalone();
      assert.equal(getSelectedModelEntryForSurface("side")?.model, "model-a");
      assert.equal(surfaceChoices.lastUsedRuntimeMode.get("side"), "agent");

      resetSideSurfaceChoices();
      assert.equal(getSelectedModelEntryForSurface("torn:1")?.model, "model-b");
      assert.equal(surfaceChoices.lastUsedRuntimeMode.get("torn:1"), "chat");
      clearTornSurfaceChoices("torn:1");
    });
  });

  describe("torn window surfaces", function () {
    beforeEach(function () {
      clearTornSurfaceChoices("torn:1");
      clearTornSurfaceChoices("torn:2");
      setModelProviderGroups([
        {
          id: "group-a",
          authMode: "api_key",
          apiBase: "https://surface-choices.invalid/v1",
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
    });

    afterEach(function () {
      clearTornSurfaceChoices("torn:1");
      clearTornSurfaceChoices("torn:2");
    });

    it("a torn surface starts from the standalone window's choices and diverges", function () {
      surfaceChoices.modelEntryId.set("entry-a", "standalone");
      startTornSurfaceChoices("torn:1");
      surfaceChoices.modelEntryId.set("entry-b", "torn:1");
      assert.equal(surfaceChoices.modelEntryId.get("standalone"), "entry-a");
      assert.equal(surfaceChoices.modelEntryId.get("torn:1"), "entry-b");

      // A later window change does not move a started torn window.
      prefStore.set(pref("conversationSystem"), "upstream");
      surfaceChoices.conversationSystem.set("codex", "standalone");
      assert.equal(surfaceChoices.conversationSystem.get("torn:1"), "upstream");
      surfaceChoices.conversationSystem.set("claude_code", "torn:1");
      assert.equal(
        surfaceChoices.conversationSystem.get("torn:1"),
        "claude_code",
      );
      assert.equal(
        surfaceChoices.conversationSystem.get("standalone"),
        "codex",
      );
      // A torn window that was never started reads the standalone window's.
      assert.equal(surfaceChoices.conversationSystem.get("torn:2"), "codex");
      assert.equal(prefStore.get(pref("lastUsedModelEntryId")), "entry-a");
      assert.equal(prefStore.get(pref("conversationSystem")), "upstream");
    });

    it("a torn surface copies keyed choices and reads unset for keys the window lacked", function () {
      surfaceChoices.lastUsedReasoningLevelForProvider.set(
        "openai",
        "high",
        "standalone",
      );
      startTornSurfaceChoices("torn:1");
      surfaceChoices.lastUsedReasoningLevelForProvider.set(
        "anthropic",
        "low",
        "standalone",
      );
      assert.equal(
        surfaceChoices.lastUsedReasoningLevelForProvider.get(
          "openai",
          "torn:1",
        ),
        "high",
      );
      assert.isNull(
        surfaceChoices.lastUsedReasoningLevelForProvider.get(
          "anthropic",
          "torn:1",
        ),
      );
      surfaceChoices.lastUsedReasoningLevelForProvider.set(
        "openai",
        "low",
        "torn:1",
      );
      assert.equal(
        surfaceChoices.lastUsedReasoningLevelForProvider.get(
          "openai",
          "standalone",
        ),
        "high",
      );
    });

    it("a torn surface never resolves to a WebChat model entry", function () {
      setSelectedModelEntryForSurface("entry-web", "standalone");
      startTornSurfaceChoices("torn:1");
      assert.notEqual(
        getSelectedModelEntryForSurface("torn:1")?.authMode,
        "webchat",
      );

      setSelectedModelEntryForSurface("entry-web", "torn:1");
      assert.notEqual(
        getSelectedModelEntryForSurface("torn:1")?.authMode,
        "webchat",
      );
      // A torn window that was never started does not inherit it either.
      assert.notEqual(
        getSelectedModelEntryForSurface("torn:2")?.authMode,
        "webchat",
      );
      assert.equal(
        getSelectedModelEntryForSurface("standalone")?.authMode,
        "webchat",
      );
    });

    it("startStandaloneSurfaceChoicesFromSidebar does not reset torn stores", function () {
      startTornSurfaceChoices("torn:1");
      setSelectedModelEntryForSurface("entry-b", "torn:1");
      startStandaloneSurfaceChoicesFromSidebar();
      clearStandaloneSurfaceChoices();
      assert.equal(getSelectedModelEntryForSurface("torn:1")?.model, "model-b");
      assert.equal(
        getSelectedModelEntryForSurface("standalone")?.model,
        "model-a",
      );
    });

    it("a disabled runtime is demoted on torn windows too", function () {
      startTornSurfaceChoices("torn:1");
      surfaceChoices.conversationSystem.set("codex", "torn:1");
      demoteConversationSystemOnEverySurface("codex");
      assert.equal(surfaceChoices.conversationSystem.get("torn:1"), "upstream");
    });

    it("clearTornSurfaceChoices forgets one torn window's choices", function () {
      startTornSurfaceChoices("torn:1");
      startTornSurfaceChoices("torn:2");
      setSelectedModelEntryForSurface("entry-b", "torn:1");
      setSelectedModelEntryForSurface("entry-b", "torn:2");
      clearTornSurfaceChoices("torn:1");
      assert.equal(getSelectedModelEntryForSurface("torn:1")?.model, "model-a");
      assert.equal(getSelectedModelEntryForSurface("torn:2")?.model, "model-b");
    });
  });
});
