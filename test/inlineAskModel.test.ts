import { assert } from "chai";
import { describe, it } from "mocha";
import {
  resolveInlineAskModelTarget,
  type InlineAskModelRuleInput,
} from "../src/modules/contextPanel/selectionPrompt/inlineAskModel";
import type { RuntimeModelEntry } from "../src/utils/modelProviders";

const CODEX_URL = "https://chatgpt.com/backend-api/codex/responses";

function entry(
  id: string,
  overrides: Partial<RuntimeModelEntry> = {},
): RuntimeModelEntry {
  return {
    entryId: id,
    groupId: `group-${id}`,
    model: `model-${id}`,
    apiBase: `https://${id}.example/v1`,
    apiKey: `key-${id}`,
    authMode: "api_key",
    providerProtocol: "openai_chat_compat",
    providerLabel: `Provider ${id}`,
    providerOrder: 0,
    displayModelLabel: `Model ${id}`,
    advanced: {
      temperature: 0.3,
      outputTokenLimit: { mode: "auto" },
    },
    ...overrides,
  } as RuntimeModelEntry;
}

const webchat = entry("web", {
  authMode: "webchat",
  providerProtocol: "web_sync",
  apiBase: "",
  apiKey: "",
  advanced: undefined,
} as Partial<RuntimeModelEntry>);
const appServer = entry("app", { authMode: "codex_app_server" });
const apiA = entry("a");
const apiB = entry("b");
const codexDirect = entry("cd", {
  model: "gpt-5.5",
  apiBase: CODEX_URL,
  apiKey: "",
  authMode: "codex_auth",
  providerProtocol: "codex_responses",
  providerLabel: "Codex Direct (Legacy)",
  displayModelLabel: "GPT-5.5",
});

function input(
  overrides: Partial<InlineAskModelRuleInput> = {},
): InlineAskModelRuleInput {
  return {
    conversationSystem: "upstream",
    sidebarEntry: apiB,
    entries: [webchat, appServer, apiA, apiB],
    codexDirect: {
      configured: false,
      runtimeModel: "",
      isModelAvailable: () => true,
    },
    ...overrides,
  };
}

describe("resolveInlineAskModelTarget", function () {
  it("uses the sidebar's API model on the API runtime", function () {
    const target = resolveInlineAskModelTarget(input());
    assert.equal(target?.source, "sidebar");
    assert.equal(target?.model, "model-b");
    assert.equal(target?.entryId, "b");
    assert.equal(target?.apiKey, "key-b");
    assert.equal(target?.displayLabel, "Model b");
  });

  it("falls back to the first API entry for Claude Code", function () {
    const target = resolveInlineAskModelTarget(
      input({ conversationSystem: "claude_code" }),
    );
    assert.equal(target?.source, "first_api");
    assert.equal(target?.entryId, "a");
  });

  it("falls back to the first API entry when the sidebar uses WebChat", function () {
    const target = resolveInlineAskModelTarget(
      input({ sidebarEntry: webchat }),
    );
    assert.equal(target?.source, "first_api");
    assert.equal(target?.entryId, "a");
  });

  it("skips Codex Direct models the catalog no longer lists", function () {
    const gone = entry("gone", {
      authMode: "codex_auth",
      catalogAvailability: "saved-unavailable",
    });
    const target = resolveInlineAskModelTarget(
      input({ sidebarEntry: webchat, entries: [webchat, gone, apiA] }),
    );
    assert.equal(target?.entryId, "a");
  });

  it("uses Codex Direct with the runtime model in Codex app-server mode", function () {
    const target = resolveInlineAskModelTarget(
      input({
        conversationSystem: "codex",
        codexDirect: {
          configured: true,
          runtimeModel: "gpt-5.4",
          isModelAvailable: () => true,
        },
      }),
    );
    assert.equal(target?.source, "codex_runtime");
    assert.equal(target?.model, "gpt-5.4");
    assert.equal(target?.authMode, "codex_auth");
    assert.equal(target?.providerProtocol, "codex_responses");
    assert.equal(target?.apiBase, CODEX_URL);
    assert.equal(target?.apiKey, "");
  });

  it("reuses the saved Codex Direct entry for the same model", function () {
    const target = resolveInlineAskModelTarget(
      input({
        conversationSystem: "codex",
        entries: [apiA, codexDirect],
        codexDirect: {
          configured: true,
          runtimeModel: "GPT-5.5",
          isModelAvailable: () => true,
        },
      }),
    );
    assert.equal(target?.source, "codex_runtime");
    assert.equal(target?.entryId, "cd");
    assert.equal(target?.displayLabel, "GPT-5.5");
  });

  it("treats a selected app-server entry as Codex app-server mode", function () {
    const target = resolveInlineAskModelTarget(
      input({
        sidebarEntry: { ...appServer, model: "gpt-5.3" },
        codexDirect: {
          configured: true,
          runtimeModel: "ignored",
          isModelAvailable: () => true,
        },
      }),
    );
    assert.equal(target?.source, "codex_runtime");
    assert.equal(target?.model, "gpt-5.3");
  });

  it("falls back to the first API entry without Codex Direct or a usable runtime model", function () {
    for (const codexDirectState of [
      {
        configured: false,
        runtimeModel: "gpt-5.4",
        isModelAvailable: () => true,
      },
      { configured: true, runtimeModel: "  ", isModelAvailable: () => true },
      { configured: true, runtimeModel: "auto", isModelAvailable: () => true },
      {
        configured: true,
        runtimeModel: "gpt-9",
        isModelAvailable: () => false,
      },
    ]) {
      const target = resolveInlineAskModelTarget(
        input({ conversationSystem: "codex", codexDirect: codexDirectState }),
      );
      assert.equal(
        target?.source,
        "first_api",
        JSON.stringify(codexDirectState),
      );
      assert.equal(target?.entryId, "a");
    }
  });

  it("returns null when no API model exists", function () {
    assert.isNull(
      resolveInlineAskModelTarget(
        input({ sidebarEntry: webchat, entries: [webchat, appServer] }),
      ),
    );
    assert.isNull(
      resolveInlineAskModelTarget(input({ sidebarEntry: null, entries: [] })),
    );
  });
});
