import { assert } from "chai";
import { buildClaudeZoteroMcpScopeForTests } from "../src/agent/externalBackendBridge";

describe("Claude MCP scope for the full-text reader", function () {
  const originalZotero = globalThis.Zotero;

  beforeEach(function () {
    (globalThis as typeof globalThis & { Zotero: typeof Zotero }).Zotero = {
      Libraries: { userLibraryID: 1, get: () => null },
    } as unknown as typeof Zotero;
  });

  afterEach(function () {
    (globalThis as typeof globalThis & { Zotero?: typeof Zotero }).Zotero =
      originalZotero;
  });

  it("names the claude_bridge backend and carries the chat's model and reasoning", function () {
    const scope = buildClaudeZoteroMcpScopeForTests(
      {
        conversationKey: 8_803,
        mode: "agent",
        userText: "read",
        libraryID: 1,
        model: "  claude-sonnet-4-5 ",
        reasoning: { provider: "anthropic", level: "high" },
      },
      "profile-reader",
    );
    assert.equal(scope.exhaustiveReadBackend, "claude_bridge");
    assert.equal(scope.model, "claude-sonnet-4-5");
    assert.deepEqual(scope.reasoning, { provider: "anthropic", level: "high" });
  });
});
