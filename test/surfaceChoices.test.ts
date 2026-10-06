import { assert } from "chai";
import { afterEach, beforeEach, describe, it } from "mocha";
import { config } from "../package.json";
import {
  bindSurfaceChoices,
  clearStandaloneSurfaceChoices,
  demoteConversationSystemOnEverySurface,
  getSelectedModelEntryForSurface,
  setSelectedModelEntryForSurface,
  surfaceChoices,
} from "../src/modules/contextPanel/surfaceChoices";
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
});
